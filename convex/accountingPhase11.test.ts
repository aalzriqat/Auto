/**
 * Phase 11 tests — fixed-asset lifecycle and depreciation.
 *
 * Covers the acceptance gates from docs/architecture/accounting-final-phase-plan.md:
 * capitalization/depreciation/impairment/disposal each post a balanced entry,
 * disposal gain/loss balances correctly in both directions, and re-running the
 * depreciation cron for the same month never double-posts.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

// Tests that depreciate hardcoded "2026-XX" months need a purchase date at or
// before those months, or the schedule-start guard (correctly) skips them.
const PAST_PURCHASE_DATE = Date.UTC(2025, 11, 1);

// SCRUM-542: a depreciation claim for "YYYY-MM" must be dated INSIDE that UTC
// month (the mutation refuses otherwise), so tests pass the month's 15th.
function monthMid(yearMonth: string): number {
  const [year, month] = yearMonth.split("-").map(Number);
  return Date.UTC(year, month - 1, 15, 12);
}

async function seedAssetDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
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
      .withIndex("by_org_eventType", (q) => q.eq("orgId", orgId).eq("eventType", eventType))
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
      idempotencyKey: crypto.randomUUID(),
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

  test("capitalize rejects an unsupported payment method", async () => {
    const { orgId, asOwner } = await seedAssetDealer();
    await expect(
      asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
        orgId,
        name: "Forklift",
        purchaseDate: Date.now(),
        costMinor: 500_000,
        salvageValueMinor: 50_000,
        usefulLifeMonths: 60,
        paymentMethod: "OTHER" as any,
      })
    ).rejects.toThrow(/Validator error/i);

    await expect(
      asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
        orgId,
        name: "Forklift 2",
        purchaseDate: Date.now(),
        costMinor: 500_000,
        salvageValueMinor: 50_000,
        usefulLifeMonths: 60,
        paymentMethod: "WIRE" as any,
      })
    ).rejects.toThrow(/Validator error/i);
  });

  test("capitalize rejects when salvage value is not less than cost", async () => {
    const { orgId, asOwner } = await seedAssetDealer();
    await expect(
      asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Delivery Van",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 1_200_000,
      usefulLifeMonths: 12,
    });

    const first = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: monthMid("2026-01"), systemActorId: userId,
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
      orgId, assetId, yearMonth: "2026-01", occurredAt: monthMid("2026-01"), systemActorId: userId,
    });
    expect(second.posted).toBe(false);
    expect(second.reason).toBe("not_after_last_depreciated_month");

    const assetAfterRerun = await t.run((ctx) => ctx.db.get(assetId));
    expect(assetAfterRerun?.accumulatedDepreciationMinor).toBe(100_000);
    expect(await eventsOfType(t, orgId, "DEPRECIATION_POSTED")).toHaveLength(1);
  });

  test("fully depreciates over the asset's useful life and then stops without exceeding cost", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Office Equipment",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 1_200_000,
      usefulLifeMonths: 12,
    });

    for (let month = 1; month <= 12; month++) {
      const yearMonth = `2026-${String(month).padStart(2, "0")}`;
      const result = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
        orgId, assetId, yearMonth, occurredAt: monthMid(yearMonth), systemActorId: userId,
      });
      expect(result.posted).toBe(true);
    }

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.accumulatedDepreciationMinor).toBe(1_200_000);

    const thirteenth = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2027-01", occurredAt: monthMid("2027-01"), systemActorId: userId,
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
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Soon Disposed",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 200_000,
      usefulLifeMonths: 24,
    });
    await asOwner.mutation(api.fixedAssets.dispose, { orgId, assetId, proceedsMinor: 200_000 });

    const result = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: monthMid("2026-01"), systemActorId: userId,
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toBe("not_active");
  });

  test("does not depreciate before the asset's depreciation start month", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const purchase = Date.UTC(2026, 0, 15); // Jan 2026
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Future Starter",
      purchaseDate: purchase,
      costMinor: 600_000,
      usefulLifeMonths: 12,
      depreciationStartDate: Date.UTC(2026, 5, 1), // schedule starts Jun 2026
    });

    const early = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-03", occurredAt: monthMid("2026-03"), systemActorId: userId,
    });
    expect(early.posted).toBe(false);
    expect(early.reason).toBe("before_depreciation_start");
    expect(await eventsOfType(t, orgId, "DEPRECIATION_POSTED")).toHaveLength(0);

    const onTime = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-06", occurredAt: monthMid("2026-06"), systemActorId: userId,
    });
    expect(onTime.posted).toBe(true);
  });

  test("a depreciable base smaller than the useful life posts 1 minor unit per month, not everything at once", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    // floor(100 / 240) = 0 — the schedule must degrade to 1/minor-unit-a-month,
    // not dump the full 100 into the first month.
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Tiny Base Asset",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 100,
      usefulLifeMonths: 240,
    });

    const first = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: monthMid("2026-01"), systemActorId: userId,
    });
    expect(first.posted).toBe(true);
    expect(first.amountMinor).toBe(1);

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.accumulatedDepreciationMinor).toBe(1);
  });

  test("fully depreciates in exactly usefulLifeMonths even when the base doesn't divide evenly", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    // 100 / 3 = 33.33 — the old Math.floor-based schedule posted 33+33+33
    // and needed a 4th month to absorb the leftover 1, missing the
    // contractual 3-month useful life. The fix must finish in exactly 3.
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Non-Divisible Base Asset",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 100,
      usefulLifeMonths: 3,
    });

    const m1 = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: monthMid("2026-01"), systemActorId: userId,
    });
    const m2 = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-02", occurredAt: monthMid("2026-02"), systemActorId: userId,
    });
    const m3 = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-03", occurredAt: monthMid("2026-03"), systemActorId: userId,
    });
    expect(m1.posted && m2.posted && m3.posted).toBe(true);
    expect((m1.amountMinor ?? 0) + (m2.amountMinor ?? 0) + (m3.amountMinor ?? 0)).toBe(100);

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.accumulatedDepreciationMinor).toBe(100);

    // A 4th month must find nothing left — the schedule finished in exactly
    // usefulLifeMonths (3), never needing a 4th.
    const m4 = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-04", occurredAt: monthMid("2026-04"), systemActorId: userId,
    });
    expect(m4.posted).toBe(false);
    expect(m4.reason).toBe("fully_depreciated");
  });

  test("rejects an out-of-order (earlier) yearMonth", async () => {
    const { t, orgId, userId, asOwner } = await seedAssetDealer();
    const assetId = await asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Out Of Order Asset",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 1_200_000,
      usefulLifeMonths: 12,
    });

    await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-08", occurredAt: monthMid("2026-08"), systemActorId: userId,
    });
    const earlier = await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-07", occurredAt: monthMid("2026-07"), systemActorId: userId,
    });
    expect(earlier.posted).toBe(false);
    expect(earlier.reason).toBe("not_after_last_depreciated_month");

    const asset = await t.run((ctx) => ctx.db.get(assetId));
    // Only the 2026-08 month's amount was ever posted.
    expect(asset?.accumulatedDepreciationMinor).toBe(100_000);
  });

  test("listActiveAssetsForDepreciation paginates across every active asset", async () => {
    const { t, orgId, asOwner } = await seedAssetDealer();
    for (let i = 0; i < 3; i++) {
      await asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Aging Machine",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 500_000,
      usefulLifeMonths: 50,
    });
    await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: monthMid("2026-01"), systemActorId: userId,
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Sold Above Book",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 500_000,
      usefulLifeMonths: 50,
    });
    await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: monthMid("2026-01"), systemActorId: userId,
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
      idempotencyKey: crypto.randomUUID(),
      orgId,
      name: "Sold At Book",
      purchaseDate: PAST_PURCHASE_DATE,
      costMinor: 500_000,
      usefulLifeMonths: 50,
    });
    await t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId, assetId, yearMonth: "2026-01", occurredAt: monthMid("2026-01"), systemActorId: userId,
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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

// ─────────────────────────────────────────────────────────────────────────────
// SCRUM-542 slice A1 — month-claim guard, UTC-day temporal guards, list visibility
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const utcDayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

type Seed = Awaited<ReturnType<typeof seedAssetDealer>>;

/** A capitalized asset in a fresh dealer; defaults are the claim-guard van, any field can be overridden. */
async function seedCapitalizedAsset(
  overrides: Partial<{ name: string; purchaseDate: number; costMinor: number; usefulLifeMonths: number }> = {}
) {
  const seed = await seedAssetDealer();
  const assetId = await seed.asOwner.mutation(api.fixedAssets.capitalize, {
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    name: "Claim Guard Van",
    purchaseDate: PAST_PURCHASE_DATE,
    costMinor: 1_200_000,
    usefulLifeMonths: 12,
    ...overrides,
  });
  return { ...seed, assetId };
}

