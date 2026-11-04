// @vitest-environment node
/**
 * SCRUM-795 / SCRUM-760 decision B: the per-door inventory in
 * docs/pilot/blocked-server-side-doors.inventory.json must list every public
 * Convex mutation exactly once, and each entry must point at things that exist.
 *
 * This test proves the inventory is complete and its citations resolve. It does
 * not prove that a guard runs before any read, or that a refusal test fails when
 * its guard is removed. Those come from reading the cited lines and from the
 * mutant runs recorded in the doc.
 */
import { beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  exportedDeclaration, financialEvidence, hasFinancialEffect, mutationBody, parseSource,
  publicMutationNames, rowCallsDoor, sourceAnalysis,
} from "./pilotDoorAnalysis";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const INVENTORY = "docs/pilot/blocked-server-side-doors.inventory.json";
const DOC = "docs/pilot/blocked-server-side-doors.md";
const ORACLE = "docs/architecture/scrum486-certification-oracle.md";

interface Block {
  guardFile: string;
  guard: string;
  code: string;
  test: string;
}
interface Entry {
  door: string;
  class: "EXCLUDED_GUARDED" | "ENABLED_CERTIFIED" | "UNCLASSIFIED" | "NON_FINANCIAL";
  blocks?: Block[];
  certification?: { test: string; row?: string; oracleSection?: string };
  effect?: string;
  ruling?: string;
  reason?: string;
  note?: string;
}

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(REPO_ROOT, rel));

const entries: Entry[] = JSON.parse(read(INVENTORY));
const modules = import.meta.glob<Record<string, unknown>>([
  "../../convex/**/*.ts", "!../../convex/**/*.test.ts", "!../../convex/**/*.d.ts",
  "!../../convex/_generated/**", "!../../convex/auth.config.ts", "!../../convex/convex.config.ts",
]);
const moduleFile = (file: string): string => path.resolve(__dirname, file);
const analysis = sourceAnalysis([
  ...Object.keys(modules).map(moduleFile),
  ...new Set(entries.flatMap((e) => e.certification ? [path.join(REPO_ROOT, e.certification.test)] : [])),
]);
const live = new Map<string, ts.Node>();
const citedRows = new Map<string, boolean>();
const nonFinancialEffects = new Map<string, string | undefined>();
beforeAll(async () => {
  for (const [file, load] of Object.entries(modules)) {
    const exports = await load(); // Import failures fail the census, never silently omit a module.
    const source = analysis.program.getSourceFile(moduleFile(file));
    if (!source) throw new Error(`Missing source for ${file}`);
    const mod = file.replace("../../convex/", "").replace(/\.ts$/, "");
    for (const name of publicMutationNames(exports)) {
      live.set(`${mod}.${name}`, mutationBody(exportedDeclaration(source, name, analysis.checker)));
    }
  }
  // Compiler initialization and graph traversal belong to setup; assertions remain bounded and synchronous.
  for (const entry of entries) {
    if (entry.certification) {
      const c = entry.certification;
      const source = analysis.program.getSourceFile(path.join(REPO_ROOT, c.test));
      citedRows.set(entry.door, !!source && !!c.row && rowCallsDoor(source, entry.door, c.row, analysis.checker));
    }
    if (entry.class === "NON_FINANCIAL") {
      const body = live.get(entry.door);
      if (!body) throw new Error(`Missing registered mutation ${entry.door}`);
      nonFinancialEffects.set(entry.door, financialEvidence(body, analysis.checker));
    }
  }
}, 60_000);
const callsDoor = (testSrc: string, door: string): boolean => {
  const [mod, fn] = [door.slice(0, door.indexOf(".")), door.slice(door.indexOf(".") + 1)];
  return new RegExp(`api\\.${mod.replace(/\//g, "\\.")}\\.${fn}\\b`).test(testSrc);
};
const isFinancial = (src: string): boolean => hasFinancialEffect(mutationBody(parseSource(src)));
const certificationCallsDoor = (src: string, door: string, row: string): boolean => rowCallsDoor(parseSource(src), door, row);

function unclassifiedEvidenceProblems(entry: Entry): string[] {
  const problems: string[] = [];
  if ((entry.effect ?? "").length < 10) problems.push(`${entry.door}: no one-line money effect`);
  if (entry.ruling !== "owner ruling needed") problems.push(`${entry.door}: ruling field`);
  return problems;
}

function classEvidenceProblems(entry: Entry): string[] {
  switch (entry.class) {
    case "EXCLUDED_GUARDED":
      return (entry.blocks?.length ?? 0) > 0 ? [] : [`${entry.door}: no block`];
    case "ENABLED_CERTIFIED":
      if (!entry.certification?.test || !entry.certification.row) return [`${entry.door}: no certification test and row`];
      return [];
    case "NON_FINANCIAL":
      return (entry.reason ?? "").length >= 8 ? [] : [`${entry.door}: no reason`];
    case "UNCLASSIFIED":
      return unclassifiedEvidenceProblems(entry);
  }
}

function blockEvidenceProblems(door: string, block: Block): string[] {
  const problems: string[] = [];
  if (!exists(block.guardFile)) problems.push(`${door}: missing guard file ${block.guardFile}`);
  else if (!read(block.guardFile).includes(block.guard)) problems.push(`${door}: ${block.guard} not in ${block.guardFile}`);
  if (!exists(block.test)) return [...problems, `${door}: missing test ${block.test}`];
  const testSrc = read(block.test);
  if (!callsDoor(testSrc, door)) problems.push(`${door}: not called in ${block.test}`);
  if (/^[A-Z][A-Z0-9_]{5,}$/.test(block.code) && !testSrc.includes(block.code)) problems.push(`${door}: ${block.code} not in ${block.test}`);
  return problems;
}

