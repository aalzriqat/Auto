/**
 * Phase 13 tests — finance-company receivables.
 *
 * The original acceptance gates here covered a claim lifecycle that SCRUM-51
 * retired: `claims.add` opened a canonical FINANCE_COMPANY receivable with no
 * originating GL debit, and `claims.settle`/`claims.reject` then credited
 * AR — Finance Companies. Finance Applications own that receivable, so Claims is
 * now a read-only work queue and those mutations are gone
 * (`claimsReadOnlyGuard.test.ts` keeps them gone).
 *
 * What remains here is what still has producers: the projection the accountant
 * works from, and the Phase 6 migration CLAIM_PAYMENT skip gap.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedClaimsDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase13 Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "p13_owner", email: "p13owner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: "p13_owner", clerkId: "p13_owner" });

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

  return { t, orgId, userId, asOwner };
}

type Ctx = Awaited<ReturnType<typeof seedClaimsDealer>>;

async function eventsOfType(t: Ctx["t"], orgId: Id<"organizations">, eventType: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .filter((q) => q.eq(q.field("eventType"), eventType))
      .collect()
  );
}

async function linesForEvent(t: Ctx["t"], event: { journalEntryId?: Id<"journalEntries"> }) {
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

async function accountBySystemKey(t: Ctx["t"], orgId: Id<"organizations">, systemKey: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
      .unique()
  );
}

/**
 * The shape `applications.ts` creates via `ensureFinanceCompanyReceivable` —
 * seeded directly so this file stays about the projection rather than about
 * the whole finance-application lifecycle (covered in applications tests).
 */
async function seedFinanceCompanyReceivable(
  { t, orgId, userId }: Pick<Ctx, "t" | "orgId" | "userId">,
  opts: {
    amountMinor: number;
    allocatedMinor?: number;
    financierName?: string;
    /** Defaults to a well-formed-but-unresolvable id, as a legacy row would carry. */
    sourceId?: string;
  }
) {
  return await t.run(async (ctx) => {
    const financeCompanyId = opts.financierName
      ? await ctx.db.insert("financeCompanies", {
          orgId, name: opts.financierName, profitRate: 5.5, maxTermMonths: 72,
          gracePeriodMonths: 3, isActive: true,
        })
      : undefined;
    const customerId = await ctx.db.insert("customers", {
      orgId, firstName: "Buyer", lastName: "X",
    });
    const applicationId = opts.sourceId ?? "legacy_application_reference";

    const receivableDocumentId = await ctx.db.insert("receivableDocuments", {
      orgId,
      documentType: "INVOICE" as const,
      documentNumber: "AR-FC-1",
      payerType: "FINANCE_COMPANY" as const,
      customerId,
      financeCompanyId,
      sourceType: "finance_application",
      sourceId: applicationId,
      originalAmountMinor: opts.amountMinor,
      currency: "JOD",
      scale: 3,
      issueDate: Date.now(),
      dueDate: Date.now(),
      status: "OPEN" as const,
      createdAt: Date.now(),
      createdBy: userId,
    });

    if (opts.allocatedMinor) {
      const paymentId = await ctx.db.insert("canonicalPayments", {
        orgId,
        direction: "IN" as const,
        payerType: "FINANCE_COMPANY" as const,
        financeCompanyId,
        method: "BANK_TRANSFER" as const,
        amountMinor: opts.allocatedMinor,
        currency: "JOD",
        scale: 3,
        status: "SETTLED" as const,
        idempotencyKey: `p13_seed_${receivableDocumentId}`,
        receivedAt: Date.now(),
        createdAt: Date.now(),
        createdBy: userId,
      });
      await ctx.db.insert("paymentAllocations", {
        orgId,
        paymentId,
        receivableDocumentId,
        amountMinor: opts.allocatedMinor,
        currency: "JOD",
        scale: 3,
        allocationDate: Date.now(),
        status: "ACTIVE" as const,
        createdAt: Date.now(),
        createdBy: userId,
      });
    }

    return { receivableDocumentId, applicationId, financeCompanyId, customerId };
  });
}

