import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { WITHHELD_READINESS_REASON_FALLBACK } from "../lib/closingReadinessReasonCodes";
import { refusalOf as finalizeRefusalOf, seedCloseableFinancedDeal, type DealCaller } from "../test-utils/seedCloseableFinancedDeal";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * SCRUM-420: a financed deal whose application carries
 * `needsFinancingReconciliation === true` can never finalize, by any door.
 * The refusal is the closing-readiness check `FINANCING_RECONCILED`, appended
 * LAST to `evaluateClosingReadiness`, which `finalizeDeal` re-runs through
 * `resolveFinancedSalePlan` before its first write. Clearing the flag goes
 * through the existing `resolveFinancingReconciliation`.
 */
async function seedDeal(opts: { flag?: boolean; reconcileFee?: boolean }) {
  const deal = await seedCloseableFinancedDeal({
    orgName: "Reconciled Gate Co",
    buyerLastName: "Gate",
    vin: "VINGATE420",
    companyName: "Gate Finance",
    feeDescription: "Courier (dealership bore none)",
    feeAmountMinor: 0,
    feeKeyPrefix: "gate-fee:",
  });
  const { t, orgId, applicationId, feeId, asOwner } = deal;
  if (opts.reconcileFee !== false) {
    await asOwner.mutation(api.financeDealCosts.reconcileDealFee, { orgId, feeId, notes: "Matched." });
  }
  // The flag is set LAST, so no earlier writer's recompute can move it.
  await t.run((ctx) =>
    ctx.db.patch(applicationId, {
      needsFinancingReconciliation: opts.flag,
      financingReconciliationReason: opts.flag === true ? "SCRUM-420 fixture: figures flagged for review." : undefined,
    })
  );
  const readApp = async () => (await t.run((ctx) => ctx.db.get(applicationId)))!;
  return { ...deal, readApp };
}

type Seeded = Awaited<ReturnType<typeof seedDeal>>;

const finalize = (caller: DealCaller, s: Seeded, key = "gate-finalize:" + s.applicationId) =>
  caller.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId: s.applicationId, idempotencyKey: key });

const refusalOf = (caller: DealCaller, s: Seeded) =>
  finalizeRefusalOf(caller, s.orgId, s.applicationId, "gate-finalize:" + s.applicationId);

const readiness = (caller: DealCaller, s: Seeded) =>
  caller.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId: s.applicationId });

// One flagged deal serves the two READ-ONLY readiness tests (T7); every test that
// finalizes or mutates seeds its own.
let flaggedForReads: Promise<Seeded> | undefined;
const flaggedDealForReads = () => (flaggedForReads ??= seedDeal({ flag: true }));