/** Inserts `count` soft-deleted fixed assets for the org. */
async function seedDeleted(seed: Pick<Seed, "t" | "orgId">, count: number) {
  for (let i = 0; i < count; i++) {
    await seed.t.run((ctx) =>
      ctx.db.insert("fixedAssets", { orgId: seed.orgId, name: `Deleted ${i}`, purchaseDate: Date.now(), isDeleted: true })
    );
  }
}
async function footprint(seed: Seed, assetId: Id<"fixedAssets">) {
  const { t, orgId } = seed;
  return {
    asset: await t.run((ctx) => ctx.db.get(assetId)),
    fixedAssetEvents: (
      await t.run((ctx) => ctx.db.query("fixedAssetEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect())
    ).length,
    accountingEvents: (
      await t.run((ctx) => ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect())
    ).length,
  };
}

/** The structured code of a refusal, "RESOLVED" when the call did not refuse, or the raw message when uncoded. */
async function refusalCode(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (caught) {
    const error = caught as { data?: { code?: string }; message?: string };
    return error.data?.code ?? `UNCODED: ${error.message}`;
  }
  return "RESOLVED";
}

describe("SCRUM-542 — depreciation month-claim guard", () => {

  test("a posting dated outside its claimed yearMonth throws and writes nothing", async () => {
    const seed = await seedCapitalizedAsset();
    const before = await footprint(seed, seed.assetId);
    await expect(
      seed.t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
        orgId: seed.orgId, assetId: seed.assetId, yearMonth: "2026-01",
        occurredAt: monthMid("2026-02"), systemActorId: seed.userId,
      })
    ).rejects.toThrow(/occurredAt is not within 2026-01/);
    expect(await footprint(seed, seed.assetId)).toEqual(before);
  });

  test("a non-finite occurredAt throws", async () => {
    const seed = await seedCapitalizedAsset();
    await expect(
      seed.t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
        orgId: seed.orgId, assetId: seed.assetId, yearMonth: "2026-01",
        occurredAt: Number.NaN, systemActorId: seed.userId,
      })
    ).rejects.toThrow(/occurredAt is not within 2026-01/);
  });

  test.each(["2026-13", "2026-00", "garbage", "2026-1", "26-01"])("a malformed yearMonth %s throws", async (yearMonth) => {
    const seed = await seedCapitalizedAsset();
    const before = await footprint(seed, seed.assetId);
    await expect(
      seed.t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
        orgId: seed.orgId, assetId: seed.assetId, yearMonth,
        occurredAt: monthMid("2026-01"), systemActorId: seed.userId,
      })
    ).rejects.toThrow(/yearMonth is not YYYY-MM/);
    expect(await footprint(seed, seed.assetId)).toEqual(before);
  });

  test("CONTROL: a valid replay of an already-posted month still returns its benign skip", async () => {
    const seed = await seedCapitalizedAsset();
    const args = {
      orgId: seed.orgId, assetId: seed.assetId, yearMonth: "2026-01",
      occurredAt: monthMid("2026-01"), systemActorId: seed.userId,
    };
    expect((await seed.t.mutation(internal.fixedAssets.depreciateAssetForMonth, args)).posted).toBe(true);
    const replay = await seed.t.mutation(internal.fixedAssets.depreciateAssetForMonth, args);
    expect(replay).toEqual({ posted: false, reason: "not_after_last_depreciated_month" });
  });

  test("a MALFORMED replay of an already-posted month throws instead of skipping", async () => {
    const seed = await seedCapitalizedAsset();
    await seed.t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId: seed.orgId, assetId: seed.assetId, yearMonth: "2026-01",
      occurredAt: monthMid("2026-01"), systemActorId: seed.userId,
    });
    await expect(
      seed.t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
        orgId: seed.orgId, assetId: seed.assetId, yearMonth: "2026-01",
        occurredAt: monthMid("2026-03"), systemActorId: seed.userId,
      })
    ).rejects.toThrow(/occurredAt is not within 2026-01/);
  });
});

