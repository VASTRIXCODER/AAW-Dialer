import "server-only";

import { timezoneForAddress } from "../leads/address-timezone";
import { leads as fallbackLeads, getLeadById as fallbackById } from "../data";
import { DIALABLE_STATUSES } from "../leads/dialable";
import {
  hasStructuredPredicates,
  leadMatchesParsedQuery,
  parseLeadQuery,
} from "../leads/search-heuristics";
import { SMART_LISTS, countSmartLists, smartListById } from "../leads/smart-lists";
import { isLeadSortKey, type LeadSortKey } from "../leads/sort-keys";
import { countyForZip } from "../leads/zip-county";
import { createAdminClient, isAdminConfigured } from "../supabase/admin";
import { isSupabaseConfigured } from "../supabase/config";
import { createClient } from "../supabase/server";
import type { Lead, LeadGroup, LeadStatus } from "../types";
import { normalizePhone } from "../utils";
import { getDncDigits, scrubDnc } from "./dnc";
import { logLeadEvent } from "./lead-events";
import { canActOn, getScope, readProfileScope } from "./scope";

// Account-scoped lead access. When Supabase is configured and the user is signed
// in, reads come from their `leads` table (RLS-enforced); otherwise it falls
// back to the in-memory source so demo mode keeps working.

// Local alias of the shared list (leads/dialable.ts) — spread because the
// Supabase `.in()` builders want a mutable array.
const DIALABLE: LeadStatus[] = [...DIALABLE_STATUSES];

/**
 * Strip the `+00` Postgres tacks onto `appointments.scheduled_at` (declared
 * timestamptz but holding a floating wall-clock — see
 * src/lib/appointments/time.ts for the invariant). Mirrors the identical local
 * helper in db/pipeline.ts; not shared because it's three lines.
 */
const toFloatingLocal = (v: string): string => {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(v);
  return m ? `${m[1]}T${m[2]}` : v;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// THE 1,000-ROW CEILING
//
// PostgREST caps every response at 1,000 rows by default. `.select("*")` with no
// `.range()` therefore returns AT MOST 1,000 rows — silently, with no error and
// nothing to indicate anything was withheld. This account has 17,342 leads, so
// the Leads tab showed 1,000 of them and the dial queue silently truncated to
// 1,000 even though 15,136 leads are dialable.
//
// Anything that must return "all" rows has to page explicitly.
// ─────────────────────────────────────────────────────────────────────────────

/** PostgREST's per-response ceiling. Pages are requested at exactly this size. */
const PAGE = 1000;
/** Hard stop so a runaway table can never OOM the server. */
const MAX_PAGED_ROWS = 100_000;

/**
 * Read EVERY row a query matches, paging past the 1,000-row cap.
 * `build()` must return a FRESH query builder each call (they aren't reusable).
 */
async function fetchAllPaged(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < MAX_PAGED_ROWS; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break; // short page ⇒ end of the table
  }
  return out;
}

export function rowToLead(r: Row): Lead {
  const num = (v: unknown) => (v == null ? undefined : Number(v));
  return {
    id: String(r.id),
    firstName: (r.first_name as string) ?? "",
    lastName: (r.last_name as string) ?? "",
    phone: (r.phone as string) ?? "",
    email: (r.email as string) ?? undefined,
    address: (r.address as string) ?? "",
    city: (r.city as string) ?? "",
    state: (r.state as string) ?? "",
    zip: (r.zip as string) ?? "",
    utilityProvider: (r.utility_provider as string) ?? "",
    solarProvider: (r.solar_provider as string) ?? "",
    status: ((r.status as LeadStatus) ?? "new"),
    campaignId: (r.campaign_id as string) ?? "",
    assignedRepId: (r.assigned_rep_id as string) ?? undefined,
    leadGroup: (r.lead_group as LeadGroup) ?? undefined,
    leadPackId: (r.lead_pack_id as string) ?? undefined,
    county: (r.county as string) || undefined,
    solarPayment: num(r.solar_payment),
    utilityBill: num(r.utility_bill),
    hasEV: Boolean(r.has_ev),
    hasPool: Boolean(r.has_pool),
    hasBattery: Boolean(r.has_battery),
    multipleSystems: Boolean(r.multiple_systems),
    notes: (r.notes as string) ?? undefined,
    aiScore: r.ai_score == null ? undefined : Number(r.ai_score),
    // NOT "America/Los_Angeles" — that was the exact bug a 2026-08-30 migration
    // (see supabase/schema.sql) removed the column's bogus DEFAULT to fix: every
    // lead without a real stored zone read as Pacific, which is wrong in the
    // direction that makes an out-of-hours call look fine. resolveLeadTimezone
    // (lib/dialer/lead-timezone.ts) treats an empty string as "no stored zone"
    // and falls through to the phone-area-code inference — but only if this
    // mapper actually HANDS it an empty string instead of re-inventing the same
    // fake default one layer up in JS. "" satisfies Lead.timezone's `string`
    // type without lying the way a fallback IANA zone would.
    timezone: (r.timezone as string) ?? "",
    lastContactedAt: (r.last_contacted_at as string) ?? undefined,
    createdAt: (r.created_at as string) ?? new Date().toISOString(),
    ownerId: (r.owner_id as string) ?? undefined,
    customFields:
      r.custom_fields && typeof r.custom_fields === "object"
        ? (r.custom_fields as Record<string, string | number | boolean>)
        : undefined,
  };
}

/** Is this profile role a supervisor (sees the whole org, not just own leads)? */

/**
 * ORDERING: upload order (created_at, then id) — the order rows came out of the
 * uploaded sheet, matching the dial queue so the Leads tab and the dialer agree.
 *
 * This used to sort by ai_score desc, which is not a fixed property of a lead:
 * recordAIOutcome() writes a fresh score back to the row after every call, so
 * the list re-sorted itself as reps worked it and leads appeared to shuffle.
 *
 * Rows imported before per-row created_at stamping (see insertLeads) all share
 * one batch timestamp, so they order by id within a batch — batches are still
 * correctly ordered relative to each other, but a pre-existing list can't
 * recover its original in-file order without a re-import.
 */
export async function getLeads(): Promise<Lead[]> {
  // Bundled sample leads ONLY in demo mode (no Supabase). A configured
  // deployment never shows placeholder data — a fresh org reads as empty.
  if (!isSupabaseConfigured()) return fallbackLeads;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    const supervisor =
      prof.supervisor && isAdminConfigured();

    // Leads are SEPARATED BY UPLOADER. A rep sees only the leads they uploaded
    // WITHIN THEIR CURRENT ORG (never a past org's rows just because they still
    // own them); a supervisor (owner/admin/manager) sees the whole org,
    // attributed to each uploader so the Leads tab can group them into
    // per-account sections.
    // Both branches PAGE — an un-ranged select silently stops at 1,000 rows, which
    // is why a 17,342-lead book rendered (and reported its total) as 1,000.
    if (!supervisor) {
      // Own uploads OR leads assigned to this rep (assigned_rep_id) — the Leads
      // tab mirrors the dial queue so a rep sees exactly what they can dial.
      const rows = await fetchAllPaged(() => {
        let q = supabase
          .from("leads")
          .select("*")
          .or(`owner_id.eq.${user.id},assigned_rep_id.eq.${user.id}`);
        if (orgId) q = q.eq("org_id", orgId);
        // Upload order — see the ORDERING note above getLeads().
        return q.order("created_at", { ascending: true }).order("id", { ascending: true });
      });
      return rows.map(rowToLead);
    }

    // Supervisor: the org pool + any of their own leads that predate org
    // scoping (org_id null — never another org's, which would still have a
    // real, different org_id), deduped, with each uploader's display name
    // resolved for sections.
    const admin = createAdminClient();
    const [orgRows, ownRows, memberRes] = await Promise.all([
      fetchAllPaged(() =>
        admin
          .from("leads")
          .select("*")
          .eq("org_id", orgId as string)
          .order("id", { ascending: true }),
      ),
      fetchAllPaged(() =>
        admin
          .from("leads")
          .select("*")
          .eq("owner_id", user.id)
          .is("org_id", null)
          .order("id", { ascending: true }),
      ),
      admin
        .from("organization_members")
        .select("user_id,name")
        .eq("org_id", orgId as string)
        .eq("status", "active"),
    ]);
    const nameById = new Map(
      ((memberRes.data ?? []) as Row[]).map((m) => [
        String(m.user_id),
        String(m.name ?? ""),
      ]),
    );
    const byId = new Map<string, Row>();
    for (const r of [...orgRows, ...ownRows]) {
      byId.set(String((r as Row).id), r as Row);
    }
    return [...byId.values()]
      .map(rowToLead)
      .map((l) => ({
        ...l,
        ownerName: l.ownerId ? nameById.get(l.ownerId) || "" : "",
      }))
      // Upload order. Sorted here rather than in SQL because this list is the
      // union of two queries (org pool + own pre-org rows); id breaks ties so
      // the order is total and stable across reloads.
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt < b.createdAt
            ? -1
            : 1,
      );
  } catch {
    return [];
  }
}

/**
 * PostgREST `.or()` filter strings are parsed on delimiters, and ilike values
 * carry LIKE wildcards — strip everything that could break out of (or wildcard
 * inside) `col.ilike.%token%` before interpolating a user-typed word.
 */
const sanitizeFilterToken = (t: string) => t.replace(/[,()%_\\]/g, "");

