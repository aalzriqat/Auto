import { TestConvex as ConvexTestInstance } from "convex-test";
import { ConvexError } from "convex/values";
import { readFileSync } from "node:fs";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";
import { evaluateClosingReadiness } from "./utils/financedSaleRecognition";

/**
 * SCRUM-443 v6 (invariant b) - PAYMENT TRUTH. Every live dealer-borne handover
 * cost with a positive actual has a supported, ledger-confirmed payment source
 * before finalizeDeal. A line no supported source can pay (a treatment custody
 * and direct payment cannot post, or a settlement deduction nothing recognises
 * off a configured financed-sale plan) is BLOCKING with its own guided reason,
 * because no journal for it exists anywhere else.
 */
type TestConvex = ConvexTestInstance<typeof schema>;
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);
const DAY = 24 * 60 * 60 * 1000;

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  otherOrgId: Id<"organizations">;
  userId: Id<"users">;
  employeeId: Id<"users">;
  applicationId: Id<"financeApplications">;
  asUser: ReturnType<TestConvex["withIdentity"]>;
  asSales: ReturnType<TestConvex["withIdentity"]>;
}

async function seedDeal(suffix: string): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Direct ${suffix}`, createdAt: Date.now() }));
  const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Other ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `dp_user_${suffix}`, email: `dp${suffix}@x.com`, name: "Rana" }));
  const employeeId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `dp_emp_${suffix}`, email: `emp${suffix}@x.com`, name: "Emp" }));
  const salesId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `dp_sales_${suffix}`, email: `sales${suffix}@x.com`, name: "Sales" }));
  const ownerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  const salesRole = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "SALES",
      permissions: [PERMISSIONS.VIEW_FINANCE_APPLICATIONS, PERMISSIONS.CREATE_FINANCE_APPLICATION],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: salesId, roleId: salesRole }));
  const { applicationId } = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `DPVIN${suffix}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "DP", lastName: "Customer" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500,
      termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    });
    const applicationId = await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId,
      status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
    });
    return { applicationId };
  });
  const asUser = t.withIdentity({ subject: `dp_user_${suffix}` });
  const asSales = t.withIdentity({ subject: `dp_sales_${suffix}` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, fiscalYear: year, periodNumber: 1,
    startDate: Date.UTC(year - 1, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    openImmediately: true,
  });
  return { t, orgId, otherOrgId, userId, employeeId, applicationId, asUser, asSales };
}

type Method = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";

/**
 * Records a direct payment the way the screen does: the amount SENT is the
 * amount the approver saw — the line's actual as it stands when this is called,
 * unless the test says the form was rendered at another figure (`expected`).
 */
async function payDirect(
  seed: Seed,
  feeId: Id<"financeDealFees">,
  extra: Partial<{ method: Method; paidAt: number; reference: string; idempotencyKey: string; as: Seed["asUser"]; expected: number }> = {}
) {
  const expectedAmountMinor =
    extra.expected ?? (await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId)))?.actualAmountMinor ?? 0;
  return await (extra.as ?? seed.asUser).mutation(api.financeDealCosts.recordDirectFeePayment, {
    orgId: seed.orgId, feeId, method: extra.method ?? "BANK_TRANSFER",
    paidAt: extra.paidAt ?? Date.now() - DAY, reference: extra.reference,
    expectedAmountMinor,
    idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(),
  });
}

const readiness = async (seed: Seed, settlesDirect = false) =>
  await seed.t.run(async (ctx) => {
    const app = (await ctx.db.get("financeApplications", seed.applicationId))!;
    const result = await evaluateClosingReadiness(ctx, app, { settlesDirect, currency: "JOD" });
    return result.readiness.checks.find((c) => c.key === "HANDOVER_COSTS_PAID")!;
  });

const ORDINARY = "OWNERSHIP_TRANSFER_EXPENSE" as const;

async function offPlanFee(
  seed: Seed,
  over: Partial<{ paidBy: string; accountingTreatment: string; deductedFromSettlement: boolean; actualAmountMinor: number | undefined }> = {}
) {
  return await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
    feeType: "LICENSING", paidBy: "DEALER", paidTo: "GOVERNMENT", accountingTreatment: ORDINARY,
    deductedFromSettlement: false, actualAmountMinor: jod(50), ...over,
  } as never);
}

/** SCRUM-446: a no-company deal through the dealership cannot close on unreconciled costs, so a test aimed at the LATER handover check reconciles the line first. */
async function reconcileFee(seed: Seed, feeId: Id<"financeDealFees">) {
  await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: "Matched to the invoice." });
}

const journals = (seed: Seed) => seed.t.run(async (ctx) => (await ctx.db.query("journalEntries").collect()).length);

