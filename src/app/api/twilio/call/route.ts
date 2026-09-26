import { NextResponse } from "next/server";
import { registerRoom } from "@/lib/call-registry";
import { recordDialRequested } from "@/lib/calls/apply-event";
import { enforcedParallelCeiling } from "@/lib/db/abandonment";
import { dncKey, getDncDigits } from "@/lib/db/dnc";
import { resolveLeadTimezone } from "@/lib/dialer/lead-timezone";
import { MAX_PARALLEL_HUMAN } from "@/lib/dialer/parallel-limits";
import { placeLegWithRetry } from "@/lib/dialer/place-call";
import { findRecentLegs, orgCallerIdSet } from "@/lib/dialer/recover-legs";
import { type CallerIdInfo, nextCallerIdWithInfo } from "@/lib/dialer/rotation-server";
import { describeOrgHours, isWithinOrgHours } from "@/lib/dialer/schedule";
import { getViewer } from "@/lib/org/membership";
import {
  getPublicBaseUrl,
  getRestClient,
  isRestConfigured,
  twilioConfig,
} from "@/lib/twilio";
import { toE164 } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface DialLeadInput {
  leadId: string;
  phone: string;
}

/**
 * Initiates the outbound legs for parallel ("3X") dialing.
 *
 * Each homeowner is dialed into the agent's conference `room`. The agent's
 * browser joins the same room via the Voice SDK; the first homeowner to answer
 * is bridged, and `/api/twilio/status` releases the remaining legs. The browser
 * polls `/api/twilio/answered` to learn which lead won.
 *
 * Requires Twilio REST credentials. With none configured it returns 503 so the
 * client can surface a clear "connect Twilio" state — it never simulates calls.
 */
