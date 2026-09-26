// ─────────────────────────────────────────────────────────────────────────────
// Organization settings & white-label blueprint — PURE module (no server-only),
// so it can be imported from both Client and Server Components.
//
// `OrgSettings` is the deep, per-organization configuration persisted in the
// organizations.settings JSONB. `feature flags` let an org turn whole areas of
// the dialer on/off, so the product literally reshapes itself per tenant.
// `OrgBlueprint` is the full white-label spec the AI builder produces.
// ─────────────────────────────────────────────────────────────────────────────

import { MAX_PARALLEL_HUMAN } from "../dialer/parallel-limits";
import { clampForwardTimeout } from "../inbound/routing";
import type { LeadFieldDef } from "../leads/field-schema";
import { sanitizeExportTemplates, type ExportTemplate } from "../leads/export-spec";
import { sanitizeReportViews, type ReportView } from "../reports/view-spec";
import {
  DEFAULT_AI_DISPOSITION_POLICY,
  mergeAiDispositionPolicy,
  type AiDispositionPolicy,
} from "../ai/disposition-policy";

export type DispositionTone = "success" | "warning" | "danger" | "neutral";

export interface OrgFeatures {
  aiDialer: boolean;
  /** Browser-based manual (human) dialing. Off ⇒ AI-only workspace. */
  manualDialer: boolean;
  leads: boolean;
  appointments: boolean;
  callbacks: boolean;
  billsFine: boolean;
  liveMonitor: boolean;
  leaderboard: boolean;
  campaigns: boolean;
  reports: boolean;
  aiAgent: boolean;
  /** The CRM workspace: pipeline board, shared work queue, audiences. */
  crm: boolean;
}

/** One inclusive-start, exclusive-end hour window, e.g. {start:8,end:9} = 8–9am. */
export interface AutomationWindow {
  start: number;
  end: number;
}

/** Unattended AI-calling schedule (server-side cron places the calls). */
/**
 * Inbound (return-call) handling for the org's dialing numbers.
 * Routing decisions are pure — see src/lib/inbound/routing.ts.
 */
export interface InboundSettings {
  /**
   * "off"       — numbers stay write-only (today's behavior)
   * "forward"   — answer, then ring the matched rep's personal phone
   * "voicemail" — answer and take a message
   * "ai"        — hand the caller to the ElevenLabs agent
   */
  mode: "off" | "forward" | "voicemail" | "ai";
  /** Text the matched rep's personal phone when a call comes back. */
  notifyRep: boolean;
  /** Seconds the rep's phone rings before falling through to voicemail (5–60). */
  forwardTimeoutSec: number;
  /** Where to send calls with no matching rep. Empty ⇒ voicemail. */
  fallbackNumber: string;
  /** Spoken before connecting. `{org}` is interpolated. Empty ⇒ a neutral default. */
  greeting: string;
  /** Record the voicemail message the caller leaves. */
  recordVoicemail: boolean;
}

export interface AutomationSettings {
  /** Master switch — nothing auto-dials unless this is on. */
  enabled: boolean;
  /** IANA timezone the windows/days are evaluated in, e.g. "America/Chicago". */
  timezone: string;
  /** Days of week to run, 0 (Sun) – 6 (Sat). */
  days: number[];
  /** Hour windows to call within (local to `timezone`). */
  windows: AutomationWindow[];
  /** Calls placed per scheduler tick (~one tick/min → ~calls per minute). */
  callsPerRun: number;
  /** Max auto calls per day per org (0 = unlimited). */
  dailyCap: number;
  /** Don't re-dial a lead contacted within this many hours. */
  cooldownHours: number;
}

/**
 * Per-organization paywall, controlled by the platform owner (superadmin). There
 * is no payment processor — the owner sets the price and flips `active` to grant
 * or revoke access. While `paywall` is on and `active` is off, members see a
 * branded lock screen instead of the app.
 */
export interface OrgBilling {
  /** Is this workspace gated behind payment at all? */
  paywall: boolean;
  /** Superadmin switch: is access currently unlocked (paid)? */
  active: boolean;
  /** Price the platform owner charges (in whole currency units). */
  price: number;
  /** ISO-4217 currency code, e.g. "USD". */
  currency: string;
  interval: "month" | "year" | "once";
  /** Optional line shown on the lock screen (e.g. a contact or plan name). */
  note: string;
}

/**
 * Outbound email the workspace sends on its own — today, just the "an appointment
 * was set" alert to whoever owns the sales calendar.
 *
 * The recipients live HERE, in the org's settings, and not in an env var, because
 * the person who needs to change them is an admin looking at a screen, not an
 * engineer with deploy access. `APPOINTMENT_NOTIFY_EMAILS` remains as a
 * deployment-wide fallback for orgs that have never opened the panel.
 */
