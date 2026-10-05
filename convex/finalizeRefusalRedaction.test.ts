import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PERMISSIONS } from "./utils/permissions";
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
 * SCRUM-414 R1 / S414-RED-1: `finalizeDeal` authorizes on
 * `confirm:finance_disbursement`, which the default MANAGER template holds
 * WITHOUT `view:finance`. For such a caller `getClosingReadiness` serves only
 * WITHHELD_* codes; a REFUSED finalize must not serve more. Both throw sites
 * are exercised: the input refusal (currency drift) and the evaluator's check
 * refusal. The finance tier keeps the full coded payload.
 */
const JOD_SCALE = 1000;
const FEE_LABEL = "Zebra courier";

type Scenario = "CURRENCY_DRIFT" | "COSTS_AWAITING_RECONCILIATION";

async function seedDeal(scenario: Scenario) {
  const deal = await seedCloseableFinancedDeal({
    orgName: "Redaction Co",
    buyerLastName: "Redact",
    vin: "VINREDACT1",
    companyName: "Redact Finance",
    feeDescription: FEE_LABEL,
    feeAmountMinor: 25 * JOD_SCALE,
    feeKeyPrefix: "redact-fee:",
  });
  const { t, orgId, feeId, asOwner } = deal;
  const confirmOnlyRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "CONFIRM_ONLY", permissions: [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT] })
  );
  const asConfirmOnly = await deal.member("confirm_u", confirmOnlyRoleId);

  if (scenario === "CURRENCY_DRIFT") {
    await asOwner.mutation(api.financeDealCosts.reconcileDealFee, { orgId, feeId, notes: "Matched." });
    const settings = await t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    await t.run((ctx) => ctx.db.patch(settings!._id, { currency: "USD", currencySymbol: "USD" }));
  }
  // COSTS_AWAITING_RECONCILIATION: the fee is left unreconciled — one line.

  return { ...deal, asConfirmOnly };
}

const refusalOf = (caller: DealCaller, orgId: Id<"organizations">, applicationId: Id<"financeApplications">) =>
  finalizeRefusalOf(caller, orgId, applicationId, "redact-finalize:" + applicationId);

/** Everything a caller receives from the refusal, serialized. */
const serialized = (error: { data?: unknown; message?: string }) => JSON.stringify({ data: error.data, message: error.message });

describe("finalizeDeal refusals are redacted below the finance tier (SCRUM-414 R1)", () => {
  const belowFinanceTier = [
    ["the default MANAGER template", "asManager"],
    ["a custom role holding only confirm:finance_disbursement", "asConfirmOnly"],
  ] as const;

  test.each(belowFinanceTier)("currency drift (input refusal) as %s: WITHHELD_UNAVAILABLE, no params, no currency", async (_label, who) => {
    const s = await seedDeal("CURRENCY_DRIFT");
    const before = await s.counts();
    const error = await refusalOf(s[who], s.orgId, s.applicationId);

    expect(error.data).toEqual({ code: "WITHHELD_UNAVAILABLE", message: WITHHELD_READINESS_REASON_FALLBACK });
    expect(serialized(error)).not.toMatch(/JOD|USD|params|recorded in/);
    expect(await s.counts()).toEqual(before);
  });

  test.each(belowFinanceTier)("a parameterized check refusal as %s: WITHHELD_<CHECK>, no params, no count or label", async (_label, who) => {
    const s = await seedDeal("COSTS_AWAITING_RECONCILIATION");
    const before = await s.counts();
    const error = await refusalOf(s[who], s.orgId, s.applicationId);

    expect(error.data).toEqual({ code: "WITHHELD_COSTS_CLOSABLE", message: WITHHELD_READINESS_REASON_FALLBACK });
    expect(serialized(error)).not.toMatch(/params|count|cost\(s\)|reconcile|Zebra/i);
    expect(await s.counts()).toEqual(before);
  });

  test("the manager's refusal matches what the readiness query serves the same manager", async () => {
    const s = await seedDeal("COSTS_AWAITING_RECONCILIATION");
    const readiness = await s.asManager.query(api.applications.getClosingReadiness, {
      orgId: s.orgId, applicationId: s.applicationId,
    });
    const blocked = readiness.checks.find((check) => check.status === "BLOCKED" || check.status === "UNAVAILABLE");
    const error = await refusalOf(s.asManager, s.orgId, s.applicationId);
    expect(blocked).toMatchObject({ key: "COSTS_CLOSABLE", reasonCode: "WITHHELD_COSTS_CLOSABLE" });
    expect(error.data).toEqual({ code: blocked!.reasonCode, message: blocked!.reason });
  });

  test("control — the finance tier keeps the full coded payload on both throw sites", async () => {
    const drift = await seedDeal("CURRENCY_DRIFT");
    const driftBefore = await drift.counts();
    expect((await refusalOf(drift.asOwner, drift.orgId, drift.applicationId)).data).toEqual({
      code: "READINESS_CURRENCY_DRIFT",
      params: { recordedCurrency: "JOD", orgCurrency: "USD" },
      message: expect.stringContaining("recorded in JOD, but the organization's currency is now USD"),
    });
    expect(await drift.counts()).toEqual(driftBefore);

    const costs = await seedDeal("COSTS_AWAITING_RECONCILIATION");
    const costsBefore = await costs.counts();
    expect((await refusalOf(costs.asOwner, costs.orgId, costs.applicationId)).data).toEqual({
      code: "COSTS_AWAITING_RECONCILIATION",
      params: { count: 1 },
      message: expect.stringContaining("1 cost(s) on this deal have an amount nobody has checked"),
    });
    expect(await costs.counts()).toEqual(costsBefore);
  });
});
