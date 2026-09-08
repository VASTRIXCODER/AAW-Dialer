"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  CheckCircle2,
  Copy,
  KeyRound,
  Lock,
  Loader2,
  Phone,
  PhoneIncoming,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useVocabulary } from "@/components/layout/vocabulary";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { EMILY_SYSTEM_PROMPT } from "@/lib/ai/agent-prompt";
import { describeDays, describeWindows } from "@/lib/dialer/schedule";
import {
  customDispositionKey,
  DISPOSITION_BEHAVIORS,
  resolveDispositionDefs,
  type DispositionBehavior,
  type DispositionDef,
} from "@/lib/dispositions/defs";
import { resolveLeadFields, type LeadFieldDef } from "@/lib/leads/field-schema";
import type { OrgFull, OrgSettings, OrgUpdate } from "@/lib/org/membership";
import {
  DEFAULT_DIALER_LAYOUT,
  type DialerLayout,
  type DispositionTone,
} from "@/lib/org/settings";
import { BEHAVIOR_DESCRIPTIONS } from "@/lib/status";
import { DIALER_TEMPLATES, templateProfile } from "@/lib/org/templates";
import { ROLE_LABEL } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const LAYOUT_TOGGLES: { key: keyof DialerLayout; label: string; hint: string }[] = [
  {
    key: "floor",
    label: "Live floor",
    hint: "Org-wide strip of who's dialing right now and calls made today.",
  },
  {
    key: "bookedTab",
    label: "Booked tab",
    hint: "A tab beside the dial queue listing leads already on the calendar.",
  },
  {
    key: "scriptCard",
    label: "Script card",
    hint: "Collapsible campaign call script above the qualify checklist.",
  },
  {
    key: "aiBriefing",
    label: "AI briefing",
    hint: "AI-generated lead briefing at the top of the qualify panel.",
  },
  {
    key: "callHistory",
    label: "Call history",
    hint: "The current lead's past calls, shown in the lead panel.",
  },
  {
    key: "upNext",
    label: "Up-next list",
    hint: "Preview of the next few leads in the queue.",
  },
  {
    key: "closerNotes",
    label: "Closer notes",
    hint: "Handoff-notes slot at the bottom of the qualify column (under construction).",
  },
];

const FEATURE_FLAGS: { key: keyof OrgSettings["features"]; label: string }[] = [
  { key: "aiDialer", label: "AI calling" },
  { key: "manualDialer", label: "Manual dialing" },
  { key: "leads", label: "Leads" },
  { key: "appointments", label: "Appointments" },
  { key: "callbacks", label: "Callbacks" },
  // The "set aside for later" workspace (/bills-fine). Was consumed by the nav
  // but had no admin control — the one flag you couldn't reach.
  { key: "billsFine", label: "Set-aside list" },
  { key: "liveMonitor", label: "Live monitor" },
  { key: "leaderboard", label: "Leaderboard" },
  { key: "campaigns", label: "Campaigns" },
  { key: "reports", label: "Reports" },
  { key: "aiAgent", label: "AI agent" },
  { key: "crm", label: "CRM workspace" },
];

