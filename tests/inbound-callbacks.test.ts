import { describe, expect, it } from "vitest";
import {
  chooseInboundRoute,
  classifyIncomingCall,
  clampForwardTimeout,
  INBOUND_REASON_FORWARDED,
  INBOUND_REASON_MESSAGE,
  inboundNotificationText,
  isInboundCallback,
  isOurNumber,
  normalizeForward,
  renderGreeting,
} from "@/lib/inbound/routing";
import { mergeSettings } from "@/lib/org/settings";
import {
  normalizeNotifyPhone,
  parseNotifyPrefs,
  toNotifyPrefsPatch,
} from "@/lib/dialer/notify-prefs";

// ─────────────────────────────────────────────────────────────────────────────
// Every number in the caller-ID pool used to be write-only. A homeowner who
// rang one back hit the voice webhook's "Direct dialing through this line is
// disabled" branch and was hung up on — the warmest inbound signal this product
// can receive, dropped with no trace anywhere.
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE = "+15551234567";

describe("classifyIncomingCall", () => {
  const call = (o: Partial<Parameters<typeof classifyIncomingCall>[0]>) =>
    classifyIncomingCall({ from: "", to: "", bridgeNumber: BRIDGE, ...o });

  it("recognises a homeowner calling one of our numbers back", () => {
    expect(call({ from: "+14155550100", to: "+18175082598" })).toBe("inbound_callback");
  });

  it("does NOT mistake a rep's browser leg for a returning caller", () => {
    // The trap: Twilio marks a call placed FROM the browser SDK as
    // Direction=inbound too, so Direction can't separate these. The `client:`
    // prefix on From is what actually does.
    expect(call({ from: "client:rep_abc", to: "+14155550100" })).toBe("browser_direct");
  });

  it("keeps the rep conference leg ahead of everything", () => {
    expect(call({ from: "client:rep_abc", conference: "room_1" })).toBe("conference");
  });

  it("keeps supervisor monitoring distinct from a plain conference join", () => {
    expect(call({ from: "client:sup", conference: "room_1", monitor: true })).toBe("monitor");
  });

  it("routes the AI bridge leg as a bridge, not as a callback", () => {
    // It arrives looking EXACTLY like an inbound call. Answering it as one would
    // put a homeowner greeting in front of the AI agent instead of bridging it.
    expect(call({ from: "+13105550111", to: BRIDGE })).toBe("ai_bridge");
  });

  it("matches the bridge number regardless of formatting", () => {
    expect(call({ from: "+13105550111", to: "(555) 123-4567" })).toBe("ai_bridge");
  });

  it("is unknown when there is nothing to go on", () => {
    expect(call({ from: "", to: "" })).toBe("unknown");
  });

  it("does not treat a short code as a returning caller", () => {
    expect(call({ from: "40404", to: "+18175082598" })).toBe("unknown");
  });
});

describe("isOurNumber", () => {
  const pool = ["+18175082598", "+13466592684"];
  it("matches a pool number in any format", () => {
    expect(isOurNumber("(817) 508-2598", pool)).toBe(true);
    expect(isOurNumber("8175082598", pool)).toBe(true);
  });
  it("rejects a number we don't own", () => {
    expect(isOurNumber("+14155550100", pool)).toBe(false);
  });
  it("is false for an empty pool", () => {
    expect(isOurNumber("+18175082598", [])).toBe(false);
  });
});

