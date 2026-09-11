/**
 * SCRUM-302 — FAILING-FIRST reproduction of the internal-economic-lifecycle defect.
 *
 *
 * INVARIANT UNDER TEST
 *   An organization that is suspended, or that carries irreversible
 *   destructive-purge history, must receive ZERO new economic footprint —
 *   whatever trust boundary the write arrives through. `requireTenantAuth`
 *   refuses a suspended org at the authenticated door; `internalMutation`,
 *   cron and webhook entry points bypass it by construction.
 *
 * WHAT "ZERO ECONOMIC FOOTPRINT" MEANS HERE — the table set whose per-org row
 * counts must be unchanged:
 *   accountingEvents · pendingAccountingEvents · journalEntries · journalLines
 *   accountBalanceSnapshots · canonicalPayments · receivableDocuments
 *   paymentAllocations · commitmentAuthorityWork · commitmentAuthorityAttempt
 *
 * Negative cases are paired with a POSITIVE CONTROL on an active org in the
 * same harness — a refusal that also refuses the healthy path proves nothing.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

/**
 * The ledger-core table set.
 *
 * A direct source scan of `ctx.db.insert("<table>", ...)` for these tables
 * across non-test `convex/**` found 19 sites in 7 files at the SCRUM-302
 * certification SHA. That is a measurement of one revision, not a standing
 * guarantee, and nothing re-derives it on later commits. If you are changing
 * ledger-core writers, re-measure directly rather than trusting this number
 * or any index. A fail-closed structural guard is deferred to SCRUM-309.
 */
const LEDGER_CORE_TABLES = [
  "accountingEvents",
  "pendingAccountingEvents",
  "journalEntries",
  "journalLines",
  "accountBalanceSnapshots",
  "canonicalPayments",
  "receivableDocuments",
  "paymentAllocations",
  "commitmentAuthorityWork",
  "commitmentAuthorityAttempt",
] as const;

type Harness = ReturnType<typeof convexTestWithComponents>;

const FINANCE_PERMS = [
  "view:sales",
  "create:sales",
  "edit:sales",
  "view:expenses",
  "create:expenses",
  "edit:expenses",
  "manage:finance",
  "view:finance",
  "view:customers",
  "create:customers",
  "view:vehicles",
  "create:vehicles",
  "edit:vehicles",
];

/** Counts rows in `LEDGER_CORE_TABLES` belonging to one org. */
async function economicFootprint(
  t: Harness,
  orgId: Id<"organizations">
): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const table of LEDGER_CORE_TABLES) {
      const rows = await ctx.db.query(table).collect();
      counts[table] = (rows as { orgId?: unknown }[]).filter(
        (r) => String(r.orgId) === String(orgId)
      ).length;
    }
    return counts;
  });
}

function totalFootprint(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/** One dealership with an initialized chart and an open accounting period. */
async function seedDealer(t: Harness, tag: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `SCRUM302 ${tag}`, createdAt: Date.now() })
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
      email: `${tag}@example.com`,
      name: `${tag} User`,
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: FINANCE_PERMS,
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

  return { orgId, userId, asUser, customerId };
}

async function suspend(t: Harness, orgId: Id<"organizations">) {
  await t.run((ctx) =>
    ctx.db.patch(orgId, {
      suspended: true,
      suspendedAt: Date.now(),
      suspendedReason: "SCRUM-302 reproduction",
    })
  );
}

async function markDestructivePurgeStarted(t: Harness, orgId: Id<"organizations">) {
  await t.run((ctx) => ctx.db.patch(orgId, { destructivePurgeStartedAt: Date.now() }));
}

// ───────────────────────────────────────────────────────────────────────────
// FLOOR 1 + 2 — payment webhook internal settlement
// ───────────────────────────────────────────────────────────────────────────

