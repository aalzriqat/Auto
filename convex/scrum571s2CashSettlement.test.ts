/**
 * SCRUM-571 slice 2a (D-43), CASH route: a cash sale must never read as settled while its canonical
 * customer invoice has a balance. `sales.create` issues the invoice for the full billable amount and
 * requires no payment, so a COMPLETED cash sale with an open invoice is a normal, reachable state
 * (saleCompletion.ts creates the invoice unconditionally and nothing gates completion on payment).
 *
 * The sale is created through the real mutation and read through the real `sales.dealCockpit`.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { payInvoice } from "../test-utils/saleInvoiceFixtures";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { getReceivableOutstandingMinor } from "./subledger";
import { reservePendingInvoiceReceipt } from "./accounting/invoiceReceiptReservation";

// SCRUM-802 legacy-cash-lifecycle opt-out. Audited with the real switch (SCRUM-802 Option A): the 12 cells that
// fail are SETTLEMENT-READER cells (cockpit settlement state, invoice summary, no-GL readiness) that need an OPEN or
// part-paid cash invoice, the legacy shape that completion can no longer leave open. They read state that existing
// data may still hold; none asserts unlinked-receipt or partial-cash completion behaviour (those are pinned with the
// real switch in scrum802CashSaleContainment.test.ts and scrum761CashReceiptDoors.test.ts). The census in
// convex/scrum802OptOutCensus.test.ts allows only the listed files.
vi.mock("./utils/saleDebtContainment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/saleDebtContainment")>()),
  CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: false,
}));

// SCRUM-968: the release door ships dark with the invoice-receipt lifecycle. The shipped value is `true`; tests of
// the release behaviour switch it off per test, and `afterEach` restores the production value.
const pilot = vi.hoisted(() => ({ payoutDisabled: true, invoiceDoorsDisabled: true }));
vi.mock("./utils/customerCreditPayoutContainment", async (importOriginal) =>
  (await import("../test-utils/pilotSwitchMock")).pilotSwitchModule(await importOriginal(), pilot));
afterEach(() => { pilot.invoiceDoorsDisabled = true; });

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

interface CashSaleOpts {
  /** false: a Free/Starter organization that never initialized a chart of accounts. */
  chart?: boolean;
  /** false: a chart-ready organization with no open period covering the sale date. */
  openPeriod?: boolean;
}

async function seedCashSale(tag: string, opts: CashSaleOpts = {}) {
  const chart = opts.chart ?? true;
  const openPeriod = opts.openPeriod ?? true;
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S2 cash ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Cash User" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  const as = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  if (chart) await as.mutation(api.chartOfAccounts.initialize, { orgId });
  if (chart && openPeriod) {
    const fiscalYear = new Date().getUTCFullYear();
    await as.mutation(api.accountingPeriods.create, {
      orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear, periodNumber: 1,
    });
    const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
    await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINCASH${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10, color: "Blue",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 13_000, status: "AVAILABLE",
      sourceType: "STOCK" as const, purchasePrice: 10_000,
    })
  );
  const saleId = await as.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: 13_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
  });
  return { t, as, orgId, userId, customerId, saleId, tag };
}

async function payInFull(s: Awaited<ReturnType<typeof seedCashSale>>) {
  await s.t.run(async (ctx) => {
    const sale = (await ctx.db.get(s.saleId))!;
    await payInvoice(ctx, {
      orgId: s.orgId, userId: s.userId, customerId: s.customerId,
      receivableId: sale.canonicalReceivableDocumentId!, amountMinor: 13_000_000,
    });
  });
}

async function settlementStage(s: Awaited<ReturnType<typeof seedCashSale>>) {
  const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
  return deal!.stages.find((st) => st.key === "SETTLEMENT")!.state;
}

async function outstandingMinor(s: Awaited<ReturnType<typeof seedCashSale>>) {
  return await s.t.run(async (ctx) => {
    const sale = (await ctx.db.get(s.saleId))!;
    return await getReceivableOutstandingMinor(ctx, sale.canonicalReceivableDocumentId!);
  });
}

