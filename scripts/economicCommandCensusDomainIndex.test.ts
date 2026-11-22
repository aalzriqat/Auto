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

test("discovers an economic command through an aliased domain index export", () => {
  fixture = mkdtempSync(join(tmpdir(), "economic-domain-index-"));
  mkdirSync(join(fixture, "domains", "deal"), { recursive: true });
  writeFileSync(join(fixture, "applications.ts"), [
    'import { recordReceipt as record } from "./domains/deal";',
    "export const confirm = mutation({",
    "  handler: async (ctx, args) => record(ctx, args),",
    "});",
  ].join("\n"));
  writeFileSync(join(fixture, "domains", "deal", "index.ts"),
    'export { persistReceipt as recordReceipt } from "./receipt";',
  );
  writeFileSync(join(fixture, "domains", "deal", "receipt.ts"), [
    "export function persistReceipt(ctx, args) {",
    '  return ctx.db.insert("canonicalPayments", args);',
    "}",
  ].join("\n"));

  const graph = buildGraph(fixture);
  expect(censusForward(graph)).toEqual(new Set(["applications.confirm"]));
  expect(censusReverse(graph)).toEqual(new Set(["applications.confirm"]));
});