/** Text columns the lexical stage matches lead-search tokens against. */
const SEARCH_TEXT_COLUMNS = [
  "first_name",
  "last_name",
  "city",
  "state",
  "utility_provider",
  "solar_provider",
  "notes",
] as const;

/**
 * STAGE 1 of the AI lead search: retrieve a bounded candidate set for a
 * natural-language query, so getSemanticSearch (stage 2) reranks ~80 relevant
 * rows instead of the first 80 of the whole book in upload order.
 *
 * Scope is EXACTLY getLeads': rep → own uploads + assigned, pinned to their
 * current org; supervisor → the org pool plus their own pre-org rows
 * (org_id null). The query parse (src/lib/leads/search-heuristics.ts) drives up
 * to two cheap queries — structured predicates (bill bounds, EV/pool/battery,
 * status, never-called) and a lexical ilike OR over the text columns — whose
 * results are UNIONED, never AND-required: a purely structured query
 * ("homeowners overpaying with an EV") has almost no lexical surface, and a
 * purely lexical one ("smiths in fresno") has no structure. A query that parses
 * to neither returns the first `limit` leads in upload order, preserving the
 * old first-N behavior. Demo and no-service-key deployments filter in JS with
 * the same parse, so every mode agrees on what a query means.
 */
export async function searchLeadCandidates(query: string, limit = 80): Promise<Lead[]> {
  const parsed = parseLeadQuery(query);
  const jsFilter = (all: Lead[]) =>
    all.filter((l) => leadMatchesParsedQuery(l, parsed)).slice(0, limit);

  // Demo mode: the bundled sample book, same heuristics.
  if (!isSupabaseConfigured()) return jsFilter(fallbackLeads);
  // Degraded self-host mode (no service key): getLeads() already falls back to
  // the rep-scoped RLS read for everyone, so filter that in JS — correct, just
  // not cheap. Never crash without full credentials is documented policy.
  if (!isAdminConfigured()) return jsFilter(await getLeads());

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    const supervisor = prof.supervisor;

    // Fresh builder per query (PostgREST builders aren't reusable). Both
    // branches mirror getLeads: multiple PostgREST filters AND together, so the
    // scope .or() below combines with the per-stage predicates correctly.
    const baseScope = () => {
      if (supervisor) {
        // Org pool + the supervisor's own pre-org rows (org_id null) — those
        // must stay searchable, matching what the Leads tab shows them.
        return createAdminClient()
          .from("leads")
          .select("*")
          .or(`org_id.eq.${orgId},and(owner_id.eq.${user.id},org_id.is.null)`);
      }
      let q = supabase
        .from("leads")
        .select("*")
        .or(`owner_id.eq.${user.id},assigned_rep_id.eq.${user.id}`);
      if (orgId) q = q.eq("org_id", orgId);
      return q;
    };
    // Upload order within each stage — same ordering contract as getLeads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finish = (q: any) =>
      q
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = async (q: any): Promise<Row[]> => {
      const { data, error } = await q;
      return error ? [] : ((data ?? []) as Row[]);
    };

    const stages: Promise<Row[]>[] = [];

    if (hasStructuredPredicates(parsed)) {
      let q = baseScope();
      if (parsed.wantsEV) q = q.eq("has_ev", true);
      if (parsed.wantsPool) q = q.eq("has_pool", true);
      if (parsed.wantsBattery) q = q.eq("has_battery", true);
      if (parsed.minBill !== null) q = q.gte("utility_bill", parsed.minBill);
      if (parsed.maxBill !== null) q = q.lte("utility_bill", parsed.maxBill);
      if (parsed.statuses.length) q = q.in("status", parsed.statuses);
      if (parsed.neverCalled) q = q.is("last_contacted_at", null);
      stages.push(run(finish(q)));
    }

    // Cap the token count so the request URL stays small; tokens are already
    // plain [a-z0-9] words, sanitized again here as defense in depth.
    const tokens = parsed.tokens
      .map(sanitizeFilterToken)
      .filter((t) => t.length >= 3)
      .slice(0, 8);
    if (tokens.length) {
      const ors = tokens
        .flatMap((t) => SEARCH_TEXT_COLUMNS.map((col) => `${col}.ilike.%${t}%`))
        .join(",");
      stages.push(run(finish(baseScope().or(ors))));
    }

    // Nothing parseable at all → first `limit` leads in upload order.
    if (!stages.length) stages.push(run(finish(baseScope())));

    const results = await Promise.all(stages);
    const byId = new Map<string, Row>();
    for (const rows of results) {
      for (const r of rows) {
        if (byId.size >= limit) break;
        const id = String(r.id);
        if (!byId.has(id)) byId.set(id, r);
      }
    }
    return [...byId.values()].map(rowToLead);
  } catch {
    return [];
  }
}

/**
 * Delete leads by id (individual or bulk, up to thousands at a time).
 *
 * Two things make a large bulk delete reliable:
 *  1. BATCHING. A single `.in("id", [...])` puts every id into the PostgREST
 *     request URL; a few hundred UUIDs overflow the server's URL-length limit and
 *     the whole call fails with a 400 ("bad request"). We delete in small chunks
 *     so each request URL stays well within limits, run in bounded-parallel waves.
 *  2. SCOPE. The leads write RLS is owner-only, but a supervisor can SEE (and
 *     should be able to clear) the whole shared org pool. So when the viewer is in
 *     an org and a service role is available, we delete with the admin client
 *     scoped IN CODE to "this org's leads OR my own" — never another org's.
 *
 * Call records are preserved (lead_id is set null on delete) so reports stay intact.
 */
export async function deleteLeads(
  leadIds: string[],
): Promise<{ deleted: number; error?: string }> {
  if (!isSupabaseConfigured())
    return { deleted: 0, error: "Connect Supabase to manage leads." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { deleted: 0, error: "You must be signed in." };

    // De-dupe + keep only well-formed UUIDs (defends the PostgREST filter too).
    const ids = [...new Set(leadIds.filter((id) => UUID.test(id)))];
    if (!ids.length) return { deleted: 0, error: "No valid leads selected." };

    // WHO MAY DELETE WHAT.
    //   • Supervisor (owner/admin/manager) → the shared org pool, since they're
    //     the ones responsible for clearing out a bad or finished list.
    //   • Everyone else (a rep) → STRICTLY the leads they uploaded themselves.
    //
    // The role check is what makes that split real. This previously read only
    // `org_id`, so the org-wide branch was taken by ANY member of an org — the
    // moment a rep could reach this function at all, they could delete a
    // teammate's uploads out of the shared pool. Reps now get the session client
    // (whose RLS delete policy is already owner-or-supervisor) AND an explicit
    // owner_id filter below, so neither layer is load-bearing on its own.
    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    const supervisor =
      Boolean(orgId && UUID.test(orgId)) && prof.supervisor && isAdminConfigured();
    const client = supervisor ? createAdminClient() : supabase;

    const CHUNK = 100; // keep each request URL small (≈4KB) — never hits the limit
    const WAVE = 8; // bounded parallelism so big deletes stay fast but safe
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) batches.push(ids.slice(i, i + CHUNK));

    let deleted = 0;
    let firstError: string | null = null;
    for (let w = 0; w < batches.length && !firstError; w += WAVE) {
      const wave = batches.slice(w, w + WAVE);
      const results = await Promise.all(
        wave.map((batch) => {
          const q = client.from("leads").delete().in("id", batch);
          // Supervisor: the admin client bypasses RLS, so scope to their org in
          // code. Rep: never past their own uploads — an id they don't own
          // simply matches nothing and is reported as not-deleted.
          const scoped = supervisor
            ? q.or(`org_id.eq.${orgId},owner_id.eq.${user.id}`)
            : q.eq("owner_id", user.id);
          return scoped.select("id");
        }),
      );
      for (const r of results) {
        if (r.error) firstError = firstError ?? r.error.message;
        else deleted += r.data?.length ?? 0;
      }
    }

    if (firstError && deleted === 0) return { deleted: 0, error: firstError };
    if (firstError)
      return { deleted, error: `Deleted ${deleted}, then hit an error: ${firstError}` };
    return { deleted };
  } catch (e) {
    return { deleted: 0, error: e instanceof Error ? e.message : "Delete failed." };
  }
}

/**
 * Reassign leads to a different uploader (move them between accounts). Supervisor-
 * only and strictly scoped to the viewer's org — you can never move another org's
 * leads, and the target must be an active member of your org. Batched like delete
 * so big moves don't overflow the request URL. Changes owner_id, so the leads
 * move into the target's dial queue + their Leads-tab section.
 */
export async function reassignLeads(
  leadIds: string[],
  toUserId: string,
): Promise<{ updated: number; error?: string }> {
  if (!isSupabaseConfigured())
    return { updated: 0, error: "Connect Supabase to manage leads." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { updated: 0, error: "You must be signed in." };
    const ids = [...new Set(leadIds.filter((id) => UUID.test(id)))];
    if (!ids.length) return { updated: 0, error: "No valid leads selected." };
    if (!UUID.test(toUserId))
      return { updated: 0, error: "Pick a teammate to reassign to." };

    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    if (!orgId || !prof.supervisor || !isAdminConfigured())
      return { updated: 0, error: "Only supervisors can reassign leads." };

    const admin = createAdminClient();
    // The target must be an active member of THIS org. Read the STATUS rather
    // than filtering on it, so a pending teammate gets told they need approving
    // instead of the flatly wrong "isn't a member of your organization".
    const { data: member } = await admin
      .from("organization_members")
      .select("user_id, status")
      .eq("org_id", orgId)
      .eq("user_id", toUserId)
      .maybeSingle();
    if (!member) return { updated: 0, error: "That person isn't in your organization." };
    if (String((member as Row).status) !== "active")
      return {
        updated: 0,
        error: "That teammate is still pending approval — approve them in Admin first.",
      };

    let updated = 0;
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      const { data, error } = await admin
        .from("leads")
        .update({ owner_id: toUserId, org_id: orgId })
        .in("id", batch)
        .eq("org_id", orgId) // never move leads outside the viewer's org
        .select("id");
      if (error) return { updated, error: error.message };
      updated += data?.length ?? 0;
    }
    return { updated };
  } catch (e) {
    return { updated: 0, error: e instanceof Error ? e.message : "Reassign failed." };
  }
}

