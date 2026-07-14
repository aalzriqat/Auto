/**
 * Phase 17 tests — legacy money migration + accountant sign-off.
 *
 * Acceptance gates covered: an opening balance is posted, approved (only
 * once), and reconciled with a recorded sign-off; the migration backfills
 * close the categories previously left as no_rule_for_category; a
 * parallel-reporting comparison surfaces legacy vs GL totals and any
 * still-unmigrated rows.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedCutoverDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase17 Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "p17_owner", email: "p17owner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  // A second finance-authorized user for opening-balance segregation of
  // duties (approver must differ from the preparer).
  const reviewerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p17_reviewer", email: "p17reviewer@example.com", name: "Reviewer" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: reviewerId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: "p17_owner", clerkId: "p17_owner" });
  const asReviewer = t.withIdentity({ subject: "p17_reviewer", clerkId: "p17_reviewer" });

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

  const accounts = await asOwner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  return { t, orgId, userId, reviewerId, asOwner, asReviewer, accounts };
}

type Ctx = Awaited<ReturnType<typeof seedCutoverDealer>>;

function account(ctx: Ctx, systemKey: string) {
  const found = ctx.accounts.find((a) => a.systemKey === systemKey);
  if (!found) throw new Error(`Account with systemKey ${systemKey} not found in seeded chart.`);
  return found;
}

describe("Phase 17 — opening balance journal", () => {
  test("drafts, approves (by a different user), posts a balanced entry categorized OPENING_BALANCE, and can only be done once", async () => {
    const ctx = await seedCutoverDealer();
    const cash = account(ctx, "CASH_ON_HAND");
    const capital = account(ctx, "PARTNER_CAPITAL");

    const draft = await ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
      orgId: ctx.orgId,
      asOfDate: Date.now(),
      lines: [
        { accountId: cash._id, debitMinor: 1_000_000, creditMinor: 0 },
        { accountId: capital._id, debitMinor: 0, creditMinor: 1_000_000 },
      ],
    });
    expect(draft.draftId).toBeTruthy();

    // The same preparer cannot also approve their own draft.
    await expect(
      ctx.asOwner.mutation(api.accountingCutover.approveOpeningBalance, {
        orgId: ctx.orgId,
        draftId: draft.draftId as Id<"openingBalanceDrafts">,
      })
    ).rejects.toThrow(/cannot be the same as the preparer/i);

    const result = await ctx.asReviewer.mutation(api.accountingCutover.approveOpeningBalance, {
      orgId: ctx.orgId,
      draftId: draft.draftId as Id<"openingBalanceDrafts">,
    });
    expect(result.journalId).toBeTruthy();

    const journal = await ctx.t.run((c) => c.db.get(result.journalId as Id<"journalEntries">));
    expect(journal?.category).toBe("OPENING_BALANCE");
    expect(journal?.status).toBe("POSTED");
    expect(journal?.postedBy).toBe(ctx.reviewerId);

    const lines = await ctx.t.run((c) =>
      c.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", result.journalId as Id<"journalEntries">)).collect()
    );
    const debit = lines.reduce((s, l) => s + l.debitMinor, 0);
    const credit = lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(debit).toBe(1_000_000);
    expect(credit).toBe(1_000_000);

    expect(await ctx.asOwner.query(api.accountingCutover.hasOpeningBalance, { orgId: ctx.orgId })).toBe(true);

    await expect(
      ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
        orgId: ctx.orgId,
        asOfDate: Date.now(),
        lines: [
          { accountId: cash._id, debitMinor: 500, creditMinor: 0 },
          { accountId: capital._id, debitMinor: 0, creditMinor: 500 },
        ],
      })
    ).rejects.toThrow(/already been posted or is awaiting approval/i);
  });

  test("a rejected draft can be drafted again", async () => {
    const ctx = await seedCutoverDealer();
    const cash = account(ctx, "CASH_ON_HAND");
    const capital = account(ctx, "PARTNER_CAPITAL");

    const draft = await ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
      orgId: ctx.orgId,
      asOfDate: Date.now(),
      lines: [
        { accountId: cash._id, debitMinor: 1_000, creditMinor: 0 },
        { accountId: capital._id, debitMinor: 0, creditMinor: 1_000 },
      ],
    });

    await expect(
      ctx.asOwner.mutation(api.accountingCutover.rejectOpeningBalanceDraft, {
        orgId: ctx.orgId,
        draftId: draft.draftId as Id<"openingBalanceDrafts">,
        rejectionReason: "Wrong numbers",
      })
    ).rejects.toThrow(/cannot be the same as the preparer/i);

    await ctx.asReviewer.mutation(api.accountingCutover.rejectOpeningBalanceDraft, {
      orgId: ctx.orgId,
      draftId: draft.draftId as Id<"openingBalanceDrafts">,
      rejectionReason: "Wrong numbers",
    });

    const redrafted = await ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
      orgId: ctx.orgId,
      asOfDate: Date.now(),
      lines: [
        { accountId: cash._id, debitMinor: 2_000, creditMinor: 0 },
        { accountId: capital._id, debitMinor: 0, creditMinor: 2_000 },
      ],
    });
    expect(redrafted.draftId).toBeTruthy();
  });

  test("rejects an unbalanced opening balance", async () => {
    const ctx = await seedCutoverDealer();
    const cash = account(ctx, "CASH_ON_HAND");
    const capital = account(ctx, "PARTNER_CAPITAL");

    await expect(
      ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
        orgId: ctx.orgId,
        asOfDate: Date.now(),
        lines: [
          { accountId: cash._id, debitMinor: 1_000, creditMinor: 0 },
          { accountId: capital._id, debitMinor: 0, creditMinor: 900 },
        ],
      })
    ).rejects.toThrow(/unbalanced/i);
  });

  test("rejects an opening balance dated outside any open period", async () => {
    const ctx = await seedCutoverDealer();
    const cash = account(ctx, "CASH_ON_HAND");
    const capital = account(ctx, "PARTNER_CAPITAL");

    await expect(
      ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
        orgId: ctx.orgId,
        asOfDate: Date.UTC(2010, 0, 1),
        lines: [
          { accountId: cash._id, debitMinor: 1_000, creditMinor: 0 },
          { accountId: capital._id, debitMinor: 0, creditMinor: 1_000 },
        ],
      })
    ).rejects.toThrow(/no open accounting period/i);
  });
});

describe("Phase 17 — minor-unit backfills", () => {
  test("backfills fixedAssets.costMinor from purchaseValue, is idempotent, and skips already-migrated rows", async () => {
    const ctx = await seedCutoverDealer();
    const legacyId = await ctx.t.run((c) =>
      c.db.insert("fixedAssets", { orgId: ctx.orgId, name: "Legacy Forklift", purchaseDate: Date.now(), purchaseValue: 2_500 })
    );
    // A fully Phase-11 asset should be left alone (already on minor units).
    const modernId = await ctx.asOwner.mutation(api.fixedAssets.capitalize, {
      orgId: ctx.orgId, name: "New Asset", purchaseDate: Date.now(), costMinor: 400_000, usefulLifeMonths: 24,
    });

    const first = await ctx.asOwner.mutation(api.accountingMigration.backfillFixedAssetMinorUnits, { orgId: ctx.orgId });
    expect(first.scanned).toBe(2);
    expect(first.migrated).toBe(1);

    const legacy = await ctx.t.run((c) => c.db.get(legacyId));
    expect(legacy?.costMinor).toBe(2_500_000); // 2500 JOD * 1000 (scale 3)
    expect(legacy?.currency).toBe("JOD");
    expect(legacy?.purchaseValue).toBe(2_500); // legacy field untouched (widen-migrate-narrow: narrow deferred)

    const modern = await ctx.t.run((c) => c.db.get(modernId));
    expect(modern?.costMinor).toBe(400_000); // untouched by the backfill

    const second = await ctx.asOwner.mutation(api.accountingMigration.backfillFixedAssetMinorUnits, { orgId: ctx.orgId });
    expect(second.migrated).toBe(0); // idempotent — nothing left to backfill
  });

  test("backfills partnerEquity.openingBalanceMinor from currentBalance and the derived balance reflects it", async () => {
    const ctx = await seedCutoverDealer();
    const partnerId = await ctx.t.run((c) =>
      c.db.insert("partnerEquity", { orgId: ctx.orgId, partnerName: "Legacy Partner", currentBalance: 750, initialCapital: 750 })
    );

    const result = await ctx.asOwner.mutation(api.accountingMigration.backfillPartnerEquityMinorUnits, { orgId: ctx.orgId });
    expect(result.migrated).toBe(1);

    const partner = await ctx.t.run((c) => c.db.get(partnerId));
    expect(partner?.openingBalanceMinor).toBe(750_000);

    const page = await ctx.asOwner.query(api.partnerEquity.list, { orgId: ctx.orgId, paginationOpts: { numItems: 10, cursor: null } });
    const row = page.page.find((p) => p._id === partnerId);
    expect(row?.balanceMinor).toBe(750_000);

    const second = await ctx.asOwner.mutation(api.accountingMigration.backfillPartnerEquityMinorUnits, { orgId: ctx.orgId });
    expect(second.migrated).toBe(0);
  });

  test("backfills claims.claimAmountMinor from claimAmount and is idempotent", async () => {
    const ctx = await seedCutoverDealer();
    const legacyId = await ctx.t.run((c) =>
      c.db.insert("claims", {
        orgId: ctx.orgId, claimDate: Date.now(), financingEntity: "Legacy FC", buyerName: "Legacy Buyer",
        claimAmount: 300, status: "PENDING",
      })
    );

    const result = await ctx.asOwner.mutation(api.accountingMigration.backfillClaimMinorUnits, { orgId: ctx.orgId });
    expect(result.migrated).toBe(1);

    const claim = await ctx.t.run((c) => c.db.get(legacyId));
    expect(claim?.claimAmountMinor).toBe(300_000);
    expect(claim?.currency).toBe("JOD");

    const second = await ctx.asOwner.mutation(api.accountingMigration.backfillClaimMinorUnits, { orgId: ctx.orgId });
    expect(second.migrated).toBe(0);
  });
});

describe("Phase 17 — parallel reporting and sign-off", () => {
  test("compareLegacyToGL matches migrated totals and flags what's still unmigrated", async () => {
    const ctx = await seedCutoverDealer();
    const from = Date.UTC(2026, 0, 1);
    const to = Date.UTC(2026, 0, 31, 23, 59, 59);
    const inRange = Date.UTC(2026, 0, 15);

    await ctx.t.run((c) =>
      c.db.insert("transactions", { orgId: ctx.orgId, type: "OUT", amount: 100, date: inRange, category: "EXPENSE", description: "Legacy expense 1" })
    );
    await ctx.t.run((c) =>
      c.db.insert("transactions", { orgId: ctx.orgId, type: "OUT", amount: 50, date: inRange, category: "EXPENSE", description: "Legacy expense 2" })
    );

    const beforeMigration = await ctx.asOwner.query(api.accountingCutover.compareLegacyToGL, { orgId: ctx.orgId, fromDate: from, toDate: to });
    expect(beforeMigration.legacy.transactionCount).toBe(2);
    expect(beforeMigration.legacy.totalOutMinor).toBe(150_000);
    expect(beforeMigration.gl.migratedEventCount).toBe(0);
    expect(beforeMigration.unmigratedCount).toBe(2);

    await ctx.asOwner.mutation(api.accountingMigration.migrateUnpostedTransactions, { orgId: ctx.orgId, dryRun: false });

    const afterMigration = await ctx.asOwner.query(api.accountingCutover.compareLegacyToGL, { orgId: ctx.orgId, fromDate: from, toDate: to });
    expect(afterMigration.gl.migratedEventCount).toBe(2);
    expect(afterMigration.gl.isBalanced).toBe(true);
    // Every migrated expense posts DR expense / CR cash for the same minor amount both sides.
    expect(afterMigration.gl.totalDebitMinor).toBe(150_000);
    expect(afterMigration.gl.totalCreditMinor).toBe(150_000);
    expect(afterMigration.unmigratedCount).toBe(0);
  });

  test("signOffCutover records a point-in-time snapshot that listSignOffs returns", async () => {
    const ctx = await seedCutoverDealer();
    await ctx.t.run((c) =>
      c.db.insert("transactions", { orgId: ctx.orgId, type: "IN", amount: 200, date: Date.now(), category: "COLLECTION_PAYMENT", description: "Legacy collection" })
    );
    await ctx.asOwner.mutation(api.accountingMigration.migrateUnpostedTransactions, { orgId: ctx.orgId, dryRun: false });

    const result = await ctx.asOwner.mutation(api.accountingCutover.signOffCutover, { orgId: ctx.orgId, notes: "Reviewed and reconciled." });
    expect(result.snapshot.legacyTransactionCount).toBe(1);
    expect(result.snapshot.migratedTransactionCount).toBe(1);
    expect(result.snapshot.unmigratedTransactionCount).toBe(0);
    expect(result.snapshot.isBalanced).toBe(true);

    const signOffs = await ctx.asOwner.query(api.accountingCutover.listSignOffs, { orgId: ctx.orgId });
    expect(signOffs).toHaveLength(1);
    expect(signOffs[0].notes).toBe("Reviewed and reconciled.");
    expect(signOffs[0].signedOffBy).toBe(ctx.userId);
  });

  test("signOffCutover rejects when transactions remain unmigrated", async () => {
    const ctx = await seedCutoverDealer();
    await ctx.t.run((c) =>
      c.db.insert("transactions", { orgId: ctx.orgId, type: "IN", amount: 200, date: Date.now(), category: "COLLECTION_PAYMENT", description: "Never migrated" })
    );
    // Deliberately skip migrateUnpostedTransactions.

    await expect(
      ctx.asOwner.mutation(api.accountingCutover.signOffCutover, { orgId: ctx.orgId })
    ).rejects.toThrow(/still unmigrated/i);
  });

  test("signOffCutover rejects when the trial balance is unbalanced", async () => {
    const ctx = await seedCutoverDealer();
    const cash = account(ctx, "CASH_ON_HAND");
    // Insert a lone unbalanced journal entry directly, bypassing the
    // balanced-lines validators that every real posting path enforces —
    // simulates a corrupted/hand-edited ledger for this guard's purpose.
    await ctx.t.run(async (c) => {
      const period = (await ctx.asOwner.query(api.accountingPeriods.list, { orgId: ctx.orgId }))[0];
      const journalId = await c.db.insert("journalEntries", {
        orgId: ctx.orgId, periodId: period._id, journalNumber: "TEST-1", accountingDate: Date.now(),
        sourceType: "test", sourceId: "1", category: "MANUAL", memo: "Unbalanced", status: "POSTED",
        currency: "JOD", postedBy: ctx.userId, postedAt: Date.now(), createdAt: Date.now(),
      });
      await c.db.insert("journalLines", {
        orgId: ctx.orgId, journalEntryId: journalId, lineNumber: 1, accountId: cash._id,
        debitMinor: 1_000, creditMinor: 0, currency: "JOD", scale: 3, accountingDate: Date.now(),
      });
    });

    await expect(
      ctx.asOwner.mutation(api.accountingCutover.signOffCutover, { orgId: ctx.orgId })
    ).rejects.toThrow(/unbalanced/i);
  });

  test("signOffCutover rejects a signer who approved the opening balance themselves", async () => {
    const ctx = await seedCutoverDealer();
    const cash = account(ctx, "CASH_ON_HAND");
    const capital = account(ctx, "PARTNER_CAPITAL");

    const draft = await ctx.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
      orgId: ctx.orgId,
      asOfDate: Date.now(),
      lines: [
        { accountId: cash._id, debitMinor: 1_000, creditMinor: 0 },
        { accountId: capital._id, debitMinor: 0, creditMinor: 1_000 },
      ],
    });
    await ctx.asReviewer.mutation(api.accountingCutover.approveOpeningBalance, {
      orgId: ctx.orgId,
      draftId: draft.draftId as Id<"openingBalanceDrafts">,
    });

    await expect(
      ctx.asReviewer.mutation(api.accountingCutover.signOffCutover, { orgId: ctx.orgId })
    ).rejects.toThrow(/must be different from whoever approved/i);

    // A third, uninvolved user can sign off cleanly.
    const signer = await ctx.asOwner.mutation(api.accountingCutover.signOffCutover, { orgId: ctx.orgId });
    expect(signer.signOffId).toBeTruthy();
  });
});

describe("Phase 17 — settling a legacy claim backfilled by the minor-unit migration", () => {
  test("settle() self-heals a missing receivable instead of posting to the GL with no subledger record", async () => {
    const { t, orgId, asOwner } = await seedCutoverDealer();

    // A pre-Phase-13 claim: only the legacy major-unit field, no
    // claimAmountMinor and (crucially) no receivableDocumentId, since add()
    // is the only place that ever creates one and this row predates it.
    const legacyClaimId = await t.run((ctx) =>
      ctx.db.insert("claims", {
        orgId, claimDate: Date.now(), financingEntity: "Legacy FC", buyerName: "Legacy Buyer",
        claimAmount: 500, status: "PENDING",
      })
    );

    await asOwner.mutation(api.accountingMigration.backfillClaimMinorUnits, { orgId });

    const claimBeforeSettle = await t.run((ctx) => ctx.db.get(legacyClaimId));
    expect(claimBeforeSettle?.claimAmountMinor).toBe(500_000);
    expect(claimBeforeSettle?.receivableDocumentId).toBeUndefined();

    await asOwner.mutation(api.claims.settle, { orgId, claimId: legacyClaimId, paymentMethod: "BANK_TRANSFER" });

    const claimAfterSettle = await t.run((ctx) => ctx.db.get(legacyClaimId));
    expect(claimAfterSettle?.status).toBe("PAID");
    expect(claimAfterSettle?.receivableDocumentId).toBeTruthy();

    const receivable = await t.run((ctx) => ctx.db.get(claimAfterSettle!.receivableDocumentId!));
    expect(receivable?.status).toBe("PAID");
    expect(receivable?.originalAmountMinor).toBe(500_000);

    const allocations = await t.run((ctx) =>
      ctx.db.query("paymentAllocations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0].receivableDocumentId).toBe(claimAfterSettle!.receivableDocumentId);
    expect(allocations[0].amountMinor).toBe(500_000);
  });
});
