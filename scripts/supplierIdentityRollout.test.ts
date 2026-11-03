import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  opaqueOrgRef,
  renderSupplierIdentitySummary,
  repairAndVerifySupplierIdentity,
  SUPPLIER_IDENTITY_COUNT_PHASES,
  SUPPLIER_IDENTITY_REPAIR_PHASES,
  supplierIdentityRefusalMessage,
  type SupplierIdentityInput,
  type SupplierIdentityRunResult,
} from "./releaseGuard";

type Call = { fn: "repair" | "count"; orgId: string; phase: string; cursor: string | null };

const READY_REPAIR = { status: "READY", cursor: null, examined: 3, repaired: 0, unresolved: 0 };
const READY_COUNT = { status: "READY", cursor: null, examined: 3, unresolved: 0 };

function harness(overrides: {
  repair?: (call: Call, n: number) => SupplierIdentityRunResult;
  count?: (call: Call, n: number) => SupplierIdentityRunResult;
  now?: () => number;
  maxPagesPerPhase?: number;
  orgs?: { orgId: string }[];
}) {
  const calls: Call[] = [];
  let repairCalls = 0;
  let countCalls = 0;
  const input: SupplierIdentityInput = {
    orgs: overrides.orgs ?? [{ orgId: "tenant-alpha" }, { orgId: "tenant-beta" }],
    repair: (args) => {
      const call: Call = { fn: "repair", orgId: args.orgId, phase: args.phase, cursor: args.cursor };
      calls.push(call);
      repairCalls += 1;
      return overrides.repair ? overrides.repair(call, repairCalls) : { ok: true, value: READY_REPAIR };
    },
    count: (args) => {
      const call: Call = { fn: "count", orgId: args.orgId, phase: args.phase, cursor: args.cursor };
      calls.push(call);
      countCalls += 1;
      return overrides.count ? overrides.count(call, countCalls) : { ok: true, value: READY_COUNT };
    },
    now: overrides.now ?? (() => 0),
    startedAt: 0,
    timeoutMs: 1_000,
    maxPagesPerPhase: overrides.maxPagesPerPhase ?? 5,
    pageSize: 100,
  };
  return { run: () => repairAndVerifySupplierIdentity(input), calls };
}

