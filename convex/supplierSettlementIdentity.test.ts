/**
 * SCRUM-868 Phase 3: Canonical supplier identity for sale completion, settlement doors, and readers.
 *
 * Requirements & Invariants:
 * 1. SOURCED sale completion without vehicle.sourcedSupplierId fails closed (SUPPLIER_IDENTITY_UNRESOLVED) and writes 0 rows.
 * 2. SOURCED sale completion with valid vehicle.sourcedSupplierId succeeds:
 *    - THROUGH_DEALERSHIP writes supplierId and supplierSnapshotVersion to vehicleSupplierPayables; removes "Unknown supplier".
 *    - DIRECT_TO_SUPPLIER writes supplierId and supplierSnapshotVersion to vehicleSupplierReceivables; removes "Unknown supplier".
 * 3. Settlement doors require resolved supplierId (fail closed with SUPPLIER_IDENTITY_UNRESOLVED):
 *    - sourcingPayables.markPaid
 *    - sourcingPayables.recordPartialPayment
 *    - sourcingPayables.setDisputed
 *    - supplierReceivables.recordReceipt
 *    - supplierReceivables.setDisputed
 *    - supplierCostRecoveries.recordReceipt
 * 4. Inactive supplier allows settlement (author self-attack #4 / N10):
 *    - A deactivated supplier's open payable and open receivable can still be marked paid / collected.
 * 5. Aggregation grouping (author self-attack #2 / N2):
 *    - outstandingSummary groups by canonical supplierId:
 *      * Two suppliers with identical displayName group into two distinct entries.
 *      * One renamed supplier with multiple snapshot names groups into one entry with the combined balance.
 * 6. Concession basis (author self-attack #3 / N2):
 *    - resolveEffectiveEntitlementForCompletion requires matching supplierId on basis.
 * 7. Deal readers (dealCockpit):
 *    - Reads snapshot name from obligation record (payable or claim), not mutated vehicle name.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { seedSupplier, renameSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import {
  SUPPLIER_ERROR,
  SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE,
} from "./utils/supplierRegistry";
import {
  assertObservedBasisMatchesVehicle,
  resolveEffectiveEntitlementForCompletion,
  SUPPLIER_CONCESSION_REFUSALS,
} from "./utils/supplierConcession";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

async function setupTest(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Org ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_user`,
      email: `${tag}@example.test`,
      name: `User ${tag}`,
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" })
  );

  return { t, orgId, userId, customerId, asUser };
}

describe("SCRUM-868 Phase 3: Sale completion canonical supplier identity", () => {
  test("SOURCED sale completion without vehicle.sourcedSupplierId fails closed with SUPPLIER_IDENTITY_UNRESOLVED and writes 0 rows", async () => {
    const s = await setupTest("sale_no_supplier");

    // SOURCED car with name only (no sourcedSupplierId)
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINUNRESOLVED01",
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 1000,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 15_000,
        status: "AVAILABLE",
        sourceType: "SOURCED",
        sourcedFromName: "Legacy Name Only",
        sourceCost: 12_000,
      } as never)
    );

    const beforeSnapshot = await dbSnapshot(s.t, Object.keys(schema.tables));

    let thrown: unknown;
    try {
      await s.asUser.mutation(api.sales.create, {
        idempotencyKey: crypto.randomUUID(),
        orgId: s.orgId,
        vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 15_000,
        saleDate: Date.now(),
        status: "COMPLETED",
        supplierSettlementRoute: "THROUGH_DEALERSHIP",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { data?: { code?: string } }).data?.code).toBe(
      SUPPLIER_ERROR.IDENTITY_UNRESOLVED
    );
    expect((thrown as { data?: { message?: string } }).data?.message).toBe(
      SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE
    );

    // Assert 0 rows written across all tables
    const afterSnapshot = await dbSnapshot(s.t, Object.keys(schema.tables));
    expect(afterSnapshot).toEqual(beforeSnapshot);
  });

  test("SOURCED sale completion with resolved sourcedSupplierId writes supplierId and snapshot version (THROUGH & DIRECT)", async () => {
    const s = await setupTest("sale_with_supplier");

    const supplierId = await seedSupplier(s.t, {
      orgId: s.orgId,
      userId: s.userId,
      displayName: "Al-Safeer Trading Co",
      version: 2,
    });

    // 1. THROUGH_DEALERSHIP
    const v1Id = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINTHROUGH001",
        make: "Toyota",
        model: "RAV4",
        year: 2024,
        mileage: 1000,
        color: "Silver",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 20_000,
        status: "AVAILABLE",
        sourceType: "SOURCED",
        sourcedSupplierId: supplierId,
        sourcedFromName: "Al-Safeer Trading Co",
        sourceCost: 17_000,
      } as never)
    );

    const quote1Id = await s.asUser.mutation(api.quotes.saveQuote, {
      orgId: s.orgId,
      customerId: s.customerId,
      vehicleId: v1Id,
      vehiclePrice: 20_000,
      downPayment: 0,
      termMonths: 0,
    });
    await s.asUser.mutation(api.deposits.create, {
      method: "CASH",
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      quoteId: quote1Id,
      amount: 20_000,
    });

    await s.asUser.mutation(api.sales.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      vehicleId: v1Id,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 20_000,
      saleDate: Date.now(),
      status: "COMPLETED",
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
      quoteId: quote1Id,
    });

    const payables = await s.t.run((ctx) =>
      ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_org", (q) => q.eq("orgId", s.orgId))
        .collect()
    );
    expect(payables.length).toBe(1);
    expect(payables[0].supplierId).toBe(supplierId);
    expect(payables[0].supplierSnapshotVersion).toBe(2);
    expect(payables[0].sourcedFromName).toBe("Al-Safeer Trading Co");
    expect(payables[0].sourcedFromName).not.toBe("Unknown supplier");

    // 2. DIRECT_TO_SUPPLIER
    const v2Id = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINDIRECT001",
        make: "Nissan",
        model: "Patrol",
        year: 2024,
        mileage: 500,
        color: "Black",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 30_000,
        status: "AVAILABLE",
        sourceType: "SOURCED",
        sourcedSupplierId: supplierId,
        sourcedFromName: "Al-Safeer Trading Co",
        sourceCost: 26_000,
      } as never)
    );

    await s.asUser.mutation(api.sales.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      vehicleId: v2Id,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 30_000,
      saleDate: Date.now(),
      status: "COMPLETED",
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
    });

    const receivables = await s.t.run((ctx) =>
      ctx.db
        .query("vehicleSupplierReceivables")
        .withIndex("by_org", (q) => q.eq("orgId", s.orgId))
        .collect()
    );
    expect(receivables.length).toBe(1);
    expect(receivables[0].supplierId).toBe(supplierId);
    expect(receivables[0].supplierSnapshotVersion).toBe(2);
    expect(receivables[0].sourcedFromName).toBe("Al-Safeer Trading Co");
    expect(receivables[0].sourcedFromName).not.toBe("Unknown supplier");
  });
});

describe("SCRUM-868 Phase 3: Settlement doors fail closed without supplierId", () => {
  test("sourcingPayables doors fail closed when payable has no supplierId", async () => {
    const s = await setupTest("payable_settle_unresolved");

    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINPAY001",
        make: "Toyota",
        model: "Yaris",
        year: 2023,
        mileage: 5000,
        color: "Blue",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 10_000,
        status: "SOLD",
        sourceType: "SOURCED",
        sourcedFromName: "No Id Supplier",
        sourceCost: 8_000,
      } as never)
    );
    const saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 10_000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );
    const payableId = await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: s.orgId,
        vehicleId,
        saleId,
        sourcedFromName: "No Id Supplier",
        amountDue: 8_000,
        currency: "JOD",
        status: "PENDING",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    // markPaid fails
    await expect(
      s.asUser.mutation(api.sourcingPayables.markPaid, {
        orgId: s.orgId,
        payableId,
        paymentMethod: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE);

    // recordPartialPayment fails
    await expect(
      s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId: s.orgId,
        payableId,
        amount: 1000,
        paymentMethod: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE);

    // setDisputed fails
    await expect(
      s.asUser.mutation(api.sourcingPayables.setDisputed, {
        orgId: s.orgId,
        payableId,
        disputed: true,
        reason: "Cost dispute",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE);
  });

  test("supplierReceivables doors fail closed when claim has no supplierId", async () => {
    const s = await setupTest("receivable_settle_unresolved");

    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINREC001",
        make: "Toyota",
        model: "Corolla",
        year: 2023,
        mileage: 5000,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 12_000,
        status: "SOLD",
        sourceType: "SOURCED",
        sourcedFromName: "No Id Supplier",
        sourceCost: 10_000,
      } as never)
    );
    const saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 12_000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );
    const receivableId = await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId,
        vehicleId,
        saleId,
        sourcedFromName: "No Id Supplier",
        amountDue: 2_000,
        currency: "JOD",
        status: "OPEN",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    // recordReceipt fails
    await expect(
      s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId,
        receivableId,
        amount: 1000,
        receiptMethod: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE);

    // setDisputed fails
    await expect(
      s.asUser.mutation(api.supplierReceivables.setDisputed, {
        orgId: s.orgId,
        receivableId,
        disputed: true,
        reason: "Margin dispute",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE);
  });

  test("supplierCostRecoveries.recordReceipt fails closed when recovery has no supplierId", async () => {
    const s = await setupTest("recovery_settle_unresolved");

    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINCOST001",
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 10,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 15_000,
        status: "SOLD",
        sourceType: "SOURCED",
        sourcedFromName: "No Id Supplier",
        sourceCost: 12_000,
      } as never)
    );
    const expenseId = await s.t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId: s.orgId,
        vehicleId,
        title: "Transport cost",
        amount: 300,
        date: Date.now() - 60_000,
        category: "TRANSPORT",
        status: "PAID",
        paymentMethod: "CASH",
        costBearer: "SUPPLIER",
      } as never)
    );
    const recoveryId = await s.t.run((ctx) =>
      ctx.db.insert("supplierCostRecoveries", {
        orgId: s.orgId,
        vehicleId,
        expenseId,
        origin: "EXPENSE",
        sourcedFromName: "No Id Supplier",
        amountDueMinor: 300_000,
        amountRecoveredMinor: 0,
        currency: "JOD",
        receiptSeq: 0,
        status: "OPEN",
        sourceEventKey: `expense:${expenseId}:created`,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never)
    );

    await expect(
      s.asUser.mutation(api.supplierCostRecoveries.recordReceipt, {
        orgId: s.orgId,
        recoveryId,
        amountMinor: 300_000,
        method: "CASH",
        receivedDate: Date.now(),
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE);
  });
});

describe("SCRUM-868 Phase 3: Inactive supplier allows settlement (Author self-attack #4 / N10)", () => {
  test("deactivated supplier allows settlement of existing payable and receivable", async () => {
    const s = await setupTest("inactive_settle");

    const supplierId = await seedSupplier(s.t, {
      orgId: s.orgId,
      userId: s.userId,
      displayName: "Al-Safeer Trading Co",
      version: 1,
    });

    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VININACT001",
        make: "Kia",
        model: "K5",
        year: 2024,
        mileage: 100,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 16_000,
        status: "SOLD",
        sourceType: "SOURCED",
        sourcedSupplierId: supplierId,
        sourcedFromName: "Al-Safeer Trading Co",
        sourceCost: 13_000,
      } as never)
    );
    const saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 16_000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );

    const payableId = await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: s.orgId,
        vehicleId,
        saleId,
        supplierId,
        supplierSnapshotVersion: 1,
        sourcedFromName: "Al-Safeer Trading Co",
        amountDue: 13_000,
        currency: "JOD",
        status: "PENDING",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const receivableId = await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId,
        vehicleId,
        saleId,
        supplierId,
        supplierSnapshotVersion: 1,
        sourcedFromName: "Al-Safeer Trading Co",
        amountDue: 3_000,
        currency: "JOD",
        status: "OPEN",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    // Deactivate the supplier
    await s.t.run(async (ctx) => {
      await ctx.db.patch(supplierId, { status: "INACTIVE" });
    });

    // 1. Pay payable in full: MUST SUCCEED (not blocked by SUPPLIER_INACTIVE)
    await s.asUser.mutation(api.sourcingPayables.markPaid, {
      orgId: s.orgId,
      payableId,
      paymentMethod: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    const paidRow = await s.t.run((ctx) => ctx.db.get(payableId));
    expect(paidRow?.status).toBe("PAID");

    // 2. Receive receivable in full: MUST SUCCEED (not blocked by SUPPLIER_INACTIVE)
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId,
      amount: 3_000,
      receiptMethod: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    const receivedRow = await s.t.run((ctx) => ctx.db.get(receivableId));
    expect(receivedRow?.status).toBe("PAID");
  });
});

describe("SCRUM-868 Phase 3: outstandingSummary canonical grouping (Author self-attack #2 / N2)", () => {
  test("two suppliers with identical displayName group into two distinct entries", async () => {
    const s = await setupTest("summary_two_same_name");

    const s1Id = await seedSupplier(s.t, {
      orgId: s.orgId,
      userId: s.userId,
      displayName: "Duplicate Name Co",
      version: 1,
    });
    const s2Id = await seedSupplier(s.t, {
      orgId: s.orgId,
      userId: s.userId,
      displayName: "Duplicate Name Co",
      version: 1,
    });

    const v1 = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINSUM1",
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 10,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 15_000,
        status: "SOLD",
        sourceType: "SOURCED",
        sourcedSupplierId: s1Id,
        sourcedFromName: "Duplicate Name Co",
        sourceCost: 12_000,
      } as never)
    );
    const v2 = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINSUM2",
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 10,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 15_000,
        status: "SOLD",
        sourceType: "SOURCED",
        sourcedSupplierId: s2Id,
        sourcedFromName: "Duplicate Name Co",
        sourceCost: 12_000,
      } as never)
    );

    const sale1 = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId: v1,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 15_000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );
    const sale2 = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId: v2,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 15_000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );

    await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId,
        vehicleId: v1,
        saleId: sale1,
        supplierId: s1Id,
        supplierSnapshotVersion: 1,
        sourcedFromName: "Duplicate Name Co",
        amountDue: 3_000,
        currency: "JOD",
        status: "OPEN",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId,
        vehicleId: v2,
        saleId: sale2,
        supplierId: s2Id,
        supplierSnapshotVersion: 1,
        sourcedFromName: "Duplicate Name Co",
        amountDue: 2_000,
        currency: "JOD",
        status: "OPEN",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const summary = await s.asUser.query(api.supplierReceivables.outstandingSummary, {
      orgId: s.orgId,
    });
    expect(summary.totalOutstanding).toBe(5_000);
    // MUST NOT collapse into one entry!
    expect(summary.bySupplier.length).toBe(2);
    const ids = summary.bySupplier.map((x) => x.supplierId);
    expect(ids).toContain(s1Id);
    expect(ids).toContain(s2Id);
  });

  test("renamed supplier groups into one entry carrying the combined balance and snapshots", async () => {
    const s = await setupTest("summary_renamed");

    const supplierId = await seedSupplier(s.t, {
      orgId: s.orgId,
      userId: s.userId,
      displayName: "Original Supplier Name",
      version: 1,
    });

    const v1 = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINRENAME1",
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 10,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 15_000,
        status: "SOLD",
        sourceType: "SOURCED",
        sourcedSupplierId: supplierId,
        sourcedFromName: "Original Supplier Name",
        sourceCost: 12_000,
      } as never)
    );
    const sale1 = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId: v1,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 15_000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId,
        vehicleId: v1,
        saleId: sale1,
        supplierId,
        supplierSnapshotVersion: 1,
        sourcedFromName: "Original Supplier Name",
        amountDue: 3_000,
        currency: "JOD",
        status: "OPEN",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    // Rename supplier
    await renameSupplier(s.t, supplierId, "Renamed Supplier Name");

    // Second receivable with new snapshot
    const v2 = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINRENAME2",
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 10,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 15_000,
        status: "SOLD",
        sourceType: "SOURCED",
        sourcedSupplierId: supplierId,
        sourcedFromName: "Renamed Supplier Name",
        sourceCost: 12_000,
      } as never)
    );
    const sale2 = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId: v2,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 15_000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId,
        vehicleId: v2,
        saleId: sale2,
        supplierId,
        supplierSnapshotVersion: 2,
        sourcedFromName: "Renamed Supplier Name",
        amountDue: 4_000,
        currency: "JOD",
        status: "OPEN",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const summary = await s.asUser.query(api.supplierReceivables.outstandingSummary, {
      orgId: s.orgId,
    });
    expect(summary.totalOutstanding).toBe(7_000);
    // Must group under single supplier
    expect(summary.bySupplier.length).toBe(1);
    expect(summary.bySupplier[0].supplierId).toBe(supplierId);
    expect(summary.bySupplier[0].outstanding).toBe(7_000);
    expect(summary.bySupplier[0].claims).toBe(2);
    expect(summary.bySupplier[0].snapshots).toEqual(
      expect.arrayContaining(["Original Supplier Name", "Renamed Supplier Name"])
    );
  });
});

describe("SCRUM-868 Phase 3: Concession basis compares supplierId (Author self-attack #3 / N2)", () => {
  test("resolveEffectiveEntitlementForCompletion requires matching supplierId on basis", () => {
    const s1Id = "supplier_1" as Id<"suppliers">;
    const s2Id = "supplier_2" as Id<"suppliers">;

    const vehicle = {
      sourceType: "SOURCED" as const,
      sourceCost: 10_000,
      sourcedFromName: "Supplier One",
      sourcedSupplierId: s1Id,
    };

    // 1. Basis without supplierId throws BASIS_STALE
    expect(() =>
      resolveEffectiveEntitlementForCompletion({
        app: {
          vehicleId: "v1" as Id<"vehicles">,
          supplierGapShareMinor: 1_000_000,
          supplierGapBasis: {
            contractEntitlementMinor: 10_000_000,
            currency: "JOD",
            supplierName: "Supplier One",
          },
        },
        vehicle,
        currency: "JOD",
      })
    ).toThrow(SUPPLIER_CONCESSION_REFUSALS.BASIS_STALE);

    // 2. Basis with mismatched supplierId throws BASIS_STALE
    expect(() =>
      resolveEffectiveEntitlementForCompletion({
        app: {
          vehicleId: "v1" as Id<"vehicles">,
          supplierGapShareMinor: 1_000_000,
          supplierGapBasis: {
            contractEntitlementMinor: 10_000_000,
            currency: "JOD",
            supplierName: "Supplier One",
            supplierId: s2Id,
          },
        },
        vehicle,
        currency: "JOD",
      })
    ).toThrow(SUPPLIER_CONCESSION_REFUSALS.BASIS_STALE);

    // 3. Basis with matching supplierId succeeds
    const result = resolveEffectiveEntitlementForCompletion({
      app: {
        vehicleId: "v1" as Id<"vehicles">,
        supplierGapShareMinor: 1_000_000,
        supplierGapBasis: {
          contractEntitlementMinor: 10_000_000,
          currency: "JOD",
          supplierName: "Supplier One",
          supplierId: s1Id,
        },
      },
      vehicle,
      currency: "JOD",
    });
    expect(result.concessionMinor).toBe(1_000_000);
    expect(result.contractEntitlementMinor).toBe(10_000_000);
  });
});

describe("SCRUM-868 Phase 3: Deal readers (dealCockpit)", () => {
  test("dealCockpit returns snapshot name from obligation record rather than mutated vehicle", async () => {
    const s = await setupTest("cockpit_snapshot_reader");

    const supplierId = await seedSupplier(s.t, {
      orgId: s.orgId,
      userId: s.userId,
      displayName: "Original Snapshot Supplier",
      version: 1,
    });

    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VINCOCKPIT01",
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 10,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 15_000,
        status: "AVAILABLE",
        sourceType: "SOURCED",
        sourcedSupplierId: supplierId,
        sourcedFromName: "Original Snapshot Supplier",
        sourceCost: 12_000,
      } as never)
    );

    const saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 15_000,
        saleDate: Date.now(),
        status: "COMPLETED",
        supplierSettlementRoute: "THROUGH_DEALERSHIP",
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: s.orgId,
        vehicleId,
        saleId,
        supplierId,
        supplierSnapshotVersion: 1,
        sourcedFromName: "Original Snapshot Supplier",
        amountDue: 12_000,
        currency: "JOD",
        status: "DUE_ON_SALE",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    // Mutate the vehicle's sourcedFromName (simulating legacy drift or admin edit)
    await s.t.run(async (ctx) => {
      await ctx.db.patch(vehicleId, { sourcedFromName: "Mutated Vehicle Supplier Name" });
    });

    const cockpit = await s.asUser.query(api.sales.dealCockpit, {
      orgId: s.orgId,
      saleId,
    });

    expect(cockpit).toBeDefined();
    expect(cockpit?.vehicle?.supplierName).toBe("Original Snapshot Supplier");
  });
});