describe.each(["impair", "dispose"] as const)("SCRUM-542 — %s UTC-day guards", (operation) => {
  const capitalizedDay = utcDayStart(Date.now()) - 20 * DAY_MS;


  function act(seed: Seed & { assetId: Id<"fixedAssets"> }, occurredAt: number | undefined) {
    return operation === "impair"
      ? seed.asOwner.mutation(api.fixedAssets.impair, {
          orgId: seed.orgId, assetId: seed.assetId, amountMinor: 10_000, occurredAt,
        })
      : seed.asOwner.mutation(api.fixedAssets.dispose, {
          orgId: seed.orgId, assetId: seed.assetId, proceedsMinor: 0, occurredAt,
        });
  }

  async function expectRefusedWithoutWrites(
    seed: Seed & { assetId: Id<"fixedAssets"> },
    occurredAt: number,
    code: string
  ) {
    const before = await footprint(seed, seed.assetId);
    expect(await refusalCode(act(seed, occurredAt))).toBe(code);
    expect(await footprint(seed, seed.assetId)).toEqual(before);
  }

  test("a date on a future UTC day is refused with zero writes; today is admitted", async () => {
    const seed = await seedCapitalizedAsset({ name: "Guarded Asset", purchaseDate: capitalizedDay + 5 * 3_600_000, costMinor: 600_000, usefulLifeMonths: 60 });
    await expectRefusedWithoutWrites(seed, Date.now() + DAY_MS, "ASSET_EVENT_DATE_IN_FUTURE");
    await act(seed, Date.now());
    expect((await footprint(seed, seed.assetId)).asset?.status).toBe(operation === "impair" ? "IMPAIRED" : "DISPOSED");
  });

  test("the UTC midnight that starts today is admitted (same day, earlier time)", async () => {
    const seed = await seedCapitalizedAsset({ name: "Guarded Asset", purchaseDate: capitalizedDay + 5 * 3_600_000, costMinor: 600_000, usefulLifeMonths: 60 });
    await act(seed, utcDayStart(Date.now()));
    expect((await footprint(seed, seed.assetId)).asset?.status).toBe(operation === "impair" ? "IMPAIRED" : "DISPOSED");
  });

  test("a non-finite date is refused with zero writes", async () => {
    const seed = await seedCapitalizedAsset({ name: "Guarded Asset", purchaseDate: capitalizedDay + 5 * 3_600_000, costMinor: 600_000, usefulLifeMonths: 60 });
    await expectRefusedWithoutWrites(seed, Number.NaN, "ASSET_EVENT_DATE_INVALID");
  });

  test("a date outside the JS Date range or with fractional ms is refused with ASSET_EVENT_DATE_INVALID and zero writes", async () => {
    const seed = await seedCapitalizedAsset({ name: "Guarded Asset", purchaseDate: capitalizedDay + 5 * 3_600_000, costMinor: 600_000, usefulLifeMonths: 60 });
    await expectRefusedWithoutWrites(seed, -8_640_000_000_000_001, "ASSET_EVENT_DATE_INVALID");
    await expectRefusedWithoutWrites(seed, Date.now() - DAY_MS + 0.5, "ASSET_EVENT_DATE_INVALID");
  });

  test("a date before the capitalization day is refused with zero writes; the same day is admitted", async () => {
    const seed = await seedCapitalizedAsset({ name: "Guarded Asset", purchaseDate: capitalizedDay + 5 * 3_600_000, costMinor: 600_000, usefulLifeMonths: 60 });
    await expectRefusedWithoutWrites(seed, capitalizedDay - 1, "ASSET_EVENT_BEFORE_CAPITALIZATION");
    await act(seed, capitalizedDay); // capitalized at 05:00 that day; midnight is the SAME UTC day
    expect((await footprint(seed, seed.assetId)).asset?.status).toBe(operation === "impair" ? "IMPAIRED" : "DISPOSED");
  });

  test("a date before the latest cron DEPRECIATE event day is refused; the same day is admitted", async () => {
    const seed = await seedCapitalizedAsset({ name: "Guarded Asset", purchaseDate: capitalizedDay + 5 * 3_600_000, costMinor: 600_000, usefulLifeMonths: 60 });
    const summary: string = await seed.t.action(internal.crons.triggerFixedAssetDepreciation, {});
    expect(summary).toMatch(/posted 1\/1/i);
    const depreciated = await seed.t.run((ctx) =>
      ctx.db.query("fixedAssetEvents").withIndex("by_asset", (q) => q.eq("assetId", seed.assetId)).collect()
    );
    const depreciateDay = utcDayStart(Math.max(...depreciated.filter((e) => e.type === "DEPRECIATE").map((e) => e.occurredAt)));

    await expectRefusedWithoutWrites(seed, depreciateDay - DAY_MS, "ASSET_EVENT_BEFORE_DEPRECIATION");
    await act(seed, depreciateDay);
    expect((await footprint(seed, seed.assetId)).asset?.status).toBe(operation === "impair" ? "IMPAIRED" : "DISPOSED");
  });
});

