/**
 * SCRUM-868 S1 structural guards for the supplier master.
 *
 * What these prove, and what they do not:
 *  - Every write to `suppliers` and `supplierAliases` sits inside a function that was handed a
 *    `RegistryLock`, which only `withRegistryLock` can mint. The registry document's
 *    version is then read and bumped by every supplier write (test 6).
 *  - Nothing deletes a supplier (I1), nothing outside the supplier modules reads or writes the
 *    new tables, and the supplier modules use no `filter` and no unbounded `collect` (Convex
 *    guidelines).
 *  - The master carries identity only (I12): no money field.
 *  - The three tables are registered with the organization purge and kept out of the financial
 *    reset.
 *
 * It does NOT prove concurrent writers conflict. `convex-test` serializes everything, so that
 * is argued from the documented OCC read set
 * (https://docs.convex.dev/database/advanced/occ) and is not demonstrated here.
 *
 * The scanner is itself tested against synthetic bad sources, so "no violations found" cannot
 * mean "the scanner looks at nothing".
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import schema from "../convex/schema";
import { ORGANIZATION_DELETION_STEPS } from "../convex/adminOrgs";
import { CHILD_TABLES_FOR_TEST, RESET_TABLES_FOR_TEST } from "../convex/orgFinancialReset";

const ROOT = path.resolve(__dirname, "..");
const SUPPLIER_TABLES = ["suppliers", "supplierAliases"] as const;
const REGISTRY_TABLE = "supplierRegistryState";
const ALL_TABLES: readonly string[] = [...SUPPLIER_TABLES, REGISTRY_TABLE];
const SUPPLIER_MODULES = new Set(["convex/suppliers.ts", "convex/utils/supplierRegistry.ts"]);
const LOCK_MODULE = "convex/utils/supplierRegistry.ts";
const WRITE_METHODS = new Set(["insert", "patch", "replace"]);
/** Per-test timeout for the whole-tree scan; see the comment on the lock-coverage test. */
const SCAN_TIMEOUT_MS = 60_000;

interface Violation {
  rule: string;
  line: number;
  text: string;
}
interface Scan {
  violations: Violation[];
  supplierWrites: number;
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function chainHasQuery(expression: ts.Expression): boolean {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "query") return true;
        current = callee.expression;
        continue;
      }
      return false;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    return false;
  }
}

function holdsRegistryLock(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      const hasLockParameter = current.parameters.some(
        (parameter) => parameter.type !== undefined && parameter.type.getText() === "RegistryLock",
      );
      if (hasLockParameter) return true;
    }
  }
  return false;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer !== undefined &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return current.name.text;
    }
  }
  return undefined;
}

