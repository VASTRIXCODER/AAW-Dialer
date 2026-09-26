import { ArrowRight, ClipboardList, UploadCloud, Users } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import {
  LeadsTable,
  type LeadsTableFilters,
  type SmartListChip,
} from "@/components/leads/leads-table";
import { ExportDialog } from "@/components/leads/export-dialog";
import { GroupUploadGrid } from "@/components/leads/group-upload-grid";
import { LeadCountsRow, type LeadCountKey } from "@/components/leads/lead-counts-row";
import { EmptyState } from "@/components/shared/empty-state";
import { Card } from "@/components/ui/card";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import {
  getLeadsPage,
  getMissingCountyCount,
  getMissingTimezoneCount,
  LEADS_PAGE_SIZE,
  listPlaces,
  type LeadsSort,
} from "@/lib/db/leads";
import { getFilteredLeadsPage, getLeadCounts } from "@/lib/db/leads-filter";
import { getScope } from "@/lib/db/scope";
import { listSmartLists, validateSmartListFilter } from "@/lib/db/smart-lists";
import { getCampaigns } from "@/lib/db/pipeline";
import { listLeadGroupsWithCounts } from "@/lib/db/lead-groups";
import { resolveLeadFields, type CoreFieldOverrides } from "@/lib/leads/field-schema";
import {
  buildCountFilter,
  decodeFilterParam,
  encodeFilterParam,
} from "@/lib/leads/filter-spec";
import { isLeadSortKey } from "@/lib/leads/sort-keys";
import { getViewer, listMembers } from "@/lib/org/membership";
import { templateProfile } from "@/lib/org/templates";
import { orgVocabulary } from "@/lib/org/vocabulary";
import { isSolarVertical } from "@/lib/org/vertical";
import { leadStatusConfig } from "@/lib/status";
import type { LeadStatus } from "@/lib/types";

