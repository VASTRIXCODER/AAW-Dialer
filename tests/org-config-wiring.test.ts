import { describe, expect, it } from "vitest";
import { hexToHsl, orgAccentCss } from "@/lib/org/accent";
import {
  describeOrgHours,
  isWithinOrgHours,
} from "@/lib/dialer/schedule";
import {
  DEFAULT_DIALER_USER_PREFS,
  parseDialerUserPrefs,
} from "@/lib/dialer/user-prefs";
import { buildOverridePayload, type OverridePolicy } from "@/lib/elevenlabs";
import { DEFAULT_ORG_SETTINGS, mergeSettings } from "@/lib/org/settings";
import { orgVocabulary } from "@/lib/org/vocabulary";

// ─────────────────────────────────────────────────────────────────────────────
// The dead-control resurrection batch: every admin configuration must actually
// work. These tests pin the pure logic each rewired control now rides on.
// ─────────────────────────────────────────────────────────────────────────────

describe("settings.dialing.defaultMode — sanitized on read", () => {
  it("defaults to 'ai' (the historical boot behavior) when absent", () => {
    expect(mergeSettings({}).dialing.defaultMode).toBe("ai");
    expect(mergeSettings(undefined).dialing.defaultMode).toBe("ai");
  });

  it("keeps a valid stored choice and rejects garbage", () => {
    expect(mergeSettings({ dialing: { defaultMode: "manual" } }).dialing.defaultMode).toBe(
      "manual",
    );
    expect(
      mergeSettings({ dialing: { defaultMode: "parallel" } }).dialing.defaultMode,
    ).toBe("parallel");
    expect(
      mergeSettings({ dialing: { defaultMode: "predictive" } }).dialing.defaultMode,
    ).toBe("ai");
    expect(mergeSettings({ dialing: { defaultMode: 42 } }).dialing.defaultMode).toBe("ai");
  });

  it("new dial-policy knobs default OFF so stored dead-control values never wake up", () => {
    // The old retryAttempts:3 / retryDelayMin:60 blobs persist in production
    // rows; the NEW keys are what the claim path reads, and they start at 0.
    expect(DEFAULT_ORG_SETTINGS.dialing.maxAttemptsPerLead).toBe(0);
    expect(DEFAULT_ORG_SETTINGS.dialing.redialCooldownMin).toBe(0);
    const merged = mergeSettings({ dialing: { retryAttempts: 3, retryDelayMin: 60 } });
    expect(merged.dialing.maxAttemptsPerLead).toBe(0);
    expect(merged.dialing.redialCooldownMin).toBe(0);
  });

  it("calling hours default to advisory (enforced=false)", () => {
    expect(mergeSettings({}).hours.enforced).toBe(false);
    expect(mergeSettings({ hours: { enforced: true } }).hours.enforced).toBe(true);
  });

  it("the hardcoded personal transfer number default is gone", () => {
    expect(DEFAULT_ORG_SETTINGS.ai.transferNumber).toBe("");
  });

  it("the talk-time watchdog uses a NEW key — stored dead maxTalkMin never wakes up", () => {
    expect(DEFAULT_ORG_SETTINGS.ai.talkTimeLimitMin).toBe(0);
    // Every org that ever saved the AI section has the dead control's
    // maxTalkMin: 8 persisted; it must not become a live 8-minute hangup.
    const merged = mergeSettings({ ai: { maxTalkMin: 8 } });
    expect(merged.ai.talkTimeLimitMin).toBe(0);
  });
});

describe("isWithinOrgHours — the calling-hours predicate", () => {
  const hours = { startHour: 8, endHour: 20, days: [1, 2, 3, 4, 5] };
  // 2026-08-26 is a Wednesday. 15:00 UTC = 10:00 in America/Chicago (CDT).
  const wedMorning = new Date("2026-08-26T15:00:00Z");
  // 03:00 UTC Thu = 22:00 Wed in Chicago — outside 8–20.
  const wedNight = new Date("2026-08-27T03:00:00Z");
  // Sunday noon Chicago.
  const sunday = new Date("2026-08-23T17:00:00Z");

  it("passes inside the window, fails outside it, respects days", () => {
    expect(isWithinOrgHours(wedMorning, hours, "America/Chicago")).toBe(true);
    expect(isWithinOrgHours(wedNight, hours, "America/Chicago")).toBe(false);
    expect(isWithinOrgHours(sunday, hours, "America/Chicago")).toBe(false);
  });

  it("evaluates in the LEAD's timezone, not the server's", () => {
    // 15:00 UTC is 08:00 in Los Angeles (inside) but 03:00 next-day in Tokyo
    // would be outside — use New York (11:00, inside) vs Honolulu (05:00, out).
    expect(isWithinOrgHours(wedMorning, hours, "America/New_York")).toBe(true);
    expect(isWithinOrgHours(wedMorning, hours, "Pacific/Honolulu")).toBe(false);
  });

  it("degenerate configs never block dialing", () => {
    expect(isWithinOrgHours(wedNight, null, "America/Chicago")).toBe(true);
    expect(
      isWithinOrgHours(wedNight, { startHour: 8, endHour: 8, days: [] }, "America/Chicago"),
    ).toBe(true);
    expect(
      isWithinOrgHours(
        wedNight,
        { startHour: NaN, endHour: 20, days: [1] },
        "America/Chicago",
      ),
    ).toBe(true);
    // Empty day list = every day (a half-saved blob must not brick a floor).
    expect(
      isWithinOrgHours(wedMorning, { startHour: 8, endHour: 20, days: [] }, "America/Chicago"),
    ).toBe(true);
  });

  it("overnight windows wrap midnight", () => {
    const night = { startHour: 20, endHour: 6, days: [] };
    expect(isWithinOrgHours(wedNight, night, "America/Chicago")).toBe(true); // 22:00
    expect(isWithinOrgHours(wedMorning, night, "America/Chicago")).toBe(false); // 10:00
  });

  it("describes itself for error copy", () => {
    expect(describeOrgHours(hours)).toBe("Mon–Fri, 8am–8pm");
  });
});