function scanSource(relPath: string, text: string): Scan {
  const sourceFile = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const inSupplierModule = SUPPLIER_MODULES.has(relPath);
  const violations: Violation[] = [];
  let supplierWrites = 0;
  const flag = (rule: string, node: ts.Node): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ rule, line: line + 1, text: node.getText(sourceFile).slice(0, 80) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (node.type.getText(sourceFile) === "RegistryLock") {
        const minter = enclosingFunctionName(node);
        if (relPath !== LOCK_MODULE || minter !== "withRegistryLock") flag("forged-lock", node);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const table = stringLiteralValue(node.arguments[0]);
      const touchesNewTable = table !== undefined && ALL_TABLES.includes(table);
      const isSupplierTable = table !== undefined && (SUPPLIER_TABLES as readonly string[]).includes(table);

      if (method === "delete" && (touchesNewTable || inSupplierModule)) flag("delete", node);
      if (!inSupplierModule && touchesNewTable && ["insert", "patch", "replace", "query", "get"].includes(method)) {
        flag("foreign-access", node);
      }
      if (inSupplierModule && WRITE_METHODS.has(method)) {
        if (table === undefined) flag("untabled-write", node);
        if (table === REGISTRY_TABLE && relPath !== LOCK_MODULE) flag("registry-write-outside-lock-module", node);
      }
      if (isSupplierTable && WRITE_METHODS.has(method)) {
        supplierWrites += 1;
        if (!holdsRegistryLock(node)) flag("unlocked-write", node);
      }
      if (inSupplierModule && (method === "filter" || method === "collect") && chainHasQuery(node.expression.expression)) {
        flag(method === "filter" ? "filter" : "unbounded-collect", node);
      }
      // A sort with no compare function orders by UTF-16 code unit only by accident of the default
      // (Sonar typescript:S2871). The supplier modules say so with `codeUnitCompare`.
      if (inSupplierModule && method === "sort" && node.arguments.length === 0) flag("bare-sort", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { violations, supplierWrites };
}

function listConvexSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_generated" || entry.name === "node_modules") continue;
      listConvexSources(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const REAL_SOURCES = listConvexSources(path.join(ROOT, "convex")).map((file) => ({
  relPath: path.relative(ROOT, file).split(path.sep).join("/"),
  text: readFileSync(file, "utf8"),
}));

const BAD_SNIPPETS: Array<{ rule: string; file: string; source: string }> = [
  {
    rule: "unlocked-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.patch("suppliers", id, { status: "INACTIVE" }); }`,
  },
  {
    rule: "unlocked-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.insert("supplierAliases", {}); }`,
  },
  {
    rule: "unlocked-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: unknown) { await ctx.db.insert("suppliers", {}); }`,
  },
  {
    rule: "untabled-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: RegistryLock) { await ctx.db.patch(id, { status: "INACTIVE" }); }`,
  },
  {
    rule: "delete",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: RegistryLock) { await ctx.db.delete("suppliers", id); }`,
  },
  {
    rule: "delete",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: RegistryLock) { await ctx.db.delete(id); }`,
  },
  {
    rule: "delete",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.delete("suppliers", id); }`,
  },
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: QueryCtx) { return ctx.db.query("suppliers").take(1); }`,
  },
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.insert("supplierRegistryState", {}); }`,
  },
  {
    rule: "registry-write-outside-lock-module",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.patch("supplierRegistryState", id, { version: 1 }); }`,
  },
  {
    rule: "filter",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: QueryCtx) { return ctx.db.query("suppliers").filter((q) => q.eq(q.field("status"), "ACTIVE")).take(5); }`,
  },
  {
    rule: "unbounded-collect",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: QueryCtx) { return ctx.db.query("suppliers").withIndex("by_org_and_status", (q) => q.eq("orgId", o)).collect(); }`,
  },
  {
    rule: "bare-sort",
    file: "convex/suppliers.ts",
    source: `export function f(ids: string[]) { return [...ids].sort(); }`,
  },
  {
    rule: "bare-sort",
    file: "convex/utils/supplierRegistry.ts",
    source: `export function f(ids: Set<string>) { return [...ids].sort(); }`,
  },
  {
    rule: "forged-lock",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx) { const lock = {} as RegistryLock; return lock; }`,
  },
  {
    rule: "forged-lock",
    file: "convex/utils/supplierRegistry.ts",
    source: `export async function notTheLock(ctx: MutationCtx) { return {} as RegistryLock; }`,
  },
];

const GOOD_SNIPPETS: Array<{ file: string; source: string }> = [
  {
    file: "convex/suppliers.ts",
    source: `
      async function insertSupplier(ctx: MutationCtx, lock: RegistryLock) { return ctx.db.insert("suppliers", {}); }
      export async function g(ctx: MutationCtx, lock: RegistryLock, ids: Id<"supplierAliases">[]) {
        await Promise.all(ids.map(async (id) => ctx.db.patch("supplierAliases", id, { status: "RETIRED" })));
        return [1, 2].filter((n) => n > 1);
      }`,
  },
  {
    file: "convex/utils/supplierRegistry.ts",
    source: `
      export async function withRegistryLock<T>(ctx: MutationCtx, fn: (lock: RegistryLock) => Promise<T>) {
        const lock = { __brand: "RegistryLock" } as RegistryLock;
        await ctx.db.patch("supplierRegistryState", id, { version: 1 });
        return fn(lock);
      }`,
  },
  { file: "convex/other.ts", source: `export const x = (ctx: QueryCtx) => ctx.db.query("vehicles").take(1);` },
  { file: "convex/suppliers.ts", source: `export const s = (ids: string[]) => [...ids].sort(codeUnitCompare);` },
  { file: "convex/other.ts", source: `export const s = (ids: string[]) => [...ids].sort();` },
];

describe("supplier master source guards", () => {
  test("lock coverage: the scanner rejects every synthetic bad source and accepts the good ones", () => {
    for (const bad of BAD_SNIPPETS) {
      const rules = scanSource(bad.file, bad.source).violations.map((v) => v.rule);
      expect(rules, `${bad.rule} in ${bad.file}: ${bad.source}`).toContain(bad.rule);
    }
    for (const good of GOOD_SNIPPETS) {
      expect(scanSource(good.file, good.source).violations, good.source).toEqual([]);
    }
  });

  test("lock coverage: no insert, patch or replace on suppliers or supplierAliases happens outside a function holding a RegistryLock, and nothing deletes either table", () => {
    let supplierWrites = 0;
    const problems: string[] = [];
    for (const source of REAL_SOURCES) {
      const scan = scanSource(source.relPath, source.text);
      supplierWrites += scan.supplierWrites;
      for (const v of scan.violations) problems.push(`${source.relPath}:${v.line} ${v.rule} ${v.text}`);
    }
    // The scan must have looked at the real writers: insert and patch on both tables.
    expect(supplierWrites).toBeGreaterThanOrEqual(4);
    expect(problems).toEqual([]);
    // This test parses every non-test source under convex/ into a full AST. That takes about 1.4 s
    // alone, but CI runs it in a coverage batch with v8 instrumentation and several workers, where
    // it overran vitest's default 5 s test timeout (SCRUM-868, run 40525208382: "Test timed out in
    // 5000ms", passing in 1.4 s on the non-coverage rerun). The scan is unchanged; the timeout is
    // explicit, as in the sibling AST guards (organizationReactivationGuard, orgFinancialResetReferenceCoverage).
  }, SCAN_TIMEOUT_MS);

  test("the supplier modules exist and are the only sources that name the new tables in a database call", () => {
    for (const relPath of SUPPLIER_MODULES) expect(REAL_SOURCES.some((s) => s.relPath === relPath), relPath).toBe(true);
  });
});

describe("supplier master schema", () => {
  function fieldsOf(table: string): string[] {
    const definition = (schema.tables as unknown as Record<string, { validator: { fields: Record<string, unknown> } }>)[table];
    expect(definition, `${table} is defined`).toBeDefined();
    return Object.keys(definition.validator.fields).sort();
  }

  test("the master holds identity only: the field list is exact and no field is money (I12)", () => {
    expect(fieldsOf("suppliers")).toEqual(
      [
        "orgId", "displayName", "displayNameKey", "legalName", "status", "contact", "taxId", "taxIdKey", "taxJurisdiction",
        "sharedLegalIdentityOf", "sharedLegalIdentityReason", "version", "origin", "createdBy", "createdAt", "updatedBy",
        "updatedAt", "deactivatedBy", "deactivatedAt", "deactivatedReason",
      ].sort(),
    );
    expect(fieldsOf("supplierAliases")).toEqual(
      ["orgId", "supplierId", "alias", "aliasKey", "source", "status", "createdBy", "createdAt"].sort(),
    );
    expect(fieldsOf("supplierRegistryState")).toEqual(["orgId", "version"].sort());
    const money = /amount|balance|currency|price|cost|paid|due|credit|debit|total|fee|commission|payable|receivable|ledger|journal/i;
    for (const table of ALL_TABLES) {
      expect(fieldsOf(table).filter((field) => money.test(field)), table).toEqual([]);
    }
  });
});

describe("supplier master purge and reset registration", () => {
  function mentions(list: unknown, table: string): boolean {
    return JSON.stringify(list).includes(`"${table}"`);
  }

  test("all three tables are deleted with the organization, children before parents", () => {
    const steps = ORGANIZATION_DELETION_STEPS as unknown as Array<{ kind: string; table?: string; index?: string }>;
    const positions = new Map<string, number>();
    for (const table of ALL_TABLES) {
      const hits = steps.map((step, i) => ({ step, i })).filter(({ step }) => step.table === table);
      expect(hits, table).toHaveLength(1);
      expect(hits[0].step.kind, table).toBe("orgRows");
      expect(hits[0].step.index, table).toMatch(/^by_org/);
      positions.set(table, hits[0].i);
    }
    expect(positions.get("supplierAliases")!).toBeLessThan(positions.get("suppliers")!);
    expect(positions.get("suppliers")!).toBeLessThan(positions.get(REGISTRY_TABLE)!);
  });

  test("master data and the registry are retained across a financial reset", () => {
    for (const table of ALL_TABLES) {
      expect(mentions(RESET_TABLES_FOR_TEST, table), `${table} must not be reset`).toBe(false);
      expect(mentions(CHILD_TABLES_FOR_TEST, table), `${table} must not be a reset child table`).toBe(false);
    }
  });
});