describe("chooseInboundRoute", () => {
  const rep = { repPhone: "+18175559999", repForwardOptIn: true };

  it("rings the rep when the org forwards and the rep opted in", () => {
    const r = chooseInboundRoute({ mode: "forward", ...rep });
    expect(r).toMatchObject({ kind: "forward", to: "+18175559999", via: "rep" });
  });

  it("does NOT ring a rep who only asked for texts", () => {
    // Double opt-in: a rep who wants a heads-up has not agreed to have their
    // personal mobile ring. Without the second consent the call still gets
    // answered — it just takes a message.
    const r = chooseInboundRoute({
      mode: "forward",
      repPhone: "+18175559999",
      repForwardOptIn: false,
    });
    expect(r).toEqual({ kind: "voicemail", reason: "no_number" });
  });

  it("falls back to the org number when no rep matched", () => {
    const r = chooseInboundRoute({ mode: "forward", fallbackNumber: "+13465550000" });
    expect(r).toMatchObject({ kind: "forward", to: "+13465550000", via: "fallback" });
  });

  it("prefers the rep over the org fallback", () => {
    const r = chooseInboundRoute({ mode: "forward", ...rep, fallbackNumber: "+13465550000" });
    expect(r).toMatchObject({ to: "+18175559999", via: "rep" });
  });

  it("takes a message rather than ringing out with nowhere to go", () => {
    expect(chooseInboundRoute({ mode: "forward" })).toEqual({
      kind: "voicemail",
      reason: "no_number",
    });
  });

  it("honours the explicit voicemail and ai modes", () => {
    expect(chooseInboundRoute({ mode: "voicemail", ...rep })).toEqual({
      kind: "voicemail",
      reason: "configured",
    });
    expect(chooseInboundRoute({ mode: "ai", ...rep })).toEqual({ kind: "ai" });
  });

  it("rejects when inbound handling is off", () => {
    expect(chooseInboundRoute({ mode: "off", ...rep })).toEqual({ kind: "reject" });
  });

  it("clamps the forward timeout into Twilio's accepted range", () => {
    expect(clampForwardTimeout(0)).toBe(25);
    expect(clampForwardTimeout(2)).toBe(5);
    expect(clampForwardTimeout(999)).toBe(60);
    expect(clampForwardTimeout(30)).toBe(30);
    expect(clampForwardTimeout("nonsense")).toBe(25);
  });
});

describe("normalizeForward", () => {
  it("accepts the shapes a person actually types", () => {
    expect(normalizeForward("8175082598")).toBe("+18175082598");
    expect(normalizeForward("(817) 508-2598")).toBe("+18175082598");
    expect(normalizeForward("1-817-508-2598")).toBe("+18175082598");
    expect(normalizeForward("+18175082598")).toBe("+18175082598");
  });
  it("refuses what could never ring", () => {
    expect(normalizeForward("")).toBe("");
    expect(normalizeForward("911")).toBe("");
    expect(normalizeForward(null)).toBe("");
    expect(normalizeForward("not a phone")).toBe("");
  });
});

describe("inboundNotificationText", () => {
  it("names the caller and says the call is live", () => {
    const t = inboundNotificationText({
      callerName: "Maria Gomez",
      callerPhone: "+14155550100",
      orgName: "VICC",
      forwarded: true,
    });
    expect(t).toContain("Maria Gomez");
    expect(t).toContain("(415) 555-0100");
    expect(t).toContain("VICC");
    expect(t).toContain("right now");
  });

  it("still works for a caller we don't recognise", () => {
    const t = inboundNotificationText({ callerPhone: "+14155550100", forwarded: false });
    expect(t).toContain("(415) 555-0100");
    expect(t).not.toContain("undefined");
    expect(t).not.toContain("null");
  });

  it("carries nothing sensitive — this lands on a lock screen", () => {
    const t = inboundNotificationText({
      callerName: "Maria Gomez",
      callerPhone: "+14155550100",
      orgName: "VICC",
      forwarded: false,
    });
    expect(t.length).toBeLessThan(160);
  });
});

describe("renderGreeting", () => {
  it("interpolates the org name", () => {
    expect(renderGreeting("Thanks for calling {org}.", "VICC")).toBe("Thanks for calling VICC.");
  });
  it("falls back to something sayable when unset", () => {
    expect(renderGreeting("", "VICC")).toContain("VICC");
    expect(renderGreeting(null, null)).toContain("calling");
  });
  it("never leaves a raw placeholder in what gets spoken", () => {
    expect(renderGreeting("Hi from {org}!", null)).not.toContain("{org}");
  });
});

