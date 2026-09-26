import { NextResponse } from "next/server";
import { getAbandonmentSnapshot } from "@/lib/db/abandonment";
import {
  ABANDONMENT_LEGAL_LIMIT,
  ABANDONMENT_WARN_THRESHOLD,
  MIN_SAMPLE_FOR_ENFORCEMENT,
} from "@/lib/dialer/abandonment";
import { getViewer } from "@/lib/org/membership";

export const dynamic = "force-dynamic";

/**
 * The org's own abandonment-rate readout — Admin → Dialing's answer to
 * "why is my max lines lower than what I set, and how close am I to that
 * happening." See lib/dialer/abandonment.ts for the FTC rule this exists for,
 * and lib/db/abandonment.ts for the write side (the Twilio status webhook).
 *
 * Deliberately self-fetching from a small client widget rather than threaded
 * through the whole Admin page → OrgSettingsForm prop chain — same shape as
 * /api/elevenlabs/caller-id-audit, and for the same reason: it keeps a
 * narrow, independently-testable admin surface from having to touch a large
 * existing form's prop contract.
 */
export async function GET() {
  const viewer = await getViewer();
  if (!viewer || !viewer.permissions.includes("admin.access")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const orgId = viewer.org?.id ?? null;
  const snapshot = await getAbandonmentSnapshot(orgId);

  return NextResponse.json({
    ...snapshot,
    legalLimit: ABANDONMENT_LEGAL_LIMIT,
    warnThreshold: ABANDONMENT_WARN_THRESHOLD,
    minSampleForEnforcement: MIN_SAMPLE_FOR_ENFORCEMENT,
    enforcing: snapshot.answered >= MIN_SAMPLE_FOR_ENFORCEMENT,
  });
}