describe("SCRUM-420 — a deal flagged needsFinancingReconciliation cannot finalize", () => {
  test("T7: a flagged, otherwise-closeable financed deal is not ready; FINANCING_RECONCILED is BLOCKED and ordered LAST", async () => {
    const s = await flaggedDealForReads();
    const served = await readiness(s.asOwner, s);
    const blocked = served.checks.filter((check) => check.status === "BLOCKED" || check.status === "UNAVAILABLE");

    // The fixture is otherwise closeable: the flag is the ONLY unmet condition.
    expect(blocked.map((check) => check.key)).toEqual(["FINANCING_RECONCILED"]);
    expect(served.state).toBe("BLOCKED");
    expect(served.checks[served.checks.length - 1]).toMatchObject({
      key: "FINANCING_RECONCILED",
      status: "BLOCKED",
      reasonCode: "FINANCING_RECONCILIATION_FLAGGED",
    });
  });

  test("T7: a below-finance-tier caller is served the WITHHELD code, with no figures or reason text", async () => {
    const s = await flaggedDealForReads();
    const served = await readiness(s.asManager, s);
    const check = served.checks.find((c) => c.key === "FINANCING_RECONCILED");
    expect(check).toMatchObject({ status: "BLOCKED", reasonCode: "WITHHELD_FINANCING_RECONCILED", reason: WITHHELD_READINESS_REASON_FALLBACK });
    expect(JSON.stringify(check)).not.toMatch(/SCRUM-420 fixture/);
  });

  test("T17: a direct finalizeDeal on a flagged deal is refused with the coded reason, and NOTHING is written", async () => {
    const s = await seedDeal({ flag: true });
    const before = await s.counts();

    const error = await refusalOf(s.asOwner, s);
    expect(error.data).toMatchObject({ code: "FINANCING_RECONCILIATION_FLAGGED", message: expect.stringMatching(/reconcil/i) });

    // No sale, journal, receivable, outbox row or idempotency completion.
    expect(await s.counts()).toEqual(before);
    const app = await s.readApp();
    expect(app.status).toBe("APPROVED");
    expect(app.finalizedSaleId).toBeUndefined();
    expect(app.needsFinancingReconciliation).toBe(true);
  });

  test("T17: the same refusal below the finance tier is the WITHHELD code, and nothing is written", async () => {
    const s = await seedDeal({ flag: true });
    const before = await s.counts();
    const error = await refusalOf(s.asManager, s);
    expect(error.data).toEqual({ code: "WITHHELD_FINANCING_RECONCILED", message: WITHHELD_READINESS_REASON_FALLBACK });
    expect(await s.counts()).toEqual(before);
  });

  test("control: after resolveFinancingReconciliation clears the flag, the check is READY and finalize succeeds", async () => {
    const s = await seedDeal({ flag: true });
    await expect(finalize(s.asOwner, s, "gate-first")).rejects.toThrow();

    await s.asOwner.mutation(api.financingEconomics.resolveFinancingReconciliation, {
      orgId: s.orgId, applicationId: s.applicationId, note: "Checked the figures against the approval letter.",
    });
    expect((await s.readApp()).needsFinancingReconciliation).toBe(false);
    expect((await readiness(s.asOwner, s)).checks.find((c) => c.key === "FINANCING_RECONCILED")).toMatchObject({ status: "READY" });

    const saleId = await finalize(s.asOwner, s, "gate-second");
    expect(saleId).toBeTruthy();
    const app = await s.readApp();
    expect(app.status).toBe("CLOSED");
    expect(app.finalizedSaleId).toBe(saleId);
    expect((await s.counts()).sales).toBe(1);
  });

  test.each([
    ["never set (undefined)", undefined, "NOT_APPLICABLE"],
    ["cleared (false)", false, "READY"],
  ] as const)("control: a deal whose flag was %s is unaffected — %s, and finalize succeeds", async (_label, flag, status) => {
    const s = await seedDeal({ flag });
    const served = await readiness(s.asOwner, s);
    expect(served.state).toBe("READY");
    expect(served.checks.find((c) => c.key === "FINANCING_RECONCILED")).toMatchObject({ status });
    expect(await finalize(s.asOwner, s)).toBeTruthy();
    expect((await s.counts()).sales).toBe(1);
  });

  test("T18: a flagged deal with an EXISTING unmet check still surfaces the existing reason (the new check is appended LAST)", async () => {
    const s = await seedDeal({ flag: true, reconcileFee: false });
    const served = await readiness(s.asOwner, s);
    const keys = served.checks.map((check) => check.key);
    expect(keys[keys.length - 1]).toBe("FINANCING_RECONCILED");
    expect(served.checks.find((c) => c.key === "COSTS_CLOSABLE")).toMatchObject({
      status: "BLOCKED", reasonCode: "COSTS_AWAITING_RECONCILIATION",
    });
    expect(served.checks.find((c) => c.key === "FINANCING_RECONCILED")).toMatchObject({ status: "BLOCKED" });

    const before = await s.counts();
    const error = await refusalOf(s.asOwner, s);
    expect(error.data).toMatchObject({ code: "COSTS_AWAITING_RECONCILIATION" });
    expect(await s.counts()).toEqual(before);
  });

  // Codex attack (ii): every other test sets the flag by a direct patch. This one raises it through the
  // REAL writer -- `recomputeAndPatchEconomics`, reached through a settlement-input cost write on a deal whose
  // finance company keeps the customer's payment and whose retained amount nobody has recorded.
  test("T17c: the flag raised by the real recompute writer refuses finalize, and nothing is written", async () => {
    const s = await seedDeal({ flag: undefined });
    expect((await s.readApp()).needsFinancingReconciliation).toBeUndefined();
    // Setup, not the writer under test: the deal's company retains the customer's payment.
    await s.t.run((ctx) => ctx.db.patch(s.applicationId, { customerContributionSettlement: "RETAINED_BY_COMPANY" }));

    // After handover every economics input is sealed except the settlement-input cost writers, which
    // call `recomputeEconomicsForApplication` (only for a line deducted from the settlement); recording one drives it.
    const secondFeeId = await s.asOwner.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD", orgId: s.orgId, applicationId: s.applicationId, feeType: "OTHER_CLOSING_EXPENSE",
      paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
      deductedFromSettlement: true, actualAmountMinor: 0, description: "Second fee (drives the recompute)",
      idempotencyKey: "gate-fee-2:" + s.applicationId,
    });
    await s.asOwner.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId: secondFeeId, notes: "Matched." });
    const flagged = await s.readApp();
    expect(flagged.needsFinancingReconciliation).toBe(true);
    expect(flagged.financingReconciliationReason).toMatch(/keeps the customer/i);

    const before = await s.counts();
    const served = await readiness(s.asOwner, s);
    expect(served.checks.find((c) => c.key === "FINANCING_RECONCILED")).toMatchObject({
      status: "BLOCKED", reasonCode: "FINANCING_RECONCILIATION_FLAGGED",
    });
    const error = await refusalOf(s.asOwner, s);
    expect(error.data).toMatchObject({ code: "FINANCING_RECONCILIATION_FLAGGED" });
    expect(await s.counts()).toEqual(before);
    expect((await s.counts()).sales).toBe(0);
    expect((await s.readApp()).finalizedSaleId).toBeUndefined();

    await s.asOwner.mutation(api.financingEconomics.resolveFinancingReconciliation, {
      orgId: s.orgId, applicationId: s.applicationId, note: "Reviewed the retained customer payment.",
    });
    expect(await finalize(s.asOwner, s, "gate-after-real-resolve")).toBeTruthy();
    expect((await s.counts()).sales).toBe(1);
  });

  test("T17b: resolve, then a recompute re-raises the flag, finalize is refused, resolve again, finalize succeeds (direct-route-independent)", async () => {
    const s = await seedDeal({ flag: true });
    const resolve = (note: string) =>
      s.asOwner.mutation(api.financingEconomics.resolveFinancingReconciliation, {
        orgId: s.orgId, applicationId: s.applicationId, note,
      });
    await resolve("First review.");
    // A writer re-raises the flag (here directly: the recompute does exactly this patch for a company that
    // retains the customer's payment — see `recomputeAndPatchEconomics`).
    await s.t.run((ctx) =>
      ctx.db.patch(s.applicationId, { needsFinancingReconciliation: true, financingReconciliationReason: "re-raised" })
    );
    await expect(finalize(s.asOwner, s, "gate-after-reraise")).rejects.toMatchObject({
      data: { code: "FINANCING_RECONCILIATION_FLAGGED" },
    });
    await resolve("Second review.");
    expect(await finalize(s.asOwner, s, "gate-after-second-resolve")).toBeTruthy();
  });
});
