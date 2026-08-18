// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CUSTOMER_DERIVED_TABLES, CUSTOMER_REFERENCING_TABLES } from "./utils/mergeHelpers";

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
  test("covers every schema table with a customerId foreign key", () => {
    const schemaSource = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
    const schemaTables = customerReferenceTablesFromSchema(schemaSource);
    // Every table with a `customerId` must be either rewritten by the merge or
    // explicitly declared derived — never silently absent from both.
    const mergeTables = [
      ...CUSTOMER_REFERENCING_TABLES.map((entry) => entry.table),
      ...CUSTOMER_DERIVED_TABLES,
    ].sort();

    expect(mergeTables).toEqual(schemaTables);
  });
});
