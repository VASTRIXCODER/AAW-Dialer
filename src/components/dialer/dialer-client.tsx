"use client";

import {
  AlertTriangle,
  CalendarCheck2,
  Hammer,
  ListFilter,
  Loader2,
  Phone,
  PhoneCall,
  Settings,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVocabulary } from "@/components/layout/vocabulary";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  isScriptTestRunning,
  scriptTextForVariant,
  scriptVariantForLead,
} from "@/lib/campaign-scripts";
import {
  persistDisposition,
  replayQueuedDispositions,
} from "@/lib/dialer/disposition-queue";
import type { PendingDisposition } from "@/lib/dialer/pending-dispositions";
import { usePendingDispositions } from "@/lib/dialer/use-pending-dispositions";
import { describeOrgHours, isWithinOrgHours } from "@/lib/dialer/schedule";
import { browserWrapupStore, clearWrapupDraft } from "@/lib/dialer/wrapup-draft";
import { filterOutcomeOptionsByKeys, resolveOutcomeOptions } from "@/lib/status";
import { useVisiblePoll } from "@/lib/use-visible-poll";
import { cn } from "@/lib/utils";
import type { BookedLead } from "@/lib/db/leads";
import type { CallOutcome, Lead } from "@/lib/types";
import { BookAppointmentDialog, type BookedAppointment } from "./book-appointment-dialog";
import {
  ScheduleCallbackDialog,
  type ScheduledCallback,
} from "./schedule-callback-dialog";
import { BookedLeadsPanel } from "./booked-leads-panel";
import { CallCockpit } from "./call-cockpit";
import { PendingDispositionsWidget } from "./pending-dispositions-widget";
import { useDialerContext, type DialerCampaign } from "./dialer-context";
import { DialerFloor } from "./dialer-floor";
import { DialerShell } from "./dialer-shell";
import { LeadPanel } from "./lead-panel";
import { groupLabel, LoadLeadsDialog } from "./load-leads-dialog";
import { QualifyPanel } from "./qualify-panel";
import { SessionBuilder } from "./session-builder";
import { Teleprompter } from "./teleprompter";

