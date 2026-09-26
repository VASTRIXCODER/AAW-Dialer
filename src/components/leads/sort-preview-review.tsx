"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Loader2,
  MapPin,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ParsedLead } from "@/lib/leads/csv";
import type { LeadFieldDef } from "@/lib/leads/field-schema";
import { formatPhone } from "@/lib/utils";
import { CampaignCertificationDialog } from "./campaign-certification-dialog";

type PreviewLead = ParsedLead & { tempId: string };

/** The Miscellaneous bucket's key in this screen. Imports as `leadGroup: null`. */
export const MISC_KEY = "misc";

export interface SortPreviewGroup {
  key: string;
  label: string;
  kind: "sorted" | "manual";
}

export interface SortPreviewResponse {
  source: "claude" | "demo";
  chunkFailures: number;
  totalRows: number;
  sortedRows: number;
  deferredRows: number;
  groups: SortPreviewGroup[];
  buckets: Record<string, PreviewLead[]>;
  columnSource: "headers" | "ai";
  aiError: string | null;
  /** Custom-field defs the parse discovered — posted back with each bucket so
   *  the import route can register them in the org's field schema. */
  discoveredFields?: LeadFieldDef[];
}

type BucketState = "idle" | "pending" | "done" | "error";

/**
 * Preview-and-confirm for an AI sort. Nothing has been inserted yet — every
 * lead here is still only in memory, so the reviewer can move any of them
 * (including into a manual-kind group, which the classifier itself never
 * proposes) before anything is written.
 *
 * Buckets are the ORG'S groups plus Miscellaneous, which holds both the leads
 * the model couldn't place and every row past the sort limit.
 */