test("a finance operator can release a pending invoice claim without returning or applying the receipt", async () => {
  pilot.invoiceDoorsDisabled = false;
  const s = await seedCashSale("release_pending");
  const { orgId, saleId } = s;
  const collectionPaymentId = await s.as.mutation(api.collections.recordPayment, {
    orgId, customerId: s.customerId, amount: 3_000,
    method: "CASH", paymentDate: Date.now(), idempotencyKey: "existing-legacy-receipt",
  });
  const { applicationId, movementId, positionId } = await s.t.run(async (ctx) => {
    const movement = await ctx.db.query("receiptMovements")
      .withIndex("by_org_payment", (q) => q.eq("orgId", orgId).eq("collectionPaymentId", collectionPaymentId))
      .unique();
    if (!movement) throw new Error("Expected a posted receipt movement");
    const position = await ctx.db.query("receiptRetainedPositions")
      .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", movement._id))
      .unique();
    if (!position) throw new Error("Expected a retained position");
    const applicationId = await reservePendingInvoiceReceipt(ctx, {
      orgId, saleId, receiptMovementId: movement._id, amountMinor: 3_000_000, actorId: s.userId,
    });
    return { applicationId, movementId: movement._id, positionId: position._id };
  });
  const amounts = () => s.as.query(api.collections.saleInvoiceReceiptStatus, {
    orgId, saleId, paginationOpts: { numItems: 10, cursor: null },
  });
  await expect(amounts()).resolves.toMatchObject({
    saleInvoiceDoorsAvailable: true, pendingClaimReleaseAvailable: true,
    invoice: { outstandingMinor: 13_000_000, availableToReserveMinor: 10_000_000 },
  });
  const release = { orgId, saleId, applicationId };
  await expect(s.t.withIdentity({ subject: "not-a-member" }).mutation(
    api.collections.releaseSaleInvoiceReceipt, release,
  )).rejects.toThrow();
  await expect(s.as.mutation(api.collections.releaseSaleInvoiceReceipt, release)).resolves.toBeNull();
  const saved = await s.t.run((ctx) => ctx.db.get(applicationId));
  expect(saved).toMatchObject({ status: "CANCELLED", cancelledBy: s.userId });
  await expect(s.as.mutation(api.collections.releaseSaleInvoiceReceipt, release)).resolves.toBeNull();
  await expect(s.t.run((ctx) => ctx.db.get(applicationId))).resolves.toEqual(saved);
  await expect(s.t.run((ctx) => ctx.db.get(positionId))).resolves.toMatchObject({
    receiptMovementId: movementId, remainingUnappliedMinor: 3_000_000,
  });
  await expect(amounts()).resolves.toMatchObject({
    page: [], invoice: { outstandingMinor: 13_000_000, availableToReserveMinor: 13_000_000 },
  });
});

