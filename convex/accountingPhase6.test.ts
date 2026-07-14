/**
 * Phase 6 tests: migration audit tooling — gap analysis, duplicate detection,
 * dry-run migration, and legacy transaction classification.
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedMigrationDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Migration Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "mig_user", email: "mig@example.com", name: "Mig User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:sales", "manage:finance", "view:finance", "create:vehicles", "view:vehicles"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );
  const asUser = t.withIdentity({ subject: "mig_user", clerkId: "mig_user" });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, asUser };
}

describe("Phase 6 — gap analysis", () => {
  test("fresh org shows 100% migration progress (nothing to migrate)", async () => {
    const { orgId, asUser } = await seedMigrationDealer();
    const gap = await asUser.query(api.accountingMigration.migrationGapAnalysis, { orgId });
    expect(gap.migrationProgress).toBe(100);
    expect(gap.legacy.transactions).toBe(0);
    expect(gap.gl.events).toBe(0);
  });

  test("legacy transaction creates a migration gap", async () => {
    const { t, orgId, asUser } = await seedMigrationDealer();

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 250, date: Date.now(),
        category: "EXPENSE", description: "Legacy rent", idempotencyKey: "leg_rent_001",
      })
    );

    const gap = await asUser.query(api.accountingMigration.migrationGapAnalysis, { orgId });
    expect(gap.legacy.transactions).toBe(1);
    expect(gap.gl.events).toBe(0);
    expect(gap.migrationProgress).toBe(0);
  });
});

describe("Phase 6 — duplicate event detection", () => {
  test("no duplicates in a fresh system", async () => {
    const { orgId, asUser } = await seedMigrationDealer();
    const result = await asUser.query(api.accountingMigration.duplicateEventCheck, {
      orgId, eventType: "EXPENSE_POSTED",
    });
    expect(result.duplicateCount).toBe(0);
  });

  test("posting same event twice via idempotency produces no duplicate in GL", async () => {
    const { orgId, asUser } = await seedMigrationDealer();
    const now = Date.now();

    await asUser.mutation(internal.accountingLedger.post, {
      orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: "dup_exp",
      eventVersion: 1, accountingDate: now, occurredAt: now, currency: "JOD",
      idempotencyKey: "dup_exp_key",
      payload: { expenseId: "dup_exp", amountMinor: 10000, currency: "JOD" },
    });
    await asUser.mutation(internal.accountingLedger.post, {
      orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: "dup_exp",
      eventVersion: 1, accountingDate: now, occurredAt: now, currency: "JOD",
      idempotencyKey: "dup_exp_key",
      payload: { expenseId: "dup_exp", amountMinor: 10000, currency: "JOD" },
    });

    const result = await asUser.query(api.accountingMigration.duplicateEventCheck, {
      orgId, eventType: "EXPENSE_POSTED",
    });
    expect(result.totalEvents).toBe(1);
    expect(result.duplicateCount).toBe(0);
  });
});

describe("Phase 6 — audit legacy transactions", () => {
  test("audit shows legacy transaction as unposted", async () => {
    const { t, orgId, asUser } = await seedMigrationDealer();

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 100, date: Date.now(),
        category: "EXPENSE", description: "Office supplies", idempotencyKey: "leg_office_001",
      })
    );

    const audit = await asUser.query(api.accountingMigration.auditLegacyTransactions, {
      orgId, onlyUnposted: true,
    });

    expect(audit.unpostedCount).toBe(1);
    expect(audit.rows[0].hasJournalEntry).toBe(false);
    expect(audit.rows[0].eventType).toBe("EXPENSE_POSTED");
  });
});

describe("Phase 6 — dry-run migration", () => {
  test("dry-run migration shows WOULD_POST without creating events", async () => {
    const { t, orgId, asUser } = await seedMigrationDealer();

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 500, date: Date.now(),
        category: "EXPENSE", description: "Marketing", idempotencyKey: "leg_mkt_001",
      })
    );

    const result = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: true, limit: 10,
    });

    expect(result.dryRun).toBe(true);
    expect(result.wouldPost).toBe(1);
    expect(result.posted).toBe(0);
    expect(result.results[0].action).toBe("WOULD_POST");

    // Verify no events were actually created
    const gap = await asUser.query(api.accountingMigration.migrationGapAnalysis, { orgId });
    expect(gap.gl.events).toBe(0);
  });

  test("live migration posts events and is idempotent when run twice", async () => {
    const { t, orgId, asUser } = await seedMigrationDealer();
    const now = Date.now();

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 300, date: now,
        category: "EXPENSE", description: "Utilities", idempotencyKey: "leg_util_001",
      })
    );

    const first = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });
    expect(first.posted).toBe(1);

    // Second run should skip already-posted transactions
    const second = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });
    expect(second.posted).toBe(0);
    expect(second.skipped).toBe(1);

    const gap = await asUser.query(api.accountingMigration.migrationGapAnalysis, { orgId });
    expect(gap.gl.events).toBe(1);
    expect(gap.migrationProgress).toBe(100);
  });
});

describe("Phase 6 — VEHICLE_PURCHASE rows are recognized as already posted via vehicles", () => {
  const baseVehicle = {
    vin: "1HGCM82633A000099",
    make: "Honda", model: "Accord", year: 2020, mileage: 10000,
    color: "White", fuelType: "Gasoline", transmission: "Automatic",
    sellingPrice: 20000, status: "AVAILABLE" as const, sourceType: "STOCK" as const,
  };

  test("audit does not flag the companion VEHICLE_PURCHASE row as unposted", async () => {
    const { orgId, asUser } = await seedMigrationDealer();

    await asUser.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    const audit = await asUser.query(api.accountingMigration.auditLegacyTransactions, {
      orgId, onlyUnposted: true,
    });
    expect(audit.unpostedCount).toBe(0);
  });

  test("migration skips the VEHICLE_PURCHASE row instead of double-posting VEHICLE_ACQUIRED", async () => {
    const { orgId, asUser } = await seedMigrationDealer();

    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId, ...baseVehicle, purchasePrice: 10000, purchasePaymentMethod: "CASH",
    });

    const result = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    expect(result.posted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.results[0]).toMatchObject({ action: "SKIP", reason: "already_posted_via_vehicle" });

    // Only the one VEHICLE_ACQUIRED event exists for the vehicle — no duplicate.
    const dup = await asUser.query(api.accountingMigration.duplicateEventCheck, {
      orgId, eventType: "VEHICLE_ACQUIRED",
    });
    expect(dup.totalEvents).toBe(1);
    expect(dup.duplicateCount).toBe(0);

    const events = await asUser.query(api.accountingMigration.auditLegacyTransactions, { orgId });
    expect(events.rows.filter((r) => r.eventType === "VEHICLE_ACQUIRED" && r.vehicleId === vehicleId)).toHaveLength(1);
  });
});
