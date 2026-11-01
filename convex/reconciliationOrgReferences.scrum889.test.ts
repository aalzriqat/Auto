/**
 * SCRUM-889 - the A/R and A/P reconciliation readers follow two stored references: a journal line's
 * `journalEntryId` (bounded GL read in accounting/accountSnapshots.ts, A/R reader) and a queued
 * reversal's `originalEventId` (hasPendingAffectingPosting, A/R and A/P readers).
 *
 * `ctx.db.get(id)` returns a document whatever organization owns it, so the organization is checked
 * explicitly (Convex docs: authorization is the function's job, db.get does not scope by tenant;
 * OWASP API1:2023 Broken Object Level Authorization). A reference that points into another
 * organization is an inconsistency, and an inconsistency makes the answer UNAVAILABLE: skipping the
 * line, or letting a foreign event decide, could report an unreconciled ledger as reconciled.
 *
 * Rows are seeded directly because no public writer creates a cross-organization link; the readers
 * are called through the real public queries.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex runtime and not
 * production data.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getControlAccountBalancesAsOf } from "./accounting/accountSnapshots";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const PERMS = ["manage:finance", "view:finance"];
const AMOUNT_MINOR = 123_400;

// chartOfAccounts.initialize and accountingPeriods.create queue scheduler work; fake timers are installed
// before them and the scheduler is drained afterwards (https://docs.convex.dev/testing/convex-test).
const seededConvexes: Array<ReturnType<typeof convexTestWithComponents>> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(async () => {
  try {
    for (const t of seededConvexes.splice(0)) {
      for (let pass = 0; pass < 10; pass += 1) {
        await t.finishAllScheduledFunctions(vi.runAllTimers);
        const queued = (await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
          (f) => f.state.kind === "pending" || f.state.kind === "inProgress"
        ).length;
        if (queued === 0) break;
      }
    }
  } finally {
    vi.useRealTimers();
  }
});

/** Org A (the caller, with a chart and an open period) and org B (a second tenant). */
async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  seededConvexes.push(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S889 A ${tag}`, createdAt: Date.now() }));
  const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S889 B ${tag}`, createdAt: Date.now() }));
  for (const id of [orgId, otherOrgId]) {
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId: id, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
  }
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "S889 User" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  // Force the journal-line path of the bounded GL read (the snapshot path reads no entries).
  await t.run((ctx) => ctx.db.patch(period._id, { snapshotFastPathEligible: false }));
  const receivableAccount = (await t.run((ctx) =>
    ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "RECEIVABLE_FROM_SUPPLIERS")).unique()
  ))!;
  return { t, orgId, otherOrgId, userId, asUser, periodId: period._id, receivableAccountId: receivableAccount._id };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const arRecon = (s: Seed) => s.asUser.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId });
const apRecon = (s: Seed) => s.asUser.query(api.accountingReports.supplierPayablesReconciliation, { orgId: s.orgId });

/** A journal entry owned by `owner`, dated in org A's open period (the period id is what makes a foreign parent look valid). */
const insertEntry = (s: Seed, owner: Id<"organizations">, status: "POSTED" | "DRAFT" = "POSTED") =>
  s.t.run((ctx) =>
    ctx.db.insert("journalEntries", {
      orgId: owner, journalNumber: "RAW", accountingDate: Date.now() - 1000, periodId: s.periodId, sourceType: "raw",
      sourceId: "raw", category: "SYSTEM", memo: "raw", status, postedBy: s.userId, postedAt: Date.now(), createdAt: Date.now(),
    })
  );

/** An org-A line on the 1240 account that points at `entryId`, whoever owns that entry. */
const insertLine = (s: Seed, entryId: Id<"journalEntries">) =>
  s.t.run((ctx) =>
    ctx.db.insert("journalLines", {
      orgId: s.orgId, journalEntryId: entryId, lineNumber: 1, accountId: s.receivableAccountId, debitMinor: AMOUNT_MINOR, creditMinor: 0,
      currency: "JOD", scale: 3, accountingDate: Date.now() - 1000,
    })
  );

