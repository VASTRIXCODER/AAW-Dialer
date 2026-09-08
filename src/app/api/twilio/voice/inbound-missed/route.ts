import { orgForDialedNumber } from "@/lib/db/inbound";

export const dynamic = "force-dynamic";

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function twiml(body: string) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`,
    { headers: { "Content-Type": "text/xml" } },
  );
}

/**
 * The rep's phone didn't pick up.
 *
 * Twilio POSTs here as the `action` of the inbound <Dial>, once that Dial
 * finishes for ANY reason. `DialCallStatus` says which:
 *
 *   completed → the rep answered and the call is over. Returning any TwiML at
 *               all here would keep the (now empty) call alive and play a
 *               voicemail prompt to nobody, so this MUST hang up.
 *   anything else (no-answer, busy, failed, canceled) → the caller is still on
 *               the line and nobody has spoken to them. Take a message.
 *
 * The callback row was already written when the call first arrived, so nothing
 * here is load-bearing for the rep seeing it — this only decides what the
 * person on the phone hears next.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const status = String(form.get("DialCallStatus") ?? "").trim();
    if (status === "completed" || status === "answered") {
      return twiml("<Hangup/>");
    }

    // Honour the org's own choice about recording a message.
    const to = new URL(req.url).searchParams.get("to") ?? "";
    const org = to ? await orgForDialedNumber(to).catch(() => null) : null;
    const record = org?.settings.dialing.inbound.recordVoicemail !== false;

    if (!record) {
      return twiml(
        `<Say voice="Polly.Joanna">Sorry we missed you. We'll call you right back.</Say><Hangup/>`,
      );
    }
    return twiml(
      `<Say voice="Polly.Joanna">${escapeXml(
        "Sorry we missed you. Please leave your name and number after the tone, and we'll call you right back.",
      )}</Say>` +
        `<Record maxLength="120" playBeep="true" timeout="5"/>` +
        `<Say voice="Polly.Joanna">Thanks. We'll be in touch.</Say><Hangup/>`,
    );
  } catch {
    // Never a 500 — Twilio reads that aloud as a generic application error.
    return twiml(
      `<Say voice="Polly.Joanna">Sorry we missed you. We'll call you right back.</Say><Hangup/>`,
    );
  }
}
