/**
 * The survey has to actually FIND the states it exists to find. A diagnostic
 * that silently returns [] is worse than none — it reads as "your books are
 * clean" right before an accountant takes over.
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

type Ctx = Awaited<ReturnType<typeof seed>>;

async function seed(tag: string) {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Org ${tag}`, createdAt: Date.now() }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@example.com` }));
  return { t, orgId, userId };
}

/** A prepaid expense + ACTIVE schedule, with no accounting events of any kind. */
async function seedSchedule(ctx: Ctx, opts: { expenseDate: number }) {
  const expenseId = await ctx.t.run((c) =>
    c.db.insert("expenses", {
      orgId: ctx.orgId, title: "Insurance", amount: 1200, date: opts.expenseDate,
      category: "FEES", status: "PAID", isPrepaid: true, amortizationMonths: 12,
    })
  );
  const scheduleId = await ctx.t.run((c) =>
    c.db.insert("prepaidExpenseSchedules", {
      orgId: ctx.orgId, expenseId, currency: "JOD", totalMinor: 1_200_000, termMonths: 12,
      expenseSystemKey: "PROFESSIONAL_FEES_EXPENSE", startYearMonth: "2026-01",
      recognizedMinor: 0, monthsRecognized: 0, status: "ACTIVE", createdAt: Date.now(),
    })
  );
  return { expenseId, scheduleId };
}

async function insertEvent(
  ctx: Ctx,
  args: {
    eventType: string;
    sourceType: string;
    sourceId: string;
    accountingDate: number;
    status: "PENDING" | "POSTED" | "FAILED" | "REVERSED";
    payload: Record<string, unknown>;
  }
): Promise<Id<"accountingEvents">> {
  return await ctx.t.run((c) =>
    c.db.insert("accountingEvents", {
      orgId: ctx.orgId,
      eventType: args.eventType,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      eventVersion: 1,
      idempotencyKey: `${args.eventType}_${args.sourceId}_${args.accountingDate}`,
      occurredAt: args.accountingDate,
      accountingDate: args.accountingDate,
      currency: "JOD",
      payload: args.payload,
      payloadHash: "test",
      status: args.status,
      createdBy: ctx.userId,
      createdAt: Date.now(),
    })
  );
}

async function survey(ctx: Ctx) {
  return await ctx.t.query(internal.diagnosePrepaidLedgerIntegrity.surveyPrepaidLedgerIntegrity, {});
}

const JAN = Date.UTC(2026, 0, 1);
const MAR = Date.UTC(2026, 2, 20);
const DEC = Date.UTC(2026, 11, 1);

