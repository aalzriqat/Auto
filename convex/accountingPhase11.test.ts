/**
 * Phase 11 tests — fixed-asset lifecycle and depreciation.
 *
 * Covers the acceptance gates from docs/architecture/accounting-final-phase-plan.md:
 * capitalization/depreciation/impairment/disposal each post a balanced entry,
 * disposal gain/loss balances correctly in both directions, and re-running the
 * depreciation cron for the same month never double-posts.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

// Tests that depreciate hardcoded "2026-XX" months need a purchase date at or
// before those months, or the schedule-start guard (correctly) skips them.
const PAST_PURCHASE_DATE = Date.UTC(2025, 11, 1);

async function seedAssetDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase11 Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "p11_owner", email: "p11owner@example.com", name: "Owner" })
  );
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      // Explicit flag so crons.ts's findOrgOwnerUser (isSystemOwnerRole check)
      // can resolve a systemActorId for automated postings, same as production
      // OWNER rows — the fallback name+all-permissions check doesn't apply
      // here since this seed only grants the two finance permissions it needs.
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRoleId }));

  // A second, lower-privileged user for the permission-gate test.
  const viewerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p11_viewer", email: "p11viewer@example.com", name: "Viewer" })
  );
  const viewerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Viewer", permissions: ["view:finance"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId }));

  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: "p11_owner", clerkId: "p11_owner" });
  const asViewer = t.withIdentity({ subject: "p11_viewer", clerkId: "p11_viewer" });

  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, viewerId, asOwner, asViewer };
}

async function eventsOfType(t: Awaited<ReturnType<typeof seedAssetDealer>>["t"], orgId: Id<"organizations">, eventType: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .filter((q) => q.eq(q.field("eventType"), eventType))
      .collect()
  );
}

async function linesForEvent(t: Awaited<ReturnType<typeof seedAssetDealer>>["t"], event: { journalEntryId?: Id<"journalEntries"> }) {
  if (!event.journalEntryId) throw new Error("Event has no journalEntryId");
  const journalEntryId = event.journalEntryId;
  return await t.run((ctx) =>
    ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalEntryId)).collect()
  );
}

function totals(lines: { debitMinor: number; creditMinor: number }[]) {
  return {
    debit: lines.reduce((s, l) => s + l.debitMinor, 0),
    credit: lines.reduce((s, l) => s + l.creditMinor, 0),
  };
}

async function accountBySystemKey(t: Awaited<ReturnType<typeof seedAssetDealer>>["t"], orgId: Id<"organizations">, systemKey: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
      .unique()
  );
}

describe("Phase 11 — asset capitalization", () => {
  test("capitalize posts a balanced DR Fixed Assets / CR Cash entry", async () => {
    const { t, orgId, asOwner } = await seedAssetDealer();

    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Forklift",
      purchaseDate: Date.now(),
      costMinor: 500_000,
      salvageValueMinor: 50_000,
      usefulLifeMonths: 60,
      paymentMethod: "CASH",
    });

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.status).toBe("ACTIVE");
    expect(asset?.accumulatedDepreciationMinor).toBe(0);
    expect(asset?.costMinor).toBe(500_000);

    const events = await eventsOfType(t, orgId, "ASSET_CAPITALIZED");
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("POSTED");

    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(500_000);
    expect(credit).toBe(500_000);

    const fixedAssetsAccount = await accountBySystemKey(t, orgId, "FIXED_ASSETS");
    const cashAccount = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    const assetLine = lines.find((l) => l.accountId === fixedAssetsAccount?._id);
    const cashLine = lines.find((l) => l.accountId === cashAccount?._id);
    expect(assetLine?.debitMinor).toBe(500_000);
    expect(cashLine?.creditMinor).toBe(500_000);
  });

  test("capitalize rejects when salvage value is not less than cost", async () => {
    const { orgId, asOwner } = await seedAssetDealer();
    await expect(
      asOwner.mutation(api.fixedAssets.capitalize, {
        orgId,
        name: "Bad asset",
        purchaseDate: Date.now(),
        costMinor: 100_000,
        salvageValueMinor: 100_000,
        usefulLifeMonths: 12,
      })
    ).rejects.toThrow(/salvage value/i);
  });

  test("capitalize rejects a non-positive cost", async () => {
    const { orgId, asOwner } = await seedAssetDealer();
    await expect(
      asOwner.mutation(api.fixedAssets.capitalize, {
        orgId,
        name: "Free asset",
        purchaseDate: Date.now(),
        costMinor: 0,
        usefulLifeMonths: 12,
      })
    ).rejects.toThrow(/cost must be/i);
  });

  test("capitalize paid by cheque credits the bank account, not cheques-in-hand", async () => {
    const { t, orgId, asOwner } = await seedAssetDealer();
    await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Cheque-Paid Lift",
      purchaseDate: Date.now(),
      costMinor: 250_000,
      usefulLifeMonths: 36,
      paymentMethod: "CHEQUE",
    });

    const events = await eventsOfType(t, orgId, "ASSET_CAPITALIZED");
    const lines = await linesForEvent(t, events[0]);

    // CHEQUES_IN_HAND holds customer cheques we've received; paying out by
    // our own cheque must credit the bank instead.
    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const chequesInHand = await accountBySystemKey(t, orgId, "CHEQUES_IN_HAND");
    expect(lines.find((l) => l.accountId === bank?._id)?.creditMinor).toBe(250_000);
    expect(lines.find((l) => l.accountId === chequesInHand?._id)).toBeUndefined();
  });

  test("capitalize requires manage:finance — a view-only member is rejected", async () => {
    const { orgId, asViewer } = await seedAssetDealer();
    await expect(
      asViewer.mutation(api.fixedAssets.capitalize, {
        orgId,
        name: "Unauthorized asset",
        purchaseDate: Date.now(),
        costMinor: 100_000,
        usefulLifeMonths: 12,
      })
    ).rejects.toThrow(/missing required permissions/i);
  });
});

describe("Phase 11 — monthly depreciation", () => {
  test("posts a balanced entry and is idempotent for the same month", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Delivery Van",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 1_200_000,
      usefulLifeMonths: 12,
    });

    const first = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: Date.now(), systemActorId: userId,
    });
    expect(first.posted).toBe(true);
    expect(first.amountMinor).toBe(100_000);

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.accumulatedDepreciationMinor).toBe(100_000);
    expect(asset?.lastDepreciatedYearMonth).toBe("2026-01");

    const events = await eventsOfType(t, orgId, "DEPRECIATION_POSTED");
    expect(events).toHaveLength(1);
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(100_000);
    expect(credit).toBe(100_000);

    const depreciationExpense = await accountBySystemKey(t, orgId, "DEPRECIATION_EXPENSE");
    const accumulatedDep = await accountBySystemKey(t, orgId, "ACCUMULATED_DEPRECIATION");
    expect(lines.find((l) => l.accountId === depreciationExpense?._id)?.debitMinor).toBe(100_000);
    expect(lines.find((l) => l.accountId === accumulatedDep?._id)?.creditMinor).toBe(100_000);

    // Re-running for the same month must be a no-op — this is the acceptance
    // gate that a cron redrive/redeploy can't double-post.
    const second = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: Date.now(), systemActorId: userId,
    });
    expect(second.posted).toBe(false);
    expect(second.reason).toBe("already_ran_this_month");

    const assetAfterRerun = await t.run((ctx) => ctx.db.get(assetId));
    expect(assetAfterRerun?.accumulatedDepreciationMinor).toBe(100_000);
    expect(await eventsOfType(t, orgId, "DEPRECIATION_POSTED")).toHaveLength(1);
  });

  test("fully depreciates over the asset's useful life and then stops without exceeding cost", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Office Equipment",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 1_200_000,
      usefulLifeMonths: 12,
    });

    for (let month = 1; month <= 12; month++) {
      const yearMonth = `2026-${String(month).padStart(2, "0")}`;
      const result = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
        orgId, assetId, yearMonth, occurredAt: Date.now(), systemActorId: userId,
      });
      expect(result.posted).toBe(true);
    }

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.accumulatedDepreciationMinor).toBe(1_200_000);

    const thirteenth = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2027-01", occurredAt: Date.now(), systemActorId: userId,
    });
    expect(thirteenth.posted).toBe(false);
    expect(thirteenth.reason).toBe("fully_depreciated");

    const assetAfter = await t.run((ctx) => ctx.db.get(assetId));
    expect(assetAfter?.accumulatedDepreciationMinor).toBe(1_200_000);

    const events = await eventsOfType(t, orgId, "DEPRECIATION_POSTED");
    expect(events).toHaveLength(12);
    let totalPosted = 0;
    for (const event of events) {
      const { debit, credit } = totals(await linesForEvent(t, event));
      expect(debit).toBe(credit);
      totalPosted += debit;
    }
    expect(totalPosted).toBe(1_200_000);
  });

  test("skips a non-ACTIVE asset", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Soon Disposed",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 200_000,
      usefulLifeMonths: 24,
    });
    await asOwner.mutation(api.fixedAssets.dispose, { orgId, assetId, proceedsMinor: 200_000 });

    const result = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: Date.now(), systemActorId: userId,
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toBe("not_active");
  });

  test("does not depreciate before the asset's depreciation start month", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const purchase = Date.UTC(2026, 0, 15); // Jan 2026
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Future Starter",
      purchaseDate: purchase,
      costMinor: 600_000,
      usefulLifeMonths: 12,
      depreciationStartDate: Date.UTC(2026, 5, 1), // schedule starts Jun 2026
    });

    const early = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-03", occurredAt: Date.now(), systemActorId: userId,
    });
    expect(early.posted).toBe(false);
    expect(early.reason).toBe("before_depreciation_start");
    expect(await eventsOfType(t, orgId, "DEPRECIATION_POSTED")).toHaveLength(0);

    const onTime = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-06", occurredAt: Date.now(), systemActorId: userId,
    });
    expect(onTime.posted).toBe(true);
  });

  test("a depreciable base smaller than the useful life posts 1 minor unit per month, not everything at once", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    // floor(100 / 240) = 0 — the schedule must degrade to 1/minor-unit-a-month,
    // not dump the full 100 into the first month.
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Tiny Base Asset",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 100,
      usefulLifeMonths: 240,
    });

    const first = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: Date.now(), systemActorId: userId,
    });
    expect(first.posted).toBe(true);
    expect(first.amountMinor).toBe(1);

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.accumulatedDepreciationMinor).toBe(1);
  });

  test("listActiveAssetsForDepreciation paginates across every active asset", async () => {
    const { t, orgId, asOwner } = await seedAssetDealer();
    for (let i = 0; i < 3; i++) {
      await asOwner.mutation(api.fixedAssets.capitalize, {
        orgId,
        name: `Paged Asset ${i}`,
        purchaseDate: Date.now(),
        costMinor: 100_000,
        usefulLifeMonths: 12,
      });
    }

    const firstPage = await t.query(internal.fixedAssets.listActiveAssetsForDepreciation, { numItems: 2 });
    expect(firstPage.page).toHaveLength(2);
    expect(firstPage.isDone).toBe(false);

    const secondPage = await t.query(internal.fixedAssets.listActiveAssetsForDepreciation, {
      cursor: firstPage.continueCursor, numItems: 2,
    });
    expect(secondPage.page).toHaveLength(1);
    expect(secondPage.isDone).toBe(true);
  });

  test("the monthly depreciation cron posts through the action end-to-end", async () => {
    const { t, orgId, asOwner } = await seedAssetDealer();
    await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Cron Asset",
      purchaseDate: Date.now(),
      costMinor: 600_000,
      usefulLifeMonths: 12,
    });

    const summary: string = await t.action(internal.crons.triggerFixedAssetDepreciation, {});
    expect(summary).toMatch(/posted 1\/1/i);

    const events = await eventsOfType(t, orgId, "DEPRECIATION_POSTED");
    expect(events).toHaveLength(1);

    // Running the cron again in the same calendar month must not double-post.
    const secondSummary: string = await t.action(internal.crons.triggerFixedAssetDepreciation, {});
    expect(secondSummary).toMatch(/posted 0\/1/i);
    expect(await eventsOfType(t, orgId, "DEPRECIATION_POSTED")).toHaveLength(1);
  });
});

describe("Phase 11 — impairment", () => {
  test("posts a balanced entry and marks the asset IMPAIRED", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Aging Machine",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 500_000,
      usefulLifeMonths: 50,
    });
    await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: Date.now(), systemActorId: userId,
    });

    await asOwner.mutation(api.fixedAssets.impair, { orgId, assetId, amountMinor: 200_000 });

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.status).toBe("IMPAIRED");
    expect(asset?.accumulatedDepreciationMinor).toBe(10_000 + 200_000);

    const events = await eventsOfType(t, orgId, "ASSET_IMPAIRED");
    expect(events).toHaveLength(1);
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(200_000);
    expect(credit).toBe(200_000);

    const impairmentLoss = await accountBySystemKey(t, orgId, "IMPAIRMENT_LOSS");
    expect(lines.find((l) => l.accountId === impairmentLoss?._id)?.debitMinor).toBe(200_000);
  });

  test("rejects an impairment amount exceeding net book value", async () => {
    const { orgId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Small Value Asset",
      purchaseDate: Date.now(),
      costMinor: 100_000,
      usefulLifeMonths: 24,
    });

    await expect(
      asOwner.mutation(api.fixedAssets.impair, { orgId, assetId, amountMinor: 150_000 })
    ).rejects.toThrow(/exceeds the asset's net book value/i);
  });

  test("rejects impairing an asset that is not ACTIVE", async () => {
    const { orgId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Already Impaired",
      purchaseDate: Date.now(),
      costMinor: 300_000,
      usefulLifeMonths: 30,
    });
    await asOwner.mutation(api.fixedAssets.impair, { orgId, assetId, amountMinor: 50_000 });

    await expect(
      asOwner.mutation(api.fixedAssets.impair, { orgId, assetId, amountMinor: 10_000 })
    ).rejects.toThrow(/only an active asset can be impaired/i);
  });
});

describe("Phase 11 — disposal", () => {
  test("disposing at a loss posts a balanced entry with a loss line", async () => {
    const { t, orgId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Sold Below Book",
      purchaseDate: Date.now(),
      costMinor: 500_000,
      usefulLifeMonths: 50,
    });

    await asOwner.mutation(api.fixedAssets.dispose, { orgId, assetId, proceedsMinor: 300_000 });

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.status).toBe("DISPOSED");
    expect(asset?.disposalProceedsMinor).toBe(300_000);

    const events = await eventsOfType(t, orgId, "ASSET_DISPOSED");
    expect(events).toHaveLength(1);
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(credit);
    expect(debit).toBe(500_000);

    const lossAccount = await accountBySystemKey(t, orgId, "LOSS_ON_DISPOSAL");
    const gainAccount = await accountBySystemKey(t, orgId, "GAIN_ON_DISPOSAL");
    expect(lines.find((l) => l.accountId === lossAccount?._id)?.debitMinor).toBe(200_000);
    expect(lines.find((l) => l.accountId === gainAccount?._id)).toBeUndefined();
  });

  test("disposing at a gain posts a balanced entry with a gain line", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Sold Above Book",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 500_000,
      usefulLifeMonths: 50,
    });
    await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: Date.now(), systemActorId: userId,
    });

    await asOwner.mutation(api.fixedAssets.dispose, { orgId, assetId, proceedsMinor: 550_000 });

    const events = await eventsOfType(t, orgId, "ASSET_DISPOSED");
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(credit);
    expect(debit).toBe(560_000);

    const gainAccount = await accountBySystemKey(t, orgId, "GAIN_ON_DISPOSAL");
    const accumulatedDep = await accountBySystemKey(t, orgId, "ACCUMULATED_DEPRECIATION");
    expect(lines.find((l) => l.accountId === gainAccount?._id)?.creditMinor).toBe(60_000);
    expect(lines.find((l) => l.accountId === accumulatedDep?._id)?.debitMinor).toBe(10_000);
  });

  test("disposing at exactly net book value posts no gain/loss line but stays balanced", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Sold At Book",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 500_000,
      usefulLifeMonths: 50,
    });
    await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: Date.now(), systemActorId: userId,
    });

    await asOwner.mutation(api.fixedAssets.dispose, { orgId, assetId, proceedsMinor: 490_000 });

    const events = await eventsOfType(t, orgId, "ASSET_DISPOSED");
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(credit);
    expect(debit).toBe(500_000);

    const gainAccount = await accountBySystemKey(t, orgId, "GAIN_ON_DISPOSAL");
    const lossAccount = await accountBySystemKey(t, orgId, "LOSS_ON_DISPOSAL");
    expect(lines.find((l) => l.accountId === gainAccount?._id)).toBeUndefined();
    expect(lines.find((l) => l.accountId === lossAccount?._id)).toBeUndefined();
  });

  test("rejects disposing an asset that has already been disposed", async () => {
    const { orgId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Double Disposed",
      purchaseDate: Date.now(),
      costMinor: 200_000,
      usefulLifeMonths: 20,
    });
    await asOwner.mutation(api.fixedAssets.dispose, { orgId, assetId, proceedsMinor: 200_000 });

    await expect(
      asOwner.mutation(api.fixedAssets.dispose, { orgId, assetId, proceedsMinor: 0 })
    ).rejects.toThrow(/already been disposed/i);
  });

  test("rejects disposing a legacy pre-Phase-11 asset with no capitalized cost", async () => {
    const { t, orgId, asOwner } = await seedAssetDealer();
    const legacyAssetId = await t.run((ctx) =>
      ctx.db.insert("fixedAssets", {
        orgId,
        name: "Legacy Asset",
        purchaseDate: Date.now(),
        purchaseValue: 1_000,
      })
    );

    await expect(
      asOwner.mutation(api.fixedAssets.dispose, { orgId, assetId: legacyAssetId, proceedsMinor: 0 })
    ).rejects.toThrow(/predates gl phase 11/i);
  });
});

describe("Phase 11 — soft delete guard", () => {
  test("a capitalized asset cannot be removed while its cost is on the ledger", async () => {
    const { orgId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "On The Books",
      purchaseDate: Date.now(),
      costMinor: 400_000,
      usefulLifeMonths: 48,
    });

    await expect(
      asOwner.mutation(api.fixedAssets.remove, { orgId, assetId })
    ).rejects.toThrow(/dispose it instead/i);
  });

  test("a disposed asset and a legacy asset can both be removed", async () => {
    const { t, orgId, asOwner } = await seedAssetDealer();

    const disposedId = await asOwner.mutation(api.fixedAssets.capitalize, {
      orgId,
      name: "Disposed Then Removed",
      purchaseDate: Date.now(),
      costMinor: 200_000,
      usefulLifeMonths: 24,
    });
    await asOwner.mutation(api.fixedAssets.dispose, { orgId, assetId: disposedId, proceedsMinor: 200_000 });
    await asOwner.mutation(api.fixedAssets.remove, { orgId, assetId: disposedId });

    const legacyId = await t.run((ctx) =>
      ctx.db.insert("fixedAssets", {
        orgId,
        name: "Legacy Junk Row",
        purchaseDate: Date.now(),
        purchaseValue: 500,
      })
    );
    await asOwner.mutation(api.fixedAssets.remove, { orgId, assetId: legacyId });

    const disposed = await t.run((ctx) => ctx.db.get(disposedId));
    const legacy = await t.run((ctx) => ctx.db.get(legacyId));
    expect(disposed?.isDeleted).toBe(true);
    expect(legacy?.isDeleted).toBe(true);
  });
});
