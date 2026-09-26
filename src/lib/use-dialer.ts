"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Call, Device } from "@twilio/voice-sdk";
import {
  type CallEvent,
  decideCallEvent,
  describeCallError,
} from "./dialer/call-events";
import {
  advanceCursorPastClaims,
  claimEmptyMessage,
  computeReleaseSet,
  orderedCandidateIds,
  reorderClaimed,
  strictQueueExhaustedMessage,
  type ClaimReleaseAction,
} from "./dialer/claims";
import { aiDialInFlight } from "./dialer/ai-redial";
import { dedupeLeadsByPhone } from "./dialer/lane-dedupe";
import { persistDisposition } from "./dialer/disposition-queue";
import { decideMuteToggle, type MuteCapability } from "./dialer/mute-intent";
import { MAX_PARALLEL_AI, MAX_PARALLEL_HUMAN } from "./dialer/parallel-limits";
import type { DialerUserPrefs } from "./dialer/user-prefs";
import type { AgentKey } from "./elevenlabs";
import type { CallOutcome, Lead } from "./types";
import { formatPhone, toE164 } from "./utils";

export type DialerStatus = "idle" | "dialing" | "live" | "wrapup" | "ai";
export type DialerMode = "connecting" | "live" | "offline";
/** The dialer's explicit mode — one word the whole shell can reason about.
 *  Derived from (and kept in sync with) aiMode + parallelCount, the two knobs
 *  the engine actually runs on; setSessionMode() moves both together. */
export type SessionMode = "manual" | "ai" | "parallel";
export type { MuteCapability } from "./dialer/mute-intent";

/** Claim scope at dial time — what /api/dialer/claim narrows eligibility by. */
export interface DialerClaimContext {
  /** Segment statuses of the loaded session (absent = server default set). */
  statuses?: string[];
  campaignId?: string;
  /** Assignment (lead pack) id when the queue is scoped to one. */
  packId?: string;
  /**
   * Queue fidelity (the mis-dial fix). `strictOrder` (DEFAULT: true) claims
   * ONLY from the display queue, in the rep's order from their current
   * position — Start can never ring someone who isn't on the list on screen.
   * `refill` (default false) opts back into pool-claiming, but only AFTER the
   * loaded list is exhausted, and the provider is told it happened.
   */
  strictOrder?: boolean;
  refill?: boolean;
}

/** Optional engine behaviors threaded from org settings via DialerProvider. */
export interface DialerEngineOptions {
  /** Org policy `settings.dialing.recording` — the conference record flag the
   *  rep leg passes to Twilio. There is deliberately NO client toggle. */
  recordingEnabled?: boolean;
  /** Org default for local presence (`settings.dialing.localPresence`). The rep
   *  can override it on the dialer; their choice is what actually gets sent. */
  localPresenceDefault?: boolean;
  /** Lease-based dial reservations (`settings.dialing.reservations`). When on,
   *  startHumanCall claims leads server-side instead of slicing the local
   *  queue — the two-reps-same-lead fix. Off/absent = the legacy local path
   *  (also the demo-mode path — claims need a database). */
  reservations?: {
    enabled: boolean;
    getContext: () => DialerClaimContext;
    /** Claimed leads may be absent from the local queue — the provider merges
     *  them into display state so the UI shows what's actually being dialed. */
    onClaimed?: (leads: Lead[]) => void;
    /** The strict list ran dry and refill mode pulled these from the eligible
     *  pool instead — the provider says so out loud (never a silent swap). */
    onQueueRefilled?: (leads: Lead[]) => void;
  };
  /** A dial round contained two leads sharing one phone number, so the later
   *  duplicates were dropped before anything rang (first occurrence kept —
   *  see src/lib/dialer/lane-dedupe.ts). The provider surfaces this (toast)
   *  and counts it (`lane.dup_dropped`). */
  onDuplicateLanesDropped?: (dropped: Lead[]) => void;
  /**
   * Which mode the dialer BOOTS into (`settings.dialing.defaultMode`).
   * Resolution: "ai" only when AI is actually usable (falls back to manual);
   * "parallel" only when the line ceiling allows >1 (falls back to manual).
   * Absent = the historical behavior: AI whenever usable, else manual.
   */
  initialMode?: "manual" | "parallel" | "ai";
  /**
   * The viewer's own dialer prefs (profile preferences.dialerPrefs), resolved
   * server-side. Personal defaults layered on top of org policy: the parallel
   * default only applies to a manual boot with a >1 line ceiling.
   */
  userPrefs?: DialerUserPrefs;
}

export interface DialLine {
  id: string;
  lead: Lead;
  status: "ringing" | "connected" | "canceled" | "no_answer";
}

/** One AI call launched in the current dialer session. */
export interface AiLaunch {
  conversationId: string | null;
  leadId: string;
  leadName: string;
  error?: string;
  /** The outbound caller ID this call was actually placed from. */
  callerId?: string | null;
  /** The lead's number, so a row can say who it dialed, not just who it called. */
  phone?: string;
  /** Which attempt at THIS lead this row is (1 = first, 2 = the double-tap or a
   *  rep-pressed "Dial again"). Lets a row say "attempt 2" instead of looking
   *  like a duplicate. */
  attempt?: number;
  /** ms epoch the dial was placed — the row's own clock, independent of any
   *  state broadcast that may never arrive. */
  startedAt?: number;
}

/** What the user knows about an ad-hoc number when there's no lead record. */
export interface KnownInfo {
  firstName?: string;
  lastName?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  utilityProvider?: string;
  solarProvider?: string;
  utilityBill?: number;
  solarPayment?: number;
  notes?: string;
}

export interface CallerIdInfo {
  callerId: string;
  pool: string[];
  poolIndex: number;
  rotateEvery: number;
}

export interface DialerState {
  status: DialerStatus;
  /** Explicit mode word derived from aiMode + parallelCount (see SessionMode). */
  sessionMode: SessionMode;
  lines: DialLine[];
  connectedLead: Lead | null;
  durationSec: number;
  muted: boolean;
  /** What the mute control can honestly do for the CURRENT attempt — "arming"
   *  covers the sub-second window between Start and device.connect() resolving,
   *  where a toggle is queued and applied the instant the rep leg exists. */
  muteCapability: MuteCapability;
  onHold: boolean;
  /** Org policy (settings.dialing.recording) — NOT a client toggle. This is
   *  what the rep leg actually passes to Twilio's conference record flag, so
   *  the REC indicator can never claim a recording that isn't being made. */
  recording: boolean;
  autoDial: boolean;
  parallelCount: number;
  /** Ceiling for parallelCount in the CURRENT mode (human 3, AI = plan limit). */
  maxParallel: number;
  lastOutcome: CallOutcome | null;
  mode: DialerMode;
  /** The active call's media briefly dropped and the Twilio SDK is auto-recovering
   *  it. The call is NOT over — this rides out a transient blip instead of letting
   *  it read as a dead call the rep hangs up on. */
  reconnecting: boolean;
  /**
   * getUserMedia was refused, so this browser has no microphone to put into a
   * call. The Twilio Device still REGISTERS fine without one — registration
   * needs no audio — which is why the dialer used to sit there reading "Twilio
   * Live" while every single dial rang a homeowner the rep could never speak
   * to. Surfaced so manual dialing can be held back until it's fixed.
   */
  micBlocked: boolean;
  callsThisSession: number;
  /** The subset of `callsThisSession` the AI agent placed. Manual dials are
   *  therefore `callsThisSession - aiCallsThisSession`. */
  aiCallsThisSession: number;
  connectsThisSession: number;
  /** Running dial total for the whole local day — persists across refresh/logout. */
  dialsToday: number;
  /** The subset of `dialsToday` the AI agent placed (persisted per rep/day). */
  aiDialsToday: number;
  queueIndex: number;
  /** Bumped every time auto-dial completes a full pass through the queue (either
   *  mode). The parent (dialer-client) watches this to refetch the dial queue
   *  from the server — dropping leads just dispositioned this pass — before
   *  starting the next pass, so "repeat the list" never blindly re-calls
   *  someone just marked not-interested/DNC/booked. */
  queueLap: number;
  error: string | null;
  callSid: string | null;
  /** Conference room for the active manual call — links its recording. */
  room: string | null;
  /** Per-lead idempotency keys for the active round — every disposition save
   *  carries its lead's key so an outbox replay can never double-file. */
  attemptIds: Record<string, string>;
  /** Outbound call SIDs for the homeowner legs — used for hold/unhold. */
  outboundSids: string[];
  /** Which caller ID is active and rotation pool info — shown in session bar. */
  callerIdInfo: CallerIdInfo | null;
  /** Numbers the rep toggled off in the dialer's caller-ID picker; empty means
   *  every pool number is eligible (default — matches today's full rotation). */
  excludedCallerIds: string[];
  /** Match the caller ID's area code to the lead's, when the pool allows it.
   *  Seeded from the org default, then remembered per rep. */
  localPresence: boolean;
  /** AI calling is the default; flip off for manual (human Twilio) dialing. */
  aiMode: boolean;
  /** Which AI persona AI calls dial as. Only meaningful when a second agent is
   *  configured; otherwise it's always "primary". */
  activeAgent: AgentKey;
  aiCalls: AiLaunch[];
  aiCampaign: "idle" | "running" | "done";
}

// ── Daily dial counter (persists across refresh / logout) ─────────────────────
// Reps wanted a running "dials today" total that survives closing the app or
// logging out — the per-session counter resets on every reload. We keep it in
// localStorage keyed by user + local calendar day, so it carries through the
// whole day on the same device and naturally resets at midnight.
const DIAL_KEY_PREFIX = "aj:dials:";
// AI dials are counted separately, not carved out of the total: the dialer
// places both kinds in one session and "how many did the agent make" is a
// different question from "how many did I make". Same per-user, per-local-day
// keying as the total, so both roll over together and both get swept.
const AI_DIAL_KEY_PREFIX = "aj:aiDials:";

function localDayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function dialStorageKey(userId?: string): string {
  return `${DIAL_KEY_PREFIX}${userId || "anon"}:${localDayStr()}`;
}

function aiDialStorageKey(userId?: string): string {
  return `${AI_DIAL_KEY_PREFIX}${userId || "anon"}:${localDayStr()}`;
}

function readAiDialsToday(userId?: string): number {
  if (typeof window === "undefined") return 0;
  try {
    return Number(window.localStorage.getItem(aiDialStorageKey(userId))) || 0;
  } catch {
    return 0;
  }
}

function writeAiDialsToday(userId: string | undefined, value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(aiDialStorageKey(userId), String(value));
  } catch {
    /* storage full / disabled — counter just won't persist */
  }
}

function readDialsToday(userId?: string): number {
  if (typeof window === "undefined") return 0;
  try {
    return Number(window.localStorage.getItem(dialStorageKey(userId))) || 0;
  } catch {
    return 0;
  }
}

function writeDialsToday(userId: string | undefined, value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(dialStorageKey(userId), String(value));
  } catch {
    /* storage full / disabled — counter just won't persist */
  }
}

/** Drop dial-counter keys from previous days so storage doesn't grow. Only
 *  prunes keys whose day suffix isn't today, so a different user's same-day
 *  count on a shared device is left intact. */
/**
 * Is this a dial-counter key from a day that isn't `today`?
 *
 * Pure and exported so the sweep's rule is testable: it has to prune BOTH the
 * total and the AI-only prefix, and it must never prune the current day —
 * getting that backwards would quietly reset a rep's counters on every mount.
 */
export function isStaleDialKey(key: string, today: string): boolean {
  const isDialKey = key.startsWith(DIAL_KEY_PREFIX) || key.startsWith(AI_DIAL_KEY_PREFIX);
  return isDialKey && !key.endsWith(`:${today}`);
}

function sweepOldDialKeys(): void {
  if (typeof window === "undefined") return;
  try {
    const today = localDayStr();
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && isStaleDialKey(k, today)) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* best-effort */
  }
}

// ── Excluded caller IDs (persists across refresh / logout) ────────────────────
// Which pool numbers a rep has toggled OFF in the dialer's caller-ID picker.
// Keyed by user only (no day component — unlike dialsToday, this isn't meant
// to reset daily). Stale entries (a number since removed from the org pool)
// are harmless: the server only ever intersects this against the live pool.
const EXCLUDED_CALLER_ID_KEY_PREFIX = "aj:excludedCallerIds:";

function excludedCallerIdStorageKey(userId?: string): string {
  return `${EXCLUDED_CALLER_ID_KEY_PREFIX}${userId || "anon"}`;
}

function readExcludedCallerIds(userId?: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(excludedCallerIdStorageKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function writeExcludedCallerIds(userId: string | undefined, value: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(excludedCallerIdStorageKey(userId), JSON.stringify(value));
  } catch {
    /* storage full / disabled — the choice just won't persist */
  }
}

// ── Local presence (area-code matching) ──────────────────────────────────────
// The org sets the default (Admin → Dialing → "Local presence"); the rep can
// flip it for themselves on the dialer and that choice sticks per rep, exactly
// like the caller-ID picker's exclusions. Absent from storage = follow the org.
const LOCAL_PRESENCE_KEY_PREFIX = "aj:localPresence:";

function localPresenceStorageKey(userId?: string): string {
  return `${LOCAL_PRESENCE_KEY_PREFIX}${userId || "anon"}`;
}

function readLocalPresence(userId: string | undefined, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(localPresenceStorageKey(userId));
    return raw == null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeLocalPresence(userId: string | undefined, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localPresenceStorageKey(userId), value ? "1" : "0");
  } catch {
    /* storage full / disabled — the choice just won't persist */
  }
}

/** Build a lightweight Lead for an ad-hoc manual dial (not a queued lead). */
function manualLead(e164: string): Lead {
  return {
    id: `manual-${Date.now().toString(36)}`,
    firstName: formatPhone(e164),
    lastName: "",
    phone: e164,
    address: "",
    city: "",
    state: "",
    zip: "",
    utilityProvider: "",
    solarProvider: "",
    status: "new",
    campaignId: "",
    hasEV: false,
    hasPool: false,
    hasBattery: false,
    multipleSystems: false,
    createdAt: new Date().toISOString(),
    timezone: "",
  };
}

// ── Concurrency ──────────────────────────────────────────────────────────────
/**
 * How often the pump checks for a FREE LINE. This is a poll interval, not a
 * launch interval — the old code launched a whole fresh batch on every tick,
 * which is what turned a "3 concurrent" setting into ~22 calls a minute.
 */
const AI_PUMP_MS = 5_000;
/**
 * A slot is force-released after this long. A call that never reports a terminal
 * state would otherwise hold its line forever and stall the campaign at N-1.
 */
const AI_SLOT_MAX_MS = 12 * 60_000;