export async function POST(req: Request) {
  if (!isRestConfigured()) {
    return NextResponse.json(
      { error: "Twilio is not configured", mode: "offline" },
      { status: 503 },
    );
  }

  // AUTH: placing real outbound legs must never be reachable unauthenticated.
  // getViewer() was already resolved below only to pick a caller ID — its result
  // never gated the dial, so an anonymous POST could ring homeowners on this
  // Twilio account. Demo mode (no Supabase) has no Twilio creds and 503s above,
  // so this gate only ever rejects a real anonymous caller.
  const viewer = await getViewer();
  if (!viewer.isDemo && !viewer.user) {
    return NextResponse.json({ error: "Sign in to place calls." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    leads?: DialLeadInput[];
    room?: string;
    agentIdentity?: string;
    /** Numbers the rep toggled off in the dialer's caller-ID picker (optional). */
    excludedCallerIds?: string[];
    /**
     * The rep's local-presence choice for THIS dial: pick a caller ID sharing
     * the lead's area code when the pool has one. Absent = follow the org
     * setting. It only ever narrows which pool number is chosen — a rep can't
     * reach a number outside the pool they're already allowed to dial from.
     */
    localPresence?: boolean;
    /** A manual "Dial again" redial: reuse this exact caller ID instead of
     *  rotating, so a repeat call is recognizably the same number. Ignored
     *  (falls back to normal rotation) if it isn't an eligible pool member. */
    pinnedCallerId?: string;
    /** Per-lead idempotency keys minted by the dialer for this round —
     *  carried onto call_attempts and later matched by the disposition. */
    attemptIds?: Record<string, string>;
  };

  const room = body.room?.trim();
  const rawLeads = body.leads ?? [];
  // Normalize every number; toE164 returns "" for anything not dialable, so the
  // filter drops placeholder/garbled phones before we ever hit Twilio.
  const withNumbers = rawLeads
    .map((l) => ({ leadId: l.leadId, to: toE164(l.phone) }))
    .filter((l) => l.to && l.leadId);

  // Scrub the org's Do-Not-Call list before dialing anything.
  const dncSet = viewer.org?.id ? await getDncDigits(viewer.org.id) : new Set<string>();
  const leads = withNumbers.filter((l) => !dncSet.has(dncKey(l.to)));

  if (!room) {
    return NextResponse.json({ error: "A conference room is required" }, { status: 400 });
  }
  // Everything got scrubbed as Do-Not-Call — say so rather than "no valid number".
  if (withNumbers.length && !leads.length) {
    return NextResponse.json(
      { error: "These numbers are on the Do Not Call list and can’t be dialed." },
      { status: 400 },
    );
  }
  if (!leads.length) {
    // Distinguish "you sent nothing" from "every number was invalid" so the rep
    // gets an actionable message instead of a generic credentials warning.
    return NextResponse.json(
      {
        error: rawLeads.length
          ? "None of these leads have a valid phone number. Check the numbers on the lead(s) and re-import if needed."
          : "At least one lead is required",
      },
      { status: 400 },
    );
  }

  const client = await getRestClient();
  if (!client) {
    return NextResponse.json({ error: "Twilio unavailable" }, { status: 503 });
  }

  // Resolve the caller so manual legs rotate through the org's shared caller-ID
  // pool on THIS rep's own counter (per-rep), same as AI calls. (viewer resolved
  // above for the auth gate.)
  const repKey = viewer.user?.id ?? null;
  const rawOrgSettings = viewer.org?.settings ?? null;
  // The rep's local-presence toggle overrides the org default for this dial.
  // Applied by handing rotation an adjusted copy of the settings rather than a
  // new parameter, so every caller-ID rule (pool, exclusions, per-rep
  // assignment) keeps resolving through exactly the one code path it did before.
  const orgSettings =
    rawOrgSettings && typeof body.localPresence === "boolean"
      ? {
          ...rawOrgSettings,
          dialing: { ...rawOrgSettings.dialing, localPresence: body.localPresence },
        }
      : rawOrgSettings;

  // Cap parallel legs server-side. The browser enforces this, but the route must
  // too — otherwise one crafted request could ring hundreds of homeowners into a
  // single conference. Honor a lower per-org "Max lines" setting under the
  // platform ceiling — imported, not hand-duplicated: this used to be a local
  // `SERVER_MAX_PARALLEL = 3` literal the client's real ceiling could silently
  // drift past (bump MAX_PARALLEL_HUMAN in one place, forget this one, and
  // every rep's "10X" session quietly places 3 real Twilio legs).
  const orgMaxLines = Math.floor(Number(orgSettings?.dialing.maxLines) || MAX_PARALLEL_HUMAN);
  // The org's OWN recent abandonment rate can lower this further — see
  // lib/db/abandonment.ts. This is the enforcement half of raising the
  // platform ceiling to 10: a bad rate throttles the org back to single-line
  // dialing automatically, rather than waiting on someone to notice a report.
  const abandonmentCeiling = await enforcedParallelCeiling({
    orgId: viewer.org?.id ?? null,
    orgConfiguredCeiling: Math.max(1, orgMaxLines),
  });
  const lineCap = Math.min(Math.max(1, orgMaxLines), MAX_PARALLEL_HUMAN, abandonmentCeiling);
  let dialLeads = leads.slice(0, lineCap);

  // Enforced calling hours (Admin → Calling hours → "Block dialing outside
  // these hours"). Evaluated in each LEAD's own timezone (area-code inference,
  // org timezone fallback) — calling-time rules follow the called party's
  // clock, not the office's. Advisory-only orgs never reach this branch.
  const hours = orgSettings?.hours;
  const hourBlocked: { leadId: string; to: string }[] = [];
  if (hours?.enforced) {
    const orgTz = viewer.org?.timezone || "America/Chicago";
    const now = new Date();
    const inHours: typeof dialLeads = [];
    for (const leg of dialLeads) {
      if (isWithinOrgHours(now, hours, resolveLeadTimezone(leg.to, null, orgTz))) {
        inHours.push(leg);
      } else {
        hourBlocked.push(leg);
      }
    }
    if (dialLeads.length && !inHours.length) {
      return NextResponse.json(
        {
          error: `It's outside this workspace's calling hours (${describeOrgHours(hours)}, in each contact's local time). An admin can change or un-enforce the hours in Admin → Calling hours.`,
        },
        { status: 400 },
      );
    }
    dialLeads = inHours;
  }

  // Admin → Dialing → "Ring timeout": how long an outbound leg rings before
  // Twilio gives up. Clamped so a stored blob can't set an unringable 1s or
  // a 10-minute zombie leg.
  const ringTimeout = Math.min(
    60,
    Math.max(5, Math.round(Number(orgSettings?.dialing.ringTimeoutSec) || 25)),
  );

  // Only attach a StatusCallback when we have a publicly-reachable origin —
  // an unreachable/relative URL makes Twilio reject the request (21609 / 11200).
  // The status callback drives parallel auto-release; without it the call still
  // connects, it just won't auto-cancel the losing legs.
  const base = getPublicBaseUrl(req);

  // For a single call, the homeowner hanging up should end the call (matching a
  // direct dial). For parallel, the losing legs are force-released, so they must
  // NOT end the conference on exit — only the rep's leg does that.
  const endOnExit = dialLeads.length === 1 ? "true" : "false";
  // No waitUrl override → the rep already waiting in the room hears Twilio's
  // standard hold music while this homeowner's line rings. The music stops the
  // moment the homeowner joins (the conference becomes active with two
  // participants), so it never blocks the two-way audio bridge.
  const conferenceTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="${endOnExit}" beep="false">${room}</Conference></Dial></Response>`;

  // Async answering-machine detection (opt-in per org). AsyncAmd never delays
  // connecting a live human — the verdict arrives out-of-band at /api/twilio/amd,
  // which drops (or voicemail-drops) machine legs. DetectMessageEnd is used when
  // voicemail drop is on so the verdict lands exactly at the greeting's beep;
  // plain Enable verdicts at machine_start, hanging up sooner. Requires a public
  // callback origin, same as the status callback.
  const amdEnabled = Boolean(orgSettings?.dialing.amd) && Boolean(base);
  const orgId = viewer.org?.id ?? "";
  const amdParams = amdEnabled
    ? {
        machineDetection: orgSettings?.dialing.voicemailDrop
          ? "DetectMessageEnd"
          : "Enable",
        asyncAmd: "true",
        asyncAmdStatusCallbackMethod: "POST" as const,
      }
    : {};

  // Resolve caller ID info for the first leg so we can return it for display.
  // Subsequent legs each advance the counter individually.
  let poolInfo: CallerIdInfo | null = null;

  const placed = await Promise.all(
    dialLeads.map(async (leg, i) => {
      try {
        // One rotated caller ID per leg (this rep's atomic counter → distinct seq),
        // drawn only from numbers the rep hasn't toggled off in the caller-ID
        // picker — if that leaves just one number, every leg in this batch uses
        // it. Pass the homeowner's number so local presence can match its area
        // code among the still-eligible numbers.
        const info = await nextCallerIdWithInfo(
          repKey,
          orgSettings,
          leg.to,
          body.excludedCallerIds,
          body.pinnedCallerId,
          // Per-rep caller-ID assignment applies HERE — the manual power
          // dialer — and nowhere else (AI calls, inbound legs). See the
          // param doc on nextCallerIdWithInfo.
          viewer.role,
          viewer.callerIds,
        );
        if (i === 0) poolInfo = info;
        const from = info.callerId || twilioConfig.callerId;
        // A transient Twilio failure (a 502, a request that never completed)
        // used to end the dial outright. Retry it — but only after proving the
        // "failed" attempt didn't actually place the call, so a lost response
        // can never become a homeowner rung twice. See place-call.ts.
        const result = await placeLegWithRetry({
          createCall: () =>
            client.calls.create({
              to: leg.to,
              from,
              twiml: conferenceTwiml,
              timeout: ringTimeout,
              ...(base
                ? {
                    statusCallback: `${base}/api/twilio/status?room=${encodeURIComponent(room)}&leadId=${encodeURIComponent(leg.leadId)}`,
                    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
                  }
                : {}),
              ...(amdEnabled
                ? {
                    ...amdParams,
                    asyncAmdStatusCallback: `${base}/api/twilio/amd?room=${encodeURIComponent(room)}&leadId=${encodeURIComponent(leg.leadId)}&org=${encodeURIComponent(orgId)}`,
                  }
                : {}),
            }),
          findExisting: async () => {
            // Narrow window: we only care about a leg created moments ago by
            // the attempt that just threw, not one from an earlier dial.
            const found = await findRecentLegs(
              [{ leadId: leg.leadId, phone: leg.to }],
              15_000,
              orgCallerIdSet(orgSettings?.dialing),
            );
            return found[0] ? { sid: found[0].sid } : null;
          },
        });
        if (!result.sid) {
          console.error(
            `[twilio/call] calls.create failed for ${leg.to} after ${result.attempts} attempt(s):`,
            result.error,
          );
          return { leadId: leg.leadId, to: leg.to, sid: null, from: null, error: result.error };
        }
        if (result.adopted) {
          console.warn(
            `[twilio/call] ${leg.to}: provider error masked a successful create — adopted ${result.sid} instead of re-dialing.`,
          );
        }
        return { leadId: leg.leadId, to: leg.to, sid: result.sid, from, error: null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[twilio/call] leg setup failed for ${leg.to}:`, msg);
        return { leadId: leg.leadId, to: leg.to, sid: null, from: null, error: msg };
      }
    }),
  );

  // Hour-blocked legs travel back as EXPLICIT per-leg refusals — never a
  // silent omission. The client cancels their lanes, frees their claims, and
  // (crucially) files no record: a call that never happened must not exist.
  for (const leg of hourBlocked) {
    placed.push({
      leadId: leg.leadId,
      to: leg.to,
      sid: null,
      from: null,
      error: `Outside this contact's calling hours (${describeOrgHours(hours!)}, their local time).`,
    });
  }

  registerRoom(room, placed, viewer.org?.id ?? null);

  // Canonical attempts (dual-write): one call_attempts row per dialed lead,
  // keyed (room, lead_id) so every later webhook resolves its attempt. The
  // client's per-lead idempotency keys ride along when provided.
  await Promise.all(
    placed
      .filter((p) => p.sid)
      .map((p) =>
        recordDialRequested({
          orgId: viewer.org?.id ?? null,
          ownerId: viewer.user?.id ?? null,
          leadId: p.leadId,
          phone: p.to,
          channel: "human",
          dialMode: dialLeads.length > 1 ? "parallel" : "manual",
          clientAttemptId: body.attemptIds?.[p.leadId] ?? null,
          room,
          providerSid: p.sid,
        }),
      ),
  );

  // Snapshot poolInfo to a const so TypeScript narrows it correctly below.
  const callerIdInfo: CallerIdInfo | null = poolInfo;

  // Collect errors from failed legs so the client can surface the real reason.
  const errors = placed.filter((p) => !p.sid && p.error).map((p) => p.error);
  return NextResponse.json({ room, calls: placed, errors, callerIdInfo });
}