/**
 * Assign leads to a rep NON-DESTRUCTIVELY — sets `assigned_rep_id` without
 * touching `owner_id`, so the uploader/attribution is preserved but the lead
 * enters that rep's dial queue + Leads tab (getDialQueue / getLeads match on
 * owner OR assignee). Pass `toUserId: null` to clear the assignment. Supervisor-
 * only, strictly org-scoped, and the target is verified to be an active member.
 */
export async function assignLeadsToRep(
  leadIds: string[],
  toUserId: string | null,
): Promise<{ updated: number; error?: string }> {
  if (!isSupabaseConfigured())
    return { updated: 0, error: "Connect Supabase to manage leads." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { updated: 0, error: "You must be signed in." };
    const ids = [...new Set(leadIds.filter((id) => UUID.test(id)))];
    if (!ids.length) return { updated: 0, error: "No valid leads selected." };
    if (toUserId !== null && !UUID.test(toUserId))
      return { updated: 0, error: "Pick a teammate to assign to." };

    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    if (!orgId || !prof.supervisor || !isAdminConfigured())
      return { updated: 0, error: "Only supervisors can assign leads." };

    const admin = createAdminClient();
    // A non-null target must be an active member of THIS org. Status is READ,
    // not filtered on, so a still-pending teammate gets an error that names the
    // actual fix rather than claiming they aren't in the org at all.
    if (toUserId) {
      const { data: member } = await admin
        .from("organization_members")
        .select("user_id, status")
        .eq("org_id", orgId)
        .eq("user_id", toUserId)
        .maybeSingle();
      if (!member) return { updated: 0, error: "That person isn't in your organization." };
      if (String((member as Row).status) !== "active")
        return {
          updated: 0,
          error: "That teammate is still pending approval — approve them in Admin first.",
        };
    }

    let updated = 0;
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      const { data, error } = await admin
        .from("leads")
        .update({ assigned_rep_id: toUserId })
        .in("id", batch)
        .eq("org_id", orgId) // never touch leads outside the viewer's org
        .select("id");
      if (error) return { updated, error: error.message };
      updated += data?.length ?? 0;
    }
    return { updated };
  } catch (e) {
    return { updated: 0, error: e instanceof Error ? e.message : "Assign failed." };
  }
}

/**
 * Distribute leads EVENLY across a set of teammates (round-robin), so a batch
 * uploaded under one account can be split into each rep's own ownership in one
 * action. This is the fix for "everyone's dialing the same leads": once each
 * lead has a distinct owner_id, the own-only dial queue keeps reps off each
 * other's lists automatically. Supervisor-only, strictly org-scoped, and every
 * target is verified to be an active member of the caller's org.
 */
export async function distributeLeads(
  leadIds: string[],
  toUserIds: string[],
): Promise<{ updated: number; perUser: Record<string, number>; error?: string }> {
  if (!isSupabaseConfigured())
    return { updated: 0, perUser: {}, error: "Connect Supabase to manage leads." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { updated: 0, perUser: {}, error: "You must be signed in." };

    const ids = [...new Set(leadIds.filter((id) => UUID.test(id)))];
    if (!ids.length) return { updated: 0, perUser: {}, error: "No valid leads selected." };
    const targets = [...new Set(toUserIds.filter((id) => UUID.test(id)))];
    if (!targets.length) return { updated: 0, perUser: {}, error: "Pick at least one teammate." };

    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    if (!orgId || !prof.supervisor || !isAdminConfigured())
      return { updated: 0, perUser: {}, error: "Only supervisors can distribute leads." };

    const admin = createAdminClient();
    // Every target must be an active member of THIS org.
    const { data: members } = await admin
      .from("organization_members")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("user_id", targets);
    const valid = new Set(((members ?? []) as Row[]).map((m) => String(m.user_id)));
    const finalTargets = targets.filter((t) => valid.has(t));
    if (!finalTargets.length)
      return {
        updated: 0,
        perUser: {},
        error: "None of those teammates are members of your organization.",
      };

    // Round-robin: lead i → finalTargets[i % n]. Batched per owner like reassign.
    const buckets = new Map<string, string[]>();
    for (const t of finalTargets) buckets.set(t, []);
    ids.forEach((id, i) => buckets.get(finalTargets[i % finalTargets.length])!.push(id));

    let updated = 0;
    const perUser: Record<string, number> = {};
    for (const [uid, bucket] of buckets) {
      const CHUNK = 100;
      let cnt = 0;
      for (let i = 0; i < bucket.length; i += CHUNK) {
        const batch = bucket.slice(i, i + CHUNK);
        const { data, error } = await admin
          .from("leads")
          .update({ owner_id: uid, org_id: orgId })
          .in("id", batch)
          .eq("org_id", orgId) // never move another org's leads
          .select("id");
        if (error) return { updated, perUser, error: error.message };
        cnt += data?.length ?? 0;
      }
      perUser[uid] = cnt;
      updated += cnt;
    }
    return { updated, perUser };
  } catch (e) {
    return { updated: 0, perUser: {}, error: e instanceof Error ? e.message : "Distribute failed." };
  }
}

export interface LeadPatch {
  firstName?: string;
  lastName?: string;
  phone?: string;
  /** null clears the field. */
  email?: string | null;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  utilityProvider?: string;
  solarProvider?: string;
  /** "appointment" / "callback" are rejected here — those need routeDisposition()
   *  (via the disposition-override flow) so the appointments/callbacks table
   *  stays in sync with the lead's status. */
  status?: LeadStatus;
  /** null clears the field. */
  utilityBill?: number | null;
  /** null clears the field. */
  solarPayment?: number | null;
  hasEV?: boolean;
  hasPool?: boolean;
  hasBattery?: boolean;
  multipleSystems?: boolean;
  /** null clears the field. */
  notes?: string | null;
  /**
   * Per-key merge onto leads.custom_fields — only the provided keys change;
   * a null value deletes that key. Keys/values are validated at the API edge.
   */
  customFields?: Record<string, string | number | boolean | null>;
}

const LOCKED_STATUSES: LeadStatus[] = ["appointment", "callback"];

/**
 * Audit an edit onto the lead's timeline (lead_events) — status transitions,
 * core/custom field diffs (old → new), and note changes, each under its own
 * kind so the Lead 360 timeline can describe them differently. Fire-and-forget
 * via logLeadEvent: never slows or fails the save it describes.
 */
function logLeadUpdateEvents(
  leadId: string,
  before: Row,
  patch: LeadPatch,
  written: Record<string, unknown>,
  actorId: string,
): void {
  const orgId = before.org_id ? String(before.org_id) : null;

  if (patch.status !== undefined) {
    const from = String(before.status ?? "new");
    if (patch.status !== from) {
      logLeadEvent({
        leadId,
        orgId,
        actorId,
        kind: "status",
        payload: { from, to: patch.status, via: "edit" },
      });
    }
  }

  // "", null and undefined all mean "empty" for diffing — a CSV blank turning
  // into an explicit null is not a change worth an audit line.
  const norm = (v: unknown) => (v === undefined || v === null || v === "" ? null : v);
  const same = (a: unknown, b: unknown) =>
    typeof a === "boolean" || typeof b === "boolean"
      ? Boolean(a) === Boolean(b)
      : String(a ?? "") === String(b ?? "");

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [col, value] of Object.entries(written)) {
    // status and notes get their own event kinds; custom_fields diffs from the patch.
    if (col === "status" || col === "notes" || col === "custom_fields") continue;
    const from = norm(before[col]);
    const to = norm(value);
    if (!same(from, to)) changes[col] = { from, to };
  }
  if (patch.customFields) {
    const beforeCustom = (
      before.custom_fields && typeof before.custom_fields === "object"
        ? before.custom_fields
        : {}
    ) as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch.customFields)) {
      const from = norm(beforeCustom[k]);
      const to = norm(v);
      if (!same(from, to)) changes[k] = { from, to };
    }
  }
  if (Object.keys(changes).length) {
    logLeadEvent({ leadId, orgId, actorId, kind: "field_change", payload: { changes } });
  }

  if (patch.notes !== undefined) {
    const from = norm(before.notes);
    const to = norm(patch.notes);
    if (!same(from, to)) {
      logLeadEvent({
        leadId,
        orgId,
        actorId,
        kind: "note",
        payload: { preview: String(to ?? "").slice(0, 280), cleared: to === null },
      });
    }
  }
}

/**
 * Edit an existing lead's fields (contact info, address, energy details, status,
 * notes) — the general-purpose counterpart to the disposition flow, for
 * correcting data rather than filing a call outcome. Row-level scoped exactly
 * like every other lead write in this file (deleteLeads, reassignLeads): the
 * actor must own the lead, or be a supervisor acting within their own org.
 *
 * `status` deliberately excludes "appointment"/"callback" — those are backed by
 * rows in the appointments/callbacks tables (see routeDisposition() in
 * records.ts) that a plain status write here wouldn't create or clear, leaving
 * the lead's status and its pipeline tab disagreeing. Use the disposition
 * override flow (RowActions "Change disposition") for those transitions.
 */