// Imported (not re-declared) from a pure, server-safe sibling — see that
// file's header for why the two constants used to drift — then re-exported so
// every existing `import { MAX_PARALLEL_HUMAN } from "@/lib/use-dialer"` still
// resolves. A bare `export { X } from "./y"` does NOT bind X into this file's
// own scope, and both constants are used throughout the rest of this hook.
export { MAX_PARALLEL_HUMAN, MAX_PARALLEL_AI };

/** One derivation for the mode word, so every setter that moves aiMode or
 *  parallelCount computes sessionMode identically and the two can't drift. */
function deriveSessionMode(aiMode: boolean, parallelCount: number): SessionMode {
  return aiMode ? "ai" : parallelCount > 1 ? "parallel" : "manual";
}

/**
 * The concurrency a fresh session boots at. Pure and exported so this exact
 * contract is pinned by a test, independent of mounting the hook.
 *
 * AI mode ALWAYS starts at the org's configured ceiling (Admin → AI settings
 * → "Max concurrent calls") — that setting IS the org's stated intent for how
 * many lines the agent should run, not a cap a rep has to remember to click
 * up to every session. Before this existed, AI boot always landed on 1
 * regardless of the setting: the ceiling said 10, the actual dial count
 * silently said 1, and "the AI dialer isn't running 10x" was true every
 * single session until someone clicked the parallel-count button row.
 *
 * Manual mode keeps its own, deliberately different default: the org's
 * default mode, or the rep's own "default to full parallel" preference —
 * either way only for a manual boot with room. A human rep opting INTO
 * multiple ringing lines is a real decision with real abandonment risk, so it
 * stays behind an explicit choice rather than defaulting on.
 */
export function bootParallelCount(input: {
  bootAiMode: boolean;
  initialMode: "manual" | "parallel" | "ai";
  maxAiConcurrency: number;
  humanCeiling: number;
  parallelDefaultPref: boolean;
}): number {
  if (input.bootAiMode) {
    return Math.max(1, Math.min(MAX_PARALLEL_AI, input.maxAiConcurrency));
  }
  return input.initialMode === "parallel" || input.parallelDefaultPref
    ? Math.max(1, input.humanCeiling)
    : 1;
}

/**
 * The concurrency to land on when TOGGLING modes mid-session. Pure and
 * exported for the same reason as bootParallelCount above.
 *
 * The two directions are NOT symmetric, on purpose:
 *   - Entering AI mode JUMPS STRAIGHT to the org's configured AI ceiling.
 *     The whole point of an org setting 10 concurrent calls is that AI mode
 *     runs at 10 — not "at whatever number manual mode was left on, capped
 *     at 10" (which for a typical manual session is 1, so this had the exact
 *     same silent-1x bug as the boot path).
 *   - Leaving AI mode only ever CLAMPS DOWN. A human rep genuinely cannot
 *     hold ten answered lines, so carrying "10" over to manual would abandon
 *     nine homeowners on the spot.
 */
export function parallelCountOnModeSwitch(input: {
  enteringAi: boolean;
  current: number;
  maxAiConcurrency: number;
  humanCeiling: number;
}): number {
  const ceiling = input.enteringAi
    ? Math.max(1, Math.min(MAX_PARALLEL_AI, input.maxAiConcurrency))
    : input.humanCeiling;
  return input.enteringAi ? ceiling : Math.min(input.current, ceiling);
}