export function OrgSettingsForm({
  org,
  canDelete,
  isSuperadmin = false,
  hasAiPermission = false,
  platformPool = [],
  platformRotateEvery = 1,
  platformPoolLocked = false,
}: {
  org: OrgFull;
  canDelete: boolean;
  isSuperadmin?: boolean;
  hasAiPermission?: boolean;
  platformPool?: string[];
  platformRotateEvery?: number;
  platformPoolLocked?: boolean;
}) {
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const [identity, setIdentity] = useState({
    name: org.name,
    productName: org.productName,
    tagline: org.tagline,
    description: org.description,
    industry: org.industry,
    website: org.website,
    dialerTemplate: org.dialerTemplate,
    brandColor: org.brandColor,
    accentColor: org.accentColor,
    logoUrl: org.logoUrl,
  });
  const [access, setAccess] = useState({
    requireApproval: org.requireApproval,
    allowJoin: org.allowJoin,
    defaultRole: org.defaultRole as string,
  });
  const [joinCode, setJoinCode] = useState(org.joinCode);
  const [timezone, setTimezone] = useState(org.timezone);
  const [dialing, setDialing] = useState<OrgSettings["dialing"]>(org.settings.dialing);
  const vocab = useVocabulary();
  // The inbound node reads through mergeSettings, so an org saved before this
  // existed still lands on a fully-populated object rather than undefined.
  const inbound = dialing.inbound;
  const setInbound = (next: OrgSettings["dialing"]["inbound"]) =>
    setDialing({ ...dialing, inbound: next });
  const [automation, setAutomation] = useState<OrgSettings["automation"]>(
    org.settings.automation,
  );
  const [hours, setHours] = useState<OrgSettings["hours"]>(org.settings.hours);
  const [ai, setAi] = useState<OrgSettings["ai"]>(() => {
    // Surface the built-in solar (Emily) script so it's visible/editable/copyable.
    const base = org.settings.ai;
    if (org.dialerTemplate === "solar" && !base.systemPrompt) {
      return { ...base, systemPrompt: EMILY_SYSTEM_PROMPT };
    }
    return base;
  });
  const [compliance, setCompliance] = useState<OrgSettings["compliance"]>(
    org.settings.compliance,
  );
  // The org's RESOLVED disposition taxonomy — keyed, behavior-carrying rows
  // (legacy { label, tone } blobs are migrated on read). What's edited here is
  // exactly what the wrap-up OutcomeGrid renders and the AI agent categorizes
  // into, so this editor is no longer a dead control.
  const [dispositions, setDispositions] = useState<DispositionDef[]>(() =>
    resolveDispositionDefs(org.settings.dispositions),
  );
  // The inline "add a custom disposition" mini-form (null = collapsed).
  const [newDispo, setNewDispo] = useState<{
    label: string;
    behavior: DispositionBehavior;
    tone: DispositionTone;
  } | null>(null);

  function updateDisposition(index: number, patch: Partial<DispositionDef>) {
    setDispositions((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function moveDisposition(index: number, dir: -1 | 1) {
    setDispositions((prev) => {
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[j]] = [next[j], next[index]];
      return next.map((d, i) => ({ ...d, sortOrder: i }));
    });
  }

  function addCustomDisposition() {
    if (!newDispo) return;
    const label = newDispo.label.trim();
    if (!label) return;
    // Key = x_<slug of the label>, minted ONCE here — later renames keep the
    // key stable so historical call records keep pointing at this row.
    const base = customDispositionKey(label);
    const keys = new Set(dispositions.map((d) => d.key));
    let key = base;
    for (let n = 2; keys.has(key); n++) key = `${base}_${n}`;
    setDispositions((prev) => [
      ...prev,
      {
        key,
        label,
        tone: newDispo.tone,
        behavior: newDispo.behavior,
        enabled: true,
        system: false,
        sortOrder: prev.length,
      },
    ]);
    setNewDispo(null);
  }
  const [features, setFeatures] = useState<OrgSettings["features"]>(
    org.settings.features,
  );
  const [terms, setTerms] = useState({
    leadNoun: org.settings.leadNoun,
    leadNounPlural: org.settings.leadNounPlural,
  });
  const [costRates, setCostRates] = useState<OrgSettings["costRates"]>(
    org.settings.costRates,
  );
  // Leaderboard scoring — already resolved through mergeLeaderboardSettings on
  // read, so every field is present even for orgs saved before F2.
  const [lb, setLb] = useState<OrgSettings["leaderboard"]>(org.settings.leaderboard);
  const setLbPoint = (key: keyof OrgSettings["leaderboard"]["points"], n: number) =>
    setLb({ ...lb, points: { ...lb.points, [key]: Math.max(0, n) } });
  // ── Dialer layout, qualify fields & lead-field schema ──────────────────────
  // The toggles show the EFFECTIVE state (template preset ⊕ stored overrides);
  // saving pins the whole section explicitly for this workspace.
  const profile = templateProfile(org.dialerTemplate);
  const [layoutCfg, setLayoutCfg] = useState<DialerLayout>(() => ({
    ...DEFAULT_DIALER_LAYOUT,
    ...(profile.dialerLayout ?? {}),
    ...(org.settings.dialerLayout ?? {}),
  }));
  // The org's effective field schema — core slots (template relabels applied)
  // plus custom fields discovered from CSV imports.
  const [leadFieldRows, setLeadFieldRows] = useState<LeadFieldDef[]>(() =>
    resolveLeadFields(org.settings.leadFields, profile.fields),
  );
  const [qualifyKeys, setQualifyKeys] = useState<string[]>(() => {
    const schema = resolveLeadFields(org.settings.leadFields, profile.fields);
    const explicit = org.settings.qualify?.fields;
    if (explicit?.length) return explicit.filter((k) => schema.some((f) => f.key === k));
    const preset = profile.qualifyFields;
    if (preset?.length) return preset.filter((k) => schema.some((f) => f.key === k));
    return schema.filter((f) => f.showInQualify).map((f) => f.key);
  });

  async function save(patch: OrgUpdate, key: string): Promise<boolean> {
    setBusy(key);
    setErr("");
    setSaved(null);
    try {
      const res = await fetch("/api/org/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.error ?? "Could not save.");
        return false;
      }
      setSaved(key);
      router.refresh();
      setTimeout(() => setSaved((s) => (s === key ? null : s)), 2500);
      return true;
    } catch {
      setErr("Network error.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function rotateCode() {
    setBusy("code");
    setErr("");
    try {
      const res = await fetch("/api/org/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rotateCode" }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok && j.code) {
        setJoinCode(j.code);
        router.refresh();
      } else setErr(j.error ?? "Could not rotate code.");
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(null);
    }
  }

  async function deleteOrg() {
    const ok = await confirmDialog({
      title: `Delete ${org.name}?`,
      body: "This removes the organization for everyone.",
      tone: "danger",
      confirmLabel: "Delete organization",
    });
    if (!ok) return;
    setBusy("delete");
    try {
      const res = await fetch("/api/org/settings", { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (j.ok) {
        router.push("/hub");
        router.refresh();
      } else setErr(j.error ?? "Could not delete.");
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(null);
    }
  }

  const SaveBtn = ({ k, onClick }: { k: string; onClick: () => void }) => (
    <Button size="sm" className="gap-2" disabled={busy === k} onClick={onClick}>
      {busy === k ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : saved === k ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        <Save className="h-4 w-4" />
      )}
      {saved === k ? "Saved" : "Save"}
    </Button>
  );

  return (
    <div className="space-y-4">
      {err && (
        <p className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
          <AlertTriangle className="h-4 w-4" />
          {err}
        </p>
      )}

      {/* Identity & branding */}
      <SectionCard
        title="Identity & branding"
        description="How your organization presents across the dialer."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Organization name">
            <Input
              value={identity.name}
              onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
            />
          </Field>
          <Field label="Product name">
            <Input
              value={identity.productName}
              placeholder="e.g. Sunrun Resolution Dialer"
              onChange={(e) => setIdentity({ ...identity, productName: e.target.value })}
            />
          </Field>
          <Field label="Tagline">
            <Input
              value={identity.tagline}
              onChange={(e) => setIdentity({ ...identity, tagline: e.target.value })}
            />
          </Field>
          <Field label="Industry">
            <Input
              value={identity.industry}
              onChange={(e) => setIdentity({ ...identity, industry: e.target.value })}
            />
          </Field>
          <Field label="Specialization">
            <Select
              value={identity.dialerTemplate}
              onChange={(e) =>
                setIdentity({ ...identity, dialerTemplate: e.target.value })
              }
            >
              {DIALER_TEMPLATES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label} — {t.blurb}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Website">
            <Input
              value={identity.website}
              placeholder="https://"
              onChange={(e) => setIdentity({ ...identity, website: e.target.value })}
            />
          </Field>
          <Field label="Brand color">
            <ColorInput
              value={identity.brandColor}
              onChange={(v) => setIdentity({ ...identity, brandColor: v })}
            />
          </Field>
          <Field label="Accent color">
            <ColorInput
              value={identity.accentColor}
              onChange={(v) => setIdentity({ ...identity, accentColor: v })}
            />
          </Field>
          <Field label="Logo URL" className="sm:col-span-2">
            <Input
              value={identity.logoUrl}
              placeholder="https://…/logo.png"
              onChange={(e) => setIdentity({ ...identity, logoUrl: e.target.value })}
            />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea
              value={identity.description}
              onChange={(e) => setIdentity({ ...identity, description: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <SaveBtn k="identity" onClick={() => save(identity, "identity")} />
        </div>
      </SectionCard>

      {/* Membership & access */}
      <SectionCard
        title="Membership & access"
        description="Control who can join and how new members are handled."
      >
        <div className="space-y-3">
          <Toggle
            label="Require approval to join"
            hint="New join requests must be approved by a manager."
            checked={access.requireApproval}
            onChange={(v) => setAccess({ ...access, requireApproval: v })}
          />
          <Toggle
            label="Allow new members to join"
            hint="Turn off to freeze the organization to its current members."
            checked={access.allowJoin}
            onChange={(v) => setAccess({ ...access, allowJoin: v })}
          />
          <Field label="Default role for new members">
            <Select
              value={access.defaultRole}
              onChange={(e) => setAccess({ ...access, defaultRole: e.target.value })}
            >
              {(["rep", "manager", "admin"] as const).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <SaveBtn
            k="access"
            onClick={() =>
              save(
                {
                  requireApproval: access.requireApproval,
                  allowJoin: access.allowJoin,
                  defaultRole: access.defaultRole as OrgUpdate["defaultRole"],
                },
                "access",
              )
            }
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/40 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <KeyRound className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Join code
            </p>
            <p className="font-mono text-xl font-bold tracking-[0.25em]">{joinCode}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => navigator.clipboard?.writeText(joinCode)}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy === "code"}
            onClick={rotateCode}
          >
            {busy === "code" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            Rotate
          </Button>
        </div>
      </SectionCard>

      {/* Dialing */}
      <SectionCard
        title="Dialing"
        description="How the power dialer places and paces calls."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Default dialer mode">
            <Select
              value={dialing.defaultMode}
              onChange={(e) =>
                setDialing({
                  ...dialing,
                  defaultMode: e.target.value as typeof dialing.defaultMode,
                })
              }
            >
              <option value="ai">AI (when available)</option>
              <option value="manual">Manual</option>
              <option value="parallel">Parallel (multi-line)</option>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              Which mode the dialer opens in. Reps can still switch modes they have
              access to; AI falls back to manual for anyone who can’t use it.
            </p>
          </Field>
          <Field label="Caller ID">
            <Input
              value={dialing.callerId}
              placeholder="+1…"
              onChange={(e) => setDialing({ ...dialing, callerId: e.target.value })}
            />
          </Field>
          <NumberField
            label="Max concurrent lines"
            value={dialing.maxLines}
            onChange={(n) => setDialing({ ...dialing, maxLines: n })}
          />
          <NumberField
            label="Ring timeout (sec)"
            hint="How long an outbound call rings before giving up (5–60)."
            value={dialing.ringTimeoutSec}
            onChange={(n) => setDialing({ ...dialing, ringTimeoutSec: n })}
          />
          <NumberField
            label="Max attempts per lead (0 = unlimited)"
            hint="Claimed dialing skips leads already dialed this many times."
            value={dialing.maxAttemptsPerLead}
            onChange={(n) => setDialing({ ...dialing, maxAttemptsPerLead: Math.max(0, n) })}
          />
          <NumberField
            label="Re-dial cooldown (min, 0 = none)"
            hint="Claimed dialing holds a lead out this long after any attempt. Due callbacks bypass it."
            value={dialing.redialCooldownMin}
            onChange={(n) => setDialing({ ...dialing, redialCooldownMin: Math.max(0, n) })}
          />
          <NumberField
            label="Rotate caller ID every (calls)"
            value={dialing.rotateEvery}
            onChange={(n) => setDialing({ ...dialing, rotateEvery: Math.max(1, n) })}
          />
        </div>
        <div className="mt-4">
          {platformPoolLocked && !isSuperadmin ? (
            /* Non-superadmin sees the platform pool as read-only. */
            <div className="rounded-xl border border-border bg-muted/30 p-4">
              <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                <Lock className="h-3.5 w-3.5" />
                Platform caller ID pool — managed by platform administrator
              </p>
              <div className="space-y-1">
                {platformPool.map((n) => (
                  <div key={n} className="flex items-center gap-2 text-sm">
                    <Phone className="h-3.5 w-3.5 text-primary" />
                    <span className="font-mono">{n}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Rotates every{" "}
                <span className="font-semibold">{Math.max(1, platformRotateEvery)}</span>{" "}
                call{platformRotateEvery === 1 ? "" : "s"} per rep — spreading volume across the
                pool to protect deliverability. Contact your platform administrator to modify
                the pool.
              </p>
            </div>
          ) : (
            /* Superadmin or no platform lock — fully editable. */
            <>
              {isSuperadmin && platformPoolLocked && (
                <p className="mb-2 flex items-center gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
                  <Lock className="h-3.5 w-3.5" />
                  Platform pool is active (TWILIO_CALLER_IDS env var). Org-level overrides are
                  ignored while the env var is set — change it in Vercel to modify the pool.
                </p>
              )}
              <Field label="Caller ID rotation pool">
                <Textarea
                  value={(dialing.callerIds ?? []).join("\n")}
                  placeholder={"+13466456704\n+1…  (one number per line)"}
                  onChange={(e) =>
                    setDialing({
                      ...dialing,
                      callerIds: e.target.value
                        .split(/[\n,]/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
              <p className="mt-1.5 text-xs text-muted-foreground">
                One E.164 number per line. The dialer cycles through these for both manual and AI
                calls, switching every{" "}
                <span className="font-semibold tabular">
                  {Math.max(1, dialing.rotateEvery || 1)}
                </span>{" "}
                call{(dialing.rotateEvery || 1) === 1 ? "" : "s"}. Leave empty to always use the
                single Caller ID above.
              </p>
            </>
          )}
        </div>
        {/* ── Inbound: what happens when someone rings these numbers BACK ─────
            Until this existed every pool number was write-only — the dialer
            rang out from them and anyone returning the call was hung up on. */}
        <div className="mt-4 rounded-xl border border-border/70 bg-surface/50 p-4">
          <div className="flex items-center gap-2">
            <PhoneIncoming className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">Inbound calls</h4>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            What a person hears when they call one of the numbers above back. A returned
            call always lands on the Callbacks tab, whatever this is set to.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="When someone calls back">
              <Select
                value={inbound.mode}
                onChange={(e) =>
                  setInbound({ ...inbound, mode: e.target.value as typeof inbound.mode })
                }
              >
                <option value="off">Don&apos;t answer — numbers stay outbound-only</option>
                <option value="forward">Ring the rep who owns the lead</option>
                <option value="voicemail">Answer and take a message</option>
                <option value="ai">Hand the caller to the AI agent</option>
              </Select>
            </Field>
            {inbound.mode === "forward" && (
              <NumberField
                label="Ring for (sec)"
                hint="5–60. Twilio refuses anything outside that, so it's clamped on save."
                value={inbound.forwardTimeoutSec ?? 25}
                onChange={(v) => setInbound({ ...inbound, forwardTimeoutSec: v })}
              />
            )}
          </div>

          {inbound.mode === "ai" && (
            <p className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
              To have the agent actually answer, the number must be assigned to it in
              ElevenLabs (Conversational AI → Phone Numbers → Inbound). That hands the
              number&apos;s webhook to ElevenLabs, so this app stops seeing the call — no
              Callbacks row and no rep text. Until you do that, callers get the greeting
              and a voicemail box.
            </p>
          )}

          {inbound.mode !== "off" && (
            <div className="mt-3 space-y-3">
              <Field label="Greeting">
                <Input
                  value={inbound.greeting}
                  placeholder="Thanks for calling {org}. Connecting you now."
                  onChange={(e) => setInbound({ ...inbound, greeting: e.target.value })}
                />
              </Field>
              <p className="-mt-1.5 text-xs text-muted-foreground">
                Spoken before anything else. <code>{"{org}"}</code> becomes your
                organization name. Leave empty for a neutral default.
              </p>
              {inbound.mode === "forward" && (
                <>
                  <Field label="Fallback number">
                    <Input
                      value={inbound.fallbackNumber}
                      placeholder="+18175550100"
                      onChange={(e) =>
                        setInbound({ ...inbound, fallbackNumber: e.target.value })
                      }
                    />
                  </Field>
                  <p className="-mt-1.5 text-xs text-muted-foreground">
                    Where calls go when the caller isn&apos;t a known {vocab.leadNoun}, or
                    the owning rep hasn&apos;t opted in. Empty means take a message.
                  </p>
                </>
              )}
              <Toggle
                label="Text the rep who owns the lead"
                hint="Sends a short SMS to the rep's personal phone the moment a call comes back — name and number only. Each rep adds their own number and opts in under Settings; this switch can't opt them in for them."
                checked={inbound.notifyRep ?? true}
                onChange={(v) => setInbound({ ...inbound, notifyRep: v })}
              />
              <Toggle
                label="Record voicemail"
                hint="Record the message a caller leaves when nobody picks up, so it lands in the call archive with everything else."
                checked={inbound.recordVoicemail ?? true}
                onChange={(v) => setInbound({ ...inbound, recordVoicemail: v })}
              />
            </div>
          )}
        </div>

        <div className="mt-3 space-y-3">
          <Toggle
            label="Local presence"
            hint="Dial from a pool number matching the lead's area code when one is available — looks local, lifts pickup. Falls back to rotation otherwise. Add numbers in the area codes you call most."
            checked={dialing.localPresence ?? false}
            onChange={(v) => setDialing({ ...dialing, localPresence: v })}
          />
          <Toggle
            label="Double-dial no-answers (AI)"
            hint="When the AI bot gets a no-answer, ring the same number once more a few seconds later before moving on. Two quick missed calls read as an important call and lift pickup rate."
            checked={dialing.doubleDial ?? false}
            onChange={(v) => setDialing({ ...dialing, doubleDial: v })}
          />
          {(dialing.doubleDial ?? false) && (
            <NumberField
              label="Double-dial gap (sec)"
              value={dialing.doubleDialGapSec ?? 15}
              onChange={(n) =>
                setDialing({ ...dialing, doubleDialGapSec: Math.max(5, Math.min(60, n)) })
              }
            />
          )}
          <Toggle
            label="Power mode (auto-disposition)"
            hint="A finished call doesn't stop for a disposition — the AI reads it in the background and it stacks in a review widget while the dialer keeps dialing. This is the workspace default; each rep can flip it on the dialer."
            checked={dialing.autoDispose ?? false}
            onChange={(v) => setDialing({ ...dialing, autoDispose: v })}
          />
          {(dialing.autoDispose ?? false) && (
            <Toggle
              label="Auto-confirm dispositions"
              hint="Apply the AI's disposition automatically instead of waiting for a tap. Appointments and callbacks always wait for a rep to set a time — no guess writes a booking onto the calendar."
              checked={dialing.autoConfirmDisposition ?? false}
              onChange={(v) => setDialing({ ...dialing, autoConfirmDisposition: v })}
            />
          )}
          <Toggle
            label="Record calls"
            checked={dialing.recording}
            onChange={(v) => setDialing({ ...dialing, recording: v })}
          />
          {dialing.recording && (
            <Toggle
              label="Transcribe manual calls"
              hint="Run speech-to-text over each recorded manual call so the archive can search what was actually said — not just the name, number and notes. Needs a provider key on the server (ElevenLabs or Deepgram) and bills per minute of audio. AI calls already come with a transcript and are unaffected."
              checked={dialing.transcribeCalls ?? false}
              onChange={(v) => setDialing({ ...dialing, transcribeCalls: v })}
            />
          )}
          <Toggle
            label="Answering-machine detection"
            hint="Auto-drop machine pickups so reps never sit through a greeting. Adds Twilio's per-call AMD fee."
            checked={dialing.amd}
            onChange={(v) => setDialing({ ...dialing, amd: v })}
          />
          <Toggle
            label="Voicemail drop"
            hint="When AMD hears the greeting end, speak the message below instead of hanging up."
            checked={dialing.voicemailDrop}
            onChange={(v) => setDialing({ ...dialing, voicemailDrop: v })}
          />
          {dialing.amd && dialing.voicemailDrop && (
            <div className="sm:col-span-2">
              <Field label="Voicemail message ({org} inserts your organization name)">
                <Textarea
                  value={dialing.voicemailMessage}
                  rows={2}
                  placeholder="This is a courtesy call from {org}. Sorry we missed you — we'll try to reach you another time."
                  onChange={(e) =>
                    setDialing({ ...dialing, voicemailMessage: e.target.value })
                  }
                />
              </Field>
            </div>
          )}
          <Toggle
            label="Lead claims (prevent double-dialing)"
            hint="Two reps (or a rep and the AI scheduler) can never pull the same lead at once. Leave on — this is the org-level rollback switch for the reservation engine, not a preference."
            checked={dialing.reservations ?? true}
            onChange={(v) => setDialing({ ...dialing, reservations: v })}
          />
          {/* Not a toggle on purpose: DNC is enforced unconditionally on every
              dial path. The old "Respect Do-Not-Call" switch was a placebo —
              it persisted a value nothing read, and a control that LOOKS like
              it can turn DNC off is worse than no control. */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-surface/50 px-4 py-3">
            <span>
              <span className="block text-sm font-medium">Do-Not-Call list</span>
              <span className="block text-xs text-muted-foreground">
                Always enforced — every manual, parallel, AI, and scheduled dial is
                scrubbed against your DNC list. This cannot be switched off.
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Enforced
            </span>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <SaveBtn k="dialing" onClick={() => save({ settings: { dialing } }, "dialing")} />
        </div>
      </SectionCard>

      {/* Automated (unattended) AI calling */}
      <SectionCard
        title="Automated calling"
        description="Let the AI agent place calls on a schedule — no rep or open browser required. Requires the AI agent + a deployed cron (see docs)."
      >
        <Toggle
          label="Enable automated calling"
          hint="When on, the server places AI calls to your dialable leads during the windows below."
          checked={automation.enabled}
          onChange={(v) => setAutomation({ ...automation, enabled: v })}
        />

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Timezone" className="sm:col-span-3">
            <Input
              value={automation.timezone}
              placeholder="America/Chicago"
              onChange={(e) => setAutomation({ ...automation, timezone: e.target.value })}
            />
          </Field>
          <NumberField
            label="Calls per minute"
            value={automation.callsPerRun}
            onChange={(n) =>
              setAutomation({ ...automation, callsPerRun: Math.max(1, Math.min(30, n)) })
            }
          />
          <NumberField
            label="Daily cap (0 = none)"
            value={automation.dailyCap}
            onChange={(n) => setAutomation({ ...automation, dailyCap: Math.max(0, n) })}
          />
          <NumberField
            label="Re-dial cooldown (hrs)"
            value={automation.cooldownHours}
            onChange={(n) => setAutomation({ ...automation, cooldownHours: Math.max(0, n) })}
          />
        </div>

        <div className="mt-4">
          <Label>Calling days</Label>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => {
              const on = automation.days.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() =>
                    setAutomation({
                      ...automation,
                      days: on
                        ? automation.days.filter((x) => x !== i)
                        : [...automation.days, i].sort((a, b) => a - b),
                    })
                  }
                  className={cn(
                    "h-9 w-12 rounded-lg border text-xs font-semibold transition-colors",
                    on
                      ? "border-primary bg-primary-soft text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-4">
          <Label>Call windows (24-hour, end is exclusive)</Label>
          <div className="space-y-2">
            {automation.windows.map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="w-20"
                  type="number"
                  min={0}
                  max={23}
                  value={w.start}
                  onChange={(e) => {
                    const start = Math.max(0, Math.min(23, Number(e.target.value) || 0));
                    setAutomation({
                      ...automation,
                      windows: automation.windows.map((x, j) => (j === i ? { ...x, start } : x)),
                    });
                  }}
                />
                <span className="text-sm text-muted-foreground">to</span>
                <Input
                  className="w-20"
                  type="number"
                  min={1}
                  max={24}
                  value={w.end}
                  onChange={(e) => {
                    const end = Math.max(1, Math.min(24, Number(e.target.value) || 1));
                    setAutomation({
                      ...automation,
                      windows: automation.windows.map((x, j) => (j === i ? { ...x, end } : x)),
                    });
                  }}
                />
                <button
                  type="button"
                  aria-label="Remove window"
                  onClick={() =>
                    setAutomation({
                      ...automation,
                      windows: automation.windows.filter((_, j) => j !== i),
                    })
                  }
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted/60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setAutomation({
                  ...automation,
                  windows: [...automation.windows, { start: 9, end: 10 }],
                })
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/60"
            >
              <Plus className="h-4 w-4" />
              Add window
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Calls{" "}
            <span className="font-semibold text-foreground">{describeDays(automation.days)}</span>{" "}
            at{" "}
            <span className="font-semibold text-foreground">
              {describeWindows(automation.windows)}
            </span>{" "}
            ({automation.timezone}). Keep windows inside 8am–9pm local to stay TCPA-compliant.
          </p>
        </div>

        <div className="mt-4 flex justify-end">
          <SaveBtn
            k="automation"
            onClick={() => save({ settings: { automation } }, "automation")}
          />
        </div>
      </SectionCard>

      {/* Business hours */}
      <SectionCard
        title="Calling hours"
        description="Your floor's calling window. Advisory by default (the dialer shows an outside-hours banner); turn on enforcement to actually block dialing."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Timezone" className="sm:col-span-3">
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </Field>
          <NumberField
            label="Start hour (0–23)"
            value={hours.startHour}
            onChange={(n) => setHours({ ...hours, startHour: n })}
          />
          <NumberField
            label="End hour (0–23)"
            value={hours.endHour}
            onChange={(n) => setHours({ ...hours, endHour: n })}
          />
        </div>
        <div className="mt-3">
          <Label>Calling days</Label>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => {
              const on = hours.days.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() =>
                    setHours({
                      ...hours,
                      days: on
                        ? hours.days.filter((x) => x !== i)
                        : [...hours.days, i].sort(),
                    })
                  }
                  className={cn(
                    "h-9 w-12 rounded-lg border text-xs font-semibold transition-colors",
                    on
                      ? "border-primary bg-primary-soft text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
        <div className="mt-3">
          <Toggle
            label="Block dialing outside these hours"
            hint="When on, manual and AI dials outside the window are refused server-side — evaluated in each contact's own timezone (area code), falling back to the org's. When off, the hours are advisory: reps see a banner but calls go through."
            checked={hours.enforced ?? false}
            onChange={(v) => setHours({ ...hours, enforced: v })}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <SaveBtn
            k="hours"
            onClick={() => save({ timezone, settings: { hours } }, "hours")}
          />
        </div>
      </SectionCard>

      {/* AI agent */}
      <SectionCard
        title="AI agent"
        description="The voice, persona, and behavior of your AI caller."
      >
        {!features.aiDialer || !hasAiPermission ? (
          /* Locked when the org has aiDialer off (feature gate) or the viewer lacks dialer.ai */
          <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border/70 px-6 py-10 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-muted/40">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </span>
            <div>
              <p className="text-sm font-semibold">
                {!features.aiDialer
                  ? "AI calling is switched off for this workspace"
                  : "AI calling is not enabled for your account"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {!features.aiDialer ? (
                  <>
                    The <span className="font-semibold">AI calling</span> feature flag is off. Turn
                    it on below to unlock AI calls, the AI dialer mode, and this configuration
                    panel — reps still need the AI-dialer permission individually.
                  </>
                ) : (
                  <>
                    AI agent configuration requires the{" "}
                    <span className="font-semibold">AI Dialer</span> permission. An admin can grant
                    it to your account from Admin → Members → the shield icon.
                  </>
                )}
              </p>
            </div>
            {!features.aiDialer && (
              <>
                <Button
                  size="sm"
                  disabled={busy === "features"}
                  onClick={async () => {
                    // Flip local state only AFTER the server accepted — an
                    // optimistic unlock on a failed PATCH rendered the whole
                    // config panel over a feature that was still off.
                    const next = { ...features, aiDialer: true };
                    if (await save({ settings: { features: next } }, "features")) {
                      setFeatures(next);
                    }
                  }}
                >
                  {busy === "features" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Enable AI calling"
                  )}
                </Button>
                {/* The page-top error banner is off-screen from down here. */}
                {err && <p className="text-xs font-medium text-danger">{err}</p>}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Agent name">
                <Input value={ai.agentName} onChange={(e) => setAi({ ...ai, agentName: e.target.value })} />
              </Field>
              <Field label="Voice (ElevenLabs voice ID)">
                <Input
                  value={ai.voice}
                  placeholder="Blank = the voice set on the ElevenLabs agent"
                  onChange={(e) => setAi({ ...ai, voice: e.target.value })}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Sent per call as a voice override. The agent must allow voice
                  overrides (ElevenLabs → Agent → Security), or this is safely ignored.
                </p>
              </Field>
              <Field label="Transfer number">
                <Input
                  value={ai.transferNumber}
                  placeholder="+1…"
                  onChange={(e) => setAi({ ...ai, transferNumber: e.target.value })}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Where the Live Monitor’s Transfer button sends a caller. Blank falls
                  back to the platform default; blank both disables Transfer.
                </p>
              </Field>
              <Field label="Language">
                <Input value={ai.language} onChange={(e) => setAi({ ...ai, language: e.target.value })} />
              </Field>
              <NumberField
                label="Max AI talk time (min, 0 = no limit)"
                hint="A connected AI call running past this is ended automatically (within ~1 minute)."
                value={ai.talkTimeLimitMin}
                onChange={(n) => setAi({ ...ai, talkTimeLimitMin: Math.max(0, n) })}
              />
              <NumberField
                label="Max simultaneous AI calls"
                hint="Your voice plan's live-call allowance — the dialer holds itself to it."
                value={ai.maxConcurrentCalls}
                onChange={(n) =>
                  setAi({ ...ai, maxConcurrentCalls: Math.max(1, Math.min(30, n)) })
                }
              />
              <Toggle
                label="Give every rep the AI dialer"
                hint="Unlocks AI calling for the whole workspace, reps included — normally it's admins and managers only. New hires get it automatically. Switching a single rep off by hand on the Members tab still overrides this. (The 'AI calling' feature switch above must also be on.)"
                checked={ai.allRepAccess ?? false}
                onChange={(v) => setAi({ ...ai, allRepAccess: v })}
              />
              {/* Superseded while every rep has it — showing both would be two
                  controls that contradict each other. */}
              {!(ai.allRepAccess ?? false) && (
                <NumberField
                  label="Give the AI dialer to your top reps (0 = off)"
                  hint="A standing rule, not a one-off grant: the top N reps by appointments booked in the last 7 days get the AI dialer, and it re-evaluates as the ranking changes — climb in and you gain it, drop out and you lose it. Admins and managers already have AI access and are never ranked, so they can't take a rep's slot. Setting a rep's AI toggle by hand on the Members tab still overrides this either way."
                  value={ai.topRepAccess ?? 0}
                  onChange={(n) => setAi({ ...ai, topRepAccess: Math.max(0, Math.min(25, n)) })}
                />
              )}
              <Field label="Voice speed (0.7 slow – 1.2 fast)">
                <Input
                  type="number"
                  step="0.05"
                  min="0.7"
                  max="1.2"
                  value={ai.voiceSpeed}
                  onChange={(e) => setAi({ ...ai, voiceSpeed: Number(e.target.value) })}
                />
              </Field>
              <Field label="Persona / instructions" className="sm:col-span-2">
                <Textarea value={ai.persona} onChange={(e) => setAi({ ...ai, persona: e.target.value })} />
              </Field>
              <Field label="Opening greeting" className="sm:col-span-2">
                <Textarea
                  value={ai.greeting}
                  onChange={(e) => setAi({ ...ai, greeting: e.target.value })}
                  placeholder="Use {agent} and {org} as placeholders."
                />
              </Field>
              <div className="sm:col-span-2">
                <div className="mb-1.5 flex items-center justify-between">
                  <Label className="mb-0">System prompt (paste this into ElevenLabs)</Label>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(ai.systemPrompt)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </button>
                </div>
                <Textarea
                  value={ai.systemPrompt}
                  onChange={(e) => setAi({ ...ai, systemPrompt: e.target.value })}
                  placeholder="Leave blank to use the built-in script for this vertical (Sunrun uses the Emily resolution script)."
                  className="min-h-[140px] font-mono text-xs"
                />
              </div>
            </div>
            {/* AI disposition policy — what an AI-proposed disposition may do to
                a call record. This was a live policy with no UI: analyze-call has
                enforced it since F1, but only a hand-edited settings blob could
                change it. */}
            <div className="mt-5 rounded-xl border border-border/70 bg-surface/50 p-4">
              <p className="text-sm font-semibold">AI dispositions</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                After each analyzed call the AI proposes a disposition. Confident,
                transcript-backed proposals can fill an <em>empty</em> slot silently;
                everything else goes to the Needs Review lane. A human’s choice is
                never overwritten.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Auto-apply confidence (%)">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={Math.round(ai.dispositionPolicy.autoApplyMin * 100)}
                    onChange={(e) =>
                      setAi({
                        ...ai,
                        dispositionPolicy: {
                          ...ai.dispositionPolicy,
                          autoApplyMin: Math.min(100, Math.max(0, Number(e.target.value))) / 100,
                        },
                      })
                    }
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Below this the proposal goes to review instead. 100 = never
                    auto-apply.
                  </p>
                </Field>
                <div>
                  <Label>Always require review</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {dispositions
                      .filter((d) => d.enabled !== false)
                      .map((d) => {
                        const key = d.key ?? "";
                        const pinned = key === "do_not_call";
                        const on =
                          pinned || ai.dispositionPolicy.alwaysReview.includes(key);
                        return (
                          <button
                            key={key}
                            type="button"
                            disabled={pinned}
                            aria-pressed={on}
                            title={
                              pinned
                                ? "Do-Not-Call always requires a human — this can't be unpinned."
                                : undefined
                            }
                            onClick={() =>
                              setAi({
                                ...ai,
                                dispositionPolicy: {
                                  ...ai.dispositionPolicy,
                                  alwaysReview: on
                                    ? ai.dispositionPolicy.alwaysReview.filter(
                                        (k) => k !== key,
                                      )
                                    : [...ai.dispositionPolicy.alwaysReview, key],
                                },
                              })
                            }
                            className={cn(
                              "rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors",
                              on
                                ? "border-primary bg-primary-soft text-primary"
                                : "border-border text-muted-foreground hover:bg-muted/60",
                              pinned && "cursor-not-allowed opacity-80",
                            )}
                          >
                            {d.label}
                          </button>
                        );
                      })}
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <Toggle
                  label="Review proposals with no transcript"
                  hint="A proposal nobody can verify against a transcript never auto-applies; off sends it nowhere at all (artifact only)."
                  checked={ai.dispositionPolicy.reviewOnMissingTranscript}
                  onChange={(v) =>
                    setAi({
                      ...ai,
                      dispositionPolicy: { ...ai.dispositionPolicy, reviewOnMissingTranscript: v },
                    })
                  }
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <SaveBtn k="ai" onClick={() => save({ settings: { ai } }, "ai")} />
            </div>
          </>
        )}
      </SectionCard>

      {/* Compliance */}
      <SectionCard
        title="Compliance"
        description="Recording disclosure & consent. (DNC is always enforced — see Dialing.)"
      >
        <div className="space-y-3">
          <Toggle
            label="Require consent before recording"
            checked={compliance.consentRequired}
            onChange={(v) => setCompliance({ ...compliance, consentRequired: v })}
          />
          <Field label="Recording disclosure">
            <Textarea
              value={compliance.recordingDisclosure}
              onChange={(e) =>
                setCompliance({ ...compliance, recordingDisclosure: e.target.value })
              }
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <SaveBtn
            k="compliance"
            onClick={() => save({ settings: { compliance } }, "compliance")}
          />
        </div>
      </SectionCard>

      {/* Dispositions — the org's wrap-up taxonomy, live end-to-end */}
      <SectionCard
        title="Call dispositions"
        description="The outcomes reps & the AI can log on a call."
      >
        <p className="mb-3 text-xs text-muted-foreground">
          These are the buttons reps see at wrap-up. Reports keep the canonical outcome;
          your custom label rides along on every call record.
        </p>
        <div className="space-y-2">
          {dispositions.map((d, i) => (
            <div
              key={d.key}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-surface/50 p-2",
                !d.enabled && "opacity-60",
              )}
            >
              {/* Reorder — the wrap-up grid renders in exactly this order */}
              <div className="flex flex-col">
                <button
                  type="button"
                  aria-label={`Move ${d.label} up`}
                  disabled={i === 0}
                  onClick={() => moveDisposition(i, -1)}
                  className="flex h-4 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${d.label} down`}
                  disabled={i === dispositions.length - 1}
                  onClick={() => moveDisposition(i, 1)}
                  className="flex h-4 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
              </div>
              <Input
                value={d.label}
                aria-label="Button label"
                className="w-40 min-w-[9rem] flex-1"
                onChange={(e) => updateDisposition(i, { label: e.target.value })}
              />
              <Select
                className="w-28"
                aria-label="Tone"
                value={d.tone}
                onChange={(e) =>
                  updateDisposition(i, { tone: e.target.value as DispositionTone })
                }
              >
                <option value="success">Positive</option>
                <option value="warning">Neutral</option>
                <option value="danger">Negative</option>
                <option value="neutral">Info</option>
              </Select>
              {d.system ? (
                // System rows: the behavior IS what the key means — read-only.
                <span className="inline-flex h-9 items-center rounded-lg bg-muted px-3 text-xs font-medium text-muted-foreground">
                  {BEHAVIOR_DESCRIPTIONS[d.behavior]}
                </span>
              ) : (
                <Select
                  className="w-52"
                  aria-label="What pressing it does"
                  value={d.behavior}
                  onChange={(e) =>
                    updateDisposition(i, {
                      behavior: e.target.value as DispositionBehavior,
                    })
                  }
                >
                  {DISPOSITION_BEHAVIORS.map((b) => (
                    <option key={b} value={b}>
                      {BEHAVIOR_DESCRIPTIONS[b]}
                    </option>
                  ))}
                </Select>
              )}
              {d.key === "do_not_call" ? (
                <Tooltip content="Legally load-bearing — can't be turned off.">
                  <span className="inline-flex">
                    <MiniSwitch checked disabled label="Do not call is always on" />
                  </span>
                </Tooltip>
              ) : (
                <MiniSwitch
                  checked={d.enabled}
                  label={d.enabled ? `Disable ${d.label}` : `Enable ${d.label}`}
                  onChange={(v) => updateDisposition(i, { enabled: v })}
                />
              )}
              {!d.system && (
                <button
                  type="button"
                  aria-label={`Remove ${d.label}`}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-danger/10 hover:text-danger"
                  onClick={() =>
                    setDispositions(dispositions.filter((_, x) => x !== i))
                  }
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        {newDispo ? (
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-border p-3">
            <Field label="Button label" className="min-w-[10rem] flex-1">
              <Input
                autoFocus
                value={newDispo.label}
                placeholder="e.g. Left with spouse"
                onChange={(e) => setNewDispo({ ...newDispo, label: e.target.value })}
              />
            </Field>
            <Field label="What pressing it does">
              <Select
                className="w-52"
                value={newDispo.behavior}
                onChange={(e) =>
                  setNewDispo({
                    ...newDispo,
                    behavior: e.target.value as DispositionBehavior,
                  })
                }
              >
                {DISPOSITION_BEHAVIORS.map((b) => (
                  <option key={b} value={b}>
                    {BEHAVIOR_DESCRIPTIONS[b]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tone">
              <Select
                className="w-28"
                value={newDispo.tone}
                onChange={(e) =>
                  setNewDispo({ ...newDispo, tone: e.target.value as DispositionTone })
                }
              >
                <option value="success">Positive</option>
                <option value="warning">Neutral</option>
                <option value="danger">Negative</option>
                <option value="neutral">Info</option>
              </Select>
            </Field>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!newDispo.label.trim()}
              onClick={addCustomDisposition}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNewDispo(null)}>
              Cancel
            </Button>
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between">
          {newDispo ? (
            <span />
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() =>
                setNewDispo({ label: "", behavior: "neutral_end", tone: "neutral" })
              }
            >
              <Plus className="h-3.5 w-3.5" />
              Add disposition
            </Button>
          )}
          <SaveBtn
            k="disp"
            onClick={() =>
              save(
                {
                  settings: {
                    dispositions: dispositions.map((d, i) => ({ ...d, sortOrder: i })),
                  },
                },
                "disp",
              )
            }
          />
        </div>
      </SectionCard>

      {/* Dialer layout & qualify */}
      <SectionCard
        title="Dialer layout & qualify"
        description="Which panels the dialer page shows, and which fields reps qualify on a call. Defaults come from your specialization — anything you save here wins."
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {LAYOUT_TOGGLES.map(({ key, label, hint }) => (
            <Toggle
              key={key}
              label={label}
              hint={hint}
              checked={layoutCfg[key]}
              onChange={(v) => setLayoutCfg({ ...layoutCfg, [key]: v })}
            />
          ))}
        </div>
        <div className="mt-4">
          <Label>Qualify panel fields</Label>
          <div className="flex flex-wrap gap-1.5">
            {leadFieldRows.map((f) => {
              const on = qualifyKeys.includes(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setQualifyKeys(
                      on
                        ? qualifyKeys.filter((k) => k !== f.key)
                        : // Keep schema order regardless of click order.
                          leadFieldRows
                            .filter((x) => x.key === f.key || qualifyKeys.includes(x.key))
                            .map((x) => x.key),
                    )
                  }
                  className={cn(
                    "flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors",
                    on
                      ? "border-primary bg-primary-soft text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  {f.label}
                  <span className={cn("font-normal", on ? "text-primary/70" : "text-muted-foreground/70")}>
                    · {f.type}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Selected fields appear in the dialer's qualify panel, in this order — reps' entries
            save back to the lead automatically. Add more fields in “Lead fields” below.
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <SaveBtn
            k="dialerLayout"
            onClick={() =>
              save(
                {
                  settings: {
                    dialerLayout: layoutCfg,
                    qualify: { ...org.settings.qualify, fields: qualifyKeys },
                  },
                },
                "dialerLayout",
              )
            }
          />
        </div>
      </SectionCard>

      {/* Lead fields */}
      <SectionCard
        title="Lead fields"
        description="The typed fields your leads carry. Core fields are shared slots you can rename to fit your vertical; custom fields are added automatically when a CSV import carries extra columns."
      >
        <div className="space-y-2">
          {leadFieldRows.map((f, i) => (
            <div key={f.key} className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-40 flex-1"
                value={f.label}
                aria-label={`Label for ${f.key}`}
                onChange={(e) => {
                  const next = [...leadFieldRows];
                  next[i] = { ...f, label: e.target.value };
                  setLeadFieldRows(next);
                }}
              />
              <span
                className="w-16 shrink-0 text-xs font-medium capitalize text-muted-foreground"
                title={f.source === "core" ? "Built-in field" : "Custom field (from CSV import)"}
              >
                {f.type}
              </span>
              <PillToggle
                label="Table"
                active={f.showInTable}
                title="Show as a column on the Leads table"
                onClick={() => {
                  const next = [...leadFieldRows];
                  next[i] = { ...f, showInTable: !f.showInTable };
                  setLeadFieldRows(next);
                }}
              />
              <PillToggle
                label="Qualify"
                active={f.showInQualify}
                title="Offer in the dialer's qualify panel by default"
                onClick={() => {
                  const next = [...leadFieldRows];
                  next[i] = { ...f, showInQualify: !f.showInQualify };
                  setLeadFieldRows(next);
                }}
              />
              {f.source === "custom" ? (
                <button
                  type="button"
                  aria-label={`Delete ${f.label}`}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-danger/10 hover:text-danger"
                  onClick={() =>
                    setLeadFieldRows(leadFieldRows.filter((_, x) => x !== i))
                  }
                >
                  <X className="h-4 w-4" />
                </button>
              ) : (
                <span className="h-9 w-9 shrink-0" aria-hidden />
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Deleting a custom field hides it everywhere — the imported values stay on your leads
          and reappear if the field is re-imported. Saving pins these labels for this workspace,
          so changing the specialization later won't rename them.
        </p>
        <div className="mt-4 flex justify-end">
          <SaveBtn
            k="leadFields"
            onClick={() => {
              // Persist only DELTAS: core rows identical to the template-
              // resolved default are dropped, so an untouched Save doesn't pin
              // template-hidden solar slots into settings.leadFields (which
              // would resurrect them in the dialer config for non-solar orgs).
              const baseline = new Map(
                resolveLeadFields([], profile.fields).map((f) => [f.key, f]),
              );
              const changed = leadFieldRows.filter((f) => {
                if (f.source === "custom") return true;
                const base = baseline.get(f.key);
                return (
                  !base ||
                  base.label !== f.label ||
                  base.showInTable !== f.showInTable ||
                  base.showInQualify !== f.showInQualify
                );
              });
              save({ settings: { leadFields: changed } }, "leadFields");
            }}
          />
        </div>
      </SectionCard>

      {/* Features & terminology */}
      <SectionCard
        title="Features & terminology"
        description="Turn whole areas of the dialer on or off, and tailor the wording."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Contact noun (singular)">
            <Input
              value={terms.leadNoun}
              placeholder="lead"
              onChange={(e) => setTerms({ ...terms, leadNoun: e.target.value })}
            />
          </Field>
          <Field label="Contact noun (plural)">
            <Input
              value={terms.leadNounPlural}
              placeholder="leads"
              onChange={(e) => setTerms({ ...terms, leadNounPlural: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FEATURE_FLAGS.map(({ key, label }) => (
            <Toggle
              key={key}
              label={label}
              checked={features[key]}
              onChange={(v) => setFeatures({ ...features, [key]: v })}
            />
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <SaveBtn
            k="features"
            onClick={() =>
              save(
                {
                  settings: {
                    features,
                    leadNoun: terms.leadNoun,
                    leadNounPlural: terms.leadNounPlural,
                  },
                },
                "features",
              )
            }
          />
        </div>
      </SectionCard>

      {/* Cost rates — drives the Reports "Cost & usage" estimates */}
      <SectionCard
        title="Cost rates"
        description="What a minute of talk time costs you — powers the estimated spend on Reports."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="AI calls ($ per minute)">
            <Input
              type="number"
              step="0.001"
              min="0"
              value={costRates.aiPerMinute}
              onChange={(e) =>
                setCostRates({ ...costRates, aiPerMinute: Number(e.target.value) || 0 })
              }
            />
          </Field>
          <Field label="Human calls ($ per minute)">
            <Input
              type="number"
              step="0.001"
              min="0"
              value={costRates.manualPerMinute}
              onChange={(e) =>
                setCostRates({
                  ...costRates,
                  manualPerMinute: Number(e.target.value) || 0,
                })
              }
            />
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Estimates only — set these to your carrier and AI plan pricing. AI calls
          typically carry the conversational-AI fee plus the phone leg.
        </p>
        <div className="mt-4 flex justify-end">
          <SaveBtn
            k="costRates"
            onClick={() => save({ settings: { costRates } }, "costRates")}
          />
        </div>
      </SectionCard>

      {/* Leaderboard scoring — the formula behind every points figure */}
      <SectionCard
        title="Leaderboard scoring"
        description="What each result is worth on your leaderboard. Every entry shows its exact breakdown, so these numbers are the whole formula."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <PointsField
            label="Human connect"
            value={lb.points.humanConnect}
            onChange={(n) => setLbPoint("humanConnect", n)}
          />
          <PointsField
            label="Qualified"
            value={lb.points.qualified}
            onChange={(n) => setLbPoint("qualified", n)}
          />
          <PointsField
            label="Appointment booked"
            value={lb.points.appointmentBooked}
            onChange={(n) => setLbPoint("appointmentBooked", n)}
          />
          {/* "Kept" = appointment rows marked completed — the status exists in
              this schema, so the component is real, not aspirational. */}
          <PointsField
            label="Appointment kept"
            value={lb.points.appointmentKept}
            onChange={(n) => setLbPoint("appointmentKept", n)}
          />
          <PointsField
            label="Callback completed"
            value={lb.points.callbackCompleted}
            onChange={(n) => setLbPoint("callbackCompleted", n)}
          />
          <PointsField
            label="Per talk minute (connected)"
            value={lb.points.talkMinute}
            onChange={(n) => setLbPoint("talkMinute", n)}
          />
        </div>
        <div className="mt-4 space-y-3">
          <Toggle
            label="Count AI-agent calls"
            hint="Off (default): only human dials score — the board measures reps, not the bot."
            checked={lb.exclusions.includeAiCalls}
            onChange={(v) =>
              setLb({ ...lb, exclusions: { ...lb.exclusions, includeAiCalls: v } })
            }
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumberField
              label="Min talk seconds for a connect"
              value={lb.exclusions.minTalkSecForConnect}
              onChange={(n) =>
                setLb({
                  ...lb,
                  exclusions: { ...lb.exclusions, minTalkSecForConnect: Math.max(0, n) },
                })
              }
            />
            <Field label="Week starts on">
              <Select
                value={String(lb.weekStart)}
                onChange={(e) =>
                  setLb({ ...lb, weekStart: e.target.value === "0" ? 0 : 1 })
                }
              >
                <option value="1">Monday</option>
                <option value="0">Sunday</option>
              </Select>
            </Field>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Periods are calendar-true in your org timezone: today, the calendar week from the
          start day above, and the calendar month. Calls whose talk time is below the minimum
          never score as connects.
        </p>
        <div className="mt-4 flex justify-end">
          <SaveBtn
            k="leaderboard"
            onClick={() => save({ settings: { leaderboard: lb } }, "leaderboard")}
          />
        </div>
      </SectionCard>

      {/* Danger zone */}
      {canDelete && (
        <SectionCard
          title="Danger zone"
          description="Irreversible actions for the organization owner."
        >
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4">
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-danger" />
              <div>
                <p className="text-sm font-semibold">Delete this organization</p>
                <p className="text-xs text-muted-foreground">
                  Members are unassigned and sent back to the Hub.
                </p>
              </div>
            </div>
            <Button
              variant="danger"
              size="sm"
              className="gap-1.5"
              disabled={busy === "delete"}
              onClick={deleteOrg}
            >
              {busy === "delete" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete organization
            </Button>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ── small building blocks ────────────────────────────────────────────────────
function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Field>
  );
}

/** Fractional-friendly number input (leaderboard points allow e.g. 0.1/min). */
function PointsField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        step="0.1"
        min="0"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </Field>
  );
}

function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value || "#2563eb"}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-background"
        aria-label="Pick color"
      />
      <Input
        value={value}
        placeholder="#2563eb"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Compact pill toggle for dense per-row switches (the Lead-fields table). */
function PillToggle({
  label,
  active,
  title,
  onClick,
}: {
  label: string;
  active: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn(
        "h-9 shrink-0 rounded-lg border px-3 text-xs font-semibold transition-colors",
        active
          ? "border-primary bg-primary-soft text-primary"
          : "border-border text-muted-foreground hover:bg-muted/60",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Compact inline switch for dense per-row toggles (the Dispositions editor).
 * `disabled` renders it inert but still checked — used for do_not_call, whose
 * enabled state is legally load-bearing and not a preference.
 */
function MiniSwitch({
  checked,
  label,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  /** Accessible name — the visual is just the track. */
  label: string;
  disabled?: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-muted",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
          checked && "translate-x-5",
        )}
      />
    </button>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border/70 bg-surface/50 px-4 py-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors peer-checked:bg-primary">
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
            checked && "translate-x-5",
          )}
        />
      </span>
    </label>
  );
}
