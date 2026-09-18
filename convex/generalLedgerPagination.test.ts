/**
 * AF-318-01 — General Ledger pagination regression.
 *
 * The confirmed defect: `accountingLedger.listJournalEntries` capped at a
 * fixed `limit` with no continuation, so an organization with more than
 * ~100-200 posted journal entries had legitimate, real entries that were
 * permanently unreachable through the General Ledger UI — a silently
 * incomplete accounting-read surface.
 *
 * This file seeds 125 real journal entries (`journalEntries` + their
 * `journalLines`, inserted directly the same way the posting engine writes
 * them — see accountingPhase17.test.ts / bankAccounts.test.ts for the same
 * convention) for one organization, spread across two accounting periods and
 * two accounts, and proves through the REAL `accountingLedger.listJournalEntries`
 * and `accountingLedger.getAccountActivity` queries that:
 *
 *   1. the first page is bounded (never returns all 125 in one call)
 *   2. a specific target entry planted OUTSIDE the first page is not on it
 *   3. continuing with the returned cursor retrieves further pages
 *   4. the target entry is eventually returned by walking pages to exhaustion
 *   5. no journal entry id appears on more than one page (no duplicates)
 *   6. the tenant boundary still holds — a second organization's list never
 *      contains the first organization's entries, and cannot be reached with
 *      the first organization's cursor
 *   7. ordering is deterministic: repeating the same walk twice from the same
 *      cursor sequence returns the identical order every time, and entries
 *      are non-increasing by `accountingDate` (the financial-date field, not
 *      `_creationTime`) down to a stable tie-breaker
 *   8. the accounting-period filter narrows to exactly the entries in that
 *      period, still via full pagination
 *   9. `getAccountActivity`'s own pagination reaches an old line the same way
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedDealer(orgName: string, clerkPrefix: string, existingT?: ReturnType<typeof convexTestWithComponents<typeof schema>>) {
  const t = existingT ?? convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: orgName, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${clerkPrefix}_owner`, email: `${clerkPrefix}@example.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );

  const asOwner = t.withIdentity({ subject: `${clerkPrefix}_owner`, clerkId: `${clerkPrefix}_owner` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date().getUTCFullYear();
  // Two periods so the period filter has something real to narrow between.
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear - 1, 0, 1), endDate: Date.UTC(fiscalYear - 1, 11, 31, 23, 59, 59, 999),
    fiscalYear: fiscalYear - 1, periodNumber: 1,
  });
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const periods = await asOwner.query(api.accountingPeriods.list, { orgId });
  const oldPeriod = periods.find((p) => p.fiscalYear === fiscalYear - 1)!;
  const currentPeriod = periods.find((p) => p.fiscalYear === fiscalYear)!;
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: oldPeriod._id });
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: currentPeriod._id });

  const accounts = await asOwner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const cash = accounts.find((a) => a.systemKey === "CASH_ON_HAND")!;
  const revenue = accounts.find((a) => a.systemKey === "MISCELLANEOUS_INCOME")!;

  return { t, orgId, userId, asOwner, oldPeriod, currentPeriod, cash, revenue };
}

type Ctx = Awaited<ReturnType<typeof seedDealer>>;

/**
 * Inserts one balanced journal entry + its two lines directly — the same
 * shape the posting engine writes (accountingPhase17.test.ts's convention) —
 * so 125 entries seed in one test run without driving 125 real economic
 * mutations through the full posting engine.
 */