export function SortPreviewReview({
  preview,
  packSize,
  packBatch,
  packBy,
  onDone,
  onCancel,
}: {
  preview: SortPreviewResponse;
  /** Cut each confirmed bucket into packs of this size. 0 = don't pack. */
  packSize?: number;
  packBatch?: string;
  /** "sequence" slices each bucket in order; "city" gives each city its own
   *  pack(s) within the bucket, cities in first-appearance order; "timezone"
   *  gives each timezone (inferred from state+zip) its own pack(s), east to
   *  west. */
  packBy?: "sequence" | "city" | "timezone";
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();

  const bucketKeys = useMemo(
    () => [...preview.groups.map((g) => g.key), MISC_KEY],
    [preview.groups],
  );

  const labelOf = useMemo(() => {
    const m = new Map<string, string>(preview.groups.map((g) => [g.key, g.label]));
    m.set(MISC_KEY, "Miscellaneous");
    return m;
  }, [preview.groups]);

  const kindOf = useMemo(() => {
    const m = new Map<string, "sorted" | "manual">(preview.groups.map((g) => [g.key, g.kind]));
    return m;
  }, [preview.groups]);

  const byTempId = useMemo(() => {
    const m = new Map<string, PreviewLead>();
    for (const list of Object.values(preview.buckets)) {
      for (const l of list) m.set(l.tempId, l);
    }
    return m;
  }, [preview]);

  const [assignment, setAssignment] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [key, list] of Object.entries(preview.buckets)) {
      for (const l of list) init[l.tempId] = key;
    }
    return init;
  });
  const [bucketState, setBucketState] = useState<Record<string, BucketState>>({});
  const [bucketMsg, setBucketMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [certPrompt, setCertPrompt] = useState<{ campaignId: string | null } | null>(null);

  const buckets = useMemo(() => {
    const out: Record<string, PreviewLead[]> = {};
    for (const k of bucketKeys) out[k] = [];
    for (const [tempId, key] of Object.entries(assignment)) {
      const lead = byTempId.get(tempId);
      // A lead whose bucket vanished (a group deleted mid-review) falls back to
      // Miscellaneous rather than disappearing from the screen entirely.
      if (lead) (out[key] ?? out[MISC_KEY]).push(lead);
    }
    return out;
  }, [assignment, byTempId, bucketKeys]);

  function moveLead(tempId: string, key: string) {
    setAssignment((prev) => ({ ...prev, [tempId]: key }));
  }

  async function importBucket(key: string, list: PreviewLead[]): Promise<boolean> {
    setBucketState((s) => ({ ...s, [key]: "pending" }));
    try {
      const res = await fetch("/api/leads/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: list.map(({ tempId: _tempId, ...rest }) => rest),
          leadGroup: key === MISC_KEY ? null : key,
          // Sent with every bucket — the route merge dedupes, so repeats are
          // harmless and a partial-failure retry still registers the fields.
          ...(preview.discoveredFields?.length
            ? { discoveredFields: preview.discoveredFields }
            : {}),
          ...(packSize && packSize > 0
            ? {
                packSize,
                packBatch: `${packBatch ?? "Upload"} · ${labelOf.get(key) ?? key}`,
                packBy: packBy ?? "sequence",
              }
            : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.certificationRequired) {
        setBucketState((s) => ({ ...s, [key]: "idle" }));
        setCertPrompt((prev) => prev ?? { campaignId: json.campaignId ?? null });
        return false;
      }
      if (!res.ok || json.error) {
        setBucketState((s) => ({ ...s, [key]: "error" }));
        setBucketMsg((s) => ({ ...s, [key]: json.error ?? "Import failed." }));
        return false;
      }
      setBucketState((s) => ({ ...s, [key]: "done" }));
      const packNote = json.packs > 0 ? ` in ${json.packs} pack${json.packs === 1 ? "" : "s"}` : "";
      setBucketMsg((s) => ({ ...s, [key]: `Imported ${json.inserted} leads${packNote}.` }));
      return true;
    } catch {
      setBucketState((s) => ({ ...s, [key]: "error" }));
      setBucketMsg((s) => ({ ...s, [key]: "Network error." }));
      return false;
    }
  }

  // Only imports buckets NOT already "done", so retrying after a partial
  // failure never double-inserts the ones that already landed.
  async function confirm() {
    setBusy(true);
    const pending = bucketKeys.filter((k) => buckets[k].length > 0 && bucketState[k] !== "done");
    const results = await Promise.all(pending.map((k) => importBucket(k, buckets[k])));
    setBusy(false);
    if (results.every(Boolean)) {
      router.refresh();
      onDone();
    }
  }

  const anyErrors = bucketKeys.some((k) => bucketState[k] === "error");
  const allDone = bucketKeys.every((k) => buckets[k].length === 0 || bucketState[k] === "done");
  const totalPending = bucketKeys.reduce((n, k) => n + buckets[k].length, 0);

  return (
    <Card className="p-5">
      {certPrompt && (
        <CampaignCertificationDialog
          campaignId={certPrompt.campaignId}
          onCertified={() => {
            setCertPrompt(null);
            void confirm();
          }}
          onCancel={() => setCertPrompt(null)}
        />
      )}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h3 className="flex items-center gap-2 font-semibold tracking-tight">
            <Sparkles className="h-4 w-4 text-accent" />
            Review sorted leads
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {preview.sortedRows.toLocaleString()} of {preview.totalRows.toLocaleString()} sorted
            {preview.deferredRows > 0 && (
              <>
                {" "}
                · {preview.deferredRows.toLocaleString()} held in Miscellaneous for later
              </>
            )}
            {packSize && packSize > 0 ? ` · packs of ${packSize}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={preview.source === "claude" ? "accent" : "neutral"}>
            {preview.source === "claude" ? "Claude" : "Demo AI"}
          </Badge>
          {preview.chunkFailures > 0 && (
            <Badge tone="warning" title="Some batches fell back to rule-based matching">
              {preview.chunkFailures} batch{preview.chunkFailures === 1 ? "" : "es"} used fallback
            </Badge>
          )}
          {!busy && !allDone && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {preview.aiError && (
        <p className="mt-4 flex items-center gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {preview.aiError}
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {bucketKeys.map((key) => {
          const list = buckets[key] ?? [];
          const state = bucketState[key];
          const isMisc = key === MISC_KEY;
          const isManual = kindOf.get(key) === "manual";
          return (
            <div key={key} className="rounded-xl border border-border/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {isMisc ? (
                    <Inbox className="h-3.5 w-3.5 text-warning" />
                  ) : isManual ? (
                    <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <MapPin className="h-3.5 w-3.5 text-primary" />
                  )}
                  {labelOf.get(key) ?? key}
                </span>
                <Badge tone={isMisc ? "warning" : isManual ? "neutral" : "primary"}>
                  {list.length}
                </Badge>
              </div>
              {state === "done" && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  {bucketMsg[key]}
                </p>
              )}
              {state === "error" && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-danger">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {bucketMsg[key]}
                </p>
              )}
              {state !== "done" && list.length > 0 && (
                <ul className="mt-2 max-h-48 space-y-1.5 overflow-y-auto">
                  {list.slice(0, 25).map((l) => (
                    <li
                      key={l.tempId}
                      className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {[l.firstName, l.lastName].filter(Boolean).join(" ") ||
                            formatPhone(l.phone)}
                        </p>
                        <p className="truncate text-muted-foreground">
                          {[l.city, l.state, l.zip].filter(Boolean).join(", ") || "No location"}
                        </p>
                      </div>
                      <select
                        value={key}
                        onChange={(e) => moveLead(l.tempId, e.target.value)}
                        disabled={busy}
                        className="h-7 shrink-0 rounded-md border border-border bg-background px-1.5 text-[11px]"
                      >
                        {bucketKeys.map((k) => (
                          <option key={k} value={k}>
                            {labelOf.get(k) ?? k}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                  {list.length > 25 && (
                    <li className="px-2 py-1 text-center text-[11px] text-muted-foreground">
                      +{list.length - 25} more
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        {anyErrors && (
          <p className="text-xs text-danger">
            Some groups failed to import. Succeeded groups won&apos;t be re-inserted — click below
            to retry only what failed.
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!allDone && (
            <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            className="gap-1.5"
            onClick={confirm}
            disabled={busy || allDone || totalPending === 0}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {allDone ? "Imported" : anyErrors ? "Retry failed groups" : "Confirm import"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