export async function updateLead(
  id: string,
  patch: LeadPatch,
): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Connect Supabase to edit leads." };
  if (!UUID.test(id)) return { ok: false, error: "Invalid lead." };
  if (patch.status && LOCKED_STATUSES.includes(patch.status)) {
    return {
      ok: false,
      error:
        'Use "Change disposition" on the Appointments/Callbacks tab to move a lead to Appointment or Callback — it needs a scheduled time too.',
    };
  }
  try {
    const scope = await getScope();
    if (!scope) return { ok: false, error: "You must be signed in." };

    // Read who owns this lead first — canActOn() needs it to decide whether
    // THIS actor (owner, or a supervisor in the same org) may write to it.
    // The full row is read (not just the authz columns) so the audit trail can
    // record old → new for every field the patch actually changes.
    const reader = isAdminConfigured() ? createAdminClient() : await createClient();
    const { data: row } = await reader
      .from("leads")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!row) return { ok: false, error: "Lead not found." };
    const r = row as Row;
    const rowOwnerId = r.owner_id ? String(r.owner_id) : null;
    const rowOrgId = r.org_id ? String(r.org_id) : null;
    if (!canActOn(scope, rowOwnerId, rowOrgId)) {
      return { ok: false, error: "You don't have permission to edit this lead." };
    }

    const fields: Record<string, unknown> = {};
    if (patch.firstName !== undefined) fields.first_name = patch.firstName;
    if (patch.lastName !== undefined) fields.last_name = patch.lastName;
    if (patch.phone !== undefined) {
      const normalized = normalizePhone(patch.phone);
      fields.phone = normalized || patch.phone;
    }
    if (patch.email !== undefined) fields.email = patch.email || null;
    if (patch.address !== undefined) fields.address = patch.address;
    if (patch.city !== undefined) fields.city = patch.city;
    if (patch.state !== undefined) fields.state = patch.state;
    if (patch.zip !== undefined) fields.zip = patch.zip;
    if (patch.utilityProvider !== undefined) fields.utility_provider = patch.utilityProvider;
    if (patch.solarProvider !== undefined) fields.solar_provider = patch.solarProvider;
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.utilityBill !== undefined) fields.utility_bill = patch.utilityBill;
    if (patch.solarPayment !== undefined) fields.solar_payment = patch.solarPayment;
    if (patch.hasEV !== undefined) fields.has_ev = patch.hasEV;
    if (patch.hasPool !== undefined) fields.has_pool = patch.hasPool;
    if (patch.hasBattery !== undefined) fields.has_battery = patch.hasBattery;
    if (patch.multipleSystems !== undefined) fields.multiple_systems = patch.multipleSystems;
    if (patch.notes !== undefined) fields.notes = patch.notes || null;
    if (patch.customFields && Object.keys(patch.customFields).length > 0) {
      if (isAdminConfigured()) {
        // ATOMIC per-key patch (app_patch_lead_custom_fields): jsonb || and -
        // inside one UPDATE, so two nearly-concurrent requests patching
        // DIFFERENT keys both survive — the JS read-modify-write below loses
        // the first writer's keys. Authorization already happened (canActOn).
        const sets: Record<string, string | number | boolean> = {};
        const dels: string[] = [];
        for (const [k, v] of Object.entries(patch.customFields)) {
          if (v === null) dels.push(k);
          else sets[k] = v;
        }
        await createAdminClient().rpc("app_patch_lead_custom_fields", {
          p_lead: id,
          p_set: sets,
          p_delete: dels,
        });
      } else {
        // Keyless self-host fallback: the RPC is service-role only, so degrade
        // to the read-modify-write (single-writer assumption).
        const existing =
          r.custom_fields && typeof r.custom_fields === "object"
            ? { ...(r.custom_fields as Record<string, string | number | boolean>) }
            : {};
        for (const [k, v] of Object.entries(patch.customFields)) {
          if (v === null) delete existing[k];
          else existing[k] = v;
        }
        fields.custom_fields = existing;
      }
    }

    if (Object.keys(fields).length === 0) {
      // Custom-fields-only edit (applied via the RPC above) still gets audited.
      logLeadUpdateEvents(id, r, patch, fields, scope.userId);
      return { ok: true };
    }

    const writer = isAdminConfigured() ? createAdminClient() : await createClient();
    const { error } = await writer.from("leads").update(fields).eq("id", id);
    if (error) return { ok: false, error: error.message };
    logLeadUpdateEvents(id, r, patch, fields, scope.userId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Update failed." };
  }
}

export async function getLeadById(id: string): Promise<Lead | null> {
  if (!isSupabaseConfigured()) return fallbackById(id) ?? null;
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("leads")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!data) return null;
    // RLS alone isn't enough here: "leads read" grants access whenever the
    // caller is an active member of the ROW's org, not just their CURRENTLY
    // ACTIVE one — deliberate, for the shared-org-pool model, but it means a
    // user who's an active member of two orgs (e.g. a platform admin) could
    // have another org's lead handed back if any caller (AI briefing/copilot/
    // summary, the AI-call route) is ever given that org's lead id. Every
    // list function already re-scopes to the viewer's active org_id; do the
    // same here rather than trusting RLS's broader membership check alone.
    const rowOrgId = data.org_id ? String(data.org_id) : null;
    if (rowOrgId) {
      const scope = await getScope();
      if (!scope || rowOrgId !== scope.orgId) return null;
    }
    return rowToLead(data);
  } catch {
    return null;
  }
}

const last10 = (s: string) => (s || "").replace(/\D/g, "").slice(-10);

/**
 * Look up a lead by id with the service-role client (no user session needed).
 * Used by the post-call pipeline (webhook), where the session client would see
 * nothing under RLS and the lead context would be lost.
 */
