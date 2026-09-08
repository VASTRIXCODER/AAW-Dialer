import "server-only";

import { getLeadByPhoneAdmin } from "./leads";
import { logLeadEvent } from "./lead-events";
import { createAdminClient, isAdminConfigured } from "../supabase/admin";
import { parseNotifyPrefs, type NotifyPrefs } from "../dialer/notify-prefs";
import { inboundNotificationText } from "../inbound/routing";
import { mergeSettings, type OrgSettings } from "../org/settings";
import { sendMessage } from "../messaging/transport";

// ─────────────────────────────────────────────────────────────────────────────
// Who does a returning call belong to?
//
// Twilio hands us two facts: the number that was dialed (ours) and the number
// that dialed it (theirs). Everything else — which org owns that number, which
// lead the caller is, which rep owns that lead, where that rep wants to be
// reached — has to be resolved from those two, with the service-role client,
// before any TwiML can be written. There is no session on an inbound call: the
// homeowner is not signed in, so `getViewer()` and RLS are both unavailable.
//
// Every function here is best-effort and total: an inbound call MUST produce
// valid TwiML in a second or two, so a database hiccup degrades to "we don't
// know who this is, take a message" rather than throwing.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? "" : String(v));
const last10 = (v: string) => {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
};

export interface InboundContext {
  orgId: string | null;
  orgName: string;
  settings: OrgSettings | null;
  /** The matched lead, when the caller is someone we know. */
  leadId: string | null;
  leadName: string;
  /** The rep who owns that lead. */
  repId: string | null;
  repName: string;
  repNotify: NotifyPrefs;
}

const EMPTY: InboundContext = {
  orgId: null,
  orgName: "",
  settings: null,
  leadId: null,
  leadName: "",
  repId: null,
  repName: "",
  repNotify: { phone: "", smsOnCallback: false, forwardCallback: false },
};

/**
 * Which organization owns the number that was dialed.
 *
 * Two places a number can live, and BOTH have to be searched: the org's own
 * `settings.dialing.callerIds` pool, and the single `settings.dialing.callerId`.
 * (The env pool, TWILIO_CALLER_IDS, is platform-wide and belongs to no single
 * org — a number that only exists there is resolved by the caller's fallback,
 * not here.)
 *
 * Matching is on the last 10 digits, because the pool is hand-typed and holds
 * every format a person might use.
 */
export async function orgForDialedNumber(dialed: string): Promise<{
  orgId: string;
  orgName: string;
  settings: OrgSettings;
} | null> {
  const want = last10(dialed);
  if (!isAdminConfigured() || want.length !== 10) return null;
  try {
    const { data } = await createAdminClient()
      .from("organizations")
      .select("id, name, settings")
      .limit(200);
    for (const row of (data ?? []) as Row[]) {
      const settings = mergeSettings(row.settings);
      const pool = [
        ...(settings.dialing.callerIds ?? []),
        settings.dialing.callerId ?? "",
      ].filter(Boolean);
      if (pool.some((n) => last10(n) === want)) {
        return { orgId: s(row.id), orgName: s(row.name), settings };
      }
    }
  } catch {
    /* fall through — the caller degrades to voicemail */
  }
  return null;
}

/** Everything the voice webhook needs to route one returning call. */
export async function resolveInboundContext(input: {
  /** The caller's number. */
  from: string;
  /** The number of ours they dialed. */
  to: string;
}): Promise<InboundContext> {
  const org = await orgForDialedNumber(input.to);
  if (!org) return EMPTY;

  const lead = await getLeadByPhoneAdmin(input.from, org.orgId).catch(() => null);
  const ctx: InboundContext = {
    ...EMPTY,
    orgId: org.orgId,
    orgName: org.orgName,
    settings: org.settings,
    leadId: lead?.id ?? null,
    leadName: lead ? `${lead.firstName} ${lead.lastName}`.trim() : "",
  };
  if (!lead?.ownerId) return ctx;

  try {
    const { data } = await createAdminClient()
      .from("profiles")
      .select("id, full_name, preferences")
      .eq("id", lead.ownerId)
      .maybeSingle();
    if (data) {
      ctx.repId = s((data as Row).id);
      ctx.repName = s((data as Row).full_name);
      ctx.repNotify = parseNotifyPrefs((data as Row).preferences);
    }
  } catch {
    /* the rep just doesn't get a text — the call still gets answered */
  }
  return ctx;
}

/**
 * File the returning call on the Callbacks board.
 *
 * `due_at` is NOW on purpose: a homeowner who just rang back is the most
 * time-sensitive row on that board, and the lanes (src/lib/callbacks/lanes.ts)
 * derive "due" from due_at against the clock — so this lands in the due lane
 * immediately and starts aging into overdue like any other promise.
 *
 * Idempotent within a short window: Twilio retries a webhook it thinks failed,
 * and one returning call must not become three rows on the board.
 */
export async function recordInboundCallback(input: {
  orgId: string | null;
  ownerId: string | null;
  leadId: string | null;
  leadName: string;
  phone: string;
  reason: string;
}): Promise<string | null> {
  if (!isAdminConfigured() || !input.orgId) return null;
  const admin = createAdminClient();
  try {
    // Same caller, same org, still open, in the last 5 minutes ⇒ same call.
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: dupe } = await admin
      .from("callbacks")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("phone", input.phone)
      .eq("status", "due")
      .gte("created_at", since)
      .limit(1);
    if ((dupe ?? []).length) return s((dupe as Row[])[0].id);

    const { data } = await admin
      .from("callbacks")
      .insert({
        org_id: input.orgId,
        owner_id: input.ownerId,
        lead_id: input.leadId,
        lead_name: input.leadName,
        phone: input.phone,
        due_at: new Date().toISOString(),
        reason: input.reason,
        status: "due",
        // Above every scheduled promise on the board. Someone is on the phone
        // right now; a callback booked for Thursday is not competing with that.
        priority: 2,
        assigned_to: input.ownerId,
      })
      .select("id")
      .maybeSingle();

    const id = data ? s((data as Row).id) : null;
    if (input.leadId) {
      // Fire-and-forget by design (see lead-events.ts) — the caller is holding
      // a phone line open, so nothing here may be awaited.
      logLeadEvent({
        leadId: input.leadId,
        orgId: input.orgId,
        kind: "note",
        payload: { source: "inbound_callback", phone: input.phone, reason: input.reason },
      });
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * Text the rep's personal phone that someone called back.
 *
 * Sends from the number that was DIALED, not the rotation pool: the rep sees a
 * consistent sender, and replying to it reaches a number the org owns.
 * Fire-and-forget by contract — an SMS failure must never delay the TwiML that
 * a caller is waiting on, so callers should not await this on the hot path.
 */
export async function notifyRepOfInboundCall(input: {
  repPhone: string;
  fromNumber: string;
  callerName: string;
  callerPhone: string;
  orgName: string;
  forwarded: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.repPhone || !input.fromNumber) {
    return { ok: false, error: "No rep number or sender number." };
  }
  const body = inboundNotificationText({
    callerName: input.callerName || null,
    callerPhone: input.callerPhone,
    orgName: input.orgName || null,
    forwarded: input.forwarded,
  });
  const res = await sendMessage({ to: input.repPhone, from: input.fromNumber, body });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
