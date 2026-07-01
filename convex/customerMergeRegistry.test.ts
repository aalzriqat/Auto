// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CUSTOMER_REFERENCING_TABLES } from "./utils/mergeHelpers";

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
    const mergeTables = CUSTOMER_REFERENCING_TABLES.map((entry) => entry.table).sort();

    expect(mergeTables).toEqual(schemaTables);
  });
});