export async function getLeadByIdAdmin(id: string): Promise<Lead | null> {
  if (!isAdminConfigured() || !UUID.test(id)) return null;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("leads")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return data ? rowToLead(data as Row) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a lead by phone (last 10 digits) with the service-role client.
 *
 * Scope to `orgId` whenever it's known — pass it every time you have it. When
 * it's omitted, the same phone number can legitimately exist as a lead row in
 * MORE THAN ONE organization (two tenants working overlapping/purchased lead
 * lists), and this function has no basis to pick between them. Rather than
 * silently returning whichever row Postgres happens to return first — which is
 * how one organization's homeowner data previously ended up personalizing
 * another organization's AI call — it refuses to guess: if the digits match
 * leads in more than one distinct org, it returns null.
 */
export async function getLeadByPhoneAdmin(
  phone: string,
  orgId?: string | null,
): Promise<Lead | null> {
  const digits = last10(phone);
  if (!isAdminConfigured() || digits.length < 10) return null;
  try {
    const admin = createAdminClient();
    let q = admin.from("leads").select("*").ilike("phone", `%${digits}%`);
    if (orgId) q = q.eq("org_id", orgId);
    const { data } = await q.limit(orgId ? 5 : 20);
    const matches = (data ?? []).filter(
      (r) => last10(String((r as Row).phone)) === digits,
    );
    if (matches.length === 0) return null;
    if (!orgId) {
      const distinctOrgs = new Set(
        matches.map((r) => String((r as Row).org_id ?? "")).filter(Boolean),
      );
      if (distinctOrgs.size > 1) return null; // ambiguous across orgs — don't guess
    }
    return rowToLead(matches[0] as Row);
  } catch {
    return null;
  }
}

export async function getDialQueue(opts?: { assignmentId?: string }): Promise<Lead[]> {
  // Scope matches the Leads tab (getLeads):
  //   • Rep         → own-only. Reps never dial a teammate's leads.
  //   • Supervisor  → the whole org's pool (owner/admin/manager). They see the
  //                   org's leads on the Leads tab, so they can dial them too —
  //                   otherwise an admin sees leads they physically can't call.
  // Any lead with a plausibly-dialable number (10+ digits) and a dialable status
  // is included; exact E.164 normalization happens at dial time.
  //
  // ORDER IS UPLOAD ORDER — deliberately NOT re-sorted here. Reps work a list
  // top-to-bottom the way they handed it over (and expect row 1 of the CSV to be
  // call 1), so the queue preserves the order rows were imported in: the SQL
  // below orders by created_at, and insertLeads stamps a per-row created_at so
  // rows inside one CSV keep their file order instead of sharing one batch
  // timestamp. This used to sort by ai_score desc, which scrambled the list.
  const dialable = (leads: Lead[]) =>
    leads.filter(
      (l) => DIALABLE.includes(l.status) && l.phone.replace(/\D/g, "").length >= 10,
    );

  const assignmentId =
    opts?.assignmentId && UUID.test(opts.assignmentId) ? opts.assignmentId : null;

  if (!isSupabaseConfigured()) {
    // Demo book carries no pack ids — an assignment-scoped demo queue is empty
    // rather than silently the whole book.
    return assignmentId
      ? dialable(fallbackLeads.filter((l) => l.leadPackId === assignmentId))
      : dialable(fallbackLeads);
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const prof = await readProfileScope(supabase, user.id, "org_id, role, disabled");
    // Suspended accounts get nothing — the supervisor branch below reads via
    // the service-role client, which would bypass the RLS suspension backstop.
    if (prof?.disabled) return [];
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    const supervisor =
      prof.supervisor && isAdminConfigured();

    // ?assignment= scopes the queue to ONE pack — after proving the pack is
    // really this caller's to dial: it must live in their org, and a rep may
    // only work a pack assigned to THEM (supervisors may dial any org pack).
    // An unverifiable assignment returns an EMPTY queue, never the full book —
    // silently widening scope is how leads get dialed twice.
    if (assignmentId) {
      if (!isAdminConfigured() || !orgId) return [];
      const admin = createAdminClient();
      const { data: pack } = await admin
        .from("lead_packs")
        .select("id, assigned_to")
        .eq("id", assignmentId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (!pack) return [];
      if (!supervisor && String((pack as Row).assigned_to ?? "") !== user.id) return [];
    }

    // Suppression set for this org — scrubbed from the queue so a DNC number never
    // appears in the manual dialer (matching the auto-dialer + placement scrubs).
    const dnc = await getDncDigits(orgId);

    // PAGED. An un-ranged select stops at PostgREST's 1,000-row default without
    // any error, so this account's dial queue silently held 1,000 of its 15,136
    // dialable leads — 93% of the book invisible, and the dialer reporting "done"
    // having never touched it. Filter status in SQL too, so we page over dialable
    // rows rather than the whole 17k table.
    if (supervisor) {
      // Org-wide pool via the service-role client (RLS would hide other reps'
      // rows), scoped in code to this org — never another org's leads.
      const admin = createAdminClient();
      const rows = await fetchAllPaged(() => {
        let q = admin
          .from("leads")
          .select("*")
          .eq("org_id", orgId as string)
          .in("status", DIALABLE);
        if (assignmentId) q = q.eq("lead_pack_id", assignmentId);
        return q.order("created_at", { ascending: true }).order("id", { ascending: true });
      });
      return scrubDnc(dialable(rows.map((r) => rowToLead(r as Row))), dnc);
    }

    // A rep's queue = leads they UPLOADED (owner_id) OR were ASSIGNED
    // (assigned_rep_id). Assignment lets a supervisor route a bulk-imported list
    // to a rep without changing who uploaded it, so a rep really can "only dial my
    // leads" even when a manager did the import. RLS's shared-pool read lets a rep
    // read a lead assigned to them but owned by someone else; this is the app scope.
    const rows = await fetchAllPaged(() => {
      let q = supabase
        .from("leads")
        .select("*")
        .or(`owner_id.eq.${user.id},assigned_rep_id.eq.${user.id}`)
        .in("status", DIALABLE);
      if (orgId) q = q.eq("org_id", orgId);
      if (assignmentId) q = q.eq("lead_pack_id", assignmentId);
      return q.order("created_at", { ascending: true }).order("id", { ascending: true });
    });
    return scrubDnc(dialable(rows.map((r) => rowToLead(r as Row))), dnc);
  } catch {
    return [];
  }
}

export interface BookedLead extends Lead {
  appointmentId: string | null;
  /** Floating wall-clock string, or null when the booking has no pinned time yet. */
  scheduledAt: string | null;
  /** The AI's human label ("Tomorrow afternoon") when there's no exact time. */
  scheduledLabel: string;
}

/** Attach each lead's most recent non-cancelled appointment (time + id). */
async function withAppointmentInfo(leads: Lead[]): Promise<BookedLead[]> {
  const empty = (l: Lead): BookedLead => ({
    ...l,
    appointmentId: null,
    scheduledAt: null,
    scheduledLabel: "",
  });
  if (!leads.length || !isAdminConfigured()) return leads.map(empty);
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("appointments")
      .select("id,lead_id,scheduled_at,scheduled_label,status,created_at")
      .in("lead_id", leads.map((l) => l.id))
      .neq("status", "cancelled")
      .order("created_at", { ascending: false });
    const byLead = new Map<string, Row>();
    for (const r of (data ?? []) as Row[]) {
      const leadId = String(r.lead_id ?? "");
      // Rows arrive newest-first, so the first hit per lead is the latest booking.
      if (leadId && !byLead.has(leadId)) byLead.set(leadId, r);
    }
    return leads.map((l) => {
      const a = byLead.get(l.id);
      if (!a) return empty(l);
      return {
        ...l,
        appointmentId: String(a.id),
        scheduledAt: a.scheduled_at ? toFloatingLocal(String(a.scheduled_at)) : null,
        scheduledLabel: String(a.scheduled_label ?? ""),
      };
    });
  } catch {
    return leads.map(empty);
  }
}

/**
 * Leads that already have an appointment booked — the exact leads `getDialQueue`
 * excludes (status "appointment" isn't in DIALABLE), in the SAME scope (rep →
 * own, supervisor → org pool). Backs the dialer's "Booked" tab: instead of a
 * converted homeowner just vanishing from the queue on the next reload, they
 * land here — visibly skipped, not silently dropped. Sorted soonest-first, with
 * unscheduled ("sometime next week") bookings last.
 */
export async function getBookedLeads(): Promise<BookedLead[]> {
  const sort = (leads: BookedLead[]) =>
    leads.sort((a, b) => {
      if (a.scheduledAt && b.scheduledAt) return a.scheduledAt < b.scheduledAt ? -1 : 1;
      if (a.scheduledAt) return -1;
      if (b.scheduledAt) return 1;
      return 0;
    });

  if (!isSupabaseConfigured())
    return sort(await withAppointmentInfo(fallbackLeads.filter((l) => l.status === "appointment")));
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    const supervisor =
      prof.supervisor && isAdminConfigured();

    if (supervisor) {
      const admin = createAdminClient();
      const rows = await fetchAllPaged(() =>
        admin
          .from("leads")
          .select("*")
          .eq("org_id", orgId as string)
          .eq("status", "appointment")
          .order("id", { ascending: true }),
      );
      return sort(await withAppointmentInfo(rows.map((r) => rowToLead(r as Row))));
    }

    const rows = await fetchAllPaged(() => {
      let q = supabase
        .from("leads")
        .select("*")
        .or(`owner_id.eq.${user.id},assigned_rep_id.eq.${user.id}`)
        .eq("status", "appointment");
      if (orgId) q = q.eq("org_id", orgId);
      return q.order("id", { ascending: true });
    });
    return sort(await withAppointmentInfo(rows.map((r) => rowToLead(r as Row))));
  } catch {
    return [];
  }
}

/**
 * Leads eligible for UNATTENDED auto-dialing across a whole org: dialable status,
 * a valid phone, and NOT contacted within `cooldownHours`. Ordered oldest-
 * contacted first (nulls first) so the scheduler works evenly through the list.
 * Admin-scoped (no user session) — used only by the cron auto-dialer.
 */
export async function getAutoDialLeadsForOrg(
  orgId: string,
  opts: { cooldownHours: number; limit: number },
): Promise<Lead[]> {
  if (!orgId || !isAdminConfigured()) return [];
  try {
    const admin = createAdminClient();
    const cutoff = new Date(
      Date.now() - Math.max(0, opts.cooldownHours) * 3_600_000,
    ).toISOString();
    const { data, error } = await admin
      .from("leads")
      .select("*")
      .eq("org_id", orgId)
      .in("status", DIALABLE)
      // Never dialed, or last dialed before the cooldown cutoff.
      .or(`last_contacted_at.is.null,last_contacted_at.lt.${cutoff}`)
      .order("last_contacted_at", { ascending: true, nullsFirst: true })
      // Over-fetch a buffer so DNC scrubbing can't starve the batch below `limit`.
      .limit(Math.max(1, opts.limit) + 25);
    if (error) return [];
    const eligible = (data ?? [])
      .map((r) => rowToLead(r as Row))
      .filter((l) => l.phone.replace(/\D/g, "").length >= 10);
    // Never auto-dial a suppressed number (added via a do_not_call disposition,
    // an SMS STOP, or a DNC import) even if its lead row is still a dialable status.
    const dnc = await getDncDigits(orgId);
    return scrubDnc(eligible, dnc).slice(0, Math.max(1, opts.limit));
  } catch {
    return [];
  }
}

/** Stamp a lead as just-contacted so the auto-dialer won't immediately re-pick it. */
export async function touchLeadContacted(
  orgId: string,
  leadId: string,
  iso: string,
): Promise<void> {
  if (!orgId || !UUID.test(leadId) || !isAdminConfigured()) return;
  try {
    const admin = createAdminClient();
    await admin
      .from("leads")
      .update({ last_contacted_at: iso })
      .eq("id", leadId)
      .eq("org_id", orgId);
  } catch {
    /* best-effort */
  }
}

/**
 * Count the leads in the viewer's dial scope (every status) — the denominator
 * for the dialer's "you have N leads but none are ready to dial" hint. Matches
 * getDialQueue's scope: a supervisor's org-wide pool, a rep's own leads.
 */
export async function getMyLeadsCount(): Promise<number> {
  if (!isSupabaseConfigured()) return fallbackLeads.length;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return 0;
    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    const supervisor =
      prof.supervisor && isAdminConfigured();
    if (supervisor) {
      const { count } = await createAdminClient()
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId as string);
      return count ?? 0;
    }
    let q = supabase.from("leads").select("id", { count: "exact", head: true }).eq("owner_id", user.id);
    if (orgId) q = q.eq("org_id", orgId);
    const { count } = await q;
    return count ?? 0;
  } catch {
    return 0;
  }
}

// ── Server-paginated Leads tab ───────────────────────────────────────────────

export const LEADS_PAGE_SIZE = 50;

