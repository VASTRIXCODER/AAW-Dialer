import {
  CORE_LEAD_FIELDS,
  formatFieldValue,
  leadFieldValue,
  type LeadFieldDef,
  type LeadFieldType,
} from "./field-schema";
import type { Lead } from "../types";

/** A compact, display-ready row from the data the lead sheet supplied. */
export interface LeadSheetEntry {
  key: string;
  label: string;
  value: string;
}

/** A logical group for the dialer's read-only lead-sheet view. */
export interface LeadSheetSection {
  key: "contact" | "location" | "details";
  label: string;
  entries: LeadSheetEntry[];
}

type LeadValue = string | number | boolean | null | undefined;

const CONTACT_FIELDS: Array<{ key: keyof Lead; label: string; type: LeadFieldType }> = [
  { key: "phone", label: "Phone", type: "phone" },
  { key: "email", label: "Email", type: "email" },
];

const LOCATION_FIELDS: Array<{ key: keyof Lead; label: string; type: LeadFieldType }> = [
  { key: "address", label: "Address", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "zip", label: "ZIP", type: "text" },
];

function humanizeFieldKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Core booleans default to false even when a spreadsheet never supplied that
 * column, so only show them when true. A custom boolean, however, exists only
 * because the upload carried its column; false is meaningful there and is kept.
 */
function hasDisplayValue(value: LeadValue, source: "core" | "custom"): boolean {
  if (value == null || value === "") return false;
  return source === "custom" || typeof value !== "boolean" || value;
}

function renderValue(value: LeadValue, type: LeadFieldType): string {
  if (type === "boolean") return value === true ? "Yes" : "No";
  return formatFieldValue(value, type);
}

function addEntry(
  entries: LeadSheetEntry[],
  key: string,
  label: string,
  value: LeadValue,
  type: LeadFieldType,
  source: "core" | "custom",
): void {
  if (!hasDisplayValue(value, source)) return;
  entries.push({ key, label, value: renderValue(value, type) });
}

/**
 * Organize every non-empty value the importer stores for a lead. The supplied
 * schema retains original CSV labels and types; values from older imports that
 * predate a schema are still shown with a readable fallback label.
 */
export function leadSheetSections(
  lead: Lead,
  fields: LeadFieldDef[] | undefined,
): LeadSheetSection[] {
  const contact: LeadSheetEntry[] = [];
  const location: LeadSheetEntry[] = [];
  const details: LeadSheetEntry[] = [];

  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim();
  if (name) contact.push({ key: "name", label: "Name", value: name });
  for (const field of CONTACT_FIELDS) {
    addEntry(contact, field.key, field.label, lead[field.key] as LeadValue, field.type, "core");
  }
  for (const field of LOCATION_FIELDS) {
    addEntry(location, field.key, field.label, lead[field.key] as LeadValue, field.type, "core");
  }

  // Start with canonical core slots, then apply an organization's label/type
  // overrides from its stored field schema.
  const coreByKey = new Map(CORE_LEAD_FIELDS.map((field) => [field.key, field]));
  for (const field of fields ?? []) {
    if (field.source === "core") coreByKey.set(field.key, field);
  }
  for (const core of CORE_LEAD_FIELDS) {
    const field = coreByKey.get(core.key) ?? core;
    addEntry(details, field.key, field.label, leadFieldValue(lead, field), field.type, "core");
  }

  // The registered schema supplies the original header label and detected type
  // for CSV spillover. Keep its order, which is also the upload's column order.
  const customDefs = (fields ?? []).filter((field) => field.source === "custom");
  const definedCustomKeys = new Set<string>();
  for (const field of customDefs) {
    definedCustomKeys.add(field.key);
    addEntry(
      details,
      field.key,
      field.label,
      lead.customFields?.[field.key],
      field.type,
      "custom",
    );
  }

  // Legacy rows can have custom_fields without a corresponding org schema.
  // Showing them here guarantees no spreadsheet detail silently disappears.
  for (const [key, value] of Object.entries(lead.customFields ?? {})) {
    if (definedCustomKeys.has(key)) continue;
    const type: LeadFieldType =
      typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "text";
    addEntry(details, key, humanizeFieldKey(key), value, type, "custom");
  }

  const sections: LeadSheetSection[] = [
    { key: "contact", label: "Contact", entries: contact },
    { key: "location", label: "Location", entries: location },
    { key: "details", label: "Imported details", entries: details },
  ];
  return sections.filter((section) => section.entries.length > 0);
}
