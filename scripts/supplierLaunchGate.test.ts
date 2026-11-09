import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { verifySupplierLaunchEvidence } from "./supplierLaunchGate";

const TABLES = ["vehicleSupplierPayables", "vehicleSupplierReceivables", "supplierCostRecoveries",
  "supplierCostRecoveryReceipts", "openingPayablePayments", "vehicles", "vehicleOwnershipConversions",
  "financeApplications", "expenses", "vehicleEdits", "openingBalanceDrafts"];
const ZERO = { MISSING_SUPPLIER_ID: 0, MISSING_PAYEE_ID: 0, MISSING_BEARER_ID: 0, MISSING_SOURCE: 0 };
const ready = { status: "READY", cursor: null, examined: 0, counts: ZERO };
const unavailable = { ok: false, code: "SUPPLIER_EVIDENCE_UNAVAILABLE" };
const run = (value: unknown, maxPages = 3) => verifySupplierLaunchEvidence({
  runPage: () => ({ ok: true, value }), now: () => 0, startedAt: 0, timeoutMs: 1000, maxPages,
});

describe("supplier launch release gate", () => {
  test("complete zero requires independent evidence for every table", () => {
    const tables: string[] = [];
    const outcome = verifySupplierLaunchEvidence({ runPage: args => { tables.push(args.table); return { ok: true, value: ready }; },
      now: () => 0, startedAt: 0, timeoutMs: 1000, maxPages: 3 });
    expect(tables).toEqual(TABLES);
    expect(outcome).toEqual({ ok: true, counts: Object.fromEntries(TABLES.map(table => [table, ZERO])) });
  });
  test("nonzero count refuses launch and returns counts only", () => {
    expect(run({ ...ready, examined: 1, counts: { ...ZERO, MISSING_SUPPLIER_ID: 1 } })).toEqual({ ok: false,
      code: "SUPPLIER_IDENTITY_UNRESOLVED", counts: Object.fromEntries(TABLES.map(table => [table, { ...ZERO, MISSING_SUPPLIER_ID: 1 }])) });
  });
  test.each([null, {}, { status: "UNAVAILABLE", code: "SUPPLIER_EVIDENCE_UNAVAILABLE" },
    { ...ready, examined: 9 }, { ...ready, examined: -1 }, { ...ready, cursor: "unexpected" },
    { ...ready, counts: { ...ZERO, privateName: "SECRET" } }, { ...ready, privateId: "SECRET" },
    { ...ready, counts: { ...ZERO, MISSING_SUPPLIER_ID: Number.NaN } },
    { ...ready, counts: { ...ZERO, MISSING_PAYEE_ID: 1 } },
    { ...ready, status: "MORE", cursor: null }, { ...ready, status: "MORE", cursor: "same" },
  ])("unavailable, malformed, over-bound or stalled evidence refuses (%j)", value => {
    expect(run(value)).toEqual(unavailable);
  });
  test("a truncated walk fails closed at the bound", () => {
    let page = 0;
    expect(verifySupplierLaunchEvidence({ runPage: () => ({ ok: true, value: { ...ready,
      status: "MORE", cursor: `page${page += 1}` } }), now: () => 0, startedAt: 0, timeoutMs: 1000, maxPages: 2 })).toEqual(unavailable);
  });
  test("failed CLI, thrown I/O and deadline never become zero", () => {
    for (const runPage of [() => ({ ok: false, reason: "PRIVATE" }), () => { throw new Error("PRIVATE"); }]) {
      expect(verifySupplierLaunchEvidence({ runPage, now: () => 0, startedAt: 0, timeoutMs: 1000, maxPages: 3 })).toEqual(unavailable);
    }
    expect(verifySupplierLaunchEvidence({ runPage: () => ({ ok: true, value: ready }), now: () => 1001,
      startedAt: 0, timeoutMs: 1000, maxPages: 3 })).toEqual(unavailable);
  });
  test("both successful rollout exits invoke the same refusing phase", () => {
    const source = readFileSync("scripts/rolloutRelease.mjs", "utf8");
    const exits = [...source.matchAll(/process\.exit\(0\)/g)];
    expect(exits).toHaveLength(2);
    for (const exit of exits) {
      const span = source.slice(source.lastIndexOf("\n}", exit.index) + 2, exit.index);
      expect(span).toContain("requireSupplierLaunchEvidence();");
    }
    expect(source).toContain('"supplierLaunchEvidence:scanPage"');
    expect(source).toContain("if (!evidence.ok)");
    expect(source).toContain("DEPLOYED, but INCOMPLETE: supplier launch evidence");
  });
});