describe("SCRUM-302 F1/F2 — payment webhook internal settlement vs org lifecycle", () => {
  test("F1: a SUSPENDED org receives no economic footprint from settleByExternalId", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const dealer = await seedDealer(t, "f1");
    const intentId = await dealer.asUser.mutation(api.paymentIntents.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId: dealer.orgId,
      customerId: dealer.customerId,
      amountMinor: 1_000_000,
      currency: "JOD",
      provider: "tap",
      externalId: "tap_f1",
    });

    await suspend(t, dealer.orgId);
    const before = await economicFootprint(t, dealer.orgId);

    await t.mutation(internal.paymentIntents.settleByExternalId, {
      provider: "tap",
      externalId: "tap_f1",
      amountMinor: 1_000_000,
      currency: "JOD",
      providerSignatureVerifiedAt: Date.now(),
    });

    expect(await economicFootprint(t, dealer.orgId)).toEqual(before);

    const intent = await t.run((ctx) => ctx.db.get(intentId));
    expect(intent?.status).not.toBe("SETTLED");
  });

  test("F1 CONTROL: an ACTIVE org still settles normally", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const dealer = await seedDealer(t, "f1ctl");
    const intentId = await dealer.asUser.mutation(api.paymentIntents.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId: dealer.orgId,
      customerId: dealer.customerId,
      amountMinor: 1_000_000,
      currency: "JOD",
      provider: "tap",
      externalId: "tap_f1ctl",
    });

    await t.mutation(internal.paymentIntents.settleByExternalId, {
      provider: "tap",
      externalId: "tap_f1ctl",
      amountMinor: 1_000_000,
      currency: "JOD",
      providerSignatureVerifiedAt: Date.now(),
    });

    const intent = await t.run((ctx) => ctx.db.get(intentId));
    expect(intent?.status).toBe("SETTLED");
    expect((await economicFootprint(t, dealer.orgId)).canonicalPayments).toBeGreaterThan(0);
  });

  test("F2: an org with destructivePurgeStartedAt receives no economic footprint", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const dealer = await seedDealer(t, "f2");
    await dealer.asUser.mutation(api.paymentIntents.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId: dealer.orgId,
      customerId: dealer.customerId,
      amountMinor: 1_000_000,
      currency: "JOD",
      provider: "tap",
      externalId: "tap_f2",
    });

    await markDestructivePurgeStarted(t, dealer.orgId);
    const before = await economicFootprint(t, dealer.orgId);

    await t.mutation(internal.paymentIntents.settleByExternalId, {
      provider: "tap",
      externalId: "tap_f2",
      amountMinor: 1_000_000,
      currency: "JOD",
      providerSignatureVerifiedAt: Date.now(),
    });

    expect(await economicFootprint(t, dealer.orgId)).toEqual(before);
  });

  test("F1/F2 CROSS-ORG: blocking one org does not affect another org's settlement", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const blocked = await seedDealer(t, "xorga");
    const healthy = await seedDealer(t, "xorgb");
    await blocked.asUser.mutation(api.paymentIntents.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId: blocked.orgId,
      customerId: blocked.customerId,
      amountMinor: 1_000_000,
      currency: "JOD",
      provider: "tap",
      externalId: "tap_xa",
    });
    const healthyIntentId = await healthy.asUser.mutation(api.paymentIntents.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId: healthy.orgId,
      customerId: healthy.customerId,
      amountMinor: 1_000_000,
      currency: "JOD",
      provider: "tap",
      externalId: "tap_xb",
    });
    await suspend(t, blocked.orgId);

    const blockedBefore = await economicFootprint(t, blocked.orgId);

    await t.mutation(internal.paymentIntents.settleByExternalId, {
      provider: "tap",
      externalId: "tap_xa",
      amountMinor: 1_000_000,
      currency: "JOD",
      providerSignatureVerifiedAt: Date.now(),
    });
    await t.mutation(internal.paymentIntents.settleByExternalId, {
      provider: "tap",
      externalId: "tap_xb",
      amountMinor: 1_000_000,
      currency: "JOD",
      providerSignatureVerifiedAt: Date.now(),
    });

    expect(await economicFootprint(t, blocked.orgId)).toEqual(blockedBefore);
    const healthyIntent = await t.run((ctx) => ctx.db.get(healthyIntentId));
    expect(healthyIntent?.status).toBe("SETTLED");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FLOOR 3 — fixed asset monthly depreciation
