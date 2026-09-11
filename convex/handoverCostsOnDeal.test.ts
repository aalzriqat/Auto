/**
 * رسوم ومصاريف تسليم السيارة on the Deal (SCRUM-215, owner requirement c19384).
 *
 * The Deal's handover-cost section is a UI over three EXISTING canonical
 * commands. This proves, on the real mutations with the exact argument shapes
 * the section sends, that the records and the derived state behave as the
 * screen claims: an added line persists with its estimate and status; a
 * retried add with the same command identity does not duplicate the charge;
 * recording the actual preserves the estimate beside it; removing is an
 * audited void that keeps the record and drops it from every total; and none
 * of it touches vehicle expenses.
 *
 * Evidence boundary: convex-test only — repository behaviour, not the Convex
 * runtime, not production data.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "view:finance", "manage:finance",
];

const VEHICLE_PRICE = 20_000;
/** JOD: three decimals. */
const JOD_SCALE = 1_000;

async function seedDeal(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Handover ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: "Deal User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINHC${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: VEHICLE_PRICE, status: "AVAILABLE",
      sourceType: "STOCK" as const, purchasePrice: 15_000,
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 100,
    })
  );
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId,
    vehiclePrice: VEHICLE_PRICE, downPayment: 0, termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY", companyId, totalFinancedAmount: VEHICLE_PRICE,
  });
  const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
  return { t, orgId, userId, vehicleId, applicationId, asUser };
}

type Seeded = Awaited<ReturnType<typeof seedDeal>>;

/** Exactly what the section's ADD sends for a transfer fee estimated at 150 JOD. */
function addArgs(s: Seeded, intent: string, overrides: Record<string, unknown> = {}) {
  return {
    orgId: s.orgId,
    applicationId: s.applicationId,
    feeType: "OWNERSHIP_TRANSFER" as const,
    description: "Transfer at the licensing department",
    estimatedAmountMinor: 150 * JOD_SCALE,
    actualAmountMinor: undefined,
    paidBy: "DEALER" as const,
    paidTo: "GOVERNMENT" as const,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" as const,
    paidAt: undefined,
    receiptReference: undefined,
    source: "MANUAL" as const,
    idempotencyKey: `record-deal-fee:${s.applicationId}:${intent}`,
    ...overrides,
  };
}

async function costs(s: Seeded) {
  return await s.asUser.query(api.financeDealCosts.listDealCosts, {
    orgId: s.orgId,
    applicationId: s.applicationId,
  });
}

async function vehicleExpenseCount(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("expenses")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId))
      .collect();
    return rows.length;
  });
}

describe("handover costs on the Deal — the three canonical commands, with the section's exact payloads", () => {
  test("ADD persists the line with its estimate, ESTIMATED_ONLY status, dealer as payer, and no vehicle expense", async () => {
    const s = await seedDeal("add");
    const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "intent-1"));

    const listed = await costs(s);
    expect(listed.fees).toHaveLength(1);
    expect(listed.fees[0]).toMatchObject({
      _id: feeId,
      feeType: "OWNERSHIP_TRANSFER",
      paidBy: "DEALER",
      paidTo: "GOVERNMENT",
      accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
      estimatedAmountMinor: 150_000,
      status: "ESTIMATED_ONLY",
    });
    expect(listed.fees[0].actualAmountMinor).toBeUndefined();
    // Estimated and actual are kept apart: the actual total is NOT topped up.
    expect(listed.summary).toMatchObject({
      lineCount: 1,
      estimatedTotalMinor: 150_000,
      actualTotalMinor: 0,
      linesAwaitingActual: 1,
    });
    expect(await vehicleExpenseCount(s)).toBe(0);
  });

  test("a retried ADD with the SAME command identity is one line; a new intent is a second line", async () => {
    const s = await seedDeal("retry");
    const first = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "intent-1"));
    const replay = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "intent-1"));
    expect(replay).toBe(first);
    expect((await costs(s)).fees).toHaveLength(1);

    await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "intent-2"));
    expect((await costs(s)).fees).toHaveLength(2);
    expect((await costs(s)).summary.estimatedTotalMinor).toBe(300_000);
  });

  test("EDIT records the actual on the existing line — the estimate survives beside it, no second live line", async () => {
    const s = await seedDeal("edit");
    const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "intent-1"));
    await s.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId,
      feeId,
      actualAmountMinor: 165 * JOD_SCALE,
      paidAt: Date.UTC(2026, 8, 10),
      receiptReference: "LIC-2026-0910",
    });
    const listed = await costs(s);
    expect(listed.fees).toHaveLength(1);
    expect(listed.fees[0]).toMatchObject({
      estimatedAmountMinor: 150_000,
      actualAmountMinor: 165_000,
      receiptReference: "LIC-2026-0910",
      status: "ACTUAL_RECORDED",
    });
    expect(listed.summary).toMatchObject({
      estimatedTotalMinor: 150_000,
      actualTotalMinor: 165_000,
      linesAwaitingActual: 0,
      linesAwaitingReconciliation: 1,
    });
  });

  test("REMOVE is an audited void: the record and its figures survive with the reason, and drop out of every total", async () => {
    const s = await seedDeal("void");
    const keep = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "intent-1"));
    const drop = await s.asUser.mutation(
      api.financeDealCosts.recordDealFee,
      addArgs(s, "intent-2", { feeType: "INSPECTION", actualAmountMinor: 40 * JOD_SCALE, estimatedAmountMinor: undefined, accountingTreatment: "SELLING_EXPENSE" })
    );

    await expect(
      s.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: s.orgId, feeId: drop, reason: "   " })
    ).rejects.toThrow(/say why/i);

    await s.asUser.mutation(api.financeDealCosts.voidDealFee, {
      orgId: s.orgId, feeId: drop, reason: "Inspection was not needed for this buyer",
    });
    const listed = await costs(s);
    // `listDealCosts` serves LIVE lines only, so the voided one leaves the
    // section; the record itself survives with its figure, reason, actor and
    // time — nothing was hard-deleted.
    expect(listed.fees.map((fee) => fee._id)).toEqual([keep]);
    expect(listed.fees[0].status).toBe("ESTIMATED_ONLY");
    expect(listed.summary).toMatchObject({ lineCount: 1, estimatedTotalMinor: 150_000, actualTotalMinor: 0 });
    const row = await s.t.run((ctx) => ctx.db.get(drop));
    expect(row).toMatchObject({
      actualAmountMinor: 40_000,
      voidReason: "Inspection was not needed for this buyer",
      voidedBy: s.userId,
    });
    expect(row?.voidedAt).toBeTypeOf("number");
  });

  test("tenant scope: a member of another org cannot record a fee against this deal", async () => {
    const s = await seedDeal("tenant");
    // A second org and member INSIDE the same test instance — convex-test ids
    // are deterministic per instance, so a cross-instance check compares equal
    // strings and proves nothing.
    const otherOrgId = await s.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealership", createdAt: Date.now() })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId: otherOrgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const otherUserId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "other_user", email: "other@example.com", name: "Other" })
    );
    const otherRoleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: otherOrgId, name: "OWNER", permissions: PERMS, isSystemOwnerRole: true })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRoleId }));
    const asOther = s.t.withIdentity({ subject: "other_user", clerkId: "other_user" });

    await expect(
      asOther.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "x", { orgId: otherOrgId }))
    ).rejects.toThrow();
    expect((await costs(s)).fees).toHaveLength(0);
  });
});
