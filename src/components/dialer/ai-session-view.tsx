"use client";

import { motion } from "framer-motion";
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ExternalLink,
  Headphones,
  Loader2,
  Phone,
  PhoneOff,
  RotateCcw,
  StopCircle,
  Target,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVocabulary } from "@/components/layout/vocabulary";
import { LiveTranscriptPane } from "@/components/monitor/live-transcript-pane";
import { useLiveListen } from "@/components/monitor/use-live-listen";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { LaneCard } from "@/components/ui/lane-card";
import { StatusPill, type PillState } from "@/components/ui/status-pill";
import { canRedial, redialTargets } from "@/lib/dialer/ai-redial";
import { aiCallPill } from "@/lib/dialer/lane-state";
import type { CallStatePayload, FloorCallState } from "@/lib/realtime/events";
import { useOrgChannel } from "@/lib/realtime/use-org-channel";
import type { AiLaunch } from "@/lib/use-dialer";
import { useVisiblePoll } from "@/lib/use-visible-poll";
import { cn, formatDuration, formatPhone } from "@/lib/utils";
import { useDialerContext } from "./dialer-context";

// ─────────────────────────────────────────────────────────────────────────────
// AiSessionView (E4) — the AI dialing session, dissolved out of call-stage's
// AiSession block. Header: which persona is dialing and (when the session is
// scoped to a campaign that has one) the campaign's stated goal. One row per
// launched call, its StatusPill driven by the org channel's `call.state`
// broadcasts (kind "ai", matched by conversationId) with the existing
// /api/elevenlabs/inflight poll as the always-on fallback — so the pills work
// in demo/offline too, just slower and coarser. Expanding a live row shows the
// floor's LiveTranscriptPane (E2 — its own "delayed" honesty built in) plus
// Listen / End-call per the viewer's monitor permissions; both render disabled
// with a plain-language reason when the viewer can't use them.
// ─────────────────────────────────────────────────────────────────────────────

const INFLIGHT_POLL_MS = 5_000;

interface RowLive {
  state: FloorCallState;
  /** ms epoch — when the call entered `state` (broadcast stateSince, else observed). */
  since: number;
  terminationReason: string | null;
}

function rowPill(
  call: AiLaunch,
  live: RowLive | undefined,
): { pill: PillState; live: boolean } {
  if (call.error) return { pill: "failed", live: false };
  if (!call.conversationId) return { pill: "dialing", live: true };
  if (live) {
    return {
      pill: aiCallPill(live.state, live.terminationReason),
      live: live.state !== "ended",
    };
  }
  // Launched, no state signal yet — the honest floor word for "on its way".
  return { pill: "initiated", live: true };
}

