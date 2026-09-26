import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { isSolarVertical } from "@/lib/org/vertical";
import { MaintenanceScreen } from "@/components/layout/maintenance-screen";
import { PaywallScreen } from "@/components/layout/paywall-screen";
import { isAIConfigured } from "@/lib/ai/claude";
import { enforcedParallelCeiling } from "@/lib/db/abandonment";
import { getAppSettings, isAccountDisabled } from "@/lib/db/app-control";
import { listLeadGroups } from "@/lib/db/lead-groups";
import { getUiPreferences } from "@/lib/db/team";
import { parseDialerSessionPrefs, parseDialerUserPrefs } from "@/lib/dialer/user-prefs";
import { getPlatformPool } from "@/lib/dialer/rotation-server";
import { restrictToAssignedNumbers } from "@/lib/dialer/rotation";
import { agentLabels, isElevenLabsConfigured, isSecondAgentConfigured } from "@/lib/elevenlabs";
import { resolveLeadFields, resolveQualifyFields } from "@/lib/leads/field-schema";
import { isReverseSearchConfigured } from "@/lib/leads/reverse-search";
import { getViewer } from "@/lib/org/membership";
import {
  DEFAULT_DIALER_LAYOUT,
  DEFAULT_FEATURES,
  resolveDialerAccess,
} from "@/lib/org/settings";
import { templateProfile } from "@/lib/org/templates";
import { orgVocabulary } from "@/lib/org/vocabulary";
import { isSuperadmin } from "@/lib/superadmin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isVoiceConfigured } from "@/lib/twilio";
import { MAX_PARALLEL_HUMAN } from "@/lib/use-dialer";
import { initials } from "@/lib/utils";
import { isSupervisorRole } from "@/lib/permissions";