describe("SCRUM-795 per-door inventory", () => {
  test.each([
    ["collections.registerCheque", "UNCLASSIFIED"],
    ["collections.clearCheque", "UNCLASSIFIED"],
    ["bankAccounts.setReconciliationTarget", "NON_FINANCIAL"],
  ])("fixture-only citation for %s cannot certify the door", (door, expectedClass) => {
    expect(entries.find((entry) => entry.door === door)).toMatchObject({ class: expectedClass });
  });

  test("F1 negative control: acquisition posting cannot be NON_FINANCIAL", () => {
    expect(isFinancial("export const resolve = mutation({ handler: async (ctx) => { await postVehicleAcquisitionIfOwned(ctx, {}); } });")).toBe(true);
  });

  test("F2 negative control: a public mutation built through a wrapper is counted", () => {
    expect(live.has("socialInbox.setConversationVehicle")).toBe(true);
  });

  test("F3 negative control: a different row calling a door does not certify this row", () => {
    const src = `test("unrelated", async () => {});
      test("actual caller", async () => { await t.mutation(api.vehicles.create, {}); });`;
    expect(certificationCallsDoor(src, "vehicles.create", "unrelated")).toBe(false);
  });

  test("lists every public mutation exactly once, with nothing extra", () => {
    const names = entries.map((e) => e.door);
    expect(names.length, "duplicate door entries").toBe(new Set(names).size);
    const listed = new Set(names);
    const missing = [...live.keys()].filter((d) => !listed.has(d)).sort();
    const stale = names.filter((d) => !live.has(d)).sort();
    expect(missing, "public mutations missing from the inventory").toEqual([]);
    expect(stale, "inventory entries that are not public mutations").toEqual([]);
    expect(live.size).toBeGreaterThan(300);
  });

  test("every entry carries what its class requires", () => {
    expect(entries.flatMap(classEvidenceProblems)).toEqual([]);
  });

  test("every block cites a guard that exists and a test that names the door, the code and the guard file", () => {
    expect(entries.flatMap((entry) => (entry.blocks ?? []).flatMap((block) => blockEvidenceProblems(entry.door, block))))
      .toEqual([]);
  });

  test("every certified door is called in its certification test and its row exists", () => {
    const oracle = read(ORACLE);
    const problems: string[] = [];
    for (const e of entries.filter((x) => x.class === "ENABLED_CERTIFIED")) {
      const c = e.certification;
      if (!c || !exists(c.test)) {
        problems.push(`${e.door}: missing certification test`);
        continue;
      }
      if (!citedRows.get(e.door)) problems.push(`${e.door}: not called by cited row ${c.row ?? "(missing)"} in ${c.test}`);
      if (!c.row) problems.push(`${e.door}: no specific test row`);
      if (c.oracleSection && !oracle.includes(`## ${c.oracleSection}`)) problems.push(`${e.door}: oracle section ${c.oracleSection}`);
    }
    expect(problems).toEqual([]);
  });

  test("every row of the oracle's blocked-doors section is bound to a test title that exists and calls the door", () => {
    const oracle = read(ORACLE);
    const start = oracle.indexOf("## SCRUM-760-DECISION-B-BLOCKED-DOORS");
    expect(start, "oracle section missing").toBeGreaterThanOrEqual(0);
    const rest = oracle.slice(start + 3);
    const end = rest.indexOf("\n## ");
    const section = end < 0 ? rest : rest.slice(0, end);
    const rows = [...section.matchAll(/^\| `([\w./]+?)`[^|]*\| `(\w+)` \| `([^`]+)` \|$/gm)];
    expect(rows.length, "rows in the section").toBe(7);
    const file = "convex/pilotBlockedDoors.scrum795.test.ts";
    const src = read(file);
    const problems: string[] = [];
    for (const [, door, code, title] of rows) {
      if (!src.includes(`test("${title}"`)) problems.push(`${door}: no test titled "${title}"`);
      if (!src.includes(code)) problems.push(`${door}: ${code} not in ${file}`);
      if (!callsDoor(src, door)) problems.push(`${door}: not called in ${file}`);
      if (!entries.some((e) => e.door === door && e.blocks?.some((b) => b.code === code))) problems.push(`${door}: inventory has no block with ${code}`);
    }
    expect(problems).toEqual([]);
  });

  test("a door classed non-financial writes no ledger, cash or subledger table and calls no posting helper", () => {
    const touching = [...nonFinancialEffects].filter(([, evidence]) => evidence !== undefined)
      .map(([door, evidence]) => `${door}: ${evidence}`);
    expect(touching).toEqual([]);
  });

  test("the doc states the same counts the inventory computes", () => {
    const doc = read(DOC);
    const by = (c: Entry["class"]): number => entries.filter((e) => e.class === c).length;
    expect(doc).toContain(`${entries.length} public mutations`);
    expect(doc).toContain(`EXCLUDED_GUARDED ${by("EXCLUDED_GUARDED")}`);
    expect(doc).toContain(`ENABLED_CERTIFIED ${by("ENABLED_CERTIFIED")}`);
    expect(doc).toContain(`UNCLASSIFIED ${by("UNCLASSIFIED")}`);
    expect(doc).toContain(`NON_FINANCIAL ${by("NON_FINANCIAL")}`);
  });
});
