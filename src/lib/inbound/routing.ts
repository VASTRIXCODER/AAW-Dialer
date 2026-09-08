// Inbound callback routing — PURE (no I/O), client- and server-safe.
//
// Until now every number in the caller-ID pool was write-only: the dialer rang
// out from them, and anyone who rang one BACK hit /api/twilio/voice's
// "Direct dialing through this line is disabled" branch and was hung up on.
// A homeowner returning a call — the warmest inbound signal this product can
// receive — was dropped on the floor with no trace anywhere.
//
// Everything here is decision-making only. The TwiML, the SMS, and the callback
// row are the caller's job (src/app/api/twilio/voice, src/lib/db/inbound.ts),
// so the rules that decide who a returning call reaches can be tested without
// Twilio, Supabase, or a network.

/** What a request hitting the voice webhook actually is. */
export type IncomingKind =
  | "ai_bridge"
  | "monitor"
  | "conference"
  | "browser_direct"
  | "inbound_callback"
  | "unknown";

const digits = (s: string) => String(s ?? "").replace(/\D/g, "");
/** Last 10 digits — how every number comparison in this file is made, so
 *  "+1 (817) 508-2598" and "8175082598" are the same number. */
const last10 = (s: string) => {
  const d = digits(s);
  return d.length >= 10 ? d.slice(-10) : d;
};

/**
 * Which of the voice webhook's several jobs this request is.
 *
 * The subtle one: Twilio marks a call placed FROM the browser SDK as
 * `Direction=inbound` too (it is inbound to Twilio), so Direction cannot tell a
 * homeowner's return call from a rep's own outbound leg. What does separate
 * them reliably is the `From`: a browser leg is always `client:<identity>`,
 * a real returning caller is always a phone number.
 */
export function classifyIncomingCall(input: {
  from: string;
  to: string;
  /** Our own `Conference` param — present only on legs the app created. */
  conference?: string;
  monitor?: boolean;
  /** TWILIO_AI_BRIDGE_NUMBER, when bridge mode is on. */
  bridgeNumber?: string;
}): IncomingKind {
  const to = String(input.to ?? "").trim();
  const from = String(input.from ?? "").trim();
  const conference = String(input.conference ?? "").trim();
  const bridge = String(input.bridgeNumber ?? "").trim();

  // The ElevenLabs agent calling our bridge number. Checked FIRST: it arrives
  // looking exactly like an inbound call, and answering it as one would put a
  // homeowner greeting in front of the AI agent instead of bridging it.
  if (bridge && to && last10(to) === last10(bridge)) return "ai_bridge";

  if (conference && input.monitor) return "monitor";
  if (conference) return "conference";

  // A browser leg. Kept distinct from an inbound callback so the deliberately
  // disabled direct-dial branch stays disabled — it must never become a way to
  // reach the new forwarding path.
  if (from.toLowerCase().startsWith("client:")) return "browser_direct";

  // A real person dialed one of our numbers.
  if (last10(from).length === 10 && last10(to).length === 10) {
    return "inbound_callback";
  }

  return "unknown";
}

/** Is `number` one of this org's dialing numbers? */
export function isOurNumber(to: string, pool: readonly string[]): boolean {
  const t = last10(to);
  return t.length === 10 && pool.some((p) => last10(p) === t);
}

export type InboundMode = "forward" | "voicemail" | "ai" | "off";

export type InboundAction =
  | { kind: "forward"; to: string; timeoutSec: number; via: "rep" | "fallback" }
  | { kind: "voicemail"; reason: "configured" | "no_number" | "rep_unavailable" }
  | { kind: "ai" }
  | { kind: "reject" };

export const DEFAULT_FORWARD_TIMEOUT_SEC = 25;
/** Twilio rejects a <Dial timeout> outside this range. */
export const MIN_FORWARD_TIMEOUT_SEC = 5;
export const MAX_FORWARD_TIMEOUT_SEC = 60;

export function clampForwardTimeout(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_FORWARD_TIMEOUT_SEC;
  return Math.min(MAX_FORWARD_TIMEOUT_SEC, Math.max(MIN_FORWARD_TIMEOUT_SEC, v));
}

