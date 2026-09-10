/**
 * SCRUM-234 — the legacy-to-GL migration writer is retired.
 *
 * `accountingMigration.migrateUnpostedTransactions` used to be the sole
 * production origin of `sourceType: "transactions"` accounting events. It is
 * now an unconditional refusal, which is the clean-slate launch containment for
 * three established defect classes at once (SCRUM-234 collections + expenses,
 * SCRUM-188 sales, SCRUM-240 partial GL from a caught posting failure).
 *
 * Every test here asserts the FULL accounting footprint before and after the
 * refused call, not just the returned status: `accountingEvents`,
 * `pendingAccountingEvents`, `journalEntries`, `journalLines`,
 * `accountBalanceSnapshots` and `financialAuditLog`. The comparison is a
 * whole-footprint equality, so a
 * REMOVAL fails it exactly as loudly as an addition — an additions-only delta
 * would read a cancelled pending post as "no GL effect".
 *
 * WHAT THIS FILE DOES NOT PROVE, stated here because the file that used to
 * claim it has been deleted rather than repaired:
 *
 * Nothing prevents a FUTURE module from posting an accounting event under the
 * legacy `transactions` source family. `postAccountingEvent` takes a
 * caller-supplied `sourceType`, `accountingLedger.post` exposes it as a
 * free-form `v.string()` on an `internalMutation` with zero production callers,
 * and the outbox forwards a stored one on redrive.
 *
 * A source-level enumeration guarding that once lived in
 * `scripts/legacyMigrationWriterRetired.test.ts`. It was removed, not fixed: a
 * mutant that genuinely inserted into `accountingEvents` from the retired
 * handler — aliasing `ctx.db` and calling a computed method name — left that
 * guard entirely GREEN while this suite caught it. A textual scan cannot
 * measure that property, and one that says it can is worse than none, because
 * it reads as coverage. Real enforcement means refusing the source family at
 * the posting boundary, which is routed to the owner as its own decision.
 *
 * FAILING-FIRST CONTROL: run this file against `convex/accountingMigration.ts`
 * as it stands on protected main `62b5a5b9c` and the collection, expense, sale
 * and dryRun cases fail, because that source posts. The red run is recorded on
 * the SCRUM-234 Jira issue.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedAccountingDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "SCRUM-234 Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "s234_owner", email: "s234@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner", isSystemOwnerRole: true,
      permissions: [
        "view:finance", "manage:finance",
        "view:expenses", "create:expenses",
        "view:vehicles", "edit:vehicles",
        "view:customers", "view:sales", "create:sales",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Dana", lastName: "Saleh" })
  );

  const asOwner = t.withIdentity({ subject: "s234_owner", clerkId: "s234_owner" });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, customerId, asOwner };
}

type Dealer = Awaited<ReturnType<typeof seedAccountingDealer>>;

type FootprintTable =
  | "accountingEvents"
  | "pendingAccountingEvents"
  | "journalEntries"
  | "journalLines"
  | "accountBalanceSnapshots"
  // `postAccountingEvent` writes one of these as its final step on EVERY
  // successful post, including every duplicate the retired writer produced, so
  // omitting it would have left the "whole footprint" claim below approximate
  // rather than true.
  | "financialAuditLog";

/**
 * The whole accounting footprint of an org, as stable sorted identity lists.
 *
 * Comparing lists rather than counts is deliberate: counts can stay equal while
 * one row is deleted and another inserted. `toEqual` on the sorted ids fails on
 * an addition, a removal, or a swap.
 */
async function accountingFootprint(t: Dealer["t"], orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    // Scanned and narrowed in JS rather than by index: `pendingAccountingEvents`
    // has no `by_org` index, and the harness database holds one org anyway.
    const ids = async (table: FootprintTable) =>
      (await ctx.db.query(table).collect())
        .filter((row) => row.orgId === orgId)
        .map((row) => row._id.toString())
        .sort();
    return {
      accountingEvents: await ids("accountingEvents"),
      pendingAccountingEvents: await ids("pendingAccountingEvents"),
      journalEntries: await ids("journalEntries"),
      journalLines: await ids("journalLines"),
      accountBalanceSnapshots: await ids("accountBalanceSnapshots"),
      financialAuditLog: await ids("financialAuditLog"),
    };
  });
}

async function legacyRows(t: Dealer["t"], orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
}

async function eventsOfType(t: Dealer["t"], orgId: Id<"organizations">, eventType: string) {
  const events = await t.run((ctx) =>
    ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
  return events.filter((event) => event.eventType === eventType);
}

/**
 * Calls the retired mutation and asserts it refused with zero financial delta.
 *
 * There is no success shape left to inspect, so nothing is returned.
 */
async function expectRefusedWithNoDelta(
  dealer: Dealer,
  args: { dryRun?: boolean; limit?: number },
) {
  const before = await accountingFootprint(dealer.t, dealer.orgId);
  const legacyBefore = await legacyRows(dealer.t, dealer.orgId);

  await expect(
    dealer.asOwner.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId: dealer.orgId,
      ...args,
    })
  ).rejects.toThrow(/retired/i);

  expect(await accountingFootprint(dealer.t, dealer.orgId)).toEqual(before);
  // The legacy rows themselves are untouched too — the refusal lands before any
  // migration bookkeeping could mark one as handled.
  expect(await legacyRows(dealer.t, dealer.orgId)).toEqual(legacyBefore);
}

