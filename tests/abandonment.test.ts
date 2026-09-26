import { describe, expect, it } from "vitest";
import {
  ABANDONMENT_LEGAL_LIMIT,
  ABANDONMENT_WARN_THRESHOLD,
  abandonedInRound,
  abandonmentSeverity,
  computeAbandonmentRate,
  MIN_SAMPLE_FOR_ENFORCEMENT,
  safeParallelCeiling,
} from "@/lib/dialer/abandonment";

// ─────────────────────────────────────────────────────────────────────────────
// Raising parallel dialing toward 10x is the direct cause of more collisions —
// more lines ringing at once means more chances two answer close together.
// This is the safeguard: without it, 10x lines is a liability with a number
// nobody's watching; with it, the dialer actually enforces the FTC's TSR cap.
// ─────────────────────────────────────────────────────────────────────────────

describe("abandonedInRound", () => {
  it("a clean single answer abandons nobody", () => {
    expect(abandonedInRound({ linesDialed: 5, answeredCount: 1 })).toBe(0);
  });

  it("two answers in one round abandons exactly one homeowner", () => {
    expect(abandonedInRound({ linesDialed: 10, answeredCount: 2 })).toBe(1);
  });

  it("never goes negative for a malformed zero-answer round", () => {
    expect(abandonedInRound({ linesDialed: 3, answeredCount: 0 })).toBe(0);
  });
});

describe("computeAbandonmentRate", () => {
  it("is 0 with sampleSize 0 when nothing has been answered yet", () => {
    expect(computeAbandonmentRate([])).toEqual({ rate: 0, answered: 0, abandoned: 0 });
  });

  it("is 0 across a run of entirely clean rounds", () => {
    const rounds = Array.from({ length: 50 }, () => ({ linesDialed: 10, answeredCount: 1 }));
    expect(computeAbandonmentRate(rounds)).toEqual({ rate: 0, answered: 50, abandoned: 0 });
  });

  it("computes the real-world rate across a mix", () => {
    // 94 clean single-answer rounds (94 answered) + 3 two-way collisions (each
    // 2 answered, 1 abandoned) => 94 + 6 = 100 answered, 3 abandoned = 3%.
    const rounds = [
      ...Array.from({ length: 94 }, () => ({ linesDialed: 10, answeredCount: 1 })),
      ...Array.from({ length: 3 }, () => ({ linesDialed: 10, answeredCount: 2 })),
    ];
    const r = computeAbandonmentRate(rounds);
    expect(r.answered).toBe(100);
    expect(r.abandoned).toBe(3);
    expect(r.rate).toBeCloseTo(0.03, 5);
  });

  it("a single round with a 3-way collision counts 2 abandoned, 3 answered", () => {
    const r = computeAbandonmentRate([{ linesDialed: 10, answeredCount: 3 }]);
    expect(r).toEqual({ rate: 2 / 3, answered: 3, abandoned: 2 });
  });
});

describe("abandonmentSeverity", () => {
  it("is 'ok' with no sample — nothing to react to yet", () => {
    expect(abandonmentSeverity(0.5, 0)).toBe("ok");
  });

  it("is 'ok' comfortably under the warn threshold", () => {
    expect(abandonmentSeverity(0.01, 100)).toBe("ok");
  });

  it("warns before the legal limit, with room to react", () => {
    expect(abandonmentSeverity(ABANDONMENT_WARN_THRESHOLD, 100)).toBe("warning");
    expect(abandonmentSeverity(0.025, 100)).toBe("warning");
  });

  it("is over_limit exactly AT the FTC's 3%, not only above it", () => {
    expect(abandonmentSeverity(ABANDONMENT_LEGAL_LIMIT, 100)).toBe("over_limit");
    expect(abandonmentSeverity(0.05, 100)).toBe("over_limit");
  });
});

describe("safeParallelCeiling — the actual enforcement lever", () => {
  it("stands at the org's configured ceiling when the rate is clean", () => {
    expect(
      safeParallelCeiling({ orgConfiguredCeiling: 10, rate: 0, sampleSize: 500 }),
    ).toBe(10);
  });

  it("still stands at the configured ceiling in the warning zone — surfaced, not restricted", () => {
    expect(
      safeParallelCeiling({ orgConfiguredCeiling: 10, rate: 0.025, sampleSize: 500 }),
    ).toBe(10);
  });

  it("drops to single-line dialing once over the legal limit with real volume", () => {
    expect(
      safeParallelCeiling({ orgConfiguredCeiling: 10, rate: 0.05, sampleSize: 500 }),
    ).toBe(1);
  });

  it("does NOT drop the ceiling over the limit before there is enough sample to trust it", () => {
    // The whole reason MIN_SAMPLE_FOR_ENFORCEMENT exists: one unlucky pair of
    // near-simultaneous answers early on must not slam an org down to 1-line
    // dialing. The FTC's own rule measures a 30-day PATTERN, not a coincidence.
    expect(
      safeParallelCeiling({
        orgConfiguredCeiling: 10,
        rate: 1, // even a "100%" rate...
        sampleSize: MIN_SAMPLE_FOR_ENFORCEMENT - 1,
      }),
    ).toBe(10);
  });

  it("enforces right at the sample-size boundary", () => {
    expect(
      safeParallelCeiling({
        orgConfiguredCeiling: 10,
        rate: 0.05,
        sampleSize: MIN_SAMPLE_FOR_ENFORCEMENT,
      }),
    ).toBe(1);
  });

  it("never returns a ceiling below 1 or above the org's own setting", () => {
    expect(safeParallelCeiling({ orgConfiguredCeiling: 0, rate: 0, sampleSize: 0 })).toBe(1);
    expect(
      safeParallelCeiling({ orgConfiguredCeiling: 5, rate: 0, sampleSize: 100 }),
    ).toBe(5);
  });
});
