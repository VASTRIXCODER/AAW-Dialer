import { NextResponse } from "next/server";
import { dncKey, getDncDigits } from "@/lib/db/dnc";
import {
  bumpImportJob,
  getImportJob,
  normalizeDedupeMode,
  writeImportChunk,
  type ImportChunkRow,
  type ImportJob,
} from "@/lib/db/lead-import";
import { insertLeads, type LeadInput } from "@/lib/db/leads";
import { hasCurrentCertification, normalizeCampaignId } from "@/lib/legal/campaign-cert";
import {
  mergeDiscoveredLeadFields,
  sanitizeDiscoveredFields,
  type ParsedLead,
} from "@/lib/leads/csv";
import type { LeadFieldDef } from "@/lib/leads/field-schema";
import {
  parseCsvToLeads,
  sanitizeColumnPlan,
  type ColumnPlan,
} from "@/lib/leads/parse-request";
import { isValidGroupKey } from "@/lib/db/lead-groups";
import {
  createPacks,
  planCityPacks,
  planPacks,
  planTimezonePacks,
  pruneEmptyPacks,
  setPackSizes,
} from "@/lib/db/lead-packs";
import type { LeadGroup } from "@/lib/types";
import { processLeadIntake } from "@/lib/orchestration/events";
import { getViewer } from "@/lib/org/membership";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Reject CSV payloads larger than this (bytes) before we ever parse them.
 *
 * This is a REQUEST ceiling, not a file ceiling. The importer splits an upload
 * into chunks under this size (see lib/leads/chunk.ts) and sends them in order,
 * so a 40 MB export imports in full — it just arrives as more than one request.
 * The value sits under the serverless body limit with room for the JSON envelope.
 */
const MAX_CSV_BYTES = 3_500_000;

/**
 * Rows one request will insert.
 *
 * This used to be 5,000 and was applied with a bare `.slice()` — a 9,381-row
 * customer file reported "Imported 5000 leads" and the other 4,381 homeowners
 * were discarded with no error, no warning, and no way for the importer to know.
 * It is now a backstop rather than a policy: the client chunks below it, so
 * hitting it means something unusual happened, and when it IS hit the response
 * says so (`truncated`) instead of lying about a clean import.
 */
const MAX_ROWS_PER_REQUEST = 25_000;

/**
 * Append NEW discovered custom fields to the org's settings.leadFields so the
 * table / qualify / AI surfaces know each field's label and type. Read-merge-
 * write with the admin client (importers are managers who may lack `org.edit`,
 * so updateOrganizationSettings' authorize gate would wrongly reject them).
 * Existing defs are never duplicated or overwritten (mergeDiscoveredLeadFields),
 * and only the `leadFields` key of the settings blob is touched. Best-effort:
 * the leads have already landed, so a settings hiccup must not fail the import.
 */
async function persistDiscoveredFields(
  orgId: string | null | undefined,
  discovered: LeadFieldDef[],
): Promise<void> {
  if (!orgId || !discovered.length || !isAdminConfigured()) return;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", orgId)
      .maybeSingle();
    const raw =
      data?.settings && typeof data.settings === "object"
        ? (data.settings as Record<string, unknown>)
        : {};
    const existing = Array.isArray(raw.leadFields)
      ? (raw.leadFields as LeadFieldDef[])
      : [];
    const { fields, added } = mergeDiscoveredLeadFields(existing, discovered);
    if (!added) return;
    await admin
      .from("organizations")
      .update({ settings: { ...raw, leadFields: fields } })
      .eq("id", orgId);
  } catch {
    // Non-fatal by design — the field VALUES are already on the leads.
  }
}

/**
 * Import leads from a CSV.
 *
 * Preferred: send the raw file text as `csv`. The server parses it, tries the
 * fast deterministic header mapper, and — when that can't confidently read the
 * file (no header row, broker exports, exotic layouts) — falls back to Claude to
 * infer the column mapping. Either way every field is extracted and phone numbers
 * are normalized to E.164.
 *
 * Back-compat: callers may still send pre-parsed `rows`.
 */
