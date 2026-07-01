import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { validateBalance, simplePayloadHash } from "./accounting/postingRules";

async function seedPhase2Dealer() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase 2 Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "p2_user", email: "p2@example.com", name: "P2 User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance",
      permissions: ["view:sales", "manage:finance", "view:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  const asUser = t.withIdentity({ subject: "p2_user", clerkId: "p2_user" });

  // Initialize chart of accounts
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  // Create and open an accounting period covering today
  const now = Date.now();
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  const monthEnd = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 0, 23, 59, 59, 999).getTime();
  const periodId = await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    fiscalYear: new Date(now).getFullYear(),
    periodNumber: new Date(now).getMonth() + 1,
    startDate: monthStart,
    endDate: monthEnd,
    openImmediately: true,
  });

  // Seed a customer
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Posting", lastName: "Customer" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "P2VIN001", make: "BMW", model: "X5", year: 2025,
      mileage: 0, color: "Black", fuelType: "Gasoline", transmission: "Automatic",
      purchasePrice: 50000, sellingPrice: 65000, status: "AVAILABLE",
    })
  );

  return { t, orgId, userId, periodId, customerId, vehicleId, asUser, now, monthStart, monthEnd };
}

// ─── Posting rule unit tests ──────────────────────────────────────────────────

describe("Phase 2 — posting rule validation", () => {
  test("validateBalance accepts balanced lines", () => {
    expect(() =>
      validateBalance([
        { accountSystemKey: "CASH_ON_HAND" as never, debitMinor: 1000, creditMinor: 0 },
        { accountSystemKey: "SALES_REVENUE" as never, debitMinor: 0, creditMinor: 1000 },
      ])
    ).not.toThrow();
  });

  test("validateBalance rejects unbalanced lines", () => {
    expect(() =>
      validateBalance([
        { accountSystemKey: "CASH_ON_HAND" as never, debitMinor: 1000, creditMinor: 0 },
        { accountSystemKey: "SALES_REVENUE" as never, debitMinor: 0, creditMinor: 900 },
      ])
    ).toThrow(/not balanced/i);
  });

  test("validateBalance rejects line with both debit and credit", () => {
    expect(() =>
      validateBalance([
        { accountSystemKey: "CASH_ON_HAND" as never, debitMinor: 500, creditMinor: 500 },
      ])
    ).toThrow(/both a debit and credit/i);
  });

  test("validateBalance rejects line with neither debit nor credit", () => {
    expect(() =>
      validateBalance([
        { accountSystemKey: "CASH_ON_HAND" as never, debitMinor: 0, creditMinor: 0 },
      ])
    ).toThrow(/must have either/i);
  });

  test("validateBalance rejects negative amounts", () => {
    expect(() =>
      validateBalance([
        { accountSystemKey: "CASH_ON_HAND" as never, debitMinor: -100, creditMinor: 0 },
      ])
    ).toThrow(/non-negative/i);
  });

  test("simplePayloadHash is deterministic", async () => {
    const p = { a: 1, b: "x" };
    expect(await simplePayloadHash(p)).toBe(await simplePayloadHash(p));
  });

  test("simplePayloadHash differs for different payloads", async () => {
    expect(await simplePayloadHash({ a: 1 })).not.toBe(await simplePayloadHash({ a: 2 }));
  });
});

// ─── Posting engine integration tests ────────────────────────────────────────