export function DialerClient({
  queue: initialQueue,
  campaigns = [],
  dispositions = null,
  initialCampaign = "",
  callbackPhone,
  callbackName,
  callbackId,
  assignmentId,
  assignmentLabel,
}: {
  queue: Lead[];
  campaigns?: DialerCampaign[];
  /** The org's stored `settings.dispositions` — the wrap-up grid renders the
   *  admin's taxonomy. Null/absent ⇒ the canonical nine. */
  dispositions?: unknown;
  initialCampaign?: string;
  /** When set, auto-dial this number (from the Callbacks page "Call back" link). */
  callbackPhone?: string;
  callbackName?: string;
  /** The claimed callback row this visit dials (uuid, already validated by the
   *  page). Ridden onto the FIRST disposition filed so the server can complete
   *  the callback — the loop that never used to close. */
  callbackId?: string;
  /** Scope the queue to one assignment (?assignment= — already server-verified
   *  by the page; the queue API re-verifies on every fetch). */
  assignmentId?: string;
  assignmentLabel?: string;
}) {
  // The dialer engine now lives ABOVE the page (in AppShell's DialerProvider) so
  // a live call survives navigating between sections. This page consumes it.
  const {
    dialer,
    config,
    queue,
    queueForDialer,
    campaignFilter,
    setCampaignFilter,
    groupFilter,
    setGroupFilter,
    myLeadsOnly,
    setMyLeadsOnly,
    campaigns: ctxCampaigns,
    applyLeadPatch,
    loadLeads,
    setAssignmentScope,
    loadingLeads,
    loadMsg,
    activate,
    loadSession,
  } = useDialerContext();
  const { state } = dialer;
  const vocab = useVocabulary();
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  // The session builder IS the load-leads flow now (quick load stays one click
  // away inside it). It was fully built in Phase 1 E and never mounted — the
  // dialer loaded a fixed default queue while claims ignored even that.
  const [builderOpen, setBuilderOpen] = useState(false);

  // Which dialer panels this workspace shows (template preset ⊕ admin toggles).
  const layout = config.dialerLayout;
  const showFloor = layout?.floor !== false;
  const showBookedTab = layout?.bookedTab !== false;
  const showScriptCard = layout?.scriptCard !== false;

  // ── Booked tab ────────────────────────────────────────────────────────────
  // Leads with an appointment already on the calendar. getDialQueue already
  // excludes them from the dial queue (status "appointment" isn't in DIALABLE),
  // Outside-hours banner clock: re-evaluate the org calling window once a
  // minute so the banner appears/disappears on schedule, not only on renders
  // something else happened to cause. Mounted after hydration (starts false)
  // so server and client first paints agree.
  const [outsideOrgHours, setOutsideOrgHours] = useState(false);
  useEffect(() => {
    const hours = config.callingHours;
    if (!hours) return;
    const evaluate = () =>
      setOutsideOrgHours(
        !isWithinOrgHours(new Date(), hours, config.orgTimezone || "America/Chicago"),
      );
    evaluate();
    const t = setInterval(evaluate, 60_000);
    return () => clearInterval(t);
  }, [config.callingHours, config.orgTimezone]);

  // so this is purely a visibility tab — polling independently of the dial
  // engine, the same pattern DialerFloor uses.
  const [tab, setTab] = useState<"queue" | "booked">("queue");
  const [bookedLeads, setBookedLeads] = useState<BookedLead[]>([]);
  const [bookedLoading, setBookedLoading] = useState(true);
  const bookedAlive = useRef(true);
  useEffect(() => {
    bookedAlive.current = true;
    return () => {
      bookedAlive.current = false;
    };
  }, []);
  // Display-only poll — paused while the tab is hidden. The dial engine's own
  // intervals (use-dialer.ts) are untouched and keep running during calls.
  // Skipped entirely when the Booked tab is laid out of this workspace.
  useVisiblePoll(() => {
    if (!showBookedTab) return;
    void (async () => {
      try {
        const r = await fetch("/api/leads/booked", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json().catch(() => ({}))) as { leads?: BookedLead[] };
        if (bookedAlive.current) setBookedLeads(Array.isArray(j.leads) ? j.leads : []);
      } catch {
        /* transient — keep the last snapshot */
      } finally {
        if (bookedAlive.current) setBookedLoading(false);
      }
    })();
  }, 15000);

  // How many of the currently-loaded leads this viewer personally uploaded —
  // powers the toggle's badge so a supervisor knows what to expect before
  // clicking it (e.g. not worth toggling if it'd show 0).
  const mineCount = useMemo(
    () =>
      config.userId
        ? queue.filter(
            (l) => l.ownerId === config.userId || l.assignedRepId === config.userId,
          ).length
        : 0,
    [queue, config.userId],
  );

  // Seed the provider with this page's server data + switch the engine on. Runs
  // once; the provider keeps the device + any live call alive after we leave.
  const activatedRef = useRef(false);
  useEffect(() => {
    if (activatedRef.current) return;
    activatedRef.current = true;
    // Assignment scope FIRST, so the initial fetch (and every auto-dial lap
    // refetch after it) is already narrowed to the pack being worked.
    setAssignmentScope(assignmentId ?? null);
    activate(initialQueue, campaigns, initialCampaign);
    // The page no longer serializes the queue into the RSC payload (it ships
    // ONCE as JSON via /api/leads/queue instead of twice) — so fetch it here,
    // unless the provider still holds a queue from an earlier visit. An
    // assignment visit ALWAYS refetches: whatever queue survived from a prior
    // visit was fetched at a different scope.
    if (assignmentId || (initialQueue.length === 0 && queue.length === 0)) void loadLeads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const campaignsForSelect = ctxCampaigns.length ? ctxCampaigns : campaigns;

  // The rep's in-call notes, owned HERE so the qualify panel and the wrap-up
  // screen edit the same note — and so there is exactly ONE writer persisting
  // it. A ref mirrors the value because fileOutcome reads the latest at
  // disposition time without wanting to be re-created on every keystroke.
  const [notes, setNotes] = useState<string>("");
  const notesRef = useRef<string>("");
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesLeadRef = useRef<string | null>(null);

  // Notes used to reach the lead ONLY through a disposition, so a rep who typed
  // "spoke to his wife, call back Friday" and then skipped the call — or simply
  // navigated away — lost it. They now save on the same 800ms debounce the
  // qualify fields use.
  const flushNotes = useCallback(() => {
    if (notesTimer.current) {
      clearTimeout(notesTimer.current);
      notesTimer.current = null;
    }
    const leadId = notesLeadRef.current;
    if (!leadId) return;
    notesLeadRef.current = null;
    void fetch("/api/leads/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // keepalive so a save racing a lead advance or a tab close still lands.
      body: JSON.stringify({ id: leadId, leadId, notes: notesRef.current }),
      keepalive: true,
    }).catch(() => {
      /* transient — the rep's screen already shows what they typed */
    });
  }, []);

  const updateNotes = useCallback(
    (next: string, leadId?: string | null) => {
      notesRef.current = next;
      setNotes(next);
      if (!leadId) return; // seeding from the lead, not a rep edit
      notesLeadRef.current = leadId;
      if (notesTimer.current) clearTimeout(notesTimer.current);
      notesTimer.current = setTimeout(() => flushNotes(), 800);
    },
    [flushNotes],
  );

  // Flush on unmount so navigating away mid-sentence doesn't drop the note.
  const flushNotesRef = useRef(flushNotes);
  flushNotesRef.current = flushNotes;
  useEffect(() => () => flushNotesRef.current(), []);
  // The script variant (A/B) shown for the focus lead — same ref idiom as
  // notesRef, so the disposition POST can carry it without re-binding
  // fileOutcome on every render. Updated by an effect further down, once the
  // focus lead + its campaign are resolved.
  const scriptVariantRef = useRef<"a" | "b" | null>(null);
  const focusLeadId = (
    state.connectedLead ??
    state.lines[0]?.lead ??
    (queueForDialer.length ? queueForDialer[state.queueIndex % queueForDialer.length] : null)
  )?.id;
  useEffect(() => {
    const lead =
      state.connectedLead ??
      state.lines[0]?.lead ??
      (queueForDialer.length ? queueForDialer[state.queueIndex % queueForDialer.length] : null);
    // Land any pending edit for the PREVIOUS lead before the value is replaced,
    // then seed from the new lead without writing that seed back.
    flushNotesRef.current();
    updateNotes(lead?.notes ?? "");
    // Reset notes to the lead's saved notes whenever the active lead changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLeadId]);

  // Flush any dispositions that failed to save on a previous (flaky) session.
  useEffect(() => {
    void replayQueuedDispositions();
  }, []);


  // The claimed callback this visit came from — consumed by the FIRST
  // disposition filed and then cleared, so a rep who keeps power-dialing after
  // the callback call can't accidentally complete the same callback again with
  // some other lead's outcome. A ref (not state): fileOutcome reads it at
  // disposition time without re-binding on every render.
  const pendingCallbackIdRef = useRef<string | null>(callbackId ?? null);

  // Auto-dial a callback number as soon as the Twilio device is live and idle.
  const callbackFiredRef = useRef(false);
  useEffect(() => {
    if (!callbackPhone || callbackFiredRef.current) return;
    if (state.mode === "live" && state.status === "idle" && !state.aiMode) {
      callbackFiredRef.current = true;
      dialer.dialNumber(callbackPhone, callbackName);
    }
  }, [state.mode, state.status, state.aiMode, callbackPhone, callbackName, dialer]);

  // Which lead the side panels describe right now (null when the queue is empty
  // and no call is active — production ships with no placeholder lead).
  const focusLead: Lead | null =
    state.connectedLead ??
    state.lines[0]?.lead ??
    (queueForDialer.length ? queueForDialer[state.queueIndex % queueForDialer.length] : null);

  const upNext = queueForDialer.length
    ? Array.from({ length: Math.min(4, queueForDialer.length - 1) }).map(
        (_, i) => queueForDialer[(state.queueIndex + i + 1) % queueForDialer.length],
      )
    : [];

  // ── Campaign script (A/B test) ─────────────────────────────────────────────
  // Which script the focus lead's campaign assigns them. Deterministic per lead
  // (hash of the id), so the same homeowner hears the same script on every
  // attempt. No script on the campaign ⇒ nothing renders at all.
  const focusCampaign = focusLead?.campaignId
    ? campaignsForSelect.find((c) => c.id === focusLead.campaignId)
    : undefined;
  const focusScripts = focusCampaign
    ? { scriptA: focusCampaign.scriptA ?? "", scriptB: focusCampaign.scriptB ?? "" }
    : null;
  const scriptVariant =
    focusLead && focusScripts ? scriptVariantForLead(focusLead, focusScripts) : null;
  const scriptText = focusScripts ? scriptTextForVariant(focusScripts, scriptVariant) : "";
  const scriptTestRunning = focusScripts ? isScriptTestRunning(focusScripts) : false;
  // The campaign's OTHER script — the teleprompter's objection branch.
  const branchText = focusScripts
    ? (scriptVariant === "b" ? focusScripts.scriptA : focusScripts.scriptB).trim()
    : "";
  useEffect(() => {
    scriptVariantRef.current = scriptVariant;
  }, [scriptVariant]);

  // Teleprompter "copy to notes": append one "Label — value" line to the same
  // in-call note the qualify panel and wrap-up edit (notesRef holds the latest).
  const focusLeadIdRef = useRef<string | null>(null);
  focusLeadIdRef.current = focusLeadId ?? null;
  const appendNote = useCallback(
    (line: string) => {
      const cur = notesRef.current;
      if (cur.includes(line)) return; // double-tap shouldn't duplicate the line
      updateNotes(cur ? `${cur}\n${line}` : line, focusLeadIdRef.current);
    },
    [updateNotes],
  );

  // ── Disposition ────────────────────────────────────────────────────────────
  // Two outcomes pause here to ask WHEN, because filing the disposition is a
  // one-way door: dialer.selectOutcome() advances the queue and, with auto-dial
  // on, immediately starts calling the next lead. Ask first, file second.
  //
  //  • "Appointment booked" → the slot, so the review reaches the calendar.
  //  • "Callback"           → the time, so the promise reaches the Callbacks
  //                           board's overdue/due/upcoming triage. Without it
  //                           every callback a rep ever promised was filed with
  //                           no due date and sat in "Due now" forever.
  //
  // Every other outcome files straight through, untouched.
  //
  // The dialogs carry the pressed disposition KEY as well as the lead — a
  // custom "Left with spouse → callback" button must file with ITS key, not
  // the generic callback_scheduled it collapses to.
  // In POWER MODE both dialogs are also reachable from the review widget, so the
  // dialog state can carry the pending row it belongs to: when present, confirming
  // files THAT row (the queue already moved on) instead of the live call.
  const [booking, setBooking] = useState<{
    lead: Lead;
    notes: string;
    dispositionKey?: string;
    pendingRow?: PendingDisposition;
  } | null>(null);
  const [callback, setCallback] = useState<{
    lead: Lead;
    notes: string;
    dispositionKey?: string;
    pendingRow?: PendingDisposition;
  } | null>(null);

  const fileOutcome = useCallback(
    (
      o: CallOutcome,
      lead: Lead | null,
      extra?: {
        appointment?: BookedAppointment | null;
        callback?: ScheduledCallback | null;
      },
      dispositionKey?: string,
    ) => {
      if (lead) {
        // Durable: on any network failure the disposition is queued in
        // localStorage and replayed on the next load, instead of being silently
        // dropped while the queue advances. Advance immediately for snappy UX.
        void persistDisposition({
          leadId: lead.id,
          leadName: `${lead.firstName} ${lead.lastName}`,
          phone: lead.phone,
          durationSec: state.durationSec,
          outcome: o,
          // The button that was pressed. For system rows this IS the outcome;
          // for admin-created rows it's their x_* key — the server validates it
          // against the org's taxonomy and stores it on the call record.
          dispositionKey: dispositionKey ?? o,
          callSid: state.callSid,
          room: state.room,
          // This lead's idempotency key from dial time — a replayed save is a
          // no-op server-side instead of a duplicate record + appointment.
          clientAttemptId: state.attemptIds[lead.id],
          notes: notesRef.current || undefined,
          appointment: extra?.appointment ?? undefined,
          callback: extra?.callback ?? undefined,
          // Which script (A/B) the rep was shown for this lead — powers the
          // per-variant split on the campaign page. Absent when no script.
          scriptVariant: scriptVariantRef.current ?? undefined,
          // The claimed callback this dial executes — the server completes it
          // when the disposition lands (consume-once, see the ref above).
          callbackId: pendingCallbackIdRef.current ?? undefined,
        });
        pendingCallbackIdRef.current = null;
        // The disposition is filed — the crash-recovery draft for this attempt
        // has served its purpose and must not resurrect on a future wrap-up.
        const store = browserWrapupStore();
        const attemptId = state.attemptIds[lead.id] ?? state.callSid;
        if (store && attemptId) clearWrapupDraft(store, attemptId);
      }
      dialer.selectOutcome(o);
    },
    [dialer, state.durationSec, state.callSid, state.room, state.attemptIds],
  );

  const onOutcome = useCallback(
    (o: CallOutcome, dispositionKey?: string) => {
      if (o === "appointment_booked" && focusLead) {
        setBooking({ lead: focusLead, notes: notesRef.current, dispositionKey });
        return;
      }
      if (o === "callback_scheduled" && focusLead) {
        setCallback({ lead: focusLead, notes: notesRef.current, dispositionKey });
        return;
      }
      fileOutcome(o, focusLead, undefined, dispositionKey);
    },
    [focusLead, fileOutcome],
  );

  // ── Power mode ──────────────────────────────────────────────────────────────
  // The true power-dialer loop: a finished MANUAL call doesn't stop on the
  // wrap-up screen. The AI reads it in the background and it stacks in the review
  // widget while the dialer keeps dialing. Both toggles default from the org
  // setting and are then remembered per rep — the rep is in control of the pace.
  const [powerMode, setPowerMode] = useState<boolean>(config.autoDispose ?? false);
  const [autoConfirm, setAutoConfirm] = useState<boolean>(
    config.autoConfirmDisposition ?? false,
  );
  const powerKey = config.userId ? `aj:powerMode:${config.userId}` : null;
  const autoConfirmKey = config.userId ? `aj:autoConfirm:${config.userId}` : null;
  useEffect(() => {
    try {
      if (powerKey) {
        const v = window.localStorage.getItem(powerKey);
        if (v != null) setPowerMode(v === "1");
      }
      if (autoConfirmKey) {
        const v = window.localStorage.getItem(autoConfirmKey);
        if (v != null) setAutoConfirm(v === "1");
      }
    } catch {
      /* storage disabled — the toggles just won't persist */
    }
  }, [powerKey, autoConfirmKey]);

  const toggleAutoConfirm = useCallback(
    (next: boolean) => {
      setAutoConfirm(next);
      try {
        if (autoConfirmKey) window.localStorage.setItem(autoConfirmKey, next ? "1" : "0");
      } catch {
        /* best-effort */
      }
    },
    [autoConfirmKey],
  );

  // Resolve a full lead for the time dialogs when confirming an appointment/
  // callback from the widget — the call is long over, so pull it from the queue
  // (falling back to a minimal record built from the pending row).
  const leadForRow = useCallback(
    (row: PendingDisposition): Lead => {
      const found = queueForDialer.find((l) => l.id === row.leadId);
      if (found) return found;
      // The lead may have cycled out of the loaded queue — the dialogs only
      // display name/city, so a minimal record is enough.
      const [firstName, ...rest] = (row.leadName || "").split(" ");
      return {
        id: row.leadId,
        firstName: firstName ?? "",
        lastName: rest.join(" "),
        phone: row.phone,
        address: "",
        city: "",
        state: "",
        zip: "",
        utilityProvider: "",
        solarProvider: "",
        status: "contacted",
        campaignId: "",
        hasEV: false,
        hasPool: false,
        hasBattery: false,
        multipleSystems: false,
        createdAt: "",
        timezone: "",
      };
    },
    [queueForDialer],
  );

  // A widget confirmation of an appointment/callback needs a time — open the
  // right dialog, tagged with the pending row so confirming files THAT row.
  const onNeedsTime = useCallback(
    (row: PendingDisposition, outcome: CallOutcome) => {
      const lead = leadForRow(row);
      if (outcome === "appointment_booked") setBooking({ lead, notes: row.notes, pendingRow: row });
      else setCallback({ lead, notes: row.notes, pendingRow: row });
    },
    [leadForRow],
  );

  const powerDispositions = usePendingDispositions({
    userId: config.userId,
    autoConfirm,
    onNeedsTime,
  });
  const { enqueue: enqueuePending } = powerDispositions;

  const togglePowerMode = useCallback(
    (next: boolean) => {
      setPowerMode(next);
      try {
        if (powerKey) window.localStorage.setItem(powerKey, next ? "1" : "0");
      } catch {
        /* best-effort */
      }
      // Power mode is nothing without continuous dialing — turning it on turns
      // auto-dial on too, so a finished call actually flows into the next one.
      if (next && !state.autoDial) dialer.setAutoDial(true);
    },
    [powerKey, dialer, state.autoDial],
  );

  // The wrap-up watcher. When a MANUAL call ends in power mode we don't wait for
  // a disposition: snapshot the call into the widget's classify pipeline and
  // skip() straight on to keep the dialer moving. Edge-detected with a ref so it
  // fires exactly once per wrap-up. (AI calls disposition themselves server-side
  // and never reach this screen.)
  const wrapupHandledRef = useRef(false);
  useEffect(() => {
    if (state.status !== "wrapup") {
      wrapupHandledRef.current = false;
      return;
    }
    if (!powerMode || state.aiMode) return;
    if (wrapupHandledRef.current) return;
    wrapupHandledRef.current = true;
    const lead = state.connectedLead;
    if (lead) {
      // Consume the claimed callback here (once) so the auto-disposition
      // completes it — the same consume-once fileOutcome does for a live call.
      const callbackIdForThis = pendingCallbackIdRef.current;
      pendingCallbackIdRef.current = null;
      enqueuePending({
        leadId: lead.id,
        leadName: `${lead.firstName} ${lead.lastName}`.trim(),
        phone: lead.phone,
        durationSec: state.durationSec,
        connected: state.durationSec > 0,
        callSid: state.callSid,
        room: state.room,
        notes: notesRef.current || "",
        scriptVariant: scriptVariantRef.current,
        clientAttemptId: state.attemptIds[lead.id] ?? state.callSid,
        callbackId: callbackIdForThis,
      });
    }
    // Keep dialing. skip() advances the queue and, with auto-dial on, launches
    // the next call — filing nothing itself, which is exactly right: the widget
    // owns this call's disposition now.
    dialer.skip();
  }, [
    state.status,
    state.aiMode,
    state.connectedLead,
    state.durationSec,
    state.callSid,
    state.room,
    state.attemptIds,
    powerMode,
    enqueuePending,
    dialer,
  ]);

  // ── Keyboard shortcuts (registered by DialerShell while this page lives) ──
  // The SAME resolution the OutcomeGrid renders, so 1..9 press exactly the
  // buttons on screen, in grid order. Every handler self-gates on status —
  // and every one of them has a visible button equivalent.
  const outcomeOptions = useMemo(
    () =>
      filterOutcomeOptionsByKeys(
        resolveOutcomeOptions(vocab, dispositions),
        focusCampaign?.dispositionKeys,
      ),
    [vocab, dispositions, focusCampaign?.dispositionKeys],
  );
  const kbdHandlers = useMemo(
    () => ({
      onStartCall: () => {
        if (state.status === "idle") dialer.startCall();
      },
      onToggleMute: () => {
        if (state.status === "dialing" || state.status === "live") dialer.toggleMute();
      },
      onSkip: () => {
        if (state.status === "dialing" || state.status === "wrapup") dialer.skip();
      },
      onFocusNotes: () => {
        document.querySelector<HTMLElement>("[data-dialer-notes]")?.focus();
      },
      onDigit: (n: number) => {
        if (state.status !== "wrapup") return;
        const opt = outcomeOptions[n - 1];
        if (opt) onOutcome(opt.value, opt.key);
      },
    }),
    [dialer, state.status, outcomeOptions, onOutcome],
  );

  return (
    <DialerShell
      assignmentLabel={assignmentLabel}
      kbd={kbdHandlers}
      dispositionLabels={outcomeOptions.map((o) => o.label)}
    >
      {/* Manual mode needs Twilio; AI mode places calls server-side without it. */}
      {config.manualEnabled && !config.voiceConfigured && !state.aiMode && (
        <Card className="flex flex-col items-start gap-3 border-warning/30 bg-warning/5 p-4 sm:flex-row sm:items-center">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">Twilio isn’t connected yet</p>
            <p className="text-sm text-muted-foreground">
              Manual dialing needs your Twilio credentials. Switch to AI calling, or
              connect Twilio to dial manually.
            </p>
          </div>
          <Link
            href="/admin"
            className={buttonVariants({ size: "sm", variant: "outline", className: "gap-2" })}
          >
            <Settings className="h-4 w-4" />
            Connect Twilio
          </Link>
        </Card>
      )}

      {/* Outside-calling-hours banner (Admin → Calling hours). Advisory by
          default; when the org enforces the hours, the server refuses the dial
          too — evaluated per-lead in the LEAD's timezone, so this org-clock
          banner is a heads-up, not the authority. */}
      {outsideOrgHours && (
        <Card
          role="status"
          className="flex flex-col items-start gap-3 border-warning/30 bg-warning/5 p-4 sm:flex-row sm:items-center"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">
              Outside calling hours ({describeOrgHours(config.callingHours!)})
            </p>
            <p className="text-sm text-muted-foreground">
              {config.callingHours?.enforced
                ? "Each contact is checked in their OWN local time at dial: contacts outside their window are refused (their lane cancels), contacts still inside theirs ring normally. This banner follows the workspace clock."
                : "Your workspace's calling window is closed. Calls still go through — this is a heads-up, not a block."}
            </p>
          </div>
        </Card>
      )}

      {/* Callback auto-dial banner — shown until the call fires */}
      {callbackPhone && !callbackFiredRef.current && state.status === "idle" && (
        <Card className="flex flex-col items-start gap-3 border-accent/30 bg-accent/5 p-4 sm:flex-row sm:items-center">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <Phone className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">
              Callback ready{callbackName ? ` — ${callbackName}` : ""}
            </p>
            <p className="text-sm text-muted-foreground">
              {state.mode === "live"
                ? "Dialing now…"
                : "Connecting to Twilio — will dial automatically once ready."}
            </p>
          </div>
        </Card>
      )}

      {/* Dial queue vs already-booked leads — booked leads are skipped by the
          queue automatically; this tab is where they're visible instead of
          just vanishing on the next reload. A one-tab bar is pointless, so the
          whole strip disappears when the layout drops the Booked tab. */}
      {showBookedTab && (
        <div className="flex items-center gap-1.5 border-b border-border/60">
          <button
            type="button"
            onClick={() => setTab("queue")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === "queue"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <PhoneCall className="h-4 w-4" />
            Dial queue
          </button>
          <button
            type="button"
            onClick={() => setTab("booked")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === "booked"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <CalendarCheck2 className="h-4 w-4" />
            Booked
            <Badge tone={tab === "booked" ? "success" : "neutral"} className="ml-0.5">
              {bookedLeads.length}
            </Badge>
          </button>
        </div>
      )}

      {/* Shared live floor — who's dialing + calls today, org-wide */}
      {showFloor && <DialerFloor />}

      {showBookedTab && tab === "booked" ? (
        <Card className="overflow-hidden">
          <BookedLeadsPanel leads={bookedLeads} loading={bookedLoading} />
        </Card>
      ) : (
        <>
      {/* Load leads into the dialer on demand + the group/campaign picker.
          Both doors lead to the SessionBuilder — two identically-labeled
          buttons doing different things is how the builder stayed invisible
          (quick load lives inside it, one click away). */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={() => setBuilderOpen(true)}
          disabled={loadingLeads || state.status !== "idle"}
        >
          {loadingLeads ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Users className="h-4 w-4" />
          )}
          Load leads
        </Button>
        {queue.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLoadDialog(true)}
            disabled={state.status !== "idle"}
            className="flex h-9 items-center gap-1.5 rounded-xl border border-border bg-background/60 px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
            title="Choose which lead group or campaign to dial"
          >
            <ListFilter className="h-4 w-4" />
            Filters
          </button>
        )}
        {groupFilter !== "all" && (
          <Badge tone="primary" className="gap-1">
            {groupLabel(groupFilter, config.leadGroupLabels, config.leadGroups)}
            <button
              type="button"
              onClick={() => setGroupFilter("all")}
              aria-label="Clear group filter"
              className="ml-0.5 hover:opacity-70"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        {campaignFilter && (
          <Badge tone="accent" className="gap-1">
            {campaignsForSelect.find((c) => c.id === campaignFilter)?.name ?? "Campaign"}
            <button
              type="button"
              onClick={() => setCampaignFilter("")}
              aria-label="Clear campaign filter"
              className="ml-0.5 hover:opacity-70"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        {config.dialScope === "org" && (
          <button
            type="button"
            onClick={() => setMyLeadsOnly(!myLeadsOnly)}
            disabled={state.status !== "idle"}
            aria-pressed={myLeadsOnly}
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors disabled:opacity-50",
              myLeadsOnly
                ? "border-primary/60 bg-primary-soft text-primary"
                : "border-border bg-background/60 text-muted-foreground hover:bg-muted",
            )}
            title={
              myLeadsOnly
                ? "Showing only your leads (ones you uploaded or were assigned). Click to include the whole organization's pool again."
                : "Only load your leads — ones you uploaded or were assigned. Your choice is remembered next time."
            }
          >
            <UserCheck className="h-4 w-4" />
            My leads only
            <Badge tone={myLeadsOnly ? "primary" : "neutral"} className="ml-0.5">
              {mineCount}
            </Badge>
          </button>
        )}
        {/* The assignment chip moved into the shell header (with progress). */}
        <span
          className="text-xs font-medium text-muted-foreground tabular"
          title={
            config.dialScope === "org" && !myLeadsOnly
              ? "As a supervisor you dial the whole organization's pool — every rep's leads, not just your own uploads."
              : "The power dialer only ever loads leads you uploaded — you never dial a teammate's leads."
          }
        >
          <b className="text-foreground">{queueForDialer.length}</b>{" "}
          {config.dialScope === "org" && !myLeadsOnly ? "org" : "of your"} lead
          {queueForDialer.length === 1 ? "" : "s"} ready to dial
        </span>
        {loadMsg && (
          <span className="basis-full text-xs text-muted-foreground">{loadMsg}</span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="overflow-hidden lg:col-span-3">
          <LeadPanel
            lead={focusLead}
            upNext={upNext}
            queue={queueForDialer}
            index={queueForDialer.length ? state.queueIndex % queueForDialer.length : 0}
            total={queueForDialer.length}
            onPrev={dialer.prevLead}
            onNext={dialer.nextLead}
            onSelect={dialer.selectLead}
            navDisabled={state.status !== "idle"}
            onLoadLeads={() => setBuilderOpen(true)}
            loadingLeads={loadingLeads}
            fields={config.leadFields}
            showCallHistory={layout?.callHistory !== false}
            showUpNext={layout?.upNext !== false}
            canReverseSearch={config.permissions?.includes("leads.reverseSearch") ?? false}
            reverseSearchConfigured={config.reverseSearchConfigured ?? false}
            onLeadPatched={applyLeadPatch}
          />
        </Card>

        <Card className="overflow-hidden lg:col-span-5 lg:min-h-[640px]">
          <CallCockpit
            state={state}
            focusLead={focusLead}
            hasQueue={queueForDialer.length > 0}
            powerMode={powerMode && !state.aiMode}
            wrapupNotes={notes}
            onNotesChange={(n) => updateNotes(n, focusLead?.id ?? null)}
            aiConfigured={config.aiAgentConfigured}
            manualEnabled={config.manualEnabled}
            aiEnabled={config.aiEnabled}
            aiLockReason={config.aiLockReason}
            secondAgentConfigured={config.secondAgentConfigured ?? false}
            agentNames={config.agentNames}
            onSetActiveAgent={dialer.setActiveAgent}
            callerIdPool={config.callerIdPool ?? []}
            callerIdRotateEvery={config.callerIdRotateEvery ?? 1}
            onToggleExcludedCallerId={dialer.toggleExcludedCallerId}
            onSetLocalPresence={dialer.setLocalPresence}
            onStart={() => dialer.startCall()}
            onManualDial={dialer.dialNumber}
            onAiDialNumber={dialer.aiDialNumber}
            onEnd={dialer.endCall}
            onSkip={dialer.skip}
            onRedial={() => focusLead && dialer.redial(focusLead)}
            onOutcome={onOutcome}
            dispositions={dispositions}
            allowedDispositionKeys={focusCampaign?.dispositionKeys}
            reviewEnabled={Boolean(config.orgId)}
            onToggleMute={dialer.toggleMute}
            onToggleHold={dialer.toggleHold}
            onDigit={dialer.sendDigit}
            onSetParallel={dialer.setParallelCount}
            onSetAutoDial={dialer.setAutoDial}
            onLaunchNextAI={dialer.launchNextAI}
            onStopAICampaign={dialer.stopAICampaign}
            onEndAISession={dialer.endAISession}
            onRedialAI={dialer.redialAI}
            onLoadLeads={() => setBuilderOpen(true)}
            onReconnect={dialer.reconnect}
          />
        </Card>

        {/* data-dialer-teleprompter: the live cockpit's "Script" reach button
            scrolls this card into view (it can sit below the fold mid-call). */}
        <Card className="overflow-hidden lg:col-span-4" data-dialer-teleprompter="">
          <div className="border-b border-border px-5 py-3">
            <h3 className="font-semibold">
              Lead information
            </h3>
            <p className="text-xs text-muted-foreground">
              Everything from the lead sheet, plus your call notes.
            </p>
          </div>
          {/* Teleprompter replaces the static script card whenever a campaign
              script exists: sections, {{field}} interpolation against the
              current lead, objection branch, copy-to-notes. */}
          {showScriptCard && scriptText.length > 0 && (
            <Teleprompter
              scriptText={scriptText}
              branchText={branchText || null}
              variant={scriptVariant}
              testRunning={scriptTestRunning}
              lead={focusLead}
              fields={config.leadFields ?? []}
              onCopyToNotes={appendNote}
            />
          )}
          <div className="p-5">
            <QualifyPanel
              key={focusLead?.id ?? "none"}
              lead={focusLead}
              fields={config.qualifyFields}
              leadFields={config.leadFields}
              notes={notes}
              onNotesChange={(n) => updateNotes(n, focusLead?.id ?? null)}
            />
          </div>
          {/* Closer notes — deliberately a visible placeholder, not a hidden
              stub: the panel is planned (notes a setter leaves for the closer
              who runs the appointment), and the slot it will occupy should
              exist on the floor before the feature does. Toggle:
              Admin → Dialer layout → "Closer notes". */}
          {layout?.closerNotes !== false && (
            <div className="border-t border-border p-5" aria-labelledby="closer-notes-heading">
              <p
                id="closer-notes-heading"
                className="mb-2.5 text-xs font-bold uppercase tracking-wide text-muted-foreground"
              >
                Closer notes
              </p>
              <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/80 bg-muted/30 px-4 py-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
                  <Hammer className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Under construction</p>
                  <p className="text-xs text-muted-foreground">
                    Handoff notes for the closer will live here. For now, keep
                    anything the closer needs in the call notes above.
                  </p>
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
        </>
      )}

      {booking && (
        <BookAppointmentDialog
          lead={booking.lead}
          defaultNotes={booking.notes}
          onConfirm={(appt) => {
            const row = booking.pendingRow;
            setBooking(null);
            // From the widget the queue already advanced — file the pending row.
            // From the live call, file + advance as before.
            if (row)
              powerDispositions.applyWithTime(row, "appointment_booked", { appointment: appt });
            else
              fileOutcome(
                "appointment_booked",
                booking.lead,
                { appointment: appt },
                booking.dispositionKey,
              );
          }}
          onSkip={() => {
            // Books it with no time — the pre-existing behavior. It lands in the
            // calendar's "Needs a time" rail rather than being silently lost.
            const row = booking.pendingRow;
            setBooking(null);
            if (row) powerDispositions.applyWithTime(row, "appointment_booked", {});
            else fileOutcome("appointment_booked", booking.lead, undefined, booking.dispositionKey);
          }}
          // Backing out files nothing at all: the rep mis-clicked, and the call
          // stays open on the same lead (or the widget row stays for review).
          onCancel={() => setBooking(null)}
        />
      )}

      {callback && (
        <ScheduleCallbackDialog
          lead={callback.lead}
          defaultReason={callback.notes}
          onConfirm={(cb) => {
            const row = callback.pendingRow;
            setCallback(null);
            if (row) powerDispositions.applyWithTime(row, "callback_scheduled", { callback: cb });
            else
              fileOutcome(
                "callback_scheduled",
                callback.lead,
                { callback: cb },
                callback.dispositionKey,
              );
          }}
          onSkip={() => {
            // Files the callback with no time — the pre-existing behavior. It
            // lands in "Due now" rather than being lost.
            const row = callback.pendingRow;
            setCallback(null);
            if (row) powerDispositions.applyWithTime(row, "callback_scheduled", {});
            else fileOutcome("callback_scheduled", callback.lead, undefined, callback.dispositionKey);
          }}
          // Backing out files nothing at all: the rep mis-clicked, and the call
          // stays open on the same lead (or the widget row stays for review).
          onCancel={() => setCallback(null)}
        />
      )}

      {/* Power-mode review stack — floats in the corner while the dialer keeps
          going. Rendered at the shell root so it stays put no matter which tab
          is showing. */}
      <PendingDispositionsWidget
        pending={powerDispositions.pending}
        available={config.manualEnabled}
        powerMode={powerMode}
        autoConfirm={autoConfirm}
        onTogglePowerMode={togglePowerMode}
        onToggleAutoConfirm={toggleAutoConfirm}
        onConfirm={powerDispositions.confirm}
        onDismiss={powerDispositions.dismiss}
        onRetry={powerDispositions.retry}
        onClearApplied={powerDispositions.clearApplied}
      />

      {showLoadDialog && (
        <LoadLeadsDialog
          leads={queue}
          campaigns={campaignsForSelect}
          campaignFilter={campaignFilter}
          onCampaignFilterChange={setCampaignFilter}
          groupFilter={groupFilter}
          onGroupFilterChange={setGroupFilter}
          onClose={() => setShowLoadDialog(false)}
          leadGroupLabels={config.leadGroupLabels}
          leadGroups={config.leadGroups}
        />
      )}

      <SessionBuilder
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        campaigns={campaignsForSelect}
        groups={config.leadGroups ?? []}
        leadGroupLabels={config.leadGroupLabels ?? {}}
        canOrgWide={config.dialScope === "org"}
        initial={config.savedSession}
        onLoad={(leads, meta) => {
          loadSession(leads, meta);
          setBuilderOpen(false);
        }}
        onQuickLoad={() => {
          void loadLeads();
          setBuilderOpen(false);
        }}
      />
    </DialerShell>
  );
}
