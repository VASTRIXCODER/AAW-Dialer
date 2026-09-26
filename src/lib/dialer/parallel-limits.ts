// ─────────────────────────────────────────────────────────────────────────────
// Platform ceilings for simultaneous dial lines — pure constants, safe to
// import from a client hook, a server API route, or an admin form without
// dragging in React, Twilio, or "server-only" restrictions.
//
// These used to live ONLY in src/lib/use-dialer.ts (a client hook) and were
// separately hand-duplicated in the server route that actually places the
// legs (`SERVER_MAX_PARALLEL = 3` in api/twilio/call/route.ts) — two copies of
// one number, with nothing tying them together but a comment asking the next
// person to remember. Raising human parallel dialing from 3 to 10 and only
// updating one copy would have silently capped every rep's "10X" session at 3
// real Twilio legs while the UI said otherwise — exactly the kind of bug this
// file exists to make impossible.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A human rep can only usefully hold a handful of ringing lines before every
 * extra answered call has to be abandoned — see lib/dialer/abandonment.ts for
 * why that number has a hard legal ceiling (the FTC's 3% rule), not just a UX
 * one. 10 matches what established power-dialer products (Orum, Nooks,
 * Koncert) offer; going higher would mean this platform ceiling stops being
 * the binding constraint and abandonment-rate enforcement becomes the only
 * thing standing between a rep and a real compliance violation.
 */
export const MAX_PARALLEL_HUMAN = 10;
/** Platform ceiling for AI concurrency; the org's plan limit applies on top. */
export const MAX_PARALLEL_AI = 30;
