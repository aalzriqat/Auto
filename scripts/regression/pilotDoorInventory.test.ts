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
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

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

/** Every `export const X = mutation(` under convex/, with the handler body text. */
function liveDoors(): Map<string, string> {
  const doors = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "_generated" && e.name !== "node_modules") walk(p);
        continue;
      }
      if (!p.endsWith(".ts") || p.includes(".test.")) continue;
      const src = fs.readFileSync(p, "utf8");
      const mod = path.relative(path.join(REPO_ROOT, "convex"), p).replace(/\\/g, "/").replace(/\.ts$/, "");
      const heads = [...src.matchAll(/^export const (\w+) = mutation\(/gm)];
      heads.forEach((h, k) => {
        const start = h.index ?? 0;
        const rest = src.slice(start + 10);
        const next = rest.search(/^export (const|function|async function) \w+/m);
        const end = next > 0 ? start + 10 + next : src.length;
        doors.set(`${mod}.${h[1]}`, src.slice(start, k + 1 < heads.length ? Math.min(end, heads[k + 1].index ?? end) : end));
      });
    }
  };
  walk(path.join(REPO_ROOT, "convex"));
  return doors;
}

const entries: Entry[] = JSON.parse(read(INVENTORY));
const live = liveDoors();
const callsDoor = (testSrc: string, door: string): boolean => {
  const [mod, fn] = [door.slice(0, door.indexOf(".")), door.slice(door.indexOf(".") + 1)];
  return new RegExp(`api\\.${mod.replace(/\//g, "\\.")}\\.${fn}\\b`).test(testSrc);
};

describe("SCRUM-795 per-door inventory", () => {
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
    const problems: string[] = [];
    for (const e of entries) {
      if (e.class === "EXCLUDED_GUARDED" && !(e.blocks?.length ?? 0)) problems.push(`${e.door}: no block`);
      if (e.class === "ENABLED_CERTIFIED" && !(e.certification?.test && (e.certification.row || e.certification.oracleSection))) {
        problems.push(`${e.door}: no certification test and row`);
      }
      if (e.class === "UNCLASSIFIED") {
        if ((e.effect ?? "").length < 10) problems.push(`${e.door}: no one-line money effect`);
        if (e.ruling !== "owner ruling needed") problems.push(`${e.door}: ruling field`);
      }
      if (e.class === "NON_FINANCIAL" && (e.reason ?? "").length < 8) problems.push(`${e.door}: no reason`);
    }
    expect(problems).toEqual([]);
  });

  test("every block cites a guard that exists and a test that names the door, the code and the guard file", () => {
    const problems: string[] = [];
    for (const e of entries) {
      for (const b of e.blocks ?? []) {
        if (!exists(b.guardFile)) problems.push(`${e.door}: missing guard file ${b.guardFile}`);
        else if (!read(b.guardFile).includes(b.guard)) problems.push(`${e.door}: ${b.guard} not in ${b.guardFile}`);
        if (!exists(b.test)) {
          problems.push(`${e.door}: missing test ${b.test}`);
          continue;
        }
        const testSrc = read(b.test);
        if (!callsDoor(testSrc, e.door)) problems.push(`${e.door}: not called in ${b.test}`);
        if (/^[A-Z][A-Z0-9_]{5,}$/.test(b.code) && !testSrc.includes(b.code)) problems.push(`${e.door}: ${b.code} not in ${b.test}`);
      }
    }
    expect(problems).toEqual([]);
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
      const src = read(c.test);
      if (!callsDoor(src, e.door)) problems.push(`${e.door}: not called in ${c.test}`);
      if (c.row && !src.includes(c.row)) problems.push(`${e.door}: row title not in ${c.test}`);
      if (c.oracleSection && !oracle.includes(`## ${c.oracleSection}`)) problems.push(`${e.door}: oracle section ${c.oracleSection}`);
    }
    expect(problems).toEqual([]);
  });

  test("a door classed non-financial writes no ledger, cash or subledger table and calls no posting helper", () => {
    const FINANCIAL = /postAccountingEvent|postOrEnqueue|enqueueAccountingEvent|post[A-Z]\w*Occurrence|"journalEntries"|"journalLines"|"collectionPayments"|"cashMovements"|"bankTransactions"|"deposits"|"payrollRuns"|"expenses"|"transactions"|"receivables"/;
    const touching = entries.filter((x) => x.class === "NON_FINANCIAL" && FINANCIAL.test(live.get(x.door) ?? "")).map((x) => x.door);
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