export interface NotificationSettings {
  /** Master switch. Off ⇒ appointments still book, nobody gets emailed. */
  appointmentEmail: boolean;
  /** Who gets told when an appointment is set / moved / cancelled. */
  appointmentEmails: string[];
  /** Also copy the rep who booked it, so they have their own paper trail. */
  ccBookingRep: boolean;
  /** Display name on the From line, e.g. "AIATWORK Dialer". */
  fromName: string;
}

/**
 * Per-tenant customization of the dialer's right-hand qualification panel.
 * Solar orgs keep the solar-loan framing; non-solar tenants (e.g. a workspace
 * that isn't selling against a solar payment) turn the solar field off and
 * relabel the third home-profile toggle to something that fits their pitch.
 */
export interface QualifySettings {
  /** Show the "Solar payment" billing field + energy-cost total. */
  showSolarPayment: boolean;
  /** Label for the third home-profile toggle (default "Battery"). */
  otherToggleLabel: string;
  /**
   * Schema keys (see src/lib/leads/field-schema.ts) the qualify panel renders,
   * in order — core slots by their camelCase key, custom fields by their
   * snake_case key. Absent/empty = derive from the vertical template's
   * `qualifyFields` preset, falling back to every schema field flagged
   * `showInQualify`. Unknown keys are ignored at render time, so a field
   * deleted from the schema never breaks the panel.
   */
  fields?: string[];
}

/**
 * Which panels of the dialer page this workspace shows. All-on is today's
 * dialer; vertical templates preset a shape (e.g. healthcare hides the live
 * floor) and admins fine-tune from there. Stored PARTIAL by design: only keys
 * an admin explicitly saved persist, so anything untouched keeps following the
 * template preset — resolved in the (app) layout as
 * DEFAULT ⊕ template preset ⊕ stored overrides.
 */
export interface DialerLayout {
  /** Org-wide live floor strip (who's dialing right now, calls today). */
  floor: boolean;
  /** The "Booked" tab beside the dial queue. */
  bookedTab: boolean;
  /** Collapsible campaign-script card above the qualify panel. */
  scriptCard: boolean;
  /** AI lead briefing at the top of the qualify panel. */
  aiBriefing: boolean;
  /** Per-lead call history in the lead panel. */
  callHistory: boolean;
  /** "Up next in queue" preview in the lead panel. */
  upNext: boolean;
  /** Closer-notes slot at the bottom of the qualify column (placeholder today). */
  closerNotes: boolean;
}

export const DEFAULT_DIALER_LAYOUT: DialerLayout = {
  floor: true,
  bookedTab: true,
  scriptCard: true,
  aiBriefing: true,
  callHistory: true,
  upNext: true,
  closerNotes: true,
};

/**
 * Customer messaging (Phase 2 · W2).
 *
 * `enabled` is an org's own switch. Whether messaging is REACHABLE at all is a
 * derived capability (`isMessagingConfigured()`), never a flag — an org must
 * not be able to toggle on a channel that isn't wired, because the toggle would
 * then be a promise the product can't keep.
 */
export interface MessagingSettings {
  enabled: boolean;
  /**
   * Local hours a message may be sent, in the RECIPIENT's timezone. Its own
   * window rather than reusing `hours`: that one defaults to `enforced: false`,
   * and flipping it on to serve messaging would immediately change live CALL
   * behaviour for every org. Messaging quiet hours can never be advisory.
   */
  quietHours: { startHour: number; endHour: number };
  /** Ceiling on what the whole workspace may send in a day. 0 = unlimited. */
  dailyOrgCap: number;
  /** Per-person limits, counted against sends the carrier accepted. */
  perContactPerDay: number;
  perContactPer7Days: number;
  /**
   * Ships INERT. The drain refuses to auto-send whatever this says, and the
   * `messages_approved_by_required` constraint refuses at the database. It
   * exists so the column doesn't have to be added later under time pressure —
   * not as a switch someone can find and flip.
   */
  autoSend: boolean;
}

export const DEFAULT_MESSAGING: MessagingSettings = {
  enabled: false,
  // Tighter than the statutory 8am–9pm on purpose — see DEFAULT_QUIET_HOURS in
  // messaging/send-gate.ts for why the boundary hours are the risky ones.
  quietHours: { startHour: 9, endHour: 20 },
  dailyOrgCap: 250,
  perContactPerDay: 1,
  perContactPer7Days: 3,
  autoSend: false,
};

