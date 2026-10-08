import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES } from "../../lib/notifications/types";
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

describe("short delivery", () => {
  it("flags a row expected twice but delivered once", () => {
    const exp = [
      { type: "lead.updated", audience: { kind: "user", userId: "mgr" } },
      { type: "lead.updated", audience: { kind: "managers", excludeActor: false } },
    ] as const;
    const fs = judgeEffects([...exp], [{ userId: "mgr", type: "lead.updated" }, { userId: "owner", type: "lead.updated" }], members, "owner");
    expect(fs.map((f) => f.kind)).toEqual(["missing"]);
  });
});

describe("expectation table vs the code  (enumerated by tool)", () => {
  const root = join(__dirname, "..", "..");
  const byName = (a: string, b: string) => a.localeCompare(b);
  const modelled = new Set(ACTION_EXPECTATIONS.flatMap((a) => a.effects.map((e) => e.type)));
  const registry = Object.keys(NOTIFICATION_TYPES);

  it("every registered type is modelled or deliberately listed as unmodelled (no silent gaps)", () => {
    const gap = registry.filter((t) => !modelled.has(t)).sort(byName);
    expect(gap).toEqual([...UNMODELLED_TYPES].sort(byName));
  });

  it("a modelled type is never also listed unmodelled, and every modelled type is registered", () => {
    for (const t of UNMODELLED_TYPES) expect(modelled.has(t)).toBe(false);
    for (const t of modelled) expect(registry).toContain(t);
  });

  it("every row's cited lines really call a notify helper for the type the row promises", () => {
    for (const a of ACTION_EXPECTATIONS) {
      const [file, lines] = a.source.split(":");
      const text = readFileSync(join(root, file), "utf8").split("\n");
      const cited = lines.split(",").map((n) => Number(n));
      // A notify call spans a few lines: the type must appear within the call that starts at the cited line.
      const calls = cited.map((n) => text.slice(n - 1, n + 6).join("\n"));
      for (const e of a.effects) {
        expect(calls.some((c) => /notify\w+\(/.test(c) && c.includes(`"${e.type}"`))).toBe(true);
      }
    }
  });
});