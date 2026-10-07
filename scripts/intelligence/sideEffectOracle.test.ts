import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_EXPECTATIONS, UNMODELLED_TYPES } from "./sideEffectExpectations";
import { fingerprintEffect, judgeEffects, recipients, type Member } from "./sideEffectOracle";

const members: Member[] = [
  { userId: "owner", isManager: true },
  { userId: "mgr", isManager: true },
  { userId: "sales", isManager: false },
];
const assignedToSales = [{ type: "lead.assigned", audience: { kind: "user", userId: "sales" } } as const];

describe("sideEffectOracle", () => {
  it("passes when each expected notification arrives exactly once", () => {
    const f = judgeEffects(
      [{ type: "lead.created", audience: { kind: "managers", excludeActor: false } }],
      [{ userId: "owner", type: "lead.created" }, { userId: "mgr", type: "lead.created" }],
      members,
      "owner",
    );
    expect(f).toEqual([]);
  });

  it("flags a missing notification", () => {
    expect(judgeEffects([...assignedToSales], [], members, "owner")).toEqual([
      { kind: "missing", type: "lead.assigned", userId: "sales" },
    ]);
  });

  it("flags a duplicate", () => {
    const f = judgeEffects([...assignedToSales], [{ userId: "sales", type: "lead.assigned" }, { userId: "sales", type: "lead.assigned" }], members, "owner");
    expect(f).toEqual([{ kind: "duplicate", type: "lead.assigned", userId: "sales", count: 2 }]);
  });

  it("flags the wrong recipient as unexpected, e.g. the old owner", () => {
    const f = judgeEffects([...assignedToSales], [{ userId: "sales", type: "lead.assigned" }, { userId: "mgr", type: "lead.assigned" }], members, "owner");
    expect(f).toEqual([{ kind: "unexpected", type: "lead.assigned", userId: "mgr" }]);
  });

  it("does not judge notification types the action is not allowed to speak about", () => {
    expect(judgeEffects([], [{ userId: "mgr", type: "task.due" }], members, "owner", ["lead.created"])).toEqual([]);
  });

  it("an action that must notify nobody fails if anything of a spoken-about type arrives", () => {
    const f = judgeEffects([{ type: "lead.updated", audience: { kind: "none" } }], [{ userId: "mgr", type: "lead.updated" }], members, "owner");
    expect(f).toEqual([{ kind: "unexpected", type: "lead.updated", userId: "mgr" }]);
  });

  it("excludeActor removes only the actor from the manager audience", () => {
    expect(recipients({ kind: "managers", excludeActor: true }, members, "owner")).toEqual(["mgr"]);
    expect(recipients({ kind: "managers", excludeActor: false }, members, "owner")).toEqual(["owner", "mgr"]);
  });

  it("fingerprints merge repeat findings of one kind", () => {
    expect(fingerprintEffect("lead.create", { kind: "missing", type: "lead.created", userId: "a" })).toBe(
      fingerprintEffect("lead.create", { kind: "missing", type: "lead.created", userId: "b" }),
    );
  });
});

describe("expectation table vs the code (enumerated by tool)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (n === "_generated" || n === "node_modules") return [];
      return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
    });
  const root = join(__dirname, "..", "..");
  const dispatched = new Set<string>();
  for (const file of walk(join(root, "convex"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:notifyUser|notifyManagers|notifyByPermission|notifyAllMembers|notifyOwner)\(\s*ctx,[^"`)]*?"([a-z]+\.[a-z_.]+)"/g)) {
      dispatched.add(m[1]);
    }
  }
  const modelled = new Set(ACTION_EXPECTATIONS.flatMap((a) => a.effects.map((e) => e.type)));
  const byName = (a: string, b: string) => a.localeCompare(b);

  it("every dispatched type is modelled or deliberately listed as unmodelled (no silent gaps)", () => {
    const gap = [...dispatched].filter((t) => !modelled.has(t)).sort(byName);
    expect(gap).toEqual([...UNMODELLED_TYPES].sort(byName));
  });

  it("a modelled type is never also listed unmodelled, and every modelled type is really dispatched", () => {
    for (const t of UNMODELLED_TYPES) expect(modelled.has(t)).toBe(false);
    for (const t of modelled) expect(dispatched.has(t)).toBe(true);
  });

  it("every row's source file really dispatches each type the row promises", () => {
    for (const a of ACTION_EXPECTATIONS) {
      const text = readFileSync(join(root, a.source.split(":")[0]), "utf8");
      for (const e of a.effects) expect(text).toContain(`"${e.type}"`);
    }
  });
});