describe("prepaid ledger integrity survey", () => {
  test("flags a posted write-off whose source expense never posted", async () => {
    const ctx = await seed("wo-noSource");
    const { scheduleId, expenseId } = await seedSchedule(ctx, { expenseDate: JAN });
    await insertEvent(ctx, {
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
      accountingDate: JAN, status: "PENDING", payload: { expenseId: expenseId.toString() },
    });
    await insertEvent(ctx, {
      eventType: "PREPAID_EXPENSE_WRITTEN_OFF", sourceType: "prepaidExpenseSchedules",
      sourceId: `${scheduleId}_c1`, accountingDate: MAR, status: "POSTED",
      payload: { scheduleId: scheduleId.toString(), amountMinor: 300_000 },
    });

    const { findings } = await survey(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].defect).toBe("correction_without_posted_source");
    expect(findings[0].amountMinor).toBe(300_000);
    expect(findings[0].currency).toBe("JOD");
    expect(findings[0].scheduleId).toBe(scheduleId);
  });

  test("flags a posted refund whose source expense never posted", async () => {
    const ctx = await seed("rf-noSource");
    const { scheduleId, expenseId } = await seedSchedule(ctx, { expenseDate: JAN });
    await insertEvent(ctx, {
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
      accountingDate: JAN, status: "FAILED", payload: { expenseId: expenseId.toString() },
    });
    await insertEvent(ctx, {
      eventType: "PREPAID_EXPENSE_REFUNDED", sourceType: "prepaidExpenseSchedules",
      sourceId: `${scheduleId}_c1`, accountingDate: MAR, status: "POSTED",
      payload: { scheduleId: scheduleId.toString(), amountMinor: 300_000 },
    });

    const { findings } = await survey(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].defect).toBe("correction_without_posted_source");
  });

  test("flags a correction dated before the debit it credits", async () => {
    const ctx = await seed("dated-before");
    const { scheduleId, expenseId } = await seedSchedule(ctx, { expenseDate: DEC });
    await insertEvent(ctx, {
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
      accountingDate: DEC, status: "POSTED", payload: { expenseId: expenseId.toString() },
    });
    await insertEvent(ctx, {
      eventType: "PREPAID_EXPENSE_REFUNDED", sourceType: "prepaidExpenseSchedules",
      sourceId: `${scheduleId}_c1`, accountingDate: MAR, status: "POSTED",
      payload: { scheduleId: scheduleId.toString(), amountMinor: 300_000 },
    });

    const { findings } = await survey(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].defect).toBe("correction_dated_before_source");
    expect(findings[0].sourceAccountingDate).toBe(DEC);
    expect(findings[0].eventAccountingDate).toBe(MAR);
  });

  test("flags recognition posted without a posted source expense", async () => {
    const ctx = await seed("amort-noSource");
    const { scheduleId, expenseId } = await seedSchedule(ctx, { expenseDate: JAN });
    await insertEvent(ctx, {
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
      accountingDate: JAN, status: "PENDING", payload: { expenseId: expenseId.toString() },
    });
    await insertEvent(ctx, {
      eventType: "PREPAID_EXPENSE_AMORTIZED", sourceType: "prepaidExpenseSchedules",
      sourceId: `${scheduleId}_2026-01`, accountingDate: JAN, status: "POSTED",
      payload: { scheduleId: scheduleId.toString(), amountMinor: 100_000, yearMonth: "2026-01" },
    });

    const { findings } = await survey(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].defect).toBe("amortization_without_posted_source");
  });

  test("flags a reversed source expense that still has a live correction", async () => {
    const ctx = await seed("src-reversed");
    const { scheduleId, expenseId } = await seedSchedule(ctx, { expenseDate: JAN });
    await insertEvent(ctx, {
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
      accountingDate: JAN, status: "REVERSED", payload: { expenseId: expenseId.toString() },
    });
    await insertEvent(ctx, {
      eventType: "PREPAID_EXPENSE_WRITTEN_OFF", sourceType: "prepaidExpenseSchedules",
      sourceId: `${scheduleId}_c1`, accountingDate: MAR, status: "POSTED",
      payload: { scheduleId: scheduleId.toString(), amountMinor: 300_000 },
    });

    const { findings } = await survey(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].defect).toBe("source_reversed_with_live_correction");
  });

  test("stays silent on a healthy schedule", async () => {
    // The whole point of a diagnostic is that a clean result means clean.
    const ctx = await seed("healthy");
    const { scheduleId, expenseId } = await seedSchedule(ctx, { expenseDate: JAN });
    await insertEvent(ctx, {
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
      accountingDate: JAN, status: "POSTED", payload: { expenseId: expenseId.toString() },
    });
    await insertEvent(ctx, {
      eventType: "PREPAID_EXPENSE_AMORTIZED", sourceType: "prepaidExpenseSchedules",
      sourceId: `${scheduleId}_2026-01`, accountingDate: JAN, status: "POSTED",
      payload: { scheduleId: scheduleId.toString(), amountMinor: 100_000, yearMonth: "2026-01" },
    });
    await insertEvent(ctx, {
      eventType: "PREPAID_EXPENSE_WRITTEN_OFF", sourceType: "prepaidExpenseSchedules",
      sourceId: `${scheduleId}_c1`, accountingDate: MAR, status: "POSTED",
      payload: { scheduleId: scheduleId.toString(), amountMinor: 300_000 },
    });

    const { findings } = await survey(ctx);
    expect(findings).toHaveLength(0);
  });

  test("ignores a queued correction — not yet a misstatement", async () => {
    // A PENDING correction is a real risk (it can still drain), but it hasn't
    // moved the ledger, so it isn't what this survey reports on.
    const ctx = await seed("queued-correction");
    const { scheduleId, expenseId } = await seedSchedule(ctx, { expenseDate: JAN });
    await insertEvent(ctx, {
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
      accountingDate: JAN, status: "PENDING", payload: { expenseId: expenseId.toString() },
    });
    await insertEvent(ctx, {
      eventType: "PREPAID_EXPENSE_WRITTEN_OFF", sourceType: "prepaidExpenseSchedules",
      sourceId: `${scheduleId}_c1`, accountingDate: MAR, status: "PENDING",
      payload: { scheduleId: scheduleId.toString(), amountMinor: 300_000 },
    });

    const { findings } = await survey(ctx);
    expect(findings).toHaveLength(0);
  });

  test("reports across organizations and never writes", async () => {
    const ctx = await seed("multi");
    const { scheduleId, expenseId } = await seedSchedule(ctx, { expenseDate: JAN });
    await insertEvent(ctx, {
      eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId.toString(),
      accountingDate: JAN, status: "PENDING", payload: { expenseId: expenseId.toString() },
    });
    const badEventId = await insertEvent(ctx, {
      eventType: "PREPAID_EXPENSE_WRITTEN_OFF", sourceType: "prepaidExpenseSchedules",
      sourceId: `${scheduleId}_c1`, accountingDate: MAR, status: "POSTED",
      payload: { scheduleId: scheduleId.toString(), amountMinor: 300_000 },
    });

    const before = await ctx.t.run((c) => c.db.get(badEventId));
    const { findings, orgsScanned } = await survey(ctx);
    const after = await ctx.t.run((c) => c.db.get(badEventId));

    expect(orgsScanned).toBeGreaterThan(0);
    expect(findings).toHaveLength(1);
    // Diagnostic only: the offending row is reported, never touched.
    expect(after).toEqual(before);
  });
});