describe("SCRUM-889 - a journal line's parent entry must belong to the same organization (A/R reader)", () => {
  test("CONTROL: a same-org POSTED parent counts toward the GL balance", async () => {
    const s = await seed("jctl");
    await insertLine(s, await insertEntry(s, s.orgId));
    const r = await arRecon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.byCurrency.JOD.glBalanceMinor).toBe(AMOUNT_MINOR);
  });

  test("a line whose parent entry belongs to another organization makes the result UNAVAILABLE, not a balance", async () => {
    const s = await seed("jforeign");
    await insertLine(s, await insertEntry(s, s.otherOrgId));
    const r = await arRecon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("INCONSISTENT_REFERENCE");
    expect(r.isReconciled).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.currencies).toEqual([]);
  });

  test("a foreign parent in DRAFT is UNAVAILABLE too: its status cannot decide whether the line is skipped", async () => {
    const s = await seed("jforeigndraft");
    await insertLine(s, await insertEntry(s, s.otherOrgId, "DRAFT"));
    const r = await arRecon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("INCONSISTENT_REFERENCE");
    expect(r.isReconciled).toBe(false);
  });

  test("a line whose parent entry no longer exists is UNAVAILABLE, never silently skipped", async () => {
    const s = await seed("jmissing");
    const entryId = await insertEntry(s, s.orgId);
    await insertLine(s, entryId);
    await s.t.run((ctx) => ctx.db.delete(entryId));
    const r = await arRecon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("INCONSISTENT_REFERENCE");
    expect(r.isReconciled).toBe(false);
  });

  test("the bounded GL read reports the inconsistency itself and returns no balances", async () => {
    const s = await seed("jhelper");
    await insertLine(s, await insertEntry(s, s.otherOrgId));
    const read = await s.t.run((ctx) =>
      getControlAccountBalancesAsOf(ctx, s.orgId, [s.receivableAccountId], Date.now() + 86_400_000, 100)
    );
    expect(read).toEqual({ status: "INCONSISTENT_REFERENCE" });
  });
});

/**
 * The A/P reader's GL side (getCumulativeBalancesAsOf) walks the organization's own entries and sums
 * every child line without looking at the line's own organization, and it never visits an
 * organization-A line whose parent is missing or owned by another organization. Each of those states
 * used to read as AVAILABLE, and with an offsetting line as reconciled. They now refuse.
 */
describe("SCRUM-889 - the A/P GL read refuses an inconsistent journal link (public supplierPayablesReconciliation)", () => {
  const apAccountId = async (s: Seed) =>
    (await s.t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", "ACCOUNTS_PAYABLE_SUPPLIERS")).unique()
    ))!._id;
  /** A line on the A/P account owned by `lineOrg`, pointing at `entryId` (A/P is a liability: a credit raises the GL balance). */
  const insertApLine = async (s: Seed, entryId: Id<"journalEntries">, lineOrg: Id<"organizations">, side: "credit" | "debit" = "credit") => {
    const accountId = await apAccountId(s);
    return s.t.run((ctx) =>
      ctx.db.insert("journalLines", {
        orgId: lineOrg, journalEntryId: entryId, lineNumber: 1, accountId, debitMinor: side === "debit" ? AMOUNT_MINOR : 0,
        creditMinor: side === "credit" ? AMOUNT_MINOR : 0, currency: "JOD", scale: 3, accountingDate: Date.now() - 1000,
      })
    );
  };
  const expectRefused = (r: Awaited<ReturnType<typeof apRecon>>) => {
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("INCONSISTENT_REFERENCE");
    expect(r.isReconciled).toBe(false);
    expect(r.currencies).toEqual([]);
    expect(r.byCurrency).toEqual({});
  };

  test("CONTROL: a same-org POSTED parent with an org-A line counts toward the A/P GL balance", async () => {
    const s = await seed("apctl");
    await insertApLine(s, await insertEntry(s, s.orgId), s.orgId);
    const r = await apRecon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.byCurrency.JOD.glBalanceMinor).toBe(AMOUNT_MINOR);
  });

  test.each(["DRAFT", "VALIDATED", "REVERSED"] as const)(
    "CONTROL: a same-org %s parent is skipped or counted by status, never refused",
    async (status) => {
      const s = await seed(`apstatus${status}`);
      const entryId = await s.t.run((ctx) =>
        ctx.db.insert("journalEntries", {
          orgId: s.orgId, journalNumber: "RAW", accountingDate: Date.now() - 1000, periodId: s.periodId, sourceType: "raw",
          sourceId: "raw", category: "SYSTEM", memo: "raw", status, postedBy: s.userId, postedAt: Date.now(), createdAt: Date.now(),
        })
      );
      await insertApLine(s, entryId, s.orgId);
      const r = await apRecon(s);
      expect(r.status).toBe("AVAILABLE");
      if (status === "REVERSED") {
        // A REVERSED entry's original lines remain postings (offset by a separate reversal).
        expect(r.byCurrency.JOD.glBalanceMinor).toBe(AMOUNT_MINOR);
      } else {
        // DRAFT / VALIDATED parents are not on the books: the line is skipped and the ledger is empty.
        expect(r.isReconciled).toBe(true);
        expect(r.currencies).toEqual([]);
      }
    }
  );

  test("B1: an org-B line under an org-A POSTED entry on the A/P account is UNAVAILABLE, not org A's GL balance", async () => {
    const s = await seed("apb1");
    await insertApLine(s, await insertEntry(s, s.orgId), s.otherOrgId);
    expectRefused(await apRecon(s));
  });

  test("B1 offset: a foreign line plus an offsetting org-A line must not read as reconciled", async () => {
    const s = await seed("apb1offset");
    const entryId = await insertEntry(s, s.orgId);
    await insertApLine(s, entryId, s.otherOrgId, "credit");
    await insertApLine(s, entryId, s.orgId, "debit");
    expectRefused(await apRecon(s));
  });

  test("B1-reverse: an org-A A/P line whose parent entry belongs to org B is UNAVAILABLE, not silently omitted", async () => {
    const s = await seed("apb1rev");
    await insertApLine(s, await insertEntry(s, s.otherOrgId), s.orgId);
    expectRefused(await apRecon(s));
  });

  test("B1-reverse: a foreign parent in DRAFT is UNAVAILABLE too, its status cannot decide whether the line is skipped", async () => {
    const s = await seed("apb1revdraft");
    await insertApLine(s, await insertEntry(s, s.otherOrgId, "DRAFT"), s.orgId);
    expectRefused(await apRecon(s));
  });

  test("B2: an org-A A/P line whose parent entry no longer exists is UNAVAILABLE, never silently dropped", async () => {
    const s = await seed("apb2");
    const entryId = await insertEntry(s, s.orgId);
    await insertApLine(s, entryId, s.orgId);
    await s.t.run((ctx) => ctx.db.delete(entryId));
    expectRefused(await apRecon(s));
  });
});