/**
 * Server-side sort for the Leads tab. `key` must be one of the whitelist below —
 * the SQL (app_leads_page) re-validates it in a CASE and silently falls back to
 * upload order for anything else, so an invalid key can never reach an ORDER BY.
 */
export interface LeadsSort {
  key: string;
  dir: "asc" | "desc";
}

/**
 * JS mirror of app_leads_page's sort whitelist — the demo/degraded-path twin of
 * the SQL CASE arms. The key set is LEAD_SORT_KEYS (leads/sort-keys.ts), and the
 * Record type makes a drifted arm a compile error; only the SQL copy still
 * needs the lockstep comment. Text keys coalesce to "" (like the SQL's
 * coalesce), value keys return null for missing data (sorted last regardless
 * of direction, like the SQL's NULLS LAST).
 */
const LEADS_SORT_VALUES: Record<LeadSortKey, (l: Lead) => string | number | null> = {
  name: (l) => `${l.lastName ?? ""} ${l.firstName ?? ""}`.toLowerCase(),
  city: (l) => (l.city ?? "").toLowerCase(),
  state: (l) => (l.state ?? "").toLowerCase(),
  status: (l) => l.status,
  utility_bill: (l) => l.utilityBill ?? null,
  solar_payment: (l) => l.solarPayment ?? null,
  ai_score: (l) => l.aiScore ?? null,
  last_contacted_at: (l) =>
    l.lastContactedAt ? Date.parse(l.lastContactedAt) || null : null,
  created_at: (l) => (l.createdAt ? Date.parse(l.createdAt) || null : null),
};

// ── City keys ────────────────────────────────────────────────────────────────
// City is FREE TEXT off a customer CSV, so "Fresno", "fresno " and "FRESNO"
// are three spellings of one place and must collapse into one bucket. Every
// city comparison in this file — the filter, the distinct list, the pack
// splitter — goes through these two helpers, and the SQL side mirrors them
// with lower(btrim(...)). Changing one means changing all three.

/** The lead's city as typed, trimmed. "" when there's none on file. */
const cityOf = (l: Lead) => (l.city ?? "").trim();

/**
 * Fold a "City|ST" composite for comparison. EACH SIDE is trimmed, not just
 * the whole string — a stored "Fresno " produces the key "Fresno |CA", and
 * trimming only the outside would leave that inner space in place and match
 * nothing. Exported so the lockstep with the SQL is testable, not just
 * asserted in a comment.
 */
export const normalizeCityKey = (key: string) =>
  key
    .split("|")
    .map((part) => part.trim().toLowerCase())
    .join("|");

/** A lead's own folded "city|st" key. "" when it has no city. */
export const cityKey = (l: Lead) =>
  cityOf(l) ? normalizeCityKey(`${cityOf(l)}|${(l.state ?? "").trim()}`) : "";

export interface LeadsPageParams {
  /** 1-based. */
  page: number;
  pageSize?: number;
  q?: string;
  status?: LeadStatus;
  /** Group key; "__misc__" selects ungrouped leads. */
  group?: string;
  /** "County|ST" composite (e.g. "Fresno|CA") — county names repeat across
   *  states, so the pair is the real filter key. "__none__" selects leads with
   *  no county on file. */
  county?: string;
  /** "City|ST" composite (e.g. "Fresno|CA"), matched case- and
   *  whitespace-insensitively because city is free text off a customer CSV.
   *  "__none__" selects leads with no city on file. */
  city?: string;
  /** Campaign id; "__none__" selects leads with no campaign. */
  campaignId?: string;
  uploaderId?: string;
  /** Uploaded by or assigned to the viewer (the dialer's "my leads" set). */
  mine?: boolean;
  /** Smart-list id — see src/lib/leads/smart-lists.ts. */
  smart?: string;
  /** Whitelisted sort key + direction. Absent (or an unknown key) = upload
   *  order (created_at, id) — the deliberate product default; see ORDERING. */
  sort?: LeadsSort;
}

export interface LeadsPageStats {
  total: number;
  qualified: number;
  appointments: number;
  /** Untouched book: attempt_count 0, never contacted, still-dialable status.
   *  See docs/phase-1/metric-glossary.md — replaced the avgScore aggregate. */
  neverDialed: number;
}

/**
 * JS twin of the SQL's neverDialed stat (app_leads_page: attempt_count = 0 AND
 * last_contacted_at IS NULL AND status dialable). The Lead shape doesn't carry
 * attempt_count, so this approximates with lastContactedAt — every completed
 * call stamps both, so the two only diverge on rows whose attempts never
 * connected AND never set last_contacted_at, which the dial loop also stamps.
 * Close enough for the demo/degraded paths this feeds.
 */
function neverDialedCount(all: Lead[]): number {
  return all.filter(
    (l) => !l.lastContactedAt && DIALABLE_STATUSES.includes(l.status),
  ).length;
}

export interface LeadsPageResult {
  leads: Lead[];
  /** Rows matching the CURRENT filters — the pagination denominator. */
  total: number;
  /** Scope-wide aggregates, deliberately UNfiltered, for the KPI tiles. */
  stats: LeadsPageStats;
  /** Scope-wide smart-list counts, for the chips. */
  smartCounts: Record<string, number>;
  page: number;
  pageSize: number;
}

function emptyLeadsPage(params: LeadsPageParams): LeadsPageResult {
  const smartCounts: Record<string, number> = {};
  for (const sl of SMART_LISTS) smartCounts[sl.id] = 0;
  return {
    leads: [],
    total: 0,
    stats: { total: 0, qualified: 0, appointments: 0, neverDialed: 0 },
    smartCounts,
    page: Math.max(params.page, 1),
    pageSize: Math.min(Math.max(params.pageSize ?? LEADS_PAGE_SIZE, 1), 200),
  };
}

/**
 * Pure JS twin of the app_leads_page SQL — used in demo mode and as the
 * degraded path when no service key exists (the RPC is service-role only).
 * Must stay in lockstep with the SQL's filter semantics.
 */
function filterLeadsPage(
  all: Lead[],
  params: LeadsPageParams,
  meId: string | null,
): LeadsPageResult {
  const pageSize = Math.min(Math.max(params.pageSize ?? LEADS_PAGE_SIZE, 1), 200);
  const page = Math.max(params.page, 1);
  const q = (params.q ?? "").trim().toLowerCase();
  const qDigits = (params.q ?? "").replace(/\D/g, "");
  const digits = qDigits.length >= 3 ? qDigits : "";
  const smart = params.smart ? smartListById(params.smart) : undefined;

  const filtered = all.filter((l) => {
    if (params.status && l.status !== params.status) return false;
    if (
      params.group &&
      (params.group === "__misc__" ? Boolean(l.leadGroup) : l.leadGroup !== params.group)
    )
      return false;
    if (params.county) {
      const key = l.county ? `${l.county}|${l.state}` : "";
      if (params.county === "__none__" ? Boolean(l.county) : key !== params.county)
        return false;
    }
    if (params.city) {
      // Case/whitespace-folded on both sides — the twin of the SQL's
      // lower(btrim(...)) comparison. Keep the two in lockstep.
      if (params.city === "__none__") {
        if (cityOf(l)) return false;
      } else if (cityKey(l) !== normalizeCityKey(params.city)) return false;
    }
    if (
      params.campaignId &&
      (params.campaignId === "__none__"
        ? Boolean(l.campaignId)
        : l.campaignId !== params.campaignId)
    )
      return false;
    if (params.uploaderId && l.ownerId !== params.uploaderId) return false;
    if (params.mine && meId && !(l.ownerId === meId || l.assignedRepId === meId))
      return false;
    if (smart && !smart.match(l)) return false;
    if (q) {
      const hit =
        `${l.firstName} ${l.lastName}`.toLowerCase().includes(q) ||
        l.city.toLowerCase().includes(q) ||
        l.utilityProvider.toLowerCase().includes(q) ||
        (digits !== "" && l.phone.replace(/\D/g, "").includes(digits));
      if (!hit) return false;
    }
    return true;
  });

  // Mirror of the SQL's sort lanes: whitelist via LEADS_SORT_VALUES (unknown
  // keys leave upload order untouched), nulls last regardless of direction.
  // Array.prototype.sort is stable, so the input's upload order stands in for
  // the SQL's (created_at, id) tiebreaker.
  const sortValue =
    params.sort && isLeadSortKey(params.sort.key)
      ? LEADS_SORT_VALUES[params.sort.key]
      : undefined;
  const ordered = sortValue
    ? [...filtered].sort((a, b) => {
        const va = sortValue(a);
        const vb = sortValue(b);
        if (va === null && vb === null) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        const cmp =
          typeof va === "string" && typeof vb === "string"
            ? va.localeCompare(vb)
            : va < vb
              ? -1
              : va > vb
                ? 1
                : 0;
        return params.sort!.dir === "desc" ? -cmp : cmp;
      })
    : filtered;

  return {
    leads: ordered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    stats: {
      total: all.length,
      qualified: all.filter((l) => l.status === "qualified" || l.status === "appointment")
        .length,
      appointments: all.filter((l) => l.status === "appointment").length,
      neverDialed: neverDialedCount(all),
    },
    smartCounts: countSmartLists(all),
    page,
    pageSize,
  };
}

/**
 * One page of the viewer's leads plus everything the Leads tab needs around it
 * (filtered total, scope-wide KPIs, smart-list counts) — in a single round
 * trip via the app_leads_page RPC. Same scope split as getLeads (rep → own +
 * assigned; supervisor → org pool + own pre-org rows), same upload ordering
 * (created_at, id) unless a whitelisted `sort` is given, evaluated in SQL so
 * 100k-lead books stop being serialized into the RSC payload.
 */