describe("SCRUM-868 P3 supplier identity rollout phase", () => {
  test("repairs every org and row kind first, then counts every org and kind, carrying the cursor", () => {
    const { run, calls } = harness({
      orgs: [{ orgId: "tenant-alpha" }],
      repair: (call, n) =>
        n === 1
          ? { ok: true, value: { status: "MORE", cursor: "c1", examined: 100, repaired: 40, unresolved: 2 } }
          : { ok: true, value: { ...READY_REPAIR, repaired: call.phase === "PAYABLES" ? 5 : 0 } },
    });
    const outcome = run();
    expect(outcome).toEqual({ ok: true, orgs: 1, repaired: 45, pages: 10, outstanding: [] });
    expect(calls.filter((c) => c.fn === "repair").map((c) => `${c.phase}:${c.cursor}`)).toEqual([
      "PAYABLES:null",
      "PAYABLES:c1",
      "RECEIVABLES:null",
      "RECOVERIES:null",
      "CONCESSIONS:null",
    ]);
    // Every repair call precedes every count call, and the count walk includes the vehicle check.
    const firstCount = calls.findIndex((c) => c.fn === "count");
    expect(calls.slice(firstCount).every((c) => c.fn === "count")).toBe(true);
    expect(calls.filter((c) => c.fn === "count").map((c) => c.phase)).toEqual([...SUPPLIER_IDENTITY_COUNT_PHASES]);
    expect(SUPPLIER_IDENTITY_REPAIR_PHASES).not.toContain("VEHICLES");
  });

  test("the check counts from the data, not from what the repair reported", () => {
    // The repair claims a clean run (nothing unresolved) but the independent count still finds rows.
    const { run } = harness({
      orgs: [{ orgId: "tenant-alpha" }],
      count: (call) =>
        call.phase === "PAYABLES" || call.phase === "VEHICLES"
          ? { ok: true, value: { ...READY_COUNT, unresolved: call.phase === "PAYABLES" ? 4 : 1 } }
          : { ok: true, value: READY_COUNT },
    });
    const outcome = run();
    expect(outcome).toMatchObject({ ok: true, outstanding: [`${opaqueOrgRef("tenant-alpha")}: PAYABLES=4, VEHICLES=1`] });
    expect(supplierIdentityRefusalMessage(outcome)).toMatch(/1 organization\(s\) still hold supplier rows with no supplier identity/);
  });

  test("a clean pass has nothing outstanding and no refusal", () => {
    const outcome = harness({}).run();
    expect(outcome).toMatchObject({ ok: true, outstanding: [] });
    expect(supplierIdentityRefusalMessage(outcome)).toBeNull();
    expect(renderSupplierIdentitySummary(outcome)).toMatch(/found nothing left for a settlement door to refuse/);
  });

  test("each organization's leftovers are listed by opaque ref with counts only", () => {
    const { run } = harness({
      count: (call) => ({
        ok: true,
        value: { ...READY_COUNT, unresolved: call.orgId === "tenant-beta" && call.phase === "CONCESSIONS" ? 2 : 0 },
      }),
    });
    const outcome = run();
    expect(outcome).toMatchObject({ ok: true, outstanding: [`${opaqueOrgRef("tenant-beta")}: CONCESSIONS=2`] });
    const published = `${renderSupplierIdentitySummary(outcome)}\n${supplierIdentityRefusalMessage(outcome)}`;
    expect(published).not.toMatch(/tenant-alpha|tenant-beta/);
  });

  test.each([
    ["not an object", null],
    ["empty object", {}],
    ["unknown status", { ...READY_REPAIR, status: "SKIPPED" }],
    ["missing unresolved", { status: "READY", cursor: null, examined: 1, repaired: 0 }],
    ["negative repaired", { ...READY_REPAIR, repaired: -1 }],
    ["fractional unresolved", { ...READY_REPAIR, unresolved: 0.5 }],
    ["NaN examined", { ...READY_REPAIR, examined: Number.NaN }],
    ["MORE without a cursor", { ...READY_REPAIR, status: "MORE", cursor: null }],
    ["READY with a cursor", { ...READY_REPAIR, cursor: "left-over" }],
  ])("an unreadable repair result refuses: %s", (_label, value) => {
    const outcome = harness({ repair: () => ({ ok: true, value }) }).run();
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("does not recognise") });
  });

  test.each([
    ["missing unresolved", { status: "READY", cursor: null, examined: 1 }],
    ["string unresolved", { ...READY_COUNT, unresolved: "0" }],
    ["unknown status", { ...READY_COUNT, status: "UNAVAILABLE" }],
    ["undefined", undefined],
  ])("an unreadable count result refuses instead of counting zero: %s", (_label, value) => {
    const outcome = harness({ count: () => ({ ok: true, value }) }).run();
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("does not recognise") });
  });

  test("a failed call refuses without printing backend text, an id or a tenant name", () => {
    const outcome = harness({ repair: () => ({ ok: false, reason: "private backend payload tenant-alpha" }) }).run();
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("repair call failed") });
    expect(JSON.stringify(outcome)).not.toMatch(/private backend payload|tenant-alpha/);
    const counted = harness({ count: () => ({ ok: false, reason: "private backend payload" }) }).run();
    expect(counted).toMatchObject({ ok: false, reason: expect.stringContaining("count call failed") });
    expect(JSON.stringify(counted)).not.toContain("private backend payload");
  });

  test("a cursor that never finishes stops at the page cap, in repair and in count", () => {
    let n = 0;
    const more = () => ({ ok: true as const, value: { ...READY_REPAIR, status: "MORE", cursor: `c${(n += 1)}` } });
    const repair = harness({ repair: more, maxPagesPerPhase: 3 });
    expect(repair.run()).toMatchObject({ ok: false, reason: expect.stringContaining("page cap") });
    expect(repair.calls).toHaveLength(3);
    const count = harness({
      count: () => ({ ok: true, value: { ...READY_COUNT, status: "MORE", cursor: `d${(n += 1)}` } }),
      maxPagesPerPhase: 2,
    });
    expect(count.run()).toMatchObject({ ok: false, reason: expect.stringContaining("page cap") });
  });

  test("a page that returns the cursor it was given refuses instead of looping", () => {
    const { run, calls } = harness({
      repair: () => ({ ok: true, value: { ...READY_REPAIR, status: "MORE", cursor: "same" } }),
      maxPagesPerPhase: 50,
    });
    expect(run()).toMatchObject({ ok: false, reason: expect.stringContaining("stopped advancing") });
    expect(calls).toHaveLength(2);
  });

  test("the shared deadline stops before another call", () => {
    let now = 0;
    const { run, calls } = harness({
      repair: () => {
        now = 1_001;
        return { ok: true, value: READY_REPAIR };
      },
      now: () => now,
    });
    expect(run()).toMatchObject({ ok: false, reason: expect.stringContaining("deadline") });
    expect(calls).toHaveLength(1);
  });

  test("a deployment with no organizations has nothing to repair or count", () => {
    const { run, calls } = harness({ orgs: [] });
    expect(run()).toEqual({ ok: true, orgs: 0, repaired: 0, pages: 0, outstanding: [] });
    expect(calls).toHaveLength(0);
  });

  test("rollout wiring: after the bank rebuild, a hard stop before verification, leftovers refuse before success", () => {
    // Same wiring pin as the bank rebuild in releaseEntrypoints.test.ts. Nothing runs rolloutRelease.mjs
    // in a test, so deleting a fail(...) call would leave every other test here green.
    const source = readFileSync(path.join(__dirname, "rolloutRelease.mjs"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const at = (pattern: RegExp) => {
      const match = pattern.exec(source);
      expect(match, `missing from rolloutRelease.mjs: ${pattern}`).not.toBeNull();
      return match!.index;
    };
    const bankStop = at(/^if \(bankStop\) fail\(bankStop\);$/m);
    const repair = at(/^const supplierIdentity = repairAndVerifySupplierIdentity\(\{$/m);
    const hardStop = at(/^if \(!supplierIdentity\.ok\) fail\(supplierIdentity\.reason\);$/m);
    const verification = at(/^const startedAt = rolloutStartedAt;$/m);
    const refusalExit = at(/^ {2}fail\(supplierIdentityRefusal\);$/m);
    const successExit = at(/^if \(lastOutcome === "verified"\) \{$/m);
    expect(bankStop).toBeLessThan(repair);
    expect(repair).toBeLessThan(hardStop);
    expect(hardStop).toBeLessThan(verification);
    expect(verification).toBeLessThan(refusalExit);
    expect(refusalExit).toBeLessThan(successExit);
    expect(source).toMatch(
      /^const supplierIdentityRefusal = lastOutcome === "verified" \? supplierIdentityRefusalMessage\(supplierIdentity\) : null;$/m,
    );
    expect(source).toMatch(/^if \(supplierIdentityRefusal\) \{\s*lastOutcome = "failed";\s*fail\(supplierIdentityRefusal\);\s*\}$/m);
    expect(source).toContain('const SUPPLIER_IDENTITY_REPAIR_FN = "supplierIdentityRepair:repairPage";');
    expect(source).toContain('const SUPPLIER_IDENTITY_COUNT_FN = "supplierIdentityRepair:countPage";');
    expect(source).toMatch(/repair: \(args\) => convex\(\["run", SUPPLIER_IDENTITY_REPAIR_FN, JSON\.stringify\(args\)\]\)/);
    expect(source).toMatch(/count: \(args\) => convex\(\["run", SUPPLIER_IDENTITY_COUNT_FN, JSON\.stringify\(args\)\]\)/);
  });
});