/**
 * Where a returning call goes.
 *
 * Forwarding is DOUBLE opt-in: the org turns the mode on, and the rep supplies
 * a personal number and ticks the box. A rep's mobile number is personal data
 * they volunteered for notifications — ringing it because an admin flipped an
 * org switch would be a different promise than the one they agreed to. Without
 * both, the call still gets answered; it just takes a message instead.
 */
export function chooseInboundRoute(input: {
  mode: InboundMode;
  /** The matched lead's owning rep, when the caller is a known lead. */
  repPhone?: string | null;
  repForwardOptIn?: boolean;
  /** Org-level number for calls with no matching rep. */
  fallbackNumber?: string | null;
  timeoutSec?: number;
}): InboundAction {
  if (input.mode === "off") return { kind: "reject" };
  if (input.mode === "ai") return { kind: "ai" };
  if (input.mode === "voicemail") return { kind: "voicemail", reason: "configured" };

  const timeoutSec = clampForwardTimeout(input.timeoutSec);
  const rep = normalizeForward(input.repPhone);
  if (rep && input.repForwardOptIn) {
    return { kind: "forward", to: rep, timeoutSec, via: "rep" };
  }
  const fallback = normalizeForward(input.fallbackNumber);
  if (fallback) return { kind: "forward", to: fallback, timeoutSec, via: "fallback" };

  // Configured to forward with nowhere to forward TO. Answering and taking a
  // message beats ringing out — the caller still reaches someone eventually,
  // and the callback row is written either way.
  return { kind: "voicemail", reason: "no_number" };
}

/** E.164 for dialing, or "" when the value can't be a real number. */
export function normalizeForward(raw: string | null | undefined): string {
  const d = digits(raw ?? "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  // Longer strings are international; keep them, but only if plausibly a number.
  if (d.length > 11 && d.length <= 15) return `+${d}`;
  return "";
}

/**
 * The SMS a rep gets on their personal phone.
 *
 * Deliberately short and free of anything sensitive: a name and a number, on a
 * device that shows previews on a lock screen. No address, no billing figures,
 * no notes.
 */
export function inboundNotificationText(input: {
  callerName?: string | null;
  callerPhone: string;
  orgName?: string | null;
  /** Was the call forwarded to them, or is this purely a heads-up? */
  forwarded: boolean;
}): string {
  const who = (input.callerName ?? "").trim();
  const org = (input.orgName ?? "").trim();
  const lead = who ? `${who} (${formatUs(input.callerPhone)})` : formatUs(input.callerPhone);
  const head = org ? `${org}: ` : "";
  return input.forwarded
    ? `${head}${lead} is calling you back right now — pick up, or open the dialer to return it.`
    : `${head}${lead} just called back. Open the dialer to return it.`;
}

/** (817) 508-2598 for NANP, otherwise the number as given. */
function formatUs(phone: string): string {
  const d = digits(phone);
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return phone;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// ── The `reason` a returned call is filed under ──────────────────────────────
// Defined here rather than inline at the write site so the board can recognise
// its own rows. A `callbacks` row has no channel column, and adding one would
// mean a migration on a live table for what is really a label — the reason
// string is the marker, so it has to be a shared constant, not a literal typed
// twice and drifting.
export const INBOUND_REASON_FORWARDED = "Called back — ringing the rep";
export const INBOUND_REASON_MESSAGE = "Called back — left for the rep";

/** Did this callback row come from someone ringing US? */
export function isInboundCallback(reason: string | null | undefined): boolean {
  const r = String(reason ?? "");
  return r === INBOUND_REASON_FORWARDED || r === INBOUND_REASON_MESSAGE;
}

/**
 * What the caller hears before anything else happens.
 * `{org}` is the only placeholder, mirroring the voicemail-drop message.
 */
export function renderGreeting(
  template: string | null | undefined,
  orgName: string | null | undefined,
): string {
  const org = (orgName ?? "").trim();
  const raw = (template ?? "").trim();
  if (!raw) {
    return org
      ? `Thanks for calling ${org}. Connecting you now.`
      : "Thanks for calling us back. Connecting you now.";
  }
  return raw.replace(/\{org\}/gi, org || "us");
}
