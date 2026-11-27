import { describe, expect, test } from "vitest";
import schema from "../convex/schema";
import { PURGE_IMPACT_MAP, PURGE_ORG_INDEX, tablesOfClass } from "../convex/utils/purgeImpactMap";

/**
 * SCRUM-1023: a table added to the schema without a purge ruling fails here,
 * instead of sitting silently outside the purge's reasoning.
 */
const definitions = schema.tables as unknown as Record<string, { indexes: Array<{ indexDescriptor: string; fields: string[] }> }>;
const schemaTables = Object.keys(definitions).sort((a, b) => a.localeCompare(b));

describe("purge impact map census (SCRUM-1023)", () => {
  test("every schema table is classified, and nothing else is", () => {
    expect(Object.keys(PURGE_IMPACT_MAP).sort((a, b) => a.localeCompare(b))).toEqual(schemaTables);
  });

  test("the three roots are exactly the tables the owner named", () => {
    expect(tablesOfClass("ROOT").sort((a, b) => a.localeCompare(b))).toEqual(["expenses", "financeApplications", "sales"]);
  });

  test("every table the manifest scans has an org-leading index that really exists", () => {
    const scanned = tablesOfClass("STRUCTURAL", "LEDGER", "DERIVED", "AUDIT", "REFUSE_IF_REFERENCED").filter((t) => t !== "journalLines");
    expect(Object.keys(PURGE_ORG_INDEX).sort((a, b) => a.localeCompare(b))).toEqual(scanned.sort((a, b) => a.localeCompare(b)));
    for (const table of scanned) {
      const index = definitions[table]?.indexes.find((i) => i.indexDescriptor === PURGE_ORG_INDEX[table]);
      expect(index, `${table}.${PURGE_ORG_INDEX[table]}`).toBeDefined();
      expect(index?.fields[0], table).toBe("orgId");
    }
  });
});
