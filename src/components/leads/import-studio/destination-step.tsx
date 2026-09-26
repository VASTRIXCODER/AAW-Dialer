"use client";

import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Destination step: which group the rows land in, which campaign they belong
// to (with the compliance-certification note — the gate itself is enforced
// server-side on every chunk), and whether to deal the file out into packs.
// ─────────────────────────────────────────────────────────────────────────────

export interface Destination {
  /** Org group key, or "__misc__" for the Miscellaneous bucket (lead_group NULL). */
  group: string;
  campaignId: string;
  packBy: "none" | "sequence" | "city" | "timezone";
  packSize: number;
}

const PACK_SIZES = [50, 100, 250, 500];

export function DestinationStep({
  groups,
  campaigns,
  dest,
  onChange,
  leadNounPlural,
  footer,
}: {
  groups: { key: string; label: string }[];
  campaigns: { id: string; name: string }[];
  dest: Destination;
  onChange: (d: Destination) => void;
  leadNounPlural: string;
  footer: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <Card className="space-y-5 p-5">
        <div>
          <h2 className="font-semibold tracking-tight">Where these {leadNounPlural} go</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Group, campaign, and how to deal the list out.
          </p>
        </div>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Group
          </span>
          <select
            value={dest.group}
            onChange={(e) => onChange({ ...dest, group: e.target.value })}
            className="mt-1.5 h-10 w-full max-w-sm rounded-xl border border-border bg-background/60 px-2.5 text-sm text-foreground focus-visible:border-primary/50 focus-visible:outline-none"
          >
            <option value="__misc__">Miscellaneous (unsorted)</option>
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Campaign
          </span>
          <select
            value={dest.campaignId}
            onChange={(e) => onChange({ ...dest, campaignId: e.target.value })}
            className="mt-1.5 h-10 w-full max-w-sm rounded-xl border border-border bg-background/60 px-2.5 text-sm text-foreground focus-visible:border-primary/50 focus-visible:outline-none"
          >
            <option value="">No campaign</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="mt-1.5 flex max-w-md items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            A list can't be dialed until its campaign is compliance-certified. If this
            one isn't yet, you'll be asked to certify before the import starts.
          </span>
        </label>

        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Packs
          </span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Deal a big list out a numbered pack at a time. Rows keep file order either way,
            except by time zone, which orders packs east to west for regional dialing shifts.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(
              [
                { v: "none", label: "No packs" },
                { v: "sequence", label: "By file order" },
                { v: "city", label: "By city" },
                { v: "timezone", label: "By time zone" },
              ] as const
            ).map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => onChange({ ...dest, packBy: o.v })}
                title={
                  o.v === "timezone"
                    ? "Each time zone gets its own pack, inferred from each lead's state and ZIP — Eastern first, Pacific last"
                    : undefined
                }
                className={cn(
                  "rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors",
                  dest.packBy === o.v
                    ? "bg-primary text-white"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          {dest.packBy !== "none" && (
            <div className="mt-3">
              <span className="text-xs text-muted-foreground">Pack size</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {PACK_SIZES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => onChange({ ...dest, packSize: n })}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors",
                      dest.packSize === n
                        ? "bg-primary text-white"
                        : "bg-muted text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      {footer}
    </div>
  );
}