describe("Phase 2 — posting engine", () => {
  test("DEPOSIT_RECEIVED creates balanced journal entry", async () => {
    const { t, orgId, customerId, asUser, now } = await seedPhase2Dealer();

    const result = await asUser.mutation(api.accountingLedger.post, {
      orgId,
      eventType: "DEPOSIT_RECEIVED",
      sourceType: "deposits",
      sourceId: "dep_001",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "JOD",
      idempotencyKey: "dep_received_001",
      payload: {
        depositId: "dep_001",
        amountMinor: 5000,
        currency: "JOD",
        paymentMethod: "CASH",
        customerId: customerId.toString(),
      },
    });

    expect(result.alreadyPosted).toBe(false);
    expect(result.journalEntryId).toBeTruthy();

    // Verify balance
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", result.journalEntryId)).collect()
    );
    const debits = lines.reduce((s, l) => s + l.debitMinor, 0);
    const credits = lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(5000);
  });

  test("SALE_COMPLETED with COGS creates 4-line balanced journal", async () => {
    const { t, orgId, customerId, vehicleId, asUser, now } = await seedPhase2Dealer();

    const result = await asUser.mutation(api.accountingLedger.post, {
      orgId,
      eventType: "SALE_COMPLETED",
      sourceType: "sales",
      sourceId: "sale_001",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "JOD",
      idempotencyKey: "sale_001_post",
      payload: {
        saleId: "sale_001",
        saleAmountMinor: 65000000,
        costMinor: 50000000,
        currency: "JOD",
        customerId: customerId.toString(),
        vehicleId: vehicleId.toString(),
      },
    });

    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", result.journalEntryId)).collect()
    );

    expect(lines).toHaveLength(4);
    const totalDebits = lines.reduce((s, l) => s + l.debitMinor, 0);
    const totalCredits = lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(totalDebits).toBe(totalCredits);
  });

  test("duplicate idempotency key returns existing result without double-posting", async () => {
    const { t, orgId, customerId, asUser, now } = await seedPhase2Dealer();

    const payload = {
      depositId: "dep_idem",
      amountMinor: 3000,
      currency: "JOD",
      paymentMethod: "CASH",
      customerId: customerId.toString(),
    };

    const first = await asUser.mutation(api.accountingLedger.post, {
      orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits",
      sourceId: "dep_idem", eventVersion: 1, accountingDate: now,
      occurredAt: now, currency: "JOD", idempotencyKey: "idempotent_deposit_001",
      payload,
    });

    const second = await asUser.mutation(api.accountingLedger.post, {
      orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits",
      sourceId: "dep_idem", eventVersion: 1, accountingDate: now,
      occurredAt: now, currency: "JOD", idempotencyKey: "idempotent_deposit_001",
      payload,
    });

    expect(second.alreadyPosted).toBe(true);
    expect(second.journalEntryId).toBe(first.journalEntryId);

    // Only one journal entry should exist for this source
    const journals = await t.run((ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "deposits").eq("sourceId", "dep_idem")).collect()
    );
    expect(journals).toHaveLength(1);
  });

  test("posting into closed period is rejected", async () => {
    const { orgId, periodId, asUser, customerId, monthStart } = await seedPhase2Dealer();

    await asUser.mutation(api.accountingPeriods.close, { orgId, periodId });

    await expect(
      asUser.mutation(api.accountingLedger.post, {
        orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits",
        sourceId: "dep_closed", eventVersion: 1,
        accountingDate: monthStart + 1000,
        occurredAt: monthStart + 1000,
        currency: "JOD", idempotencyKey: "closed_period_test",
        payload: {
          depositId: "dep_closed", amountMinor: 1000, currency: "JOD",
          customerId: customerId.toString(),
        },
      })
    ).rejects.toThrow(/CLOSED/i);
  });

  test("posting with no covering period is rejected", async () => {
    const { orgId, asUser, customerId } = await seedPhase2Dealer();
    const futureDate = Date.now() + 365 * 24 * 60 * 60 * 1000;

    await expect(
      asUser.mutation(api.accountingLedger.post, {
        orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits",
        sourceId: "dep_future", eventVersion: 1,
        accountingDate: futureDate, occurredAt: futureDate,
        currency: "JOD", idempotencyKey: "no_period_test",
        payload: {
          depositId: "dep_future", amountMinor: 1000, currency: "JOD",
          customerId: customerId.toString(),
        },
      })
    ).rejects.toThrow(/No accounting period/i);
  });

  test("unknown event type is rejected", async () => {
    const { orgId, asUser, now, customerId } = await seedPhase2Dealer();

    await expect(
      asUser.mutation(api.accountingLedger.post, {
        orgId, eventType: "UNKNOWN_EVENT", sourceType: "foo",
        sourceId: "bar", eventVersion: 1,
        accountingDate: now, occurredAt: now,
        currency: "JOD", idempotencyKey: "unknown_event_type",
        payload: {},
      })
    ).rejects.toThrow(/Unknown event type/i);
  });

  test("reversal creates inverse journal and marks original reversed", async () => {
    const { t, orgId, customerId, asUser, now } = await seedPhase2Dealer();

    const postResult = await asUser.mutation(api.accountingLedger.post, {
      orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits",
      sourceId: "dep_rev", eventVersion: 1, accountingDate: now,
      occurredAt: now, currency: "JOD", idempotencyKey: "dep_rev_post",
      payload: {
        depositId: "dep_rev", amountMinor: 2000, currency: "JOD",
        paymentMethod: "CASH", customerId: customerId.toString(),
      },
    });

    const reversalResult = await asUser.mutation(api.accountingLedger.reverse, {
      orgId,
      originalEventId: postResult.eventId,
      reversalDate: now,
      reason: "Customer cancelled deposit",
      idempotencyKey: "dep_rev_reversal",
    });

    expect(reversalResult.alreadyReversed).toBe(false);

    // Original event should be REVERSED
    const originalEvent = await t.run((ctx) => ctx.db.get(postResult.eventId));
    expect(originalEvent?.status).toBe("REVERSED");

    // Original journal should be REVERSED
    const originalJournal = await t.run((ctx) => ctx.db.get(postResult.journalEntryId));
    expect(originalJournal?.status).toBe("REVERSED");

    // Reversal journal should be balanced and inverse
    const reversalLines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", reversalResult.reversalJournalEntryId)).collect()
    );
    const originalLines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", postResult.journalEntryId)).collect()
    );

    // Each reversal line should be the inverse of its original
    for (let i = 0; i < originalLines.length; i++) {
      expect(reversalLines[i].debitMinor).toBe(originalLines[i].creditMinor);
      expect(reversalLines[i].creditMinor).toBe(originalLines[i].debitMinor);
    }

    const rDebits = reversalLines.reduce((s, l) => s + l.debitMinor, 0);
    const rCredits = reversalLines.reduce((s, l) => s + l.creditMinor, 0);
    expect(rDebits).toBe(rCredits);
  });

  test("reversing an already-reversed event is idempotent on second call", async () => {
    const { orgId, customerId, asUser, now } = await seedPhase2Dealer();

    const postResult = await asUser.mutation(api.accountingLedger.post, {
      orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits",
      sourceId: "dep_rev2", eventVersion: 1, accountingDate: now,
      occurredAt: now, currency: "JOD", idempotencyKey: "dep_rev2_post",
      payload: {
        depositId: "dep_rev2", amountMinor: 1500, currency: "JOD",
        customerId: customerId.toString(),
      },
    });

    await asUser.mutation(api.accountingLedger.reverse, {
      orgId, originalEventId: postResult.eventId, reversalDate: now,
      reason: "Test reversal", idempotencyKey: "dep_rev2_reversal",
    });

    const secondReversal = await asUser.mutation(api.accountingLedger.reverse, {
      orgId, originalEventId: postResult.eventId, reversalDate: now,
      reason: "Test reversal", idempotencyKey: "dep_rev2_reversal",
    });

    expect(secondReversal.alreadyReversed).toBe(true);
  });

  test("getJournalEntry returns entry with lines and event", async () => {
    const { orgId, customerId, asUser, now } = await seedPhase2Dealer();

    const postResult = await asUser.mutation(api.accountingLedger.post, {
      orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits",
      sourceId: "dep_read", eventVersion: 1, accountingDate: now,
      occurredAt: now, currency: "JOD", idempotencyKey: "dep_read_001",
      payload: {
        depositId: "dep_read", amountMinor: 1000, currency: "JOD",
        customerId: customerId.toString(),
      },
    });

    const detail = await asUser.query(api.accountingLedger.getJournalEntry, {
      orgId, journalEntryId: postResult.journalEntryId,
    });

    expect(detail).not.toBeNull();
    expect(detail!.entry.status).toBe("POSTED");
    expect(detail!.lines.length).toBeGreaterThan(0);
    expect(detail!.event).not.toBeNull();
    expect(detail!.entry.journalNumber).toMatch(/^JE-/);
  });
});