export interface OrgSettings {
  dialing: {
    /**
     * Which mode the dialer OPENS in for this workspace: manual, parallel
     * (multi-line), or ai. "ai" silently falls back to manual for viewers who
     * can't use the AI dialer (no permission / feature off / ElevenLabs
     * unconfigured), and "parallel" falls back to manual when maxLines is 1.
     */
    defaultMode: "manual" | "parallel" | "ai";
    /** Admin's own ceiling on simultaneous human lines, clamped to the platform
     *  maximum (MAX_PARALLEL_HUMAN) — and, live, to whatever the org's own
     *  recent abandonment rate allows (lib/db/abandonment.ts). Raising this
     *  makes more lines SELECTABLE; it never dials more lines on its own — a
     *  rep (or an org whose defaultMode is literally "parallel") still has to
     *  choose to use them. */
    maxLines: number;
    /** Seconds an outbound leg rings before Twilio gives up (clamped 5–60). */
    ringTimeoutSec: number;
    recording: boolean;
    /**
     * Run speech-to-text over recorded MANUAL calls, so the archive can search
     * what was actually said instead of only the name, number and rep's notes.
     * Requires a provider key (ELEVENLABS_API_KEY or DEEPGRAM_API_KEY) and
     * `recording` on — there is nothing to transcribe otherwise.
     *
     * OFF by default on purpose: an org that set ELEVENLABS_API_KEY for the AI
     * dialer must not silently start paying per-minute for speech-to-text on
     * every human call the moment this ships. AI calls are unaffected — their
     * transcript already arrives from ElevenLabs at no extra cost.
     */
    transcribeCalls: boolean;
    /**
     * Async answering-machine detection on manual/parallel outbound legs.
     * Twilio's AsyncAmd never delays connecting a live human; when the verdict
     * says machine, the leg is auto-dropped (or gets the voicemail drop below).
     * Off by default: it adds per-minute AMD cost and changes floor behavior,
     * so an admin has to opt in.
     */
    amd: boolean;
    /** On AMD's end-of-greeting beep, speak `voicemailMessage` instead of hanging up. */
    voicemailDrop: boolean;
    /**
     * TTS text for the voicemail drop. Placeholders: {org}. Empty falls back
     * to a neutral default at drop time.
     */
    voicemailMessage: string;
    /**
     * Org-wide ceiling on dial attempts per lead for CLAIMED dialing (the
     * reservation engine skips leads at/over it). 0 = unlimited. Assignment
     * and campaign policies still apply their own caps on top.
     */
    maxAttemptsPerLead: number;
    /**
     * Minutes a lead is held out of claimed dialing after any attempt.
     * 0 = none. Due callbacks bypass the cooldown (the claim RPC's rule).
     */
    redialCooldownMin: number;
    /** Primary outbound caller ID (used when the rotation pool is empty). */
    callerId: string;
    /**
     * Caller-ID rotation pool — a list of E.164 numbers the dialer cycles
     * through for BOTH manual and AI calls. Empty = always use `callerId`/env.
     */
    callerIds: string[];
    /** Switch to the next pool number after this many calls (min 1). */
    rotateEvery: number;
    /**
     * Local presence: prefer a pool number whose area code matches the lead's,
     * so the call looks local and gets answered more. Falls back to normal
     * rotation when no pool number shares the lead's area code.
     */
    localPresence: boolean;
    /**
     * Double-dial ("double tap"): when the AI bot gets a NO-ANSWER, ring the same
     * number once more after a short gap before moving on. Two missed calls in
     * quick succession read as an important call and lift pickup rate. Off by
     * default. Applies to the AI dialer only.
     */
    doubleDial: boolean;
    /** Seconds to wait after a no-answer before the second (double-tap) dial. */
    doubleDialGapSec: number;
    /**
     * Power mode (auto-dispose): a finished MANUAL call no longer stops on the
     * wrap-up screen. The AI classifies the outcome in the background, it stacks
     * in a review widget, and the dialer immediately moves to the next lead and
     * keeps going. The workspace DEFAULT; each rep can flip it in the dialer.
     */
    autoDispose: boolean;
    /**
     * When power mode is on: auto-APPLY the AI's suggested disposition instead
     * of leaving it for the rep to confirm. Appointments and callbacks are
     * never auto-applied (they need a time), whatever this is set to. The
     * workspace default; each rep can flip it in the dialer.
     */
    autoConfirmDisposition: boolean;
    /**
     * Lease-based dial reservations (claim/heartbeat/release — see
     * src/lib/db/reservations.ts): two reps can never pull the same lead into
     * their queues at once. ON by default; this is the org-level kill switch
     * for rolling the reservation engine back to first-writer-wins dialing if
     * it ever misbehaves in production.
     */
    reservations: boolean;
    /**
     * What happens when someone rings one of the org's dialing numbers BACK.
     *
     * Every pool number used to be write-only: the dialer rang out from them and
     * anyone returning the call was hung up on by the voice webhook's disabled
     * direct-dial branch. Off by default — turning this on makes the numbers
     * answer, which is a visible change in how the business behaves.
     */
    inbound: InboundSettings;
  };
  /**
   * Unattended AI calling schedule. When enabled, a server-side cron places AI
   * calls to the org's dialable leads during the configured windows — no rep or
   * open browser required. Off by default so no org auto-dials unexpectedly.
   */
  automation: AutomationSettings;
  /**
   * Phase 2 playbook orchestration (the /api/cron/orchestrate tick). OFF by
   * default — no org ever auto-orchestrates by surprise; this is level 2 of
   * the kill-switch hierarchy (docs/phase-2/playbook-and-orchestration-
   * contracts.md §10). No admin UI yet on purpose: it unlocks with P2.2.
   */
  orchestration: { enabled: boolean };
  hours: {
    startHour: number; // 0–23 local to the org timezone
    endHour: number;
    days: number[]; // 0 (Sun) – 6 (Sat)
    /**
     * When ON, outbound MANUAL/PARALLEL and interactive AI dials outside these
     * hours are refused server-side (evaluated in the LEAD's own timezone,
     * falling back to the org's). When off, the hours are advisory — the
     * dialer shows an outside-hours banner but never blocks a call.
     */
    enforced: boolean;
  };
  ai: {
    agentName: string;
    persona: string;
    greeting: string;
    /** Full system prompt for the AI caller. Empty = use the vertical default. */
    systemPrompt: string;
    /**
     * ElevenLabs voice ID override for AI calls. Sent per-call through the
     * override payload ONLY when the agent's dashboard allow-list permits a
     * voice override (fail-closed, like every other override field). Empty =
     * the voice configured on the ElevenLabs dashboard agent.
     */
    voice: string;
    /** TTS playback speed (0.7 slow – 1.2 fast). Lower sounds calmer/slower. */
    voiceSpeed: number;
    /**
     * Where a live AI call is transferred when a supervisor hits Transfer.
     * Empty falls back to the platform env `ELEVENLABS_TRANSFER_NUMBER`;
     * empty BOTH ⇒ the transfer action is unavailable.
     */
    transferNumber: string;
    /**
     * Watchdog ceiling on a single AI call's talk time, in minutes (0 = none).
     * The reconcile cron force-ends conversations that run past it — a stuck
     * or rambling agent call can't burn minutes forever.
     *
     * NEW KEY on purpose: the dead control this replaces stored `maxTalkMin: 8`
     * in every org that ever saved the AI section, and waking that value up
     * would hang up healthy calls mid-booking at minute 8 (below the old
     * 12-minute generic force-close) — a limit nobody consciously chose. The
     * legacy `maxTalkMin` blob key is ignored forever.
     */
    talkTimeLimitMin: number;
    language: string;
    /**
     * How many AI calls may be LIVE at once — the org's voice-plan concurrency
     * allowance. The dialer holds itself to this number.
     *
     * It matters that this is a REAL ceiling: the dialer used to launch a fresh
     * batch every 8 seconds regardless of whether prior calls had ended, so a
     * "3X" setting peaked near 70 simultaneous calls and burned credits at a
     * rate nobody chose. Set this to whatever the plan actually allows.
     */
    maxConcurrentCalls: number;
    /**
     * Auto-grant the AI dialer to the workspace's top N reps (0 = off).
     *
     * A standing rule rather than a one-off grant: the ranking is recomputed
     * from live numbers — appointments booked over a rolling 7 days — so a rep
     * who climbs into the top N gains access and one who drops out loses it,
     * with nobody editing a permission. Only members whose ROLE doesn't already
     * include `dialer.ai` are ranked, so a manager can't consume a rep's slot.
     *
     * An admin's explicit per-member override still wins in BOTH directions:
     * this is folded in underneath the stored overrides (see getViewer).
     */
    topRepAccess: number;
    /**
     * Give EVERY member the AI dialer, reps included.
     *
     * `dialer.ai` is a manager-and-above permission by role, so a workspace that
     * wants its whole floor on the AI dialer would otherwise have to flip each
     * rep by hand on the Members tab — and remember to do it again for every
     * new hire. This is the workspace-wide switch for that.
     *
     * Supersedes `topRepAccess`: "everyone" already includes the top N, so when
     * this is on the ranking isn't consulted at all. An admin's explicit
     * per-member override still wins, so a single rep can still be switched off.
     *
     * Independent of `features.aiDialer`, which is the org-level paywall/kill
     * switch — that must also be on for anyone to place an AI call.
     */
    allRepAccess: boolean;
    /**
     * What an AI-PROPOSED disposition may do to a call record (F1): silent
     * auto-apply only above `autoApplyMin` confidence, with a transcript, and
     * never for an `alwaysReview` outcome — everything else lands in the
     * needs-review queue. See src/lib/ai/disposition-policy.ts.
     */
    dispositionPolicy: AiDispositionPolicy;
  };
  compliance: {
    // NOTE: there is deliberately no "enforce DNC" switch. Do-Not-Call is
    // enforced unconditionally at every dial path (manual, parallel, AI,
    // cron) and is not an org-configurable behavior.
    recordingDisclosure: string;
    consentRequired: boolean;
  };
  /**
   * Stored wrap-up rows. Two generations coexist in live blobs: the legacy
   * `{ label, tone }` pairs the old editor wrote, and the keyed rows the
   * Dispositions editor writes now (key/behavior/enabled/system/sortOrder —
   * see DispositionDef in src/lib/dispositions/defs.ts). NEVER read this array
   * raw — always resolve through resolveDispositionDefs, which round-trips
   * keyed rows and migrates legacy ones.
   */
  dispositions: {
    label: string;
    tone: DispositionTone;
    key?: string;
    behavior?: string;
    enabled?: boolean;
    system?: boolean;
    sortOrder?: number;
  }[];
  /** Qualification-panel customization (solar field + third toggle label). */
  qualify: QualifySettings;
  /**
   * Dialer-page layout toggles. PARTIAL on purpose: only the keys an admin has
   * explicitly saved live here — unset keys keep following the vertical
   * template's preset (see DEFAULT_DIALER_LAYOUT and the (app) layout).
   */
  dialerLayout: Partial<DialerLayout>;
  messaging: MessagingSettings;
  notifications: NotificationSettings;
  features: OrgFeatures;
  billing: OrgBilling;
  /** Per-minute call cost estimates — drives the Reports "Cost & usage" panel. */
  costRates: CostRates;
  /** Leaderboard scoring: per-component points, exclusions, and week start. */
  leaderboard: LeaderboardSettings;
  /**
   * Saved /reports views (range + compare presets by name). Capped at 12 and
   * sanitized on every read — see src/lib/reports/view-spec.ts.
   */
  reportViews: ReportView[];
  /**
   * The org's lead field schema: custom fields discovered from CSV imports plus
   * any explicit overrides of the core slots. Empty = derive everything from the
   * vertical template's defaults (see resolveLeadFields in
   * src/lib/leads/field-schema.ts).
   */
  leadFields: LeadFieldDef[];
  /**
   * Saved Export v2 setups (column selection + format), managed from the leads
   * Export dialog. Capped at 20; sanitized on every read (mergeSettings) so a
   * hand-edited blob degrades to its valid templates instead of breaking the
   * dialog. See src/lib/leads/export-spec.ts.
   */
  exportTemplates: ExportTemplate[];
  /** Domain noun the dialer uses for a contact, e.g. "homeowner". */
  leadNoun: string;
  leadNounPlural: string;
  /**
   * Per-org display-label overrides for the fixed lead-group "dropboxes", keyed
   * by group key (e.g. {"fresno":"San Antonio"}). Display-only — the underlying
   * keys and the geo-classifier are global and untouched. Empty = default labels.
   */
  leadGroupLabels: Record<string, string>;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  // On by default, but with no recipients it is inert — an org that never opens
  // the panel gets no email and, importantly, no "delivery failed" alerts either.
  appointmentEmail: true,
  appointmentEmails: [],
  ccBookingRep: false,
  fromName: "",
};

