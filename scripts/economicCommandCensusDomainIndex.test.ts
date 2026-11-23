import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, censusForward, censusReverse } from "./economicCommandCensus";

let fixture: string | undefined;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

const directExport = 'export { persistReceipt as recordReceipt } from "./receipt";';

test.each([
  ["direct re-export", directExport, "export ", "./domains/deal", true],
  ["root directory index", directExport, "export ", "./", true],
  ["local export of imported binding", 'export { imported as recordReceipt };\nimport { persistReceipt as imported } from "./receipt";', "export ", "./domains/deal", true],
  ["private declaration", directExport, "", "./domains/deal", false],
  ["type-only local export", 'import { persistReceipt as imported } from "./receipt";\nexport type { imported as recordReceipt };', "export ", "./domains/deal", false],
])("counts only value exports through a directory index: %s", (_case, barrel, exportPrefix, modulePath, reachable) => {
  fixture = mkdtempSync(join(tmpdir(), "economic-domain-index-"));
  const barrelDirectory = join(fixture, modulePath);
  mkdirSync(barrelDirectory, { recursive: true });
  writeFileSync(join(fixture, "applications.ts"), [
    `import { recordReceipt as record } from "${modulePath}";`,
    "export const confirm = mutation({",
    "  handler: async (ctx, args) => record(ctx, args),",
    "});",
  ].join("\n"));
  writeFileSync(join(barrelDirectory, "index.ts"), barrel);
  writeFileSync(join(barrelDirectory, "receipt.ts"), [
    `${exportPrefix}function persistReceipt(ctx, args) {`,
    '  return ctx.db.insert("canonicalPayments", args);',
    "}",
  ].join("\n"));

  const graph = buildGraph(fixture);
  const expected = new Set(reachable ? ["applications.confirm"] : []);
  expect(censusForward(graph)).toEqual(expected);
  expect(censusReverse(graph)).toEqual(expected);
});
