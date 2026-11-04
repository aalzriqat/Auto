// @vitest-environment node
import { expect, test } from "vitest";
import ts from "typescript";
import { internalMutationGeneric, queryGeneric } from "convex/server";
import { hasFinancialEffect, mutationBody, publicMutationNames, rowCallsDoor } from "./pilotDoorAnalysis";
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
  ["opaque patch", "const patch: Record<string, unknown> = {}; await ctx.db.patch(id, patch);", true],
  ["timestamp and payment type", 'await ctx.db.patch(id, { dueAt: 100, paymentType: "CASH" });', false],
  ["comment and quoted call", '/* postVehicleAcquisitionIfOwned(ctx, {}) */ const label = "postFake()";', false],
  ["uncalled closure", "const unused = () => postVehicleAcquisitionIfOwned(ctx, {});", false],
])("financial analysis: %s", (_label, body, expected) => {
  const { source, checker } = fixture({
    "/fixture/entry.ts": `export const door = mutation({ handler: async (ctx) => { ${body} } });`,
  });
  expect(hasFinancialEffect(mutationBody(source), checker)).toBe(expected);
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