export const DEFAULT_QUALIFY: QualifySettings = {
  showSolarPayment: true,
  otherToggleLabel: "Battery",
};

export const DEFAULT_FEATURES: OrgFeatures = {
  aiDialer: true,
  manualDialer: true,
  leads: true,
  appointments: true,
  callbacks: true,
  billsFine: true,
  liveMonitor: true,
  leaderboard: true,
  campaigns: true,
  reports: true,
  aiAgent: true,
  crm: true,
};

export const DEFAULT_BILLING: OrgBilling = {
  paywall: false,
  active: true,
  price: 0,
  currency: "USD",
  interval: "month",
  note: "",
};

/**
 * What a minute of talk time costs this org, in USD — ESTIMATES, editable in
 * Admin → Organization settings. Defaults approximate common list pricing:
 * AI calls carry the conversational-AI per-minute fee plus the carrier leg;
 * human calls are just the carrier leg.
 */
export interface CostRates {
  aiPerMinute: number;
  manualPerMinute: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  aiPerMinute: 0.1,
  manualPerMinute: 0.015,
};

// ── Leaderboard scoring (F2) ─────────────────────────────────────────────────

/**
 * Points per scoring component. These replace the old hardcoded score formula in
 * src/lib/leaderboard.ts — an org decides what a connect, a qualified call, a
 * booking, a KEPT booking, a completed callback, and a minute of real talk are
 * worth on its own floor. The scoring math itself (windows, exclusions, ties)
 * lives in composeLeaderboard and is deliberately not configurable.
 */
