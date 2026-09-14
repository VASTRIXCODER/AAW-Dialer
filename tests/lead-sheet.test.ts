import { describe, expect, it } from "vitest";
import { leadSheetSections } from "@/lib/leads/lead-sheet";
import type { Lead } from "@/lib/types";

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    firstName: "Ada",
    lastName: "Lovelace",
    phone: "+15551234567",
    address: "12 Analytical Engine Way",
    city: "London",
    state: "ON",
    zip: "N1 9GU",
    utilityProvider: "Acme Energy",
    solarProvider: "",
    status: "new",
    campaignId: "campaign-1",
    hasEV: false,
    hasPool: false,
    hasBattery: false,
    multipleSystems: false,
    createdAt: "2026-09-14T00:00:00.000Z",
    timezone: "America/New_York",
    ...overrides,
  };
}

describe("leadSheetSections", () => {
  it("organizes mapped fields and every stored CSV spillover value", () => {
    const sections = leadSheetSections(
      makeLead({
        email: "ada@example.com",
        utilityBill: 189,
        hasEV: true,
        customFields: {
          referral_source: "Neighborhood event",
          policy_expired: false,
          legacy_code: "00123",
        },
      }),
      [
        {
          key: "referral_source",
          label: "Referral source",
          type: "text",
          source: "custom",
          showInTable: true,
          showInQualify: false,
        },
        {
          key: "policy_expired",
          label: "Policy expired",
          type: "boolean",
          source: "custom",
          showInTable: true,
          showInQualify: false,
        },
      ],
    );

    expect(sections.find((section) => section.key === "contact")?.entries).toEqual(
      expect.arrayContaining([
        { key: "name", label: "Name", value: "Ada Lovelace" },
        { key: "email", label: "Email", value: "ada@example.com" },
      ]),
    );
    expect(sections.find((section) => section.key === "location")?.entries).toEqual(
      expect.arrayContaining([{ key: "zip", label: "ZIP", value: "N1 9GU" }]),
    );
    expect(sections.find((section) => section.key === "details")?.entries).toEqual(
      expect.arrayContaining([
        { key: "utilityBill", label: "Utility bill ($/mo)", value: "$189" },
        { key: "hasEV", label: "EV", value: "Yes" },
        { key: "referral_source", label: "Referral source", value: "Neighborhood event" },
        { key: "policy_expired", label: "Policy expired", value: "No" },
        { key: "legacy_code", label: "Legacy Code", value: "00123" },
      ]),
    );
  });

  it("omits empty and default-false core values but keeps false uploaded custom values", () => {
    const sections = leadSheetSections(
      makeLead({ customFields: { opted_in: false } }),
      [
        {
          key: "opted_in",
          label: "Opted in",
          type: "boolean",
          source: "custom",
          showInTable: true,
          showInQualify: false,
        },
      ],
    );
    const details = sections.find((section) => section.key === "details")?.entries ?? [];

    expect(details).toContainEqual({ key: "opted_in", label: "Opted in", value: "No" });
    expect(details.find((entry) => entry.key === "solarPayment")).toBeUndefined();
    expect(details.find((entry) => entry.key === "hasPool")).toBeUndefined();
  });
});