describe("SCRUM-234 — modern collection receipts can no longer be double-posted", () => {
  test("recordPayment leaves a legacy row, and the retired migration cannot post a second journal for it", async () => {
    const dealer = await seedAccountingDealer();
    const { t, orgId, customerId, asOwner } = dealer;

    const receivableId = await asOwner.mutation(api.collections.createReceivable, {
      orgId, customerId, sourceType: "INTERNAL_INSTALLMENT", title: "Installment",
      amount: 1000, dueDate: Date.now() + 86_400_000, creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asOwner.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receivableId, amount: 300, method: "CASH", paymentDate: Date.now(),
    });

    // The dual representation this defect depends on: one modern accounting
    // event sourced from `collectionPayments`, PLUS a legacy `transactions`
    // row that the migration's `sourceType: "transactions"` probe would map
    // back to COLLECTION_PAYMENT and fail to recognise as already posted.
    const collectionEvents = await eventsOfType(t, orgId, "COLLECTION_PAYMENT");
    expect(collectionEvents).toHaveLength(1);
    expect(collectionEvents[0].sourceType).toBe("collectionPayments");
    expect((await legacyRows(t, orgId)).filter((tx) => tx.category === "COLLECTION_PAYMENT")).toHaveLength(1);

    await expectRefusedWithNoDelta(dealer, { dryRun: false });

    expect(await eventsOfType(t, orgId, "COLLECTION_PAYMENT")).toHaveLength(1);
  });

  test("clearCheque leaves a legacy row, and the retired migration cannot post a second journal for it", async () => {
    const dealer = await seedAccountingDealer();
    const { t, orgId, customerId, asOwner } = dealer;

    const receivableId = await asOwner.mutation(api.collections.createReceivable, {
      orgId, customerId, sourceType: "CHEQUE", title: "Cheque receivable",
      amount: 800, dueDate: Date.now() + 86_400_000, creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const chequeId = await asOwner.mutation(api.collections.registerCheque, {
      orgId, receivableId, customerId, bank: "Arab Bank", chequeNumber: "S234-1",
      chequeDate: Date.now() + 86_400_000, amount: 800,
    });
    await asOwner.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    const collectionEvents = await eventsOfType(t, orgId, "COLLECTION_PAYMENT");
    expect(collectionEvents).toHaveLength(1);
    expect(collectionEvents[0].sourceType).toBe("collectionPayments");
    expect((await legacyRows(t, orgId)).filter((tx) => tx.category === "COLLECTION_PAYMENT")).toHaveLength(1);

    await expectRefusedWithNoDelta(dealer, { dryRun: false });

    expect(await eventsOfType(t, orgId, "COLLECTION_PAYMENT")).toHaveLength(1);
  });
});

describe("SCRUM-234 — the EXPENSE_POSTED family reproduced in c18041", () => {
  test("a PAID expense keeps exactly one EXPENSE_POSTED event through a refused migration", async () => {
    const dealer = await seedAccountingDealer();
    const { t, orgId, asOwner } = dealer;

    await asOwner.mutation(api.expenses.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId, title: "Office supplies", amount: 100, date: Date.now(),
      category: "OTHER", status: "PAID", paymentMethod: "CASH",
    });

    // Exactly the precondition recorded on protected main 62b5a5b9c: one event
    // sourced from `expenses`, two journal lines, one legacy row.
    const expenseEvents = await eventsOfType(t, orgId, "EXPENSE_POSTED");
    expect(expenseEvents).toHaveLength(1);
    expect(expenseEvents[0].sourceType).toBe("expenses");
    const before = await accountingFootprint(t, orgId);
    expect(before.journalLines).toHaveLength(2);
    expect((await legacyRows(t, orgId)).filter((tx) => tx.category === "EXPENSE")).toHaveLength(1);

    // On protected main this produced a second EXPENSE_POSTED event and four
    // journal lines. It now refuses.
    await expectRefusedWithNoDelta(dealer, { dryRun: false });

    const after = await accountingFootprint(t, orgId);
    expect(await eventsOfType(t, orgId, "EXPENSE_POSTED")).toHaveLength(1);
    expect(after.journalLines).toHaveLength(2);
  });
});

describe("SCRUM-188 — a legacy VEHICLE_SALE row cannot be migrated into a duplicate sale", () => {
  test("the manually duplicated cashbook row posts nothing", async () => {
    const dealer = await seedAccountingDealer();
    const { t, orgId } = dealer;

    // SCRUM-188's reachability precondition is a hand-written legacy cashbook
    // row, which is what this insert is.
    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "IN", amount: 20000, date: Date.now(),
        category: "VEHICLE_SALE", description: "Manually duplicated legacy sale",
      })
    );

    await expectRefusedWithNoDelta(dealer, { dryRun: false });

    expect(await eventsOfType(t, orgId, "SALE_COMPLETED")).toHaveLength(0);
  });
});