describe("Phase 13 / SCRUM-51 — finance-company receivable work queue", () => {
  test("projects the authoritative receivable with a derived outstanding balance", async () => {
    const ctx = await seedClaimsDealer();
    const { applicationId } = await seedFinanceCompanyReceivable(ctx, {
      amountMinor: 750_000,
      allocatedMinor: 250_000,
      financierName: "Jordan Finance Co",
    });

    const page = await ctx.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: ctx.orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page).toHaveLength(1);
    const row = page.page[0];
    expect(row.financingEntity).toBe("Jordan Finance Co");
    expect(row.buyerName).toBe("Buyer X");
    expect(row.originalAmountMinor).toBe(750_000);
    // Derived from active allocations, never stored — so it cannot drift.
    expect(row.outstandingMinor).toBe(500_000);
    expect(row.applicationId).toBe(applicationId);
    expect(row.currency).toBe("JOD");
    expect(row.scale).toBe(3);
  });

  test("does not leak customer receivables into the finance-company queue", async () => {
    const ctx = await seedClaimsDealer();
    await seedFinanceCompanyReceivable(ctx, { amountMinor: 100_000, financierName: "FC" });
    await ctx.t.run(async (c) => {
      const customerId = await c.db.insert("customers", {
        orgId: ctx.orgId, firstName: "Cash", lastName: "Buyer",
      });
      await c.db.insert("receivableDocuments", {
        orgId: ctx.orgId,
        documentType: "INVOICE" as const,
        documentNumber: "AR-CUST-1",
        payerType: "CUSTOMER" as const,
        customerId,
        sourceType: "sales",
        sourceId: "sale_1",
        originalAmountMinor: 999_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: "OPEN" as const,
        createdAt: Date.now(),
        createdBy: ctx.userId,
      });
    });

    const page = await ctx.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: ctx.orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page).toHaveLength(1);
    expect(page.page[0].originalAmountMinor).toBe(100_000);
  });

  test("a legacy row whose sourceId resolves to no application still lists", async () => {
    const ctx = await seedClaimsDealer();
    // No finance company on the document and a sourceId that is not a valid
    // financeApplications id — the pre-SCRUM-51 "claims" rows look like this.
    await seedFinanceCompanyReceivable(ctx, { amountMinor: 42_000 });

    const page = await ctx.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: ctx.orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page).toHaveLength(1);
    expect(page.page[0].financingEntity).toBeNull();
    expect(page.page[0].outstandingMinor).toBe(42_000);
  });

  test.each(["WRITTEN_OFF", "REVERSED", "CANCELLED"] as const)(
    "a %s receivable is not reported as outstanding",
    async (status) => {
      const ctx = await seedClaimsDealer();
      const { receivableDocumentId } = await seedFinanceCompanyReceivable(ctx, {
        amountMinor: 750_000,
        financierName: "Jordan Finance Co",
      });
      await ctx.t.run((c) => c.db.patch(receivableDocumentId, { status }));

      // getReceivableOutstandingMinor zeroes only CANCELLED, so a written-off
      // or reversed document comes back at its FULL original amount. Reporting
      // that would assert the financier still owes money already given up on.
      const page = await ctx.asOwner.query(api.claims.listFinanceCompanyReceivables, {
        orgId: ctx.orgId,
        paginationOpts: { numItems: 10, cursor: null },
      });
      expect(page.page[0].status).toBe(status);
      expect(page.page[0].outstandingMinor).toBe(0);

      const totals = await ctx.asOwner.query(api.claims.financeCompanyOutstandingTotals, {
        orgId: ctx.orgId,
      });
      expect(totals).toEqual([]);
    }
  );

  test("totals are org-wide and per currency, never one cross-currency sum", async () => {
    const ctx = await seedClaimsDealer();
    await seedFinanceCompanyReceivable(ctx, {
      amountMinor: 750_000,
      allocatedMinor: 250_000,
      financierName: "JOD FC",
    });
    await ctx.t.run(async (c) => {
      const customerId = await c.db.insert("customers", {
        orgId: ctx.orgId, firstName: "USD", lastName: "Buyer",
      });
      await c.db.insert("receivableDocuments", {
        orgId: ctx.orgId,
        documentType: "INVOICE" as const,
        documentNumber: "AR-FC-USD",
        payerType: "FINANCE_COMPANY" as const,
        customerId,
        sourceType: "finance_application",
        sourceId: "another_application",
        originalAmountMinor: 50_000,
        currency: "USD",
        scale: 2,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: "OPEN" as const,
        createdAt: Date.now(),
        createdBy: ctx.userId,
      });
    });

    const totals = await ctx.asOwner.query(api.claims.financeCompanyOutstandingTotals, {
      orgId: ctx.orgId,
    });

    expect(totals).toHaveLength(2);
    expect(totals.find((row) => row.currency === "JOD")).toEqual({
      currency: "JOD", scale: 3, outstandingMinor: 500_000,
    });
    expect(totals.find((row) => row.currency === "USD")).toEqual({
      currency: "USD", scale: 2, outstandingMinor: 50_000,
    });
  });

  test("totals cover receivables beyond the first page of the queue", async () => {
    const ctx = await seedClaimsDealer();
    for (let i = 0; i < 5; i++) {
      await seedFinanceCompanyReceivable(ctx, { amountMinor: 100_000, financierName: `FC ${i}` });
    }

    // One page short of the whole set: the headline must still be the total.
    const page = await ctx.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: ctx.orgId,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(page.page).toHaveLength(2);

    const totals = await ctx.asOwner.query(api.claims.financeCompanyOutstandingTotals, {
      orgId: ctx.orgId,
    });
    expect(totals).toEqual([{ currency: "JOD", scale: 3, outstandingMinor: 500_000 }]);
  });

  test("requires view:finance", async () => {
    const ctx = await seedClaimsDealer();
    await seedFinanceCompanyReceivable(ctx, { amountMinor: 100_000, financierName: "FC" });

    const stranger = ctx.t.withIdentity({ subject: "outsider", clerkId: "outsider" });
    await expect(
      stranger.query(api.claims.listFinanceCompanyReceivables, {
        orgId: ctx.orgId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow();
  });
});

describe("Phase 13 — legacy migration gap", () => {
  test("CLAIM_PAYMENT legacy transactions now migrate with a balanced entry", async () => {
    const { t, orgId, asOwner } = await seedClaimsDealer();

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "IN", amount: 400, date: Date.now(),
        category: "CLAIM_PAYMENT", description: "Legacy claim payment",
      })
    );

    const result = await asOwner.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false,
    });
    expect(result.posted).toBe(1);
    expect(result.skipped).toBe(0);

    const events = await eventsOfType(t, orgId, "CLAIM_SETTLED");
    expect(events).toHaveLength(1);

    // 400 JOD → 400_000 minor at scale 3; legacy migration settles as CASH.
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(400_000);
    expect(debit).toBe(credit);
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    expect(lines.find((l) => l.accountId === cash?._id)?.debitMinor).toBe(400_000);
  });
});
