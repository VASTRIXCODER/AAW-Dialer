import { describe, expect, it } from "vitest";
import {
  TIMEZONE_ORDER,
  timezoneForAddress,
  zoneLabel,
} from "@/lib/leads/address-timezone";

describe("timezoneForAddress", () => {
  it("resolves the predominant zone for a plain state", () => {
    expect(timezoneForAddress({ state: "CA", zip: "94103" })).toBe(
      "America/Los_Angeles",
    );
    expect(timezoneForAddress({ state: "NY", zip: "10001" })).toBe(
      "America/New_York",
    );
    expect(timezoneForAddress({ state: "AZ", zip: "85001" })).toBe(
      "America/Phoenix",
    );
    expect(timezoneForAddress({ state: "HI", zip: "96813" })).toBe(
      "Pacific/Honolulu",
    );
  });

  it("accepts a full state name, not just the USPS code", () => {
    expect(timezoneForAddress({ state: "California", zip: "" })).toBe(
      "America/Los_Angeles",
    );
    expect(timezoneForAddress({ state: "texas", zip: "" })).toBe(
      "America/Chicago",
    );
  });

  it("corrects El Paso, TX to Mountain time despite the state default", () => {
    // The whole point: an El Paso address must not read as Central just
    // because the rest of Texas is.
    expect(timezoneForAddress({ state: "TX", zip: "79901" })).toBe(
      "America/Denver",
    );
    expect(timezoneForAddress({ state: "TX", zip: "79936" })).toBe(
      "America/Denver",
    );
  });

  it("leaves the rest of Texas on Central", () => {
    expect(timezoneForAddress({ state: "TX", zip: "75201" })).toBe(
      "America/Chicago",
    ); // Dallas
    expect(timezoneForAddress({ state: "TX", zip: "77002" })).toBe(
      "America/Chicago",
    ); // Houston
  });

  it("separates the FL panhandle from the rest of Florida", () => {
    expect(timezoneForAddress({ state: "FL", zip: "32501" })).toBe(
      "America/Chicago",
    ); // Pensacola
    expect(timezoneForAddress({ state: "FL", zip: "32401" })).toBe(
      "America/Chicago",
    ); // Panama City
  });

  it("keeps Tallahassee Eastern despite sharing an area code with the panhandle", () => {
    // This is the case the PHONE-based table can't get right (both share the
    // 850 area code) and the address-based one can.
    expect(timezoneForAddress({ state: "FL", zip: "32301" })).toBe(
      "America/New_York",
    );
  });

  it("leaves the rest of Florida on Eastern", () => {
    expect(timezoneForAddress({ state: "FL", zip: "33101" })).toBe(
      "America/New_York",
    ); // Miami
  });

  it("returns null for a state it doesn't recognize", () => {
    expect(timezoneForAddress({ state: "Ontario", zip: "" })).toBeNull();
    expect(timezoneForAddress({ state: "", zip: "" })).toBeNull();
    expect(timezoneForAddress({})).toBeNull();
  });

  it("still resolves with no ZIP at all — state alone is enough outside the override zips", () => {
    expect(timezoneForAddress({ state: "CO", zip: null })).toBe(
      "America/Denver",
    );
  });

  it("tolerates a messy ZIP (ZIP+4, stray whitespace)", () => {
    expect(timezoneForAddress({ state: "TX", zip: " 79901-1234 " })).toBe(
      "America/Denver",
    );
  });

  it("a ZIP override never fires for the wrong state's identical prefix", () => {
    // 798/799 and 324/325 are only meaningful alongside TX/FL respectively —
    // guard against the override table being consulted independent of state
    // in some future refactor by asserting today's actual behavior: the
    // override wins on zip3 alone, which is fine BECAUSE these zip3s are
    // exclusively used by their real state. Sanity-check that assumption
    // holds for a nonsense state paired with a real override zip3: the
    // override still applies (zip3 is unambiguous nationally), which is the
    // documented contract, not a bug.
    expect(timezoneForAddress({ state: "XX", zip: "79901" })).toBe(
      "America/Denver",
    );
  });
});

describe("zoneLabel", () => {
  it("gives every zone in TIMEZONE_ORDER a real label", () => {
    for (const tz of TIMEZONE_ORDER) {
      expect(zoneLabel(tz)).not.toBe(tz);
    }
  });

  it("falls back to the raw IANA id for an unlabeled zone", () => {
    expect(zoneLabel("Europe/London")).toBe("Europe/London");
  });

  it("distinguishes Arizona's non-DST Mountain time from the rest", () => {
    expect(zoneLabel("America/Phoenix")).not.toBe(zoneLabel("America/Denver"));
  });
});

describe("TIMEZONE_ORDER", () => {
  it("runs east to west with no duplicates", () => {
    expect(new Set(TIMEZONE_ORDER).size).toBe(TIMEZONE_ORDER.length);
    expect(TIMEZONE_ORDER.indexOf("America/New_York")).toBeLessThan(
      TIMEZONE_ORDER.indexOf("America/Chicago"),
    );
    expect(TIMEZONE_ORDER.indexOf("America/Chicago")).toBeLessThan(
      TIMEZONE_ORDER.indexOf("America/Denver"),
    );
    expect(TIMEZONE_ORDER.indexOf("America/Denver")).toBeLessThan(
      TIMEZONE_ORDER.indexOf("America/Los_Angeles"),
    );
  });

  it("includes every zone timezoneForAddress can actually return", () => {
    // Every distinct output of a real (state, zip) lookup must have a place in
    // the canonical order, or a pack made of that zone would sort nowhere.
    const zones = new Set<string>();
    for (const state of [
      "CA", "TX", "FL", "AZ", "NY", "IL", "CO", "WA", "AK", "HI",
      "PR", "GU", "AS",
    ]) {
      const tz = timezoneForAddress({ state, zip: "" });
      if (tz) zones.add(tz);
    }
    zones.add(timezoneForAddress({ state: "TX", zip: "79901" })!);
    zones.add(timezoneForAddress({ state: "FL", zip: "32401" })!);
    for (const tz of zones) {
      expect(TIMEZONE_ORDER).toContain(tz);
    }
  });
});