describe("SCRUM-240 — partial-GL reachability through this path is structurally absent", () => {
  test("a mixed batch of postable and unmappable rows never enters financial posting", async () => {
    const dealer = await seedAccountingDealer();
    const { t, orgId } = dealer;

    // SCRUM-240 needed the loop to post some rows and then catch a failure on a
    // later one, committing the earlier postings (a caught exception COMMITS in
    // Convex). There is no loop left to enter: the refusal is the first
    // statement in the handler, ahead of classification and ahead of the
    // tenancy guard.
    for (const [category, type, amount] of [
      ["EXPENSE", "OUT", 100],
      ["COLLECTION_PAYMENT", "IN", 200],
      ["OTHER", "OUT", 50], // no mapping rule — the row the old loop skipped
      ["REFUND", "OUT", 25], // likewise unmapped
      ["VEHICLE_SALE", "IN", 9000],
    ] as const) {
      await t.run((ctx) =>
        ctx.db.insert("transactions", {
          orgId, type, amount, date: Date.now(), category, description: `legacy ${category}`,
        })
      );
    }

    const before = await accountingFootprint(t, orgId);
    expect(before.accountingEvents).toHaveLength(0);
    expect(before.journalEntries).toHaveLength(0);
    expect(before.journalLines).toHaveLength(0);

    await expectRefusedWithNoDelta(dealer, { dryRun: false, limit: 200 });
  });
});

describe("SCRUM-234 — dryRun is not the authority boundary, and the read-only surface survives", () => {
  // One test block per dryRun state, deliberately not one block making three
  // calls: a bundled block aborts on its first internal failure, so the other
  // two states would never be independently exercised in a failing run — and
  // the evidence count would not reconstruct.
  test.each([
    ["dryRun true", { dryRun: true }],
    ["dryRun false", { dryRun: false }],
    ["dryRun omitted", {}],
  ] as const)("%s is refused with zero financial delta", async (_label, args) => {
    const dealer = await seedAccountingDealer();
    await dealer.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: dealer.orgId, type: "OUT", amount: 500, date: Date.now(),
        category: "EXPENSE", description: "Marketing",
      })
    );

    await expectRefusedWithNoDelta(dealer, args);
  });

  test("callers with no identity and no membership are refused the same way, writing nothing", async () => {
    // The source places the refusal ahead of `requireTenantAuth` on purpose,
    // and the commit message makes a security-relevant claim about that: no
    // caller-dependent branch exists, so the tenancy guard's impersonation
    // audit-write never fires on behalf of a call that can never act. Asserted
    // rather than assumed.
    const dealer = await seedAccountingDealer();
    const { t, orgId } = dealer;
    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 100, date: Date.now(), category: "EXPENSE", description: "Office supplies",
      })
    );

    const outsiderUserId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "s234_outsider", email: "outsider@example.com", name: "Outsider" })
    );
    expect(outsiderUserId).toBeTruthy();

    const before = await accountingFootprint(t, orgId);
    const legacyBefore = await legacyRows(t, orgId);

    for (const caller of [
      t, // no identity at all
      t.withIdentity({ subject: "s234_outsider", clerkId: "s234_outsider" }), // authenticated, not a member
    ]) {
      await expect(
        caller.mutation(api.accountingMigration.migrateUnpostedTransactions, { orgId, dryRun: false })
      ).rejects.toThrow(/retired/i);
    }

    // Including the admin audit trail — the table `requireTenantAuth` writes
    // its `impersonated-write:*` row into. Nothing was written on behalf of a
    // call that could never act.
    const adminAudit = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(adminAudit).toEqual([]);
    expect(await accountingFootprint(t, orgId)).toEqual(before);
    expect(await legacyRows(t, orgId)).toEqual(legacyBefore);
  });

  test("the read-only audit queries remain usable and mutate nothing", async () => {
    const dealer = await seedAccountingDealer();
    const { t, orgId, asOwner } = dealer;
    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 100, date: Date.now(), category: "EXPENSE", description: "Office supplies",
      })
    );

    const before = await accountingFootprint(t, orgId);
    const legacyBefore = await legacyRows(t, orgId);

    const audit = await asOwner.query(api.accountingMigration.auditLegacyTransactions, { orgId, onlyUnposted: true });
    expect(audit.unpostedCount).toBe(1);
    expect(audit.rows[0].eventType).toBe("EXPENSE_POSTED");

    const gap = await asOwner.query(api.accountingMigration.migrationGapAnalysis, { orgId });
    expect(gap.gl.events).toBe(0);

    const dup = await asOwner.query(api.accountingMigration.duplicateEventCheck, { orgId, eventType: "EXPENSE_POSTED" });
    expect(dup.duplicateCount).toBe(0);

    expect(await accountingFootprint(t, orgId)).toEqual(before);
    expect(await legacyRows(t, orgId)).toEqual(legacyBefore);
  });
});