export default async function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await getViewer();

  // Signed out (and not demo) → sign in. Signed in but no active org → the Hub.
  if (!viewer.isDemo && !viewer.user) redirect("/login");
  if (!viewer.isDemo && !viewer.org) redirect("/hub");

  // Superadmins are also normal users (hidden) — they use the app like anyone,
  // and reach the Control Center through a discreet entry. They're exempt from
  // the kill switch / suspension so they can never lock themselves out.
  const superadmin = await isSuperadmin();

  if (viewer.user && !superadmin) {
    // These two gates are independent — resolve them concurrently instead of
    // serially (the app settings read and the per-user suspension check have no
    // data dependency on each other).
    const [settings, disabled] = await Promise.all([
      getAppSettings(),
      isAccountDisabled(viewer.user.id),
    ]);
    if (settings.maintenance) {
      return <MaintenanceScreen message={settings.message} />;
    }
    if (disabled) {
      return <MaintenanceScreen suspended />;
    }
  }

  // Per-org paywall: if this workspace is gated and not yet activated by the
  // platform owner, lock it for everyone but the superadmin (who grants access).
  const billing = viewer.org?.settings.billing;
  if (!superadmin && billing?.paywall && !billing.active) {
    return (
      <PaywallScreen
        orgName={viewer.org?.name ?? "This workspace"}
        productName={viewer.org?.productName}
        billing={billing}
      />
    );
  }

  const account = {
    name: viewer.displayName,
    email: viewer.email,
    initials: initials(viewer.displayName) || "·",
  };

  // Config for the app-wide dialer engine (lives in AppShell so calls survive
  // navigation). Same resolution the dialer page uses for its access gates.
  const { manualEnabled, aiEnabled, aiLockReason } = resolveDialerAccess(
    viewer.org?.settings.features ?? DEFAULT_FEATURES,
    viewer.permissions.includes("dialer.ai"),
  );
  // Supervisors dial the whole org pool; reps dial only their own uploads
  // (mirrors getDialQueue's server-side scoping).
  const dialScope: "org" | "own" =
    isSupervisorRole(viewer.role) ? "org" : "own";
  // The effective caller-ID pool (org settings, or the platform-locked env pool
  // when TWILIO_CALLER_IDS is set) — lets the dialer's caller-ID picker offer
  // exactly the numbers nextCallerId*() will actually validate an override against.
  const { pool: orgCallerIdPool, rotateEvery: callerIdRotateEvery } = getPlatformPool(
    viewer.org?.settings ?? null,
  );
  // Narrowed to a rep's own assignment (same call the power-dialer route makes
  // server-side) so the picker never OFFERS a number a rep isn't actually
  // allowed to dial from. owner/admin/manager see the org's whole pool, same
  // as today — this is a no-op for them regardless of anything assigned.
  const callerIdPool = restrictToAssignedNumbers(
    orgCallerIdPool,
    viewer.role,
    viewer.callerIds,
  );
  // The org's intake groups drive the dialer's group filter (labels only — the
  // dialer never needs the AI rule text), and the viewer's own dialer prefs
  // come off their profile. enforcedHumanLines rides alongside: the org's
  // OWN recent abandonment rate (lib/db/abandonment.ts) can lower the real
  // ceiling below what Admin has configured, and the dialer must show that
  // lowered number rather than offering "10X" only to have the dial route
  // silently truncate every parallel session to 1 line with no visible reason.
  const orgConfiguredLines = Math.max(
    1,
    Math.floor(Number(viewer.org?.settings.dialing.maxLines)) || MAX_PARALLEL_HUMAN,
  );
  const [orgLeadGroupsRaw, uiPreferences, enforcedHumanLines] = await Promise.all([
    listLeadGroups(viewer.org?.id ?? null),
    getUiPreferences(),
    enforcedParallelCeiling({
      orgId: viewer.org?.id ?? null,
      orgConfiguredCeiling: orgConfiguredLines,
    }),
  ]);
  const orgLeadGroups = orgLeadGroupsRaw.map((g) => ({
    key: g.key,
    label: g.label,
  }));

  // ── Template-driven dialer shape ───────────────────────────────────────────
  // The vertical template presets the field schema, the qualify field list and
  // the page layout; org settings override the preset key-by-key. Resolved here
  // (server-side, per request) so switching the template in Admin re-derives
  // everything the org never explicitly overrode.
  const orgSettings = viewer.org?.settings;
  const profile = templateProfile(viewer.org?.dialerTemplate);
  const savedCoreKeys = new Set(
    (orgSettings?.leadFields ?? []).filter((f) => f.source === "core").map((f) => f.key),
  );
  let leadFields = resolveLeadFields(orgSettings?.leadFields, profile.fields);
  // Legacy double-gate, kept: solar slots appear only for the solar vertical
  // with the qualify toggle on — unless the org's own schema explicitly
  // overrides a slot (explicit org config wins, same as resolveLeadFields).
  const solarAllowed =
    isSolarVertical(viewer.org?.dialerTemplate) &&
    (orgSettings?.qualify?.showSolarPayment ?? true);
  if (!solarAllowed) {
    leadFields = leadFields.filter(
      (f) => savedCoreKeys.has(f.key) || (f.key !== "solarPayment" && f.key !== "solarProvider"),
    );
  }
  // Slots the template hides are dropped from the dialer's schema entirely
  // (rather than carried along with both visibility flags off), so the lead
  // panel and search never surface another vertical's fields.
  const templateHidden = new Set(profile.fields?.hidden ?? []);
  leadFields = leadFields.filter((f) => savedCoreKeys.has(f.key) || !templateHidden.has(f.key));
  // Legacy third-toggle label: an admin-customized label (anything beyond the
  // two seed defaults) still renames the Battery slot, unless the org's schema
  // already overrides that slot explicitly.
  const legacyOtherLabel = orgSettings?.qualify?.otherToggleLabel?.trim();
  if (
    legacyOtherLabel &&
    legacyOtherLabel !== "Battery" &&
    legacyOtherLabel !== "Other" &&
    !savedCoreKeys.has("hasBattery")
  ) {
    leadFields = leadFields.map((f) =>
      f.key === "hasBattery" ? { ...f, label: legacyOtherLabel } : f,
    );
  }
  // Which fields the qualify panel renders (org → template preset → every field
  // flagged showInQualify). mergeSettings keeps an absent list `undefined` and an
  // explicit empty one `[]`, which is the distinction resolveQualifyFields turns
  // into "inherit" vs "render nothing".
  const qualifyFields = resolveQualifyFields(
    orgSettings?.qualify?.fields,
    profile.qualifyFields,
    leadFields,
  );
  // Effective page layout: default all-on ⊕ template preset ⊕ org toggles.
  const dialerLayout = {
    ...DEFAULT_DIALER_LAYOUT,
    ...(profile.dialerLayout ?? {}),
    ...(orgSettings?.dialerLayout ?? {}),
  };

  const dialerConfig = {
    userId: viewer.user?.id,
    // Presence on the org floor channel tracks a human-readable name.
    displayName: viewer.displayName,
    // Names the org's private realtime floor channel (answered fast-path, live
    // floor). Absent in demo — every realtime consumer then reports offline
    // and falls back to polling.
    orgId: viewer.org?.id ?? null,
    // Org policy: record manual conference calls. The rep leg passes exactly
    // this to Twilio, and the dialer's RecordingIndicator reports exactly this.
    recordingEnabled: viewer.org?.settings.dialing.recording ?? true,
    // Lease-based dial claims (two-reps-same-lead fix). Needs a database —
    // demo mode stays on the legacy local queue path.
    reservationsEnabled:
      isSupabaseConfigured() &&
      Boolean(viewer.org?.id) &&
      (viewer.org?.settings.dialing.reservations ?? true),
    voiceConfigured: isVoiceConfigured(),
    aiAgentConfigured: isElevenLabsConfigured(),
    // A second AI persona the rep can pick in the dialer (feature is hidden unless set).
    secondAgentConfigured: isSecondAgentConfigured(),
    agentNames: agentLabels(),
    manualEnabled,
    aiEnabled,
    aiLockReason,
    dialScope,
    // The org's voice-plan concurrency allowance — the dialer holds itself to it.
    maxAiConcurrency: viewer.org?.settings.ai.maxConcurrentCalls ?? 10,
    // Admin → Dialing → "Max lines", clamped by the org's OWN recent
    // abandonment rate (enforcedHumanLines, computed above) — never the raw
    // setting alone. A team that wants single-line dialing sets it to 1 and
    // 2X/3X disappears; a team whose rate has climbed gets throttled the same
    // way whether or not anyone remembered to check the Admin panel.
    maxHumanLines: enforcedHumanLines,
    callerIdPool,
    callerIdRotateEvery,
    // Local presence default: dial from a pool number in the lead's own area
    // code when one exists. The rep can flip it per-session on the dialer.
    localPresence: viewer.org?.settings.dialing.localPresence ?? true,
    // Double-dial (double-tap): AI bot re-rings a no-answer once after a short gap.
    doubleDial: viewer.org?.settings.dialing.doubleDial ?? false,
    doubleDialGapSec: viewer.org?.settings.dialing.doubleDialGapSec ?? 15,
    // Power mode: finished manual calls auto-classify + keep dialing instead of
    // stopping on the wrap-up screen. Both are org defaults the rep can flip live.
    autoDispose: viewer.org?.settings.dialing.autoDispose ?? false,
    autoConfirmDisposition: viewer.org?.settings.dialing.autoConfirmDisposition ?? false,
    // Which mode the dialer boots into (Admin → Dialing → Default mode). The
    // engine falls back to manual when the chosen mode isn't usable.
    defaultDialMode: viewer.org?.settings.dialing.defaultMode ?? "ai",
    // Admin → Calling hours: the dialer's outside-hours banner (advisory) and,
    // when `enforced`, mirrored by the server-side refusal in the call routes.
    callingHours: viewer.org?.settings.hours ?? null,
    orgTimezone: viewer.org?.timezone ?? "America/Chicago",
    // The viewer's own dialer prefs (Settings → Dialer preferences).
    userPrefs: parseDialerUserPrefs(uiPreferences),
    // The session builder's remembered choices, so it reopens as it was left.
    savedSession: parseDialerSessionPrefs(uiPreferences),
    // Per-tenant qualification-panel shape (solar field + third toggle label).
    // A non-solar vertical drops the solar field regardless of the qualify
    // setting, so a tenant never has to switch off solar wording in two places.
    qualifyShowSolarPayment: solarAllowed,
    qualifyOtherLabel: viewer.org?.settings.qualify?.otherToggleLabel ?? "Battery",
    // The template-resolved dialer shape (see the block above).
    dialerLayout,
    leadFields,
    qualifyFields,
    // Per-org "dropbox" label overrides (display only).
    leadGroupLabels: viewer.org?.settings.leadGroupLabels ?? {},
    leadGroups: orgLeadGroups,
    // Gates supervisor-only dialer affordances (reverse search). Every one is
    // re-checked server-side — this only decides what gets drawn.
    permissions: viewer.permissions,
    // Is an automated skip-trace provider configured? When false, the reverse-
    // search button drops to zero-config manual mode: open Whitepages in a tab,
    // read the number off it, type it back — no API key, no server lookup.
    reverseSearchConfigured: isReverseSearchConfigured(),
  };

  return (
    <AppShell
      voiceConfigured={isVoiceConfigured()}
      aiConfigured={isAIConfigured()}
      account={account}
      permissions={viewer.permissions}
      features={viewer.org?.settings.features ?? null}
      orgName={viewer.org?.name ?? null}
      productName={viewer.org?.productName || null}
      brandColor={viewer.org?.brandColor || null}
      accentColor={viewer.org?.accentColor || null}
      logoUrl={viewer.org?.logoUrl || null}
      // Resolved once, per request, and handed to every Client Component under
      // the shell — so no screen has to hardcode "homeowner" or re-derive the
      // vertical's nouns for itself.
      vocabulary={orgVocabulary(viewer.org)}
      role={viewer.role}
      superadmin={superadmin}
      dialerConfig={dialerConfig}
    >
      {children}
    </AppShell>
  );
}