describe("SCRUM-542 — dispose of an IMPAIRED asset", () => {
  test("a disposal dated before the impairment day is refused with zero writes; the same day is admitted", async () => {
    const seed = await seedAssetDealer();
    const capitalizedDay = utcDayStart(Date.now()) - 20 * DAY_MS;
    const impairedDay = utcDayStart(Date.now()) - 5 * DAY_MS;
    const assetId = await seed.asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: crypto.randomUUID(),
      orgId: seed.orgId,
      name: "Impaired Then Disposed",
      purchaseDate: capitalizedDay + 3_600_000,
      costMinor: 600_000,
      usefulLifeMonths: 60,
    });
    await seed.asOwner.mutation(api.fixedAssets.impair, {
      orgId: seed.orgId, assetId, amountMinor: 10_000, occurredAt: impairedDay + 12 * 3_600_000,
    });

    const before = await footprint(seed, assetId);
    expect(
      await refusalCode(
        seed.asOwner.mutation(api.fixedAssets.dispose, {
          orgId: seed.orgId, assetId, proceedsMinor: 0, occurredAt: impairedDay - 1,
        })
      )
    ).toBe("ASSET_EVENT_BEFORE_IMPAIRMENT");
    expect(await footprint(seed, assetId)).toEqual(before);

    await seed.asOwner.mutation(api.fixedAssets.dispose, {
      orgId: seed.orgId, assetId, proceedsMinor: 0, occurredAt: impairedDay,
    });
    expect((await footprint(seed, assetId)).asset?.status).toBe("DISPOSED");
  });
});