describe("SCRUM-968: releasing an unactivated invoice claim", () => {
  beforeEach(() => { pilot.invoiceDoorsDisabled = false; });

  async function reserveClaim(s: Awaited<ReturnType<typeof seedCashSale>>) {
    const paymentId = await s.as.mutation(api.collections.recordPayment, {
      orgId: s.orgId, customerId: s.customerId, amount: 3_000,
      method: "CASH", paymentDate: Date.now(), idempotencyKey: `receipt-${s.tag}`,
    });
    return await s.t.run(async (ctx) => {
      const movement = await ctx.db.query("receiptMovements")
        .withIndex("by_org_payment", (q) => q.eq("orgId", s.orgId).eq("collectionPaymentId", paymentId)).unique();
      if (!movement) throw new Error("Expected a posted receipt movement");
      const position = await ctx.db.query("receiptRetainedPositions")
        .withIndex("by_org_movement", (q) => q.eq("orgId", s.orgId).eq("receiptMovementId", movement._id)).unique();
      if (!position) throw new Error("Expected a retained position");
      const applicationId = await reservePendingInvoiceReceipt(ctx, {
        orgId: s.orgId, saleId: s.saleId, receiptMovementId: movement._id, amountMinor: 3_000_000, actorId: s.userId,
      });
      return { applicationId, positionId: position._id };
    });
  }

  async function outsider(s: Awaited<ReturnType<typeof seedCashSale>>, tag: string, permissions: string[]) {
    return await s.t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: `Other ${tag}`, createdAt: Date.now() });
      await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
      const userId = await ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: tag });
      const roleId = await ctx.db.insert("roles", { orgId, name: "Other", permissions });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      return { orgId, userId, clerkId: `${tag}_u` };
    });
  }

  test("a member of another organization cannot release this organization's claim", async () => {
    const s = await seedCashSale("release_wrong_org");
    const { applicationId, positionId } = await reserveClaim(s);
    const other = await outsider(s, "intruder", ["manage:finance", "view:sales"]);
    const asOther = s.t.withIdentity({ subject: other.clerkId, clerkId: other.clerkId });
    const before = await s.t.run((ctx) => ctx.db.get(applicationId));
    const position = await s.t.run((ctx) => ctx.db.get(positionId));
    // Their own org is authorised, but the row and the sale are not theirs.
    await expect(asOther.mutation(api.collections.releaseSaleInvoiceReceipt, {
      orgId: other.orgId, saleId: s.saleId, applicationId,
    })).rejects.toBeInstanceOf(ConvexError);
    // This organization's id is refused at the membership check, by code.
    await expect(asOther.mutation(api.collections.releaseSaleInvoiceReceipt, {
      orgId: s.orgId, saleId: s.saleId, applicationId,
    })).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
    await expect(s.t.run((ctx) => ctx.db.get(applicationId))).resolves.toEqual(before);
    await expect(s.t.run((ctx) => ctx.db.get(positionId))).resolves.toEqual(position);
  });

  test("a member without MANAGE_FINANCE is refused and the claim stays pending", async () => {
    const s = await seedCashSale("release_no_permission");
    const { applicationId } = await reserveClaim(s);
    const viewerId = await s.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "viewer_u", email: "viewer@e.com", name: "Viewer" });
      const roleId = await ctx.db.insert("roles", { orgId: s.orgId, name: "Viewer", permissions: ["view:sales"] });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
      return userId;
    });
    expect(viewerId).toBeTruthy();
    const asViewer = s.t.withIdentity({ subject: "viewer_u", clerkId: "viewer_u" });
    await expect(asViewer.mutation(api.collections.releaseSaleInvoiceReceipt, {
      orgId: s.orgId, saleId: s.saleId, applicationId,
    })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(s.t.run((ctx) => ctx.db.get(applicationId))).resolves.toMatchObject({ status: "PENDING" });
  });

  test("an activated claim is refused and keeps its status, allocation and credit", async () => {
    const s = await seedCashSale("release_active");
    const { applicationId, positionId } = await reserveClaim(s);
    const position = await s.t.run((ctx) => ctx.db.get(positionId));
    await s.t.run((ctx) => ctx.db.patch(applicationId, { status: "ACTIVE", activatedAt: Date.now() }));
    const active = await s.t.run((ctx) => ctx.db.get(applicationId));
    await expect(s.as.mutation(api.collections.releaseSaleInvoiceReceipt, {
      orgId: s.orgId, saleId: s.saleId, applicationId,
    })).rejects.toMatchObject({ data: { code: "VALIDATION_FAILED" } });
    await expect(s.t.run((ctx) => ctx.db.get(applicationId))).resolves.toEqual(active);
    await expect(s.t.run((ctx) => ctx.db.get(positionId))).resolves.toEqual(position);
  });

  test("release keeps the retained credit amount and a retry leaves one cancellation record", async () => {
    const s = await seedCashSale("release_credit");
    const { applicationId, positionId } = await reserveClaim(s);
    const creditBefore = await s.t.run((ctx) => ctx.db.get(positionId));
    const eventsBefore = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
    const release = { orgId: s.orgId, saleId: s.saleId, applicationId };
    await s.as.mutation(api.collections.releaseSaleInvoiceReceipt, release);
    const cancelled = await s.t.run((ctx) => ctx.db.get(applicationId));
    await s.as.mutation(api.collections.releaseSaleInvoiceReceipt, release);
    const creditAfter = await s.t.run((ctx) => ctx.db.get(positionId));
    expect(creditAfter).toMatchObject({
      remainingUnappliedMinor: creditBefore?.remainingUnappliedMinor,
      initialUnappliedMinor: creditBefore?.initialUnappliedMinor,
    });
    expect(creditBefore?.remainingUnappliedMinor).toBe(3_000_000);
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelledBy: s.userId });
    // The retry changed nothing: same cancelledAt, no new money events.
    await expect(s.t.run((ctx) => ctx.db.get(applicationId))).resolves.toEqual(cancelled);
    await expect(s.t.run((ctx) => ctx.db.query("accountingEvents").collect())).resolves.toHaveLength(eventsBefore.length);
    await expect(s.t.run((ctx) => ctx.db.query("invoiceReceiptApplications")
      .withIndex("by_org_sale_status", (q) => q.eq("orgId", s.orgId).eq("saleId", s.saleId).eq("status", "CANCELLED"))
      .collect())).resolves.toHaveLength(1);
  });

  type Seeded = Awaited<ReturnType<typeof seedCashSale>>;
  const everyTable = () => Object.keys(schema.tables);
  // The durable accounting outbox (accountingOutbox.schema.ts) is `pendingAccountingEvents`.
  const outboxTables = () => everyTable().filter((name) => name === "pendingAccountingEvents");
  const release = (s: Seeded, applicationId: Id<"invoiceReceiptApplications">, saleId: Id<"sales"> = s.saleId) =>
    s.as.mutation(api.collections.releaseSaleInvoiceReceipt, { orgId: s.orgId, saleId, applicationId });
  const scheduled = (s: Seeded) => s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

  /** The refused call must leave every table and the scheduler byte-for-byte as it found them. */
  async function expectRefusedUnchanged(s: Seeded, call: () => Promise<unknown>, code: string) {
    const before = { tables: await dbSnapshot(s.t, everyTable()), scheduled: await scheduled(s) };
    await expect(call()).rejects.toMatchObject({ data: { code } });
    expect({ tables: await dbSnapshot(s.t, everyTable()), scheduled: await scheduled(s) }).toEqual(before);
  }

  test("with the shipped switch value the door is refused, nothing changes, and release is not offered", async () => {
    const s = await seedCashSale("release_dark");
    const { applicationId } = await reserveClaim(s);
    pilot.invoiceDoorsDisabled = true;
    await expectRefusedUnchanged(s, () => release(s, applicationId), "SALE_INVOICE_RECEIPT_DOORS_DISABLED");
    await expect(s.t.run((ctx) => ctx.db.get(applicationId))).resolves.toMatchObject({ status: "PENDING" });
    await expect(s.as.query(api.collections.saleInvoiceReceiptStatus, {
      orgId: s.orgId, saleId: s.saleId, paginationOpts: { numItems: 10, cursor: null },
    })).resolves.toMatchObject({ saleInvoiceDoorsAvailable: false, pendingClaimReleaseAvailable: false });
  });

  test("a sale that does not own the application is refused and nothing changes", async () => {
    const s = await seedCashSale("release_other_sale");
    const { applicationId } = await reserveClaim(s);
    const otherSaleId = await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = (await ctx.db.get(s.saleId))!;
      void _id; void _creationTime;
      return await ctx.db.insert("sales", copy);
    });
    await expectRefusedUnchanged(s, () => release(s, applicationId, otherSaleId), "VALIDATION_FAILED");
  });

  test("a deleted sale is refused and nothing changes", async () => {
    const s = await seedCashSale("release_deleted_sale");
    const { applicationId } = await reserveClaim(s);
    await s.t.run((ctx) => ctx.db.patch(s.saleId, { isDeleted: true }));
    await expectRefusedUnchanged(s, () => release(s, applicationId), "VALIDATION_FAILED");
  });

  test.each(["activatedAt", "allocationId", "activationEventId"] as const)(
    "an ACTIVE claim is refused through its %s and nothing changes", async (marker) => {
      const s = await seedCashSale(`release_active_${marker}`);
      const { applicationId } = await reserveClaim(s);
      await s.t.run(async (ctx) => {
        const now = Date.now();
        if (marker === "activatedAt") return await ctx.db.patch(applicationId, { status: "ACTIVE", activatedAt: now });
        if (marker === "activationEventId") {
          const event = await ctx.db.query("accountingEvents").first();
          if (!event) throw new Error("Expected an accounting event to point at");
          return await ctx.db.patch(applicationId, { status: "ACTIVE", activationEventId: event._id });
        }
        const application = (await ctx.db.get(applicationId))!;
        const paymentId = await ctx.db.insert("canonicalPayments", {
          orgId: s.orgId, direction: "IN", payerType: "CUSTOMER", customerId: s.customerId, method: "CASH",
          amountMinor: 1, currency: "JOD", scale: 3, status: "SETTLED", idempotencyKey: `alloc-${s.tag}`,
          createdBy: s.userId, createdAt: now,
        });
        const allocationId = await ctx.db.insert("paymentAllocations", {
          orgId: s.orgId, paymentId, receivableDocumentId: application.receivableDocumentId, amountMinor: 1,
          currency: "JOD", scale: 3, allocationDate: now, status: "ACTIVE", createdBy: s.userId, createdAt: now,
        });
        return await ctx.db.patch(applicationId, { status: "ACTIVE", allocationId });
      });
      await expectRefusedUnchanged(s, () => release(s, applicationId), "VALIDATION_FAILED");
    });

  test("a REVERSED claim is refused with a coded error and nothing changes", async () => {
    const s = await seedCashSale("release_reversed");
    const { applicationId } = await reserveClaim(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { status: "REVERSED" }));
    await expectRefusedUnchanged(s, () => release(s, applicationId), "VALIDATION_FAILED");
  });

  test("a successful release adds no outbox row, event or scheduled function", async () => {
    const s = await seedCashSale("release_no_outbox");
    const { applicationId } = await reserveClaim(s);
    const outboxBefore = await dbSnapshot(s.t, outboxTables());
    const eventsBefore = await dbSnapshot(s.t, ["accountingEvents"]);
    const scheduledBefore = await scheduled(s);
    await expect(release(s, applicationId)).resolves.toBeNull();
    expect(outboxTables().length).toBeGreaterThan(0);
    await expect(dbSnapshot(s.t, outboxTables())).resolves.toEqual(outboxBefore);
    await expect(dbSnapshot(s.t, ["accountingEvents"])).resolves.toEqual(eventsBefore);
    await expect(scheduled(s)).resolves.toEqual(scheduledBefore);
  });
});
describe("SCRUM-571 s2a: the cash cockpit judges the customer's invoice too", () => {
  test("a completed cash sale whose invoice is open is NOT settled", async () => {
    const s = await seedCashSale("open");
    // The premise: completion left the whole invoice outstanding.
    expect(await outstandingMinor(s)).toBe(13_000_000);
    expect(await settlementStage(s)).not.toBe("COMPLETE");
  });

  test("control: the same sale reads settled once the customer has paid the invoice in full", async () => {
    const s = await seedCashSale("paid");
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(s.saleId))!;
      await payInvoice(ctx, {
        orgId: s.orgId, userId: s.userId, customerId: s.customerId,
        receivableId: sale.canonicalReceivableDocumentId!, amountMinor: 13_000_000,
      });
    });
    expect(await outstandingMinor(s)).toBe(0);
    expect(await settlementStage(s)).toBe("COMPLETE");
  });
});

