import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { buildGraph, censusForward, censusReverse } from "./economicCommandCensus";

test("the census follows named value imports through re-export chains", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "census-export-"));
  try {
    const sources = {
      "entry.ts": [
        'import { hookForward as apply, hookInlineType, hookTypeOnly, hookCycle, hookComment } from "./facade";',
        "export const change = mutation({",
        "  handler: async (ctx) => apply(ctx),",
        "});",
        "export const ignored = mutation({",
        "  handler: async (ctx) => { hookInlineType(ctx); hookTypeOnly(ctx); hookCycle(ctx); hookComment(ctx); },",
        "});",
      ],
      "facade.ts": [
        'export { hookPosting as hookForward, type hookPosting as hookInlineType } from "./adapter";',
        'export type { hookSink as hookTypeOnly } from "./posting";',
        'export { hookCycle } from "./cycle";',
        '// export { hookSink as hookComment } from "./posting";',
      ],
      "adapter.ts": ['export { hookSink as hookPosting } from "./posting.js";'],
      "cycle.ts": ['export { hookCycle } from "./facade";'],
      "posting.ts": [
        "export async function hookSink(ctx) {",
        '  await ctx.db.insert("receivables", {});',
        "}",
      ],
    };
    for (const [file, lines] of Object.entries(sources)) {
      fs.writeFileSync(path.join(directory, file), lines.join("\n"));
    }
    const graph = buildGraph(directory);

    expect([...(graph.edges.get("entry.change") ?? [])]).toEqual(["posting.hookSink"]);
    expect(graph.edges.get("entry.ignored")).toEqual(new Set());
    expect([...censusForward(graph)]).toEqual(["entry.change"]);
    expect([...censusReverse(graph)]).toEqual(["entry.change"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