describe("SCRUM-542 — fixed asset list visibility", () => {
  test.each(["before", "after"] as const)(
    "a live asset created %s 105 deleted rows is on the FIRST page of list",
    async (when) => {
      const seed = await seedAssetDealer();
      const { t, orgId, asOwner } = seed;
      const insertLive = () =>
        t.run((ctx) => ctx.db.insert("fixedAssets", { orgId, name: "Live", purchaseDate: Date.now(), costMinor: 1000 }));
      // "before": the live row is older, so the desc-ordered scan meets all 105 deleted rows first.
      const liveBefore = when === "before" ? await insertLive() : undefined;
      await seedDeleted(seed, 105);
      const liveId = liveBefore ?? (await insertLive());
      const page = await asOwner.query(api.fixedAssets.list, {
        orgId, paginationOpts: { numItems: 10, cursor: null },
      });
      expect(page.page.map((row) => row._id)).toEqual([liveId]);
      expect(page.isDone).toBe(true);
    }
  );
  test("CONTROL: an asset an admin restore left with isDeleted=false stays listed", async () => {
    const { t, orgId, asOwner } = await seedAssetDealer();
    const restoredId = await t.run((ctx) =>
      ctx.db.insert("fixedAssets", { orgId, name: "Restored", purchaseDate: Date.now(), costMinor: 1000, isDeleted: false })
    );
    const page = await asOwner.query(api.fixedAssets.list, {
      orgId, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map((row) => row._id)).toEqual([restoredId]);
  });

  test("the cron's active-asset listing never returns a deleted asset, across pages", async () => {
    const { t, orgId } = await seedAssetDealer();
    const liveIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      liveIds.push(
        await t.run((ctx) =>
          ctx.db.insert("fixedAssets", { orgId, name: `Live ${i}`, purchaseDate: Date.now(), costMinor: 1000, status: "ACTIVE" })
        )
      );
      await t.run((ctx) =>
        ctx.db.insert("fixedAssets", { orgId, name: `Gone ${i}`, purchaseDate: Date.now(), costMinor: 1000, status: "ACTIVE", isDeleted: true })
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await t.query(internal.fixedAssets.listActiveAssetsForDepreciation, { cursor, numItems: 2 });
      seen.push(...page.page.map((row) => row._id));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen.sort()).toEqual([...liveIds].sort());
  });
});

describe("SCRUM-542 — capitalize refuses a purchase date on a future UTC day", () => {
  const capitalizeArgs = (seed: Seed, purchaseDate: number) => ({
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    name: "Date Guard Asset",
    purchaseDate,
    costMinor: 600_000,
    usefulLifeMonths: 60,
  });

  test("the next UTC day is refused with ASSET_PURCHASE_DATE_IN_FUTURE and zero writes", async () => {
    const seed = await seedAssetDealer();
    const count = (table: "fixedAssets" | "fixedAssetEvents" | "accountingEvents" | "commandIdempotency") =>
      seed.t.run(async (ctx) => (await ctx.db.query(table).collect()).length);
    const before = {
      assets: await count("fixedAssets"),
      events: await count("fixedAssetEvents"),
      accounting: await count("accountingEvents"),
      idempotency: await count("commandIdempotency"),
    };
    const code = await refusalCode(
      seed.asOwner.mutation(api.fixedAssets.capitalize, capitalizeArgs(seed, utcDayStart(Date.now()) + DAY_MS))
    );
    expect(code).toBe("ASSET_PURCHASE_DATE_IN_FUTURE");
    expect({
      assets: await count("fixedAssets"),
      events: await count("fixedAssetEvents"),
      accounting: await count("accountingEvents"),
      idempotency: await count("commandIdempotency"),
    }).toEqual(before);
  });

  test("CONTROL: a purchase date earlier today (UTC) is admitted, and a same-day disposal is admitted", async () => {
    const seed = await seedAssetDealer();
    const assetId = await seed.asOwner.mutation(
      api.fixedAssets.capitalize,
      capitalizeArgs(seed, utcDayStart(Date.now()))
    );
    await seed.asOwner.mutation(api.fixedAssets.dispose, {
      orgId: seed.orgId, assetId, proceedsMinor: 0, occurredAt: Date.now(),
    });
    expect((await footprint(seed, assetId)).asset?.status).toBe("DISPOSED");
  });
});

describe("SCRUM-542 — capitalize refuses an unrepresentable date before any write", () => {
  const TABLES = ["fixedAssets", "fixedAssetEvents", "accountingEvents", "pendingAccountingEvents", "commandIdempotency"] as const;
  const args = (seed: Seed, purchaseDate: number, depreciationStartDate?: number) => ({
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    name: "Representable Date Asset",
    purchaseDate,
    costMinor: 600_000,
    usefulLifeMonths: 60,
    ...(depreciationStartDate === undefined ? {} : { depreciationStartDate }),
  });
  async function counts(seed: Seed) {
    const out: Record<string, number> = {};
    for (const table of TABLES) out[table] = await seed.t.run(async (ctx) => (await ctx.db.query(table).collect()).length);
    return out;
  }
  async function expectRefusedWithoutWrites(seed: Seed, payload: ReturnType<typeof args>, code: string) {
    const before = await counts(seed);
    expect(await refusalCode(seed.asOwner.mutation(api.fixedAssets.capitalize, payload))).toBe(code);
    expect(await counts(seed)).toEqual(before);
  }

  test.each([
    ["below the Date range", -8_640_000_000_000_001],
    ["NaN", Number.NaN],
    ["fractional milliseconds", Date.now() - 86_400_000 + 0.5],
  ])("a purchaseDate %s is refused with ASSET_PURCHASE_DATE_INVALID and zero writes", async (_label, purchaseDate) => {
    const seed = await seedAssetDealer();
    await expectRefusedWithoutWrites(seed, args(seed, purchaseDate), "ASSET_PURCHASE_DATE_INVALID");
  });

  test.each([
    ["NaN", Number.NaN],
    ["above the Date range", 8_640_000_000_000_001],
  ])("a depreciationStartDate %s is refused with ASSET_DEPRECIATION_START_DATE_INVALID and zero writes", async (_label, start) => {
    const seed = await seedAssetDealer();
    await expectRefusedWithoutWrites(seed, args(seed, Date.now() - 86_400_000, start), "ASSET_DEPRECIATION_START_DATE_INVALID");
  });

  test("CONTROL: the exact lower Date bound passes validity (any later outcome is not the INVALID code)", async () => {
    const seed = await seedAssetDealer();
    const code = await refusalCode(seed.asOwner.mutation(api.fixedAssets.capitalize, args(seed, -8_640_000_000_000_000)));
    expect(code).not.toBe("ASSET_PURCHASE_DATE_INVALID");
  });

  test("CONTROL: a valid past purchaseDate with a future depreciationStartDate is admitted", async () => {
    const seed = await seedAssetDealer();
    const assetId = await seed.asOwner.mutation(
      api.fixedAssets.capitalize,
      args(seed, Date.now() - 86_400_000, Date.now() + 30 * 86_400_000)
    );
    expect((await footprint(seed, assetId)).asset?.status).toBe("ACTIVE");
  });
});

describe("SCRUM-561 - utcDateLabel", () => {
  test.each([
    [0, "1970-01-01"],
    [Date.UTC(2026, 9, 2, 15, 30), "2026-10-02"],
    [Date.UTC(2026, 9, 2, 23, 59, 59, 999), "2026-10-02"],
    [Date.UTC(2026, 9, 3, 0, 0, 0, 0), "2026-10-03"],
    [-1, "1969-12-31"],
    [-0.1, "1969-12-31"], // a fractional instant before 1970 is labelled with the day utcDay floors to
    [-8_640_000_000_000_000, "-271821-04-20"],
    [8_640_000_000_000_000, "275760-09-13"],
  ])("%s renders as %s", async (ms, label) => {
    const { utcDateLabel } = await import("./utils/ledgerCalendar");
    expect(utcDateLabel(ms)).toBe(label);
  });
});

const isoDay = (ms: number) => new Date(utcDayStart(ms)).toISOString().slice(0, 10);

describe("SCRUM-561 - date refusals name the UTC day they enforced", () => {
  const D = utcDayStart(Date.now()) - 30 * DAY_MS;
  const H = 3_600_000;
  afterEach(() => vi.useRealTimers());
  // The clock is pinned to the last millisecond of a UTC day so the "today" label cannot flake at midnight.
  const PINNED_NOW = Date.UTC(2026, 9, 2, 23, 59, 59, 999);
  const pinClock = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
  };
  type Refusal = { code: string; message: string; earliestDate?: string; today?: string };

  /** A capitalized asset (cost 600_000, 60 months) bought at `purchaseDate`. */
  const seedAsset = (purchaseDate: number) => seedCapitalizedAsset({ purchaseDate, costMinor: 600_000, usefulLifeMonths: 60 });

  function dispose(seed: Seed & { assetId: Id<"fixedAssets"> }, occurredAt: number) {
    return seed.asOwner.mutation(api.fixedAssets.dispose, { orgId: seed.orgId, assetId: seed.assetId, proceedsMinor: 0, occurredAt });
  }
  function impair(seed: Seed & { assetId: Id<"fixedAssets"> }, occurredAt: number) {
    return seed.asOwner.mutation(api.fixedAssets.impair, { orgId: seed.orgId, assetId: seed.assetId, amountMinor: 10_000, occurredAt });
  }
  async function refusal(attempt: Promise<unknown>): Promise<Refusal> {
    try {
      await attempt;
    } catch (caught) {
      return (caught as { data: Refusal }).data;
    }
    throw new Error("expected a refusal");
  }
  /** The refusal has `code`, names `day` (an instant on the expected UTC day) in `field` and in its message. */
  function expectDated(data: Refusal, code: string, field: "earliestDate" | "today", day: number) {
    expect(data.code).toBe(code);
    expect(data[field]).toBe(isoDay(day));
    expect(data.message).toContain(isoDay(day));
    expect(data.message).not.toContain("{");
  }
  function insertEvent(seed: Seed & { assetId: Id<"fixedAssets"> }, type: "DEPRECIATE" | "IMPAIR", occurredAt: number) {
    return seed.t.run((ctx) =>
      ctx.db.insert("fixedAssetEvents", {
        orgId: seed.orgId, assetId: seed.assetId, type, amountMinor: 1, currency: "USD", occurredAt, actorId: seed.userId, createdAt: Date.now(),
      })
    );
  }

  test.each([
    ["15:30 UTC", 15.5 * H],
    ["23:30 UTC", 23.5 * H],
    ["00:00 UTC", 0],
  ])("BEFORE_CAPITALIZATION names the capitalization day (bound at %s) and writes nothing", async (_label, offset) => {
    const seed = await seedAsset(D + offset);
    const before = await footprint(seed, seed.assetId);
    expectDated(await refusal(dispose(seed, D - 1)), "ASSET_EVENT_BEFORE_CAPITALIZATION", "earliestDate", D);
    expect(await footprint(seed, seed.assetId)).toEqual(before);
  });

  test("BEFORE_DEPRECIATION names the LATEST depreciation day, whatever the insertion order", async () => {
    const seed = await seedAsset(D + 5 * H);
    await insertEvent(seed, "DEPRECIATE", D + 12 * DAY_MS + 15.5 * H);
    await insertEvent(seed, "DEPRECIATE", D + 2 * DAY_MS + 15.5 * H);
    await insertEvent(seed, "DEPRECIATE", D + 7 * DAY_MS + 15.5 * H);
    const before = await footprint(seed, seed.assetId);
    expectDated(await refusal(dispose(seed, D + 11 * DAY_MS)), "ASSET_EVENT_BEFORE_DEPRECIATION", "earliestDate", D + 12 * DAY_MS);
    expect(await footprint(seed, seed.assetId)).toEqual(before);
    await dispose(seed, D + 12 * DAY_MS); // the same UTC day is still admitted
    expect((await footprint(seed, seed.assetId)).asset?.status).toBe("DISPOSED");
  });

  test("BEFORE_IMPAIRMENT names the impairment day for a disposal", async () => {
    const seed = await seedAsset(D + H);
    const impairedAt = D + 9 * DAY_MS + 15.5 * H;
    await impair(seed, impairedAt);
    const before = await footprint(seed, seed.assetId);
    expectDated(await refusal(dispose(seed, D + 8 * DAY_MS + 23.5 * H)), "ASSET_EVENT_BEFORE_IMPAIRMENT", "earliestDate", impairedAt);
    expect(await footprint(seed, seed.assetId)).toEqual(before);
  });

  test("CONTROL: an impairment is not bounded by an earlier IMPAIR event", async () => {
    const seed = await seedAsset(D + H);
    await insertEvent(seed, "IMPAIR", D + 9 * DAY_MS + 15.5 * H);
    await impair(seed, D + 3 * DAY_MS);
    expect((await footprint(seed, seed.assetId)).asset?.status).toBe("IMPAIRED");
  });

  test("precedence: capitalization wins over depreciation and names ITS date", async () => {
    const seed = await seedAsset(D + 15.5 * H);
    await insertEvent(seed, "DEPRECIATE", D + 10 * DAY_MS + 15.5 * H);
    expectDated(await refusal(dispose(seed, D - 1)), "ASSET_EVENT_BEFORE_CAPITALIZATION", "earliestDate", D);
  });

  test("precedence: depreciation wins over impairment for a disposal and names ITS date", async () => {
    const seed = await seedAsset(D + H);
    await insertEvent(seed, "DEPRECIATE", D + 10 * DAY_MS + 15.5 * H);
    await insertEvent(seed, "IMPAIR", D + 5 * DAY_MS + 15.5 * H);
    expectDated(await refusal(dispose(seed, D + 3 * DAY_MS)), "ASSET_EVENT_BEFORE_DEPRECIATION", "earliestDate", D + 10 * DAY_MS);
  });

  test("a legacy asset with no CAPITALIZE event falls back to its purchase date, and names it", async () => {
    const seed = await seedAssetDealer();
    const assetId = await seed.t.run((ctx) =>
      ctx.db.insert("fixedAssets", { orgId: seed.orgId, name: "Legacy", purchaseDate: D + 15.5 * H, costMinor: 600_000, status: "ACTIVE" })
    );
    const legacy = { ...seed, assetId };
    expectDated(await refusal(dispose(legacy, D - 1)), "ASSET_EVENT_BEFORE_CAPITALIZATION", "earliestDate", D);
    await dispose(legacy, D);
    expect((await footprint(legacy, assetId)).asset?.status).toBe("DISPOSED");
  });

  test("an unrepresentable stored bound is ignored, never a NaN refusal", async () => {
    const seed = await seedAssetDealer();
    const assetId = await seed.t.run((ctx) =>
      ctx.db.insert("fixedAssets", { orgId: seed.orgId, name: "Legacy bad date", purchaseDate: 8_640_000_000_000_001, costMinor: 600_000, status: "ACTIVE" })
    );
    const legacy = { ...seed, assetId };
    await dispose(legacy, D);
    expect((await footprint(legacy, assetId)).asset?.status).toBe("DISPOSED");
    const events = await seed.t.run((ctx) => ctx.db.query("fixedAssetEvents").withIndex("by_asset", (q) => q.eq("assetId", assetId)).collect());
    expect(events.map((e) => e.type)).toEqual(["DISPOSE"]);
  });

  test.each(["impair", "dispose"] as const)("IN_FUTURE (%s) names today's UTC day", async (operation) => {
    const seed = await seedAsset(D + H);
    pinClock();
    const future = PINNED_NOW + 2 * DAY_MS;
    const data = await refusal(operation === "impair" ? impair(seed, future) : dispose(seed, future));
    expectDated(data, "ASSET_EVENT_DATE_IN_FUTURE", "today", PINNED_NOW);
    expect(data.today).toBe("2026-10-02");
  });

  test("capitalize IN_FUTURE names today's UTC day", async () => {
    const seed = await seedAssetDealer();
    pinClock();
    const data = await refusal(
      seed.asOwner.mutation(api.fixedAssets.capitalize, {
        idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, name: "Future", purchaseDate: PINNED_NOW + 2 * DAY_MS, costMinor: 600_000, usefulLifeMonths: 60,
      })
    );
    expectDated(data, "ASSET_PURCHASE_DATE_IN_FUTURE", "today", PINNED_NOW);
    expect(data.today).toBe("2026-10-02");
  });
});