/**
 * SCRUM-571 D-48: the posting proof is required exactly when the sale was completed under a general
 * ledger. Free/Starter organizations have no chart, so their SALE_COMPLETED is only queued and can
 * never post; a fully paid sale there must still read settled.
 */
describe("SCRUM-571 D-48: the posting proof follows the chart state at completion", () => {
  test("a no-chart (Free/Starter) cash sale whose invoice is paid in full reads settled", async () => {
    const s = await seedCashSale("nochart_paid", { chart: false });
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(s.saleId))!;
      expect(sale.glPostingRequired).toBe(false);
    });
    await payInFull(s);
    expect(await outstandingMinor(s)).toBe(0);
    expect(await settlementStage(s)).toBe("COMPLETE");
  });

  test("control: the same no-chart sale with an open invoice is NOT settled", async () => {
    const s = await seedCashSale("nochart_open", { chart: false });
    expect(await outstandingMinor(s)).toBe(13_000_000);
    expect(await settlementStage(s)).not.toBe("COMPLETE");
  });

  test("control: a chart-ready org with no open period still requires the proof, so a paid sale is not settled until the event posts", async () => {
    const s = await seedCashSale("chart_noperiod", { openPeriod: false });
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(s.saleId))!;
      // The chart only, never the period: the books are owed this sale.
      expect(sale.glPostingRequired).toBe(true);
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", s.orgId).eq("idempotencyKey", `sale_completed_${s.saleId}`))
        .first();
      expect(event?.status).not.toBe("POSTED");
    });
    await payInFull(s);
    expect(await outstandingMinor(s)).toBe(0);
    expect(await settlementStage(s)).not.toBe("COMPLETE");
  });

  test("the upgrade case: initializing a chart AFTER a paid no-GL sale does not flip it to unproven", async () => {
    const s = await seedCashSale("upgrade", { chart: false });
    await payInFull(s);
    expect(await settlementStage(s)).toBe("COMPLETE");
    await s.as.mutation(api.chartOfAccounts.initialize, { orgId: s.orgId });
    expect(await settlementStage(s)).toBe("COMPLETE");
  });

  test("a legacy sale with no glPostingRequired and no posted event fails closed", async () => {
    const s = await seedCashSale("legacy", { chart: false });
    await payInFull(s);
    await s.t.run((ctx) => ctx.db.patch(s.saleId, { glPostingRequired: undefined }));
    expect(await settlementStage(s)).not.toBe("COMPLETE");
  });
});

