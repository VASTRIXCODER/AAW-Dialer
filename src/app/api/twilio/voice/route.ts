import {
  notifyRepOfInboundCall,
  recordInboundCallback,
  resolveInboundContext,
} from "@/lib/db/inbound";
import { elevenLabsConfig } from "@/lib/elevenlabs";
import {
  chooseInboundRoute,
  classifyIncomingCall,
  INBOUND_REASON_FORWARDED,
  INBOUND_REASON_MESSAGE,
  renderGreeting,
} from "@/lib/inbound/routing";
import {
  getPublicBaseUrl,
  getRestClient,
  isCallerIdConfigured,
  twilioConfig,
  verifyMonitorToken,
} from "@/lib/twilio";

const digits = (s: string) => s.replace(/\D/g, "");

export const dynamic = "force-dynamic";

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** Wrap a TwiML body in a well-formed document with the right content type. */
function twiml(body: string) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`,
    { headers: { "Content-Type": "text/xml" } },
  );
}

/** A spoken message + hang up — used for graceful failures (never a 500). */
function say(message: string) {
  return twiml(`<Say voice="Polly.Joanna">${escapeXml(message)}</Say><Hangup/>`);
}

/**
 * A homeowner rang one of the org's dialing numbers back.
 *
 * Three things happen, in this order and for this reason:
 *   1. The call is FILED on the Callbacks board, before anything else. Whatever
 *      the caller does next — hangs up during the greeting, rings out, leaves a
 *      message — the rep has a row saying they called. That row is the product;
 *      the connection attempt is a bonus.
 *   2. The rep is TEXTED, detached. An SMS round-trip must never sit between a
 *      caller and the TwiML they are waiting on, so this is deliberately not
 *      awaited.
 *   3. The caller is ROUTED per the org's mode — rung through to the rep,
 *      handed a voicemail box, or given to the AI agent.
 *
 * It must always return valid TwiML: every failure path here degrades to a
 * spoken message, never a 500 (which Twilio reads aloud as a generic error).
 */
async function handleInboundCallback(opts: {
  from: string;
  to: string;
  callSid: string;
  req: Request;
}): Promise<Response> {
  const { from, to, callSid, req } = opts;
  let ctx: Awaited<ReturnType<typeof resolveInboundContext>>;
  try {
    ctx = await resolveInboundContext({ from, to });
  } catch {
    return say("Thanks for calling. Please try us again shortly.");
  }

  const inbound = ctx.settings?.dialing.inbound;
  // No org owns this number, or the org has left inbound off: say something
  // human and hang up. Never the old "direct dialing is disabled" — that was
  // written for a rep's console, not a homeowner returning a call.
  if (!ctx.settings || !inbound || inbound.mode === "off") {
    return say("Thanks for calling. Please try us again during business hours.");
  }

  const route = chooseInboundRoute({
    mode: inbound.mode,
    repPhone: ctx.repNotify.phone || null,
    repForwardOptIn: ctx.repNotify.forwardCallback,
    fallbackNumber: inbound.fallbackNumber,
    timeoutSec: inbound.forwardTimeoutSec,
  });

  // (1) File it. Awaited — this is the deliverable.
  await recordInboundCallback({
    orgId: ctx.orgId,
    ownerId: ctx.repId,
    leadId: ctx.leadId,
    leadName: ctx.leadName,
    phone: from,
    reason:
      route.kind === "forward" ? INBOUND_REASON_FORWARDED : INBOUND_REASON_MESSAGE,
  }).catch(() => null);

  // (2) Text the rep. Detached on purpose (see the doc comment).
  if (inbound.notifyRep && ctx.repNotify.smsOnCallback && ctx.repNotify.phone) {
    void notifyRepOfInboundCall({
      repPhone: ctx.repNotify.phone,
      // From the number they DIALED, so the rep sees a consistent sender and a
      // reply reaches a number the org actually owns.
      fromNumber: to,
      callerName: ctx.leadName,
      callerPhone: from,
      orgName: ctx.orgName,
      forwarded: route.kind === "forward",
    }).catch(() => {});
  }

  // (3) Route the caller.
  const greeting = escapeXml(renderGreeting(inbound.greeting, ctx.orgName));
  const base = getPublicBaseUrl(req);

  if (route.kind === "reject") {
    return say("Thanks for calling. Please try us again during business hours.");
  }

  if (route.kind === "ai") {
    // The ElevenLabs agent owns an inbound number by taking over its Twilio
    // webhook, which would mean this route never runs and none of the above
    // would happen. So "ai" is deliberately NOT a silent no-op that drops the
    // caller: it answers, files, notifies, and takes a message, and the admin
    // copy says to point the number at ElevenLabs to have the agent answer.
    return twiml(
      `<Say voice="Polly.Joanna">${greeting}</Say>` + voicemailTwiml(inbound, base, callSid),
    );
  }

  if (route.kind === "forward") {
    const action = base
      ? ` action="${escapeXml(`${base}/api/twilio/voice/inbound-missed?to=${encodeURIComponent(to)}`)}" method="POST"`
      : "";
    return twiml(
      `<Say voice="Polly.Joanna">${greeting}</Say>` +
        // callerId is OUR number, not the homeowner's: the rep's phone must show
        // a number they recognise, and forwarding someone else's caller ID is
        // both confusing and, on many carriers, refused outright.
        `<Dial timeout="${route.timeoutSec}" callerId="${escapeXml(to)}"${action}>` +
        `<Number>${escapeXml(route.to)}</Number>` +
        `</Dial>`,
    );
  }

  return twiml(
    `<Say voice="Polly.Joanna">${greeting}</Say>` + voicemailTwiml(inbound, base, callSid),
  );
}

/** Take a message. Shared by the voicemail mode and every fallthrough. */
function voicemailTwiml(
  inbound: { recordVoicemail: boolean },
  base: string | null,
  callSid: string,
): string {
  const prompt =
    "Please leave your name and number after the tone, and we'll call you right back.";
  if (!inbound.recordVoicemail) {
    return `<Say voice="Polly.Joanna">Sorry we missed you. We'll call you right back.</Say><Hangup/>`;
  }
  const cb =
    base && callSid
      ? ` recordingStatusCallback="${escapeXml(`${base}/api/twilio/status?inbound=1&callSid=${encodeURIComponent(callSid)}`)}"`
      : "";
  return (
    `<Say voice="Polly.Joanna">${prompt}</Say>` +
    `<Record maxLength="120" playBeep="true" timeout="5"${cb}/>` +
    `<Say voice="Polly.Joanna">Thanks. We'll be in touch.</Say><Hangup/>`
  );
}