describe("SCRUM-889 - a queued reversal's original event must belong to the same organization", () => {
  const insertOriginal = (s: Seed, owner: Id<"organizations">, eventType: string) =>
    s.t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId: owner, eventType, sourceType: "x", sourceId: "x889", eventVersion: 1, idempotencyKey: `k889_${Math.random()}`,
        occurredAt: Date.now(), accountingDate: Date.now(), currency: "JOD", payload: {}, status: "POSTED", createdBy: s.userId,
        createdAt: Date.now(),
      })
    );
  const queueReverse = (s: Seed, originalEventId: Id<"accountingEvents">) =>
    s.t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId: s.orgId, kind: "REVERSE", status: "PENDING", idempotencyKey: `k889rev_${Math.random()}`, accountingDate: Date.now(),
        actorId: s.userId, attempts: 0, createdAt: Date.now(), sourceType: "x", sourceId: "x", originalEventId,
      })
    );
  // COMMISSION_PAID touches neither 1240 nor the A/P control account, so a same-org original of this type
  // lets both readers stay AVAILABLE. A foreign one must not.
  const NON_AFFECTING = "COMMISSION_PAID";
  type Reader = typeof arRecon | typeof apRecon;
  async function sameOrgControl(tag: string, reader: (s: Seed) => ReturnType<Reader>) {
    const s = await seed(tag);
    await queueReverse(s, await insertOriginal(s, s.orgId, NON_AFFECTING));
    const r = await reader(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.isReconciled).toBe(true);
  }
  async function foreignOriginal(tag: string, reader: (s: Seed) => ReturnType<Reader>) {
    const s = await seed(tag);
    await queueReverse(s, await insertOriginal(s, s.otherOrgId, NON_AFFECTING));
    const r = await reader(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("PENDING_POSTINGS");
    expect(r.isReconciled).toBe(false);
  }
  async function missingOriginal(tag: string, reader: (s: Seed) => ReturnType<Reader>) {
    const s = await seed(tag);
    const originalId = await insertOriginal(s, s.orgId, NON_AFFECTING);
    await queueReverse(s, originalId);
    await s.t.run((ctx) => ctx.db.delete(originalId));
    const r = await reader(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("PENDING_POSTINGS");
  }

  test("A/R CONTROL: a same-org original that cannot touch 1240 leaves the result AVAILABLE", () => sameOrgControl("rctlar", arRecon));
  test("A/R: a queued reversal whose original belongs to another organization is unresolved, PENDING_POSTINGS", () =>
    foreignOriginal("rforeignar", arRecon));
  test("A/R: a queued reversal whose original no longer exists is unresolved, PENDING_POSTINGS", () => missingOriginal("rmissingar", arRecon));
  test("A/P CONTROL: a same-org original that cannot touch the AP account leaves the result AVAILABLE", () => sameOrgControl("rctlap", apRecon));
  test("A/P: a queued reversal whose original belongs to another organization is unresolved, PENDING_POSTINGS", () =>
    foreignOriginal("rforeignap", apRecon));
  test("A/P: a queued reversal whose original no longer exists is unresolved, PENDING_POSTINGS", () => missingOriginal("rmissingap", apRecon));
});