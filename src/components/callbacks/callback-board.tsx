"use client";

import {
  AlarmClock,
  CheckCircle2,
  Clock,
  Flag,
  Loader2,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  RotateCcw,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useVocabulary } from "@/components/layout/vocabulary";
import { LeadOpenLink } from "@/components/leads/lead-360/lead-open-link";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import {
  formatDayLabel,
  formatTime,
  parseFloating,
  timezoneLabel,
} from "@/lib/appointments/time";
import {
  compareCallbacks,
  isClaimActive,
  laneOf,
  overdueTier,
  type CallbackLane,
} from "@/lib/callbacks/lanes";
import type { CallbackBoardRow } from "@/lib/db/callbacks";
import { dialDeepLink } from "@/lib/dialer/deep-link";
import { isInboundCallback } from "@/lib/inbound/routing";
import { cn, formatPhone, initials, relativeTime } from "@/lib/utils";
import {
  ScheduleCallbackDialog,
  type ScheduledCallback,
} from "@/components/dialer/schedule-callback-dialog";

// ─────────────────────────────────────────────────────────────────────────────
// The interactive Callbacks board. Lanes (overdue / due / upcoming + the
// escalation tiers) are DERIVED here against a ticking clock — see
// src/lib/callbacks/lanes.ts — never stored, so a slipping callback escalates
// on its own. Every action goes through the claim/lifecycle API:
//
//   Call back  → POST /api/callbacks/:id/claim, then /dialer?…&callback=:id —
//                the claim is atomic, so two reps can't work the same promise;
//                the deep-linked id is what completes the callback when the
//                call's disposition is filed.
//   Reschedule → the SAME dialog the dialer uses (one mental model for "when").
//   Reassign / priority — manager+ (assignments.manage), member select.
//   Done / Cancel / Re-open — the pre-existing /api/pipeline status path.
// ─────────────────────────────────────────────────────────────────────────────

const LANES: Array<{
  key: CallbackLane;
  title: string;
  tone: "danger" | "warning" | "accent";
  icon: typeof AlarmClock;
}> = [
  { key: "overdue", title: "Overdue", tone: "danger", icon: AlarmClock },
  { key: "due", title: "Due now", tone: "warning", icon: Clock },
  { key: "upcoming", title: "Upcoming", tone: "accent", icon: CheckCircle2 },
];

interface RowHandlers {
  callBack: (row: CallbackBoardRow) => void;
  setStatus: (row: CallbackBoardRow, status: "completed" | "cancelled" | "due") => void;
  cancelRow: (row: CallbackBoardRow) => void;
  reassign: (row: CallbackBoardRow, toUserId: string) => void;
  togglePriority: (row: CallbackBoardRow) => void;
  release: (row: CallbackBoardRow) => void;
  openReschedule: (row: CallbackBoardRow) => void;
}

function DueLabel({ row, now }: { row: CallbackBoardRow; now: number }) {
  const d = parseFloating(row.dueAt);
  if (!d) {
    // Honest: a callback with no agreed time is not "due now", it just never
    // got one.
    return <span className="text-xs font-medium text-muted-foreground/70">No time set</span>;
  }
  const tz = row.timezone ? timezoneLabel(row.timezone, d) : "";
  return (
    <span
      className="whitespace-nowrap text-xs font-medium text-muted-foreground tabular"
      title={`${formatDayLabel(d)} at ${formatTime(d)}${tz ? ` (${tz})` : ""}`}
    >
      {relativeTime(d.toISOString(), new Date(now))}
      {tz ? <span className="text-muted-foreground/70"> · {tz}</span> : null}
    </span>
  );
}

function EscalationBadge({ row, now }: { row: CallbackBoardRow; now: number }) {
  const tier = overdueTier(row.dueAt, now);
  if (!tier) return null;
  if (tier === "missed") {
    return (
      <Badge tone="danger" className="gap-1" title="More than 24 hours late">
        <AlarmClock className="h-3 w-3" /> Missed
      </Badge>
    );
  }
  if (tier === "amber") {
    return (
      <Badge tone="warning" title="More than 2 hours late">
        Running late
      </Badge>
    );
  }
  return <Badge tone="danger">Overdue</Badge>;
}