/**
 * SCRUM-571 D-48 (F4): whenever the invoice is open the cockpit names that customer balance, behind
 * the existing view:finance projection. Users without it get the qualitative state only.
 */
describe("SCRUM-571 D-48: the cockpit names the customer's invoice balance", () => {
  async function asViewerWithoutFinance(s: Awaited<ReturnType<typeof seedCashSale>>) {
    const viewerId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `${s.tag}_viewer`, email: `${s.tag}.v@e.com`, name: "Viewer" })
    );
    const roleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: s.orgId, name: "SALES", permissions: ["view:sales"], isSystemOwnerRole: false })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId: viewerId, roleId }));
    return s.t.withIdentity({ subject: `${s.tag}_viewer`, clerkId: `${s.tag}_viewer` });
  }

  test("an open invoice is named with its outstanding amount for a view:finance caller", async () => {
    const s = await seedCashSale("f4_open");
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal!.customerInvoiceState).toBe("OPEN");
    expect(deal!.money!.customerInvoice).toEqual({ state: "OPEN", outstandingMinor: 13_000_000, currency: "JOD" });
  });

  test("a part-paid invoice names the remaining balance, not the face value", async () => {
    const s = await seedCashSale("f4_part");
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(s.saleId))!;
      await payInvoice(ctx, {
        orgId: s.orgId, userId: s.userId, customerId: s.customerId,
        receivableId: sale.canonicalReceivableDocumentId!, amountMinor: 5_000_000,
      });
    });
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal!.money!.customerInvoice.outstandingMinor).toBe(8_000_000);
  });

  test("a paid invoice reads CLOSED with nothing outstanding", async () => {
    const s = await seedCashSale("f4_paid");
    await payInFull(s);
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal!.money!.customerInvoice).toEqual({ state: "CLOSED", outstandingMinor: 0, currency: "JOD" });
  });

  test("a cancelled cash sale describes no invoice: NONE (parity with the financed cockpit)", async () => {
    const s = await seedCashSale("f4_cancelled");
    await payInFull(s);
    await s.t.run((ctx) => ctx.db.patch(s.saleId, { status: "CANCELLED" }));
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal!.customerInvoiceState).toBe("NONE");
    expect(deal!.money!.customerInvoice).toEqual({ state: "NONE", outstandingMinor: null, currency: "JOD" });
  });

  test("a caller without view:finance gets the qualitative state and no amount", async () => {
    const s = await seedCashSale("f4_redact");
    const viewer = await asViewerWithoutFinance(s);
    const deal = await viewer.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal).not.toBeNull();
    expect(deal!.customerInvoiceState).toBe("OPEN");
    expect(deal!.money).toBeNull();
  });
});
