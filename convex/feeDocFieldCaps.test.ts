import { TestConvex as ConvexTestInstance } from "convex-test";
import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import {
  feeDocBytes,
  MAX_DIRECT_PAYMENT_REFERENCE_CHARS,
  MAX_FEE_ATTACHMENTS,
  MAX_FEE_DESCRIPTION_CHARS,
  MAX_FEE_DOC_BYTES,
  MAX_FEE_RECEIPT_REFERENCE_CHARS,
  MAX_FEE_RECONCILIATION_NOTES_CHARS,
  MAX_FEE_VOID_REASON_CHARS,
} from "./utils/feeDocLimits";

/**
 * SCRUM-443 v6 (invariant a) — the byte bound holds BY CONSTRUCTION: every row a
 * public writer admits still accepts every later lifecycle write (pay direct,
 * void, reconcile, re-record the actual, custody link). Field caps at the input
 * boundary make the backstop `assertFeeDocWithinBytes` unreachable for an
 * admitted row, so the dead end (a row that pays or voids never again) cannot
 * be built through the public doors.
 */
type TestConvex = ConvexTestInstance<typeof schema>;
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);

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

describe("a1 - the dead end: a description past the cap is refused at entry, an at-cap row pays and voids", () => {
  test("a near-cap description is refused at recordDealFee, no line is written", async () => {
    const seed = await seedDeal("a1-refuse");
    // The old code admitted a row up to ~8 KiB: one that then refused direct payment and void for good.
    const nearCap = "x".repeat(MAX_FEE_DOC_BYTES - 400);
    await expect(addFee(seed, { description: nearCap })).rejects.toThrow(/may be at most 500 characters/);
    await expect(addFee(seed, { description: "x".repeat(MAX_FEE_DESCRIPTION_CHARS + 1) })).rejects.toThrow(/Nothing has been recorded/);
    expect(await feeCount(seed)).toBe(0);
  });

  test("a description of exactly the cap (worst-case 3-byte characters) is admitted, then pays directly and voids", async () => {
    const seed = await seedDeal("a1-atcap");
    const description = "€".repeat(MAX_FEE_DESCRIPTION_CHARS);
    const feeId = await addFee(seed, { description, receiptReference: "€".repeat(MAX_FEE_RECEIPT_REFERENCE_CHARS) });
    expect((await rowOf(seed, feeId))?.description).toHaveLength(MAX_FEE_DESCRIPTION_CHARS);
    await seed.asUser.mutation(api.financeDealCosts.recordDirectFeePayment, {
      orgId: seed.orgId, feeId, method: "BANK_TRANSFER", paidAt: Date.now() - 1000, expectedAmountMinor: jod(50),
      reference: "€".repeat(MAX_DIRECT_PAYMENT_REFERENCE_CHARS), idempotencyKey: crypto.randomUUID(),
    });
    expect((await rowOf(seed, feeId))?.directPayment).toBeDefined();
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, {
      orgId: seed.orgId, feeId, reason: "€".repeat(MAX_FEE_VOID_REASON_CHARS),
    });
    const row = (await rowOf(seed, feeId))!;
    expect(row.voidedAt).toBeDefined();
    expect(feeDocBytes(row as never)).toBeLessThanOrEqual(MAX_FEE_DOC_BYTES);
  });

  test("every free-text field has its own cap, and refuses one character over", async () => {
    const seed = await seedDeal("a1-fields");
    const feeId = await addFee(seed);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
        orgId: seed.orgId, feeId, actualAmountMinor: jod(60), expectedCurrency: "JOD", receiptReference: "r".repeat(MAX_FEE_RECEIPT_REFERENCE_CHARS + 1),
      })
    ).rejects.toThrow(/at most 200 characters/);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: "n".repeat(MAX_FEE_RECONCILIATION_NOTES_CHARS + 1) })
    ).rejects.toThrow(/at most 500 characters/);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "v".repeat(MAX_FEE_VOID_REASON_CHARS + 1) })
    ).rejects.toThrow(/at most 300 characters/);
    expect((await rowOf(seed, feeId))?.voidedAt).toBeUndefined();
    expect((await rowOf(seed, feeId))?.actualAmountMinor).toBe(jod(50));
  });
});