/**
 * TwiML endpoint invoked by the Voice SDK / TwiML App when the browser places a
 * call. Modes:
 *
 *  • `Conference` + `Monitor` → supervisor live-listen: join the rep's conference
 *                         MUTED (hears everyone, heard by no one). Gated by a
 *                         signed token from /api/twilio/listen.
 *  • `Conference` present → rep call (single/parallel), supervisor take-over, or
 *                         parallel winner: join the conference room where the
 *                         homeowner is bridged. `record` records the conference.
 *  • `To` present       → legacy single PSTN dial: bridge to the homeowner using
 *                         the configured caller ID (+ recording).
 *
 * It must ALWAYS return valid TwiML with HTTP 200 — any non-200 or malformed
 * response makes Twilio play the generic "an application error has occurred" to
 * the caller. So every failure path returns a clear spoken message instead.
 *
 * Point your TwiML App's Voice Request URL at: {NEXT_PUBLIC_APP_URL}/api/twilio/voice
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const to = String(form.get("To") ?? "").trim();
    const from = String(form.get("From") ?? "").trim();
    const callSid = String(form.get("CallSid") ?? "").trim();
    const conference = String(form.get("Conference") ?? "").trim();
    const monitor = String(form.get("Monitor") ?? "") === "true";
    const monitorToken = String(form.get("Token") ?? "");
    const record = String(form.get("record") ?? "false") === "true";

    const bridge = elevenLabsConfig.bridgeNumber.trim();
    const kind = classifyIncomingCall({ from, to, conference, monitor, bridgeNumber: bridge });

    // ── AI bridge: the ElevenLabs agent dialed our bridge number. Hold the leg
    // briefly; /api/elevenlabs/call moves it into the conference room by REST. ──
    if (kind === "ai_bridge") {
      return twiml(`<Pause length="30"/>`);
    }

    // ── Someone rang one of our dialing numbers BACK ──────────────────────────
    // Every pool number used to be write-only: this landed in the disabled
    // direct-dial branch below and the caller was hung up on. Now it is
    // answered, filed on the Callbacks board, and the rep who owns the lead
    // gets a text on their personal phone.
    if (kind === "inbound_callback") {
      return handleInboundCallback({ from, to, callSid, req });
    }

    // ── Supervisor live-listen: join MUTED, silently (no relay needed) ────────
    // Only a token signed by the authorized listen route gets in — this is what
    // keeps silent eavesdropping locked to permitted supervisors.
    if (conference && monitor) {
      if (!verifyMonitorToken(conference, monitorToken)) {
        return say("You're not authorized to listen to this call.");
      }
      const room = escapeXml(conference);
      return twiml(
        `<Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="false" muted="true" beep="false">${room}</Conference></Dial>`,
      );
    }

    // ── Conference: rep call (single/parallel), or supervisor take-over ───────
    if (conference) {
      const room = escapeXml(conference);
      // Record the whole conference from the rep's leg (exactly one per room).
      // Pass the room back on the recording callback so /api/twilio/status can
      // link the finished recording to this call record — a conference recording
      // webhook carries the ConferenceSid, never the rep's CallSid.
      const base = getPublicBaseUrl(req);
      const recordingCb = base
        ? `${base}/api/twilio/status?room=${encodeURIComponent(conference)}`
        : "";
      const recordAttr = record
        ? recordingCb
          ? ` record="record-from-start" recordingStatusCallback="${escapeXml(recordingCb)}"`
          : ' record="record-from-start"'
        : "";
      // No waitUrl override → Twilio plays its standard hold music to the rep
      // while the homeowner's line rings. The music stops automatically the
      // instant the homeowner joins the conference (two participants = active),
      // so it never interferes with the two-way audio bridge.
      return twiml(
        `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false"${recordAttr}>${room}</Conference></Dial>`,
      );
    }

    // ── Direct `To` PSTN dial: REMOVED, deliberately ──────────────────────────
    // This legacy branch bridged straight to any number the browser passed in
    // `device.connect({ params: { To } })`. No app code has used it since the
    // conference flow (/api/twilio/call) became the only dial path — but the
    // branch itself still answered, and it sat OUTSIDE every server-side
    // policy gate: no DNC scrub, no enforced calling hours, no max-attempts,
    // no org feature check. Any signed-in user with a Voice token could ring
    // any number from the org's caller ID by typing one line in the console —
    // exactly the calls the admin was told were now impossible. Every real
    // dial goes through /api/twilio/call, where the policy gates live.
    if (to) {
      return say(
        "Direct dialing through this line is disabled. Please use the dialer.",
      );
    }

    return say("No destination was provided for this call.");
  } catch {
    // Never surface a 500 to Twilio — that becomes the generic spoken error.
    return say("We're sorry, something went wrong setting up this call.");
  }
}

/**
 * Browser-openable diagnostic (Twilio uses POST, so this never runs for real
 * calls). Visit this URL to confirm the webhook is reachable and to copy the
 * EXACT value your TwiML App's Voice Request URL must hold.
 *
 * It also READS BACK what the TwiML App is actually pointed at, because a
 * stale/wrong URL there is the single most common cause of "I press Start, the
 * homeowner's phone rings, and then I'm dumped back to the Start screen": the
 * homeowner leg is placed by REST with inline TwiML and rings perfectly well,
 * while the REP's leg — the only one that goes through the TwiML App — dies on
 * an application error the instant it's created. Reporting the configured URL
 * next to the expected one turns that from a guess into a two-second check.
 */
