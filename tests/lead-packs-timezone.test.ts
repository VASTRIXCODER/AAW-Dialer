import { describe, expect, it } from "vitest";
import { MAX_PACKS_PER_UPLOAD, planTimezonePacks } from "@/lib/db/lead-packs";

const row = (state: string, zip = "") => ({ state, zip });

describe("planTimezonePacks", () => {
  it("orders zones EAST TO WEST, regardless of file order", () => {
    // File leads with a Pacific row, then Eastern, then Central — the packs
    // must still come out Eastern, Central, Pacific.
    const rows = [row("CA"), row("NY"), row("NY"), row("IL")];
    const packs = planTimezonePacks(rows, 10, "Jan list");
    expect(packs.map((p) => p.label)).toEqual([
      "Jan list · Eastern",
      "Jan list · Central",
      "Jan list · Pacific",
    ]);
  });

  it("keeps a zone's rows in file order inside its pack", () => {
    const rows = [row("NY"), row("CA"), row("NY"), row("NY")];
    const packs = planTimezonePacks(rows, 10, "L");
    const eastern = packs.find((p) => p.label.includes("Eastern"))!;
    expect(eastern.indices).toEqual([0, 2, 3]);
  });

  it("cuts a large zone into numbered packs, still in file order", () => {
    const rows = Array.from({ length: 25 }, () => row("CA"));
    const packs = planTimezonePacks(rows, 10, "Big");
    expect(packs.map((p) => p.label)).toEqual([
      "Big · Pacific · Pack 1",
      "Big · Pacific · Pack 2",
      "Big · Pacific · Pack 3",
    ]);
    expect(packs[0].indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(packs[2].indices).toEqual([20, 21, 22, 23, 24]);
  });

  it("names a single-pack zone plainly, with no misleading 'Pack 1'", () => {
    const packs = planTimezonePacks([row("CA")], 10, "L");
    expect(packs[0].label).toBe("L · Pacific");
  });

  it("separates El Paso from the rest of Texas even though both are state TX", () => {
    const rows = [row("TX", "75201"), row("TX", "79901"), row("TX", "77002")];
    const packs = planTimezonePacks(rows, 10, "L");
    expect(packs.map((p) => p.label)).toEqual(["L · Central", "L · Mountain"]);
    const central = packs.find((p) => p.label === "L · Central")!;
    const mountain = packs.find((p) => p.label === "L · Mountain")!;
    expect(central.indices).toEqual([0, 2]); // Dallas, Houston
    expect(mountain.indices).toEqual([1]); // El Paso
  });

  it("puts Arizona in its own bucket, distinct from the rest of Mountain time", () => {
    const rows = [row("CO"), row("AZ")];
    const packs = planTimezonePacks(rows, 10, "L");
    expect(packs.map((p) => p.label).sort()).toEqual([
      "L · Mountain",
      "L · Mountain (Arizona)",
    ]);
  });

  it("collects leads with no resolvable zone into one trailing bucket", () => {
    const rows = [row("CA"), row(""), row("NY"), row("Ontario")];
    const packs = planTimezonePacks(rows, 10, "L");
    expect(packs.map((p) => p.label)).toEqual([
      "L · Eastern",
      "L · Pacific",
      "L · Unknown time zone",
    ]);
    const unknown = packs.find((p) => p.label.includes("Unknown"))!;
    expect(unknown.indices).toEqual([1, 3]);
  });

  it("never drops a lead: every input index appears in exactly one pack", () => {
    const rows = [
      row("CA"), row(""), row("NY"), row("TX", "79901"), row("AZ"),
      row("TX", "75201"), row("HI"), row("AK"), row("Nowhere"),
    ];
    const packs = planTimezonePacks(rows, 10, "L");
    const seen = packs.flatMap((p) => p.indices).sort((a, b) => a - b);
    expect(seen).toEqual(rows.map((_, i) => i));
  });

  it("is empty for an empty file", () => {
    expect(planTimezonePacks([], 10, "L")).toEqual([]);
  });

  it("never plans more than the pack ceiling", () => {
    // Far fewer than 500 real zones exist, so this is really asserting the
    // safety net never fires under realistic input — not exercising it.
    const rows = Array.from({ length: 5_000 }, (_, i) =>
      row(i % 2 === 0 ? "CA" : "NY"),
    );
    const packs = planTimezonePacks(rows, 10, "Huge");
    expect(packs.length).toBeLessThanOrEqual(MAX_PACKS_PER_UPLOAD);
  });
});
