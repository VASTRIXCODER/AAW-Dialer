import "server-only";

import {
  ABANDONMENT_WINDOW_DAYS,
  abandonmentSeverity,
  safeParallelCeiling,
  type AbandonmentSeverity,
} from "../dialer/abandonment";
import { createAdminClient, isAdminConfigured } from "../supabase/admin";

// ─────────────────────────────────────────────────────────────────────────────
// The I/O half of abandonment-rate tracking — see lib/dialer/abandonment.ts
// for the pure math and WHY this exists (raising parallel dialing to 10x is
// the direct cause of more collisions; this is what keeps that safe).
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * Record one resolved parallel round. Fire-and-forget by design (mirrors
 * logLeadEvent) — this rides on the Twilio status webhook, which must return
 * fast and must never fail over a metrics write.
 */
export function recordParallelRound(input: {
  orgId: string | null;
  room: string;
  linesDialed: number;
  answeredCount: number;
}): void {
  if (!isAdminConfigured() || !input.orgId) return;
  void (async () => {
    try {
      await createAdminClient().from("dial_parallel_rounds").insert({
        org_id: input.orgId,
        room: input.room,
        lines_dialed: Math.max(1, Math.floor(input.linesDialed) || 1),
        answered_count: Math.max(1, Math.floor(input.answeredCount) || 1),
      });
    } catch {
      /* best-effort by contract — this rides on a Twilio webhook that must
         return fast and must never fail over a metrics write */
    }
  })();
}

export interface AbandonmentSnapshot {
  rate: number;
  answered: number;
  abandoned: number;
  severity: AbandonmentSeverity;
  windowDays: number;
}

const EMPTY_SNAPSHOT: AbandonmentSnapshot = {
  rate: 0,
  answered: 0,
  abandoned: 0,
  severity: "ok",
  windowDays: ABANDONMENT_WINDOW_DAYS,
};

/** The org's abandonment rate over the trailing FTC measurement window (30
 *  days), aggregated server-side (app_abandonment_snapshot) rather than
 *  fetched row-by-row — an org running near 10x lines for a month is exactly
 *  the one this needs to answer fast, and exactly the one a row-limited
 *  client-side fetch would silently under-count for. */
export async function getAbandonmentSnapshot(
  orgId: string | null,
): Promise<AbandonmentSnapshot> {
  if (!orgId || !isAdminConfigured()) return EMPTY_SNAPSHOT;
  try {
    const since = new Date(
      Date.now() - ABANDONMENT_WINDOW_DAYS * 86_400_000,
    ).toISOString();
    const { data, error } = await createAdminClient().rpc(
      "app_abandonment_snapshot",
      { p_org: orgId, p_since: since },
    );
    if (error || !data?.length) return EMPTY_SNAPSHOT;
    const row = data[0] as Row;
    const answered = Number(row.answered ?? 0);
    const abandoned = Number(row.abandoned ?? 0);
    const rate = answered > 0 ? abandoned / answered : 0;
    return {
      rate,
      answered,
      abandoned,
      severity: abandonmentSeverity(rate, answered),
      windowDays: ABANDONMENT_WINDOW_DAYS,
    };
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

/**
 * The parallel-line ceiling actually safe to offer THIS org right now, given
 * its own recent abandonment rate — not just the number in Admin. Call this
 * anywhere a real dialing ceiling is resolved (the manual call route, the
 * client config the dialer boots from) so a bad rate throttles the org
 * automatically instead of sitting in a panel nobody's watching until a
 * complaint arrives.
 */
export async function enforcedParallelCeiling(input: {
  orgId: string | null;
  orgConfiguredCeiling: number;
}): Promise<number> {
  const snap = await getAbandonmentSnapshot(input.orgId);
  return safeParallelCeiling({
    orgConfiguredCeiling: input.orgConfiguredCeiling,
    rate: snap.rate,
    sampleSize: snap.answered,
  });
}
