/**
 * Phase 13 tests — claim receivables and settlement.
 *
 * Acceptance gates: creating a claim opens a receivable; settling it records
 * a payment, allocates it, and posts DR Bank / CR Finance-company AR;
 * rejecting writes it off with a balanced entry; direct status patching is
 * gone; the Phase 6 migration CLAIM_PAYMENT skip gap is closed.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedClaimsDealer() {
  const t = convexTest(schema, MODULE_GLOB);
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

async function createClaim(asOwner: Ctx["asOwner"], orgId: Id<"organizations">, amountMinor = 750_000) {
  return await asOwner.mutation(api.claims.add, {
    orgId,
    claimDate: Date.now(),
    financingEntity: "Jordan Finance Co",
    buyerName: "Buyer X",
    claimAmountMinor: amountMinor,
  });
}

describe("Phase 13 — claim creation", () => {
  test("creating a claim opens an OPEN finance-company receivable for the full amount", async () => {
    const { t, orgId, asOwner } = await seedClaimsDealer();
    const claimId = await createClaim(asOwner, orgId);

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("PENDING");
    expect(claim?.claimAmountMinor).toBe(750_000);
    expect(claim?.receivableDocumentId).toBeTruthy();

    const receivable = await t.run((ctx) => ctx.db.get(claim!.receivableDocumentId!));
    expect(receivable?.status).toBe("OPEN");
    expect(receivable?.payerType).toBe("FINANCE_COMPANY");
    expect(receivable?.originalAmountMinor).toBe(750_000);
    expect(receivable?.sourceType).toBe("claims");
    expect(receivable?.sourceId).toBe(claimId.toString());
  });

  test("rejects a non-positive claim amount", async () => {
    const { orgId, asOwner } = await seedClaimsDealer();
    await expect(
      asOwner.mutation(api.claims.add, {
        orgId, claimDate: Date.now(),
        financingEntity: "FC", buyerName: "B", claimAmountMinor: 0,
      })
    ).rejects.toThrow(/must be a positive/i);
  });
});

describe("Phase 13 — claim settlement", () => {
  test("settling posts DR Bank / CR Finance-company AR, allocates, and marks everything PAID", async () => {
    const { t, orgId, asOwner } = await seedClaimsDealer();
    const claimId = await createClaim(asOwner, orgId);

    await asOwner.mutation(api.claims.settle, { orgId, claimId, paymentMethod: "BANK_TRANSFER" });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("PAID");
    expect(claim?.settledAt).toBeTruthy();

    const receivable = await t.run((ctx) => ctx.db.get(claim!.receivableDocumentId!));
    expect(receivable?.status).toBe("PAID");

    const payments = await t.run((ctx) =>
      ctx.db.query("canonicalPayments").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].payerType).toBe("FINANCE_COMPANY");
    expect(payments[0].amountMinor).toBe(750_000);

    const allocations = await t.run((ctx) =>
      ctx.db.query("paymentAllocations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0].amountMinor).toBe(750_000);

    const events = await eventsOfType(t, orgId, "CLAIM_SETTLED");
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("POSTED");
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(750_000);
    expect(credit).toBe(750_000);

    const bank = await accountBySystemKey(t, orgId, "BANK_ACCOUNT");
    const arFc = await accountBySystemKey(t, orgId, "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES");
    expect(lines.find((l) => l.accountId === bank?._id)?.debitMinor).toBe(750_000);
    expect(lines.find((l) => l.accountId === arFc?._id)?.creditMinor).toBe(750_000);
  });

  test("settling in cash debits the cash drawer instead of the bank", async () => {
    const { t, orgId, asOwner } = await seedClaimsDealer();
    const claimId = await createClaim(asOwner, orgId, 100_000);

    await asOwner.mutation(api.claims.settle, { orgId, claimId, paymentMethod: "CASH" });

    const events = await eventsOfType(t, orgId, "CLAIM_SETTLED");
    const lines = await linesForEvent(t, events[0]);
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    expect(lines.find((l) => l.accountId === cash?._id)?.debitMinor).toBe(100_000);
  });

  test("a settled claim cannot be settled again", async () => {
    const { orgId, asOwner } = await seedClaimsDealer();
    const claimId = await createClaim(asOwner, orgId);
    await asOwner.mutation(api.claims.settle, { orgId, claimId, paymentMethod: "BANK_TRANSFER" });

    await expect(
      asOwner.mutation(api.claims.settle, { orgId, claimId, paymentMethod: "CASH" })
    ).rejects.toThrow(/only a pending claim/i);
  });
});

describe("Phase 13 — claim rejection", () => {
  test("rejecting posts a balanced write-off and marks the receivable WRITTEN_OFF", async () => {
    const { t, orgId, asOwner } = await seedClaimsDealer();
    const claimId = await createClaim(asOwner, orgId, 300_000);

    await asOwner.mutation(api.claims.reject, { orgId, claimId });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("REJECTED");
    expect(claim?.rejectedAt).toBeTruthy();

    const receivable = await t.run((ctx) => ctx.db.get(claim!.receivableDocumentId!));
    expect(receivable?.status).toBe("WRITTEN_OFF");

    const events = await eventsOfType(t, orgId, "CLAIM_WRITTEN_OFF");
    expect(events).toHaveLength(1);
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(300_000);
    expect(credit).toBe(300_000);

    const writeOff = await accountBySystemKey(t, orgId, "CLAIM_WRITE_OFF_EXPENSE");
    const arFc = await accountBySystemKey(t, orgId, "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES");
    expect(lines.find((l) => l.accountId === writeOff?._id)?.debitMinor).toBe(300_000);
    expect(lines.find((l) => l.accountId === arFc?._id)?.creditMinor).toBe(300_000);
  });

  test("a rejected claim cannot be settled afterwards", async () => {
    const { orgId, asOwner } = await seedClaimsDealer();
    const claimId = await createClaim(asOwner, orgId);
    await asOwner.mutation(api.claims.reject, { orgId, claimId });

    await expect(
      asOwner.mutation(api.claims.settle, { orgId, claimId, paymentMethod: "CASH" })
    ).rejects.toThrow(/only a pending claim/i);
  });
});

describe("Phase 13 — event-driven status only", () => {
  test("update no longer accepts a status argument", async () => {
    const { orgId, asOwner } = await seedClaimsDealer();
    const claimId = await createClaim(asOwner, orgId);

    await expect(
      asOwner.mutation(api.claims.update, { orgId, claimId, status: "PAID" } as never)
    ).rejects.toThrow();

    await asOwner.mutation(api.claims.update, { orgId, claimId, notes: "still fine" });
  });

  test("a pending claim with an open receivable cannot be removed", async () => {
    const { orgId, asOwner } = await seedClaimsDealer();
    const claimId = await createClaim(asOwner, orgId);

    await expect(
      asOwner.mutation(api.claims.remove, { orgId, claimId })
    ).rejects.toThrow(/settle or reject it/i);

    await asOwner.mutation(api.claims.settle, { orgId, claimId, paymentMethod: "BANK_TRANSFER" });
    await asOwner.mutation(api.claims.remove, { orgId, claimId });
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
