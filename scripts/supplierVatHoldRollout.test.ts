import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { recoverSupplierVatHolds } from "./releaseGuard";

describe("SCRUM-782 supplier VAT hold rollout", () => {
  const run = (runPage: Parameters<typeof recoverSupplierVatHolds>[0]["runPage"], now = () => 0) =>
    recoverSupplierVatHolds({ runPage, now, startedAt: 0, timeoutMs: 1000, maxPages: 3 });

  test("serially pages to READY, counting only reclassified rows", () => {
    let calls = 0;
    expect(run(() => ({ ok: true, value: {
      status: ++calls === 3 ? "READY" : "MORE", reclassified: calls === 3 ? 1 : 0,
    } }))).toEqual({ ok: true, pages: 3, reclassified: 1 });
    expect(calls).toBe(3);
  });

  test("a completed migration needs only its READY probe", () => {
    let calls = 0;
    expect(run(() => { calls += 1; return { ok: true, value: { status: "READY", reclassified: 0 } }; }))
      .toEqual({ ok: true, pages: 1, reclassified: 0 });
    expect(calls).toBe(1);
  });

  test.each([null, {}, { status: "READY" }, { status: "SKIPPED", reclassified: 0 },
    { status: "READY", reclassified: -1 }, { status: "READY", reclassified: 101 },
    { status: "READY", reclassified: NaN }])("unavailable or malformed evidence refuses: %j", (value) => {
    expect(run(() => ({ ok: true, value }))).toMatchObject({ ok: false });
  });

  test("a failed call refuses without leaking backend output", () => {
    const result = run(() => ({ ok: false, reason: "private backend payload" }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("call failed") });
    expect(JSON.stringify(result)).not.toContain("private backend payload");
  });

  test("a nonterminating migration stops at the page cap", () => {
    let calls = 0;
    expect(run(() => { calls += 1; return { ok: true, value: { status: "MORE", reclassified: 0 } }; }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("page cap") });
    expect(calls).toBe(3);
  });

  test("the shared deadline stops before another call", () => {
    let calls = 0;
    let now = 0;
    expect(run(() => { calls += 1; now = 1001; return { ok: true, value: { status: "MORE", reclassified: 0 } }; }, () => now))
      .toMatchObject({ ok: false, reason: expect.stringContaining("deadline") });
    expect(calls).toBe(1);
  });

  test("rollout wiring runs after identity verification and refuses before any success path", () => {
    // Same wiring pin as the bank rebuild in releaseEntrypoints.test.ts.
    const source = readFileSync(path.join(__dirname, "rolloutRelease.mjs"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const at = (pattern: RegExp) => {
      const match = pattern.exec(source);
      expect(match).not.toBeNull();
      return match!.index;
    };
    const identity = at(/^const before = collectReport\(undefined\);$/m);
    const refusal = at(/^if \(!before.ok\) fail\(before.reason\);$/m);
    const migration = at(/^const supplierVat = recoverSupplierVatHolds\(\{$/m);
    const failure = at(/^if \(!supplierVat.ok\) fail\(supplierVat.reason\);$/m);
    const empty = at(/^if \(before.verdict.orgCount === 0\) \{$/m);
    const bank = at(/^const bank = rebuildBankBalances\(\{$/m);
    expect(identity).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(migration);
    expect(migration).toBeLessThan(failure);
    expect(failure).toBeLessThan(empty);
    expect(empty).toBeLessThan(bank);
    expect(source).toMatch(/runPage: \(\) => convex\(\["run", SUPPLIER_VAT_HOLD_FN, "\{\}"\]\)/);
    expect(source).toContain('const SUPPLIER_VAT_HOLD_FN = "accountingOutbox:recoverPeriodHeldSupplierVat";');
    expect(source).toMatch(/function fail\(message\) \{[\s\S]*?process.exit\(1\);/);
  });
});
