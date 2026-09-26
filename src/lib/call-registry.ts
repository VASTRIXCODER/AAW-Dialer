import "server-only";

// ─────────────────────────────────────────────────────────────────────────────
// Tracks in-flight parallel-dial conferences so the browser can learn which
// homeowner answered first (the winning leg) and the server can release the rest.
//
// This uses module-level state, which is correct for a single long-running
// server instance (e.g. `next start`, one container/VM). For horizontally
// scaled or serverless deployments, back this with a shared store (Redis or
// Twilio Sync) so every instance observes the same answer state.
// ─────────────────────────────────────────────────────────────────────────────

export interface CallLeg {
  leadId: string;
  to: string;
  sid: string | null;
}

interface RoomState {
  createdAt: number;
  answeredLeadId: string | null;
  legs: CallLeg[];
  /** The dialing org, so a round's outcome can be attributed for abandonment-
   *  rate tracking (src/lib/dialer/abandonment.ts) without a DB round-trip
   *  from the Twilio webhook that resolves it. */
  orgId: string | null;
}

const rooms = new Map<string, RoomState>();
const ROOM_TTL_MS = 10 * 60_000;

function sweep() {
  const now = Date.now();
  for (const [key, value] of rooms) {
    if (now - value.createdAt > ROOM_TTL_MS) rooms.delete(key);
  }
}

export function registerRoom(room: string, legs: CallLeg[], orgId: string | null = null) {
  sweep();
  rooms.set(room, { createdAt: Date.now(), answeredLeadId: null, legs, orgId });
}

/** Records the first answered leg. Returns true if this was the winning answer. */
export function markAnswered(room: string, leadId: string): boolean {
  const state = rooms.get(room);
  if (!state) return false;
  if (state.answeredLeadId) return false;
  state.answeredLeadId = leadId;
  return true;
}

export function getAnswered(room: string): string | null {
  return rooms.get(room)?.answeredLeadId ?? null;
}

/** Other legs that should be released once a winner answers. */
export function losingLegs(room: string, winnerLeadId: string): CallLeg[] {
  const state = rooms.get(room);
  if (!state) return [];
  return state.legs.filter((l) => l.leadId !== winnerLeadId && l.sid);
}

/** The org that placed this round's legs, and how many there were —
 *  everything abandonment-rate tracking needs about the round besides the
 *  live-answer count it discovers by fetching each leg's Twilio status. */
export function roomRoundInfo(room: string): { orgId: string | null; linesDialed: number } | null {
  const state = rooms.get(room);
  if (!state) return null;
  return { orgId: state.orgId, linesDialed: state.legs.filter((l) => l.sid).length };
}