export function AiSessionView({
  calls,
  campaign,
  parallelCount,
  hasMore,
  onLaunchNext,
  onStop,
  onEnd,
  onRedial,
}: {
  calls: AiLaunch[];
  campaign: "idle" | "running" | "done";
  parallelCount: number;
  hasMore: boolean;
  onLaunchNext: () => void;
  onStop: () => void;
  onEnd: () => void;
  /** Dial one lead again — the AI twin of the manual dialer's Redial. */
  onRedial: (leadId: string) => void;
}) {
  const { dialer, config, campaigns, campaignFilter } = useDialerContext();
  const { state } = dialer;
  const vocab = useVocabulary();

  const agentName =
    state.activeAgent === "secondary"
      ? config.agentNames?.secondary || "Agent 2"
      : config.agentNames?.primary || "AI agent";
  const scopedCampaign = campaignFilter
    ? campaigns.find((c) => c.id === campaignFilter)
    : undefined;
  const objective = scopedCampaign?.objective?.trim() || "";

  const canListen = config.permissions?.includes("monitor.listen") ?? false;
  const canIntervene = config.permissions?.includes("monitor.intervene") ?? false;

  // ── Live state per conversation: broadcasts first, inflight poll as net ────
  const [liveById, setLiveById] = useState<Record<string, RowLive>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Which conversations are OURS — broadcast handler filters against this so
  // the map never grows with the rest of the floor's traffic.
  const convIdsRef = useRef<Set<string>>(new Set());
  convIdsRef.current = new Set(
    calls.map((c) => c.conversationId).filter((id): id is string => Boolean(id)),
  );
  // First-seen times, so a row with no state signal still gets an honest timer.
  const seenAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const c of calls) {
      const key = c.conversationId ?? `pending:${c.leadId}`;
      if (!seenAtRef.current.has(key)) seenAtRef.current.set(key, Date.now());
    }
  }, [calls]);

  useOrgChannel({
    orgId: config.orgId ?? null,
    on: {
      "call.state": (p: CallStatePayload) => {
        if (p.kind !== "ai" || !convIdsRef.current.has(p.id)) return;
        setLiveById((prev) => {
          const cur = prev[p.id];
          if (cur && cur.state === p.state) return prev;
          const since = p.stateSince ? Date.parse(p.stateSince) : NaN;
          return {
            ...prev,
            [p.id]: {
              state: p.state,
              since: Number.isFinite(since) ? since : Date.now(),
              terminationReason: p.terminationReason ?? null,
            },
          };
        });
      },
    },
  });

  // Fallback: the same own-scoped inflight endpoint the engine's pump uses.
  // Coarser than the broadcast (live/ended + outcome, no ringing/connected
  // split) but works with no realtime channel at all.
  const pollInflight = useCallback(() => {
    const ids = [...convIdsRef.current].filter((id) => {
      const live = liveById[id];
      return !live || live.state !== "ended";
    });
    if (!ids.length) return;
    fetch("/api/elevenlabs/inflight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { active?: string[]; ended?: { id: string; outcome: string | null }[] } | null) => {
        if (!j?.ended?.length) return;
        setLiveById((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const e of j.ended ?? []) {
            const cur = next[e.id];
            if (cur?.state === "ended") continue;
            next[e.id] = {
              state: "ended",
              since: Date.now(),
              terminationReason: e.outcome ?? cur?.terminationReason ?? null,
            };
            changed = true;
          }
          return changed ? next : prev;
        });
      })
      .catch(() => {});
  }, [liveById]);
  useVisiblePoll(pollInflight, INFLIGHT_POLL_MS);

  // ── Listen / intervene (reuse the floor's flows, one ear at a time) ────────
  const listen = useLiveListen();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [interveneError, setInterveneError] = useState("");

  async function endAICall(conversationId: string) {
    setEndingId(conversationId);
    setInterveneError("");
    try {
      const res = await fetch("/api/elevenlabs/intervene", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, action: "end" }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setInterveneError(json.error ?? "Couldn't end the call.");
    } catch {
      setInterveneError("Network error.");
    } finally {
      setEndingId(null);
    }
  }

  const firstConv = calls.find((c) => c.conversationId)?.conversationId ?? null;
  const liveCount = calls.filter((c) => rowPill(c, c.conversationId ? liveById[c.conversationId] : undefined).live).length;
  // Session tallies, so the AI side answers the same questions the manual
  // header answers: how many did we place, how many are up, how many failed.
  const doneCount = calls.length - liveCount;
  const failedCount = calls.filter(
    (c) =>
      Boolean(c.error) ||
      (c.conversationId
        ? ["no_answer", "failed", "busy"].includes(
            liveById[c.conversationId]?.terminationReason ?? "",
          )
        : false),
  ).length;
  const isRowLive = (c: AiLaunch) =>
    rowPill(c, c.conversationId ? liveById[c.conversationId] : undefined).live;
  const canRedialRow = (c: AiLaunch, isLive: boolean) => canRedial(c, isLive);
  const redialable = redialTargets(calls, isRowLive);

  return (
    <motion.div
      key="ai"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="flex w-full max-w-md flex-col gap-4"
    >
      {/* Header — who is dialing, toward what */}
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand shadow-glow">
          <Bot className="h-8 w-8 text-white" />
        </div>
        <h2 className="flex items-center justify-center gap-2 text-lg font-bold">
          {campaign === "done" ? "Campaign complete" : `${agentName} is calling`}
          {/* How many lines this session is ACTUALLY running at, visible the
              whole time a campaign runs — not just a one-time chip on the
              idle screen a rep might never have looked at. Answers "is this
              really running at 10x" at a glance instead of by counting rows. */}
          {campaign !== "done" && state.parallelCount > 1 && (
            <span
              className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-bold text-accent"
              title={`Running ${state.parallelCount} calls at once (max ${state.maxParallel}) — change it from the Start screen before your next session.`}
            >
              {state.parallelCount}X
            </span>
          )}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {campaign === "running"
            ? "Auto-dialing your list. Oversee, listen & take over below or in the Live Monitor."
            : `${liveCount} in flight · oversee, listen & take over below.`}
        </p>
        {(scopedCampaign || objective) && (
          <p className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
            {scopedCampaign && <Badge tone="accent">{scopedCampaign.name}</Badge>}
            {objective && (
              <span className="inline-flex items-center gap-1" title="This campaign's stated goal.">
                <Target className="h-3 w-3" />
                {objective}
              </span>
            )}
          </p>
        )}
      </div>

      {/* Session tallies — the AI side of the manual header's dial counters. */}
      {calls.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { label: "Placed", value: calls.length, tone: "text-foreground" },
              { label: "In flight", value: liveCount, tone: "text-primary" },
              {
                label: failedCount ? "No answer" : "Finished",
                value: failedCount || doneCount,
                tone: failedCount ? "text-warning" : "text-muted-foreground",
              },
            ] as const
          ).map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-border/70 bg-surface/50 px-3 py-2 text-center backdrop-blur"
            >
              <p className={cn("text-lg font-bold tabular", s.tone)}>{s.value}</p>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {s.label}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* The engine's own halt reason.
          This was the gap: when the provider refuses to dial (out of credits,
          breaker open) the engine sets state.error with a plain-English reason
          AND stops the pump — but this view only ever rendered the listen and
          intervene errors, so the rep saw dialing silently stop with no
          explanation. The idle screen shows state.error; the AI session, the
          one screen you are actually watching when it happens, did not. */}
      {state.error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-danger">AI dialing stopped</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{state.error}</p>
          </div>
        </div>
      )}
      {interveneError && (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger">
          {interveneError}
        </p>
      )}
      {listen.error && (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger">
          {listen.error}
        </p>
      )}

      {/* Per-call rows */}
      <div className="max-h-[26rem] space-y-2 overflow-y-auto pr-0.5">
        {calls.slice(0, 20).map((c, i) => {
          const live = c.conversationId ? liveById[c.conversationId] : undefined;
          const { pill, live: isLive } = rowPill(c, live);
          const sinceKey = c.conversationId ?? `pending:${c.leadId}`;
          const since = live?.since ?? seenAtRef.current.get(sinceKey) ?? now;
          const elapsedSec = Math.max(0, Math.floor((now - since) / 1000));
          const reason = c.error
            ? c.error
            : live?.state === "ended" && live.terminationReason
              ? live.terminationReason.replace(/_/g, " ")
              : null;
          const expandable = Boolean(c.conversationId);
          const expanded = expandable && expandedId === c.conversationId;
          const listening =
            c.conversationId != null &&
            listen.listeningKey === `ai:${c.conversationId}`;
          const firstName = c.leadName.split(" ")[0] || vocab.LeadNoun;

          return (
            <LaneCard
              key={`${c.leadId}-${i}`}
              compact
              focused={listening}
              header={
                <button
                  type="button"
                  onClick={() =>
                    expandable &&
                    setExpandedId(expanded ? null : c.conversationId)
                  }
                  disabled={!expandable}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 text-left",
                    expandable && "cursor-pointer",
                  )}
                  title={
                    expandable
                      ? expanded
                        ? "Collapse"
                        : "Expand — live transcript & controls"
                      : "Still placing this call."
                  }
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand/90 text-white">
                    <Bot className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{c.leadName}</span>
                      {(c.attempt ?? 1) > 1 && (
                        <span
                          className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-bold text-muted-foreground"
                          title={`Attempt ${c.attempt} at this ${vocab.leadNoun} this session.`}
                        >
                          #{c.attempt}
                        </span>
                      )}
                    </span>
                    {/* Both numbers, the way the manual dialer shows them: who we
                        rang, and which of our numbers it went out on. */}
                    <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                      <Phone className="h-2.5 w-2.5 shrink-0" />
                      {c.phone ? formatPhone(c.phone) : "—"}
                      {c.callerId && <> · from {formatPhone(c.callerId)}</>}
                    </span>
                  </span>
                  {expandable && (
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-180",
                      )}
                    />
                  )}
                </button>
              }
              statusPill={<StatusPill state={pill} />}
              timer={
                isLive ? (
                  <span className="text-xs font-semibold text-muted-foreground tabular">
                    {formatDuration(elapsedSec)}
                  </span>
                ) : undefined
              }
              body={
                reason || canRedialRow(c, isLive) ? (
                  <div className="flex items-center justify-between gap-2">
                    {reason ? (
                      <p className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                        {reason}
                      </p>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {/* Dial again — the AI twin of the manual dialer's Redial.
                        Deliberately on the ROW itself, not tucked inside the
                        expander: a call that failed outright has no conversation
                        to expand, and that is exactly the one worth re-ringing. */}
                    {canRedialRow(c, isLive) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 gap-1.5 px-2 text-xs"
                        onClick={() => onRedial(c.leadId)}
                        title={`Have ${agentName} call ${c.leadName} again now.`}
                      >
                        <RotateCcw className="h-3 w-3" />
                        Dial again
                      </Button>
                    )}
                  </div>
                ) : undefined
              }
              footer={
                expanded && c.conversationId ? (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant={listening ? "outline" : "primary"}
                        className={cn("gap-1.5", listening && "border-success/40 text-success")}
                        disabled={!canListen || !isLive || listen.busyKey === `ai:${c.conversationId}`}
                        title={
                          !canListen
                            ? "Listening to live calls needs the monitor.listen permission — ask your manager."
                            : !isLive
                              ? "This call has ended — nothing live to listen to."
                              : undefined
                        }
                        onClick={() =>
                          c.conversationId &&
                          listen.start({ kind: "ai", conversationId: c.conversationId })
                        }
                      >
                        {listen.busyKey === `ai:${c.conversationId}` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Headphones className="h-3.5 w-3.5" />
                        )}
                        {listening ? "Listening — stop" : "Listen"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        className="gap-1.5"
                        disabled={!canIntervene || !isLive || endingId === c.conversationId}
                        title={
                          !canIntervene
                            ? "Intervening on live calls needs the monitor.intervene permission — ask your manager."
                            : !isLive
                              ? "This call has already ended."
                              : "End this AI call now."
                        }
                        onClick={() => c.conversationId && void endAICall(c.conversationId)}
                      >
                        {endingId === c.conversationId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <PhoneOff className="h-3.5 w-3.5" />
                        )}
                        End call
                      </Button>
                      <Link
                        href={`/monitor?call=${encodeURIComponent(c.conversationId)}`}
                        className={buttonVariants({
                          size: "sm",
                          variant: "outline",
                          className: "gap-1.5",
                        })}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open in floor
                      </Link>
                    </div>
                    {isLive ? (
                      <LiveTranscriptPane
                        orgId={config.orgId ?? null}
                        conversationId={c.conversationId}
                        live
                        contactLabel={firstName}
                        className="max-h-56"
                      />
                    ) : (
                      <div className="rounded-xl border border-dashed border-border/70 px-3 py-3 text-center">
                        <p className="text-xs text-muted-foreground">
                          Call ended — the recording and transcript land in the call archive.
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2 gap-1.5"
                          onClick={() => onRedial(c.leadId)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Dial again
                        </Button>
                      </div>
                    )}
                  </div>
                ) : undefined
              }
            />
          );
        })}
      </div>

      <Link
        href={firstConv ? `/monitor?call=${encodeURIComponent(firstConv)}` : "/monitor"}
        className={buttonVariants({ size: "lg", className: "w-full gap-2" })}
      >
        <ExternalLink className="h-5 w-5" />
        Open Live Monitor
      </Link>

      <div className="flex flex-wrap gap-2">
        {campaign === "running" ? (
          <Button variant="outline" className="flex-1 gap-2" onClick={onStop}>
            <StopCircle className="h-4 w-4" />
            Stop auto-dial
          </Button>
        ) : (
          hasMore && (
            // Offered even when the campaign reported "done": a finished pass is
            // not a dead end, and the queue refreshes between laps. Without this
            // the only button left on a completed session was "End session".
            <Button variant="outline" className="flex-1 gap-2" onClick={onLaunchNext}>
              <Bot className="h-4 w-4" />
              {campaign === "done"
                ? "Run another pass"
                : `Call next ${parallelCount > 1 ? parallelCount : ""}`}
            </Button>
          )
        )}
        {/* Re-ring everything that didn't connect, in one press. */}
        {redialable.length > 0 && campaign !== "running" && (
          <Button
            variant="outline"
            className="flex-1 gap-2"
            onClick={() => redialable.forEach((c) => onRedial(c.leadId))}
            title={`Have ${agentName} call the ${redialable.length} ${
              redialable.length === 1 ? vocab.leadNoun : vocab.leadNounPlural
            } that didn't connect again.`}
          >
            <RotateCcw className="h-4 w-4" />
            Dial again ({redialable.length})
          </Button>
        )}
        <Button variant="ghost" className="flex-1 gap-2 text-muted-foreground" onClick={onEnd}>
          <PhoneOff className="h-4 w-4" />
          End session
        </Button>
      </div>
    </motion.div>
  );
}
