import { describe, expect, it } from "vitest";
import {
  bootParallelCount,
  MAX_PARALLEL_AI,
  parallelCountOnModeSwitch,
} from "@/lib/use-dialer";

// ─────────────────────────────────────────────────────────────────────────────
// The reported gap: "add 10x dialing compatibility." The AI dialer already
// supported up to 30 concurrent calls, defaulting to 10 (org settings
// ai.maxConcurrentCalls) — the ceiling was never the problem.
//
// The bug: booting into AI mode always started parallelCount at 1, no matter
// what the org's ceiling said. The button row offered "10X"; nothing ever
// pressed it for you. Same gap switching from manual into AI mid-session — it
// carried over whatever manual mode was at (usually 1), clamped DOWN to the
// AI ceiling, never raised UP to it.
// ─────────────────────────────────────────────────────────────────────────────

describe("bootParallelCount", () => {
  it("boots AI mode at the org's configured ceiling, not 1", () => {
    // This is the whole bug. Before the fix this returned 1 regardless of
    // maxAiConcurrency, so an org configured for 10 concurrent AI calls
    // silently ran single-call every session until a rep clicked the row.
    expect(
      bootParallelCount({
        bootAiMode: true,
        initialMode: "ai",
        maxAiConcurrency: 10,
        humanCeiling: 3,
        parallelDefaultPref: false,
      }),
    ).toBe(10);
  });

  it("respects a non-default org ceiling", () => {
    expect(
      bootParallelCount({
        bootAiMode: true,
        initialMode: "ai",
        maxAiConcurrency: 5,
        humanCeiling: 3,
        parallelDefaultPref: false,
      }),
    ).toBe(5);
  });

  it("never boots above the platform ceiling even if org config is corrupt", () => {
    expect(
      bootParallelCount({
        bootAiMode: true,
        initialMode: "ai",
        maxAiConcurrency: 999,
        humanCeiling: 3,
        parallelDefaultPref: false,
      }),
    ).toBe(MAX_PARALLEL_AI);
  });

  it("never boots below 1 even if org config is zero/negative", () => {
    expect(
      bootParallelCount({
        bootAiMode: true,
        initialMode: "ai",
        maxAiConcurrency: 0,
        humanCeiling: 3,
        parallelDefaultPref: false,
      }),
    ).toBe(1);
  });

  it("still boots manual mode at 1 by default — that decision stays a rep's own", () => {
    expect(
      bootParallelCount({
        bootAiMode: false,
        initialMode: "manual",
        maxAiConcurrency: 10,
        humanCeiling: 3,
        parallelDefaultPref: false,
      }),
    ).toBe(1);
  });

  it("boots manual mode at the human ceiling when the org default is 'parallel'", () => {
    expect(
      bootParallelCount({
        bootAiMode: false,
        initialMode: "parallel",
        maxAiConcurrency: 10,
        humanCeiling: 3,
        parallelDefaultPref: false,
      }),
    ).toBe(3);
  });

  it("boots manual mode at the human ceiling when the REP's own preference says so", () => {
    expect(
      bootParallelCount({
        bootAiMode: false,
        initialMode: "manual",
        maxAiConcurrency: 10,
        humanCeiling: 3,
        parallelDefaultPref: true,
      }),
    ).toBe(3);
  });
});

describe("parallelCountOnModeSwitch", () => {
  it("jumps straight to the AI ceiling when entering AI mode, regardless of the prior count", () => {
    // The mid-session twin of the boot bug: switching manual(1) -> AI used to
    // clamp 1 down against the AI ceiling (min(1, 10) = 1) instead of raising
    // it up to what the org actually configured.
    expect(
      parallelCountOnModeSwitch({
        enteringAi: true,
        current: 1,
        maxAiConcurrency: 10,
        humanCeiling: 3,
      }),
    ).toBe(10);
  });

  it("still jumps to the ceiling even from a higher manual count", () => {
    expect(
      parallelCountOnModeSwitch({
        enteringAi: true,
        current: 3,
        maxAiConcurrency: 10,
        humanCeiling: 3,
      }),
    ).toBe(10);
  });

  it("clamps DOWN when leaving AI mode — a human cannot hold ten lines", () => {
    expect(
      parallelCountOnModeSwitch({
        enteringAi: false,
        current: 10,
        maxAiConcurrency: 10,
        humanCeiling: 3,
      }),
    ).toBe(3);
  });

  it("leaving AI mode never RAISES the count", () => {
    // Already below the human ceiling — must stay put, not jump up to it.
    expect(
      parallelCountOnModeSwitch({
        enteringAi: false,
        current: 1,
        maxAiConcurrency: 10,
        humanCeiling: 3,
      }),
    ).toBe(1);
  });

  it("clamps AI entry to the platform ceiling for a corrupt org value", () => {
    expect(
      parallelCountOnModeSwitch({
        enteringAi: true,
        current: 1,
        maxAiConcurrency: 999,
        humanCeiling: 3,
      }),
    ).toBe(MAX_PARALLEL_AI);
  });
});