function ClaimChip({
  row,
  now,
  userId,
  onRelease,
}: {
  row: CallbackBoardRow;
  now: number;
  userId: string;
  onRelease: () => void;
}) {
  if (!isClaimActive(row.claimedBy, row.claimedAt, now)) return null;
  if (row.claimedBy === userId) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
        You&apos;re working this
        <button
          type="button"
          onClick={onRelease}
          className="font-medium underline-offset-2 hover:underline"
          title="Let go of this callback so a teammate can take it"
        >
          release
        </button>
      </span>
    );
  }
  const when = row.claimedAt ? relativeTime(row.claimedAt, new Date(now)) : "";
  return (
    <span
      className="inline-flex items-center rounded-lg bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      title="A teammate claimed this callback — claims free up after 15 quiet minutes"
    >
      {row.claimedByName || "A teammate"} claimed {when}
    </span>
  );
}

function RowCard({
  row,
  lane,
  now,
  userId,
  canManage,
  members,
  busy,
  h,
  fallbackName,
}: {
  row: CallbackBoardRow;
  lane: CallbackLane;
  now: number;
  userId: string;
  canManage: boolean;
  members: { id: string; name: string }[];
  busy: string | null;
  h: RowHandlers;
  fallbackName: string;
}) {
  const name = row.leadName || fallbackName;
  const claimedByOther =
    isClaimActive(row.claimedBy, row.claimedAt, now) && row.claimedBy !== userId;
  const assigneeName = row.assignedToName || row.repName;
  const rowBusy = busy?.startsWith(`${row.id}:`) ?? false;
  return (
    <div className="p-4">
      <div className="flex items-center gap-2.5">
        <Avatar initials={initials(name)} tone="chart-1" size="sm" />
        <div className="min-w-0 flex-1">
          {/* Name → Lead 360 when the callback is tied to a lead row; legacy
              rows without one stay plain text. */}
          {row.leadId ? (
            <LeadOpenLink leadId={row.leadId} className="block truncate text-sm font-semibold">
              {name}
            </LeadOpenLink>
          ) : (
            <p className="truncate text-sm font-semibold">{name}</p>
          )}
          <p className="truncate text-xs text-muted-foreground tabular">
            {row.phone ? formatPhone(row.phone) : "—"}
            {assigneeName && <span> · {assigneeName}</span>}
          </p>
        </div>
        <DueLabel row={row} now={now} />
        {(canManage || row.priority > 0) && (
          <button
            type="button"
            onClick={() => canManage && h.togglePriority(row)}
            disabled={!canManage || rowBusy}
            aria-pressed={row.priority > 0}
            aria-label={row.priority > 0 ? "Remove priority flag" : "Flag as priority"}
            title={
              canManage
                ? row.priority > 0
                  ? "Remove priority flag"
                  : "Flag as priority"
                : "Flagged priority"
            }
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
              row.priority > 0
                ? "text-warning hover:bg-warning/10"
                : "text-muted-foreground/50 hover:bg-muted hover:text-foreground",
              !canManage && "cursor-default hover:bg-transparent",
            )}
          >
            <Flag className={cn("h-3.5 w-3.5", row.priority > 0 && "fill-current")} />
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {/* A returned call outranks every scheduled promise on this board: the
            rest are things WE said we'd do, this is someone who already picked
            up the phone. Called out first so it can't be lost in a long list. */}
        {isInboundCallback(row.reason) && (
          <Badge
            tone="success"
            className="gap-1"
            title="This person called one of your numbers back — you didn't schedule it."
          >
            <PhoneIncoming className="h-3 w-3" />
            They called back
          </Badge>
        )}
        {lane === "overdue" && <EscalationBadge row={row} now={now} />}
        {row.campaignName && <Badge tone="neutral">{row.campaignName}</Badge>}
        {row.attemptCount > 0 && (
          <Badge tone="neutral" className="tabular">
            {row.attemptCount} attempt{row.attemptCount === 1 ? "" : "s"}
          </Badge>
        )}
        <ClaimChip row={row} now={now} userId={userId} onRelease={() => h.release(row)} />
        {row.callRecordId && row.leadId && (
          <LeadOpenLink
            leadId={row.leadId}
            className="text-[11px] font-medium text-accent"
            title="Open the full record — the source call is in its history"
          >
            View call
          </LeadOpenLink>
        )}
      </div>

      {row.reason && (
        <p className="mt-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
          {row.reason}
        </p>
      )}

      {canManage && members.length > 0 && (
        <label className="mt-2 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <span className="shrink-0">Assigned to</span>
          <select
            value={row.assignedTo ?? row.ownerId}
            onChange={(e) => h.reassign(row, e.target.value)}
            disabled={rowBusy}
            className="h-7 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs text-foreground disabled:opacity-50"
          >
            {!members.some((m) => m.id === (row.assignedTo ?? row.ownerId)) && (
              <option value={row.assignedTo ?? row.ownerId}>
                {assigneeName || "Unassigned"}
              </option>
            )}
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        <Button
          size="sm"
          variant={lane === "overdue" && !claimedByOther ? "primary" : "outline"}
          className="flex-1 gap-1.5"
          disabled={!row.phone || rowBusy}
          onClick={() => h.callBack(row)}
          title={
            !row.phone
              ? "No phone number on this callback"
              : claimedByOther
                ? `${row.claimedByName || "A teammate"} is working this — claiming will fail until their claim goes stale`
                : "Claim it and dial"
          }
        >
          {busy === `${row.id}:call` ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PhoneCall className="h-3.5 w-3.5" />
          )}
          Call back
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5"
          disabled={rowBusy}
          onClick={() => h.openReschedule(row)}
          title="Move it to a new agreed time"
        >
          <Clock className="h-3.5 w-3.5" />
          Reschedule
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={rowBusy}
          onClick={() => h.setStatus(row, "completed")}
          aria-label="Mark done"
          title="Mark done"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={rowBusy}
          onClick={() => h.cancelRow(row)}
          aria-label="Cancel callback"
          title="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ClosedRow({
  row,
  now,
  busy,
  onReopen,
  fallbackName,
}: {
  row: CallbackBoardRow;
  now: number;
  busy: string | null;
  onReopen: () => void;
  fallbackName: string;
}) {
  const name = row.leadName || fallbackName;
  const stamp = row.lastAttemptAt ?? row.createdAt;
  return (
    <div className="flex items-center gap-2.5 p-3.5">
      <Avatar initials={initials(name)} tone="chart-1" size="sm" />
      <div className="min-w-0 flex-1">
        {row.leadId ? (
          <LeadOpenLink leadId={row.leadId} className="block truncate text-sm font-medium">
            {name}
          </LeadOpenLink>
        ) : (
          <p className="truncate text-sm font-medium">{name}</p>
        )}
        <p className="truncate text-xs text-muted-foreground">
          {row.status === "completed" ? "Completed" : "Cancelled"}
          {stamp ? ` ${relativeTime(stamp, new Date(now))}` : ""}
          {row.attemptCount > 0 &&
            ` · ${row.attemptCount} attempt${row.attemptCount === 1 ? "" : "s"}`}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="gap-1.5"
        disabled={busy?.startsWith(`${row.id}:`) ?? false}
        onClick={onReopen}
        title="Put it back on the board"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Re-open
      </Button>
    </div>
  );
}

export function CallbackBoard({
  open,
  closed,
  members,
  canManage,
  userId,
  initialNow,
}: {
  open: CallbackBoardRow[];
  closed: CallbackBoardRow[];
  /** Active teammates, for the manager's reassign select. Empty for reps. */
  members: { id: string; name: string }[];
  /** Holder of `assignments.manage` — callbacks are distributed work. */
  canManage: boolean;
  userId: string;
  /** Server render's clock — first client render uses the SAME value so lanes
   *  and relative labels hydrate identically; a 30s tick takes over after. */
  initialNow: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const vocab = useVocabulary();

  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const [busy, setBusy] = useState<string | null>(null);
  const [resched, setResched] = useState<CallbackBoardRow | null>(null);

  const lanes = useMemo(() => {
    const by: Record<CallbackLane, CallbackBoardRow[]> = {
      overdue: [],
      due: [],
      upcoming: [],
    };
    for (const row of open) by[laneOf(row.dueAt, now)].push(row);
    for (const key of Object.keys(by) as CallbackLane[]) by[key].sort(compareCallbacks);
    return by;
  }, [open, now]);

  const recentlyCompleted = useMemo(
    () => closed.filter((r) => r.status === "completed"),
    [closed],
  );
  const cancelled = useMemo(() => closed.filter((r) => r.status === "cancelled"), [closed]);

  async function api(key: string, url: string, init: RequestInit, okMsg?: string) {
    setBusy(key);
    try {
      const res = await fetch(url, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast({
          title: "Couldn't save that",
          description: typeof j.error === "string" ? j.error : "Please try again.",
          tone: "danger",
        });
        return;
      }
      if (okMsg) toast({ title: okMsg, tone: "success" });
      router.refresh();
    } catch {
      toast({ title: "Network error", description: "Please try again.", tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  const handlers: RowHandlers = {
    async callBack(row) {
      const name = row.leadName || vocab.LeadNoun;
      setBusy(`${row.id}:call`);
      try {
        const res = await fetch(`/api/callbacks/${row.id}/claim`, { method: "POST" });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          claimedBy?: string;
          error?: string;
        };
        if (!res.ok) {
          toast({
            title: "Couldn't claim the callback",
            description: j.error ?? "Please try again.",
            tone: "danger",
          });
          return;
        }
        if (!j.ok) {
          // Someone else holds a live claim — honest, and nobody double-dials.
          toast({
            title: `${name} is being worked by a teammate`,
            description: j.claimedBy
              ? `${j.claimedBy} has this one — it frees up if they stall.`
              : undefined,
          });
          router.refresh();
          return;
        }
        router.push(dialDeepLink({ phone: row.phone, name, callbackId: row.id }));
      } catch {
        toast({ title: "Network error", description: "Please try again.", tone: "danger" });
      } finally {
        setBusy(null);
      }
    },
    setStatus(row, status) {
      const msg =
        status === "completed" ? "Marked done" : status === "cancelled" ? "Cancelled" : "Re-opened";
      void api(
        `${row.id}:${status}`,
        "/api/pipeline",
        { method: "POST", body: JSON.stringify({ action: "callback", id: row.id, status }) },
        msg,
      );
    },
    cancelRow(row) {
      void (async () => {
        const ok = await confirm({
          title: "Cancel this callback?",
          body: "It moves to Cancelled — you can re-open it later if they change their mind.",
          confirmLabel: "Cancel callback",
          tone: "danger",
        });
        if (ok) handlers.setStatus(row, "cancelled");
      })();
    },
    reassign(row, toUserId) {
      const name = members.find((m) => m.id === toUserId)?.name;
      void api(
        `${row.id}:reassign`,
        `/api/callbacks/${row.id}`,
        { method: "PATCH", body: JSON.stringify({ action: "reassign", toUserId }) },
        name ? `Reassigned to ${name}` : "Reassigned",
      );
    },
    togglePriority(row) {
      void api(
        `${row.id}:priority`,
        `/api/callbacks/${row.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ action: "priority", priority: row.priority > 0 ? 0 : 1 }),
        },
        row.priority > 0 ? "Flag removed" : "Flagged priority",
      );
    },
    release(row) {
      void api(
        `${row.id}:release`,
        `/api/callbacks/${row.id}`,
        { method: "PATCH", body: JSON.stringify({ action: "release" }) },
        "Claim released",
      );
    },
    openReschedule(row) {
      setResched(row);
    },
  };

  function confirmReschedule(row: CallbackBoardRow, cb: ScheduledCallback | null) {
    setResched(null);
    void api(
      `${row.id}:reschedule`,
      `/api/callbacks/${row.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          action: "reschedule",
          dueAt: cb?.iso ?? null,
          reason: cb?.reason || undefined,
        }),
      },
      cb ? `Rescheduled — ${cb.when}` : "Time cleared — it's due now",
    );
  }

  // Reschedule dialog wants first/last for its header — split the display name.
  const reschedLead = resched
    ? (() => {
        const [firstName, ...rest] = (resched.leadName || vocab.LeadNoun).split(" ");
        return { firstName: firstName ?? "", lastName: rest.join(" "), city: "" };
      })()
    : null;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {LANES.map((lane) => {
          const items = lanes[lane.key];
          const Icon = lane.icon;
          return (
            <Card key={lane.key} className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-border p-4">
                <div className="flex items-center gap-2">
                  <Icon
                    className={
                      lane.tone === "danger"
                        ? "h-4 w-4 text-danger"
                        : lane.tone === "warning"
                          ? "h-4 w-4 text-warning"
                          : "h-4 w-4 text-accent"
                    }
                  />
                  <h3 className="font-semibold">{lane.title}</h3>
                </div>
                <Badge tone={lane.tone}>{items.length}</Badge>
              </div>
              <div className="divide-y divide-border">
                {items.length === 0 && (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    Nothing waiting.
                  </p>
                )}
                {items.map((row) => (
                  <RowCard
                    key={row.id}
                    row={row}
                    lane={lane.key}
                    now={now}
                    userId={userId}
                    canManage={canManage}
                    members={members}
                    busy={busy}
                    h={handlers}
                    fallbackName={vocab.LeadNoun}
                  />
                ))}
              </div>
            </Card>
          );
        })}
      </div>

      {(recentlyCompleted.length > 0 || cancelled.length > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border p-4">
              <div className="flex items-center gap-2">
                <PhoneCall className="h-4 w-4 text-success" />
                <h3 className="font-semibold">Recently completed</h3>
              </div>
              <Badge tone="success">{recentlyCompleted.length}</Badge>
            </div>
            <div className="max-h-80 divide-y divide-border overflow-y-auto">
              {recentlyCompleted.length === 0 && (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  Nothing completed in the last 14 days.
                </p>
              )}
              {recentlyCompleted.map((row) => (
                <ClosedRow
                  key={row.id}
                  row={row}
                  now={now}
                  busy={busy}
                  onReopen={() => handlers.setStatus(row, "due")}
                  fallbackName={vocab.LeadNoun}
                />
              ))}
            </div>
          </Card>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border p-4">
              <div className="flex items-center gap-2">
                <PhoneOff className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-semibold">Cancelled</h3>
              </div>
              <Badge tone="neutral">{cancelled.length}</Badge>
            </div>
            <div className="max-h-80 divide-y divide-border overflow-y-auto">
              {cancelled.length === 0 && (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  Nothing cancelled in the last 14 days.
                </p>
              )}
              {cancelled.map((row) => (
                <ClosedRow
                  key={row.id}
                  row={row}
                  now={now}
                  busy={busy}
                  onReopen={() => handlers.setStatus(row, "due")}
                  fallbackName={vocab.LeadNoun}
                />
              ))}
            </div>
          </Card>
        </div>
      )}

      {resched && reschedLead && (
        <ScheduleCallbackDialog
          lead={reschedLead}
          defaultReason={resched.reason}
          onConfirm={(cb) => confirmReschedule(resched, cb)}
          // "No time agreed" clears the slot — it lands honestly in Due now.
          onSkip={() => confirmReschedule(resched, null)}
          onCancel={() => setResched(null)}
        />
      )}
    </>
  );
}