export interface LeaderboardPoints {
  humanConnect: number;
  qualified: number;
  appointmentBooked: number;
  /** Appointment marked completed (the rep actually held it). */
  appointmentKept: number;
  /** Per whole minute of connected talk time. */
  talkMinute: number;
  callbackCompleted: number;
}

export interface LeaderboardExclusions {
  /** Count AI-agent calls toward reps' scores. Off = human dials only. */
  includeAiCalls: boolean;
  /**
   * A "connect" only scores when measured talk time reaches this many seconds
   * (calls whose talk time is unknown — legacy rows — are not gated).
   */
  minTalkSecForConnect: number;
}

export interface LeaderboardSettings {
  points: LeaderboardPoints;
  exclusions: LeaderboardExclusions;
  /** Calendar week start for the weekly board: 0 = Sunday, 1 = Monday. */
  weekStart: 0 | 1;
}

export const DEFAULT_LEADERBOARD: LeaderboardSettings = {
  points: {
    humanConnect: 1,
    qualified: 3,
    appointmentBooked: 5,
    appointmentKept: 8,
    talkMinute: 0.1,
    callbackCompleted: 2,
  },
  exclusions: { includeAiCalls: false, minTalkSecForConnect: 30 },
  weekStart: 1,
};

/** Sanitize a stored leaderboard blob (numbers coerced, weekStart clamped). */
export function mergeLeaderboardSettings(raw: unknown): LeaderboardSettings {
  const s = (raw ?? {}) as Partial<LeaderboardSettings>;
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const points = { ...DEFAULT_LEADERBOARD.points };
  for (const key of Object.keys(points) as (keyof LeaderboardPoints)[]) {
    points[key] = num(s.points?.[key], DEFAULT_LEADERBOARD.points[key]);
  }
  return {
    points,
    exclusions: {
      includeAiCalls: s.exclusions?.includeAiCalls === true,
      minTalkSecForConnect: num(
        s.exclusions?.minTalkSecForConnect,
        DEFAULT_LEADERBOARD.exclusions.minTalkSecForConnect,
      ),
    },
    weekStart: s.weekStart === 0 ? 0 : 1,
  };
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  dialing: {
    // "ai" preserves the historical boot behavior: the dialer opens in AI mode
    // whenever the viewer can actually use it, manual otherwise. Orgs that want
    // manual-first pick it in Admin → Dialing.
    defaultMode: "ai",
    // Matches the platform ceiling — not a "safe conservative default that
    // happens to equal the old ceiling." An org that's never touched this
    // setting now gets real 10x manual/parallel dialing SELECTABLE, exactly
    // like ai.maxConcurrentCalls already defaults to its own ceiling below.
    // "Selectable" is the operative word: this raises what a rep CAN choose,
    // never what dials on its own — see the field's doc comment above, and
    // lib/db/abandonment.ts for what keeps that safe in practice.
    maxLines: MAX_PARALLEL_HUMAN,
    ringTimeoutSec: 25,
    recording: true,
    // Opt-in: speech-to-text bills per minute, so an admin turns it on.
    transcribeCalls: false,
    amd: false,
    voicemailDrop: true,
    voicemailMessage: "",
    // 0 = off. These deliberately default OFF (unlike the old dead
    // retryAttempts/retryDelayMin knobs, which persisted 3/60 that nothing
    // read) so no org gets surprise skip behavior from a value it never chose.
    maxAttemptsPerLead: 0,
    redialCooldownMin: 0,
    callerId: "",
    callerIds: [],
    rotateEvery: 1,
    // On by default: when the pool holds a number in the lead's area code, dial
    // from it so the call shows as local and is answered more (and is flagged as
    // spam less). No-ops safely when the pool has no matching area code, so it's
    // safe to default on and pays off the moment regional numbers are added.
    localPresence: true,
    doubleDial: false,
    doubleDialGapSec: 15,
    // Power mode + auto-confirm are opt-in per workspace (and per rep on top).
    autoDispose: false,
    autoConfirmDisposition: false,
    // The reservation engine is the default; orgs saved before it existed pick
    // it up here via mergeSettings (absent key → this default → ON).
    reservations: true,
    // OFF: the numbers stay write-only until an admin decides they should
    // answer. Turning it on changes how the business behaves to anyone who
    // dials back, so it is never something an upgrade does on its own.
    inbound: {
      mode: "off",
      notifyRep: true,
      forwardTimeoutSec: 25,
      fallbackNumber: "",
      greeting: "",
      recordVoicemail: true,
    },
  },
  orchestration: { enabled: false },
  automation: {
    enabled: false,
    timezone: "America/Chicago",
    days: [0, 1, 2, 3, 4, 5, 6],
    // 8–9am, 11am–3pm, 5–7pm (end hour is exclusive).
    windows: [
      { start: 8, end: 9 },
      { start: 11, end: 15 },
      { start: 17, end: 19 },
    ],
    callsPerRun: 3,
    dailyCap: 500,
    cooldownHours: 6,
  },
  // enforced defaults OFF: hours are advisory (dialer banner) until an admin
  // explicitly turns the server-side block on.
  hours: { startHour: 8, endHour: 20, days: [1, 2, 3, 4, 5], enforced: false },
  ai: {
    agentName: "Aria",
    persona: "Friendly, concise, and consultative.",
    greeting: "Hi, this is {agent} calling from {org} — do you have a quick moment?",
    systemPrompt: "",
    // Empty = the voice configured on the ElevenLabs dashboard agent.
    voice: "",
    voiceSpeed: 0.9,
    // Empty = fall back to the ELEVENLABS_TRANSFER_NUMBER env; empty both ⇒
    // no transfer target (the action is unavailable). The old hardcoded
    // literal default is gone on purpose — a phone number is tenant config,
    // not source code.
    transferNumber: "",
    talkTimeLimitMin: 0,
    language: "en",
    // Matches the common ElevenLabs plan allowance. Raise if the plan does.
    maxConcurrentCalls: 10,
    // Both off until an admin opts in — each hands a paid capability to reps
    // who don't have it by role, so it must be a deliberate choice.
    topRepAccess: 0,
    allRepAccess: false,
    dispositionPolicy: {
      ...DEFAULT_AI_DISPOSITION_POLICY,
      alwaysReview: [...DEFAULT_AI_DISPOSITION_POLICY.alwaysReview],
    },
  },
  compliance: {
    recordingDisclosure: "This call may be recorded for quality and training.",
    consentRequired: false,
  },
  dispositions: [
    { label: "Appointment booked", tone: "success" },
    { label: "Callback scheduled", tone: "warning" },
    { label: "Not interested", tone: "danger" },
    { label: "No answer", tone: "neutral" },
  ],
  qualify: { ...DEFAULT_QUALIFY },
  dialerLayout: {},
  messaging: { ...DEFAULT_MESSAGING },
  notifications: { ...DEFAULT_NOTIFICATIONS },
  features: { ...DEFAULT_FEATURES },
  billing: { ...DEFAULT_BILLING },
  costRates: { ...DEFAULT_COST_RATES },
  leaderboard: {
    points: { ...DEFAULT_LEADERBOARD.points },
    exclusions: { ...DEFAULT_LEADERBOARD.exclusions },
    weekStart: DEFAULT_LEADERBOARD.weekStart,
  },
  reportViews: [],
  leadFields: [],
  exportTemplates: [],
  leadNoun: "lead",
  leadNounPlural: "leads",
  leadGroupLabels: {},
};

