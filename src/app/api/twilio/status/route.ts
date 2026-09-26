import {
  ANSWERED_STATUSES,
  applyTwilioCallStatus,
  TERMINAL_STATUSES,
} from "@/lib/ai-call-state";
import { losingLegs, markAnswered, roomRoundInfo } from "@/lib/call-registry";
import { applyCallEvent, twilioEventTypeForStatus } from "@/lib/calls/apply-event";
import { recordParallelRound } from "@/lib/db/abandonment";
import { providerEventFingerprint } from "@/lib/calls/state-machine";
import { kickTranscription } from "@/lib/db/transcribe-call";
import {
  type AICallRef,
  getAICallRef,
  getAICallRefByCustomerSid,
} from "@/lib/db/records";
import {
  connectHumanCall,
  endHumanCallForLeg,
  getHumanCall,
  ringHumanCall,
} from "@/lib/human-call-store";
import { publishOrgEvent } from "@/lib/realtime/publish";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { getRestClient, readVerifiedTwilioForm } from "@/lib/twilio";

export const dynamic = "force-dynamic";

/**
 * Receives Twilio call + recording status callbacks.
 *
 * This route is the system's source of truth for what a phone is actually doing.
 * Twilio is the only party that knows whether a human picked up — ElevenLabs
 * cannot tell us, because in bridge mode it is talking to our own Twilio
 * conference, which answers instantly. We used to subscribe to these events and
 * then throw the interesting ones away, which is why a call that rang out sat in
 * the Live Monitor as "In Progress" until something force-closed it minutes later.
 *
 * Three jobs:
 *   1. AI calls  — drive the conversation lifecycle (ringing → connected →
 *      no-answer), and hang up the AI agent when nobody answers.
 *   2. Human calls — drive `live_calls` presence, so the monitor no longer depends
 *      on the rep's browser tab staying alive.
 *   3. Recordings + parallel-dial winner selection (pre-existing).
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const room = url.searchParams.get("room");
  const leadId = url.searchParams.get("leadId");
  const conversationId = url.searchParams.get("conversationId");

  // Verify Twilio's signature before acting on anything. This route mutates
  // call_records / pending_recordings / pending_call_verdicts / live_calls and
  // releases parallel legs, all with the service-role client — an unsigned POST
  // could forge recordings, drop live calls, and poison verdicts. Reject before
  // any of that. (Skips only when unconfigured/demo or the emergency valve is on.)
  const form = await readVerifiedTwilioForm(req);
  if (!form) {
    return new Response(null, { status: 403 });
  }
  const callStatus = String(form.CallStatus ?? "");
  const recordingStatus = String(form.RecordingStatus ?? "");
  const recordingUrl = String(form.RecordingUrl ?? "");
  const callSid = String(form.CallSid ?? "");
  const errorCode = Number(form.ErrorCode) || null;
  const answeredByRaw = String(form.AnsweredBy ?? "");

  // ── Canonical event log (dual-write, events first) ──────────────────────────
  // Every call-status callback is appended to the immutable call_events log and
  // CAS-applied to the canonical call_attempts state machine. Duplicates die on
  // the (source, provider_event_id) fingerprint; late/out-of-order events lose
  // the CAS. The legacy writes below are untouched during the dual-write phase.
  if (callStatus && callSid) {
    await applyCallEvent({
      source: "twilio",
      type: twilioEventTypeForStatus(callStatus, answeredByRaw || null) ?? "leg.completed",
      providerEventId: providerEventFingerprint({
        source: "twilio",
        sid: callSid,
        status: callStatus,
        sequence: String(form.SequenceNumber ?? ""),
      }),
      attemptRef: { room, conversationId, leadId },
      leg: {
        providerSid: callSid,
        leadId,
        rawStatus: callStatus,
        errorCode,
        answeredBy: answeredByRaw || null,
      },
    });
  }

  // ── Recording complete: save URL to the matching call record ────────────────
  // Manual calls are conferences, so the webhook carries the room (passed on the
  // callback URL) — match the record by room. If the record doesn't exist yet
  // (the rep is still wrapping up), park the URL in pending_recordings; the
  // insert claims it. We still try call_sid for any non-conference recordings.
  if (recordingStatus === "completed" && recordingUrl && isAdminConfigured()) {
    try {
      const admin = createAdminClient();
      const isHumanRoom = Boolean(room && room.startsWith("hc-"));
      if (isHumanRoom) {
        const { data: updated } = await admin
          .from("call_records")
          .update({ recording_url: recordingUrl })
          .eq("room", room)
          .is("recording_url", null)
          .select("id");
        // Record not written yet — park the recording so the insert can claim it.
        if (!updated || updated.length === 0) {
          await admin
            .from("pending_recordings")
            .upsert({ room, recording_url: recordingUrl }, { onConflict: "room" });
        } else {
          // The audio just became available and the row exists — turn it into
          // words now. Fire-and-forget: Twilio gets its 204 immediately, and
          // the sweep retries anything this drops.
          kickTranscription((updated[0] as { id?: string } | undefined)?.id);
        }
      } else if (callSid) {
        await admin
          .from("call_records")
          .update({ recording_url: recordingUrl })
          .eq("call_sid", callSid)
          .is("recording_url", null);
      }
    } catch {
      /* best-effort */
    }
  }

  // ── AI call: the homeowner's leg is the whole truth ─────────────────────────
  // Human conference legs carry `room=hc-…` and never a conversationId, so skip
  // them rather than spend a lookup per event proving they aren't AI calls.
  const maybeAi = Boolean(conversationId) || !room;
  if (callStatus && maybeAi) {
    await handleAiLeg({ conversationId, callSid, callStatus, errorCode });
  }

  // ── Human call: drive live presence straight off Twilio ─────────────────────
  // room is `hc-<humanId>` (see use-dialer), and live_calls.id IS that humanId.
  if (room?.startsWith("hc-") && callStatus) {
    const humanId = room.slice(3);
    try {
      if (callStatus === "ringing") {
        await ringHumanCall(humanId);
      } else if (ANSWERED_STATUSES.has(callStatus)) {
        await connectHumanCall(humanId, leadId);
        // ANSWERED FAST-PATH: tell the rep's browser WHICH leg picked up, now,
        // instead of waiting for its next /api/twilio/answered poll. The dialer
        // matches on `room` and runs its existing resolution immediately; the
        // poll (slowed while the channel is live) remains the backstop.
        const hc = await getHumanCall(humanId);
        publishOrgEvent(hc?.orgId, "call.answered", {
          humanId,
          room,
          answeredLeadId: leadId ?? null,
        });
      } else if (TERMINAL_STATUSES.has(callStatus) && leadId) {
        // Only ends the row if THIS is the leg that answered — a losing parallel
        // leg terminating must not yank a live call off the monitor.
        await endHumanCallForLeg(humanId, leadId);
      }
    } catch {
      /* presence is best-effort — never fail a Twilio webhook over it */
    }
  }

  // ── Parallel-dial winner: release the losing legs ───────────────────────────
  // CRITICAL: only release a leg that is still RINGING. A leg that already
  // ANSWERED must never be hung up here. In a 3X dial two homeowners can pick up
  // within the same ~1.5s window, and the two "who won?" authorities can disagree:
  // this webhook picks the winner by which `answered` callback arrived FIRST
  // (markAnswered), while the rep's browser bridges the call to the first answered
  // leg in PLACEMENT order (the /api/twilio/answered poll). When those differ, the
  // old code — which completed every non-winner leg regardless of status — hung up
  // the very homeowner the rep was now talking to, dropping the call the instant
  // "connected" appeared. Fetching each loser's live status and skipping any that
  // is no longer ringing makes an answered leg untouchable no matter which
  // authority labeled it a "loser"; at worst a rare double-answer leaves one extra
  // homeowner in the room briefly, which the rep can end — never a dropped call.
  if (room && leadId && ANSWERED_STATUSES.has(callStatus)) {
    const isWinner = markAnswered(room, leadId);
    if (isWinner) {
      const client = await getRestClient();
      if (client) {
        const STILL_RINGING = new Set(["queued", "initiated", "ringing"]);
        // Abandonment-rate tracking (lib/dialer/abandonment.ts): a losing leg
        // found NOT still ringing here was genuinely answered by a human (or
        // machine) at the exact moment another line became the rep's call —
        // that is the real, FTC-relevant event. This is why the release logic
        // above never hangs up an answered leg: doing so wouldn't erase the
        // abandonment, only hide the count of it.
        let answeredLosers = 0;
        await Promise.all(
          losingLegs(room, leadId).map(async (leg) => {
            if (!leg.sid) return;
            try {
              const c = await client.calls(leg.sid).fetch();
              if (STILL_RINGING.has(c.status)) {
                await client.calls(leg.sid).update({ status: "completed" });
              } else {
                answeredLosers += 1;
              }
            } catch {
              /* leg already gone — nothing to release, and nothing to count:
                 a leg Twilio has no record of was never confirmed answered. */
            }
          }),
        );
        // Only true PARALLEL rounds (2+ lines) are compliance-relevant here —
        // a plain single-line manual call has no collision risk to measure,
        // and mixing it in would dilute the rate with clean calls that were
        // never at risk, hiding a real problem concentrated in parallel mode.
        const info = roomRoundInfo(room);
        if (info && info.linesDialed > 1) {
          recordParallelRound({
            orgId: info.orgId,
            room,
            linesDialed: info.linesDialed,
            answeredCount: 1 + answeredLosers,
          });
        }
      }
    }
  }

  // ── Persist Twilio's own verdict on the call ────────────────────────────────
  // Twilio knows things we otherwise throw away: whether the leg was actually
  // answered, and the error code when it wasn't (21210/21212 bad caller ID, 21610
  // blocked, 13224 geo-permissions…).
  //
  // This used to key on `.eq("call_sid", callSid)` — the HOMEOWNER leg's SID. But
  // call_records.call_sid holds the REP's browser-leg SID for manual calls and the
  // AGENT's leg SID for AI calls. It never holds this one. So the update matched
  // zero rows on every single call, and these columns were always null. Conference
  // calls carry the room, so match on that instead — the same way the recording
  // path above already does.
  if (TERMINAL_STATUSES.has(callStatus) && isAdminConfigured()) {
    try {
      const admin = createAdminClient();
      // answered_by is OMITTED (not nulled) when this callback doesn't carry
      // it: with async AMD the verdict arrives at /api/twilio/amd and is
      // parked there FIRST — a null here would overwrite it on the upsert.
      const answeredBy = String(form.AnsweredBy ?? "");
      const verdict = {
        twilio_call_status: callStatus,
        twilio_error_code: errorCode,
        ...(answeredBy ? { answered_by: answeredBy } : {}),
      };
      if (room) {
        const { data: updated } = await admin
          .from("call_records")
          .update(verdict)
          .eq("room", room)
          .select("id");
        // Matching on `room` fixed the wrong-SID half of this bug, but not the
        // ORDERING half: `completed` arrives the moment the call ends, while the
        // record is only written when the rep saves their disposition seconds
        // later. So this update still found nothing on essentially every call.
        // Park the verdict; insertCallRecord claims it — the same rescue the
        // recording path above has always had.
        if (!updated || updated.length === 0) {
          await admin
            .from("pending_call_verdicts")
            .upsert({ room, ...verdict }, { onConflict: "room" });
        }
      } else if (callSid) {
        await admin.from("call_records").update(verdict).eq("call_sid", callSid);
      }
    } catch {
      /* best-effort */
    }
  }

  // Twilio parses a status-callback response as TwiML. Returning a JSON body made
  // it log "15003 Warning Response to Callback URL" on every single call. An empty
  // 204 is what it actually wants.
  return new Response(null, { status: 204 });
}

/**
 * Resolve which AI conversation this leg belongs to, then hand it to the shared
 * transition table in ai-call-state.ts (the same one the direct-mode poller uses,
 * so push and poll can never disagree).
 */
async function handleAiLeg(input: {
  conversationId: string | null;
  callSid: string;
  callStatus: string;
  errorCode: number | null;
}): Promise<void> {
  const { callSid, callStatus, errorCode } = input;

  // The query param is the fast path; the SID lookup is the fallback for when it's
  // lost, so a no-answer event is never silently dropped on the floor.
  let ref: AICallRef | null = null;
  if (input.conversationId) ref = await getAICallRef(input.conversationId);
  if (!ref && callSid) ref = await getAICallRefByCustomerSid(callSid);
  if (!ref) return; // not an AI leg — a human leg, or a call we don't track

  try {
    await applyTwilioCallStatus({
      conversationId: ref.conversationId,
      agentCallSid: ref.callSid,
      callStatus,
      errorCode,
    });
  } catch {
    /* best-effort — the cron reconciler will catch anything we drop */
  }
}