// ───────────────────────────────────────────────────────────────────────────

async function seedDepreciableAsset(t: Harness, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.insert("fixedAssets", {
      orgId,
      name: "Workshop lift",
      purchaseDate: Date.UTC(2020, 0, 1),
      costMinor: 1_200_000,
      currency: "JOD",
      salvageValueMinor: 0,
      usefulLifeMonths: 12,
      method: "STRAIGHT_LINE" as const,
      depreciationStartDate: Date.UTC(2020, 0, 1),
      status: "ACTIVE" as const,
      accumulatedDepreciationMinor: 0,
      monthsDepreciated: 0,
    })
  );
}

describe("SCRUM-302 F3 — fixed asset depreciation cron vs org lifecycle", () => {
  test("F3: a SUSPENDED org's asset is not depreciated and posts nothing", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const dealer = await seedDealer(t, "f3");
    const assetId = await seedDepreciableAsset(t, dealer.orgId);
    await suspend(t, dealer.orgId);
    const before = await economicFootprint(t, dealer.orgId);

    const result = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId: dealer.orgId,
      assetId,
      yearMonth: `${new Date().getUTCFullYear()}-01`,
      occurredAt: Date.now(),
      systemActorId: dealer.userId,
    });

    expect(result.posted).toBe(false);
    expect(await economicFootprint(t, dealer.orgId)).toEqual(before);
  });

  test("F3 CONTROL: an ACTIVE org's asset still depreciates", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const dealer = await seedDealer(t, "f3ctl");
    const assetId = await seedDepreciableAsset(t, dealer.orgId);

    const result = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId: dealer.orgId,
      assetId,
      yearMonth: `${new Date().getUTCFullYear()}-01`,
      occurredAt: Date.now(),
      systemActorId: dealer.userId,
    });

    expect(result.posted).toBe(true);
    expect(totalFootprint(await economicFootprint(t, dealer.orgId))).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FLOOR 4 — dealer-product deferral / F&I commission recognition
// ───────────────────────────────────────────────────────────────────────────

async function seedActiveDeferral(
  t: Harness,
  orgId: Id<"organizations">,
  customerId: Id<"customers">,
  userId: Id<"users">
) {
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: "Corolla",
      year: 2020,
      mileage: 10_000,
      color: "White",
      fuelType: "PETROL",
      transmission: "AUTOMATIC",
      sellingPrice: 10_000,
      status: "SOLD" as const,
    })
  );
  const saleId = await t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 10_000,
      saleDate: Date.now(),
      status: "COMPLETED" as const,
    })
  );
  return await t.run((ctx) =>
    ctx.db.insert("dealerProductDeferrals", {
      orgId,
      saleId,
      productType: "WARRANTY" as const,
      totalMarginMinor: 1_200_000,
      currency: "JOD",
      termMonths: 12,
      recognizedMinor: 0,
      monthsRecognized: 0,
      status: "ACTIVE" as const,
      createdAt: Date.now(),
    })
  );
}

