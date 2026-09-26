"use client";

import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Admin → Dialing's answer to "why is my max lines lower than I set, and how
// close am I to that happening." Self-fetching, like the caller-ID audit
// panel — see /api/twilio/abandonment-rate for what this reads and
// lib/dialer/abandonment.ts for the FTC rule (16 CFR §310.4(b)(4), 3%
// abandonment over a rolling 30 days) this whole feature exists for.
// ─────────────────────────────────────────────────────────────────────────────

interface Snapshot {
  rate: number;
  answered: number;
  abandoned: number;
  severity: "ok" | "warning" | "over_limit";
  windowDays: number;
  legalLimit: number;
  warnThreshold: number;
  minSampleForEnforcement: number;
  enforcing: boolean;
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function AbandonmentRateReadout() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/twilio/abandonment-rate")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((j: Snapshot) => {
        if (!cancelled) setSnap(j);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load the abandonment rate.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="text-xs text-muted-foreground">{error}</p>;
  }
  if (!snap) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading your abandonment rate…
      </p>
    );
  }

  const tone =
    snap.severity === "over_limit"
      ? "danger"
      : snap.severity === "warning"
        ? "warning"
        : "success";
  const Icon =
    snap.severity === "over_limit"
      ? ShieldAlert
      : snap.severity === "warning"
        ? AlertTriangle
        : CheckCircle2;

  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        tone === "danger" && "border-danger/40 bg-danger/5",
        tone === "warning" && "border-warning/40 bg-warning/5",
        tone === "success" && "border-border/70 bg-muted/20",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          className={cn(
            "h-4 w-4 shrink-0",
            tone === "danger" && "text-danger",
            tone === "warning" && "text-warning",
            tone === "success" && "text-success",
          )}
        />
        <span className="text-sm font-semibold">Abandonment rate</span>
        <span className="font-mono text-sm font-bold tabular-nums">{pct(snap.rate)}</span>
        <span className="text-xs text-muted-foreground">
          over the last {snap.windowDays} days · FTC limit {pct(snap.legalLimit)}
        </span>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {snap.answered === 0
          ? "No parallel-dial answers recorded yet — nothing to measure."
          : snap.answered < snap.minSampleForEnforcement
            ? `${snap.abandoned} of ${snap.answered} answered calls not connected to a rep. Too little volume yet to act on — reported for visibility only.`
            : snap.severity === "over_limit"
              ? `${snap.abandoned} of ${snap.answered} answered calls went ungreeted — over the legal limit. Max lines is held at 1 until this recovers.`
              : snap.severity === "warning"
                ? `${snap.abandoned} of ${snap.answered} answered calls went ungreeted — getting close to the ${pct(snap.legalLimit)} limit. Your configured line count still stands.`
                : `${snap.abandoned} of ${snap.answered} answered calls went ungreeted. Comfortably under the limit.`}
      </p>
    </div>
  );
}
