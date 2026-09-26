"use client";

import {
  AlertTriangle,
  Check,
  Clock,
  Inbox,
  Loader2,
  MapPin,
  Plus,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import type { LeadGroupWithCount } from "@/lib/db/lead-groups";
import { cn } from "@/lib/utils";

/**
 * Create, rename, describe and delete the workspace's lead groups.
 *
 * The `description` field is the point of this screen, not decoration: it's the
 * rule the AI sorts against, so "Dallas/Fort Worth area codes and cities" sorts
 * far better than a bare label like "North Texas". The copy says so, because an
 * admin who leaves it blank gets noticeably worse sorting and would otherwise
 * have no way to know why.
 *
 * Deleting never destroys leads — the group's leads fall back to Miscellaneous,
 * and the confirm text says how many will move.
 */
export function LeadGroupManager({
  initialGroups,
  initialMiscCount,
  initialMissingCountyCount,
  initialMissingTimezoneCount,
}: {
  initialGroups: LeadGroupWithCount[];
  initialMiscCount: number;
  /** Leads with a ZIP but no county yet (see getMissingCountyCount) — drives
   *  the "Backfill counties" control below. */
  initialMissingCountyCount: number;
  /** Leads with a state but no timezone yet (see getMissingTimezoneCount) —
   *  drives the "Backfill time zones" control below. */
  initialMissingTimezoneCount: number;
}) {
  const router = useRouter();
  const [groups, setGroups] = useState<LeadGroupWithCount[]>(initialGroups);
  const [miscCount, setMiscCount] = useState(initialMiscCount);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [newLabel, setNewLabel] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newManual, setNewManual] = useState(false);
  const [adding, setAdding] = useState(false);

  // "Sort more" — works through the Miscellaneous backlog N at a time.
  const [sorting, setSorting] = useState(false);
  const [sortMsg, setSortMsg] = useState<string | null>(null);

  // "Backfill counties" — a plain deterministic ZIP lookup (no AI, no token
  // budget — see src/lib/leads/zip-county.ts), so unlike Sort more this runs
  // one large batch per click instead of working a queue in small steps.
  const [missingCountyCount, setMissingCountyCount] = useState(initialMissingCountyCount);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);

  // "Backfill time zones" — the exact same shape, one column over (see
  // src/lib/leads/address-timezone.ts). A separate button rather than folding
  // into "Backfill counties": a lead can resolve a county without resolving a
  // timezone (no ZIP match) or vice versa (a state alone is enough for
  // timezone), so one button silently skipping half its own name would be
  // more confusing than two small, honest ones.
  const [missingTimezoneCount, setMissingTimezoneCount] = useState(
    initialMissingTimezoneCount,
  );
  const [backfillingTz, setBackfillingTz] = useState(false);
  const [backfillTzMsg, setBackfillTzMsg] = useState<string | null>(null);

  async function create() {
    if (!newLabel.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/lead-groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: newLabel,
          description: newDesc,
          kind: newManual ? "manual" : "sorted",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        setError(json.error ?? "Couldn't create that group.");
        return;
      }
      setGroups((g) => [...g, { ...json.group, leadCount: 0 }]);
      setNewLabel("");
      setNewDesc("");
      setNewManual(false);
      router.refresh();
    } finally {
      setAdding(false);
    }
  }

  async function patch(id: string, fields: Record<string, unknown>) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/lead-groups", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...fields }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        setError(json.error ?? "Couldn't save that change.");
        return;
      }
      setGroups((gs) =>
        gs.map((g) => (g.id === id ? { ...g, ...json.group, leadCount: g.leadCount } : g)),
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/lead-groups?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        setError(json.error ?? "Couldn't delete that group.");
        return;
      }
      setGroups((gs) => gs.filter((g) => g.id !== id));
      setMiscCount((n) => n + (json.movedToMisc ?? 0));
      setConfirmDelete(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function sortMore(limit: number) {
    setSorting(true);
    setSortMsg(null);
    try {
      const res = await fetch("/api/leads/sort-existing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        setSortMsg(json.error ?? "Couldn't sort those leads.");
        return;
      }
      setMiscCount(json.remaining ?? 0);
      setSortMsg(
        json.sorted === 0
          ? "Nothing left in Miscellaneous."
          : `Filed ${json.placed} of ${json.sorted} — ${json.remaining} still in Miscellaneous.`,
      );
      router.refresh();
    } catch {
      setSortMsg("Couldn't reach the server.");
    } finally {
      setSorting(false);
    }
  }

  async function backfillCounty() {
    setBackfilling(true);
    setBackfillMsg(null);
    try {
      const res = await fetch("/api/leads/backfill-county", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 10000 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        setBackfillMsg(json.error ?? "Couldn't backfill counties.");
        return;
      }
      setMissingCountyCount(json.remaining ?? 0);
      setBackfillMsg(
        json.checked === 0
          ? "Every lead with a ZIP already has a county."
          : `Filed ${json.updated} of ${json.checked}${
              json.unmatched ? ` (${json.unmatched} ZIP${json.unmatched === 1 ? "" : "s"} not recognized)` : ""
            } — ${json.remaining} left.`,
      );
      router.refresh();
    } catch {
      setBackfillMsg("Couldn't reach the server.");
    } finally {
      setBackfilling(false);
    }
  }

  async function backfillTimezone() {
    setBackfillingTz(true);
    setBackfillTzMsg(null);
    try {
      const res = await fetch("/api/leads/backfill-timezone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 10000 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        setBackfillTzMsg(json.error ?? "Couldn't backfill time zones.");
        return;
      }
      setMissingTimezoneCount(json.remaining ?? 0);
      setBackfillTzMsg(
        json.checked === 0
          ? "Every lead with a state already has a time zone."
          : `Filed ${json.updated} of ${json.checked}${
              json.unmatched
                ? ` (${json.unmatched} state${json.unmatched === 1 ? "" : "s"} not recognized)`
                : ""
            } — ${json.remaining} left.`,
      );
      router.refresh();
    } catch {
      setBackfillTzMsg("Couldn't reach the server.");
    } finally {
      setBackfillingTz(false);
    }
  }

  return (
    <div className="space-y-5">
      {error && (
        <p className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.id} className="rounded-xl border border-border/70 p-3">
            <div className="flex flex-wrap items-center gap-2">
              {g.kind === "manual" ? (
                <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <Sparkles className="h-4 w-4 shrink-0 text-primary" />
              )}
              <Input
                defaultValue={g.label}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== g.label) void patch(g.id, { label: v });
                }}
                className="h-8 max-w-[220px] flex-1"
              />
              <Badge tone="neutral">{g.leadCount.toLocaleString()}</Badge>
              <button
                type="button"
                onClick={() => void patch(g.id, { kind: g.kind === "manual" ? "sorted" : "manual" })}
                disabled={busy === g.id}
                title={
                  g.kind === "manual"
                    ? "Humans only — the AI never files leads here. Click to let AI sort into it."
                    : "AI may sort leads into this group. Click to make it human-only."
                }
                className={cn(
                  "rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors",
                  g.kind === "manual"
                    ? "border-border bg-muted text-muted-foreground"
                    : "border-primary/40 bg-primary-soft text-primary",
                )}
              >
                {g.kind === "manual" ? "Human-filed" : "AI-sorted"}
              </button>
              {confirmDelete === g.id ? (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void remove(g.id)}
                    disabled={busy === g.id}
                    className="flex items-center gap-1 rounded-lg bg-danger px-2 py-1 text-[11px] font-semibold text-danger-foreground"
                  >
                    {busy === g.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    Move {g.leadCount} to Misc & delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(null)}
                    className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(g.id)}
                  className="ml-auto rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                  title="Delete this group (its leads move to Miscellaneous)"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Textarea
              defaultValue={g.description}
              placeholder="How the AI should recognize this group — e.g. “Dallas/Fort Worth area codes and cities, ZIPs 750-753”"
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== g.description) void patch(g.id, { description: v });
              }}
              className="mt-2 min-h-[52px] text-xs"
            />
          </div>
        ))}
      </div>

      {/* Miscellaneous is not a row you can edit — it's every lead with no group. */}
      <div className="rounded-xl border border-warning/40 bg-warning/5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Inbox className="h-4 w-4 shrink-0 text-warning" />
          <span className="text-sm font-semibold">Miscellaneous</span>
          <Badge tone="warning">{miscCount.toLocaleString()}</Badge>
          <span className="text-xs text-muted-foreground">
            Everything not filed into a group yet
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            {[500, 2000].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => void sortMore(n)}
                disabled={sorting || miscCount === 0}
                className="flex items-center gap-1 rounded-lg border border-border bg-background/60 px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-muted disabled:opacity-50"
              >
                {sorting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                Sort {n.toLocaleString()} more
              </button>
            ))}
          </span>
        </div>
        {sortMsg && <p className="mt-2 text-xs text-muted-foreground">{sortMsg}</p>}
      </div>

      {/* County is a plain geographic fact computed from ZIP at import time —
          not an AI classification, so there's no ongoing queue to work like
          Miscellaneous. This only ever matters once per org: leads imported
          before this feature shipped, or with a since-corrected ZIP. */}
      <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-semibold">Counties</span>
          {missingCountyCount > 0 && (
            <Badge tone="warning">{missingCountyCount.toLocaleString()}</Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {missingCountyCount > 0
              ? "Leads with a ZIP but no county on file yet"
              : "Every lead with a ZIP has a county on file"}
          </span>
          <button
            type="button"
            onClick={() => void backfillCounty()}
            disabled={backfilling || missingCountyCount === 0}
            className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-background/60 px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-muted disabled:opacity-50"
          >
            {backfilling ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <MapPin className="h-3 w-3" />
            )}
            Backfill counties
          </button>
        </div>
        {backfillMsg && <p className="mt-2 text-xs text-muted-foreground">{backfillMsg}</p>}
      </div>

      {/* Time zone is also a plain fact, computed from state+zip at import
          time — same "only matters once per org" shape as county above. This
          is the field timezone-based lead-pack sorting groups leads by. */}
      <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-semibold">Time zones</span>
          {missingTimezoneCount > 0 && (
            <Badge tone="warning">{missingTimezoneCount.toLocaleString()}</Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {missingTimezoneCount > 0
              ? "Leads with a state but no time zone on file yet"
              : "Every lead with a state has a time zone on file"}
          </span>
          <button
            type="button"
            onClick={() => void backfillTimezone()}
            disabled={backfillingTz || missingTimezoneCount === 0}
            className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-background/60 px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-muted disabled:opacity-50"
          >
            {backfillingTz ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Clock className="h-3 w-3" />
            )}
            Backfill time zones
          </button>
        </div>
        {backfillTzMsg && (
          <p className="mt-2 text-xs text-muted-foreground">{backfillTzMsg}</p>
        )}
      </div>

      <div className="rounded-xl border border-dashed border-border p-3">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          New group
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <Label>Name</Label>
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="North Texas"
            />
          </div>
          <div>
            <Label>How the AI should recognize it</Label>
            <Input
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Dallas/Fort Worth area codes and cities"
            />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={newManual}
              onChange={(e) => setNewManual(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border"
            />
            Human-filed only — the AI never sorts leads into it
          </label>
          <Button
            size="sm"
            className="ml-auto gap-1.5"
            onClick={create}
            disabled={adding || !newLabel.trim()}
          >
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add group
          </Button>
        </div>
      </div>
    </div>
  );
}