describe("isInboundCallback — how the board recognises its own rows", () => {
  it("recognises both reasons the webhook writes", () => {
    expect(isInboundCallback(INBOUND_REASON_FORWARDED)).toBe(true);
    expect(isInboundCallback(INBOUND_REASON_MESSAGE)).toBe(true);
  });
  it("leaves a rep-scheduled callback alone", () => {
    expect(isInboundCallback("Asked for a call Tuesday")).toBe(false);
    expect(isInboundCallback("")).toBe(false);
    expect(isInboundCallback(null)).toBe(false);
  });
});

describe("org settings — the inbound node survives a merge", () => {
  it("defaults to off, so no org starts answering by surprise", () => {
    const s = mergeSettings({});
    expect(s.dialing.inbound.mode).toBe("off");
  });

  it("fills in every key when an org saved only one of them", () => {
    // The bug this guards: the outer `...s.dialing` spread replaces the nested
    // object wholesale, so an org saved with just { mode } would come back
    // missing forwardTimeoutSec and read as a 0-second ring.
    const s = mergeSettings({ dialing: { inbound: { mode: "forward" } } });
    expect(s.dialing.inbound.mode).toBe("forward");
    expect(s.dialing.inbound.forwardTimeoutSec).toBe(25);
    expect(s.dialing.inbound.notifyRep).toBe(true);
    expect(s.dialing.inbound.recordVoicemail).toBe(true);
  });

  it("clamps a stored timeout Twilio would refuse", () => {
    expect(
      mergeSettings({ dialing: { inbound: { forwardTimeoutSec: 900 } } }).dialing.inbound
        .forwardTimeoutSec,
    ).toBe(60);
  });

  it("falls back to off for a mode that isn't one of ours", () => {
    expect(
      mergeSettings({ dialing: { inbound: { mode: "banana" } } }).dialing.inbound.mode,
    ).toBe("off");
  });

  it("keeps what an org actually saved", () => {
    const s = mergeSettings({
      dialing: {
        inbound: {
          mode: "voicemail",
          notifyRep: false,
          greeting: "Hi from {org}",
          fallbackNumber: "+18175550100",
        },
      },
    });
    expect(s.dialing.inbound).toMatchObject({
      mode: "voicemail",
      notifyRep: false,
      greeting: "Hi from {org}",
      fallbackNumber: "+18175550100",
    });
  });
});

describe("notify prefs", () => {
  it("normalizes what a rep types", () => {
    expect(normalizeNotifyPhone("(817) 555-9999")).toBe("+18175559999");
    expect(normalizeNotifyPhone("nope")).toBe("");
  });

  it("reads a saved profile", () => {
    expect(
      parseNotifyPrefs({ notify: { phone: "8175559999", smsOnCallback: true } }),
    ).toEqual({ phone: "+18175559999", smsOnCallback: true, forwardCallback: false });
  });

  it("treats a toggle with no number as off", () => {
    // A promise nothing can keep. Reads as off until a usable number is saved.
    expect(
      parseNotifyPrefs({ notify: { phone: "", smsOnCallback: true, forwardCallback: true } }),
    ).toEqual({ phone: "", smsOnCallback: false, forwardCallback: false });
  });

  it("defaults to fully off for a profile that has never set it", () => {
    expect(parseNotifyPrefs(null)).toEqual({
      phone: "",
      smsOnCallback: false,
      forwardCallback: false,
    });
    expect(parseNotifyPrefs({})).toEqual({
      phone: "",
      smsOnCallback: false,
      forwardCallback: false,
    });
  });

  it("rejects a number that could never be reached, rather than storing it", () => {
    const r = toNotifyPrefsPatch({ phone: "12", smsOnCallback: true });
    expect(r.ok).toBe(false);
  });

  it("lets a rep clear their number and turns both consents off with it", () => {
    const r = toNotifyPrefsPatch({ phone: "", smsOnCallback: true, forwardCallback: true });
    expect(r).toEqual({
      ok: true,
      notify: { phone: "", smsOnCallback: false, forwardCallback: false },
    });
  });

  it("stores both consents when a real number is given", () => {
    const r = toNotifyPrefsPatch({
      phone: "817-555-9999",
      smsOnCallback: true,
      forwardCallback: true,
    });
    expect(r).toEqual({
      ok: true,
      notify: { phone: "+18175559999", smsOnCallback: true, forwardCallback: true },
    });
  });
});
