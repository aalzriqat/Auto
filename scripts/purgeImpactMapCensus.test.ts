import { describe, expect, test } from "vitest";
import schema from "../convex/schema";
import {
  PURGE_CLEARABLE_FIELDS, PURGE_IMPACT_MAP, PURGE_LIVE_STATES, PURGE_NOT_LIVE_STATUS, PURGE_ORG_INDEX, PURGE_PARENT_INDEX,
  PURGE_REFERENCE_COVERAGE, PURGE_ROOT_SURVIVOR_INDEX, PURGE_SCANNED_BY_GET, PURGE_STORAGE_FIELDS, PURGE_TARGET_CLASSES, tablesOfClass,
} from "../convex/utils/purgeImpactMap";
import { allReferences, type Ref, type ValidatorLike } from "./schemaIdReferences";

/**
 * SCRUM-1023: a table added to the schema without a purge ruling fails here,
 * instead of sitting silently outside the purge's reasoning. PR #908 round 1 adds
 * the schema-derived proof that no reference INTO a purgeable table sits in a
 * table (or field) the manifest neither scans nor explicitly covers.
 */
const definitions = schema.tables as unknown as Record<string, { indexes: Array<{ indexDescriptor: string; fields: string[] }>; validator: ValidatorLike }>;
const schemaTables = Object.keys(definitions).sort((a, b) => a.localeCompare(b));
const sorted = (xs: Iterable<string>): string[] => [...xs].sort((a, b) => a.localeCompare(b));

const literalsOf = (v: ValidatorLike & { value?: unknown }): string[] =>
  v.kind === "literal" ? [String(v.value)] : v.kind === "union" ? (v.members ?? []).flatMap((m) => literalsOf(m as ValidatorLike & { value?: unknown })) : [];
const topFields = (v: ValidatorLike): Record<string, ValidatorLike> => {
  if (v.kind === "object") return v.fields ?? {};
  if (v.kind === "union") return Object.assign({}, ...(v.members ?? []).map(topFields));
  return {};
};
const fieldsOf = (table: string): Record<string, ValidatorLike> => topFields(definitions[table].validator);

/** Every table the manifest reads, by whichever mechanism. */
const scannedTables = (): Set<string> => new Set([
  ...Object.keys(PURGE_ORG_INDEX), ...Object.keys(PURGE_ROOT_SURVIVOR_INDEX), ...Object.keys(PURGE_PARENT_INDEX), ...PURGE_SCANNED_BY_GET,
]);

const refKey = (r: Ref): string => `${r.table}.${r.path}->${r.target}`;

/** References INTO a purgeable table from a table that is neither scanned nor covered by name. */
function unaccountedReferences(refs: Ref[], scanned: ReadonlySet<string>, coverage: Readonly<Record<string, string>>): string[] {
  return sorted(refs.filter((r) => PURGE_TARGET_CLASSES.has(PURGE_IMPACT_MAP[r.target]) && !scanned.has(r.table) && !(refKey(r) in coverage)).map(refKey));
}

/** Coverage entries that no longer describe a reference from an unscanned table: they must be deleted, not left to rot. */
function staleCoverage(refs: Ref[], scanned: ReadonlySet<string>, coverage: Readonly<Record<string, string>>): string[] {
  const live = new Set(refs.filter((r) => PURGE_TARGET_CLASSES.has(PURGE_IMPACT_MAP[r.target]) && !scanned.has(r.table)).map(refKey));
  return sorted(Object.keys(coverage).filter((k) => !live.has(k)));
}

describe("purge impact map census (SCRUM-1023)", () => {
  test("every schema table is classified, and nothing else is", () => {
    expect(sorted(Object.keys(PURGE_IMPACT_MAP))).toEqual(schemaTables);
  });

  test("the three roots are exactly the tables the owner named", () => {
    expect(sorted(tablesOfClass("ROOT"))).toEqual(["expenses", "financeApplications", "sales"]);
  });

  test("every purgeable, survivor and audit table is scanned by exactly one mechanism, with an index that really exists", () => {
    const expected = tablesOfClass("STRUCTURAL", "LEDGER", "DERIVED", "FORWARD_LINKED", "AUDIT", "REFUSE_IF_REFERENCED");
    // No filter: journalLines (no org index) is covered by its parent index, not skipped.
    expect(sorted([...Object.keys(PURGE_ORG_INDEX), ...Object.keys(PURGE_PARENT_INDEX)])).toEqual(sorted(expected));
    for (const table of Object.keys(PURGE_ORG_INDEX)) {
      const index = definitions[table]?.indexes.find((i) => i.indexDescriptor === PURGE_ORG_INDEX[table]);
      expect(index, `${table}.${PURGE_ORG_INDEX[table]}`).toBeDefined();
      expect(index?.fields[0], table).toBe("orgId");
    }
    for (const [table, { index, parent, field }] of Object.entries(PURGE_PARENT_INDEX)) {
      const found = definitions[table]?.indexes.find((i) => i.indexDescriptor === index);
      expect(found, `${table}.${index}`).toBeDefined();
      expect(found?.fields[0], table).toBe(field);
      expect(allReferences().some((r) => r.table === table && r.path === field && r.target === parent), `${table}.${field} points at ${parent}`).toBe(true);
      expect(PURGE_ORG_INDEX[parent], `${parent} is read first`).toBeDefined();
    }
  });

  test("the root tables are read as survivors through their org index", () => {
    expect(sorted(Object.keys(PURGE_ROOT_SURVIVOR_INDEX))).toEqual(sorted(tablesOfClass("ROOT")));
    for (const [table, index] of Object.entries(PURGE_ROOT_SURVIVOR_INDEX)) {
      const found = definitions[table]?.indexes.find((i) => i.indexDescriptor === index);
      expect(found?.fields[0], `${table}.${index}`).toBe("orgId");
    }
  });
});