export const metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse `?sort=key.dir` — unknown keys and malformed values drop to undefined
 *  (upload order) rather than forwarding user input to the RPC. The whitelist
 *  is LEAD_SORT_KEYS (the keys app_leads_page's CASE accepts); the SQL
 *  re-validates anyway (defense in depth). */
function parseSort(raw: string | undefined): LeadsSort | undefined {
  if (!raw) return undefined;
  const dot = raw.indexOf(".");
  const key = dot > 0 ? raw.slice(0, dot) : raw;
  if (!isLeadSortKey(key)) return undefined;
  return { key, dir: raw.slice(dot + 1) === "desc" ? "desc" : "asc" };
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Filters live in the URL so pagination survives router.refresh() after
  // bulk actions, and so a filtered view is shareable/bookmarkable.
  const raw = await searchParams;
  // The App Router delivers a REPEATED param as an array — take the first
  // rather than crashing on ['smith','jones'].trim().
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const sp = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, one(v)]));
  const status =
    sp.status && sp.status in leadStatusConfig ? (sp.status as LeadStatus) : undefined;
  // A malformed ?uploader= would fail the RPC's uuid cast and render the whole
  // book as the onboarding empty state — validate instead of forwarding.
  const uploaderId = sp.uploader && UUID.test(sp.uploader) ? sp.uploader : undefined;
  const sort = parseSort(sp.sort);
  const pageNum = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  // The typed-filter RPC and the tile counts both trust an ALREADY-AUTHORIZED
  // scope; demo mode has no session, so fall back the same way the count route
  // does (the demo paths ignore the ids anyway).
  const scope = (await getScope()) ?? { userId: "demo", orgId: null, supervisor: true };

  const [campaigns, viewer, places, counts, smartLists] = await Promise.all([
    getCampaigns(),
    getViewer(),
    listPlaces(),
    getLeadCounts(scope),
    listSmartLists(scope),
  ]);

  // ?f= — a typed FilterSpec (base64url). Decode + sanitize server-side; a
  // mangled param degrades to whatever conditions survive (null = no filter).
  // The RE-ENCODED canonical param is what travels back to the table, so the
  // URL the table preserves always matches the filter the server ran.
  let filterSpec = sp.f ? decodeFilterParam(sp.f) : null;
  // Legacy ?smart= bookmarks: a seeded KEY translates into its DB list's
  // FilterSpec right here, so old links run through the same ?f= pipeline the
  // chips use (and the matching chip lights up by canonical param). A key
  // without a list (deleted, or a solar-only key on a non-solar org) falls
  // through to the legacy p_smart read unchanged.
  let smartTranslated = false;
  if (!filterSpec && sp.smart) {
    const legacyList = smartLists.find((l) => l.key === sp.smart);
    if (legacyList) {
      filterSpec = legacyList.filter;
      smartTranslated = true;
    }
  }
  const fParam = filterSpec ? encodeFilterParam(filterSpec) : undefined;
  const filters: LeadsTableFilters = {
    q: sp.q?.trim() || undefined,
    status,
    smart: smartTranslated ? undefined : sp.smart || undefined,
    group: sp.group || undefined,
    county: sp.county || undefined,
    city: sp.city || undefined,
    campaignId: sp.campaign || undefined,
    uploaderId,
    mine: sp.mine === "1",
    // The VALIDATED value goes back to the table, so its headers only ever
    // reflect a sort the server actually applied.
    sort: sort ? `${sort.key}.${sort.dir}` : undefined,
    f: fParam,
  };

  let leads;
  let total: number;
  let page = pageNum;
  let pageSize = LEADS_PAGE_SIZE;
  // The scope-wide total only exists on the legacy read; the typed-filter
  // path skips the onboarding empty state (a filter implies a book).
  let bookTotal: number | null = null;

  if (filterSpec) {
    // ?f= REPLACES the legacy filter set for the row read — one grammar, one
    // source of truth. Legacy params still ride the URL untouched for when the
    // filter is cleared.
    const opts = { filter: filterSpec, sort: sort ? [sort] : undefined };
    let result = await getFilteredLeadsPage(scope, {
      ...opts,
      offset: (pageNum - 1) * pageSize,
      limit: pageSize,
    });
    // Same out-of-range clamp as the legacy path (stale bookmark, shrunk set).
    if (result.leads.length === 0 && result.total > 0 && pageNum > 1) {
      const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
      if (lastPage < pageNum) {
        page = lastPage;
        result = await getFilteredLeadsPage(scope, {
          ...opts,
          offset: (lastPage - 1) * pageSize,
          limit: pageSize,
        });
      }
    }
    leads = result.leads;
    total = result.total;
  } else {
    let pageData = await getLeadsPage({ page: pageNum, ...filters, sort });
    // Out-of-range page (stale bookmark, or the last row of the last page was
    // just deleted and router.refresh() kept ?page=N): clamp to the real last
    // page instead of rendering a book that looks empty.
    if (pageData.leads.length === 0 && pageData.total > 0 && pageNum > 1) {
      const lastPage = Math.max(1, Math.ceil(pageData.total / pageData.pageSize));
      if (lastPage < pageNum) {
        pageData = await getLeadsPage({ page: lastPage, ...filters, sort });
      }
    }
    ({ leads, total, page, pageSize } = pageData);
    bookTotal = pageData.stats.total;
  }
  // The org's own intake groups (+ how many leads sit in each, and in the
  // Miscellaneous catch-all) drive both the upload tiles and the group filter.
  // missingCountyCount/missingTimezoneCount ride alongside it — all three are
  // org-scoped HEAD counts that only Edit groups needs, gated behind the same
  // canManage check.
  const [{ groups: leadGroups, miscCount }, missingCountyCount, missingTimezoneCount] =
    await Promise.all([
      listLeadGroupsWithCounts(viewer.org?.id ?? null),
      getMissingCountyCount(viewer.org?.id ?? null),
      getMissingTimezoneCount(viewer.org?.id ?? null),
    ]);
  // Lead management (delete / reassign) is for managers+ (leads.import). Pull the
  // org's members so a supervisor can reassign leads between accounts.
  const canManage = viewer.permissions.includes("leads.import");
  // Per-org "dropbox" label overrides (display only) — e.g. show "San Antonio"
  // where the underlying bucket key is still "fresno".
  const groupLabels = viewer.org?.settings.leadGroupLabels ?? {};
  // ACTIVE members only. listMembers returns everyone who isn't 'removed' —
  // which includes people still 'pending' approval — but every assignment path
  // (assignLeadsToRep, reassignLeads, assignPack) requires an ACTIVE member and
  // hard-fails otherwise. Offering a pending teammate in these dropdowns is how
  // "rep assignments don't work" happened: the name was pickable, and the
  // assignment came back "That person isn't a member of your organization."
  // Filtered here rather than inside listMembers because Admin genuinely needs
  // the pending rows — that screen is where they get approved.
  const members =
    canManage && viewer.org
      ? (await listMembers(viewer.org.id))
          .filter((m) => m.status === "active")
          .map((m) => ({ id: m.userId, name: m.name }))
      : [];
  const campaignList = campaigns
    .filter((c) => c.status !== "completed")
    .map((c) => ({ id: c.id, name: c.name }));

  // The org's effective lead-field schema: explicit settings.leadFields when
  // saved (imports/Admin), otherwise the core slots with the dialer template's
  // relabels/hides applied. TemplateProfile.fields ships with the templates
  // half of this epic — read it defensively so either half builds alone.
  const fields = resolveLeadFields(
    viewer.org?.settings.leadFields,
    (templateProfile(viewer.org?.dialerTemplate) as { fields?: CoreFieldOverrides })
      .fields,
  );

  // Smart-list chips, pre-digested for the client: each list's filter encoded
  // to its canonical ?f= param (same encoder as the count tiles, so active-chip
  // matching is param-for-param) and validated against the org's resolved
  // schema — a list referencing a vanished custom field gets an amber dot
  // instead of quietly reading as "empty list."
  const meId = viewer.user?.id ?? null;
  const smartChips: SmartListChip[] = smartLists.map((l) => ({
    id: l.id,
    key: l.key,
    name: l.name,
    description: l.description,
    tone: l.tone,
    favorite: l.favorite,
    param: encodeFilterParam(l.filter),
    warnings: validateSmartListFilter(l.filter, fields),
    canEdit: canManage || (l.ownerId != null && l.ownerId === meId),
  }));

  // Tile → URL: each count key encodes its own FilterSpec into ?f=. "active"
  // (no exclusions) is the bare page. The tile whose canonical param matches
  // the current ?f= renders highlighted — encode-for-encode, since every tile
  // href came from the same encoder.
  const countHrefs = {} as Record<LeadCountKey, string>;
  let activeCountKey: LeadCountKey | null = null;
  for (const key of Object.keys(counts) as LeadCountKey[]) {
    const tileSpec = buildCountFilter(key);
    const enc = tileSpec ? encodeFilterParam(tileSpec) : "";
    countHrefs[key] = enc ? `/leads?f=${enc}` : "/leads";
    if (enc && fParam === enc) activeCountKey = key;
  }

  // "homeowner" was hardcoded here, so every vertical read the solar tenant's
  // noun on its own leads page. orgVocabulary owns that precedence now (org
  // setting → vertical → neutral), in one place, for every screen.
  const vocab = orgVocabulary(viewer.org);
  const header = (
    <PageHeader
      title={vocab.LeadNounPlural}
      description={`Every ${vocab.leadNoun} in your pipeline, scored and ready to dial.`}
    >
      {/* Hidden for reps: Export v2 is gated on `leads.export` (manager+ by
          default), so showing the button to everyone would just hand a rep a
          403. The dialog receives the CURRENT sanitized ?f= spec (null = the
          whole scope) so what exports always matches what's on screen; the
          legacy re-import-format GET stays reachable from inside the dialog. */}
      {/* The Import Studio's front door. Until now the ONLY paths in were
          dropping a file on the collapsed group grid or a link buried in
          Admin — reps with the leads.import override literally could not find
          it. Same gate as the studio page itself, so this never 403-screens. */}
      {canManage && (
        <Link
          href="/leads/import"
          className={buttonVariants({ variant: "outline", size: "sm", className: "gap-2" })}
        >
          <UploadCloud className="h-4 w-4" />
          Import
        </Link>
      )}
      {viewer.permissions.includes("leads.export") && (
        <ExportDialog
          filterSpec={filterSpec}
          fields={fields}
          templates={viewer.org?.settings.exportTemplates ?? []}
          canSaveTemplates={viewer.permissions.includes("org.edit")}
        />
      )}
    </PageHeader>
  );

  // Scope-wide total, not the current page/filter — an empty BOOK gets the
  // onboarding empty state; an empty filter result renders inside the table.
  if (bookTotal === 0) {
    return (
      <PageContainer>
        {header}
        <GroupUploadGrid
          canImport={canManage}
          groups={leadGroups}
          miscCount={miscCount}
          missingCountyCount={missingCountyCount}
          missingTimezoneCount={missingTimezoneCount}
        />
        <EmptyState
          icon={Users}
          title="No leads yet"
          description={
            canManage
              ? "Import a CSV above, or connect your CRM to start building your dialing queue."
              : "Ask a manager or admin to import leads to start building your dialing queue."
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <GroupUploadGrid
        canImport={canManage}
        groups={leadGroups}
        miscCount={miscCount}
        missingCountyCount={missingCountyCount}
        missingTimezoneCount={missingTimezoneCount}
      />
      {/* Pack assignment moved to the Assignment Center (Phase 1 · D1) — one
          place to allocate, track, and rebalance work instead of an inline
          panel. LeadPacksPanel stays in the tree, just unused. */}
      {canManage && (
        <Link href="/assignments" className="block">
          <Card className="flex items-center justify-between gap-3 p-5 transition-shadow hover:shadow-lift">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <ClipboardList className="h-4 w-4" />
              </span>
              <div>
                <h3 className="font-semibold tracking-tight">Assignments</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Allocate {vocab.leadNounPlural} to reps and track live progress
                </p>
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-primary">
              Manage assignments
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </Card>
        </Link>
      )}

      {/* The 8 drillable tiles (app_lead_counts) — each links straight into
          the typed filter that computes it, so a number and its drilled row
          set can never disagree. Replaced the old 4-KPI MetricCard row. */}
      <LeadCountsRow
        counts={counts}
        hrefFor={(key) => countHrefs[key]}
        active={activeCountKey}
      />

      <LeadsTable
        leads={leads}
        total={total}
        page={page}
        pageSize={pageSize}
        smartLists={smartChips}
        filters={filters}
        // The SANITIZED spec behind filters.f — the filter-summary bar and the
        // builder drawer seed from it, so the UI always reflects what actually
        // ran (not whatever a mangled URL claimed).
        filterSpec={filterSpec}
        campaigns={campaignList}
        canManage={canManage}
        meId={meId}
        members={members}
        labelOverrides={groupLabels}
        orgGroups={leadGroups.map((g) => ({ key: g.key, label: g.label }))}
        orgCounties={places.counties}
        orgCities={places.cities}
        fields={fields}
        // Both signals, one prop: a non-solar vertical drops the solar fields
        // outright, and a solar org can still switch them off per-tenant.
        showSolarPayment={
          isSolarVertical(viewer.org?.dialerTemplate) &&
          (viewer.org?.settings.qualify?.showSolarPayment ?? true)
        }
      />
    </PageContainer>
  );
}
