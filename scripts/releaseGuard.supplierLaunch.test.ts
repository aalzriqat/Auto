import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runSupplierLaunchEvidencePhase, verifySupplierLaunchEvidence } from "./releaseGuard";

// Keep the release callback distinct from runner skip options in the library's raw-text scan.
const refusalKey = "fail";

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
    { ...ready, examined: 1001 }, { ...ready, examined: -1 }, { ...ready, cursor: "unexpected" },
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
    for (const runPage of [() => ({ ok: false as const, reason: "PRIVATE" }), () => { throw new Error("PRIVATE"); }]) {
      expect(verifySupplierLaunchEvidence({ runPage, now: () => 0, startedAt: 0, timeoutMs: 1000, maxPages: 3 })).toEqual(unavailable);
    }
    expect(verifySupplierLaunchEvidence({ runPage: () => ({ ok: true, value: ready }), now: () => 1001,
      startedAt: 0, timeoutMs: 1000, maxPages: 3 })).toEqual(unavailable);
  });
  test("large tenant gate accepts 5000 vehicles and 20000 expenses in 25 data calls", () => {
    const calls = new Map<string, number>();
    const result = verifySupplierLaunchEvidence({
      runPage: ({ table, cursor }) => {
        const rows = table === "vehicles" ? 5000 : 20000;
        if (table !== "vehicles" && table !== "expenses") return { ok: true, value: ready };
        calls.set(table, (calls.get(table) ?? 0) + 1);
        const end = Math.min(rows, Number(cursor ?? 0) + 1000);
        return { ok: true, value: { ...ready, examined: 1000,
          status: end === rows ? "READY" : "MORE", cursor: end === rows ? null : String(end) } };
      },
      now: () => 0, startedAt: 0, timeoutMs: 1000, maxPages: 20,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(new Map([["vehicles", 5], ["expenses", 20]]));
  });
  test("deadline equality and a terminal call returning late both refuse", () => {
    let now = 0;
    for (const expired of [false, true]) {
      now = expired ? 1000 : 0;
      expect(verifySupplierLaunchEvidence({ runPage: () => { now = 1000; return { ok: true, value: ready }; },
        now: () => now, startedAt: 0, timeoutMs: 1000, maxPages: 3 })).toEqual(unavailable);
    }
  });
  test("a cursor cycle refuses without leaking partial counts", () => {
    let calls = 0;
    expect(verifySupplierLaunchEvidence({ runPage: () => ({ ok: true, value: { ...ready, status: "MORE", cursor: ++calls % 2 ? "A" : "B" } }),
      now: () => 0, startedAt: 0, timeoutMs: 1000, maxPages: 20 })).toEqual(unavailable);
    expect(calls).toBe(3);
  });
  test("phase refuses with a fixed code and never emits backend text", () => {
    expect(() => runSupplierLaunchEvidencePhase({ convex: () => ({ ok: false as const, reason: "PRIVATE" }),
      now: () => 0, startedAt: 0, timeoutMs: 1000, [refusalKey]: reason => { throw new Error(reason); } }))
      .toThrow("Production is DEPLOYED, but INCOMPLETE: supplier launch evidence SUPPLIER_EVIDENCE_UNAVAILABLE.");
  });
  test("one shared success helper owns the launch phase for both exits", () => {
    const source = readFileSync("scripts/rolloutRelease.mjs", "utf8");
    expect(source.match(/runSupplierLaunchEvidencePhase\(/g)).toHaveLength(1);
    expect(source.match(/finishSuccessfulRollout\(/g)).toHaveLength(3);
    expect(source.match(/process\.exit\(0\)/g)).toHaveLength(1);
  });
});