export async function getLeadsPage(params: LeadsPageParams): Promise<LeadsPageResult> {
  if (!isSupabaseConfigured()) return filterLeadsPage(fallbackLeads, params, null);
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return emptyLeadsPage(params);

    // The RPC is revoked from `authenticated` (it trusts its scope params), so
    // without a service key fall back to the RLS full fetch + JS paging — the
    // degraded self-host mode, correct just not cheap.
    if (!isAdminConfigured()) {
      return filterLeadsPage(await getLeads(), params, user.id);
    }

    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    const supervisor = prof.supervisor;

    const pageSize = Math.min(Math.max(params.pageSize ?? LEADS_PAGE_SIZE, 1), 200);
    const page = Math.max(params.page, 1);
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("app_leads_page", {
      p_org: orgId,
      p_user: user.id,
      p_supervisor: supervisor,
      p_q: params.q?.trim() || null,
      p_status: params.status ?? null,
      p_group: params.group ?? null,
      p_county: params.county ?? null,
      p_city: params.city ?? null,
      p_campaign: params.campaignId ?? null,
      p_uploader: params.uploaderId ?? null,
      p_mine: Boolean(params.mine),
      p_smart: params.smart ?? null,
      p_offset: (page - 1) * pageSize,
      p_limit: pageSize,
      p_sort: params.sort?.key ?? null,
      p_dir: params.sort?.dir ?? "asc",
    });
    if (error || !data) {
      // NEVER render a populated book as empty because the RPC failed — a
      // schema-drift deploy (old function signature, missing column) or a
      // transient error degrades to the RLS full fetch + JS twin instead.
      return filterLeadsPage(await getLeads(), params, user.id);
    }

    const payload = data as {
      rows?: Row[];
      total?: number;
      stats?: Partial<LeadsPageStats> & { smart?: Record<string, number> };
    };
    const leads = (payload.rows ?? []).map((r) => ({
      ...rowToLead(r),
      ownerName: String(r.owner_name ?? ""),
    }));
    const smartCounts: Record<string, number> = {};
    for (const sl of SMART_LISTS) {
      smartCounts[sl.id] = Number(payload.stats?.smart?.[sl.id] ?? 0);
    }
    return {
      leads,
      total: Number(payload.total ?? 0),
      stats: {
        total: Number(payload.stats?.total ?? 0),
        qualified: Number(payload.stats?.qualified ?? 0),
        appointments: Number(payload.stats?.appointments ?? 0),
        neverDialed: Number(payload.stats?.neverDialed ?? 0),
      },
      smartCounts,
      page,
      pageSize,
    };
  } catch {
    return emptyLeadsPage(params);
  }
}

export interface CountyOption {
  county: string;
  state: string;
}

/**
 * Distinct (county, state) pairs in the viewer's scope, for the Leads filter
 * dropdown. A plain DISTINCT read, not a count — the filtered table's own "N
 * leads" total already answers "how many", so this only needs to name which
 * counties exist, not how big each one is.
 *
 * Paged and narrow-selected (two text columns) rather than routed through
 * app_leads_page: that RPC returns one PAGE of full lead rows for the current
 * filter, not distinct values scope-wide, and a 50k-row book of two columns is
 * still cheap to page through and dedupe in JS — a Postgres DISTINCT would
 * need its own RPC for a feature this small. Same scope split as getLeads:
 * rep → own uploads + assigned; supervisor → org pool + own pre-org rows.
 */
export async function listDistinctCounties(): Promise<CountyOption[]> {
  return (await listPlaces()).counties;
}

export interface CityOption {
  city: string;
  state: string;
}

export interface PlaceOptions {
  counties: CountyOption[];
  cities: CityOption[];
}

/**
 * Distinct counties AND cities in the viewer's scope, for the Leads filter
 * dropdowns. ONE scan produces both: they read the same rows off the same
 * table, so splitting them into two functions would page the whole book twice
 * to answer one screen.
 *
 * ORDER IS UPLOAD ORDER — first appearance in the book, NOT alphabetical.
 * A rep works a list the way it was handed to them, so the dropdown has to
 * name the places in the order the file presented them: if the CSV opens with
 * 400 Fresno rows and then moves to Bakersfield, Fresno is the first option.
 * Sorting these A-Z reshuffled a deliberately-ordered list into a stranger's
 * order, which is exactly the complaint that produced this comment. The rows
 * are read `order by created_at, id` and deduped keeping FIRST occurrence,
 * and insertLeads stamps a per-row created_at so rows inside one CSV keep
 * their file order rather than sharing one batch timestamp.
 *
 * Paged and narrow-selected (three text columns) rather than routed through
 * app_leads_page: that RPC returns one PAGE of full lead rows for the current
 * filter, not distinct values scope-wide. Same scope split as getLeads:
 * rep → own uploads + assigned; supervisor → org pool + own pre-org rows.
 */
export async function listPlaces(): Promise<PlaceOptions> {
  const empty: PlaceOptions = { counties: [], cities: [] };
  if (!isSupabaseConfigured()) return empty;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return empty;
    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    const supervisor =
      prof.supervisor && isAdminConfigured();

    // Insertion-ordered Maps: first write wins the position, so deduping keeps
    // each place at its FIRST appearance in upload order.
    const counties = new Map<string, CountyOption>();
    const cities = new Map<string, CityOption>();
    const collect = (rows: Row[]) => {
      for (const r of rows) {
        const state = String(r.state ?? "").trim();
        const county = String(r.county ?? "").trim();
        if (county && !counties.has(`${county}|${state}`)) {
          counties.set(`${county}|${state}`, { county, state });
        }
        const city = String(r.city ?? "").trim();
        if (city) {
          // Folded key so "Fresno"/"fresno " collapse; the FIRST spelling seen
          // is the one displayed, matching how the book itself reads.
          const key = normalizeCityKey(`${city}|${state}`);
          if (!cities.has(key)) cities.set(key, { city, state });
        }
      }
    };

    const COLS = "county,city,state";
    // Upload order, matching getLeads/getDialQueue's ORDERING contract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inOrder = (q: any) =>
      q.order("created_at", { ascending: true }).order("id", { ascending: true });

    if (!supervisor) {
      const rows = await fetchAllPaged(() => {
        let q = supabase
          .from("leads")
          .select(COLS)
          .or(`owner_id.eq.${user.id},assigned_rep_id.eq.${user.id}`);
        if (orgId) q = q.eq("org_id", orgId);
        return inOrder(q);
      });
      collect(rows);
    } else {
      const admin = createAdminClient();
      // Sequential, not Promise.all: the org pool is the main book and its
      // order must lead: a supervisor's own stray pre-org rows are a footnote
      // and belong after it, not interleaved by whichever query returned first.
      const orgRows = await fetchAllPaged(() =>
        inOrder(admin.from("leads").select(COLS).eq("org_id", orgId as string)),
      );
      const ownRows = await fetchAllPaged(() =>
        inOrder(
          admin.from("leads").select(COLS).eq("owner_id", user.id).is("org_id", null),
        ),
      );
      collect(orgRows);
      collect(ownRows);
    }

    return { counties: [...counties.values()], cities: [...cities.values()] };
  } catch {
    return empty;
  }
}

/**
 * How many of the org's leads have a ZIP on file but no county yet — the
 * number shown next to the "Backfill counties" button under Edit groups, and
 * what decides whether that button has anything to do. Same org-scoped HEAD
 * count as listLeadGroupsWithCounts' miscCount (plain RLS client, not admin —
 * this only needs a number). Matches POST /api/leads/backfill-county's read
 * scope exactly (`county is null`, `zip is not null`, this org) so the count
 * shown here never disagrees with what a click actually processes.
 */
export async function getMissingCountyCount(orgId: string | null): Promise<number> {
  if (!orgId || !isSupabaseConfigured()) return 0;
  try {
    const supabase = await createClient();
    const { count } = await supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .is("county", null)
      .not("zip", "is", null);
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * How many of the org's leads have a state on file but no timezone yet — the
 * "Backfill time zones" counterpart to getMissingCountyCount above. Matches
 * POST /api/leads/backfill-timezone's read scope exactly (`timezone is null`,
 * `state` present and non-blank, this org).
 *
 * `state` rather than `zip` is the gate, unlike county: timezoneForAddress's
 * primary signal is the state (a ZIP is only consulted for the two override
 * regions), so a lead with a state but no ZIP is still fully backfillable —
 * gating on ZIP the way county does would under-count what this button can
 * actually fix.
 */
export async function getMissingTimezoneCount(orgId: string | null): Promise<number> {
  if (!orgId || !isSupabaseConfigured()) return 0;
  try {
    const supabase = await createClient();
    const { count } = await supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .is("timezone", null)
      .not("state", "is", null)
      .neq("state", "");
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Head-count of the viewer's dial queue (same scope + status filter as
 * getDialQueue) for the dialer's header badge, so the page stops serializing
 * the entire queue into the RSC payload just to render a number. Slightly
 * generous — the 10-digit-phone check and DNC scrub happen at load time in the
 * client, which refetches the real queue anyway.
 */
export async function getDialQueueCount(): Promise<number> {
  if (!isSupabaseConfigured())
    return fallbackLeads.filter((l) => DIALABLE.includes(l.status)).length;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return 0;
    const prof = await readProfileScope(supabase, user.id);
    const orgId = prof?.org_id ? String(prof.org_id) : null;
    const supervisor =
      prof.supervisor && isAdminConfigured();
    if (supervisor) {
      const { count } = await createAdminClient()
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId as string)
        .in("status", DIALABLE);
      return count ?? 0;
    }
    let q = supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .or(`owner_id.eq.${user.id},assigned_rep_id.eq.${user.id}`)
      .in("status", DIALABLE);
    if (orgId) q = q.eq("org_id", orgId);
    const { count } = await q;
    return count ?? 0;
  } catch {
    return 0;
  }
}

