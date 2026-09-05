// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CUSTOMER_DERIVED_TABLES,
  CUSTOMER_NON_REASSIGNABLE_TABLES,
  CUSTOMER_REFERENCING_TABLES,
} from "./utils/mergeHelpers";

function customerReferenceTablesFromSchema(source: string): string[] {
  const tables = new Set<string>();
  let currentTable: string | null = null;

  for (const line of source.split(/\r?\n/)) {
    const tableMatch = line.match(/^  ([A-Za-z0-9_]+): defineTable/);
    if (tableMatch) currentTable = tableMatch[1];
    if (currentTable && line.includes("customerId: v.")) {
      tables.add(currentTable);
    }
  }

  return [...tables].sort();
}

describe("customer merge registry", () => {
  test("classifies every schema table with a customerId, exactly once", () => {
    const schemaSource = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
    const schemaTables = customerReferenceTablesFromSchema(schemaSource);
    // Every table with a `customerId` must be rewritten by the merge, declared
    // derived, or declared non-reassignable authority — never silently absent
    // from all three, and never in two of them at once (the sorted comparison
    // rejects a duplicate, because the schema side is a Set).
    const mergeTables = [
      ...CUSTOMER_REFERENCING_TABLES.map((entry) => entry.table),
      ...CUSTOMER_DERIVED_TABLES,
      ...CUSTOMER_NON_REASSIGNABLE_TABLES,
    ].sort();

    expect(mergeTables).toEqual(schemaTables);
  });

  /**
   * SCRUM-218-C / owner blocker c17675. The test above is satisfied by ANY
   * single classification, so it would happily accept a receipt-authority table
   * being MOVED from the non-reassignable list back into the rewriting
   * registry. That move is precisely the defect, so it gets its own assertion
   * rather than relying on a check that cannot see it.
   */
  test("never lets sealed receipt authority into the rewriting registry", () => {
    const rewritten = new Set<string>(CUSTOMER_REFERENCING_TABLES.map((entry) => entry.table));
    for (const table of CUSTOMER_NON_REASSIGNABLE_TABLES) {
      expect(
        rewritten.has(table),
        `"${table}" carries sealed economic provenance: a merge must not raw-patch ` +
          `its customerId. Deciding what a merge should do instead is SCRUM-250.`
      ).toBe(false);
    }
  });
});
