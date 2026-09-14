"use client";

import { motion } from "framer-motion";
import { BatteryCharging, Car, CircleEllipsis, FileText, Waves } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CountUp } from "@/components/motion";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  CORE_LEAD_FIELDS,
  leadFieldValue,
  parseFieldValue,
  type LeadFieldDef,
} from "@/lib/leads/field-schema";
import { leadSheetSections } from "@/lib/leads/lead-sheet";
import type { Lead } from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";

function Toggle({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: typeof Car;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.93 }}
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 400, damping: 22 }}
      className={cn(
        "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors duration-200",
        active
          ? "border-primary/50 bg-primary-soft text-primary shadow-[0_0_18px_-6px_hsl(var(--glow)/0.6)]"
          : "border-border bg-surface text-muted-foreground hover:bg-muted",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </motion.button>
  );
}

/** The solar-era icons keep their toggles; everything else gets a neutral dot. */
function toggleIcon(label: string): typeof Car {
  if (label === "EV") return Car;
  if (label === "Pool") return Waves;
  if (label === "Battery") return BatteryCharging;
  return CircleEllipsis;
}

/** Placeholder + input attributes per field type. */
function inputProps(def: LeadFieldDef): React.ComponentProps<typeof Input> {
  switch (def.type) {
    case "currency":
      return { inputMode: "decimal", placeholder: "$0" };
    case "number":
      return { inputMode: "decimal", placeholder: "0" };
    case "date":
      return { type: "date" };
    case "phone":
      return { inputMode: "tel", placeholder: "(555) 555-1234" };
    case "email":
      return { type: "email", placeholder: "name@example.com" };
    case "url":
      return { type: "url", placeholder: "https://" };
    default:
      return { placeholder: "—" };
  }
}