export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer.permissions.includes("leads.import")) {
    return NextResponse.json(
      { inserted: 0, error: "You don't have permission to import leads." },
      { status: 403 },
    );
  }

  // Throttle imports: each one can trigger CSV parsing + a Claude column-mapping
  // call, so a loop would be a CPU + token DoS. The budget is per REQUEST and a
  // large upload is now legitimately many requests (one per chunk), so the old
  // ceiling of 12 would have failed a big import part-way through. The token
  // cost it was really protecting is bounded elsewhere: the model runs once per
  // upload and every later chunk replays the resolved plan.
  const rl = rateLimit(`import:${viewer.user?.id ?? clientIp(req)}`, 240, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { inserted: 0, error: "Too many imports in a row — wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    csv?: string;
    rows?: LeadInput[];
    /** Field defs for the rows' customFields (the sort-preview round trip
     *  carries them so AI-sorted imports register their columns too). */
    discoveredFields?: unknown;
    campaignId?: string | null;
    leadGroup?: LeadGroup | null;
    /** Cut this import into numbered packs of roughly this many leads. */
    packSize?: number | null;
    /** Label the packs carry — normally the source file name. */
    packBatch?: string | null;
    /** How to cut the packs. "sequence" (default) slices the file in order;
     *  "city" gives each city its own pack(s), in the order the file presents
     *  them; "timezone" gives each timezone (from state+zip) its own pack(s),
     *  in canonical east-to-west order. See planCityPacks / planTimezonePacks. */
    packBy?: "sequence" | "city" | "timezone" | null;
    // ── Chunked upload (one file arriving as several requests) ──────────────
    /** This chunk's first data row index within the whole file. Keeps created_at
     *  — and therefore the dial queue — in file order across chunks. */
    rowOffset?: number;
    /** Packs already created for this upload, so numbering continues. */
    packSeqOffset?: number;
    /** The column layout resolved on the first chunk. Replaying it is what makes
     *  a chunked upload cost one Claude call instead of one per chunk, and what
     *  stops two chunks of the same file reading it differently. */
    columnPlan?: unknown;
    // ── Import Studio (job-tracked imports) ─────────────────────────────────
    /** The uploader's explicit "row 0 is column names" answer. false = the
     *  headerless broker-list path: row 0 is DATA, and no layer may eat it. */
    hasHeader?: boolean;
    /** Explicit delimiter override (TSV with commas inside cells). */
    delimiter?: string;
    /** Import job to account this chunk against (created via
     *  POST /api/leads/import/jobs). Enables dedupe modes + rollback. */
    jobId?: string;
    /** skip (default, today's behavior) | update | create_new. */
    dedupeMode?: string;
    /** Original file name, stamped on every inserted row (provenance). */
    sourceFile?: string;
  };

  // Reject an oversized CSV before parsing: parseCsvToLeads walks the whole string
  // character by character and the AI fallback ships the grid to Claude, so the
  // cap has to come BEFORE that work (the 5,000-row slice below happens after it).
  if (typeof body.csv === "string" && body.csv.length > MAX_CSV_BYTES) {
    return NextResponse.json(
      {
        inserted: 0,
        error:
          "That upload chunk is too large. Reload the page and try again — the " +
          "importer splits big files automatically, so this shouldn't happen.",
      },
      { status: 413 },
    );
  }

  const hasGroup = Object.prototype.hasOwnProperty.call(body, "leadGroup");
  // Group keys are per-org now, so validity is "does THIS org have it" rather
  // than membership of a global list.
  if (hasGroup && body.leadGroup !== null) {
    const ok = await isValidGroupKey(viewer.org?.id ?? null, body.leadGroup);
    if (!ok) {
      return NextResponse.json(
        { inserted: 0, error: "That lead group doesn't exist in this workspace." },
        { status: 400 },
      );
    }
  }

  // Compliance gate: a list can't be dialed until someone has certified this
  // specific campaign (or the org-wide "no campaign" bucket) has the legal
  // right to be contacted, at the current certification version. Checked
  // BEFORE parsing so an uncertified import never spends an AI column-mapping
  // call on a file that's about to be blocked anyway.
  const certCampaignId = normalizeCampaignId(body.campaignId);
  if (viewer.org?.id) {
    const certified = await hasCurrentCertification(viewer.org.id, certCampaignId);
    if (!certified) {
      return NextResponse.json(
        {
          inserted: 0,
          error: "This campaign needs a compliance certification before you can import leads into it.",
          certificationRequired: true,
          campaignId: certCampaignId,
        },
        { status: 403 },
      );
    }
  }

  let leads: ParsedLead[] | LeadInput[] = [];
  let source: "headers" | "ai" | "rows" = "rows";
  let aiError: string | null = null;
  let discoveredFields: LeadFieldDef[] = [];
  // Handed back so the client can replay it on the rest of this upload's chunks.
  let columnPlan: ColumnPlan | null = null;
  // Data rows this request received, and how many of them carried neither a
  // phone nor a name. Reported so the importer can reconcile every row of the
  // file against an outcome instead of trusting a bare success.
  let fileRows = 0;
  let skippedRows = 0;

  // Delimiter override is allowlisted — anything else falls back to detection.
  const DELIMS = new Set([",", ";", "\t", "|"]);
  const delimiter =
    typeof body.delimiter === "string" && DELIMS.has(body.delimiter)
      ? body.delimiter
      : undefined;

  if (typeof body.csv === "string" && body.csv.trim()) {
    const parsed = await parseCsvToLeads(body.csv, {
      // Untrusted by the time it comes back through the browser — rebuilt from
      // recognised values only, or discarded (then this chunk resolves its own).
      plan: sanitizeColumnPlan(body.columnPlan),
      hasHeader: typeof body.hasHeader === "boolean" ? body.hasHeader : undefined,
      delimiter,
    });
    if ("error" in parsed) {
      return NextResponse.json({ inserted: 0, error: parsed.error }, { status: 400 });
    }
    leads = parsed.leads;
    source = parsed.source;
    aiError = parsed.aiError;
    discoveredFields = parsed.discoveredFields;
    columnPlan = parsed.plan;
    fileRows = parsed.fileRows;
    skippedRows = parsed.skippedRows;
  } else if (Array.isArray(body.rows)) {
    leads = body.rows;
    fileRows = body.rows.length;
    // Client-held ParsedLead JSON (the sort-preview round trip) — its field
    // defs arrive over the wire, so re-validate every one before trusting it.
    discoveredFields = sanitizeDiscoveredFields(body.discoveredFields);
  }

  if (!leads.length) {
    return NextResponse.json(
      {
        inserted: 0,
        error:
          aiError ??
          "Couldn't find any leads in that file. Make sure it has a phone or name column.",
      },
      { status: 400 },
    );
  }

  // Assign the whole batch to the chosen campaign (if any) and/or fixed intake
  // group (if any). `hasGroup` distinguishes "leadGroup: null" (explicit
  // "unsorted") from the key being omitted entirely (legacy callers that never
  // mention groups, whose rows keep whatever lead_group they'd otherwise get).
  // Scrub the org's Do-Not-Call list: a re-import must never resurrect a number a
  // homeowner asked us to stop calling (import dedup only compares against
  // existing lead ROWS, which may have been deleted).
  const dncSet = await getDncDigits(viewer.org?.id ?? null);
  const scrubbed = dncSet.size
    ? leads.filter(
        (r) => !dncSet.has(dncKey(String((r as { phone?: string }).phone ?? ""))),
      )
    : leads;
  const dncSkipped = leads.length - scrubbed.length;
  // Backstop only, and a LOUD one: `truncated` rides back on the response and the
  // importer surfaces it. Silently slicing here is the bug this whole change
  // exists to kill — an import that drops rows must never report success.
  const capped = scrubbed.slice(0, MAX_ROWS_PER_REQUEST);
  const truncated = scrubbed.length - capped.length;

  // ── Packs ────────────────────────────────────────────────────────────────
  // Cut the batch into numbered slices so a big list can be dealt out a pack
  // at a time. The pack rows are created up front (we need their ids to stamp
  // each lead), then sized and pruned after the insert — dedupe and invalid
  // rows mean the final counts aren't knowable until the write lands.
  const packSize = Number(body.packSize) || 0;
  const wantsPacks = packSize > 0 && Boolean(viewer.org?.id);
  const packBy =
    body.packBy === "city" ? "city" : body.packBy === "timezone" ? "timezone" : "sequence";
  // Packs this upload already created in earlier chunks — numbering continues
  // from there so one file never deals out two "Pack 1"s.
  const packSeqOffset = Math.max(0, Math.floor(Number(body.packSeqOffset) || 0));
  let packIds: string[] = [];
  let assignedPackOf: (index: number) => string | null = () => null;

  if (wantsPacks && viewer.org?.id) {
    const batch = (body.packBatch || "Upload").toString();
    if (packBy === "city" || packBy === "timezone") {
      // One pack per city or per timezone (or several for a big one). Cities
      // come out in file-introduction order; timezones come out canonical
      // east-to-west — either way, planCityPacks/planTimezonePacks own the
      // ordering, and this only maps their planned row indices onto the pack
      // ids the insert hands back.
      const planned =
        packBy === "city"
          ? planCityPacks(
              capped as { city?: string | null; state?: string | null }[],
              packSize,
              batch,
            )
          : planTimezonePacks(
              capped as { state?: string | null; zip?: string | null }[],
              packSize,
              batch,
            );
      const packs = await createPacks(viewer.org.id, {
        batch,
        packCount: planned.length,
        createdBy: viewer.user?.id ?? null,
        // A group that spans two chunks gets a pack in each. Both would
        // otherwise read identically with nothing to tell them apart, so a
        // continuation chunk numbers its packs explicitly.
        labels: planned.map((p, i) =>
          packSeqOffset > 0 ? `${p.label} · Pack ${packSeqOffset + i + 1}` : p.label,
        ),
        seqOffset: packSeqOffset,
      });
      if (packs.length) {
        packIds = packs.map((p) => p.id);
        const packIdOfRow = new Map<number, string>();
        planned.forEach((p, pi) => {
          const id = packs[pi]?.id;
          if (id) for (const rowIndex of p.indices) packIdOfRow.set(rowIndex, id);
        });
        assignedPackOf = (i) => packIdOfRow.get(i) ?? null;
      }
    } else {
      const { packCount, effectiveSize } = planPacks(capped.length, packSize);
      const packs = await createPacks(viewer.org.id, {
        batch,
        packCount,
        createdBy: viewer.user?.id ?? null,
        seqOffset: packSeqOffset,
      });
      if (packs.length) {
        packIds = packs.map((p) => p.id);
        assignedPackOf = (i) => packs[Math.min(packs.length - 1, Math.floor(i / effectiveSize))].id;
      }
    }
  }

  const rows: LeadInput[] = capped.map((r, i) => ({
    ...r,
    ...(body.campaignId ? { campaignId: body.campaignId } : {}),
    ...(hasGroup ? { leadGroup: body.leadGroup } : {}),
    ...(packIds.length ? { leadPackId: assignedPackOf(i) } : {}),
  }));

  // The chunk's position in the file drives the created_at origin, so chunk 7's
  // rows sort after chunk 6's however long the requests took — see insertLeads.
  const rowOffset = Math.max(0, Math.floor(Number(body.rowOffset) || 0));

  // ── Job-tracked write (Import Studio) ─────────────────────────────────────
  // A valid, still-running job for THIS org switches the write to
  // writeImportChunk: one dedupe probe per chunk instead of a full phone scan,
  // dedupe modes, provenance stamping, and atomic per-chunk accounting on the
  // job row. Everything else (packs, groups, campaign, cert gate) is identical.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let job: ImportJob | null = null;
  if (typeof body.jobId === "string" && UUID.test(body.jobId) && viewer.org?.id) {
    job = await getImportJob(body.jobId);
    if (!job || job.orgId !== viewer.org.id) {
      return NextResponse.json(
        { inserted: 0, error: "That import job doesn't exist in this workspace." },
        { status: 400 },
      );
    }
    if (job.status !== "running") {
      // A canceled/finished job must STOP the chunk loop — silently importing
      // into a dead job is how "I canceled it but the leads kept coming" happens.
      return NextResponse.json(
        { inserted: 0, error: "That import job is no longer running." },
        { status: 409 },
      );
    }
  }

  let written: {
    inserted: number;
    invalidPhone: number;
    duplicates: number;
    error?: string;
    noop?: boolean;
  };
  let updated = 0;
  let failed = 0;
  let dncFlagged = 0;

  if (job && viewer.org?.id && viewer.user?.id) {
    const dedupeMode = normalizeDedupeMode(body.dedupeMode ?? job.dedupeMode);
    const chunk = rows.length
      ? await writeImportChunk(rows as ImportChunkRow[], {
          orgId: viewer.org.id,
          ownerId: viewer.user.id,
          jobId: job.id,
          sourceFile:
            (typeof body.sourceFile === "string" && body.sourceFile.slice(0, 200)) ||
            job.fileName ||
            null,
          dedupeMode,
          rowOffset,
        })
      : {
          created: 0,
          updated: 0,
          duplicates: 0,
          invalidPhone: 0,
          dncFlagged: 0,
          failed: 0,
          errors: [] as { row: number; message: string }[],
          noop: true as const,
        };
    updated = chunk.updated;
    failed = chunk.failed;
    dncFlagged = chunk.dncFlagged;
    written = {
      inserted: chunk.created,
      invalidPhone: chunk.invalidPhone,
      duplicates: chunk.duplicates,
      error: "error" in chunk ? chunk.error : undefined,
      noop: chunk.noop,
    };
    // Per-chunk accounting bump — atomic, because chunks are separate requests.
    await bumpImportJob(job.id, {
      rows: fileRows,
      created: chunk.created,
      updated: chunk.updated,
      duplicates: chunk.duplicates,
      dnc: dncSkipped,
      invalid: chunk.invalidPhone,
      skipped: skippedRows,
      failed: chunk.failed,
      errors: chunk.errors,
    });
  } else {
    written = rows.length
      ? await insertLeads(rows, { createdAtOffsetMs: rowOffset })
      : { inserted: 0, invalidPhone: 0, duplicates: 0, noop: true };
  }

  // "Nothing worth inserting" is not a failure. One chunk of a re-uploaded file
  // is often 100% duplicates (or 100% DNC, leaving `rows` empty above), and
  // answering 400 there would abort the remaining chunks and leave the file
  // half-imported — the failure mode this change exists to remove. Real errors
  // (a DB write that failed, no session) still come back as errors.
  const { noop, ...counts } = written;
  const result = noop ? { ...counts, error: undefined } : counts;

  // Register any newly discovered custom fields AFTER the rows land — an
  // import that failed (or inserted nothing) must not grow the org's schema.
  if (!result.error && result.inserted > 0) {
    await persistDiscoveredFields(viewer.org?.id, discoveredFields);
    // Phase 2 intake (§7): opportunities + speed-to-lead clocks for the rows
    // that just landed. Fire-and-forget — the reconcile cron is the backstop.
    void processLeadIntake().catch(() => {});
  }

  if (packIds.length && viewer.org?.id) {
    // Count what actually landed per pack rather than what we intended, then
    // drop any pack that ended up empty (a fully-duplicate tail slice).
    const counts = new Map<string, number>();
    if (!result.error) {
      rows.forEach((r) => {
        const id = r.leadPackId;
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      });
    }
    await setPackSizes(
      viewer.org.id,
      packIds.map((id) => ({ id, size: counts.get(id) ?? 0 })),
    );
    await pruneEmptyPacks(viewer.org.id, packIds);
  }

  return NextResponse.json(
    {
      ...result,
      source,
      aiError,
      packs: packIds.length,
      dncSkipped,
      // Job-tracked extras: existing leads enriched (dedupe mode "update"),
      // rows that failed to write, and rows the file's own DNC column flagged
      // (imported suppressed — stored, reportable, never dialable).
      updated,
      failed,
      dncFlagged,
      jobId: job?.id ?? null,
      // The full accounting for this request: every data row it received ends up
      // in exactly one of inserted / duplicates / dncSkipped / skippedRows /
      // truncated. Reported every time so the importer can reconcile the file
      // instead of trusting a bare success.
      fileRows,
      parsedRows: leads.length,
      skippedRows,
      truncated,
      // Replayed by the client on the rest of this upload's chunks.
      columnPlan,
    },
    { status: result.error ? 400 : 200 },
  );
}