describe("purge reference coverage (PR #908 round 1, R2)", () => {
  const refs = allReferences();

  test("every reference into a purgeable table sits in a table the manifest scans or names explicitly", () => {
    expect(unaccountedReferences(refs, scannedTables(), PURGE_REFERENCE_COVERAGE)).toEqual([]);
    expect(staleCoverage(refs, scannedTables(), PURGE_REFERENCE_COVERAGE)).toEqual([]);
  });

  test("the organization row is scanned because it really holds references into purgeable tables", () => {
    const fromOrg = refs.filter((r) => r.table === "organizations" && PURGE_TARGET_CLASSES.has(PURGE_IMPACT_MAP[r.target]));
    expect(fromOrg.length).toBeGreaterThan(0);
    expect(PURGE_SCANNED_BY_GET.has("organizations")).toBe(true);
  });

  test("mutation control: dropping the organization scan, or the journal line scan, is caught", () => {
    const without = (t: string): Set<string> => new Set([...scannedTables()].filter((x) => x !== t));
    expect(unaccountedReferences(refs, without("organizations"), {}).some((k) => k.startsWith("organizations."))).toBe(true);
    expect(unaccountedReferences(refs, without("journalLines"), {})).toContain("journalLines.journalEntryId->journalEntries");
    expect(unaccountedReferences(refs, without("sales"), {}).some((k) => k.startsWith("sales."))).toBe(true);
  });

  test("mutation control: a reference from a new, unscanned table is caught, and an explicit entry accepts it", () => {
    const fake: Ref = { table: "someNewTable", path: "saleId", target: "sales", optional: true };
    const key = refKey(fake);
    expect(unaccountedReferences([...refs, fake], scannedTables(), {})).toEqual([key]);
    expect(unaccountedReferences([...refs, fake], scannedTables(), { [key]: "reason" })).toEqual([]);
    expect(staleCoverage([...refs, fake], scannedTables(), { [key]: "reason" })).toEqual([]);
  });

  test("mutation control: a coverage entry for a reference that does not exist is stale", () => {
    expect(staleCoverage(refs, scannedTables(), { "ghost.field->sales": "gone" })).toEqual(["ghost.field->sales"]);
    expect(staleCoverage(refs, scannedTables(), { "customers.vehicleId->vehicles": "scanned table" })).toEqual(["customers.vehicleId->vehicles"]);
  });
});

describe("purge live states, clearable fields and storage files match the schema", () => {
  test("every live state names a scanned, joinable table and values that are real schema literals", () => {
    for (const [table, rule] of Object.entries(PURGE_LIVE_STATES)) {
      expect(PURGE_ORG_INDEX[table], `${table} is scanned`).toBeDefined();
      expect(["STRUCTURAL", "LEDGER", "DERIVED"], table).toContain(PURGE_IMPACT_MAP[table]);
      const field = fieldsOf(table)[rule.field];
      expect(field, `${table}.${rule.field}`).toBeDefined();
      const literals = literalsOf(field);
      for (const value of rule.values) expect(literals, `${table}.${rule.field}=${value}`).toContain(value);
    }
  });

  test("every purgeable table with a status lifecycle is either a live state or justified as not live", () => {
    const withStatus = tablesOfClass("STRUCTURAL", "LEDGER", "DERIVED").filter((t) => literalsOf(fieldsOf(t).status ?? { kind: "string" }).length > 0);
    const decided = new Set([...Object.keys(PURGE_LIVE_STATES), ...Object.keys(PURGE_NOT_LIVE_STATUS)]);
    expect(sorted(withStatus.filter((t) => !decided.has(t)))).toEqual([]);
    expect(sorted([...decided].filter((t) => !withStatus.includes(t)))).toEqual([]);
  });

  test("every clearable field is a real link to sales on a kept row, guarded by a real state field", () => {
    for (const [table, rule] of Object.entries(PURGE_CLEARABLE_FIELDS)) {
      expect(["REFUSE_IF_REFERENCED", "KEEP"], table).toContain(PURGE_IMPACT_MAP[table]);
      expect(PURGE_ORG_INDEX[table], `${table} is scanned`).toBeDefined();
      expect(allReferences().some((r) => r.table === table && r.path === rule.field && r.target === "sales"), `${table}.${rule.field}`).toBe(true);
      const literals = literalsOf(fieldsOf(table)[rule.whenField]);
      for (const value of [...(rule.in ?? []), ...(rule.notIn ?? [])]) expect(literals, `${table}.${rule.whenField}=${value}`).toContain(value);
    }
  });

  test("the storage fields are exactly the storage references held by purgeable tables, top-level only", () => {
    const derived: Record<string, string[]> = {};
    for (const r of allReferences()) {
      if (r.target !== "_storage" || !PURGE_TARGET_CLASSES.has(PURGE_IMPACT_MAP[r.table])) continue;
      expect(r.path, `${r.table}.${r.path} must be a top-level field (teach storageRefs a nested path first)`).toMatch(/^[A-Za-z]+(\[\])?$/);
      (derived[r.table] ??= []).push(r.path.replace("[]", ""));
    }
    const mapped = Object.fromEntries(Object.entries(PURGE_STORAGE_FIELDS).map(([t, f]) => [t, sorted(f)]));
    // A union table reports the same field once per member: dedupe.
    expect(Object.fromEntries(Object.entries(derived).map(([t, f]) => [t, sorted(new Set(f))]))).toEqual(mapped);
  });
});