describe("SCRUM-302 F4 — F&I deferral recognition cron vs org lifecycle", () => {
  test("F4: a SUSPENDED org recognizes nothing and posts nothing", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const dealer = await seedDealer(t, "f4");
    const deferralId = await seedActiveDeferral(t, dealer.orgId, dealer.customerId, dealer.userId);
    await suspend(t, dealer.orgId);
    const before = await economicFootprint(t, dealer.orgId);

    const result = await t.mutation(
      internal.dealerProductDeferrals.recognizeDeferredCommissionForMonth,
      {
        orgId: dealer.orgId,
        deferralId,
        yearMonth: `${new Date().getUTCFullYear()}-01`,
        occurredAt: Date.now(),
        systemActorId: dealer.userId,
      }
    );

    expect(result.posted).toBe(false);
    expect(await economicFootprint(t, dealer.orgId)).toEqual(before);
  });

  test("F4 CONTROL: an ACTIVE org still recognizes", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const dealer = await seedDealer(t, "f4ctl");
    const deferralId = await seedActiveDeferral(t, dealer.orgId, dealer.customerId, dealer.userId);

    const result = await t.mutation(
      internal.dealerProductDeferrals.recognizeDeferredCommissionForMonth,
      {
        orgId: dealer.orgId,
        deferralId,
        yearMonth: `${new Date().getUTCFullYear()}-01`,
        occurredAt: Date.now(),
        systemActorId: dealer.userId,
      }
    );

    expect(result.posted).toBe(true);
    expect(totalFootprint(await economicFootprint(t, dealer.orgId))).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FLOOR 5 — prepaid expense amortization
// ───────────────────────────────────────────────────────────────────────────

/**
 * Created through the real `api.expenses.create` path rather than by direct
 * insert. `amortizeScheduleForMonth` refuses with `source_expense_not_posted`
 * unless the originating EXPENSE_POSTED event actually exists, so a
 * hand-inserted schedule amortizes nothing and the negative test would pass
 * vacuously — which is exactly what the positive control caught on the first
 * run of this file.
 */
async function seedActivePrepaidSchedule(
  t: Harness,
  dealer: Awaited<ReturnType<typeof seedDealer>>
) {
  const fiscalYear = new Date().getUTCFullYear();
  await dealer.asUser.mutation(api.expenses.create, {
      idempotencyKey: crypto.randomUUID(),
    orgId: dealer.orgId,
    title: "Annual insurance",
    amount: 1_200,
    date: Date.UTC(fiscalYear, 0, 15),
    category: "PREPAID" as const,
    status: "PAID" as const,
    paymentMethod: "BANK_TRANSFER" as const,
    isPrepaid: true,
    amortizationMonths: 12,
  });

  const schedule = await t.run(async (ctx) => {
    const rows = await ctx.db.query("prepaidExpenseSchedules").collect();
    return rows.find((r) => String(r.orgId) === String(dealer.orgId));
  });
  if (!schedule) throw new Error("fixture: prepaid schedule was not created by expenses.create");
  return schedule._id;
}

describe("SCRUM-302 F5 — prepaid amortization cron vs org lifecycle", () => {
  test("F5: a SUSPENDED org amortizes nothing and posts nothing", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const dealer = await seedDealer(t, "f5");
    const scheduleId = await seedActivePrepaidSchedule(t, dealer);
    await suspend(t, dealer.orgId);
    const before = await economicFootprint(t, dealer.orgId);

    const result = await t.mutation(internal.prepaidExpenses.catchUpScheduleMutation, {
      orgId: dealer.orgId,
      scheduleId,
      throughYearMonth: `${new Date().getUTCFullYear()}-03`,
      now: Date.now(),
      systemActorId: dealer.userId,
    });

    expect(result.monthsPosted).toBe(0);
    expect(await economicFootprint(t, dealer.orgId)).toEqual(before);
  });

  test("F5 CONTROL: an ACTIVE org still amortizes", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const dealer = await seedDealer(t, "f5ctl");
    const scheduleId = await seedActivePrepaidSchedule(t, dealer);

    const result = await t.mutation(internal.prepaidExpenses.catchUpScheduleMutation, {
      orgId: dealer.orgId,
      scheduleId,
      throughYearMonth: `${new Date().getUTCFullYear()}-03`,
      now: Date.now(),
      systemActorId: dealer.userId,
    });

    expect(result.monthsPosted).toBeGreaterThan(0);
    expect(totalFootprint(await economicFootprint(t, dealer.orgId))).toBeGreaterThan(0);
  });
});