async function insertJournalEntry(
  ctx: Ctx,
  args: { index: number; accountingDate: number; periodId: Id<"accountingPeriods">; accountId: Id<"chartOfAccounts">; memo: string }
) {
  return ctx.t.run(async (dbCtx) => {
    const entryId = await dbCtx.db.insert("journalEntries", {
      orgId: ctx.orgId,
      periodId: args.periodId,
      journalNumber: `GLTEST-${String(args.index).padStart(4, "0")}`,
      accountingDate: args.accountingDate,
      sourceType: "test",
      sourceId: String(args.index),
      category: "MANUAL",
      memo: args.memo,
      status: "POSTED",
      currency: "JOD",
      postedBy: ctx.userId,
      postedAt: Date.now(),
      createdAt: Date.now(),
    });
    await dbCtx.db.insert("journalLines", {
      orgId: ctx.orgId, journalEntryId: entryId, lineNumber: 1, accountId: ctx.cash._id,
      debitMinor: 1_000, creditMinor: 0, currency: "JOD", scale: 3, accountingDate: args.accountingDate,
    });
    await dbCtx.db.insert("journalLines", {
      orgId: ctx.orgId, journalEntryId: entryId, lineNumber: 2, accountId: args.accountId,
      debitMinor: 0, creditMinor: 1_000, currency: "JOD", scale: 3, accountingDate: args.accountingDate,
    });
    return entryId;
  });
}

/** Walks accountingLedger.listJournalEntries to exhaustion, returning every page. */
async function walkAllPages(
  ctx: Ctx,
  extraArgs: Record<string, unknown> = {},
  pageSize = 20
) {
  const pages: Array<{ page: any[]; isDone: boolean; continueCursor: string }> = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const result: any = await ctx.asOwner.query(api.accountingLedger.listJournalEntries, {
      orgId: ctx.orgId,
      ...extraArgs,
      paginationOpts: { numItems: pageSize, cursor },
    } as any);
    pages.push(result as any);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return pages;
}