/** Why the AI dialer is locked for a viewer: a plan upgrade vs a role limit. */
export type AiLockReason = "premium" | "role" | null;

export interface DialerAccess {
  manualEnabled: boolean;
  aiEnabled: boolean;
  aiLockReason: AiLockReason;
}

/**
 * Resolve which dialer modes a viewer may use, from the org's feature flags and
 * whether they hold the `dialer.ai` permission. Two independent gates on AI:
 *  • `aiDialer` off ⇒ AI is a locked premium feature for everyone (paywall).
 *  • no AI permission ⇒ AI is manager+ only (reps are manual-only) — UNLESS the
 *    workspace is AI-only (manual off), where reps must keep AI or be stranded.
 */
export function resolveDialerAccess(
  features: OrgFeatures,
  hasAiPermission: boolean,
): DialerAccess {
  const manualEnabled = features.manualDialer !== false;
  const aiOrgEnabled = features.aiDialer !== false;
  const aiRoleAllowed = hasAiPermission || !manualEnabled;
  const aiEnabled = aiOrgEnabled && aiRoleAllowed;
  const aiLockReason: AiLockReason = aiEnabled
    ? null
    : !aiOrgEnabled
      ? "premium"
      : "role";
  return { manualEnabled, aiEnabled, aiLockReason };
}

