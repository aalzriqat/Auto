import { TestConvex as ConvexTestInstance } from "convex-test";
import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { feeDocBytes, MAX_DIRECT_PAYMENT_REFERENCE_CHARS, MAX_FEE_ATTACHMENTS, MAX_FEE_DOC_BYTES } from "./utils/feeDocLimits";

/**
 * SCRUM-443 v5 — every financeDealFees document is bounded, at EVERY writer.
 *
 * The direct-payment closing proof budgets its reads in documents AND bytes
 * (`MAX_DIRECT_PROOF_BYTES` is an expression of `MAX_FEE_DOC_BYTES`), which is
 * only true if no writer can produce a line past that size. One test per
 * writer: the RESULTING document past the cap is refused, guided, and nothing
 * is written.
 *
 * Writers of `financeDealFees` (enumerated with grep over convex/**, tests
 * excluded): recordDealFee (insert), recordTemplateFeeActual (insert),
 * recordActualFeeAmount (patch), reconcileDealFee (patch), voidDealFee (patch),
 * recordDirectFeePayment (patch), setFeeCustody (patch), syncCustodyFeePosting
 * (patch), the custody-migration (patch). reverseDirectFeePayment only ever
 * clears `directPayment` (the document shrinks).
 */

type TestConvex = ConvexTestInstance<typeof schema>;
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);
const HUGE = "x".repeat(MAX_FEE_DOC_BYTES + 500);

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  employeeId: Id<"users">;
  applicationId: Id<"financeApplications">;
  asUser: ReturnType<TestConvex["withIdentity"]>;
}