/** Records a fee the way the LEGACY finance-company template writer does: source COMPANY_TEMPLATE, treatment and deduction frozen from the snapshot. */
async function templateFee(seed: Seed, over: Partial<{ accountingTreatment: string; deductedFromSettlement: boolean }> = {}) {
  await seed.t.run((ctx) =>
    ctx.db.patch(seed.applicationId, {
      companyRuleSnapshot: {
        ruleVersion: 1, companyName: "X",
        feeTemplates: [{
          feeType: "LICENSING", description: "Plates", estimatedAmountMinor: jod(50), paidBy: "DEALER", paidTo: "GOVERNMENT",
          includedInQuotation: false, deductedFromSettlement: over.deductedFromSettlement ?? false, refundable: false,
          accountingTreatment: over.accountingTreatment ?? ORDINARY,
        }],
      } as never,
    })
  );
  const feeId = await seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
    orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 0, feeType: "LICENSING",
    actualAmountMinor: jod(50), expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
  } as never);
  expect((await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId)))?.source).toBe("COMPANY_TEMPLATE");
  return feeId;
}

/** finalizeDeal is refused with `code`, nothing is journalled or queued for the line, and the deal stays APPROVED. */
async function expectFinalizeRefusedWithNoGl(seed: Seed, feeId: Id<"financeDealFees">, code: string, key: string) {
  await reconcileFee(seed, feeId);
  await registerHandover(seed.asUser, api, seed.orgId, seed.applicationId);
  await seed.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: seed.orgId, applicationId: seed.applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  const before = await journals(seed);
  let refusal: unknown;
  try {
    await seed.asUser.mutation(api.applications.finalizeDeal, { orgId: seed.orgId, applicationId: seed.applicationId, idempotencyKey: key });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(ConvexError);
  expect((refusal as ConvexError<{ code: string }>).data.code).toBe(code);
  expect(await journals(seed)).toBe(before);
  const events = await seed.t.run(async (ctx) => (await ctx.db.query("accountingEvents").collect()).filter((e) => e.sourceId === (feeId as string)));
  expect(events).toEqual([]);
  expect((await seed.t.run((ctx) => ctx.db.get("financeApplications", seed.applicationId)))?.status).toBe("APPROVED");
}

describe("b1 - an off-plan dealer-borne line no supported source can pay blocks the closing", () => {
  test("CAPITALIZED_TO_VEHICLE + positive actual: BLOCKED with UNSUPPORTED_TREATMENT; finalizeDeal refuses and posts nothing", async () => {
    const seed = await seedDeal("b1-cap");
    const feeId = await offPlanFee(seed, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    const check = await readiness(seed);
    expect(check.status).toBe("BLOCKED");
    expect(check.reason?.code).toBe("HANDOVER_COSTS_UNSUPPORTED_TREATMENT");
    expect(check.feeIds).toEqual([feeId]);
    const served = await seed.asUser.query(api.applications.getClosingReadiness, { orgId: seed.orgId, applicationId: seed.applicationId });
    expect(served.checks.find((c) => c.key === "HANDOVER_COSTS_PAID")?.status).toBe("BLOCKED");

    await reconcileFee(seed, feeId);
    await registerHandover(seed.asUser, api, seed.orgId, seed.applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId, applicationId: seed.applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
    });
    const before = await journals(seed);
    let refusal: unknown;
    try {
      await seed.asUser.mutation(api.applications.finalizeDeal, { orgId: seed.orgId, applicationId: seed.applicationId, idempotencyKey: "b1-fin" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConvexError);
    expect((refusal as ConvexError<{ code: string }>).data.code).toBe("HANDOVER_COSTS_UNSUPPORTED_TREATMENT");
    // GL absence: no journal for the line exists, before or after the refusal.
    expect(await journals(seed)).toBe(before);
    const events = await seed.t.run(async (ctx) => (await ctx.db.query("accountingEvents").collect()).filter((e) => e.sourceId === (feeId as string)));
    expect(events).toEqual([]);
    expect((await seed.t.run((ctx) => ctx.db.get("financeApplications", seed.applicationId)))?.status).toBe("APPROVED");
  });

  test("a settlement-deducted postable line OFF a configured plan: DEDUCTION_NOT_RECOGNISED", async () => {
    const seed = await seedDeal("b1-ded");
    const feeId = await offPlanFee(seed, { deductedFromSettlement: true });
    const check = await readiness(seed);
    expect(check.status).toBe("BLOCKED");
    expect(check.reason?.code).toBe("HANDOVER_COSTS_DEDUCTION_NOT_RECOGNISED");
    expect(check.feeIds).toEqual([feeId]);
  });

  test("the door exists: remove the cost and record it again as a postable treatment - then pay it - READY", async () => {
    const seed = await seedDeal("b1-door");
    const feeId = await offPlanFee(seed, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    expect((await readiness(seed)).status).toBe("BLOCKED");
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "wrong treatment" });
    expect((await readiness(seed)).status).toBe("READY");
    const again = await offPlanFee(seed);
    const blocked = await readiness(seed);
    expect(blocked.reason?.code).toBe("HANDOVER_COSTS_UNPAID");
    expect(blocked.feeIds).toEqual([again]);
    await payDirect(seed, again);
    expect((await readiness(seed)).status).toBe("READY");
  });

  test("the remove door needs CREATE_FINANCE_APPLICATION; the direct-payment door needs CONFIRM_FINANCE_DISBURSEMENT (a sales role has the first, not the second)", async () => {
    const seed = await seedDeal("b1-perm");
    const feeId = await offPlanFee(seed, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    await seed.asSales.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "wrong treatment" });
    expect((await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId)))?.voidedAt).toBeDefined();
    // The role that may remove the line still cannot pay it: no disbursement authority.
    const payable = await offPlanFee(seed);
    const before = await seed.t.run((ctx) => ctx.db.get("financeDealFees", payable));
    await expect(payDirect(seed, payable, { as: seed.asSales })).rejects.toThrow(`Forbidden: Missing required permissions: ${PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT}`);
    expect(await seed.t.run((ctx) => ctx.db.get("financeDealFees", payable))).toEqual(before);
    // Control: the same payment by the owner (who holds the authority) is accepted.
    await payDirect(seed, payable);
    expect((await seed.t.run((ctx) => ctx.db.get("financeDealFees", payable)))?.directPayment).toBeDefined();
  });

  test("controls: an ordinary postable UNPAID line keeps its own code; a zero actual is exempt; customer- and financier-borne are out of scope", async () => {
    const seed = await seedDeal("b1-controls");
    await offPlanFee(seed);
    expect((await readiness(seed)).reason?.code).toBe("HANDOVER_COSTS_UNPAID");

    const clean = await seedDeal("b1-controls-2");
    await offPlanFee(clean, { accountingTreatment: "CAPITALIZED_TO_VEHICLE", actualAmountMinor: 0 });
    await offPlanFee(clean, { paidBy: "CUSTOMER", accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    await offPlanFee(clean, { paidBy: "FINANCE_COMPANY", accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    expect((await readiness(clean)).status).toBe("READY");
  });

  test("controls: on a configured plan a deducted line is NOT double-required, and a non-postable line there is still blocked", async () => {
    const seed = await seedDeal("b1-plan");
    const companyId = await seed.asUser.mutation(api.finance.createCompany, {
      orgId: seed.orgId, name: "JAF", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, defaultLtvPercent: 100, isActive: true,
    });
    await seed.t.run((ctx) => ctx.db.patch("financeApplications", seed.applicationId, { companyId }));
    await offPlanFee(seed, { deductedFromSettlement: true });
    expect((await readiness(seed)).status).toBe("READY");
    await offPlanFee(seed, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    expect((await readiness(seed)).reason?.code).toBe("HANDOVER_COSTS_UNSUPPORTED_TREATMENT");
  });

  test("the other fee writer (recordTemplateFeeActual) is covered: a legacy-template line whose treatment is CAPITALIZED_TO_VEHICLE blocks with the legacy-review reason (SCRUM-443 v7)", async () => {
    const seed = await seedDeal("b1-template");
    const feeId = await templateFee(seed, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    const check = await readiness(seed);
    expect(check.status).toBe("BLOCKED");
    expect(check.reason?.code).toBe("HANDOVER_COSTS_LEGACY_TEMPLATE_REVIEW");
    expect(check.reason?.params).toEqual({ count: 1 });
    expect(check.feeIds).toEqual([feeId]);
    await expectFinalizeRefusedWithNoGl(seed, feeId, "HANDOVER_COSTS_LEGACY_TEMPLATE_REVIEW", "b1-template-fin");
  });

  test("the direct-payment door refuses an unsupported-treatment line with guidance naming remove-and-record-again", async () => {
    const seed = await seedDeal("b1-refusal");
    const feeId = await offPlanFee(seed, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    let message = "";
    try {
      await payDirect(seed, feeId);
    } catch (error) {
      message = String((error as { data?: unknown }).data ?? error);
    }
    expect(message).toMatch(/remove/i);
    expect((await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId)))?.directPayment).toBeUndefined();
  });
});

describe("b3 - a legacy-template line the deal cannot correct is not told to remove and re-add it (SCRUM-443 v7)", () => {
  test("a legacy-template deducted line with no configured plan: LEGACY_TEMPLATE_REVIEW, finalizeDeal refused, no GL", async () => {
    const seed = await seedDeal("b3-ded");
    const feeId = await templateFee(seed, { deductedFromSettlement: true });
    const check = await readiness(seed);
    expect(check.status).toBe("BLOCKED");
    expect(check.reason?.code).toBe("HANDOVER_COSTS_LEGACY_TEMPLATE_REVIEW");
    expect(check.feeIds).toEqual([feeId]);
    await expectFinalizeRefusedWithNoGl(seed, feeId, "HANDOVER_COSTS_LEGACY_TEMPLATE_REVIEW", "b3-ded-fin");
  });

  test("control: a MANUAL unsupported line keeps HANDOVER_COSTS_UNSUPPORTED_TREATMENT, a MANUAL deducted line keeps DEDUCTION_NOT_RECOGNISED", async () => {
    const cap = await seedDeal("b3-manual-cap");
    await offPlanFee(cap, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    expect((await readiness(cap)).reason?.code).toBe("HANDOVER_COSTS_UNSUPPORTED_TREATMENT");
    const ded = await seedDeal("b3-manual-ded");
    await offPlanFee(ded, { deductedFromSettlement: true });
    expect((await readiness(ded)).reason?.code).toBe("HANDOVER_COSTS_DEDUCTION_NOT_RECOGNISED");
  });

  test("mixed: one legacy-template and one manual unsupported line - the legacy reason comes first and counts only the template line", async () => {
    const seed = await seedDeal("b3-mixed");
    await offPlanFee(seed, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    const templateId = await templateFee(seed, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    const check = await readiness(seed);
    expect(check.reason?.code).toBe("HANDOVER_COSTS_LEGACY_TEMPLATE_REVIEW");
    expect(check.reason?.params).toEqual({ count: 1 });
    expect(check.feeIds).toHaveLength(2);
    expect(check.feeIds).toContain(templateId);
  });

  test("precedence is unchanged: an UNPAID line still comes before the legacy-template review", async () => {
    const seed = await seedDeal("b3-unpaid");
    await offPlanFee(seed);
    await templateFee(seed, { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    expect((await readiness(seed)).reason?.code).toBe("HANDOVER_COSTS_UNPAID");
  });
});

describe("b2 - a raw row with a direct payment but no valid counter cannot have its payment cleared", () => {
  async function rawPaid(name: string, counter: number | undefined) {
    const seed = await seedDeal(name);
    const feeId = await offPlanFee(seed);
    await seed.t.run((ctx) =>
      ctx.db.patch(feeId, {
        directPayment: { version: 1, amountMinor: jod(50), method: "BANK_TRANSFER", paidAt: Date.now() - 1000, recordedBy: seed.userId, recordedAt: Date.now() },
        directPaymentVersion: counter,
      })
    );
    return { seed, feeId };
  }

  test.each([["absent", undefined], ["mismatched", 2]] as const)("counter %s: void and an amount change are refused, the row unchanged", async (_label, counter) => {
    const { seed, feeId } = await rawPaid(`b2-${_label}`, counter);
    await expect(seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "mistake" })).rejects.toThrow(/inconsistent/);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(60), expectedCurrency: "JOD" })
    ).rejects.toThrow(/inconsistent/);
    const row = (await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId)))!;
    expect(row.voidedAt).toBeUndefined();
    expect(row.actualAmountMinor).toBe(jod(50));
    expect(row.directPayment?.amountMinor).toBe(jod(50));
  });

  test("control: a payment made through the writer (counter present) is voided and re-amounted exactly as before", async () => {
    const seed = await seedDeal("b2-control");
    const feeId = await offPlanFee(seed);
    await payDirect(seed, feeId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(60), expectedCurrency: "JOD" });
    expect((await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId)))?.directPayment).toBeUndefined();
    await payDirect(seed, feeId);
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "mistake" });
    expect((await seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId)))?.voidedAt).toBeDefined();
  });
});
describe("the settles-direct route rule the handover scope uses matches applications.ts", () => {
  test("dealSettlesDirect and settlesDirectToSupplier carry the same three route statements", () => {
    const body = (file: string, fn: string) => {
      const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const start = text.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      return text.slice(start, text.indexOf("\n}\n", start));
    };
    const statements = [
      "if (dealershipCollectsGross(consignedSettlementRoute(app))) return false;",
      "const vehicle = await ctx.db.get(app.vehicleId);",
      "return vehicle != null && isConsignedAgentSale(vehicle);",
    ];
    for (const [file, fn] of [
      ["convex/applications.ts", "async function settlesDirectToSupplier("],
      ["convex/utils/financedSaleRecognition.ts", "export async function dealSettlesDirect("],
    ] as const) {
      const text = body(file, fn);
      for (const s of statements) expect(text, `${file}: ${s}`).toContain(s);
    }
  });
});