// @vitest-environment node
import { expect, test } from "vitest";
import ts from "typescript";
import { internalMutationGeneric, queryGeneric } from "convex/server";
import { exportedDeclaration, financialEvidence, hasFinancialEffect, mutationBody, parseSource, publicMutationNames, rowCallsDoor } from "./pilotDoorAnalysis";
import { socialBulkMutation } from "../../convex/functions";

/** Real compiler with a small in-memory source tree, including cross-module symbol resolution. */
function fixture(files: Record<string, string>) {
  const options: ts.CompilerOptions = {
    noLib: true, types: [], target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = (file) => file in files;
  host.readFile = (file) => files[file];
  host.directoryExists = (dir) => dir === "/fixture" || dir === "/";
  host.getSourceFile = (file) => files[file] === undefined ? undefined :
    ts.createSourceFile(file, files[file], ts.ScriptTarget.Latest, true);
  const program = ts.createProgram(Object.keys(files), options, host);
  const source = program.getSourceFile("/fixture/entry.ts");
  if (!source) throw new Error("Missing fixture source");
  return { source, checker: program.getTypeChecker() };
}

test.each([
  ["acquisition posting", "await postVehicleAcquisitionIfOwned(ctx, {});", true],
  ["journal insert", 'await ctx.db.insert("journalLines", row);', true],
  ["money patch", "await ctx.db.patch(id, { amountMinor: 100 });", true],
  ["three-argument money patch", 'const id = "fc" as Id<"financeCompanies">; await ctx.db.patch("financeCompanies", id, { adminFees: 100 });', true],
  ["three-argument money replace", 'const id = "fc" as Id<"financeCompanies">; await ctx.db.replace("financeCompanies", id, { adminFees: 100 });', true],
  ["id-addressed ledger patch", 'const id = "entry" as Id<"journalEntries">; await ctx.db.patch(id, { status: "POSTED" });', true],
  ["id-addressed ledger delete", 'const id = "entry" as Id<"journalEntries">; await ctx.db.delete(id);', true],
  ["id-addressed money replace", 'const id = "fc" as Id<"financeCompanies">; await ctx.db.replace(id, { adminFees: 100 });', true],
  ["typed money insert", 'const row = { adminFees: 100 }; await ctx.db.insert("financeCompanies", row);', true],
  ["table-addressed ledger patch", 'await ctx.db.patch("journalEntries", id, { status: "POSTED" });', true],
  ["table-addressed ledger replace", 'await ctx.db.replace("journalEntries", id, { status: "POSTED" });', true],
  ["table-addressed ledger delete", 'await ctx.db.delete("journalEntries", id);', true],
  ["aliased union ledger id", 'type EntryId = Id<"journalEntries"> | Id<"users">; const id = "entry" as EntryId; await ctx.db.delete(id);', true],
  ["union table brand", 'const id = "entry" as Id<"journalEntries" | "users">; await ctx.db.delete(id);', true],
  ["non-ledger id delete", 'const id = "fc" as Id<"financeCompanies">; await ctx.db.delete(id);', false],
  ["non-ledger table delete", 'await ctx.db.delete("financeCompanies", id);', false],
  ["three-argument configuration patch", 'const id = "fc" as Id<"financeCompanies">; await ctx.db.patch("financeCompanies", id, { isActive: false });', false],
  ["unrelated library method", 'library.patch("financeCompanies", id, { amount: 100 });', false],
  ["read-only database call", 'await ctx.db.get("journalEntries", id);', false],
  ["opaque patch", "const patch: Record<string, unknown> = {}; await ctx.db.patch(id, patch);", true],
  ["timestamp and payment type", 'await ctx.db.patch(id, { dueAt: 100, paymentType: "CASH" });', false],
  ["comment and quoted call", '/* postVehicleAcquisitionIfOwned(ctx, {}) */ const label = "postFake()";', false],
  ["uncalled closure", "const unused = () => postVehicleAcquisitionIfOwned(ctx, {});", false],
])("financial analysis: %s", (_label, body, expected) => {
  const { source, checker } = fixture({
    "/fixture/entry.ts": `type Id<T extends string> = string & { __tableName: T };
      export const door = mutation({ handler: async (ctx) => { ${body} } });`,
  });
  expect(hasFinancialEffect(mutationBody(source), checker)).toBe(expected);
  expect(financialEvidence(mutationBody(source), checker) !== undefined).toBe(expected);
});

test.each([
  ['await ctx.db.patch("financeCompanies", id, { adminFees: 100 });', true],
  ['await ctx.db.patch(id, { isActive: false });', false],
  ['await ctx.db.delete("journalEntries", id);', true],
])("syntax-only money analysis: %s", (body, expected) => {
  const source = parseSource(`export const door = mutation({ handler: async (ctx) => { ${body} } });`);
  expect(hasFinancialEffect(mutationBody(source))).toBe(expected);
});

test.each(["collectionPayments", "cashMovements", "bankTransactions", "deposits", "payrollRuns", "expenses", "transactions", "receivables"])(
  "an opaque write to %s cannot be classed NON_FINANCIAL", (table) => {
    const { source, checker } = fixture({
      "/fixture/entry.ts": `export const door = mutation({ handler: async (ctx) => {
        await ctx.db.insert("${table}", opaqueRow);
      } });`,
    });
    expect(hasFinancialEffect(mutationBody(source), checker)).toBe(true);
  },
);

test("financial helper discovery follows imported aliases, local aliases and cycles", () => {
  const { source, checker } = fixture({
    "/fixture/entry.ts": `import { writeAcquisition as renamed } from "./helper";
      const localAlias = renamed;
      export const door = mutation({ handler: async (ctx) => localAlias(ctx) });`,
    "/fixture/helper.ts": `export function writeAcquisition(ctx) { recur(ctx); }
      function recur(ctx) { writeAcquisition(ctx); ctx.db.patch(id, { purchasePrice: 100 }); }`,
  });
  expect(hasFinancialEffect(mutationBody(source), checker)).toBe(true);
});

test("census resolves a re-exported handler and reports its money-write location", () => {
  const { source, checker } = fixture({
    "/fixture/entry.ts": 'export { original as door } from "./helper";',
    "/fixture/helper.ts": `export const original = mutation({ handler: async (ctx) => {
      await ctx.db.patch("financeCompanies", "fc", { adminFees: 100 });
    } });`,
  });
  const declaration = exportedDeclaration(source, "door", checker);
  expect(financialEvidence(mutationBody(declaration), checker)).toBe("helper.ts:2 patch");
  expect(() => exportedDeclaration(source, "missing", checker)).toThrow("Cannot resolve registered export entry.ts.missing");
});

test("registered census accepts the real wrapper builder and rejects queries and internal mutations", () => {
  const handler = () => null;
  expect(publicMutationNames({
    wrapped: socialBulkMutation({ args: {}, handler }),
    query: queryGeneric({ args: {}, handler }),
    internal: internalMutationGeneric({ args: {}, handler }),
    ordinary: handler,
  })).toEqual(["wrapped"]);
});

test("a test.each citation reaches imported helpers but cannot borrow another row or an uncalled closure", () => {
  const { source, checker } = fixture({
    "/fixture/entry.ts": `import { exercise as shared } from "./helper";
      test.each([1, 2])("cited %s", async () => {
        const unused = () => t.mutation(api.sales.create, {});
        await shared();
      });
      test("other", async () => { await t.mutation(api.sales.create, {}); });`,
    "/fixture/helper.ts": `export async function exercise() { await nested(); }
      async function nested() { await t.mutation(api.vehicles.create, {}); }`,
  });
  expect(rowCallsDoor(source, "vehicles.create", "cited %s", checker)).toBe(true);
  expect(rowCallsDoor(source, "sales.create", "cited %s", checker)).toBe(false);
  expect(rowCallsDoor(source, "vehicles.create", "missing row", checker)).toBe(false);
});

test("ambiguous duplicate titles and skipped rows cannot provide certification evidence", () => {
  const { source, checker } = fixture({
    "/fixture/entry.ts": `test("duplicate", () => t.mutation(api.vehicles.create, {}));
      test("duplicate", () => {});
      test.skip("skipped", () => t.mutation(api.vehicles.create, {}));`,
  });
  expect(rowCallsDoor(source, "vehicles.create", "duplicate", checker)).toBe(false);
  expect(rowCallsDoor(source, "vehicles.create", "skipped", checker)).toBe(false);
});