/** Deep-merge a stored (partial) settings blob over the defaults. */
export function mergeSettings(raw: unknown): OrgSettings {
  const s = (raw ?? {}) as Partial<OrgSettings>;
  return {
    dialing: {
      ...DEFAULT_ORG_SETTINGS.dialing,
      ...(s.dialing ?? {}),
      // Sanitized on read — a hand-edited or legacy blob can hold anything.
      defaultMode: (["manual", "parallel", "ai"] as const).includes(
        s.dialing?.defaultMode as "manual",
      )
        ? s.dialing!.defaultMode
        : DEFAULT_ORG_SETTINGS.dialing.defaultMode,
      // Nested object: the outer spread would replace it wholesale, so an org
      // saved with `inbound: { mode: "forward" }` and nothing else would come
      // back missing every other key and read as timeout 0 / notify off.
      inbound: {
        ...DEFAULT_ORG_SETTINGS.dialing.inbound,
        ...(s.dialing?.inbound ?? {}),
        mode: (["off", "forward", "voicemail", "ai"] as const).includes(
          s.dialing?.inbound?.mode as "off",
        )
          ? s.dialing!.inbound!.mode
          : DEFAULT_ORG_SETTINGS.dialing.inbound.mode,
        forwardTimeoutSec: clampForwardTimeout(s.dialing?.inbound?.forwardTimeoutSec),
      },
    },
    automation: {
      ...DEFAULT_ORG_SETTINGS.automation,
      ...(s.automation ?? {}),
      // Arrays must be replaced wholesale, not spread-merged.
      days: Array.isArray(s.automation?.days)
        ? s.automation!.days
        : DEFAULT_ORG_SETTINGS.automation.days,
      windows: Array.isArray(s.automation?.windows)
        ? s.automation!.windows
        : DEFAULT_ORG_SETTINGS.automation.windows,
    },
    hours: { ...DEFAULT_ORG_SETTINGS.hours, ...(s.hours ?? {}) },
    orchestration: { enabled: s.orchestration?.enabled === true },
    ai: {
      ...DEFAULT_ORG_SETTINGS.ai,
      ...(s.ai ?? {}),
      // Sanitized on every read (clamped threshold, wholesale array replace) —
      // the stored blob is whatever the last PATCH wrote.
      dispositionPolicy: mergeAiDispositionPolicy(s.ai?.dispositionPolicy),
    },
    compliance: { ...DEFAULT_ORG_SETTINGS.compliance, ...(s.compliance ?? {}) },
    dispositions: Array.isArray(s.dispositions)
      ? s.dispositions
      : DEFAULT_ORG_SETTINGS.dispositions,
    qualify: {
      ...DEFAULT_QUALIFY,
      ...(s.qualify ?? {}),
      // Arrays replace wholesale, and anything that isn't an array is dropped
      // (undefined = "derive from the template's preset").
      fields: Array.isArray(s.qualify?.fields) ? s.qualify!.fields : undefined,
    },
    // Deliberately NOT back-filled with defaults: this section stays partial so
    // the (app) layout can layer it over the vertical template's preset —
    // back-filling `true` here would make every org look like it explicitly
    // chose all-on and the presets would never apply.
    dialerLayout:
      s.dialerLayout && typeof s.dialerLayout === "object" && !Array.isArray(s.dialerLayout)
        ? s.dialerLayout
        : {},
    notifications: {
      ...DEFAULT_NOTIFICATIONS,
      ...(s.notifications ?? {}),
      // Arrays replace wholesale — spreading would merge index-wise and resurrect
      // a recipient the admin just deleted.
      appointmentEmails: Array.isArray(s.notifications?.appointmentEmails)
        ? s.notifications!.appointmentEmails
        : DEFAULT_NOTIFICATIONS.appointmentEmails,
    },
    messaging: {
      ...DEFAULT_MESSAGING,
      ...(s.messaging ?? {}),
      // Nested, so a stored blob carrying only one hour cannot leave the other
      // undefined and silently disable the window.
      quietHours: {
        ...DEFAULT_MESSAGING.quietHours,
        ...(s.messaging?.quietHours ?? {}),
      },
    },
    features: { ...DEFAULT_FEATURES, ...(s.features ?? {}) },
    billing: { ...DEFAULT_BILLING, ...(s.billing ?? {}) },
    costRates: { ...DEFAULT_COST_RATES, ...(s.costRates ?? {}) },
    // Sanitized on read — point values coerced, weekStart clamped to 0|1.
    leaderboard: mergeLeaderboardSettings(s.leaderboard),
    // Sanitized on read (shape + the 12-view cap); views replace wholesale.
    reportViews: sanitizeReportViews(s.reportViews),
    // Arrays replace wholesale (like dispositions) — spread-merging would
    // resurrect a field an admin just deleted.
    leadFields: Array.isArray(s.leadFields) ? s.leadFields : [],
    // Sanitized on read (shape + the 20-template cap) — the stored blob is
    // whatever the PATCH route last wrote, and templates replace wholesale.
    exportTemplates: sanitizeExportTemplates(s.exportTemplates),
    leadNoun: s.leadNoun ?? DEFAULT_ORG_SETTINGS.leadNoun,
    leadNounPlural: s.leadNounPlural ?? DEFAULT_ORG_SETTINGS.leadNounPlural,
    leadGroupLabels:
      s.leadGroupLabels && typeof s.leadGroupLabels === "object"
        ? s.leadGroupLabels
        : {},
  };
}

/** Full white-label specification the AI builder emits and create applies. */
export interface OrgBlueprint {
  name: string;
  industry: string;
  template: string;
  productName: string;
  tagline: string;
  description: string;
  brandColor: string;
  accentColor: string;
  requireApproval: boolean;
  defaultRole: "rep" | "manager" | "admin";
  settings: OrgSettings;
}