describe("SCRUM-542 — refusal translations", () => {
  test("every new asset-date code has en and ar ServerError_ entries; en equals the server message", async () => {
    const { FIXED_ASSET_DATE_REFUSALS } = await import("./fixedAssets");
    const { dictionaries } = await import("../lib/i18n/dictionaries");
    const codes = Object.keys(FIXED_ASSET_DATE_REFUSALS);
    expect(codes.sort()).toEqual([
      "ASSET_EVENT_BEFORE_CAPITALIZATION",
      "ASSET_EVENT_BEFORE_DEPRECIATION",
      "ASSET_EVENT_BEFORE_IMPAIRMENT",
      "ASSET_EVENT_DATE_INVALID",
      "ASSET_EVENT_DATE_IN_FUTURE",
      "ASSET_PURCHASE_DATE_IN_FUTURE",
      "ASSET_PURCHASE_DATE_INVALID",
      "ASSET_DEPRECIATION_START_DATE_INVALID",
    ].sort());
    for (const code of codes) {
      const key = `ServerError_${code}`;
      const en = (dictionaries.en as Record<string, string>)[key];
      const ar = (dictionaries.ar as Record<string, string>)[key];
      const template = (FIXED_ASSET_DATE_REFUSALS as Record<string, string>)[code];
      // The EN dictionary equals the server template exactly, placeholder included.
      expect(en, `${key} en`).toBe(template);
      expect(ar, `${key} ar`).toMatch(/[؀-ۿ]/);
      for (const token of template.match(/\{\w+\}/g) ?? []) {
        expect(ar, `${key} ar keeps ${token}`).toContain(token);
      }
    }
    expect((dictionaries.en as Record<string, string>).DisposalAccountingDateLabel).toBeTruthy();
    expect((dictionaries.ar as Record<string, string>).DisposalAccountingDateLabel).toMatch(/[؀-ۿ]/);
  });
});

