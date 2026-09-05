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
});

/**
 * ⚠️ A FIXED LITERAL ORACLE, DELIBERATELY NOT DERIVED FROM
 * `CUSTOMER_NON_REASSIGNABLE_TABLES`.
 *
 * The first version of the guard below iterated that constant, which made it
 * SELF-REFERENTIAL: deleting a table from the list also deleted it from the
 * check. Codex demonstrated the bypass — move `receiptRetainedPositions` out of
 * the sealed list and into the rewriting registry with a finder that selects
 * only `applicationCount === 0`, and all 38 tests passed while a merge
 * raw-patched sealed authority. The union check below could not see it either,
 * because a clean MOVE keeps every table classified exactly once.
 *
 * These three names are the protected set. Changing this array is the explicit,
 * reviewable act of changing what is protected — it cannot happen as a side
 * effect of editing a registry.
 */
const SEALED_RECEIPT_AUTHORITY = [
  "receiptMovements",
  "receiptRetainedPositions",
  "receiptApplications",
] as const;

describe("customer merge registry — sealed receipt authority", () => {
  test("no sealed receipt table is ever in the rewriting registry", () => {
    const rewritten = new Set<string>(CUSTOMER_REFERENCING_TABLES.map((entry) => entry.table));
    for (const table of SEALED_RECEIPT_AUTHORITY) {
      expect(
        rewritten.has(table),
        `"${table}" carries sealed economic provenance: a merge must not raw-patch ` +
          `its customerId, not even selectively. Deciding what a merge should do ` +
          `instead is SCRUM-250.`
      ).toBe(false);
    }
  });

  test("the sealed list still declares exactly the protected set", () => {
    // Catches SILENT REMOVAL. Without this, dropping a table from
    // CUSTOMER_NON_REASSIGNABLE_TABLES and adding it to the rewriting registry
    // satisfies the union check (still classified once) and, before the oracle
    // above existed, satisfied the guard too.
    expect([...CUSTOMER_NON_REASSIGNABLE_TABLES].sort()).toEqual([...SEALED_RECEIPT_AUTHORITY].sort());
  });
});