describe("a2 - the composed worst case: every field at its cap, multibyte, production-length ids, still fits", () => {
  test.each([
    ["3-byte UTF-8 (the worst case of one UTF-16 unit)", "€"],
    ["Arabic (2 bytes a unit)", "ع"],
    ["astral (a surrogate pair is 2 units, 2 bytes each)", "\u{1F600}"],
  ])("%s", (_label, glyph) => {
    const fill = (units: number) => glyph.repeat(Math.floor(units / glyph.length));
    const id = "k".repeat(32);
    const doc = {
      orgId: id, applicationId: id, feeType: "LICENSING", currency: "JOD", estimatedAmountMinor: 9_999_999, actualAmountMinor: 9_999_999,
      paidBy: "DEALER", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
      includedInQuotation: true, deductedFromSettlement: true, refundable: true,
      description: fill(MAX_FEE_DESCRIPTION_CHARS),
      custodyId: id, custodyPosted: { version: 999, amountMinor: 9_999_999, custodyId: id, occurredAt: 1.7e12 }, custodyPostingVersion: 999,
      directPayment: {
        version: 999, amountMinor: 9_999_999, method: "BANK_TRANSFER", paidAt: 1.7e12, reference: fill(MAX_DIRECT_PAYMENT_REFERENCE_CHARS),
        recordedBy: id, recordedAt: 1.7e12,
      },
      directPaymentVersion: 999, paidAt: 1.7e12, receiptReference: fill(MAX_FEE_RECEIPT_REFERENCE_CHARS),
      documentStorageIds: Array.from({ length: MAX_FEE_ATTACHMENTS }, () => id),
      source: "COMPANY_TEMPLATE", templateIndex: 99,
      reconciledAt: 1.7e12, reconciledBy: id, reconciliationNotes: fill(MAX_FEE_RECONCILIATION_NOTES_CHARS),
      voidedAt: 1.7e12, voidedBy: id, voidReason: fill(MAX_FEE_VOID_REASON_CHARS),
      createdBy: id, createdAt: 1.7e12, updatedAt: 1.7e12,
    };
    const bytes = feeDocBytes(doc);

    // Measured 2026-09-29: 6,577 bytes (3-byte units), 4,877 (Arabic / astral), of 8,192.
    expect(bytes, `${_label}: ${bytes}`).toBeLessThanOrEqual(MAX_FEE_DOC_BYTES);
    expect(bytes).toBeGreaterThan(0);
  });

  test("the caps are tight enough to matter: the pre-v6 caps (1,000 / 500 / 2,000) would NOT have fit at 3 bytes a unit", () => {
    expect(3 * (1000 + 500 + 2000 + MAX_FEE_RECEIPT_REFERENCE_CHARS + MAX_DIRECT_PAYMENT_REFERENCE_CHARS)).toBeGreaterThan(MAX_FEE_DOC_BYTES);
  });
});

describe("a3 - the template path: a long configured description is shortened on the copy, never a dead end", () => {
  const template = (description: string) => ({
    feeType: "LICENSING", description, estimatedAmountMinor: jod(50), paidBy: "DEALER", paidTo: "GOVERNMENT",
    includedInQuotation: false, deductedFromSettlement: false, refundable: false, accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
  });
  const record = (seed: Seed, extra: Record<string, unknown> = {}) =>
    seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
      orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 0, feeType: "LICENSING",
      actualAmountMinor: jod(50), expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), ...extra,
    } as never);

  test("a 6,000-character template description is copied at the cap; the row pays and voids; no message points at settings", async () => {
    const seed = await seedDeal("a3-template");
    await seed.t.run((ctx) =>
      ctx.db.patch(seed.applicationId, {
        companyRuleSnapshot: { ruleVersion: 1, companyName: "X", feeTemplates: [template("ت".repeat(6000))] } as never,
      })
    );
    const feeId = await record(seed);
    expect((await rowOf(seed, feeId))?.description).toHaveLength(MAX_FEE_DESCRIPTION_CHARS);
    await seed.asUser.mutation(api.financeDealCosts.recordDirectFeePayment, {
      orgId: seed.orgId, feeId, method: "BANK_TRANSFER", paidAt: Date.now() - 1000, expectedAmountMinor: jod(50), idempotencyKey: crypto.randomUUID(),
    });
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "entered in error" });
    expect((await rowOf(seed, feeId))?.voidedAt).toBeDefined();
  });

  test("an over-cap typed receipt reference is refused with guidance that does not send the user to settings", async () => {
    const seed = await seedDeal("a3-ref");
    await seed.t.run((ctx) =>
      ctx.db.patch(seed.applicationId, { companyRuleSnapshot: { ruleVersion: 1, companyName: "X", feeTemplates: [template("Plates")] } as never })
    );
    let message = "";
    try {
      await record(seed, { receiptReference: "r".repeat(MAX_FEE_RECEIPT_REFERENCE_CHARS + 1) });
    } catch (error) {
      message = String((error as { data?: unknown }).data ?? error);
    }
    expect(message).toMatch(/at most 200 characters/);
    expect(message).not.toMatch(/settings/i);
    expect(await feeCount(seed)).toBe(0);
  });
});

describe("a4 - setFeeCustody checks the link patch even when no posting follows", () => {
  async function custodySeed(name: string, actualAmountMinor: number | undefined) {
    const seed = await seedDeal(name);
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });
    const feeId = await addFee(seed, { paidBy: "EMPLOYEE", actualAmountMinor });
    return { seed, custodyId, feeId };
  }
  const link = (s: { seed: Seed; custodyId: Id<"financeDealCustody">; feeId: Id<"financeDealFees"> }) =>
    s.seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: s.seed.orgId, feeId: s.feeId, custodyId: s.custodyId });

  test.each([
    ["no actual", undefined],
    ["zero actual", 0],
  ])("%s: one byte over is refused with nothing written; at the cap it links", async (_label, actual) => {
    const s = await custodySeed(`a4-${_label.replace(" ", "-")}`, actual);
    const extra = { custodyId: s.custodyId, updatedAt: Date.now() };
    const journalsBefore = await journalCount(s.seed);
    await padTo(s.seed, s.feeId, extra, 1);
    await expect(link(s)).rejects.toThrow(/too large to store/);
    expect((await rowOf(s.seed, s.feeId))?.custodyId).toBeUndefined();
    expect(await journalCount(s.seed)).toBe(journalsBefore);
    await padTo(s.seed, s.feeId, extra, 0);
    await link(s);
    expect((await rowOf(s.seed, s.feeId))?.custodyId).toBe(s.custodyId);
  });

  test("control, positive actual: one byte over is refused, at the cap it links", async () => {
    const s = await custodySeed("a4-positive", jod(50));
    const extra = { custodyId: s.custodyId, updatedAt: Date.now() };
    await padTo(s.seed, s.feeId, extra, 1);
    await expect(link(s)).rejects.toThrow(/too large to store/);
    expect((await rowOf(s.seed, s.feeId))?.custodyId).toBeUndefined();
  });
});