export async function GET(req: Request) {
  const base = getPublicBaseUrl(req);
  const expected = base ? `${base}/api/twilio/voice` : null;

  // Read the TwiML App's live configuration. Best-effort: no REST creds, no app
  // SID, or a Twilio hiccup all degrade to "couldn't check" rather than failing.
  let twimlApp: {
    checked: boolean;
    voiceUrl: string | null;
    voiceMethod: string | null;
    matches: boolean | null;
    note: string;
  } = {
    checked: false,
    voiceUrl: null,
    voiceMethod: null,
    matches: null,
    note: "Couldn't read the TwiML App — check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_TWIML_APP_SID.",
  };

  const appSid = twilioConfig.twimlAppSid.trim();
  const client = appSid ? await getRestClient() : null;
  if (client && appSid) {
    try {
      const app = await client.applications(appSid).fetch();
      const configured = (app.voiceUrl ?? "").trim();
      const method = (app.voiceMethod ?? "").trim().toUpperCase();
      // Compare ignoring a trailing slash — Twilio stores it either way.
      const norm = (u: string) => u.replace(/\/+$/, "");
      const matches = Boolean(expected) && norm(configured) === norm(expected ?? "");
      twimlApp = {
        checked: true,
        voiceUrl: configured || null,
        voiceMethod: method || null,
        matches,
        note: !configured
          ? "Your TwiML App has NO Voice Request URL. The rep's browser leg cannot connect — set it to voiceUrl below (POST)."
          : matches
            ? method && method !== "POST"
              ? `Voice URL is correct but the method is ${method}. Twilio must POST — change it.`
              : "TwiML App Voice URL matches this app. The rep's browser leg has somewhere valid to land."
            : `TwiML App Voice URL points at ${configured}, NOT at this app. That is why the rep's side of the call fails while the homeowner still rings — set it to voiceUrl below (POST).`,
      };
    } catch (err) {
      twimlApp.note = `Couldn't read TwiML App ${appSid.slice(0, 6)}…: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  } else if (!appSid) {
    twimlApp.note =
      "No TWILIO_TWIML_APP_SID is set — the browser can't register a Voice device at all.";
  }

  return Response.json({
    ok: true,
    message:
      "Twilio Voice webhook is reachable. Set your TwiML App → Voice → Request URL to the voiceUrl below, with HTTP method POST.",
    voiceUrl: expected,
    method: "POST",
    twimlApp,
    callerIdConfigured: isCallerIdConfigured(),
    callerIdNote: isCallerIdConfigured()
      ? "Caller ID is set — outbound dialing via /api/twilio/call is enabled."
      : "No TWILIO_CALLER_ID — outbound dialing is disabled (take-over still works).",
  });
}