async function seedDeal(suffix: string): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Bytes ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `fb_user_${suffix}`, email: `fb${suffix}@x.com`, name: "Rana" }));
  const employeeId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `fb_emp_${suffix}`, email: `fbemp${suffix}@x.com`, name: "Emp" }));
  const ownerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: ownerRole }));
  const { applicationId } = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `FBVIN${suffix}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "FB", lastName: "Customer" });
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
  const asUser = t.withIdentity({ subject: `fb_user_${suffix}` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, fiscalYear: year, periodNumber: 1,
    startDate: Date.UTC(year - 1, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    openImmediately: true,
  });
  return { t, orgId, userId, employeeId, applicationId, asUser };
}

const addFee = (seed: Seed, extra: Record<string, unknown> = {}) =>
  seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId, applicationId: seed.applicationId,
    feeType: "LICENSING", paidBy: "DEALER", paidTo: "GOVERNMENT",
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: jod(50),
    ...extra,
  } as never);

const rowOf = (seed: Seed, feeId: Id<"financeDealFees">) => seed.t.run((ctx) => ctx.db.get("financeDealFees", feeId));
const feeCount = (seed: Seed) => seed.t.run(async (ctx) => (await ctx.db.query("financeDealFees").collect()).length);
const journalCount = (seed: Seed) => seed.t.run(async (ctx) => (await ctx.db.query("journalEntries").collect()).length);
const outbox = async (seed: Seed) =>
  seed.t.run(async (ctx) => (await ctx.db.query("accountingEvents").collect()).length + (await ctx.db.query("pendingAccountingEvents").collect()).length);

/**
 * Pads the stored line's description so that the line, as it would stand with
 * `extra` applied, is at most `slack` bytes past MAX_FEE_DOC_BYTES (0 = exactly
 * at the cap, admitted; 1 = one byte over, refused). Sized with the same
 * function the writers use.
 */
async function padTo(seed: Seed, feeId: Id<"financeDealFees">, extra: Record<string, unknown>, slack: number) {
  const row = (await rowOf(seed, feeId))!;
  const bytesWith = (n: number) => feeDocBytes({ ...row, ...extra, description: "x".repeat(n) });
  let lo = 0;
  let hi = MAX_FEE_DOC_BYTES;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytesWith(mid) <= MAX_FEE_DOC_BYTES + slack) lo = mid;
    else hi = mid - 1;
  }
  await seed.t.run((ctx) => ctx.db.patch(feeId, { description: "x".repeat(lo) }));
  return bytesWith(lo);
}

describe("every writer refuses an oversize resulting financeDealFees document, writing nothing", () => {
  test("recordDealFee: a description past the cap is refused, no line", async () => {
    const seed = await seedDeal("w-record");
    await expect(addFee(seed, { description: HUGE })).rejects.toThrow(/too large to store.*Nothing has been recorded/s);
    expect(await feeCount(seed)).toBe(0);
  });

  test("recordDealFee: more than the attachment cap is refused", async () => {
    const seed = await seedDeal("w-attach");
    const ids = await seed.t.run(async (ctx) => {
      const out: Id<"_storage">[] = [];
      for (let i = 0; i < MAX_FEE_ATTACHMENTS + 1; i += 1) out.push(await ctx.storage.store(new Blob([`file ${i}`])));
      return out;
    });
    await expect(addFee(seed, { documentStorageIds: ids })).rejects.toThrow(/at most 10 attachments/);
    expect(await feeCount(seed)).toBe(0);
    await addFee(seed, { documentStorageIds: ids.slice(0, MAX_FEE_ATTACHMENTS) });
    expect(await feeCount(seed)).toBe(1);
  });

  test("recordTemplateFeeActual: a template description past the cap names the template to edit; a long receipt reference does not", async () => {
    const seed = await seedDeal("w-template");
    const template = {
      feeType: "LICENSING", description: HUGE, estimatedAmountMinor: jod(50), paidBy: "DEALER", paidTo: "GOVERNMENT",
      includedInQuotation: false, deductedFromSettlement: false, refundable: false, accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
    };
    await seed.t.run((ctx) =>
      ctx.db.patch(seed.applicationId, { companyRuleSnapshot: { ruleVersion: 1, companyName: "X", feeTemplates: [template] } as never })
    );
    const record = (extra: Record<string, unknown> = {}) =>
      seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
        orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 0, feeType: "LICENSING",
        actualAmountMinor: jod(50), expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), ...extra,
      } as never);
    await expect(record()).rejects.toThrow(/fee template in the finance company's settings/);
    expect(await feeCount(seed)).toBe(0);
    // A small template with an oversize typed reference is the caller's to shorten.
    await seed.t.run((ctx) =>
      ctx.db.patch(seed.applicationId, {
        companyRuleSnapshot: { ruleVersion: 1, companyName: "X", feeTemplates: [{ ...template, description: "Plates" }] } as never,
      })
    );
    await expect(record({ receiptReference: HUGE })).rejects.toThrow(/Shorten the description, reference or notes/);
    expect(await feeCount(seed)).toBe(0);
  });

  test("recordActualFeeAmount: a receipt reference that pushes the line past the cap is refused, the amount unchanged", async () => {
    const seed = await seedDeal("w-actual");
    const feeId = await addFee(seed);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
        orgId: seed.orgId, feeId, actualAmountMinor: jod(65), expectedCurrency: "JOD", receiptReference: HUGE,
      })
    ).rejects.toThrow(/too large to store/);
    expect((await rowOf(seed, feeId))?.actualAmountMinor).toBe(jod(50));
  });

  test("reconcileDealFee: notes that push the line past the cap are refused, the line stays unreconciled", async () => {
    const seed = await seedDeal("w-reconcile");
    const feeId = await addFee(seed);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: HUGE })
    ).rejects.toThrow(/too large to store/);
    expect((await rowOf(seed, feeId))?.reconciledAt).toBeUndefined();
  });

  test("voidDealFee: a reason that pushes the line past the cap is refused, the line stays live", async () => {
    const seed = await seedDeal("w-void");
    const feeId = await addFee(seed);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: HUGE })
    ).rejects.toThrow(/too large to store/);
    expect((await rowOf(seed, feeId))?.voidedAt).toBeUndefined();
  });

  test("recordDirectFeePayment: a payment that would take the line past the cap posts nothing; at the cap it is admitted", async () => {
    const seed = await seedDeal("w-direct");
    const feeId = await addFee(seed);
    const paid = {
      directPayment: { version: 1, amountMinor: jod(50), method: "BANK_TRANSFER", paidAt: Date.now() - 1000, recordedBy: seed.userId, recordedAt: Date.now() },
      directPaymentVersion: 1,
      updatedAt: Date.now(),
    };
    await padTo(seed, feeId, paid, 1);
    const before = { journals: await journalCount(seed), events: await outbox(seed) };
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordDirectFeePayment, {
        orgId: seed.orgId, feeId, method: "BANK_TRANSFER", paidAt: Date.now() - 1000, expectedAmountMinor: jod(50), idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/too large to store/);
    expect(await journalCount(seed)).toBe(before.journals);
    expect(await outbox(seed)).toBe(before.events);
    expect((await rowOf(seed, feeId))?.directPayment).toBeUndefined();
  });

  test("recordDirectFeePayment: the reference is capped at 200 characters", async () => {
    const seed = await seedDeal("w-ref");
    const feeId = await addFee(seed);
    const pay = (reference: string) =>
      seed.asUser.mutation(api.financeDealCosts.recordDirectFeePayment, {
        orgId: seed.orgId, feeId, method: "BANK_TRANSFER", paidAt: Date.now() - 1000, expectedAmountMinor: jod(50),
        reference, idempotencyKey: crypto.randomUUID(),
      });
    await expect(pay("r".repeat(MAX_DIRECT_PAYMENT_REFERENCE_CHARS + 1))).rejects.toThrow(/reference is too long/);
    expect((await rowOf(seed, feeId))?.directPayment).toBeUndefined();
    await pay("r".repeat(MAX_DIRECT_PAYMENT_REFERENCE_CHARS));
    expect((await rowOf(seed, feeId))?.directPayment?.reference).toHaveLength(MAX_DIRECT_PAYMENT_REFERENCE_CHARS);
  });

  async function custodySeed(name: string) {
    const seed = await seedDeal(name);
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });
    const feeId = await addFee(seed, { paidBy: "EMPLOYEE" });
    return { seed, custodyId, feeId };
  }

  test("setFeeCustody: attaching custody that takes the line one byte past the cap is refused", async () => {
    const { seed, custodyId, feeId } = await custodySeed("w-setcustody");
    await padTo(seed, feeId, { custodyId, updatedAt: Date.now() }, 1);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId })
    ).rejects.toThrow(/too large to store/);
    expect((await rowOf(seed, feeId))?.custodyId).toBeUndefined();
  });

  test("the custody posting: a line that fits with custody attached but not with its posting record is refused as a whole", async () => {
    const { seed, custodyId, feeId } = await custodySeed("w-custodypost");
    // Exactly at the cap with the custody link attached: the link patch is
    // admitted, the posting's own record (custodyPosted + version) is what
    // takes it over.
    await padTo(seed, feeId, { custodyId, updatedAt: Date.now() }, 0);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId })
    ).rejects.toThrow(/too large to store/);
    const row = await rowOf(seed, feeId);
    expect(row?.custodyId).toBeUndefined();
    expect(row?.custodyPosted).toBeUndefined();
  });
});