export interface LeadInput {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  utilityProvider?: string;
  solarProvider?: string;
  status?: string;
  utilityBill?: number;
  solarPayment?: number;
  campaignId?: string;
  /** Org group key. Explicit `null` stamps "Miscellaneous" (distinct from
   *  omitting the key, which leaves any existing lead_group untouched). */
  leadGroup?: LeadGroup | null;
  /** Pack (numbered slice of an upload) this row belongs to. */
  leadPackId?: string | null;
  /** Explicit county override. Omitted = computed from `zip` at insert time
   *  (see countyForZip in lib/leads/zip-county.ts); explicit `null` skips that
   *  and stores no county even if the ZIP would otherwise resolve one. */
  county?: string | null;
  /** Explicit timezone override (a real IANA zone, e.g. "America/Denver").
   *  Omitted = computed from `state` + `zip` at insert time (see
   *  timezoneForAddress in lib/leads/address-timezone.ts); explicit `null`
   *  skips that and stores no zone even if the address would resolve one. */
  timezone?: string | null;
  notes?: string;
  /** Typed spillover for CSV columns beyond the core slots (custom_fields jsonb). */
  customFields?: Record<string, string | number | boolean>;
}

/**
 * Bulk-insert leads for the signed-in account (CSV import).
 *
 * Phone numbers are normalized to E.164 server-side (defense in depth — the same
 * normalization the importer runs client-side) so stored data is clean and
 * dialable. Rows whose phone can't be normalized are still imported (data isn't
 * lost) but counted in `invalidPhone` so the UI can warn they won't be dialable.
 *
 * Duplicate phone numbers are skipped, not inserted — checked against every
 * OTHER lead already in this account's organization (the shared pool a CSV
 * re-upload or a second rep's list would otherwise silently double), plus
 * duplicates within the batch itself. The comparison query is the RLS-scoped
 * session client, so it is structurally incapable of seeing (or matching
 * against) another organization's leads — dedupe never crosses an org boundary.
 */
export async function insertLeads(
  rows: LeadInput[],
  opts: {
    /** Milliseconds to add to this batch's created_at origin, so a chunked
     *  upload's later requests still sort after its earlier ones. Pass the
     *  chunk's row offset within the file. */
    createdAtOffsetMs?: number;
  } = {},
): Promise<{
  inserted: number;
  invalidPhone: number;
  duplicates: number;
  error?: string;
  /**
   * True when nothing was inserted because there was nothing WORTH inserting —
   * every row was a duplicate, or none had a phone or a name. That is an outcome,
   * not a failure, and callers must not treat it as one: a chunk of a re-uploaded
   * file is legitimately 100% duplicates, and aborting there would leave the rest
   * of the file unimported. The message is still returned for a caller that wants
   * to show it; `noop` is what says it's safe to carry on.
   */
  noop?: boolean;
}> {
  if (!isSupabaseConfigured())
    return { inserted: 0, invalidPhone: 0, duplicates: 0, error: "Connect Supabase to save leads." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { inserted: 0, invalidPhone: 0, duplicates: 0, error: "You must be signed in." };

    let invalidPhone = 0;
    const candidates = rows
      .filter((r) => (r.phone && r.phone.trim()) || r.firstName)
      .map((r) => {
        const rawPhone = (r.phone ?? "").trim();
        const normalized = normalizePhone(rawPhone);
        if (rawPhone && !normalized) invalidPhone++;
        const phone = normalized || rawPhone;
        return {
          digits: last10(phone),
          row: {
            owner_id: user.id,
            first_name: r.firstName ?? "",
            last_name: r.lastName ?? "",
            // Store the clean E.164 when we can; otherwise keep the original so
            // the lead still carries whatever the user uploaded.
            phone,
            email: r.email || null,
            address: r.address ?? "",
            city: r.city ?? "",
            state: r.state ?? "",
            zip: r.zip ?? "",
            utility_provider: r.utilityProvider ?? "",
            solar_provider: r.solarProvider ?? "",
            status: r.status ?? "new",
            utility_bill: r.utilityBill ?? null,
            solar_payment: r.solarPayment ?? null,
            campaign_id: r.campaignId ?? null,
            lead_group: r.leadGroup ?? null,
            lead_pack_id: r.leadPackId ?? null,
            // Omitted (undefined) -> computed from the ZIP; explicit null ->
            // stored as no county even if the ZIP would resolve one; a caller
            // that already knows the county (none do yet) can pass it directly.
            county:
              r.county !== undefined ? r.county : (countyForZip(r.zip)?.county ?? null),
            // Same contract as county, one line up: computed from the address
            // (state + zip) unless the caller already supplied one. This is
            // what timezone-based lead-pack sorting groups leads by, and what
            // resolveLeadTimezone now prefers over the phone's area code for
            // TCPA calling-window enforcement — the address is the more
            // trustworthy signal for where a lead actually is, since phone
            // numbers are portable and addresses (mostly) aren't.
            timezone:
              r.timezone !== undefined
                ? r.timezone
                : (timezoneForAddress({ state: r.state, zip: r.zip }) ?? null),
            notes: r.notes || null,
            custom_fields: r.customFields ?? {},
          },
        };
      });

    if (!candidates.length)
      return {
        inserted: 0,
        invalidPhone,
        duplicates: 0,
        error: "No valid rows found.",
        noop: true,
      };

    // Every phone this org already has on file, from any uploader — the shared
    // pool means a duplicate is still a duplicate even if a different rep
    // imported it. Paged: an un-ranged select silently caps at 1,000 rows.
    const existingRows = await fetchAllPaged(() => supabase.from("leads").select("phone"));
    const existingDigits = new Set(
      existingRows.map((r) => last10(String(r.phone))).filter((d) => d.length === 10),
    );

    let duplicates = 0;
    const seenInBatch = new Set<string>();
    const payload = candidates
      .filter((c) => {
        // No usable phone digits (e.g. a name-only row) — nothing to dedupe on.
        if (c.digits.length !== 10) return true;
        if (existingDigits.has(c.digits) || seenInBatch.has(c.digits)) {
          duplicates++;
          return false;
        }
        seenInBatch.add(c.digits);
        return true;
      })
      .map((c) => c.row);

    if (!payload.length)
      return {
        inserted: 0,
        invalidPhone,
        duplicates,
        error: "Every row was already in your organization's leads.",
        noop: true,
      };

    // PRESERVE CSV ROW ORDER. `created_at` defaults to now(), which in Postgres
    // is the TRANSACTION timestamp — so every row of a bulk insert gets the
    // IDENTICAL value and the file's order is unrecoverable (ordering then falls
    // back to random UUIDs). The dial queue orders by created_at, so stamp each
    // row 1ms apart in file order: row 0 sorts before row 1, and a later import
    // still lands after an earlier one. Drift is one millisecond per row (40s for
    // a 40,000-row file), which is irrelevant to every consumer of this column.
    //
    // `createdAtOffsetMs` is how a CHUNKED upload keeps one file's order. Chunk 2
    // is a separate request that would otherwise re-read Date.now() — and if it
    // started before chunk 1's stamps ran out, its rows would interleave into the
    // middle of chunk 1. The caller passes the row offset instead, so every chunk
    // stamps from the same conceptual origin and the file lands in file order.
    const offset = Math.max(0, Math.floor(opts.createdAtOffsetMs ?? 0));
    const base = Date.now() + offset;
    const stamped = payload.map((row, i) => ({
      ...row,
      created_at: new Date(base + i).toISOString(),
    }));

    // BATCHED. A single insert puts every row in one PostgREST request body;
    // tens of thousands of rows (each with a custom_fields jsonb) overflow the
    // request limit and the whole import fails with an opaque error. Batching
    // also means a failure half way through reports what actually landed instead
    // of claiming zero — the rows are already in the table either way, and an
    // importer told "0 inserted" re-uploads and doubles the list.
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < stamped.length; i += BATCH) {
      const slice = stamped.slice(i, i + BATCH);
      let { error, count } = await supabase
        .from("leads")
        .insert(slice, { count: "exact" });
      if (error && /custom_fields/i.test(error.message)) {
        // Schema drift (DB not yet migrated with the custom_fields column):
        // rather than failing the whole import, retry without the spillover so
        // the core lead data still lands.
        const bare = slice.map(({ custom_fields: _cf, ...rest }) => rest);
        ({ error, count } = await supabase.from("leads").insert(bare, { count: "exact" }));
      }
      if (error) return { inserted, invalidPhone, duplicates, error: error.message };
      inserted += count ?? slice.length;
    }
    return { inserted, invalidPhone, duplicates };
  } catch (e) {
    return {
      inserted: 0,
      invalidPhone: 0,
      duplicates: 0,
      error: e instanceof Error ? e.message : "Import failed.",
    };
  }
}

export async function getLeadStats() {
  const all = await getLeads();
  return {
    total: all.length,
    qualified: all.filter(
      (l) => l.status === "qualified" || l.status === "appointment",
    ).length,
    appointments: all.filter((l) => l.status === "appointment").length,
    neverDialed: neverDialedCount(all),
  };
}
