import { NextResponse } from "next/server";
import { updateProfile } from "@/lib/db/team";
import { toNotifyPrefsPatch } from "@/lib/dialer/notify-prefs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { fullName, team, preferences } = (await req.json().catch(() => ({}))) as {
    fullName?: string;
    team?: string;
    preferences?: Record<string, unknown>;
  };

  // The `notify` node holds a phone number this app will TEXT and RING, so it
  // is normalized and validated server-side rather than trusted from the
  // client — a stored value that doesn't normalize is a number that will never
  // reach anyone, and the rep would have no way to tell.
  let prefs = preferences;
  if (prefs && "notify" in prefs) {
    const parsed = toNotifyPrefsPatch(
      (prefs.notify ?? {}) as Record<string, unknown>,
    );
    if (!parsed.ok) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    prefs = { ...prefs, notify: parsed.notify };
  }

  const r = await updateProfile({ fullName, team, preferences: prefs });
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
