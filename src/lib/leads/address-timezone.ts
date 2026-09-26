import { normalizeState } from "./normalize";

// ─────────────────────────────────────────────────────────────────────────────
// Resolve a lead's timezone from their ADDRESS (state + ZIP) — not their phone.
//
// src/lib/dialer/lead-timezone.ts already infers a timezone from the phone
// number's NANP area code, for TCPA calling-window enforcement. That's the
// right signal for "is it legal to dial this number right now" (the FCC cares
// about the number's own area code history), but it is the WRONG signal for
// "where does this lead actually live" — numbers are portable, so a lead who
// moved from Chicago to Dallas keeps their 312 number. For a business whose
// product installs at a physical address, the address on file is the more
// trustworthy signal, and it's what powers timezone-based lead-pack sorting
// (grouping a big list into regional dialing shifts).
//
// Same approximation strategy as lead-timezone.ts, and deliberately so: full
// state coverage, corrected by a small, well-documented set of ZIP3 overrides
// for the states that visibly straddle a zone boundary. Anything finer (the
// Idaho panhandle, Kentucky/Indiana/Michigan's east-west splits, Arizona's
// Navajo Nation observing DST inside a state that doesn't) is a real exception
// this table does NOT model — same tradeoff the phone-based table already
// makes, made explicit so both stay honest about the same gap rather than one
// silently disagreeing with the other.
//
// A state we don't recognize (or no state at all — a foreign address, a blank
// field) returns null. Never a guess.
// ─────────────────────────────────────────────────────────────────────────────

/** Every US state/territory's PREDOMINANT IANA zone. */
const STATE_TIMEZONE: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix", // no DST — distinct from the rest of Mountain time
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DE: "America/New_York",
  DC: "America/New_York",
  FL: "America/New_York", // panhandle correction below
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Denver",
  IL: "America/Chicago",
  IN: "America/New_York",
  IA: "America/Chicago",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/New_York",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Chicago",
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Chicago",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago", // El Paso correction below
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
  PR: "America/Puerto_Rico",
  VI: "America/Puerto_Rico",
  GU: "Pacific/Guam",
  MP: "Pacific/Guam",
  AS: "Pacific/Pago_Pago",
};

/**
 * ZIP3 prefix → zone, checked BEFORE the state table. Two corrections, both
 * large enough (a whole metro, not one town) and well-documented enough that
 * getting them wrong would be a visible, embarrassing error rather than an
 * edge case — the same bar lead-timezone.ts applies to its own two exceptions
 * (TX 915, NE 308).
 */
const ZIP3_OVERRIDE: Record<string, string> = {
  // El Paso + Hudspeth County, TX — the one part of Texas on Mountain time.
  "798": "America/Denver",
  "799": "America/Denver",
  // FL panhandle west of the Apalachicola River (Pensacola, Fort Walton Beach,
  // Panama City) — Central time, unlike the rest of Florida. Tallahassee
  // (zip3 323) shares FL's 850 area code with this stretch but is Eastern, which
  // is exactly why the phone-based table can't separate them and the address
  // can: it's the one case where this module is MORE precise than the phone one.
  "324": "America/Chicago",
  "325": "America/Chicago",
};

/** Canonical east → west order, for grouping leads into regional dialing shifts. */
export const TIMEZONE_ORDER: readonly string[] = [
  "America/Puerto_Rico",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Pacific/Guam",
  "Pacific/Pago_Pago",
];

const ZONE_LABEL: Record<string, string> = {
  "America/Puerto_Rico": "Atlantic",
  "America/New_York": "Eastern",
  "America/Chicago": "Central",
  "America/Denver": "Mountain",
  "America/Phoenix": "Mountain (Arizona)",
  "America/Los_Angeles": "Pacific",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
  "Pacific/Guam": "Guam",
  "Pacific/Pago_Pago": "Samoa",
};

/** A short, human name for a zone ("Eastern", "Mountain (Arizona)"). Falls
 *  back to the bare IANA id for a zone outside this table, so a caller never
 *  renders "undefined" for a real-but-unlabeled zone. */
export function zoneLabel(tz: string): string {
  return ZONE_LABEL[tz] ?? tz;
}

/**
 * Best-effort IANA timezone for a US mailing address. ZIP3 overrides win when
 * present (they exist precisely because the state-level answer is wrong for
 * that stretch); otherwise the state's predominant zone. Returns null for a
 * state this table doesn't recognize — never a guess.
 */
export function timezoneForAddress(input: {
  state?: string | null;
  zip?: string | null;
}): string | null {
  const zip3 = String(input.zip ?? "")
    .replace(/\D/g, "")
    .slice(0, 3);
  if (zip3.length === 3 && ZIP3_OVERRIDE[zip3]) return ZIP3_OVERRIDE[zip3];

  const state = normalizeState(String(input.state ?? ""));
  return STATE_TIMEZONE[state] ?? null;
}
