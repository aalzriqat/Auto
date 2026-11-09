import { expect, test } from "vitest";
import schema from "../convex/schema";
import { OPENING_VOID_REFERENCE_INDEX } from "../convex/utils/openingVoidReferences";

interface ValidatorNode {
  kind: string;
  tableName?: string;
  fields?: Record<string, ValidatorNode>;
  members?: ValidatorNode[];
  element?: ValidatorNode;
  key?: ValidatorNode;
  value?: ValidatorNode;
}

// Independent literal oracle: these rows are deleted, unlike retained stock
// and partner masters. A new incoming schema reference must be inspected.
const deletedTables = new Set(["receivables", "receivableDocuments", "employeeAdvances", "prepaidExpenseSchedules",
  "supplierCostRecoveries", "vehicleSupplierPayables", "openingCommissionLiabilities", "deposits"]);
function referencesDeletedSource(validator: ValidatorNode): boolean {
  switch (validator.kind) {
    case "id": return deletedTables.has(validator.tableName ?? "");
    case "object": return Object.values(validator.fields ?? {}).some(referencesDeletedSource);
    case "union": return (validator.members ?? []).some(referencesDeletedSource);
    case "array": return validator.element !== undefined && referencesDeletedSource(validator.element);
    case "record": return [validator.key, validator.value].some(child => child !== undefined && referencesDeletedSource(child));
    case "float64": case "int64": case "boolean": case "bytes": case "string": case "null": case "any": case "literal": return false;
    default: throw new Error(`Unmeasured schema validator: ${validator.kind}`);
  }
}

test("SCRUM-850 every incoming typed reference to a deleted opening source is inspected before void", () => {
  // Org reset scan fields are refused directly. The opening draft intentionally
  // keeps its immutable history. Every other referencing table must be scanned.
  const separatelyHandled = new Set(["organizations", "openingBalanceDrafts"]);
  const missing = Object.entries(schema.tables).filter(([table, definition]) =>
    referencesDeletedSource(definition.validator as unknown as ValidatorNode) && !separatelyHandled.has(table) &&
    !(table in OPENING_VOID_REFERENCE_INDEX)).map(([table]) => table);
  expect(missing).toEqual([]);
});

test("SCRUM-850 each dynamic void reference read uses an actual org-leading schema index", () => {
  const tables = schema.tables as unknown as Record<string, { indexes: Array<{ indexDescriptor: string; fields: string[] }> }>;
  for (const [table, index] of Object.entries(OPENING_VOID_REFERENCE_INDEX)) {
    const definition = tables[table as keyof typeof OPENING_VOID_REFERENCE_INDEX];
    const declared = definition.indexes.find(candidate => candidate.indexDescriptor === index);
    expect(declared?.fields[0], `${table}.${index}`).toBe("orgId");
  }
});