export function useDialer(
  queue: Lead[],
  aiConfigured = false,
  userId?: string,
  /** Gate for the Twilio device. The dialer now lives in an app-wide provider so
   *  a call survives navigation; without this gate the device would initialize
   *  (and prompt for mic) for every user on every page. The provider flips this
   *  true only once the dialer is actually opened, and keeps it true after — so
   *  the device persists across route changes. */
  enabled = true,
  /** The org's AI concurrency allowance (their voice plan's live-call limit). */
  maxAiConcurrency = 10,
  /** AI double-dial: re-ring a NO-ANSWER once, `doubleDialGapSec` later, before
   *  moving on. Two quick missed calls read as important and lift pickup. */
  doubleDial = false,
  doubleDialGapSec = 15,
  /**
   * The org's own ceiling on simultaneous HUMAN lines (Admin → Dialing → "Max
   * lines"). Setting it to 1 turns off parallel dialing for the workspace: a
   * team that only ever wants one homeowner on the line at a time no longer
   * gets 2X/3X offered. Clamped to the platform maximum — an org can dial fewer
   * lines than MAX_PARALLEL_HUMAN, never more, because a rep still can't hold
   * more than a few answered calls without abandoning someone.
   */
  maxHumanLines = MAX_PARALLEL_HUMAN,
  /** Org-policy behaviors (recording flag, dial reservations). See the type. */
  options: DialerEngineOptions = {},
) {
  const humanCeiling = Math.max(
    1,
    Math.min(MAX_PARALLEL_HUMAN, Math.floor(maxHumanLines) || MAX_PARALLEL_HUMAN),
  );
  const recordingEnabled = options.recordingEnabled ?? true;
  const localPresenceDefault = options.localPresenceDefault ?? true;
  // Resolve the org's chosen boot mode against what's actually usable. The old
  // behavior (AI whenever usable) is exactly initialMode:"ai", which is also
  // the absent-key default — so nothing changes until an admin picks otherwise.
  const initialMode = options.initialMode ?? "ai";
  const bootAiMode = aiConfigured && initialMode === "ai";
  // Parallel at boot. AI mode ALWAYS starts at the org's configured AI
  // concurrency (Admin → AI settings → "Max concurrent calls", 10 by
  // default) — that setting IS the org's stated intent for how many lines
  // the agent should run, not a ceiling a rep has to remember to click up to
  // every session. Before this, AI boot always landed on 1 regardless of the
  // setting: the ceiling said 10, the actual dial count silently said 1,
  // and "the AI dialer isn't running 10x" was true every single session
  // until someone clicked the button row.
  //
  // Manual mode keeps its own, deliberately different default: the org's
  // default mode, or the rep's own "default to full parallel" preference —
  // either way only for a manual boot with room. A human rep opting INTO
  // multiple ringing lines is a real decision with real abandonment risk, so
  // it stays behind an explicit choice rather than defaulting on.
  const initialParallelCount = bootParallelCount({
    bootAiMode,
    initialMode,
    maxAiConcurrency,
    humanCeiling,
    parallelDefaultPref: options.userPrefs?.parallelDefault ?? false,
  });
  const [state, setState] = useState<DialerState>({
    status: "idle",
    sessionMode: deriveSessionMode(bootAiMode, initialParallelCount),
    lines: [],
    connectedLead: null,
    durationSec: 0,
    muted: false,
    muteCapability: "unsupported",
    onHold: false,
    recording: recordingEnabled,
    autoDial: options.userPrefs?.autoDialNext ?? false,
    parallelCount: initialParallelCount,
    maxParallel: bootAiMode ? maxAiConcurrency : humanCeiling,
    lastOutcome: null,
    mode: "connecting",
    reconnecting: false,
    micBlocked: false,
    callsThisSession: 0,
    aiCallsThisSession: 0,
    connectsThisSession: 0,
    dialsToday: 0,
    aiDialsToday: 0,
    queueIndex: 0,
    queueLap: 0,
    error: null,
    callSid: null,
    room: null,
    attemptIds: {},
    outboundSids: [],
    callerIdInfo: null,
    excludedCallerIds: [],
    localPresence: true,
    aiMode: bootAiMode,
    activeAgent: "primary",
    aiCalls: [],
    aiCampaign: "idle",
  });

  const queueIndexRef = useRef(0);
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  /**
   * A token-expiry error (20104/31205) that arrived WHILE a call was live. The
   * fix for that error is to rebuild the Device — but rebuilding destroys it,
   * which would drop the very call the rep is on. So we defer: flag it here and
   * rebuild the instant the call ends (see endCall/resetToIdle), never during.
   */
  const pendingRebuildRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Watches the winning homeowner leg AFTER connect on a parallel dial. At 2x/3x
  // the conference has endOnExit=false, so the customer hanging up does NOT end
  // the rep's leg — without this the rep would sit on "live" talking to nobody.
  const customerWatchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * The CURRENT attempt's answered-poll body, exposed so the org realtime
   * channel (DialerProvider) can run one resolution pass the instant a
   * `call.answered` broadcast arrives instead of waiting out the interval.
   * Null whenever no answered-poll is active — a stray hint then does nothing.
   */
  const answeredPollFnRef = useRef<(() => Promise<void>) | null>(null);
  /**
   * Whether the org floor channel is live (set by DialerProvider). While it is,
   * the answered poll relaxes 1.5s → 5s: the broadcast is the fast path and the
   * poll is only the safety net. Read at poll START (dial time) — a mid-call
   * health flip keeps the interval it started with, which at worst costs one
   * 5s detection until the next dial.
   */
  const realtimeLiveRef = useRef(false);
  const presenceSnapshotRef = useRef<{
    status: DialerStatus;
    lead: { name?: string; city?: string; phone?: string } | null;
    aiActiveCount: number;
  }>({ status: "idle", lead: null, aiActiveCount: 0 });
  const identityRef = useRef<string>("agent");
  /** Server-signed proof that `identityRef` was issued to us — renews it in place. */
  const identityProofRef = useRef<string>("");
  // Behavior refs boot from the SAME values as state — startCall() and the
  // dial paths read the refs, not state, so a mismatch here is not cosmetic:
  // with defaultMode "manual" and AI usable, `useRef(aiConfigured)` made the
  // Start button silently launch an AI SESSION from a UI that said Manual.
  // (Caught by review — the org's manual-first choice inverted into AI calls.)
  const autoDialRef = useRef(options.userPrefs?.autoDialNext ?? false);
  const parallelRef = useRef(initialParallelCount);
  const modeRef = useRef<DialerMode>("connecting");
  const aiModeRef = useRef(bootAiMode);
  const activeAgentRef = useRef<AgentKey>("primary");
  const excludedCallerIdsRef = useRef<string[]>([]);
  const localPresenceRef = useRef<boolean>(true);
  const aiConfiguredRef = useRef(aiConfigured);
  const aiCursorRef = useRef(0);
  /**
   * Leads in the current round the SERVER refused to dial (enforced calling
   * hours, per-leg placement failure). They never rang, so no cleanup path may
   * fabricate a no_answer record for them — recordNonWinners skips this set.
   */
  const undialedRef = useRef<Set<string>>(new Set());
  /** A strict claim advanced the cursor for this round; advanceQueue consumes
   *  it instead of double-advancing. lapWrapped records whether that advance
   *  wrapped the list (the lap boundary, read by isCompletingLap). */
  const claimAdvancedRef = useRef(false);
  const lapWrappedRef = useRef(false);
  /**
   * Conversations we've launched that haven't finished. THIS is what makes
   * `parallelCount` an actual concurrency limit rather than a batch size.
   */
  const inflightRef = useRef<Set<string>>(new Set());
  /** When each slot was taken — so a call that never ends can't hold one forever. */
  const slotAgeRef = useRef<Map<string, number>>(new Map());
  const maxAiRef = useRef(maxAiConcurrency);
  useEffect(() => {
    maxAiRef.current = maxAiConcurrency;
  }, [maxAiConcurrency]);
  // The org's human-line ceiling, mirrored so mode switches and clamps read the
  // current value without re-creating the callbacks that use it.
  const humanCeilingRef = useRef(humanCeiling);
  useEffect(() => {
    humanCeilingRef.current = humanCeiling;
    // A ceiling that just dropped (an admin lowered "Max lines") must pull an
    // already-selected count down with it, or the rep keeps dialing 3X on a
    // workspace that has since been set to 1.
    setState((s) => {
      if (s.aiMode) return s;
      const clamped = Math.min(s.parallelCount, humanCeiling);
      if (s.parallelCount === clamped && s.maxParallel === humanCeiling) return s;
      parallelRef.current = clamped;
      return {
        ...s,
        parallelCount: clamped,
        maxParallel: humanCeiling,
        sessionMode: deriveSessionMode(false, clamped),
      };
    });
  }, [humanCeiling]);

  // ── Engine options (org policy) ────────────────────────────────────────────
  // Mirrored to refs so dial-time code reads the CURRENT values without being
  // re-created; the reservation callbacks close over nothing stale.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const recordingRef = useRef(recordingEnabled);
  useEffect(() => {
    recordingRef.current = recordingEnabled;
    // Keep the display flag honest if the org's policy changes mid-session.
    setState((s) => (s.recording === recordingEnabled ? s : { ...s, recording: recordingEnabled }));
  }, [recordingEnabled]);
  /** Lead ids this rep currently HOLDS via /api/dialer/claim (on-screen round). */
  const claimedIdsRef = useRef<Set<string>>(new Set());
  /** state.status mirror for interval callbacks (heartbeat). */
  const statusRef = useRef<DialerStatus>("idle");
  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);
  /** A mute toggle pressed before device.connect() resolved — applied by
   *  attachCallHandlers the moment the rep leg exists (pre-answer mute). */
  const pendingMuteRef = useRef<boolean | null>(null);

  /**
   * Let go of the held claims for the current round. Skip/reset release them
   * client-side (nothing was filed — the leads must be claimable again NOW);
   * a disposition releases nothing here because the server clears the hold
   * itself when the outcome write lands (markLeadAttempted in insertCallRecord)
   * — a client release racing that write could hand the lead to another rep
   * before its attempt counter advanced.
   */
  const releaseClaimedLeads = useCallback((action: ClaimReleaseAction) => {
    const ids = computeReleaseSet(action, claimedIdsRef.current);
    claimedIdsRef.current.clear();
    if (!ids.length || !optionsRef.current.reservations?.enabled) return;
    fetch("/api/dialer/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leadIds: ids }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  // Renew the holds for on-screen leads every 60s while a session is active —
  // the reservation TTL is 180s, so one missed beat is survivable and two are
  // not, which is exactly the behavior we want when a tab actually died.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (!optionsRef.current.reservations?.enabled) return;
      if (statusRef.current === "idle") return;
      const ids = [...claimedIdsRef.current];
      if (!ids.length) return;
      fetch("/api/dialer/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadIds: ids }),
      }).catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, [enabled]);
  // ── AI double-dial (double-tap) ────────────────────────────────────────────
  const doubleDialRef = useRef(doubleDial);
  const doubleDialGapMsRef = useRef(Math.max(5, doubleDialGapSec) * 1000);
  useEffect(() => {
    doubleDialRef.current = doubleDial;
    doubleDialGapMsRef.current = Math.max(5, doubleDialGapSec) * 1000;
  }, [doubleDial, doubleDialGapSec]);
  /** How many times we've dialed each lead THIS session (1 = first, 2 = the tap). */
  const attemptsRef = useRef<Map<string, number>>(new Map());
  /** conversationId → the lead it was for, so a no-answer can find its lead to re-ring. */
  const convLeadRef = useRef<Map<string, Lead>>(new Map());
  /**
   * leadId → the lead, for every lead this AI session has dialed. convLeadRef is
   * deleted the moment a call ends (it exists only to route the automatic
   * double-tap), so it can't back a rep-initiated "Dial again" — by the time the
   * button is worth pressing, the entry is gone. This one lives for the session.
   */
  const aiLeadByIdRef = useRef<Map<string, Lead>>(new Map());
  /** Leads waiting for their second (double-tap) dial, keyed by lead id. Each also
   *  holds a `redial:<id>` slot in inflightRef through the gap, so the pump keeps a
   *  line free for the re-ring instead of racing ahead to the next lead. */
  const redialsRef = useRef<Map<string, { dueAt: number; lead: Lead }>>(new Map());
  /** Fires each pending re-ring at its own due time (see tickRedials). */
  const redialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const humanIdRef = useRef<string | null>(null);
  /** Per-lead idempotency keys for the CURRENT round (mirrors state.attemptIds
   *  for code paths that run outside React's render cycle). */
  const attemptIdsRef = useRef<Record<string, string>>({});
  // Monotonically incremented on every AI session start/end so in-flight fetch
  // callbacks from a prior session can detect they're stale and skip setState.
  const sessionGenRef = useRef(0);
  // Whether manual PSTN dialing is possible (a Twilio caller ID is configured).
  const canDialOutRef = useRef(true);
  /** Mirrors state.micBlocked for the dial path, which reads it synchronously. */
  const micOkRef = useRef(true);
  /**
   * The outbound homeowner leg(s) of the attempt in flight, held here so that
   * EVERY teardown path can hang them up — not just the two that happened to
   * remember to. Cleared in connectLine(): once a homeowner is bridged this is
   * a live conversation, and releasing it would drop the rep mid-sentence.
   */
  const activeLegsRef = useRef<{
    sids: string[];
    dialed: { leadId: string; phone: string }[];
  }>({ sids: [], dialed: [] });
  /**
   * A dial is between "pressed Start" and "joined or failed". Without this, a
   * rep mashing Start placed one real outbound call per click — 9 in 8 seconds
   * in production, on a workspace whose Max lines is 1.
   */
  const dialInFlightRef = useRef(false);
  /**
   * True once a homeowner is actually bridged to the rep on the current attempt.
   *
   * The difference between "the call ended" and "the call never happened" is not
   * cosmetic: one deserves the disposition screen, the other is a failure the rep
   * needs told about. Without this they were the same code path, so a rep whose
   * own leg Twilio dropped mid-ring got a wrap-up form for a conversation that
   * never occurred.
   */
  const bridgedRef = useRef(false);
  /**
   * Set immediately before WE hang the rep's leg up on purpose — the End call
   * button, a no-answer, the 3-minute timeout. The `disconnect` event can't tell
   * "we ended this" from "Twilio killed our leg" on its own, and treating the
   * second as the first is what dressed a failed dial up as a completed call.
   */
  const intentionalEndRef = useRef(false);
  // Daily dial counter — ref is the source of truth (seeded from localStorage),
  // mirrored to state.dialsToday for display. userIdRef keys the storage per rep.
  const dialsTodayRef = useRef(0);
  const aiDialsTodayRef = useRef(0);
  const userIdRef = useRef(userId);
  // Bumped on every device (re-)setup so async callbacks from a torn-down or
  // superseded Device can detect they're stale and bail instead of fighting.
  const deviceGenRef = useRef(0);
  // Source of truth for state.queueLap (see DialerState.queueLap).
  const queueLapRef = useRef(0);
  // Screen Wake Lock held while a dialing session is active, so a rep's phone
  // doesn't suspend the tab (and drop the Twilio websocket) mid-session.
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const patch = useCallback((p: Partial<DialerState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  // Increment the persisted daily dial total by n. Updates the ref + localStorage
  // synchronously; callers mirror dialsTodayRef.current into state for display.
  // `channel` also credits the AI-only total, so the two never drift apart —
  // there is exactly one place that knows a dial happened.
  const recordDials = useCallback((n: number, channel: "human" | "ai" = "human") => {
    dialsTodayRef.current += n;
    writeDialsToday(userIdRef.current, dialsTodayRef.current);
    if (channel === "ai") {
      aiDialsTodayRef.current += n;
      writeAiDialsToday(userIdRef.current, aiDialsTodayRef.current);
    }
  }, []);

  // ── Human-call live presence (Live Monitor) ───────────────────────────────
  const postHuman = useCallback(
    (action: "connect", extra: Record<string, unknown> = {}) => {
      const id = humanIdRef.current;
      if (!id) return;
      fetch("/api/calls/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id, ...extra }),
      }).catch(() => {});
    },
    [],
  );

  /**
   * Hang up outbound legs we placed but can no longer bridge the rep into.
   * Fire-and-forget: the rep is already back at idle, and an abandoned call
   * ringing a real person is worse than a failed cleanup request.
   *
   * Takes the numbers we dialed as well as the SIDs, because the failure this
   * exists for includes "the response carrying the SIDs never arrived" — and in
   * that case the numbers are the only handle we have on calls that are, right
   * now, ringing somebody's house.
   */
  const releaseLegs = useCallback(
    (sids: string[], dialed: { leadId: string; phone: string }[] = []) => {
      if (!sids.length && !dialed.length) return;
      fetch("/api/twilio/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sids, leads: dialed }),
        keepalive: true,
      }).catch(() => {});
    },
    [],
  );

  /**
   * Hang up the outbound leg(s) of an attempt that never reached the rep.
   *
   * connectLine() clears the ref, so once a homeowner is actually bridged this
   * is a no-op and a live conversation can never be cut. Everywhere else, a
   * teardown means nobody is coming — and the leg has to go rather than ring
   * a real person into an empty conference.
   */
  const releaseActiveLegs = useCallback(() => {
    const { sids, dialed } = activeLegsRef.current;
    activeLegsRef.current = { sids: [], dialed: [] };
    if (sids.length || dialed.length) releaseLegs(sids, dialed);
  }, [releaseLegs]);

  /**
   * Ask Twilio which of the numbers we just dialed are actually in flight.
   *
   * The counterpart to releaseLegs: same problem (we lost the SIDs), opposite
   * resolution (finish the call rather than abandon it). Returns an empty list
   * on any failure, so the caller falls through to its normal "nothing was
   * dialed" handling and never invents a call that doesn't exist.
   */
  const recoverPlacedLegs = useCallback(
    async (
      dialed: { leadId: string; phone: string }[],
    ): Promise<{ leadId: string; sid: string }[]> => {
      if (!dialed.length) return [];
      try {
        const res = await fetch("/api/twilio/legs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leads: dialed }),
        });
        if (!res.ok) return [];
        const json = (await res.json().catch(() => ({}))) as {
          calls?: { leadId?: string; sid?: string }[];
        };
        return (json.calls ?? [])
          .filter((c): c is { leadId: string; sid: string } =>
            Boolean(c?.sid && c?.leadId),
          )
          .map((c) => ({ leadId: c.leadId, sid: c.sid }));
      } catch {
        return [];
      }
    },
    [],
  );

  const clearHumanPresence = useCallback(() => {
    const id = humanIdRef.current;
    if (!id) return;
    humanIdRef.current = null;
    fetch("/api/calls/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "end", id }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  // ── Per-user live presence (manager Team Status roster) ──────────────────
  const postPresence = useCallback(
    (
      status: DialerStatus,
      lead: { name?: string; city?: string; phone?: string } | null,
      aiActiveCount: number,
    ) => {
      fetch("/api/team/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, lead, aiActiveCount }),
      }).catch(() => {});
    },
    [],
  );

  const clearMyPresence = useCallback(() => {
    fetch("/api/team/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "offline" }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const stopTick = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  const startTick = useCallback(() => {
    stopTick();
    tickRef.current = setInterval(() => {
      setState((s) => ({ ...s, durationSec: s.durationSec + 1 }));
    }, 1000);
  }, [stopTick]);

  const stopPoll = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (customerWatchRef.current) clearInterval(customerWatchRef.current);
    customerWatchRef.current = null;
    // No poll running ⇒ nothing for a realtime answered-hint to trigger.
    answeredPollFnRef.current = null;
  }, []);

  const stopAITimer = useCallback(() => {
    if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    aiTimerRef.current = null;
  }, []);

  /**
   * Fetch a Voice access token from the server.
   *
   * `identity` MUST be passed when REFRESHING the token of a live Device. Twilio
   * requires a renewed token to carry the same identity — hand `updateToken()` a
   * token minted for a different one and the Device re-registers as a different
   * client, which is registration churn at best and a dropped call at worst.
   * The idle health check runs every 25 s, so without this the browser was
   * silently changing Twilio identity all day long.
   */
  const fetchVoiceToken = useCallback(async (renew = false) => {
    try {
      // Renewals ask to keep the current identity, proving it was issued to us.
      const id = identityRef.current;
      const proof = identityProofRef.current;
      const url =
        renew && id && proof
          ? `/api/twilio/token?identity=${encodeURIComponent(id)}&proof=${encodeURIComponent(proof)}`
          : "/api/twilio/token";
      const res = await fetch(url, { cache: "no-store" });
      return (await res.json()) as {
        token?: string;
        identity?: string;
        identityProof?: string;
        mode: string;
        canDialOut?: boolean;
      };
    } catch {
      return null;
    }
  }, []);

  /**
   * Record the identity the server actually issued.
   *
   * Deliberately separate from fetching, and only ever called AFTER the caller's
   * staleness check: a superseded setup that wrote these refs would leave the
   * LIVE device renewing under an identity that isn't its own — which is exactly
   * the identity switch this whole mechanism exists to prevent.
   */
  const adoptIdentity = useCallback(
    (data: { identity?: string; identityProof?: string } | null) => {
      if (!data?.identity) return;
      identityRef.current = data.identity;
      identityProofRef.current = data.identityProof ?? "";
    },
    [],
  );

  // ── Initialize (or re-initialize) the Twilio device ───────────────────────
  // Tokens are short-lived (1h). Without renewal the device silently goes dead
  // mid-shift — the homeowner-reported "dialer just stops letting me dial, even
  // after refresh." setupDevice() builds the Device AND wires its full lifecycle:
  //   • tokenWillExpire → fetch a new token and updateToken() in place (no drop)
  //   • error 20104/31205 (token expired/invalid) → full rebuild
  //   • unregistered → re-register
  // It's also the manual reconnect path, so a wedged device is always one tap
  // from recovery rather than requiring a reload (which Safari didn't always fix).
  const setupDevice = useCallback(async () => {
    const gen = ++deviceGenRef.current;
    try {
      deviceRef.current?.destroy();
    } catch {
      /* noop */
    }
    deviceRef.current = null;
    modeRef.current = "connecting";
    patch({ mode: "connecting", error: null });

    const data = await fetchVoiceToken();
    if (deviceGenRef.current !== gen) return;
    if (!data?.token) {
      modeRef.current = "offline";
      patch({ mode: "offline" });
      return;
    }
    // This setup is still the current one, so this identity is now OUR identity —
    // every later renewal renews it in place rather than picking up a new one.
    adoptIdentity(data);

    // Request mic permission BEFORE creating the Device. Browsers (Safari most
    // strictly) block audio silently when permission is first asked mid-call;
    // doing it now, during setup, surfaces the prompt at a sane moment. We
    // release the stream immediately — the SDK re-acquires it per call.
    //
    // The outcome is RECORDED, not swallowed. Registration succeeds without a
    // microphone, so the old "register anyway; connect() will surface a real
    // error" left the dialer reading "Twilio Live" on a browser that could not
    // possibly hold a conversation — and connect()'s error was then discarded
    // by the Call error handler. Every dial rang a real homeowner into silence.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      micOkRef.current = true;
      patch({ micBlocked: false });
    } catch (err) {
      micOkRef.current = false;
      patch({ micBlocked: true });
      console.error("[dialer] microphone unavailable — manual dialing held back:", err);
    }
    if (deviceGenRef.current !== gen) return;

    try {
      const { Device, Call } = await import("@twilio/voice-sdk");
      const device = new Device(data.token, {
        logLevel: "error",
        // Prefer Opus (wideband, packet-loss resilient) then fall back to PCMU.
        // Without this the SDK may pick a codec that works for signalling but
        // produces no audio on certain browser/network paths.
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      });

      // Renew the token ~30s before it lapses so the device stays live all day.
      device.on("tokenWillExpire", async () => {
        if (deviceGenRef.current !== gen) return;
        // Renew in place — same identity. See fetchVoiceToken.
        const fresh = await fetchVoiceToken(true);
        if (deviceGenRef.current !== gen) return;
        if (fresh?.token) {
          try {
            device.updateToken(fresh.token);
            adoptIdentity(fresh);
          } catch {
            /* updateToken can throw if the device is mid-teardown */
          }
        }
      });

      device.on("registered", () => {
        if (deviceGenRef.current !== gen) return;
        modeRef.current = "live";
        patch({ mode: "live" });
      });

      device.on("unregistered", () => {
        // A network blip or token lapse dropped the registration. Don't disturb
        // an active call (its media is a separate connection). Otherwise reflect
        // the drop HONESTLY — a device left reading "Twilio Live" while actually
        // dead is exactly why reps saw "it doesn't say I'm live" / "offline" and
        // had to reload — then try to bring it back so dialing recovers on its own.
        if (deviceGenRef.current !== gen || callRef.current) return;
        modeRef.current = "connecting";
        patch({ mode: "connecting" });
        device.register().catch(() => {
          if (deviceGenRef.current !== gen || callRef.current) return;
          modeRef.current = "offline";
          patch({ mode: "offline" });
        });
      });

      device.on("error", (err: { code?: number }) => {
        if (deviceGenRef.current !== gen) return;
        // Access token expired/invalid → rebuild from a fresh token. But a rebuild
        // DESTROYS the device, and destroying it mid-call hangs up the rep on a
        // live homeowner — the exact "the phone just cuts off while I'm talking"
        // failure. If a call is up, defer: rebuild the moment it ends (endCall/
        // resetToIdle consume this flag), never during. The live call's media is a
        // separate PeerConnection that a lapsed *registration* token doesn't sever.
        if (err?.code === 20104 || err?.code === 31205) {
          if (callRef.current) {
            pendingRebuildRef.current = true;
            return;
          }
          void setupDeviceRef.current?.();
          return;
        }
        // Other fatal errors with no live call → mark offline so the UI offers
        // the Reconnect button instead of looking falsely "live".
        if (!callRef.current) {
          modeRef.current = "offline";
          patch({ mode: "offline" });
        }
      });

      await device.register();
      if (deviceGenRef.current !== gen) {
        device.destroy();
        return;
      }
      deviceRef.current = device;
      canDialOutRef.current = data.canDialOut !== false;
      modeRef.current = "live";
      patch({ mode: "live" });
    } catch {
      if (deviceGenRef.current !== gen) return;
      modeRef.current = "offline";
      patch({ mode: "offline" });
    }
  }, [adoptIdentity, fetchVoiceToken, patch]);

  // Stable indirection so lifecycle handlers can re-invoke the latest setup.
  const setupDeviceRef = useRef(setupDevice);
  useEffect(() => {
    setupDeviceRef.current = setupDevice;
  }, [setupDevice]);

  // Manual recovery — surfaced as a "Reconnect" button when the device is offline.
  const reconnect = useCallback(() => {
    void setupDevice();
  }, [setupDevice]);

  // Verify the device is actually registered and recover if not. Called on the
  // three moments a silently-dropped websocket would otherwise strand the dialer
  // "offline" until a manual reload: the rep returning to a backgrounded tab, the
  // network coming back, and a periodic health check. Never disturbs a live call.
  const ensureRegistered = useCallback(async () => {
    // Never while a call is up — and never while a dial is IN FLIGHT either.
    // `callRef.current` isn't set until device.connect() resolves, so this check
    // used to leave a window, a second or so wide, in which the health check
    // could tear the Device down between "the homeowner's phone is ringing" and
    // "the rep joins the conference" — the rep's leg dying with the call already
    // on the wire.
    if (!enabled || callRef.current || dialInFlightRef.current) return;
    const device = deviceRef.current;
    if (!device || String(device.state) !== "registered") {
      await setupDeviceRef.current?.();
      return;
    }
    // Registered, but a token can lapse while the tab is frozen (a throttled timer
    // never fires tokenWillExpire) — refresh so the next dial isn't rejected on a
    // stale token. Reuse the CURRENT identity: a refresh must not change who this
    // Device is (see fetchVoiceToken).
    try {
      const fresh = await fetchVoiceToken(true);
      // Re-check: a dial may have started while that request was in flight, and
      // updating the token is not worth risking the leg it's about to place.
      if (callRef.current || dialInFlightRef.current) return;
      if (fresh?.token) {
        device.updateToken(fresh.token);
        adoptIdentity(fresh);
      }
    } catch {
      /* the tokenWillExpire event + the re-register branch above are backstops */
    }
  }, [adoptIdentity, enabled, fetchVoiceToken]);

  useEffect(() => {
    // Only build the Twilio device once the dialer is actually in use. Flips
    // true on first activation and stays true, so the device (and any live
    // call) persists across navigation instead of tearing down per page.
    if (!enabled) return;
    void setupDevice();
    return () => {
      // Invalidate in-flight callbacks and tear the device down on unmount.
      deviceGenRef.current += 1;
      try {
        deviceRef.current?.destroy();
      } catch {
        /* noop */
      }
      deviceRef.current = null;
    };
  }, [setupDevice, enabled]);

  // ── Recover the device on resume (backgrounding fix) ──────────────────────
  // Mobile browsers freeze a backgrounded tab and tear down its websocket, so a
  // rep who switched apps and came back found the dialer "offline" and had to
  // fully exit + reload. Re-check registration on every resume signal instead.
  // Debounced because one "return to tab" fires a burst (visibilitychange +
  // focus + pageshow) that should collapse into a single recovery attempt.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const kick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void ensureRegistered(), 400);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") kick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", kick);
    window.addEventListener("focus", kick);
    window.addEventListener("online", kick);
    return () => {
      if (debounce) clearTimeout(debounce);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", kick);
      window.removeEventListener("focus", kick);
      window.removeEventListener("online", kick);
    };
  }, [enabled, ensureRegistered]);

  // Periodic health check — catches a device that died while the tab STAYED open
  // (a silent drop that emitted no unregistered/error event); the resume signals
  // above would never see that. Cheap: only re-registers when actually needed.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => void ensureRegistered(), 25_000);
    return () => clearInterval(id);
  }, [enabled, ensureRegistered]);

  // Hold a Screen Wake Lock while a session is active, so a rep's phone doesn't
  // dim → suspend the tab → drop the call. Best-effort (unsupported browsers skip
  // it); re-acquired on visibility since the lock auto-releases when hidden.
  const sessionActive = state.status !== "idle";
  useEffect(() => {
    if (!sessionActive) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let released = false;
    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible" || wakeLockRef.current) return;
        const lock = await navigator.wakeLock.request("screen");
        if (released) {
          void lock.release().catch(() => {});
          return;
        }
        wakeLockRef.current = lock;
        lock.addEventListener("release", () => {
          if (wakeLockRef.current === lock) wakeLockRef.current = null;
        });
      } catch {
        /* denied / unsupported — not critical */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (lock) void lock.release().catch(() => {});
    };
  }, [sessionActive]);

  // Report status + current lead on every change, and keep a steady heartbeat
  // (independent of state changes) so a rep sitting genuinely idle doesn't age
  // past the roster's staleness window and vanish from a manager's view.
  useEffect(() => {
    if (!enabled) return;
    const lead = state.connectedLead
      ? {
          name: `${state.connectedLead.firstName} ${state.connectedLead.lastName}`.trim(),
          city: [state.connectedLead.city, state.connectedLead.state].filter(Boolean).join(", "),
          phone: state.connectedLead.phone,
        }
      : state.aiCalls[0]
        ? { name: state.aiCalls[0].leadName }
        : null;
    const aiActiveCount = state.status === "ai" ? state.aiCalls.length : 0;
    presenceSnapshotRef.current = { status: state.status, lead, aiActiveCount };
    postPresence(state.status, lead, aiActiveCount);
    // aiCalls.length (not the array itself) so a per-lead mutation mid-batch
    // doesn't fire a POST per lead — only when the concurrent count changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, state.status, state.connectedLead, state.aiCalls.length, postPresence]);

  useEffect(() => {
    if (!enabled) return;
    // 60s, up from 20s: channel presence on the org floor (E1/E3) is the
    // primary liveness signal now — this HTTP heartbeat is the fallback that
    // keeps the roster working in demo mode and across channel outages.
    presenceTimerRef.current = setInterval(() => {
      const snap = presenceSnapshotRef.current;
      postPresence(snap.status, snap.lead, snap.aiActiveCount);
    }, 60_000);
    return () => {
      if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
      presenceTimerRef.current = null;
    };
  }, [enabled, postPresence]);

  // ── Seed the daily dial counter from storage (per rep, per local day) ──────
  useEffect(() => {
    userIdRef.current = userId;
    const n = readDialsToday(userId);
    dialsTodayRef.current = n;
    const ai = readAiDialsToday(userId);
    aiDialsTodayRef.current = ai;
    setState((s) => ({ ...s, dialsToday: n, aiDialsToday: ai }));
    sweepOldDialKeys();
  }, [userId]);

  // ── Seed excluded caller IDs from storage (per rep, no expiry) ─────────────
  useEffect(() => {
    const excluded = readExcludedCallerIds(userId);
    excludedCallerIdsRef.current = excluded;
    setState((s) => ({ ...s, excludedCallerIds: excluded }));
  }, [userId]);

  // ── Seed local presence: the rep's own choice, else the org default ────────
  useEffect(() => {
    const on = readLocalPresence(userId, localPresenceDefault);
    localPresenceRef.current = on;
    setState((s) => ({ ...s, localPresence: on }));
  }, [userId, localPresenceDefault]);

  useEffect(
    () => () => {
      stopTick();
      stopPoll();
      stopAITimer();
      // Clear the double-tap timer directly (purgeRedials is declared later, and
      // on unmount the whole hook goes anyway — only the live timer needs killing).
      if (redialTimerRef.current) clearTimeout(redialTimerRef.current);
      clearHumanPresence();
      clearMyPresence();
    },
    [stopTick, stopPoll, stopAITimer, clearHumanPresence, clearMyPresence],
  );

  /**
   * Keep the queue cursor pointing INSIDE the current queue, wrapping back to
   * the top when it has fallen off the end. Returns the usable cursor.
   *
   * The cursor routinely outlives the list it was set against: an AI pass parks
   * it at exactly `queue.length` when it runs out of leads, `loadLeads()` can
   * hand back a shorter list than last time, and the group / campaign / "my
   * leads" filters narrow the queue underneath it. Nothing used to bring it back
   * in range, and `nextLeads()` slices from it without wrapping — so a stale
   * cursor made "Start session" find NOTHING to dial and bail out instantly.
   * That is the "I press start, it never dials, and it drops straight back to
   * idle" report: the lead panel still showed a lead (it indexes with a modulo
   * the engine itself never applied), so the queue looked perfectly fine.
   */
  const normalizeCursor = useCallback(() => {
    if (queueIndexRef.current >= queue.length || queueIndexRef.current < 0) {
      queueIndexRef.current = 0;
      setState((s) => (s.queueIndex === 0 ? s : { ...s, queueIndex: 0 }));
    }
    return queueIndexRef.current;
  }, [queue.length]);

  // Re-anchor whenever the loaded queue changes size, so the cursor can never be
  // left stranded past the end of a freshly-loaded or freshly-filtered list.
  useEffect(() => {
    normalizeCursor();
  }, [normalizeCursor]);

  /**
   * The next `count` leads. Does NOT wrap WITHIN a batch.
   *
   * This used to index `queue[(i + n) % queue.length]`, so a 2-lead queue dialed
   * at 3X produced [lead0, lead1, lead0] — the same homeowner rung twice, on two
   * lines, simultaneously, from a single batch. Running short at the end of the
   * queue means fewer lines this round, not calling someone twice.
   * (Lapping the whole list is handled deliberately elsewhere, via queueLap.)
   */
  const nextLeads = useCallback(
    (count: number) => {
      if (!queue.length) return [];
      const start = normalizeCursor();
      return queue.slice(start, start + count);
    },
    [normalizeCursor, queue],
  );

  const connectLine = useCallback(
    (lead: Lead) => {
      stopPoll();
      // Bridged. From here the outbound leg IS the conversation, so drop it from
      // the release list — every later teardown must leave it alone.
      activeLegsRef.current = { sids: [], dialed: [] };
      dialInFlightRef.current = false;
      bridgedRef.current = true;
      postHuman("connect");
      setState((s) => ({
        ...s,
        status: "live",
        connectedLead: lead,
        durationSec: 0,
        connectsThisSession: s.connectsThisSession + 1,
        lines: s.lines.map((l) =>
          l.lead.id === lead.id
            ? { ...l, status: "connected" }
            : { ...l, status: "canceled" },
        ),
      }));
      startTick();
    },
    [postHuman, startTick, stopPoll],
  );

  // A parallel (2x/3x) dial rings several homeowners but only the WINNER gets a
  // rep disposition. Without this the losing legs get NO call_record at all, so
  // dial counts and connect-rate are wrong by up to Nx, there is no per-attempt
  // trail (a TCPA exposure), and the auto-dialer silently re-rings them. File a
  // best-effort no_answer record for every non-winning line. `keepLeadId` is the
  // one the rep will disposition themselves (the winner, or the focus lead on a
  // no-answer batch), so it's skipped here.
  const recordNonWinners = useCallback((dialedLeads: Lead[], keepLeadId: string) => {
    if (dialedLeads.length < 2) return;
    for (const l of dialedLeads) {
      if (!l.id || l.id === keepLeadId) continue;
      // The server refused this leg (enforced hours / placement failure) — the
      // phone never rang, and a no_answer record for it would be a fabricated
      // TCPA/audit entry AND a stealth attempt-count bump.
      if (undialedRef.current.has(l.id)) continue;
      // Through the durable outbox (not bare fetch), each with its own per-lead
      // idempotency key from dial time — a retried batch files each loser once.
      // attemptRoom resolves the canonical attempt WITHOUT storing the round's
      // shared room on the record (call_records.room is unique per round and
      // belongs to the rep-dispositioned winner).
      void persistDisposition({
        leadId: l.id,
        leadName: `${l.firstName} ${l.lastName}`.trim(),
        phone: l.phone,
        durationSec: 0,
        outcome: "no_answer",
        clientAttemptId: attemptIdsRef.current[l.id],
        attemptRoom: humanIdRef.current ? `hc-${humanIdRef.current}` : undefined,
      });
    }
  }, []);

  // A token-expiry error that arrived mid-call deferred its device rebuild so it
  // wouldn't drop the call. The call is over now — honor it, so the device
  // recovers instead of quietly running on a stale/expired token.
  const consumePendingRebuild = useCallback(() => {
    if (!pendingRebuildRef.current) return;
    pendingRebuildRef.current = false;
    void setupDeviceRef.current?.();
  }, []);

  /**
   * Tear the call down and go back to idle.
   *
   * `reason` is not optional politeness — this is the path the Twilio Call's
   * error/cancel/reject events land on, and it used to reset the UI in total
   * silence. The rep pressed Start, the screen flashed and came back, and
   * nothing anywhere said why. Callers that know why MUST say so.
   *
   * It also releases the outbound leg. Reaching idle means the rep is not on
   * this call and never will be, so anything still ringing is a homeowner
   * picking up to silence.
   */
  const resetToIdle = useCallback(
    (reason?: string) => {
      stopTick();
      stopPoll();
      clearHumanPresence();
      releaseActiveLegs();
      // Nothing was filed for this round — free the reservation holds so the
      // leads are immediately claimable again (by us or anyone else).
      releaseClaimedLeads("reset");
      dialInFlightRef.current = false;
      bridgedRef.current = false;
      intentionalEndRef.current = false;
      pendingMuteRef.current = null;
      // Detach FIRST, then hang up: the disconnect below can re-enter these
      // handlers, and a null ref is what makes them recognise the event as
      // belonging to a call the dialer has already finished with.
      const call = callRef.current;
      callRef.current = null;
      try {
        // Reaching idle means the rep is not on this call and never will be, so
        // a leg still open here is a rep silently connected to nothing.
        if (call && call.status() !== "closed") call.disconnect();
      } catch {
        /* already torn down */
      }
      patch({
        status: "idle",
        lines: [],
        connectedLead: null,
        durationSec: 0,
        reconnecting: false,
        muteCapability: "unsupported",
        ...(reason ? { error: reason } : {}),
      });
      consumePendingRebuild();
    },
    [
      clearHumanPresence,
      consumePendingRebuild,
      patch,
      releaseActiveLegs,
      releaseClaimedLeads,
      stopTick,
      stopPoll,
    ],
  );

  const endCall = useCallback(() => {
    stopTick();
    stopPoll();
    clearHumanPresence();
    // If this ends before anyone was bridged, the homeowner leg is still out
    // there ringing. connectLine() empties the ref, so a real conversation
    // ending here releases nothing.
    releaseActiveLegs();
    dialInFlightRef.current = false;
    const sid = callRef.current?.parameters?.CallSid ?? null;
    // Detach BEFORE hanging up. `disconnect()` can fire the `disconnect` event
    // re-entrantly, and with the ref already cleared that event is correctly
    // read as coming from a call the dialer has finished with — instead of
    // re-entering this function.
    const call = callRef.current;
    callRef.current = null;
    try {
      call?.disconnect();
    } catch {
      /* noop */
    }
    bridgedRef.current = false;
    intentionalEndRef.current = false;
    pendingMuteRef.current = null;
    // The claims for this round stay HELD through wrap-up (the heartbeat keeps
    // renewing them) — the disposition or skip decides how they're released.
    patch({ status: "wrapup", callSid: sid, reconnecting: false, muteCapability: "unsupported" });
    consumePendingRebuild();
  }, [clearHumanPresence, consumePendingRebuild, patch, releaseActiveLegs, stopTick, stopPoll]);

  const attachCallHandlers = useCallback(
    (call: Call, onAccept?: () => void) => {
      callRef.current = call;

      // PRE-ANSWER MUTE: the rep leg exists from this moment (connect() has
      // resolved; the customer may still be ringing), so mute is live — and a
      // toggle pressed during the sub-second "arming" window before this ran
      // was queued as an intent that must be honored now, not dropped.
      if (pendingMuteRef.current !== null) {
        try {
          call.mute(pendingMuteRef.current);
        } catch {
          /* the call teardown races this — muted state resets with the call */
        }
        pendingMuteRef.current = null;
      }
      patch({ muteCapability: "ready" });

      /**
       * THE fix for "it rings, then boots me back to Start session."
       *
       * A Twilio Call keeps emitting after it is over — a hang-up is routinely
       * followed by trailing media/ICE `error`s, and `cancel` lands on an
       * outgoing leg Twilio gave up on. These handlers are attached per Call and
       * never detached, so before this every late event from a DEAD call ran
       * against whatever the dialer was doing at that moment. Once `endCall()`
       * had nulled `callRef.current`, the old guard (`if (callRef.current && …)`)
       * fell straight through to a bare `resetToIdle()` — wiping the screen back
       * to Start, saying nothing, seconds after the rep pressed the button.
       *
       * `decideCallEvent` (src/lib/dialer/call-events.ts) holds the rules and is
       * asserted by `npm run verify:call-events`; this closure just supplies the
       * live context and carries the verdict out.
       */
      const dispatch = (event: CallEvent, err?: unknown) => {
        let callStatus = "closed";
        try {
          callStatus = String(call.status());
        } catch {
          /* status() unavailable on a torn-down call — treat as closed */
        }
        const action = decideCallEvent(event, {
          isCurrent: callRef.current === call,
          bridged: bridgedRef.current,
          intentional: intentionalEndRef.current,
          callStatus,
        });
        if (action.type === "ignore") return;
        if (action.type === "wrapup") {
          endCall();
          return;
        }
        // Never silent: `reason: null` means "the Twilio error IS the reason".
        resetToIdle(action.reason ?? describeCallError(err));
      };

      if (onAccept) call.on("accept", onAccept);
      call.on("disconnect", () => dispatch("disconnect"));
      call.on("cancel", () => dispatch("cancel"));
      call.on("reject", () => dispatch("reject"));
      call.on("error", (err: unknown) => {
        // Logged unconditionally, even when the verdict is "ignore" — the error
        // code is the one piece of evidence that explains a failed dial, and the
        // handler used to take no argument at all, dropping every one of them.
        console.error("[dialer] call error", err);
        dispatch("error", err);
      });

      // Transient media/signaling blip: the SDK is auto-recovering the SAME call
      // leg — it is NOT over. Ride it out (show "Reconnecting…") rather than let a
      // 2-second wobble read as a dropped call. If recovery ultimately fails the
      // SDK fires `disconnect`, which wraps up normally.
      call.on("reconnecting", () => {
        if (callRef.current === call) patch({ reconnecting: true });
      });
      call.on("reconnected", () => {
        if (callRef.current === call) patch({ reconnecting: false });
      });
    },
    [endCall, patch, resetToIdle],
  );

  // ── Lead navigation (browse the queue without calling) ────────────────────
  const nextLead = useCallback(() => {
    if (!queue.length) return;
    queueIndexRef.current = (queueIndexRef.current + 1) % queue.length;
    patch({ queueIndex: queueIndexRef.current });
  }, [patch, queue.length]);

  const prevLead = useCallback(() => {
    if (!queue.length) return;
    queueIndexRef.current =
      (queueIndexRef.current - 1 + queue.length) % queue.length;
    patch({ queueIndex: queueIndexRef.current });
  }, [patch, queue.length]);

  const selectLead = useCallback(
    (leadId: string) => {
      const idx = queue.findIndex((l) => l.id === leadId);
      if (idx >= 0) {
        queueIndexRef.current = idx;
        patch({ queueIndex: idx });
      }
    },
    [patch, queue],
  );

  // ── AI calling (default) ──────────────────────────────────────────────────

  /** Abandon every pending double-tap re-ring (out of credits, session ended, …). */
  const purgeRedials = useCallback(() => {
    if (redialTimerRef.current) {
      clearTimeout(redialTimerRef.current);
      redialTimerRef.current = null;
    }
    for (const leadId of redialsRef.current.keys()) {
      inflightRef.current.delete(`redial:${leadId}`);
      slotAgeRef.current.delete(`redial:${leadId}`);
    }
    redialsRef.current.clear();
  }, []);

  /**
   * Place ONE AI call for a lead — the shared dial used by BOTH the new-lead pump
   * and the double-tap re-ring, so an attempt and its re-ring behave identically
   * (same reservation, credit-halt handling, live-call bookkeeping). Reserves the
   * line up front, counts the dial + the per-lead attempt, then swaps the
   * reservation for the real conversation id (recording which lead it was for, so
   * a no-answer can find its way back here for the tap).
   */
  const launchAICall = useCallback(
    async (l: Lead, gen: number) => {
      const slotKey = `lead:${l.id}`;
      inflightRef.current.add(slotKey);
      slotAgeRef.current.set(slotKey, Date.now());
      const attempt = (attemptsRef.current.get(l.id) ?? 0) + 1;
      attemptsRef.current.set(l.id, attempt);
      aiLeadByIdRef.current.set(l.id, l);
      recordDials(1, "ai");
      const leadName = `${l.firstName} ${l.lastName}`.trim() || formatPhone(l.phone);
      setState((s) =>
        sessionGenRef.current !== gen
          ? s
          : {
              ...s,
              status: "ai",
              error: null,
              callsThisSession: s.callsThisSession + 1,
              aiCallsThisSession: s.aiCallsThisSession + 1,
              dialsToday: dialsTodayRef.current,
              aiDialsToday: aiDialsTodayRef.current,
              aiCampaign: autoDialRef.current ? "running" : s.aiCampaign,
              aiCalls: [
                {
                  conversationId: null,
                  leadId: l.id,
                  leadName,
                  phone: l.phone,
                  attempt,
                  startedAt: Date.now(),
                },
                ...s.aiCalls,
              ].slice(0, 40),
            },
      );
      try {
        const res = await fetch("/api/elevenlabs/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            leadId: l.id,
            agent: activeAgentRef.current,
            localPresence: localPresenceRef.current,
            excludedCallerIds: excludedCallerIdsRef.current.length
              ? excludedCallerIdsRef.current
              : undefined,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          conversationId?: string;
          error?: string;
          halted?: boolean;
          callerId?: string | null;
        };

        // The server REFUSED to dial (out of credits / breaker open). Stop the
        // whole campaign — including any owed re-rings — every further call would
        // fail identically and spend a real homeowner for nothing.
        if (json.halted) {
          inflightRef.current.delete(slotKey);
          slotAgeRef.current.delete(slotKey);
          stopAITimer();
          autoDialRef.current = false;
          purgeRedials();
          setState((s) =>
            sessionGenRef.current !== gen
              ? s
              : {
                  ...s,
                  autoDial: false,
                  aiCampaign: "idle",
                  error: json.error ?? "AI dialing halted.",
                },
          );
          return;
        }

        inflightRef.current.delete(slotKey);
        slotAgeRef.current.delete(slotKey);
        if (res.ok && json.conversationId) {
          inflightRef.current.add(json.conversationId);
          slotAgeRef.current.set(json.conversationId, Date.now());
          convLeadRef.current.set(json.conversationId, l);
        }
        setState((s) => {
          if (sessionGenRef.current !== gen) return s;
          return {
            ...s,
            aiCalls: s.aiCalls.map((c) =>
              c.leadId === l.id && c.conversationId === null && !c.error
                ? {
                    ...c,
                    conversationId: json.conversationId ?? null,
                    error: res.ok ? undefined : json.error ?? "Call failed",
                    callerId: json.callerId ?? null,
                  }
                : c,
            ),
          };
        });
      } catch {
        inflightRef.current.delete(slotKey);
        slotAgeRef.current.delete(slotKey);
        setState((s) => {
          if (sessionGenRef.current !== gen) return s;
          return {
            ...s,
            aiCalls: s.aiCalls.map((c) =>
              c.leadId === l.id && c.conversationId === null && !c.error
                ? { ...c, error: "Network error" }
                : c,
            ),
          };
        });
      }
    },
    [purgeRedials, recordDials, stopAITimer],
  );

  /**
   * Fire every DUE double-tap re-ring, then re-arm for the next one at its exact
   * due time. Runs on its own timer (not the new-lead pump) so a re-ring lands
   * ~gap seconds after the miss even at one line at a time, and even when
   * auto-dial is off. Each re-ring gave up its reserved `redial:` slot for a live
   * line here, so it never exceeds the concurrency ceiling.
   */
  const tickRedials = useCallback(() => {
    if (redialTimerRef.current) {
      clearTimeout(redialTimerRef.current);
      redialTimerRef.current = null;
    }
    if (!redialsRef.current.size) return;
    const now = Date.now();
    const gen = sessionGenRef.current;
    let soonest = Infinity;
    for (const [leadId, r] of [...redialsRef.current.entries()]) {
      if (r.dueAt <= now) {
        redialsRef.current.delete(leadId);
        inflightRef.current.delete(`redial:${leadId}`);
        slotAgeRef.current.delete(`redial:${leadId}`);
        void launchAICall(r.lead, gen);
      } else {
        soonest = Math.min(soonest, r.dueAt);
      }
    }
    if (redialsRef.current.size && soonest < Infinity) {
      redialTimerRef.current = setTimeout(
        () => tickRedials(),
        Math.max(250, soonest - Date.now()),
      );
    }
  }, [launchAICall]);
  const tickRedialsRef = useRef(tickRedials);
  useEffect(() => {
    tickRedialsRef.current = tickRedials;
  }, [tickRedials]);

  /**
   * Retire slots whose calls have ended, so the pump can top the floor back up.
   * Force-releases any slot older than AI_SLOT_MAX_MS — otherwise a conversation
   * that never reaches a terminal state holds its line forever and the campaign
   * quietly stalls at N-1, which presents as "the dialer just stopped".
   *
   * Also the trigger point for the double-tap: a call that ended as a genuine
   * NO-ANSWER (and only that — never a real conversation, never a system failure)
   * gets one re-ring queued after the gap, holding the line it just freed.
   */
  const reapInflight = useCallback(async () => {
    const now = Date.now();
    for (const [id, at] of slotAgeRef.current) {
      if (now - at > AI_SLOT_MAX_MS) {
        inflightRef.current.delete(id);
        slotAgeRef.current.delete(id);
        if (id.startsWith("redial:")) redialsRef.current.delete(id.slice(7));
      }
    }
    const ids = [...inflightRef.current].filter(
      (id) => !id.startsWith("lead:") && !id.startsWith("redial:"),
    );
    if (!ids.length) return;
    try {
      const res = await fetch("/api/elevenlabs/inflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        active?: string[];
        ended?: { id: string; outcome: string | null }[];
      };
      const live = new Set(json.active ?? []);
      const endedOutcome = new Map(
        (json.ended ?? []).map((e) => [e.id, e.outcome] as const),
      );
      let scheduled = false;
      for (const id of ids) {
        if (live.has(id)) continue;
        inflightRef.current.delete(id);
        slotAgeRef.current.delete(id);
        const lead = convLeadRef.current.get(id);
        convLeadRef.current.delete(id);
        if (
          doubleDialRef.current &&
          endedOutcome.get(id) === "no_answer" &&
          lead &&
          (attemptsRef.current.get(lead.id) ?? 0) < 2 &&
          !redialsRef.current.has(lead.id)
        ) {
          // Hold the freed line for the re-ring instead of letting the pump race
          // ahead to a new lead — that's what makes the two calls land back to back.
          redialsRef.current.set(lead.id, {
            dueAt: now + doubleDialGapMsRef.current,
            lead,
          });
          inflightRef.current.add(`redial:${lead.id}`);
          slotAgeRef.current.set(`redial:${lead.id}`, now);
          scheduled = true;
        }
      }
      if (scheduled) tickRedialsRef.current();
    } catch {
      /* the age guard above is the backstop */
    }
  }, []);

  /**
   * The new-lead pump. Tops the floor up to `parallelCount` LIVE calls — no more.
   *
   * It asks how many lines are free and launches exactly that many (never N fresh
   * calls every tick regardless of whether the last ones ended — that throughput-
   * dial-wearing-a-concurrency-label is how a 10-line plan got flooded to ~70
   * simultaneous). Double-tap re-rings run on their OWN timer (tickRedials); their
   * held `redial:` reservations count toward the ceiling here, so the pump keeps a
   * line free for a re-ring instead of launching a new lead on top of it.
   */
  const launchAIBatch = useCallback(async () => {
    await reapInflight();
    const gen = sessionGenRef.current;
    // Only re-arm the pump while auto-dial is still on AND this is still the
    // current session. stopAICampaign/endAISession clear autoDialRef (and end
    // bumps the generation), so a batch already in flight when Stop was pressed
    // re-checks this after its awaits and can no longer schedule the next tick —
    // which is what used to keep dialing homeowners after the operator stopped.
    const keepPumping = () => autoDialRef.current && sessionGenRef.current === gen;
    const slots = Math.max(0, parallelRef.current - inflightRef.current.size);

    // Every line is busy (or held for a pending re-ring) — come back when one frees.
    if (slots === 0) {
      if (keepPumping()) {
        aiTimerRef.current = setTimeout(() => void launchAIBatch(), AI_PUMP_MS);
      }
      return;
    }

    const start = aiCursorRef.current;
    const leads = queue.slice(start, start + slots);
    if (!leads.length) {
      // Out of NEW leads — but don't declare "done" while calls are live OR a
      // double-tap is still owed.
      if (inflightRef.current.size > 0 || redialsRef.current.size > 0) {
        if (keepPumping()) {
          aiTimerRef.current = setTimeout(() => void launchAIBatch(), AI_PUMP_MS);
        }
        return;
      }
      stopAITimer();
      patch({ status: "ai", aiCampaign: "done" });
      return;
    }
    aiCursorRef.current = start + leads.length;
    queueIndexRef.current = Math.min(aiCursorRef.current, queue.length);
    patch({
      queueIndex: queueIndexRef.current,
      aiCampaign: autoDialRef.current ? "running" : "idle",
    });

    await Promise.all(leads.map((l) => launchAICall(l, gen)));

    // Keep pumping while auto-dial is on. The next tick re-checks free lines, so
    // this can't run away: if all N are still busy it launches nothing.
    if (keepPumping() && aiCursorRef.current < queue.length) {
      aiTimerRef.current = setTimeout(() => void launchAIBatch(), AI_PUMP_MS);
    } else if (aiCursorRef.current >= queue.length) {
      // End of this pass. Wait for calls on the wire AND any owed re-rings before
      // declaring the lap over — otherwise the parent refetches mid-flight and the
      // next lap stacks on top of live calls.
      if (
        (inflightRef.current.size > 0 || redialsRef.current.size > 0) &&
        keepPumping()
      ) {
        aiTimerRef.current = setTimeout(() => void launchAIBatch(), AI_PUMP_MS);
        return;
      }
      queueLapRef.current += 1;
      patch({ aiCampaign: "done", queueLap: queueLapRef.current });
    }
  }, [launchAICall, patch, queue, reapInflight, stopAITimer]);

  const startAISession = useCallback(() => {
    stopAITimer();
    sessionGenRef.current += 1;
    // Same stale-cursor trap as the manual path: a finished pass parks the
    // cursor at queue.length, and starting from there gives the pump nothing to
    // launch — the session would open and report "Campaign complete" on the spot.
    aiCursorRef.current = normalizeCursor();
    // A fresh session starts with every line free. Carrying stale slots over
    // would make the pump believe the floor was busy and launch nothing.
    inflightRef.current.clear();
    slotAgeRef.current.clear();
    purgeRedials();
    attemptsRef.current.clear();
    convLeadRef.current.clear();
    aiLeadByIdRef.current.clear();
    setState((s) => ({
      ...s,
      status: "ai",
      aiCalls: [],
      aiCampaign: autoDialRef.current ? "running" : "idle",
      error: null,
    }));
    void launchAIBatch();
  }, [launchAIBatch, normalizeCursor, purgeRedials, stopAITimer]);

  /** AI-dial an ad-hoc number with whatever the user knows about it. */
  const aiDialNumber = useCallback(
    async (phone: string, known: KnownInfo) => {
      const e164 = toE164(phone);
      if (e164.replace(/\D/g, "").length < 10) {
        patch({ error: "Enter a valid phone number." });
        return;
      }
      stopAITimer();
      const tempId = `manual-${Date.now().toString(36)}`;
      const name =
        `${known.firstName ?? ""} ${known.lastName ?? ""}`.trim() ||
        formatPhone(e164);
      recordDials(1, "ai");
      setState((s) => ({
        ...s,
        status: "ai",
        error: null,
        aiCampaign: "idle",
        callsThisSession: s.callsThisSession + 1,
        aiCallsThisSession: s.aiCallsThisSession + 1,
        dialsToday: dialsTodayRef.current,
        aiDialsToday: aiDialsTodayRef.current,
        aiCalls: [{ conversationId: null, leadId: tempId, leadName: name }],
      }));
      try {
        const res = await fetch("/api/elevenlabs/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            phone: e164,
            lead: known,
            agent: activeAgentRef.current,
            localPresence: localPresenceRef.current,
            excludedCallerIds: excludedCallerIdsRef.current.length
              ? excludedCallerIdsRef.current
              : undefined,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          conversationId?: string;
          error?: string;
          callerId?: string | null;
        };
        setState((s) => ({
          ...s,
          aiCalls: s.aiCalls.map((c) =>
            c.leadId === tempId
              ? {
                  ...c,
                  conversationId: json.conversationId ?? null,
                  error: res.ok ? undefined : json.error ?? "Call failed",
                  callerId: json.callerId ?? null,
                }
              : c,
          ),
        }));
      } catch {
        setState((s) => ({
          ...s,
          aiCalls: s.aiCalls.map((c) =>
            c.leadId === tempId ? { ...c, error: "Network error" } : c,
          ),
        }));
      }
    },
    [patch, recordDials, stopAITimer],
  );

  // ── Human (Twilio) call attempt ───────────────────────────────────────────
  // Every human call runs through a Twilio conference (single = parallel-of-one):
  // the homeowner(s) are dialed into room `hc-<humanId>` and the rep's browser
  // joins the same room. This is what lets a supervisor live-listen by joining
  // the conference muted — no media relay required.
  const startHumanCall = useCallback(
    async (override?: Lead[], opts?: { pinnedCallerId?: string }) => {
      // One dial at a time. Each press of Start places a REAL outbound call, and
      // when the rep's side then failed silently they pressed it again — nine
      // times in eight seconds in production, on a workspace configured for a
      // single line. Nine homeowners rang; nobody was there for any of them.
      if (dialInFlightRef.current) return;

      // Pin the Device now. The dial does real network work before it needs to
      // join the conference, and setupDevice() (health check, token refresh,
      // tab resume) can null deviceRef out underneath us in that window — which
      // used to blow up on `deviceRef.current.connect(...)` several awaits later.
      const device = deviceRef.current;
      if (modeRef.current !== "live" || !device) {
        patch({
          error: "Twilio isn't connected. Add your credentials to place calls.",
          status: "idle",
        });
        return;
      }

      // No microphone, no call. The Device registers happily without one, so
      // everything upstream of here looks healthy — but the rep cannot speak,
      // and dialing anyway just rings a homeowner into silence. Refuse BEFORE
      // placing the call rather than discovering it after the phone is ringing.
      if (!micOkRef.current) {
        patch({
          error:
            "Your microphone isn't available, so the call would ring with no one on the line. Allow microphone access for this site, then press Reconnect.",
          status: "idle",
          micBlocked: true,
        });
        return;
      }

      if (!canDialOutRef.current) {
        patch({
          error:
            "Outbound calling needs Twilio REST credentials (Account SID, Auth Token, and Caller ID).",
          status: "idle",
        });
        return;
      }

      // ── Who gets dialed ──────────────────────────────────────────────────
      // Reservations ON: claim the next N leads server-side — an exclusive,
      // TTL'd hold per lead, so two reps (or a rep and the AI cron) can never
      // pull the same lead at the same moment. The local queue stays what it
      // always was: the DISPLAY. Reservations OFF (and demo mode, and explicit
      // overrides like redial/callback): the legacy local-cursor path, intact.
      let leads: Lead[];
      // Fresh round: the cursor-advance flags belong to THIS round only — a
      // stale flag from a previous claimed round would make an override round
      // (redial, callback launch) skip its advanceQueue.
      claimAdvancedRef.current = false;
      lapWrappedRef.current = false;
      const reservations = optionsRef.current.reservations;
      if (!override && reservations?.enabled) {
        // In-flight guard goes up BEFORE the claim round-trip — mashing Start
        // during the network wait must not stack a second claim + dial.
        dialInFlightRef.current = true;
        const ctx = reservations.getContext();
        // ── QUEUE FIDELITY (the mis-dial fix) ──────────────────────────────
        // The claim used to carry no lead scoping, so the server handed back
        // the org pool's top-eligibility lead: someone NOT on the list the rep
        // loaded — and the SAME someone on every retry, because skip releases
        // the hold and the pool order is deterministic. Strict mode (default)
        // constrains the claim to the display queue's ids, in the rep's order
        // from their current position; the server holds the first eligible N
        // of exactly that list (p_preserve_order).
        const strict = ctx.strictOrder !== false;
        const WINDOW = 200; // the claim route's leadIds cap
        let candidates = strict
          ? orderedCandidateIds(queue, queueIndexRef.current, WINDOW)
          : [];
        const postClaim = async (body: Record<string, unknown>): Promise<Lead[]> => {
          try {
            const res = await fetch("/api/dialer/claim", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const json = (await res.json().catch(() => ({}))) as { leads?: Lead[] };
            return res.ok && Array.isArray(json.leads) ? json.leads : [];
          } catch {
            return [];
          }
        };
        let claimed: Lead[] = [];
        let refilled = false;
        if (!strict || candidates.length) {
          claimed = await postClaim({
            count: parallelRef.current,
            statuses: ctx.statuses,
            campaignId: ctx.campaignId,
            packId: ctx.packId,
            ...(strict ? { leadIds: candidates, preserveOrder: true } : {}),
          });
        }
        // A fully-ineligible head window (held by teammates, cooling down) on
        // a session larger than the window must not read as "list finished"
        // while eligible leads sit right behind it — probe the NEXT window
        // once before declaring the list dry.
        if (!claimed.length && strict && queue.length > WINDOW) {
          const nextWindow = orderedCandidateIds(
            queue,
            queueIndexRef.current + WINDOW,
            WINDOW,
          ).filter((id) => !candidates.includes(id));
          if (nextWindow.length) {
            claimed = await postClaim({
              count: parallelRef.current,
              statuses: ctx.statuses,
              campaignId: ctx.campaignId,
              packId: ctx.packId,
              leadIds: nextWindow,
              preserveOrder: true,
            });
            if (claimed.length) candidates = nextWindow;
          }
        }
        // Strict list dry + refill opted-in: pull from the eligible pool —
        // loudly, never as a silent substitution.
        if (!claimed.length && strict && ctx.refill) {
          claimed = await postClaim({
            count: parallelRef.current,
            statuses: ctx.statuses,
            campaignId: ctx.campaignId,
            packId: ctx.packId,
          });
          refilled = claimed.length > 0;
        }
        if (!claimed.length) {
          dialInFlightRef.current = false;
          patch({
            error: strict
              ? strictQueueExhaustedMessage(queue.length, Boolean(ctx.refill))
              : claimEmptyMessage(queue.length),
            status: "idle",
            lines: [],
          });
          return;
        }
        // The round runs in the REP's order, whatever order the rows returned.
        claimed = reorderClaimed(claimed, candidates);
        for (const l of claimed) claimedIdsRef.current.add(l.id);
        // STRICT rounds only: walk the cursor past what this round consumed,
        // flag it so advanceQueue doesn't double-advance, and record whether
        // the walk wrapped (the lap boundary). Pool/refill claims leave the
        // cursor alone — their leads aren't positions in the rep's list.
        if (strict && !refilled) {
          const prevCursor = queueIndexRef.current;
          const nextCursor = advanceCursorPastClaims(
            queue,
            prevCursor,
            claimed.map((l) => l.id),
          );
          if (nextCursor !== prevCursor) {
            queueIndexRef.current = nextCursor;
            patch({ queueIndex: nextCursor });
          }
          claimAdvancedRef.current = true;
          lapWrappedRef.current = nextCursor <= prevCursor;
        } else {
          claimAdvancedRef.current = false;
          lapWrappedRef.current = false;
        }
        // Claimed leads may not be in the local queue array (refill mode) —
        // let the provider merge them into display state so the UI shows the
        // actual round, and announce a refill when one happened.
        reservations.onClaimed?.(claimed);
        if (refilled) reservations.onQueueRefilled?.(claimed);
        leads = claimed;
      } else {
        leads = override ?? nextLeads(parallelRef.current);
      }

      // ── Phone-duplicate guard ────────────────────────────────────────────
      // The claim guarantees lead-level exclusivity, but two DIFFERENT lead
      // rows can carry one phone number (re-imports, shared landlines) — and a
      // round that dials both rings the same phone on two lanes at once. Keep
      // the first occurrence, drop the rest BEFORE anything is on the wire,
      // and tell the provider (it toasts + counts `lane.dup_dropped`).
      const dedupe = dedupeLeadsByPhone(leads);
      if (dedupe.dropped.length) {
        const droppedClaimIds = dedupe.dropped
          .map((l) => l.id)
          .filter((id) => claimedIdsRef.current.has(id));
        for (const id of droppedClaimIds) claimedIdsRef.current.delete(id);
        // Free the dropped duplicates' holds NOW — nothing will ever be filed
        // for them this round, and letting the TTL run out just locks a lead
        // no phone is going to ring.
        if (droppedClaimIds.length && optionsRef.current.reservations?.enabled) {
          fetch("/api/dialer/release", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ leadIds: droppedClaimIds }),
            keepalive: true,
          }).catch(() => {});
        }
        optionsRef.current.onDuplicateLanesDropped?.(dedupe.dropped);
        leads = dedupe.kept;
      }
      // Never fail silently here. This used to `return` with no state change and
      // no message, so pressing "Start session" looked like the dialer had
      // started and instantly quit — with nothing on screen explaining why.
      if (!leads.length) {
        dialInFlightRef.current = false;
        patch({
          error: queue.length
            ? "Couldn't line up the next lead to dial. Reload your leads and try again."
            : "No leads are loaded — press “Load leads” to build a session first.",
          status: "idle",
          lines: [],
        });
        return;
      }

      // Past every guard — this attempt is really going to put phones on the wire.
      dialInFlightRef.current = true;
      // Fresh attempt: nobody is bridged yet, and nothing we do from here is an
      // intentional hang-up until we say so.
      bridgedRef.current = false;
      intentionalEndRef.current = false;

      const lines: DialLine[] = leads.map((lead) => ({
        id: `line-${lead.id}-${Date.now()}`,
        lead,
        status: "ringing",
      }));

      patch({
        status: "dialing",
        lines,
        connectedLead: null,
        durationSec: 0,
        muted: false,
        // The rep leg joins the conference when connect() resolves (below) —
        // BEFORE the customer answers — so mute is armed from dialing onward.
        // A toggle in this window queues its intent; attachCallHandlers applies.
        muteCapability: "arming",
        onHold: false,
        lastOutcome: null,
        error: null,
        callSid: null,
        room: null,
        outboundSids: [],
      });
      // Count each LINE dialed, not each batch — a 3X parallel dial places three
      // calls and must read as three dials (AI mode already counts per lead), so
      // the session/day dial totals mean the same thing in both modes.
      recordDials(leads.length);
      setState((s) => ({
        ...s,
        callsThisSession: s.callsThisSession + leads.length,
        dialsToday: dialsTodayRef.current,
      }));

      // Register live presence for the Live Monitor. The conference room is
      // derived from this id so supervisors can join it to listen.
      const lead0 = leads[0];
      const humanId = `h-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;
      humanIdRef.current = humanId;
      const room = `hc-${humanId}`;
      // Persist the room so the disposition save can link the recording to it.
      // (attemptIds is patched below once minted — see the dial block.)
      patch({ room });
      fetch("/api/calls/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "start",
          id: humanId,
          leadName:
            leads.length > 1
              ? `${leads.length}× parallel dial`
              : `${lead0.firstName} ${lead0.lastName}`.trim() ||
                formatPhone(lead0.phone),
          city: [lead0.city, lead0.state].filter(Boolean).join(", "),
          phone: lead0.phone,
        }),
      }).catch(() => {});

      // Tracked outside the try so a failure to join the conference can still
      // hang up whatever we already put on the wire (see the catch below).
      let placedSids: string[] = [];
      // What we asked Twilio to dial. This is the ONLY handle on those calls
      // that can't be lost in transit, so every cleanup path falls back to it.
      const dialed = leads.map((l) => ({ leadId: l.id, phone: l.phone }));
      // Per-lead idempotency keys for this round: carried onto call_attempts at
      // dial time and onto every disposition save, so a replayed save can never
      // double-file. One key per LEAD (a 3X round is three attempts).
      const attemptIds: Record<string, string> = {};
      for (const l of leads) {
        attemptIds[l.id] =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `ca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      }
      attemptIdsRef.current = attemptIds;
      undialedRef.current = new Set();
      patch({ attemptIds });
      // Publish it immediately, so a teardown triggered from OUTSIDE this
      // function — a Call error event, Cancel, the poll giving up — can hang the
      // legs up too. Previously only the paths inside this try block could.
      activeLegsRef.current = { sids: [], dialed };
      // Flips once the dial request has come back, so the catch below can tell
      // "we never got as far as Twilio" from "Twilio is dialing, our side broke".
      let dialResponded = false;

      try {
        // Dial the homeowner(s) into the conference room via Twilio REST.
        const res = await fetch("/api/twilio/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room,
            agentIdentity: identityRef.current,
            leads: dialed,
            attemptIds,
            localPresence: localPresenceRef.current,
            excludedCallerIds: excludedCallerIdsRef.current.length
              ? excludedCallerIdsRef.current
              : undefined,
            pinnedCallerId: opts?.pinnedCallerId,
          }),
        });
        dialResponded = true;

        // Read the body ONCE, and never let a failure to read it decide whether
        // a call happened. /api/twilio/call puts real phones on the wire and
        // then reports the leg SIDs; those two facts travel separately, and the
        // report has to survive a trip back through the CDN that the ringing
        // phone does not. Conflating "I couldn't read the answer" with "nothing
        // was dialed" is what dropped the rep back to idle — with an error
        // blaming their Twilio credentials — while a homeowner's phone rang an
        // empty conference that nobody would ever join, and nothing hung it up.
        const raw = await res.text().catch(() => "");
        let data: {
          calls?: { leadId: string; sid: string | null; error?: string | null }[];
          errors?: (string | null)[];
          error?: string;
          callerIdInfo?: { callerId: string; pool: string[]; poolIndex: number; rotateEvery: number } | null;
        } = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          /* unreadable — the recovery below decides what actually happened */
        }

        let placed = (data.calls ?? [])
          .filter((c): c is { leadId: string; sid: string } => Boolean(c?.sid))
          .map((c) => ({ leadId: c.leadId, sid: c.sid }));

        // Nothing came back with a SID. Before calling that a failed dial, ask
        // Twilio — it is the one party that can't be confused on this point.
        if (!placed.length) {
          placed = await recoverPlacedLegs(dialed);
        }

        if (!placed.length) {
          clearHumanPresence();
          dialInFlightRef.current = false;
          activeLegsRef.current = { sids: [], dialed: [] };
          // Nothing was dialed — free the claims NOW rather than letting the
          // holds run out their TTL while the rep retries into "all claimed".
          releaseClaimedLeads("reset");
          // Surface the real Twilio rejection (e.g. unverified number on trial
          // account, invalid caller ID, geographic restriction, etc.) so the
          // team knows exactly what to fix rather than getting a generic message.
          const twilioMsg = (data.errors ?? []).filter(Boolean)[0];
          patch({
            error: data.error
              ? data.error
              : twilioMsg
                ? `Call failed: ${twilioMsg}`
                : res.ok
                  ? "Couldn't place the call. Check your Twilio number and credentials."
                  : `The dialer service returned ${res.status}. Try again in a moment.`,
            status: "idle",
            lines: [],
            muteCapability: "unsupported",
          });
          return;
        }

        // Store caller ID info for the rotation indicator and hold/unhold.
        if (data.callerIdInfo) {
          patch({ callerIdInfo: data.callerIdInfo });
        }
        placedSids = placed.map((p) => p.sid);

        // Legs the server REFUSED to place (enforced calling hours in the
        // lead's own timezone, or a per-leg Twilio failure) never rang. They
        // must leave this round's bookkeeping entirely: their lanes flip to
        // canceled, their claims free NOW (not on the 180s TTL), and the
        // undialed set stops recordNonWinners from fabricating a no_answer
        // record — an audit entry for a call that never happened.
        const placedIds = new Set(placed.map((p) => p.leadId));
        const droppedIds = dialed
          .map((d) => d.leadId)
          .filter((id) => !placedIds.has(id));
        const activeDialed = droppedIds.length
          ? dialed.filter((d) => placedIds.has(d.leadId))
          : dialed;
        if (droppedIds.length) {
          for (const id of droppedIds) {
            undialedRef.current.add(id);
            claimedIdsRef.current.delete(id);
          }
          if (optionsRef.current.reservations?.enabled) {
            fetch("/api/dialer/release", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ leadIds: droppedIds }),
              keepalive: true,
            }).catch(() => {});
          }
          const droppedSet = new Set(droppedIds);
          setState((s) => ({
            ...s,
            lines: s.lines.map((ln) =>
              droppedSet.has(ln.lead.id) ? { ...ln, status: "canceled" as const } : ln,
            ),
          }));
        }
        activeLegsRef.current = { sids: placedSids, dialed: activeDialed };
        patch({ outboundSids: placedSids });

        // Join the rep's browser into the same room. `record` is the ORG's
        // recording policy (settings.dialing.recording) — it used to be a
        // hardcoded "true", which made the on-screen REC indicator (and the
        // recording disclosure) a lie for any org that switched recording off.
        const call = await device.connect({
          params: {
            Conference: room,
            record: String(Boolean(recordingRef.current)),
            MonitorId: humanId,
          },
        });

        // The rep's browser is now in the conference, but the CALL is NOT
        // "connected" until the CUSTOMER actually answers. Poll Twilio for the
        // answered leg — works for single AND parallel — and flip to connected
        // only then. So the dialer + Live Monitor stay on "Dialing / Ringing"
        // until pickup (never a premature "connected"), the talk timer starts at
        // the real answer, and a no-answer cleanly wraps the attempt up.
        attachCallHandlers(call);
        stopPoll();
        // Cadence: 1.5s alone, 5s when the org floor channel is live — the
        // `call.answered` broadcast then runs this same body within ~1s of
        // pickup (see onAnsweredHint), and the poll is only the safety net.
        // The give-up cap scales with the interval so the backstop stays a
        // constant ~3 minutes either way.
        const pollIntervalMs = realtimeLiveRef.current ? 5_000 : 1_500;
        const maxPollAttempts = Math.max(1, Math.round(180_000 / pollIntervalMs));
        let pollAttempts = 0;
        const pollAnswered = async () => {
          // ~3 minutes max (see the cap above). Treats a hung Twilio response
          // as no-answer so the rep isn't left waiting.
          if (++pollAttempts > maxPollAttempts) {
            stopPoll();
            intentionalEndRef.current = true;
            try { callRef.current?.disconnect(); } catch { /* noop */ }
            // resetToIdle (not a bare patch) so the outbound leg is released too
            // — three minutes in, an un-hung-up leg is a phone still ringing.
            resetToIdle("No answer — the call timed out.");
            return;
          }
          try {
            const a = await fetch("/api/twilio/answered", {
              method: "POST",
              headers: { "content-type": "application/json" },
              // `room` proves we own this call — the route only touches legs
              // belonging to the live_calls row for this conference.
              body: JSON.stringify({ room, legs: placed }),
            });
            const { answeredLeadId, done } = (await a.json()) as {
              answeredLeadId: string | null;
              done?: boolean;
            };
            if (answeredLeadId) {
              const lead = leads.find((l) => l.id === answeredLeadId) ?? leads[0];
              // File no_answer records for the homeowners dialed on the OTHER
              // parallel lines — they don't get a rep disposition (P2.RECORDS).
              recordNonWinners(leads, answeredLeadId);
              connectLine(lead); // connectLine stops the poll + starts the timer
              // In parallel mode the conference has endOnExit=false, so the
              // customer hanging up does NOT end the rep's leg and nothing else
              // would tell us. Watch the winning leg and wrap up when it ends
              // (P2.HANGUP) — the same outcome a single dial gets for free.
              const winnerLeg = placed.find((p) => p.leadId === answeredLeadId);
              if (leads.length > 1 && winnerLeg) {
                customerWatchRef.current = setInterval(async () => {
                  try {
                    const w = await fetch("/api/twilio/answered", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ room, legs: [winnerLeg] }),
                    });
                    const { done: gone } = (await w.json()) as { done?: boolean };
                    // Only wrap up if we're still on THIS bridged call.
                    if (gone && bridgedRef.current) endCall();
                  } catch {
                    /* transient read — keep watching */
                  }
                }, 4000);
              }
            } else if (done) {
              // Nobody answered — release the rep from the empty conference. File
              // no_answer for the non-focus parallel lines (the rep dispositions
              // the focus lead themselves).
              recordNonWinners(leads, leads[0]?.id ?? "");
              stopPoll();
              if (callRef.current) {
                // Nobody home is an OUTCOME, not a failure — flag the hang-up as
                // ours so the rep still gets the disposition screen.
                intentionalEndRef.current = true;
                try {
                  callRef.current.disconnect();
                } catch {
                  /* the disconnect handler wraps up */
                }
              } else {
                // The rep's leg is already gone, so no "disconnect" event is
                // coming and nothing would ever move the UI off "Dialing".
                resetToIdle("No answer.");
              }
            }
          } catch {
            /* keep polling */
          }
        };
        answeredPollFnRef.current = pollAnswered;
        pollRef.current = setInterval(pollAnswered, pollIntervalMs);
      } catch (err) {
        // device.connect() throws on a destroyed Device or when a Call is already
        // active (see Device.connect in @twilio/voice-sdk), and the dial fetch
        // throws on a dropped connection. All of them land here.
        console.error("[dialer] start failed", err);
        // resetToIdle releases the outbound leg(s) via activeLegsRef — which is
        // populated even when we never learned the SIDs, so the homeowner is
        // hung up either way.
        resetToIdle(
          dialResponded
            ? describeCallError(err)
            : "Lost the connection while starting the call. Any lines that were ringing have been hung up — press Start to try again.",
        );
      }
    },
    [
      attachCallHandlers,
      clearHumanPresence,
      connectLine,
      endCall,
      nextLeads,
      patch,
      queue.length,
      recordDials,
      recordNonWinners,
      recoverPlacedLegs,
      releaseClaimedLeads,
      releaseLegs,
      resetToIdle,
      stopPoll,
    ],
  );

  // The Start button + auto-dial route through here, honoring the current mode.
  const startCall = useCallback(
    (override?: Lead[]) => {
      if (aiModeRef.current && aiConfiguredRef.current && !override) {
        startAISession();
        return;
      }
      void startHumanCall(override);
    },
    [startAISession, startHumanCall],
  );

  /**
   * Begin a fresh pass through the (freshly-refetched) queue after auto-dial
   * completes a lap. Called by the parent once it's confirmed there's still
   * something dialable — resets the queue position to the top so AI mode's
   * cursor (which reads off queueIndexRef) and manual mode's nextLeads() both
   * start from lead 0 of the new list, instead of picking up from wherever
   * the exhausted previous pass left off.
   */
  const restartAutoDialLap = useCallback(() => {
    queueIndexRef.current = 0;
    patch({ queueIndex: 0 });
    startCall();
  }, [patch, startCall]);

  const dialNumber = useCallback(
    (raw: string, displayName?: string) => {
      const e164 = toE164(raw);
      if (e164.replace(/\D/g, "").length < 10) {
        patch({ error: "Enter a valid phone number." });
        return;
      }
      const lead = manualLead(e164);
      if (displayName) {
        const parts = displayName.trim().split(/\s+/);
        lead.firstName = parts[0] ?? lead.firstName;
        lead.lastName = parts.slice(1).join(" ");
      }
      void startHumanCall([lead]); // manual dial is always human
    },
    [patch, startHumanCall],
  );

  /** Rewind to the top of the list — a freshly-loaded session starts at its
   *  first lead, whatever position the previous session was parked at. */
  const resetQueueCursor = useCallback(() => {
    queueIndexRef.current = 0;
    claimAdvancedRef.current = false;
    lapWrappedRef.current = false;
    setState((s) => (s.queueIndex === 0 ? s : { ...s, queueIndex: 0 }));
  }, []);

  const advanceQueue = useCallback(() => {
    if (!queue.length) return;
    // A strict claim already advanced the cursor past exactly the leads this
    // round consumed — bumping again here skipped ~parallel leads per round
    // (and made laps complete at half the list). Consume the flag instead.
    // (Caught by review: the double advance was the mirror image of the very
    // mis-dial bug the claim advance fixed.)
    if (claimAdvancedRef.current) {
      claimAdvancedRef.current = false;
      return;
    }
    queueIndexRef.current =
      (queueIndexRef.current + parallelRef.current) % queue.length;
    patch({ queueIndex: queueIndexRef.current });
  }, [patch, queue.length]);

  // True when the CURRENT queue position is the last one this pass will touch
  // — i.e. advanceQueue() is about to wrap back toward the start. Must be
  // read BEFORE advanceQueue() moves the index. When a strict claim advanced
  // the cursor itself, the wrap already happened (or didn't) at claim time —
  // the flag the claim path recorded is the truth for this round.
  const isCompletingLap = useCallback(
    () =>
      claimAdvancedRef.current
        ? lapWrappedRef.current
        : queue.length > 0 && queueIndexRef.current + parallelRef.current >= queue.length,
    [queue.length],
  );

  const selectOutcome = useCallback(
    (outcome: CallOutcome) => {
      clearHumanPresence();
      // Dispositioning from wrap-up ends the attempt for good. If anything was
      // still on the wire (a losing parallel leg, a leg that outlived the rep's
      // side), it goes now. No-op once bridged — see connectLine.
      releaseActiveLegs();
      // Claims: FORGET, don't release. The disposition write releases the hold
      // server-side (markLeadAttempted inside insertCallRecord) — a client
      // release here would race it and could hand the lead to another rep
      // before its attempt counter advanced.
      releaseClaimedLeads("disposition");
      dialInFlightRef.current = false;
      bridgedRef.current = false;
      intentionalEndRef.current = false;
      pendingMuteRef.current = null;
      const completingLap = isCompletingLap();
      patch({ lastOutcome: outcome, status: "idle", lines: [], connectedLead: null });
      advanceQueue();
      if (autoDialRef.current && queue.length) {
        if (completingLap) {
          // Reached the end of this pass. Don't blindly re-dial the same
          // static, possibly-stale array (it would include leads just
          // dispositioned as not_interested/DNC/booked moments ago in this
          // same pass). Bump queueLap — the parent refetches the dial queue
          // and calls restartAutoDialLap() once it confirms there's still
          // something dialable.
          queueLapRef.current += 1;
          patch({ queueLap: queueLapRef.current });
        } else {
          setTimeout(() => startCall(), 900);
        }
      }
    },
    [
      advanceQueue,
      clearHumanPresence,
      isCompletingLap,
      patch,
      queue.length,
      releaseActiveLegs,
      releaseClaimedLeads,
      startCall,
    ],
  );

  const skip = useCallback(() => {
    stopTick();
    stopPoll();
    clearHumanPresence();
    // This is the "Cancel" button on the ringing screen as well as "Skip without
    // disposition" on wrap-up. Cancelling a dial hung up only the REP's browser
    // leg and left the homeowner's phone ringing an empty conference until it
    // rang out. Release it. (No-op once a call is bridged — see connectLine.)
    releaseActiveLegs();
    // No disposition was filed, so nothing will release the claims server-side
    // — free them here or the leads sit locked for the rest of the TTL.
    releaseClaimedLeads("skip");
    dialInFlightRef.current = false;
    bridgedRef.current = false;
    intentionalEndRef.current = false;
    pendingMuteRef.current = null;
    // Detach before hanging up — skip() decides where the rep goes next (idle,
    // or straight into the next auto-dial), so the `disconnect` this fires must
    // not be handled at all.
    const call = callRef.current;
    callRef.current = null;
    try {
      call?.disconnect();
    } catch {
      /* noop */
    }
    const completingLap = isCompletingLap();
    advanceQueue();
    if (autoDialRef.current && queue.length) {
      if (completingLap) {
        queueLapRef.current += 1;
        patch({ status: "idle", lines: [], connectedLead: null, durationSec: 0, muteCapability: "unsupported", queueLap: queueLapRef.current });
      } else {
        setTimeout(() => startCall(), 400);
      }
    } else {
      patch({ status: "idle", lines: [], connectedLead: null, durationSec: 0, muteCapability: "unsupported" });
    }
  }, [
    advanceQueue,
    clearHumanPresence,
    isCompletingLap,
    patch,
    queue.length,
    releaseActiveLegs,
    releaseClaimedLeads,
    startCall,
    stopPoll,
    stopTick,
  ]);

  /**
   * Re-attempt `lead` right now instead of moving on to whatever the queue has
   * next — the manual-dialing counterpart to the AI's automatic double-dial.
   * Many Do Not Disturb setups let a call through when it repeats within a few
   * minutes, and a rep watching the wrap-up screen is in the best position to
   * judge "that felt like DND, not a real no-answer" and act on it immediately
   * rather than wait for this lead to cycle back around the queue.
   *
   * Pins the SAME caller ID the just-ended attempt used (see pinnedCallerId on
   * nextCallerIdWithInfo) — a repeat call from a DIFFERENT number isn't
   * recognizable to the homeowner's phone as a repeat, which would defeat the
   * whole point.
   *
   * Files NO disposition, matching skip(): the wrap-up screen is still up
   * because the rep hasn't judged this attempt, and redialing doesn't answer
   * that judgment either. `lead` keeps whatever status it already has, so
   * it's exactly as eligible for the ordinary queue/auto-dial afterward as it
   * was before this button was pressed.
   */
  const redial = useCallback(
    (lead: Lead) => {
      stopTick();
      stopPoll();
      clearHumanPresence();
      releaseActiveLegs();
      // Keep the claim: redial dials the SAME lead again, so the hold is still
      // ours to use (and the heartbeat keeps renewing it through the attempt).
      dialInFlightRef.current = false;
      bridgedRef.current = false;
      intentionalEndRef.current = false;
      pendingMuteRef.current = null;
      const call = callRef.current;
      callRef.current = null;
      try {
        call?.disconnect();
      } catch {
        /* noop */
      }
      const pinnedCallerId = state.callerIdInfo?.callerId || undefined;
      patch({ status: "idle", lines: [], connectedLead: null, durationSec: 0 });
      void startHumanCall([lead], { pinnedCallerId });
    },
    [
      clearHumanPresence,
      patch,
      releaseActiveLegs,
      startHumanCall,
      state.callerIdInfo,
      stopPoll,
      stopTick,
    ],
  );

  const launchNextAI = useCallback(() => {
    // Clear any pending tick first (mirrors startAISession) so a manual "launch
    // next" while a timer is already armed can't start a second pump lineage.
    stopAITimer();
    void launchAIBatch();
  }, [launchAIBatch, stopAITimer]);

  /**
   * Dial ONE lead again with the AI agent — the rep-pressed twin of the
   * automatic double-tap. The manual dialer has always had `redial`; the AI side
   * had nothing, so a call that rang out or died on connect was simply lost
   * unless the whole list was run again.
   *
   * Deliberately NOT gated on auto-dial or the campaign state: a rep watching a
   * call fail wants to re-ring it right now, whether the pump is running, idle,
   * or the campaign already reported "done".
   */
  const redialAI = useCallback(
    (leadId: string) => {
      const lead = aiLeadByIdRef.current.get(leadId);
      if (!lead) {
        patch({ error: "That lead is no longer loaded — reload your queue to dial it again." });
        return;
      }
      // Already on the wire (or holding a line for its double-tap) — a second
      // press would put two live calls on one homeowner.
      if (
        aiDialInFlight(
          leadId,
          inflightRef.current,
          new Set(redialsRef.current.keys()),
        )
      ) {
        return;
      }
      patch({ error: null });
      void launchAICall(lead, sessionGenRef.current);
    },
    [launchAICall, patch],
  );

  const stopAICampaign = useCallback(() => {
    // Clearing autoDialRef is what actually stops the pump: a launchAIBatch tick
    // already in flight re-reads it after its awaits, so without this it would
    // arm the next tick and keep dialing after Stop was pressed.
    autoDialRef.current = false;
    stopAITimer();
    patch({ aiCampaign: "idle" });
  }, [patch, stopAITimer]);

  const endAISession = useCallback(() => {
    autoDialRef.current = false;
    stopAITimer();
    sessionGenRef.current += 1;
    purgeRedials();
    attemptsRef.current.clear();
    convLeadRef.current.clear();
    aiLeadByIdRef.current.clear();
    patch({ status: "idle", aiCalls: [], aiCampaign: "idle" });
  }, [patch, purgeRedials, stopAITimer]);

  const toggleMute = useCallback(() => {
    setState((s) => {
      // Pure verdict (see dialer/mute-intent.ts): apply to the live Call,
      // QUEUE during the arming window (connect() not yet resolved — the
      // intent is honored in attachCallHandlers), or ignore when there's
      // nothing in flight at all — no optimistic pill over a dead control.
      const decision = decideMuteToggle({
        muted: s.muted,
        hasCall: Boolean(callRef.current),
        dialInFlight: dialInFlightRef.current,
      });
      if (decision.action === "ignore") return s;
      if (decision.action === "apply") {
        pendingMuteRef.current = null;
        try {
          callRef.current?.mute(decision.muted);
        } catch {
          /* torn-down call — the state resets with it */
        }
      } else {
        pendingMuteRef.current = decision.muted;
      }
      return { ...s, muted: decision.muted };
    });
  }, []);

  const toggleHold = useCallback(() => {
    setState((s) => {
      const nextHold = !s.onHold;
      // Fire-and-forget: ask Twilio to hold/unhold the homeowner participant(s)
      // with hold music. Falls back gracefully if Twilio isn't configured.
      if (s.room) {
        fetch("/api/twilio/hold", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ room: s.room, sids: s.outboundSids, hold: nextHold }),
        }).catch(() => {});
      }
      return { ...s, onHold: nextHold };
    });
  }, []);

  // toggleRecording is GONE on purpose: it flipped a client-side boolean that
  // controlled nothing (the connect param was hardcoded), so the button was a
  // dead control wearing a live look. Recording is org policy now — see
  // state.recording and the `record` param on device.connect().

  const sendDigit = useCallback((digit: string) => {
    try {
      callRef.current?.sendDigits(digit);
    } catch {
      /* noop */
    }
  }, []);

  /**
   * ANSWERED FAST-PATH (realtime): a `call.answered` broadcast for our room
   * just arrived — run the existing answered-poll body ONCE, immediately,
   * instead of waiting out the interval. Exactly the same fetch-and-resolve
   * the poll runs, so push and poll can never disagree; a hint with no active
   * poll (already connected / wrapped up) is a no-op by construction.
   */
  const onAnsweredHint = useCallback((_answeredLeadId?: string | null) => {
    void answeredPollFnRef.current?.();
  }, []);

  /** DialerProvider reports the org floor channel's health here — while live,
   *  the NEXT dial's answered poll relaxes to 5s (the broadcast is primary). */
  const setRealtimeLive = useCallback((live: boolean) => {
    realtimeLiveRef.current = live;
  }, []);

  const setAutoDial = useCallback(
    (value: boolean) => {
      autoDialRef.current = value;
      patch({ autoDial: value });
      if (!value) {
        stopAITimer();
        setState((s) => (s.aiCampaign === "running" ? { ...s, aiCampaign: "idle" } : s));
      }
    },
    [patch, stopAITimer],
  );

  /**
   * The ceiling is MODE-AWARE. A human rep genuinely can't handle more than a few
   * ringing lines — every extra answered call gets abandoned, which is rude and a
   * compliance problem. The AI agent has no such limit; its ceiling is whatever
   * the voice plan allows. Collapsing both into one hardcoded `Math.min(3, …)`
   * meant a 10-concurrent plan ran at 30% of what it pays for.
   */
  const maxParallel = useCallback(
    () =>
      aiModeRef.current
        ? Math.max(1, Math.min(MAX_PARALLEL_AI, maxAiRef.current))
        : humanCeilingRef.current,
    [],
  );

  const setParallelCount = useCallback(
    (value: number) => {
      const clamped = Math.min(maxParallel(), Math.max(1, value));
      parallelRef.current = clamped;
      patch({
        parallelCount: clamped,
        maxParallel: maxParallel(),
        sessionMode: deriveSessionMode(aiModeRef.current, clamped),
      });
    },
    [maxParallel, patch],
  );

  const setAiMode = useCallback(
    (value: boolean) => {
      // AI can only be turned ON when it's actually usable for this viewer
      // (configured + permitted); otherwise the dialer stays in manual mode.
      const next = value && aiConfiguredRef.current;
      aiModeRef.current = next;
      stopAITimer();
      clearHumanPresence();
      inflightRef.current.clear();
      slotAgeRef.current.clear();
      purgeRedials();
      attemptsRef.current.clear();
      convLeadRef.current.clear();
      aiLeadByIdRef.current.clear();

      // See parallelCountOnModeSwitch's doc comment: entering AI jumps
      // straight to the org's configured ceiling; leaving it only clamps
      // down, because a human rep genuinely cannot hold ten answered lines.
      const ceiling = next
        ? Math.max(1, Math.min(MAX_PARALLEL_AI, maxAiRef.current))
        : humanCeilingRef.current;
      parallelRef.current = parallelCountOnModeSwitch({
        enteringAi: next,
        current: parallelRef.current,
        maxAiConcurrency: maxAiRef.current,
        humanCeiling: humanCeilingRef.current,
      });

      patch({
        aiMode: next,
        sessionMode: deriveSessionMode(next, parallelRef.current),
        status: "idle",
        aiCalls: [],
        aiCampaign: "idle",
        parallelCount: parallelRef.current,
        maxParallel: ceiling,
      });
    },
    [clearHumanPresence, patch, stopAITimer],
  );

  /**
   * Move the whole dialer to one explicit mode. This is a coordinator over the
   * two real knobs (aiMode + parallelCount) — not a third source of truth:
   * "ai" turns AI mode on (a no-op when AI isn't usable for this viewer);
   * "parallel" is human dialing at 2+ lines (kept if already higher, clamped
   * by the org ceiling); "manual" is human dialing at exactly one line.
   */
  const setSessionMode = useCallback(
    (mode: SessionMode) => {
      if (mode === "ai") {
        setAiMode(true);
        return;
      }
      if (aiModeRef.current) setAiMode(false);
      setParallelCount(mode === "parallel" ? Math.max(2, parallelRef.current) : 1);
    },
    [setAiMode, setParallelCount],
  );

  /** The live Twilio Device (null in demo / before setup) — read-only access
   *  for the audio-device hook; the device lifecycle stays fully in here. */
  const getDevice = useCallback(() => deviceRef.current, []);

  /** Pick which AI persona AI calls dial as. Mirrored to a ref so in-flight
   *  launches read the current value. */
  const setActiveAgent = useCallback(
    (value: AgentKey) => {
      activeAgentRef.current = value;
      patch({ activeAgent: value });
    },
    [patch],
  );

  /** Flip a caller ID's excluded/included state from the dialer's toggle row.
   *  Mirrored to a ref so in-flight/async call launches read the current
   *  value, and to localStorage so the choice survives reloads. The picker UI
   *  is responsible for not letting the rep exclude every number — this just
   *  flips membership. */
  const toggleExcludedCallerId = useCallback(
    (callerId: string) => {
      const cur = excludedCallerIdsRef.current;
      const next = cur.includes(callerId)
        ? cur.filter((n) => n !== callerId)
        : [...cur, callerId];
      excludedCallerIdsRef.current = next;
      writeExcludedCallerIds(userIdRef.current, next);
      patch({ excludedCallerIds: next });
    },
    [patch],
  );

  /** Flip area-code matching for this rep. Takes effect on the NEXT dial —
   *  the caller ID for a call already ringing is long since chosen. */
  const setLocalPresence = useCallback(
    (value: boolean) => {
      localPresenceRef.current = value;
      writeLocalPresence(userIdRef.current, value);
      patch({ localPresence: value });
    },
    [patch],
  );

  return {
    state,
    startCall,
    restartAutoDialLap,
    resetQueueCursor,
    dialNumber,
    aiDialNumber,
    endCall,
    selectOutcome,
    skip,
    redial,
    toggleMute,
    toggleHold,
    sendDigit,
    setAutoDial,
    setParallelCount,
    setAiMode,
    setSessionMode,
    getDevice,
    setActiveAgent,
    toggleExcludedCallerId,
    setLocalPresence,
    launchNextAI,
    stopAICampaign,
    endAISession,
    redialAI,
    nextLead,
    prevLead,
    selectLead,
    reconnect,
    onAnsweredHint,
    setRealtimeLive,
  };
}
