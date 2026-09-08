"use client";

import {
  Bell,
  Building2,
  Check,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  PhoneCall,
  PhoneIncoming,
  Radio,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useVocabulary } from "@/components/layout/vocabulary";
import { Input, Label } from "@/components/ui/input";
import {
  DEFAULT_NOTIFY_PREFS,
  type NotifyPrefs,
} from "@/lib/dialer/notify-prefs";
import {
  DEFAULT_DIALER_USER_PREFS,
  type DialerUserPrefs,
} from "@/lib/dialer/user-prefs";
import {
  PERMISSION_LABEL,
  PERMISSIONS,
  type OrgRole,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
} from "@/lib/permissions";
import { cn, formatPhone } from "@/lib/utils";

function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-muted",
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

function PrefRow({
  icon: Icon,
  title,
  desc,
  checked,
  onChange,
}: {
  icon: typeof Bell;
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-3.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

export function SettingsView({
  account,
  role = null,
  orgName = null,
  productName = null,
  membershipStatus = "none",
  permissions = [],
  team: savedTeam = "",
  dialerPrefs = DEFAULT_DIALER_USER_PREFS,
  notifyPrefs = DEFAULT_NOTIFY_PREFS,
}: {
  account?: { name: string; email: string } | null;
  role?: OrgRole | null;
  orgName?: string | null;
  productName?: string | null;
  membershipStatus?: "active" | "pending" | "none";
  permissions?: string[];
  /** The saved profile team — this used to hardcode "AIATWORK" and never load. */
  team?: string;
  /** The saved dialer prefs (profile preferences.dialerPrefs). */
  dialerPrefs?: DialerUserPrefs;
  /** The saved callback-notification prefs (profile preferences.notify). */
  notifyPrefs?: NotifyPrefs;
}) {
  const { theme, setTheme } = useTheme();
  const vocab = useVocabulary();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const displayName = account?.name ?? "Your account";
  const displayEmail = account?.email ?? "";
  const displayInitials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "·";

  const [name, setName] = useState(displayName);
  // Loads the SAVED team (this field used to initialize to a hardcoded
  // "AIATWORK" and never read what was stored — saving then overwrote the
  // real value with the placeholder).
  const [team, setTeam] = useState(savedTeam);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function saveProfile() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName: name, team }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  // Dialer prefs persist on the profile (preferences.dialerPrefs) the moment
  // they're toggled, and the (app) layout feeds them into the dialer engine —
  // these used to be six local-state placebos that reset on every visit.
  const [prefs, setPrefs] = useState<DialerUserPrefs>(dialerPrefs);
  const [prefsStatus, setPrefsStatus] = useState<"idle" | "saved" | "error">("idle");
  // Monotonic sequence: a slow earlier POST resolving last must never mark the
  // UI saved (or revert it) over a newer toggle's result.
  const prefsSeq = useRef(0);
  const set = (k: keyof DialerUserPrefs) => (v: boolean) => {
    const prev = prefs;
    const next = { ...prefs, [k]: v };
    const seq = ++prefsSeq.current;
    setPrefs(next);
    setPrefsStatus("idle");
    fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferences: { dialerPrefs: next } }),
    })
      .then((res) => {
        if (seq !== prefsSeq.current) return; // superseded by a newer toggle
        if (res.ok) {
          setPrefsStatus("saved");
        } else {
          // The switch must not lie: revert it and say the save failed.
          setPrefs(prev);
          setPrefsStatus("error");
        }
      })
      .catch(() => {
        if (seq !== prefsSeq.current) return;
        setPrefs(prev);
        setPrefsStatus("error");
      });
  };

  // ── Callback notifications ────────────────────────────────────────────────
  // The number is saved EXPLICITLY (a button, not on every keystroke) because
  // a half-typed phone number is a number that can't be reached, and the
  // toggles depend on it. The toggles then save immediately, like the ones
  // above.
  const [notifyPrefsState, setNotifyPrefsState] = useState<NotifyPrefs>(notifyPrefs);
  const [notifyPhone, setNotifyPhone] = useState(
    notifyPrefs.phone ? formatPhone(notifyPrefs.phone) : "",
  );
  const [savedNotify, setSavedNotify] = useState({
    phoneInput: notifyPrefs.phone ? formatPhone(notifyPrefs.phone) : "",
  });
  const [notifySaving, setNotifySaving] = useState(false);
  const [notifyStatus, setNotifyStatus] = useState<"idle" | "saved" | "error">("idle");
  const [notifyError, setNotifyError] = useState("");
  const notifySeq = useRef(0);

  async function persistNotify(next: NotifyPrefs, phoneInput: string) {
    const seq = ++notifySeq.current;
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferences: { notify: next } }),
    }).catch(() => null);
    if (seq !== notifySeq.current) return null;
    const json = (await res?.json().catch(() => ({}))) as { error?: string };
    if (!res?.ok) {
      setNotifyError(json.error ?? "");
      setNotifyStatus("error");
      return null;
    }
    setSavedNotify({ phoneInput });
    setNotifyError("");
    setNotifyStatus("saved");
    return next;
  }

  async function saveNotify() {
    setNotifySaving(true);
    setNotifyStatus("idle");
    try {
      // Clearing the number turns both consents off with it — the server does
      // the same, but doing it here too keeps the switches honest immediately
      // instead of showing "on" against an empty field until the next load.
      const cleared = notifyPhone.replace(/\D/g, "").length === 0;
      const next: NotifyPrefs = cleared
        ? { phone: "", smsOnCallback: false, forwardCallback: false }
        : { ...notifyPrefsState, phone: notifyPhone };
      const ok = await persistNotify(next, notifyPhone);
      if (ok) setNotifyPrefsState({ ...next, phone: cleared ? "" : notifyPhone });
    } finally {
      setNotifySaving(false);
    }
  }

  const setNotify = (k: "smsOnCallback" | "forwardCallback") => (v: boolean) => {
    // A consent with no number behind it is a promise nothing can keep.
    if (!notifyPrefsState.phone && v) {
      setNotifyError("Add and save your number first.");
      setNotifyStatus("error");
      return;
    }
    const prev = notifyPrefsState;
    const next = { ...notifyPrefsState, [k]: v };
    setNotifyPrefsState(next);
    setNotifyStatus("idle");
    void persistNotify(next, savedNotify.phoneInput).then((ok) => {
      if (!ok) setNotifyPrefsState(prev); // the switch must not lie
    });
  };

  const themes = [
    { key: "light", label: "Light", icon: Sun },
    { key: "dark", label: "Dark", icon: Moon },
    { key: "system", label: "System", icon: Monitor },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Profile */}
      <Card className="p-6 lg:col-span-1">
        <div className="flex flex-col items-center text-center">
          <Avatar
            initials={displayInitials}
            tone="primary"
            size="lg"
            className="h-20 w-20 text-2xl"
          />
          <h3 className="mt-3 text-lg font-bold">{displayName}</h3>
          {displayEmail && (
            <p className="text-sm text-muted-foreground">{displayEmail}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
            {role && (
              <Badge tone={role === "rep" ? "neutral" : "primary"}>
                {ROLE_LABEL[role]}
              </Badge>
            )}
            {membershipStatus === "pending" && <Badge tone="warning">Pending approval</Badge>}
          </div>
          {orgName && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Building2 className="h-3.5 w-3.5" />
              {orgName}
              {productName ? ` · ${productName}` : ""}
            </p>
          )}
        </div>
      </Card>

      <div className="space-y-4 lg:col-span-2">
        {/* Account */}
        <Card className="p-6">
          <h3 className="font-semibold">Account</h3>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label>Full name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label>Email</Label>
              <Input value={displayEmail} readOnly disabled />
            </div>
            <div>
              <Label>Team</Label>
              <Input value={team} onChange={(e) => setTeam(e.target.value)} />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            {saved && <span className="text-xs font-medium text-success">Saved ✓</span>}
            <Button size="sm" onClick={saveProfile} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
            <Link href="/terms" target="_blank" className="font-medium hover:text-foreground hover:underline">
              Terms of Service
            </Link>
            <Link href="/privacy" target="_blank" className="font-medium hover:text-foreground hover:underline">
              Privacy Policy
            </Link>
            <Link href="/acceptable-use" target="_blank" className="font-medium hover:text-foreground hover:underline">
              Acceptable Use Policy
            </Link>
          </div>
        </Card>

        {/* Access & permissions */}
        <Card className="p-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <h3 className="font-semibold">Access &amp; permissions</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {role
              ? `You're ${ROLE_LABEL[role]} in this organization. ${ROLE_DESCRIPTION[role]}`
              : "You're not an active member of an organization yet."}
          </p>
          <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {PERMISSIONS.map((p) => {
              const granted = permissions.includes(p);
              return (
                <div
                  key={p}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
                    granted ? "text-foreground" : "text-muted-foreground/60",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
                      granted ? "bg-success/15 text-success" : "bg-muted text-muted-foreground/60",
                    )}
                  >
                    {granted ? <Check className="h-3.5 w-3.5" /> : <Minus className="h-3 w-3" />}
                  </span>
                  {PERMISSION_LABEL[p]}
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Permissions are set by your organization’s admins. Ask an admin if you need more access.
          </p>
        </Card>

        {/* Appearance */}
        <Card className="p-6">
          <h3 className="font-semibold">Appearance</h3>
          <p className="text-sm text-muted-foreground">Choose your interface theme</p>
          <div className="mt-4 grid grid-cols-3 gap-3">
            {themes.map((t) => {
              const active = mounted && theme === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTheme(t.key)}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-xl border p-4 transition-all active:scale-95",
                    active
                      ? "border-primary bg-primary-soft text-primary"
                      : "border-border bg-surface text-muted-foreground hover:bg-muted",
                  )}
                >
                  <t.icon className="h-5 w-5" />
                  <span className="text-sm font-semibold">{t.label}</span>
                </button>
              );
            })}
          </div>
        </Card>

        {/* Dialer preferences — real, profile-persisted, engine-wired. The old
            "Record calls" toggle is gone on purpose: recording is org policy
            (Admin → Dialing), and a per-rep switch that pretended otherwise was
            a compliance placebo. Same for the notification toggles — nothing
            sent desktop alerts or digests, so the switches were lies; org email
            notifications live in Admin → Notifications. */}
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Dialer preferences</h3>
            {prefsStatus === "saved" && (
              <span className="text-xs font-medium text-success">Saved ✓</span>
            )}
            {prefsStatus === "error" && (
              <span className="text-xs font-medium text-danger" role="status">
                Couldn’t save — check your connection and try again.
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Your personal defaults — they follow your account on any device.
          </p>
          <div className="mt-2 divide-y divide-border">
            <PrefRow
              icon={Radio}
              title="Auto-dial next lead"
              desc="Automatically start the next call after disposition"
              checked={prefs.autoDialNext}
              onChange={set("autoDialNext")}
            />
            <PrefRow
              icon={PhoneCall}
              title="Default to full parallel"
              desc="Open sessions at your organization's parallel line count"
              checked={prefs.parallelDefault}
              onChange={set("parallelDefault")}
            />
          </div>
          <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
            Call recording follows your organization’s policy (Admin → Dialing) and
            appointment emails are configured in Admin → Notifications.
          </p>
        </Card>

        {/* Callback notifications — the rep's own phone number, so a homeowner
            who rings one of the dialing numbers back reaches a human. Two
            SEPARATE consents on purpose: wanting a heads-up is not the same as
            agreeing to have your personal mobile ring. */}
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">When someone calls you back</h3>
            {notifyStatus === "saved" && (
              <span className="text-xs font-medium text-success">Saved ✓</span>
            )}
            {notifyStatus === "error" && (
              <span className="text-xs font-medium text-danger" role="status">
                {notifyError || "Couldn’t save — check your connection and try again."}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Your personal number. Used only to reach you about returned calls — never
            shown to a {vocab.leadNoun} and never dialed from.
          </p>

          <label className="mt-4 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Your mobile number
            </span>
            <div className="mt-1.5 flex gap-2">
              <Input
                value={notifyPhone}
                onChange={(e) => {
                  setNotifyPhone(e.target.value);
                  setNotifyStatus("idle");
                }}
                placeholder="(817) 555-0199"
                inputMode="tel"
                autoComplete="tel"
                className="flex-1"
              />
              <Button
                variant="outline"
                onClick={saveNotify}
                disabled={notifySaving || notifyPhone === savedNotify.phoneInput}
              >
                {notifySaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </label>

          <div className="mt-2 divide-y divide-border">
            <PrefRow
              icon={MessageSquare}
              title="Text me when someone calls back"
              desc={
                notifyPrefsState.phone
                  ? `We’ll text ${formatPhone(notifyPrefsState.phone)} the moment a ${vocab.leadNoun} rings one of your numbers back`
                  : "Add your number above to turn this on"
              }
              checked={notifyPrefsState.smsOnCallback}
              onChange={setNotify("smsOnCallback")}
            />
            <PrefRow
              icon={PhoneIncoming}
              title="Ring my phone"
              desc="Put the caller straight through to your mobile, so you can answer wherever you are"
              checked={notifyPrefsState.forwardCallback}
              onChange={setNotify("forwardCallback")}
            />
          </div>
          <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
            Returned calls always land on the Callbacks tab, whether or not these are on.
            Your organization decides what a returning caller hears (Admin → Dialing →
            Inbound calls).
          </p>
        </Card>
      </div>
    </div>
  );
}