/** A stored value, rendered into an editable input's string form. */
function toInputString(
  value: string | number | boolean | null | undefined,
  type: LeadFieldDef["type"],
): string {
  if (value == null || value === "" || typeof value === "boolean") return "";
  if (type === "date") {
    const t = Date.parse(String(value));
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return String(value);
}

const DEFAULT_QUALIFY_FIELDS = CORE_LEAD_FIELDS.filter((f) => f.showInQualify);

function LeadSheetDetails({
  lead,
  fields,
  notes,
  onNotesChange,
}: {
  lead: Lead | null;
  fields?: LeadFieldDef[];
  notes: string;
  onNotesChange: (notes: string) => void;
}) {
  if (!lead) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
        <div className="flex items-center gap-2 text-primary">
          <FileText className="h-4 w-4" />
          <span className="text-sm font-semibold">Lead sheet</span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Select a lead to see the information imported with it.
        </p>
      </div>
    );
  }

  const sections = leadSheetSections(lead, fields);

  return (
    <section className="space-y-4" aria-labelledby="lead-sheet-heading">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <FileText className="h-3.5 w-3.5" aria-hidden />
        </span>
        <div>
          <h4 id="lead-sheet-heading" className="text-sm font-semibold">
            Lead sheet
          </h4>
          <p className="text-xs text-muted-foreground">
            All information imported for this lead.
          </p>
        </div>
      </div>

      {sections.map((section) => (
        <div key={section.key}>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
            {section.label}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {section.entries.map((entry) => (
              <div key={entry.key} className="min-w-0">
                <dt className="text-[11px] font-medium text-muted-foreground">{entry.label}</dt>
                <dd className="break-words text-sm leading-snug">{entry.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}

      <div>
        <p className="mb-2.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          Notes
        </p>
        <Textarea
          placeholder="Lifestyle changes, objections, follow-ups…"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
        />
      </div>
    </section>
  );
}

export function QualifyPanel({
  lead,
  notes: controlledNotes,
  onNotesChange,
  fields,
  leadFields,
}: {
  lead: Lead | null;
  /**
   * Controlled notes. The wrap-up screen edits the SAME note as this panel — a
   * rep typing "call back Thursday" while dispositioning shouldn't have to find
   * a different textarea in another column — so the value is lifted to the
   * dialer page and both views read it from there.
   */
  notes?: string;
  onNotesChange?: (notes: string) => void;
  /** The fields to render, in order — the org's resolved qualify schema. */
  fields?: LeadFieldDef[];
  /** Full resolved schema — gives the lead-sheet view every imported CSV column. */
  leadFields?: LeadFieldDef[];
}) {
  const defs = fields ?? DEFAULT_QUALIFY_FIELDS;
  const inputs = defs.filter((f) => f.type !== "boolean");
  const toggles = defs.filter((f) => f.type === "boolean");

  // Prefill from the lead — these inputs now PERSIST (see queueChange below),
  // so showing the stored values is honest rather than leaving blanks over
  // placeholders that silently discarded whatever the rep typed.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (lead) {
      for (const def of inputs) init[def.key] = toInputString(leadFieldValue(lead, def), def.type);
    }
    return init;
  });
  const [flags, setFlags] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    if (lead) {
      for (const def of toggles) init[def.key] = leadFieldValue(lead, def) === true;
    }
    return init;
  });
  const [ownNotes, setOwnNotes] = useState(lead?.notes ?? "");
  const notes = controlledNotes ?? ownNotes;

  // ── Persistence (debounced 800ms) ──────────────────────────────────────────
  // These entries used to be local state only — reps thought they were saving
  // data, and every keystroke evaporated when the queue advanced (the panel is
  // remounted per lead). Each change now lands on the lead via
  // POST /api/leads/update: core slots as their camelCase patch fields, custom
  // keys under `customFields` (tolerated as a no-op until the route accepts it).
  const leadId = lead?.id ?? null;
  const pendingRef = useRef<Record<string, string | number | boolean | null>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defsRef = useRef(defs);
  defsRef.current = defs;

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!leadId || Object.keys(pending).length === 0) return;
    pendingRef.current = {};
    const body: Record<string, unknown> = { id: leadId, leadId };
    const custom: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(pending)) {
      const def = defsRef.current.find((d) => d.key === key);
      if (def?.source === "custom") {
        // Custom values must stay scalar — a cleared field persists as "".
        custom[key] = value ?? "";
      } else {
        body[key] = value;
      }
    }
    if (Object.keys(custom).length > 0) body.customFields = custom;
    // keepalive so a save racing a lead advance / navigation still lands.
    void fetch("/api/leads/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {
      /* transient — the rep's screen already shows their entry */
    });
  }, [leadId]);

  const flushRef = useRef(flush);
  flushRef.current = flush;
  // The panel is remounted per lead (key={lead.id}) — flush whatever is still
  // pending on the way out so a fast disposition never outruns the debounce.
  useEffect(() => () => flushRef.current(), []);

  const queueChange = useCallback(
    (def: LeadFieldDef, raw: string | boolean) => {
      if (!leadId) return;
      let value: string | number | boolean | null;
      if (typeof raw === "boolean") {
        value = raw;
      } else if (def.type === "currency" || def.type === "number") {
        const trimmed = raw.trim();
        if (trimmed === "") {
          value = null; // clears the field
        } else {
          const parsed = parseFieldValue(trimmed, def.type);
          if (typeof parsed !== "number") return; // not a number yet — wait
          value = parsed;
        }
      } else {
        value = raw;
      }
      pendingRef.current[def.key] = value;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flushRef.current(), 800);
    },
    [leadId],
  );

  // Combined monthly total — only meaningful when the classic solar pair is on
  // screen (utility bill + solar payment); otherwise it would just echo one
  // field back at the rep.
  const billDef = inputs.find((f) => f.key === "utilityBill");
  const solarDef = inputs.find((f) => f.key === "solarPayment");
  const showTotal = Boolean(billDef && solarDef);
  const total =
    (Number(values.utilityBill) || lead?.utilityBill || 0) +
    (Number(values.solarPayment) || lead?.solarPayment || 0);

  const inputsTitle = inputs.some((f) => f.type === "currency") ? "Billing" : "Details";
  const togglesTitle = toggles.some((f) => ["EV", "Pool", "Battery"].includes(f.label))
    ? "Home profile"
    : "Profile";

  return (
    <div className="space-y-5">
      <LeadSheetDetails
        lead={lead}
        fields={leadFields}
        notes={notes}
        onNotesChange={(next) => {
          setOwnNotes(next);
          onNotesChange?.(next);
        }}
      />

      {inputs.length > 0 && (
        <div>
          <p className="mb-2.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {inputsTitle}
          </p>
          <div className={cn("grid gap-3", inputs.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
            {inputs.map((def) => (
              <div key={def.key} className={cn(def.type === "url" && "col-span-full")}>
                <Label>{def.label}</Label>
                <Input
                  {...inputProps(def)}
                  value={values[def.key] ?? ""}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [def.key]: e.target.value }));
                    queueChange(def, e.target.value);
                  }}
                />
              </div>
            ))}
          </div>
          {/* With no solar payment the "total" would just echo the utility bill,
              so the combined line only appears when both figures are present. */}
          {showTotal && (
            <div className="mt-3 flex items-center justify-between rounded-xl bg-muted px-3.5 py-2.5">
              <span className="text-sm text-muted-foreground">Total energy cost</span>
              <span className="text-lg font-bold tabular text-primary">
                <CountUp
                  value={total}
                  duration={0.5}
                  format={(n) => formatCurrency(Math.round(n))}
                />
                <span className="text-xs font-normal text-muted-foreground">/mo</span>
              </span>
            </div>
          )}
        </div>
      )}

      {toggles.length > 0 && (
        <div>
          <p className="mb-2.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {togglesTitle}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {toggles.map((def) => (
              <Toggle
                key={def.key}
                label={def.label}
                icon={toggleIcon(def.label)}
                active={flags[def.key] ?? false}
                onClick={() => {
                  const next = !(flags[def.key] ?? false);
                  setFlags((f) => ({ ...f, [def.key]: next }));
                  queueChange(def, next);
                }}
              />
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
