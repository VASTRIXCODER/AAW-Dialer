// ─────────────────────────────────────────────────────────────────────────────
// Abandonment-rate tracking — PURE decision logic, no I/O.
//
// Raising parallel dialing toward 10x is the direct cause of a real compliance
// risk, not a hypothetical one: the FTC's Telemarketing Sales Rule (16 CFR
// §310.4(b)(4)) caps the ABANDONMENT RATE — calls a live person answers that
// don't reach a live agent within 2 seconds — at 3%, measured per calling
// campaign over a rolling 30-day window. This app's own Terms page already
// promises customers that rate stays within legal limits.
//
// The good news, established by reading /api/twilio/status/route.ts before
// touching any of this: the release logic ALREADY refuses to hang up a leg
// that has been answered — it only ever cancels legs still ringing. So the
// system never manufactures a silent abandonment by force-hanging-up a live
// person. The real, remaining risk is structural to N-way parallel dialing
// itself: when two or more lines answer within the same short webhook race
// window, only one becomes the rep's connected call — the other homeowner(s)
// answered and, for some seconds, are not being greeted by anyone. That risk
// is roughly proportional to how many lines ring at once, which is exactly
// what raising the ceiling increases. Tracking + acting on the rate is what
// makes 10x lines a safe default rather than a silent liability.
//
// This module is the pure half: given counts, decide the rate and what to do
// about it. The I/O half (writing an event, reading the rolling window) lives
// in src/lib/db/abandonment.ts, which is server-only and calls into this.
// ─────────────────────────────────────────────────────────────────────────────

/** The FTC TSR's actual ceiling. Cited, never silently changed. */
export const ABANDONMENT_LEGAL_LIMIT = 0.03;
/** Where the org gets warned — comfortably under the legal limit, so there is
 *  real room to react before a single bad day tips the 30-day rate over. */
export const ABANDONMENT_WARN_THRESHOLD = 0.02;
/** The FTC's own measurement window. */
export const ABANDONMENT_WINDOW_DAYS = 30;

export type AbandonmentSeverity = "ok" | "warning" | "over_limit";

/**
 * One resolved parallel round's contribution to the rate. `answeredCount` is
 * how many of the round's lines were found genuinely answered (not still
 * ringing) when the round resolved — 1 means a clean single answer, no
 * collision; 2+ means that many minus one were left ungreeted.
 */
export interface RoundOutcome {
  linesDialed: number;
  answeredCount: number;
}

/** How many of a round's answers were NOT the one the rep connected to. */
export function abandonedInRound(round: RoundOutcome): number {
  return Math.max(0, round.answeredCount - 1);
}

/**
 * The rate itself: abandoned answers ÷ total answers, across a set of rounds.
 * A campaign with no answered calls yet has an undefined rate, not a zero one
 * — reported as 0 with `sampleSize: 0` so a caller can tell "no data" from
 * "verified clean," which matters because the FTC rule is about calls
 * actually answered, not calls placed.
 */
export function computeAbandonmentRate(rounds: readonly RoundOutcome[]): {
  rate: number;
  answered: number;
  abandoned: number;
} {
  let answered = 0;
  let abandoned = 0;
  for (const r of rounds) {
    answered += Math.max(0, r.answeredCount);
    abandoned += abandonedInRound(r);
  }
  return { rate: answered > 0 ? abandoned / answered : 0, answered, abandoned };
}

/** Classify a rate against the two thresholds above. */
export function abandonmentSeverity(
  rate: number,
  sampleSize: number,
): AbandonmentSeverity {
  // No data yet is not "ok" in the sense of "verified safe" — but it is not a
  // warning either. Callers that need a strict on/off gate should treat a
  // small sample as "ok" (nothing to react to) and let the rate speak once
  // there's enough volume to mean something; see safeParallelCeiling below,
  // which does exactly that.
  if (sampleSize === 0) return "ok";
  if (rate >= ABANDONMENT_LEGAL_LIMIT) return "over_limit";
  if (rate >= ABANDONMENT_WARN_THRESHOLD) return "warning";
  return "ok";
}

/** Minimum answered-call sample before the rate is trusted enough to ACT on
 *  (as opposed to merely display). A single unlucky pair of near-simultaneous
 *  answers early in a session must not slam an org down to 1-line dialing —
 *  the FTC's own rule is a 30-day rate for exactly this reason: it is
 *  measuring a pattern, not a coincidence. */
export const MIN_SAMPLE_FOR_ENFORCEMENT = 20;

/**
 * The REAL safeguard: what parallel-line ceiling is safe to actually offer,
 * given the org's own recent abandonment rate. This is what keeps 10x lines
 * from being "a number in Admin nobody looks at until a complaint arrives" —
 * the dialer enforces it directly.
 *
 *   - Under warning, with enough sample to trust the rate: the org's own
 *     configured ceiling stands.
 *   - At warning: still the configured ceiling — this is the "you're getting
 *     close" zone, surfaced in the UI, not yet restricted.
 *   - At or over the legal limit, with enough sample to trust it: drop to
 *     single-line dialing. Not zero (that would stop the org from working
 *     leads at all over a compliance question) — one line at a time cannot
 *     abandon a second caller, because there is no second caller.
 */
export function safeParallelCeiling(input: {
  orgConfiguredCeiling: number;
  rate: number;
  sampleSize: number;
}): number {
  const severity = abandonmentSeverity(input.rate, input.sampleSize);
  if (severity === "over_limit" && input.sampleSize >= MIN_SAMPLE_FOR_ENFORCEMENT) {
    return 1;
  }
  return Math.max(1, Math.floor(input.orgConfiguredCeiling) || 1);
}