describe("org accent color → token override", () => {
  it("converts hex to HSL triplets (3- and 6-digit, with/without #)", () => {
    expect(hexToHsl("#ff0000")).toEqual({ h: 0, s: 100, l: 50 });
    expect(hexToHsl("00f")).toEqual({ h: 240, s: 100, l: 50 });
    expect(hexToHsl("#808080")).toEqual({ h: 0, s: 0, l: 50 });
  });

  it("rejects junk instead of emitting broken CSS", () => {
    expect(hexToHsl("red")).toBeNull();
    expect(hexToHsl("")).toBeNull();
    expect(orgAccentCss("not-a-color")).toBe("");
    expect(orgAccentCss(null)).toBe("");
  });

  it("emits scoped light + dark rules", () => {
    const css = orgAccentCss("#0ea5e9");
    expect(css).toContain("[data-org-accent]{--accent:");
    expect(css).toContain(".dark [data-org-accent]{--accent:");
    expect(css).toContain("--accent-soft:");
  });
});

describe("dialer user prefs — profile preferences parsing", () => {
  it("defaults OFF and only accepts literal true", () => {
    expect(parseDialerUserPrefs(null)).toEqual(DEFAULT_DIALER_USER_PREFS);
    expect(parseDialerUserPrefs({})).toEqual(DEFAULT_DIALER_USER_PREFS);
    expect(
      parseDialerUserPrefs({ dialerPrefs: { autoDialNext: true, parallelDefault: "yes" } }),
    ).toEqual({ autoDialNext: true, parallelDefault: false });
  });
});

describe("vocabulary tagline — the org's own line wins", () => {
  it("uses the org tagline when set, the vertical's otherwise", () => {
    const withOwn = orgVocabulary({
      dialerTemplate: "general",
      productName: "VICC Dialer",
      tagline: "Close more, dial less",
    });
    expect(withOwn.tagline).toBe("Close more, dial less");

    const without = orgVocabulary({
      dialerTemplate: "general",
      productName: "VICC Dialer",
      tagline: "   ",
    });
    expect(without.tagline).not.toBe("   ");
    expect(without.tagline.length).toBeGreaterThan(0);
  });
});

describe("ElevenLabs voice override — allow-list gated like every override", () => {
  const allowAll: OverridePolicy = {
    prompt: true,
    firstMessage: true,
    language: true,
    ttsSpeed: true,
    ttsVoiceId: true,
  };

  it("sends tts.voice_id only when the agent allows it", () => {
    const sent = buildOverridePayload({ voiceId: "voice_abc", voiceSpeed: 0.9 }, allowAll);
    expect(sent.sent).toContain("tts.voice_id");
    expect(sent.override?.tts).toEqual({ speed: 0.9, voice_id: "voice_abc" });

    const denied = buildOverridePayload(
      { voiceId: "voice_abc", voiceSpeed: 0.9 },
      { ...allowAll, ttsVoiceId: false },
    );
    expect(denied.dropped).toContain("tts.voice_id");
    // Speed still rides — the two tts fields are independent.
    expect(denied.override?.tts).toEqual({ speed: 0.9 });
  });

  it("policy unknown ⇒ nothing is sent (fail closed)", () => {
    const built = buildOverridePayload({ voiceId: "voice_abc" }, null);
    expect(built.override).toBeNull();
    expect(built.mode).toBe("none:policy-unknown");
  });

  it("an empty/whitespace voice id is never an override", () => {
    const built = buildOverridePayload({ voiceId: "  " }, allowAll);
    expect(built.override).toBeNull();
  });
});

describe("settings.dialing.maxLines — the 10x default", () => {
  it("defaults to the platform ceiling, not the old value of 3", () => {
    // A fresh org, never having touched Admin -> Dialing, now gets real 10x
    // manual/parallel dialing SELECTABLE out of the box — matching how
    // ai.maxConcurrentCalls already defaults to its own ceiling. "Selectable"
    // is the operative word: this does not dial more lines on its own, it
    // only raises what a rep can choose to click up to.
    expect(DEFAULT_ORG_SETTINGS.dialing.maxLines).toBe(10);
    expect(mergeSettings({}).dialing.maxLines).toBe(10);
  });

  it("never silently overwrites an org's own saved choice", () => {
    // An org that explicitly configured 3 lines (or any other value) before
    // this change keeps exactly that — the new default only ever fills a gap
    // that was never actually set.
    expect(mergeSettings({ dialing: { maxLines: 3 } }).dialing.maxLines).toBe(3);
    expect(mergeSettings({ dialing: { maxLines: 1 } }).dialing.maxLines).toBe(1);
  });
});