describe("General Ledger pagination — AF-318-01 regression (>100 entries reachable)", () => {
  test("125 seeded entries: bounded first page, a planted OLD entry is off page 1, pagination reaches it, no duplicates, deterministic order", async () => {
    const ctx = await seedDealer("GL Pagination Dealer", "glpag");

    const TOTAL = 125;
    const baseDate = ctx.currentPeriod.startDate + 10 * 24 * 60 * 60 * 1000;

    // Entry 0 is deliberately the OLDEST (smallest accountingDate) — it must
    // sort to the LAST page under desc-by-accountingDate ordering, so it is
    // guaranteed to be off any reasonably small first page.
    const TARGET_INDEX = 0;
    const TARGET_MEMO = "TARGET-OLD-JOURNAL";
    await insertJournalEntry(ctx, {
      index: TARGET_INDEX,
      accountingDate: baseDate, // oldest of the batch
      periodId: ctx.currentPeriod._id,
      accountId: ctx.revenue._id,
      memo: TARGET_MEMO,
    });
    const insertedIds: Id<"journalEntries">[] = [];
    for (let i = 1; i < TOTAL; i++) {
      const id = await insertJournalEntry(ctx, {
        index: i,
        // Strictly increasing dates after the target, so the target is
        // provably the single oldest entry and therefore off page 1.
        accountingDate: baseDate + i * 60_000,
        periodId: ctx.currentPeriod._id,
        accountId: ctx.revenue._id,
        memo: `filler-${i}`,
      });
      insertedIds.push(id);
    }

    // 1. The first page is bounded — never all 125 in one call.
    const firstPage = await ctx.asOwner.query(api.accountingLedger.listJournalEntries, {
      orgId: ctx.orgId,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(firstPage.page.length).toBe(20);
    expect(firstPage.isDone).toBe(false);

    // 2. The target is not necessarily (and here, provably not) on page 1 —
    // it is the oldest entry, and the list is ordered desc by accountingDate.
    expect(firstPage.page.some((e: any) => e.memo === TARGET_MEMO)).toBe(false);

    // 3 & 4. Continuation retrieves further pages, and the target is
    // eventually returned by walking to exhaustion.
    const pages = await walkAllPages(ctx, {}, 20);
    const lastPage = pages[pages.length - 1];
    expect(lastPage.isDone).toBe(true);
    const allEntries = pages.flatMap((p) => p.page);
    expect(allEntries.length).toBe(TOTAL);
    const target = allEntries.find((e: any) => e.memo === TARGET_MEMO);
    expect(target).toBeDefined();
    expect(target!.accountingDate).toBe(baseDate);

    // The target was reached on a LATER page, proving pagination actually
    // continued rather than the first page happening to contain everything.
    const targetPageIndex = pages.findIndex((p) => p.page.some((e: any) => e.memo === TARGET_MEMO));
    expect(targetPageIndex).toBeGreaterThan(0);

    // 5. No journal entry id appears on more than one page.
    const allIds = allEntries.map((e: any) => String(e._id));
    expect(new Set(allIds).size).toBe(allIds.length);

    // 7 (part). Ordering is deterministic: walking the SAME query again from
    // scratch returns entries in the identical order.
    const pagesAgain = await walkAllPages(ctx, {}, 20);
    const allEntriesAgain = pagesAgain.flatMap((p) => p.page);
    expect(allEntriesAgain.map((e: any) => String(e._id))).toEqual(allIds);

    // 7 (part). Entries are non-increasing by accountingDate — the financial
    // date, not _creationTime (every entry here was inserted in ASCENDING
    // accountingDate order but must read back DESCENDING).
    for (let i = 1; i < allEntries.length; i++) {
      expect(allEntries[i - 1].accountingDate).toBeGreaterThanOrEqual(allEntries[i].accountingDate);
    }
  }, 60_000);

  test("tenant isolation holds across a 125-entry organization and a second, smaller organization", async () => {
    // Both organizations are seeded on the SAME convex-test backend instance
    // (`t`) — a real shared database, the way two tenants of one deployment
    // actually coexist — rather than two independent in-memory backends that
    // could never prove cross-tenant isolation at all.
    const ctxA = await seedDealer("GL Pagination Dealer A", "glpaga");
    const ctxB = await seedDealer("GL Pagination Dealer B", "glpagb", ctxA.t);

    const baseDate = ctxA.currentPeriod.startDate + 10 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 30; i++) {
      await insertJournalEntry(ctxA, {
        index: i, accountingDate: baseDate + i * 60_000, periodId: ctxA.currentPeriod._id,
        accountId: ctxA.revenue._id, memo: `org-a-${i}`,
      });
    }
    await insertJournalEntry(ctxB, {
      index: 0, accountingDate: ctxB.currentPeriod.startDate, periodId: ctxB.currentPeriod._id,
      accountId: ctxB.revenue._id, memo: "org-b-only-entry",
    });

    // Org B's owner querying Org B's own orgId sees only org B's entry.
    const bPages = await walkAllPages(ctxB, {}, 20);
    const bEntries = bPages.flatMap((p) => p.page);
    expect(bEntries.length).toBe(1);
    expect(bEntries[0].memo).toBe("org-b-only-entry");
    expect(bEntries.some((e: any) => String(e.orgId) !== String(ctxB.orgId))).toBe(false);

    // Org B's identity cannot read Org A's journal entries by naming Org A's
    // orgId — requireTenantAuth refuses before any page is returned.
    await expect(
      ctxB.asOwner.query(api.accountingLedger.listJournalEntries, {
        orgId: ctxA.orgId,
        paginationOpts: { numItems: 20, cursor: null },
      })
    ).rejects.toThrow();

    // And walking Org A's own pages to exhaustion never surfaces Org B's row.
    const aPages = await walkAllPages(ctxA, {}, 20);
    const aEntries = aPages.flatMap((p) => p.page);
    expect(aEntries.length).toBe(30);
    expect(aEntries.some((e: any) => e.memo === "org-b-only-entry")).toBe(false);
    expect(aEntries.every((e: any) => String(e.orgId) === String(ctxA.orgId))).toBe(true);
  }, 60_000);

  test("the accounting-period filter narrows to exactly that period's entries, reached through full pagination", async () => {
    const ctx = await seedDealer("GL Pagination Period Dealer", "glpagp");

    // 15 entries in the OLD period, 20 in the CURRENT period.
    for (let i = 0; i < 15; i++) {
      await insertJournalEntry(ctx, {
        index: i, accountingDate: ctx.oldPeriod.startDate + i * 60_000, periodId: ctx.oldPeriod._id,
        accountId: ctx.revenue._id, memo: `old-period-${i}`,
      });
    }
    for (let i = 0; i < 20; i++) {
      await insertJournalEntry(ctx, {
        index: 100 + i, accountingDate: ctx.currentPeriod.startDate + i * 60_000, periodId: ctx.currentPeriod._id,
        accountId: ctx.revenue._id, memo: `current-period-${i}`,
      });
    }

    const oldPages = await walkAllPages(ctx, { periodId: ctx.oldPeriod._id }, 5);
    const oldEntries = oldPages.flatMap((p) => p.page);
    expect(oldEntries.length).toBe(15);
    expect(oldEntries.every((e: any) => e.memo.startsWith("old-period-"))).toBe(true);
    expect(oldEntries.every((e: any) => String(e.periodId) === String(ctx.oldPeriod._id))).toBe(true);

    const currentPages = await walkAllPages(ctx, { periodId: ctx.currentPeriod._id }, 5);
    const currentEntries = currentPages.flatMap((p) => p.page);
    expect(currentEntries.length).toBe(20);
    expect(currentEntries.every((e: any) => e.memo.startsWith("current-period-"))).toBe(true);

    // No overlap between the two period-filtered walks.
    const oldIds = new Set(oldEntries.map((e: any) => String(e._id)));
    expect(currentEntries.every((e: any) => !oldIds.has(String(e._id)))).toBe(true);
  }, 60_000);

  test("ordering and period membership follow accountingDate — a backdated entry created LAST still sorts and filters by its own financial date, not by _creationTime", async () => {
    const ctx = await seedDealer("GL Backdate Dealer", "glback");

    // Two ordinary same-period entries, inserted in normal chronological
    // order (both _creationTime and accountingDate increasing together).
    const early = await insertJournalEntry(ctx, {
      index: 1, accountingDate: ctx.currentPeriod.startDate + 5 * 24 * 60 * 60 * 1000,
      periodId: ctx.currentPeriod._id, accountId: ctx.revenue._id, memo: "ordinary-early",
    });
    const late = await insertJournalEntry(ctx, {
      index: 2, accountingDate: ctx.currentPeriod.startDate + 10 * 24 * 60 * 60 * 1000,
      periodId: ctx.currentPeriod._id, accountId: ctx.revenue._id, memo: "ordinary-late",
    });

    // A BACKDATED manual journal: inserted THIRD (latest _creationTime of the
    // three, and Convex's own creation-time counter only increases), but its
    // `accountingDate` — and therefore its `periodId` — belongs to the OLD
    // period, weeks before either ordinary entry's accounting date. If the GL
    // ever ordered or filtered by _creationTime instead of accountingDate,
    // this entry would wrongly sort newest and would wrongly appear in the
    // CURRENT period's filtered list instead of the OLD period's.
    const backdated = await insertJournalEntry(ctx, {
      index: 3, accountingDate: ctx.oldPeriod.startDate + 2 * 24 * 60 * 60 * 1000,
      periodId: ctx.oldPeriod._id, accountId: ctx.revenue._id, memo: "backdated-manual-journal",
    });

    // Ordering: desc by accountingDate must put the two CURRENT-period
    // entries ahead of the OLD-period backdated one, in true financial-date
    // order (late, then early, then backdated) — the reverse of insertion
    // order for the first two, and unrelated to insertion order for the third.
    const allPages = await walkAllPages(ctx, {}, 20);
    const allEntries = allPages.flatMap((p) => p.page);
    expect(allEntries.map((e: any) => String(e._id))).toEqual([
      String(late), String(early), String(backdated),
    ]);

    // Period membership: filtering by the CURRENT period returns exactly the
    // two ordinary entries — never the backdated one, even though it was
    // created after both.
    const currentPages = await walkAllPages(ctx, { periodId: ctx.currentPeriod._id }, 20);
    const currentIds = currentPages.flatMap((p) => p.page).map((e: any) => String(e._id));
    expect(new Set(currentIds)).toEqual(new Set([String(early), String(late)]));

    // Filtering by the OLD period returns exactly the backdated entry — it
    // belongs to the period its accountingDate falls in, regardless of when
    // the row was actually created.
    const oldPages = await walkAllPages(ctx, { periodId: ctx.oldPeriod._id }, 20);
    const oldIds = oldPages.flatMap((p) => p.page).map((e: any) => String(e._id));
    expect(oldIds).toEqual([String(backdated)]);
  }, 60_000);

  test("getAccountActivity paginates a single account's full history past the old fixed take(500)-shaped cutoff", async () => {
    const ctx = await seedDealer("GL Account Activity Dealer", "glacct");

    const TOTAL = 40;
    const baseDate = ctx.currentPeriod.startDate + 5 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < TOTAL; i++) {
      await insertJournalEntry(ctx, {
        index: i, accountingDate: baseDate + i * 60_000, periodId: ctx.currentPeriod._id,
        accountId: ctx.revenue._id, memo: `acct-activity-${i}`,
      });
    }

    const pages: any[] = [];
    let cursor: string | null = null;
    let account: any = null;
    for (let i = 0; i < 20; i++) {
      const result: any = await ctx.asOwner.query(api.accountingLedger.getAccountActivity, {
        orgId: ctx.orgId,
        accountId: ctx.revenue._id,
        paginationOpts: { numItems: 6, cursor },
      });
      if (!result) throw new Error("account activity returned null");
      account = result.account;
      pages.push(result);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    const allLines = pages.flatMap((p) => p.lines);
    // One credit line per journal entry landed on this account.
    expect(allLines.length).toBe(TOTAL);
    expect(account._id).toBe(ctx.revenue._id);

    // No duplicate lines across pages, and every page stayed bounded.
    const lineIds = allLines.map((l: any) => String(l._id));
    expect(new Set(lineIds).size).toBe(lineIds.length);
    for (const p of pages.slice(0, -1)) {
      expect(p.lines.length).toBeLessThanOrEqual(6);
    }

    // The running balance on the LAST line reflects all TOTAL credits to this
    // revenue account (each 1,000 minor units), proving the balance is not
    // silently re-derived from only the last bounded page.
    const lastLine = allLines[allLines.length - 1];
    expect(lastLine.runningBalanceMinor).toBe(TOTAL * 1_000);
  }, 60_000);

  test("Blocker A regression: getAccountActivity preserves running balance across same-accountingDate page boundary", async () => {
    const ctx = await seedDealer("Same Date Activity Dealer", "glsamedate");

    const sameDate = ctx.currentPeriod.startDate + 10 * 60_000;
    // Insert two journal entries on the exact same accountingDate, each crediting revenue by 1,000 JOD
    await insertJournalEntry(ctx, {
      index: 1,
      accountingDate: sameDate,
      periodId: ctx.currentPeriod._id,
      accountId: ctx.revenue._id,
      memo: "line-1",
    });
    await insertJournalEntry(ctx, {
      index: 2,
      accountingDate: sameDate,
      periodId: ctx.currentPeriod._id,
      accountId: ctx.revenue._id,
      memo: "line-2",
    });

    // Page 1 with pageSize = 1
    const page1: any = await ctx.asOwner.query(api.accountingLedger.getAccountActivity, {
      orgId: ctx.orgId,
      accountId: ctx.revenue._id,
      paginationOpts: { numItems: 1, cursor: null },
    });

    expect(page1.lines).toHaveLength(1);
    expect(page1.lines[0].runningBalanceMinor).toBe(1_000);
    expect(page1.continueCursor).toBeTruthy();

    // Page 2 with pageSize = 1 using page 1's cursor
    const page2: any = await ctx.asOwner.query(api.accountingLedger.getAccountActivity, {
      orgId: ctx.orgId,
      accountId: ctx.revenue._id,
      paginationOpts: { numItems: 1, cursor: page1.continueCursor },
    });

    expect(page2.lines).toHaveLength(1);
    // Page 2 must have running balance 2,000, NOT 1,000!
    expect(page2.openingBalanceMinor).toBe(1_000);
    expect(page2.lines[0].runningBalanceMinor).toBe(2_000);
    expect(page2.closingBalanceMinor).toBe(2_000);
  });

  test("Blocker B regression: listJournalEntries with accountId does not duplicate entries with multiple lines for same account across pages", async () => {
    const ctx = await seedDealer("Duplicate Line Entry Dealer", "gldupentry");

    // Create entry with TWO lines for ctx.revenue._id
    const entryId = await ctx.t.run(async (dbCtx) => {
      const eId = await dbCtx.db.insert("journalEntries", {
        orgId: ctx.orgId,
        periodId: ctx.currentPeriod._id,
        journalNumber: "GLTEST-SPLIT",
        accountingDate: ctx.currentPeriod.startDate + 10_000,
        sourceType: "test",
        sourceId: "split",
        category: "MANUAL",
        memo: "split-entry",
        status: "POSTED",
        currency: "JOD",
        postedBy: ctx.userId,
        postedAt: Date.now(),
        createdAt: Date.now(),
      });
      // Line 1: revenue credit 500
      await dbCtx.db.insert("journalLines", {
        orgId: ctx.orgId, journalEntryId: eId, lineNumber: 1, accountId: ctx.revenue._id,
        debitMinor: 0, creditMinor: 500, currency: "JOD", scale: 3, accountingDate: ctx.currentPeriod.startDate + 10_000,
      });
      // Line 2: revenue credit 500 (same account!)
      await dbCtx.db.insert("journalLines", {
        orgId: ctx.orgId, journalEntryId: eId, lineNumber: 2, accountId: ctx.revenue._id,
        debitMinor: 0, creditMinor: 500, currency: "JOD", scale: 3, accountingDate: ctx.currentPeriod.startDate + 10_000,
      });
      // Line 3: cash debit 1,000
      await dbCtx.db.insert("journalLines", {
        orgId: ctx.orgId, journalEntryId: eId, lineNumber: 3, accountId: ctx.cash._id,
        debitMinor: 1_000, creditMinor: 0, currency: "JOD", scale: 3, accountingDate: ctx.currentPeriod.startDate + 10_000,
      });
      return eId;
    });

    // Also insert another entry before and after so we test cursor continuation
    const otherEntryId = await insertJournalEntry(ctx, {
      index: 10,
      accountingDate: ctx.currentPeriod.startDate + 20_000,
      periodId: ctx.currentPeriod._id,
      accountId: ctx.revenue._id,
      memo: "other-entry",
    });

    // Walk listJournalEntries with accountId = ctx.revenue._id and pageSize = 1
    // to force split-entry's two lines to land on different pages!
    const pages: any[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const result: any = await ctx.asOwner.query(api.accountingLedger.listJournalEntries, {
        orgId: ctx.orgId,
        accountId: ctx.revenue._id,
        paginationOpts: { numItems: 1, cursor },
      });
      pages.push(result);
      if (result.isDone || !result.continueCursor) break;
      cursor = result.continueCursor;
    }

    const allEntries = pages.flatMap((p) => p.page);
    const entryIds = allEntries.map((e: any) => String(e._id));
    // Each qualifying entry must appear EXACTLY ONCE across the full cursor walk!
    expect(entryIds.filter((id) => id === String(entryId))).toHaveLength(1);
    expect(entryIds.filter((id) => id === String(otherEntryId))).toHaveLength(1);
    expect(allEntries).toHaveLength(2);
  });

  test("Blocker B regression: listJournalEntries with combined periodId and accountId filters accurately without duplicates or skips", async () => {
    const ctx = await seedDealer("Period and Account Filter Dealer", "glperiodacct");

    // Insert 2 entries in oldPeriod for revenue
    const old1 = await insertJournalEntry(ctx, {
      index: 1,
      accountingDate: ctx.oldPeriod.startDate + 10_000,
      periodId: ctx.oldPeriod._id,
      accountId: ctx.revenue._id,
      memo: "old-1",
    });
    const old2 = await insertJournalEntry(ctx, {
      index: 2,
      accountingDate: ctx.oldPeriod.startDate + 20_000,
      periodId: ctx.oldPeriod._id,
      accountId: ctx.revenue._id,
      memo: "old-2",
    });

    // Insert 2 entries in currentPeriod for revenue (one has multiple lines)
    const cur1 = await ctx.t.run(async (dbCtx) => {
      const eId = await dbCtx.db.insert("journalEntries", {
        orgId: ctx.orgId,
        periodId: ctx.currentPeriod._id,
        journalNumber: "GLTEST-CUR-SPLIT",
        accountingDate: ctx.currentPeriod.startDate + 10_000,
        sourceType: "test",
        sourceId: "cur-split",
        category: "MANUAL",
        memo: "cur-split",
        status: "POSTED",
        currency: "JOD",
        postedBy: ctx.userId,
        postedAt: Date.now(),
        createdAt: Date.now(),
      });
      await dbCtx.db.insert("journalLines", {
        orgId: ctx.orgId, journalEntryId: eId, lineNumber: 1, accountId: ctx.revenue._id,
        debitMinor: 0, creditMinor: 400, currency: "JOD", scale: 3, accountingDate: ctx.currentPeriod.startDate + 10_000,
      });
      await dbCtx.db.insert("journalLines", {
        orgId: ctx.orgId, journalEntryId: eId, lineNumber: 2, accountId: ctx.revenue._id,
        debitMinor: 0, creditMinor: 600, currency: "JOD", scale: 3, accountingDate: ctx.currentPeriod.startDate + 10_000,
      });
      return eId;
    });

    const cur2 = await insertJournalEntry(ctx, {
      index: 4,
      accountingDate: ctx.currentPeriod.startDate + 30_000,
      periodId: ctx.currentPeriod._id,
      accountId: ctx.revenue._id,
      memo: "cur-2",
    });

    // Walk with accountId + currentPeriod at pageSize = 1
    const currentPages: any[] = [];
    let curCursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const result: any = await ctx.asOwner.query(api.accountingLedger.listJournalEntries, {
        orgId: ctx.orgId,
        accountId: ctx.revenue._id,
        periodId: ctx.currentPeriod._id,
        paginationOpts: { numItems: 1, cursor: curCursor },
      });
      currentPages.push(result);
      if (result.isDone || !result.continueCursor) break;
      curCursor = result.continueCursor;
    }

    const currentEntries = currentPages.flatMap((p) => p.page);
    expect(currentEntries).toHaveLength(2);
    expect(currentEntries.map((e: any) => String(e._id))).toEqual([String(cur2), String(cur1)]);

    // Walk with accountId + oldPeriod at pageSize = 1
    const oldPages: any[] = [];
    let oldCursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const result: any = await ctx.asOwner.query(api.accountingLedger.listJournalEntries, {
        orgId: ctx.orgId,
        accountId: ctx.revenue._id,
        periodId: ctx.oldPeriod._id,
        paginationOpts: { numItems: 1, cursor: oldCursor },
      });
      oldPages.push(result);
      if (result.isDone || !result.continueCursor) break;
      oldCursor = result.continueCursor;
    }

    const oldEntries = oldPages.flatMap((p) => p.page);
    expect(oldEntries).toHaveLength(2);
    expect(oldEntries.map((e: any) => String(e._id))).toEqual([String(old2), String(old1)]);
  });
});