describe("SCRUM-561 - the placeholder is filled in the user's language", () => {
  test.each([
    ["ASSET_EVENT_BEFORE_CAPITALIZATION", "earliestDate"],
    ["ASSET_EVENT_BEFORE_DEPRECIATION", "earliestDate"],
    ["ASSET_EVENT_BEFORE_IMPAIRMENT", "earliestDate"],
    ["ASSET_EVENT_DATE_IN_FUTURE", "today"],
    ["ASSET_PURCHASE_DATE_IN_FUTURE", "today"],
  ] as const)("%s renders %s in EN and AR with nothing left over", async (code, field) => {
    const { FIXED_ASSET_DATE_REFUSALS } = await import("./fixedAssets");
    const { dictionaries } = await import("../lib/i18n/dictionaries");
    const { getLocalizedErrorMessage } = await import("../lib/errors");
    const { ConvexError } = await import("convex/values");
    const error = new ConvexError({ code, message: FIXED_ASSET_DATE_REFUSALS[code], [field]: "2026-03-09" });
    const en = getLocalizedErrorMessage(error, (k) => (dictionaries.en as Record<string, string>)[k] ?? k);
    const ar = getLocalizedErrorMessage(error, (k) => (dictionaries.ar as Record<string, string>)[k] ?? k);
    for (const text of [en, ar]) {
      expect(text).toContain("2026-03-09");
      expect(text).not.toContain("{");
    }
    expect(ar).toMatch(/[؀-ۿ]/);
  });
});

describe("SCRUM-561 - depreciateAssetForMonth stores only whole-millisecond instants", () => {
  async function counts(seed: Seed) {
    return seed.t.run(async (ctx) => ({
      events: (await ctx.db.query("fixedAssetEvents").collect()).length,
      journals: (await ctx.db.query("journalEntries").collect()).length,
    }));
  }
  const post = (seed: Seed & { assetId: Id<"fixedAssets"> }, occurredAt: number) =>
    seed.t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId: seed.orgId, assetId: seed.assetId, yearMonth: "2026-01", occurredAt, systemActorId: seed.userId,
    });

  test("a fractional occurredAt inside the month is refused and writes nothing", async () => {
    const seed = await seedCapitalizedAsset();
    const before = await counts(seed);
    await expect(post(seed, monthMid("2026-01") + 0.5)).rejects.toThrow(/whole-millisecond/);
    expect(await counts(seed)).toEqual(before);
  });

  test("CONTROL: the whole-millisecond instant still posts", async () => {
    const seed = await seedCapitalizedAsset();
    expect(await post(seed, monthMid("2026-01"))).toMatchObject({ posted: true });
  });
});
