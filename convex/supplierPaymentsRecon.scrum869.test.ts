/**
 * SCRUM-869 per-supplier payments reconciliation to GL 2400 (ADR docs/adr/2026-11-04-supplier-payments-gl-reconciliation.md).
 * Hand computation (JOD, 3 decimals): entitlement 9_500 JOD = 9_500_000 minor; one instalment of 4_000 JOD = 4_000_000 minor
 * is debited to 2400 by SUPPLIER_PAYMENT_SETTLED against the payable. Evidence boundary: convex-test only, seeded data.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { STATEMENT_FAMILY_LIMIT } from "./utils/supplierObligationDue";

vi.mock("./utils/saleDebtContainment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/saleDebtContainment")>()),
  CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: false,
}));

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales", "view:cost_price",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "approve:requests",
];

const SALE_PRICE = 12_500;
const ENTITLEMENT = 9_500;

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `RC ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "RC User" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const supplierId = await t.run((ctx) =>
    ctx.db.insert("suppliers", {
      orgId, displayName: "Amman Importer Co", displayNameKey: "amman importer co", status: "ACTIVE", version: 1,
      origin: "MANUAL", createdBy: userId, createdAt: Date.now(), updatedBy: userId, updatedAt: Date.now(),
    })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINRC${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White", fuelType: "Gas",
      transmission: "Auto", sellingPrice: SALE_PRICE, status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT, sourcedSupplierId: supplierId,
    })
  );
  await asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId, salePrice: SALE_PRICE,
    saleDate: Date.now(), status: "COMPLETED" as const, supplierSettlementRoute: "THROUGH_DEALERSHIP" as const,
  });
  const payable = (await t.run((ctx) => ctx.db.query("vehicleSupplierPayables").collect()))[0]!;
  return { t, orgId, userId, asUser, vehicleId, payable, supplierId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const recon = (s: Seed, supplierId = s.supplierId) =>
  s.asUser.query(api.supplierStatement.paymentsReconciliation, { orgId: s.orgId, supplierId });

const pay = (s: Seed, amount: number) =>
  s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, payableId: s.payable._id, amount, paymentMethod: "CASH",
  });

describe("SCRUM-869 per-supplier payments reconciliation", () => {
  test("a real partial payment reconciles: subledger and GL both show 4_000_000; the credit side is not attributable", async () => {
    const s = await seed("ok");
    await pay(s, 4_000);
    const r = await recon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.currencies).toEqual([
      { currency: "JOD", subledgerPaidMinor: 4_000_000, glPaidMinor: 4_000_000, differenceMinor: 0 },
    ]);
    expect(r.isReconciled).toBe(true);
    expect(r.differences).toEqual([]);
    expect(r.creditSide).toBe("NOT_ATTRIBUTABLE");
    expect(r.excludedOpeningRows).toBe(0);
    expect(Object.keys(r).sort()).toEqual(
      ["creditSide", "currencies", "differences", "excludedOpeningRows", "isReconciled", "status", "supplierId"].sort()
    );
  });

  test("no payment yet: nothing to compare, reconciled, no currencies", async () => {
    const s = await seed("none");
    const r = await recon(s);
    expect(r).toMatchObject({ status: "AVAILABLE", currencies: [], isReconciled: true, differences: [] });
  });

  test("a subledger payment the GL never saw is a named difference, not hidden", async () => {
    const s = await seed("drift");
    await pay(s, 4_000);
    await s.t.run((ctx) => ctx.db.patch(s.payable._id, { amountPaid: 5_000 }));
    const r = await recon(s);
    expect(r.isReconciled).toBe(false);
    expect(r.currencies).toEqual([
      { currency: "JOD", subledgerPaidMinor: 5_000_000, glPaidMinor: 4_000_000, differenceMinor: 1_000_000 },
    ]);
    expect(r.differences).toEqual([
      { payableId: s.payable._id, currency: "JOD", subledgerPaidMinor: 5_000_000, glPaidMinor: 4_000_000 },
    ]);
  });

  test("another supplier's payable and its payments are not counted", async () => {
    const s = await seed("other");
    await pay(s, 4_000);
    const otherId = await s.t.run((ctx) =>
      ctx.db.insert("suppliers", {
        orgId: s.orgId, displayName: "Other Co", displayNameKey: "other co", status: "ACTIVE", version: 1,
        origin: "MANUAL", createdBy: s.userId, createdAt: Date.now(), updatedBy: s.userId, updatedAt: Date.now(),
      })
    );
    const r = await recon(s, otherId);
    expect(r).toMatchObject({ status: "AVAILABLE", currencies: [], isReconciled: true });
  });

  test("an opening-basis payable is excluded from both sides and counted", async () => {
    const s = await seed("open");
    await pay(s, 4_000);
    await s.t.run(async (ctx) => {
      const draftId = await ctx.db.insert("openingBalanceDrafts", {
        orgId: s.orgId, status: "POSTED", lines: [], asOfDate: Date.now(), createdBy: s.userId, createdAt: Date.now(), currency: "JOD",
      } as never);
      await ctx.db.insert("vehicleSupplierPayables", {
        orgId: s.orgId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co", amountDue: 2_000,
        amountPaid: 500, currency: "JOD", status: "PARTIALLY_PAID", origin: "OPENING", openingBalanceDraftId: draftId,
        openingRowKey: "r1", openingKind: "SUPPLIER_PAYABLE", title: "Opening", createdBy: s.userId,
        createdAt: Date.now(), updatedAt: Date.now(),
      } as never);
    });
    const r = await recon(s);
    expect(r.excludedOpeningRows).toBe(1);
    expect(r.currencies).toEqual([
      { currency: "JOD", subledgerPaidMinor: 4_000_000, glPaidMinor: 4_000_000, differenceMinor: 0 },
    ]);
  });

  test("a queued AP-affecting posting makes the answer unavailable, never reconciled", async () => {
    const s = await seed("queued");
    await pay(s, 4_000);
    await s.t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId: s.orgId, kind: "POST", status: "PENDING", idempotencyKey: "q1", accountingDate: Date.now(), actorId: s.userId,
        attempts: 0, createdAt: Date.now(), eventType: "SUPPLIER_PAYMENT_SETTLED", sourceType: "vehicleSupplierPayables", sourceId: "x", currency: "JOD",
        payload: {},
      } as never)
    );
    const r = await recon(s);
    expect(r).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "PENDING_POSTINGS", isReconciled: false, currencies: [] });
  });

  test("more payables than the read bound is unavailable (OVER_LIMIT), never a partial sum", async () => {
    const s = await seed("bound");
    await s.t.run(async (ctx) => {
      for (let i = 0; i < STATEMENT_FAMILY_LIMIT + 1; i++) {
        await ctx.db.insert("vehicleSupplierPayables", {
          orgId: s.orgId, vehicleId: s.vehicleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co", amountDue: 1,
          amountPaid: 1, currency: "JOD", status: "PAID", createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
        } as never);
      }
    });
    const r = await recon(s);
    expect(r).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "OVER_LIMIT", isReconciled: false, currencies: [] });
  });

  test("tenancy: another organization cannot read this supplier", async () => {
    const s = await seed("tenant");
    // Ids repeat across harnesses, so the second organization lives in the same database.
    const otherOrgId = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "RC other", createdAt: Date.now() }));
    await s.t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId: otherOrgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
    const otherUserId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "other_u", email: "o@e.com", name: "Other" }));
    const otherRoleId = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: otherOrgId, name: "Owner", permissions: PERMS }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRoleId }));
    const asOther = s.t.withIdentity({ subject: "other_u", clerkId: "other_u" });
    await expect(
      asOther.query(api.supplierStatement.paymentsReconciliation, { orgId: otherOrgId, supplierId: s.supplierId })
    ).rejects.toThrow();
    await expect(
      asOther.query(api.supplierStatement.paymentsReconciliation, { orgId: s.orgId, supplierId: s.supplierId })
    ).rejects.toThrow();
  });
});
