/**
 * SCRUM-234 — the `transactions` SOURCE FAMILY is refused at the forward
 * posting boundary.
 *
 * Retiring `migrateUnpostedTransactions` retired the only production CALLER
 * that minted a `sourceType: "transactions"` accounting event. It did not
 * retire the AUTHORITY: `postAccountingEvent` takes a caller-supplied
 * `sourceType`, `accountingLedger.post` exposes it as a free-form `v.string()`,
 * and the outbox forwards a stored one on redrive. Two successive static guards
 * over the source tree failed to close that gap — a textual scan measures
 * recognition, not authority — so the refusal now lives at the economic
 * chokepoint every legitimate posting already passes through.
 *
 * The call graph was verified before choosing that point, not assumed: exactly
 * two functions create `accountingEvents` rows in non-test `convex/` —
 * `postingEngine.postAccountingEvent` (forward) and
 * `reversals.reverseAccountingEvent` (reversal). Every forward path — domain
 * hooks, `accountingLedger.post`, the migration, and the outbox drain — reaches
 * the first.
 *
 * WHAT THIS FILE PROVES, in the order the owner ruling requires it:
 *
 *   1-2  the pre-guard engine COULD create accounting state under this family
 *        (failing-first; see the control note below)
 *   3    the same call now refuses
 *   4    the complete financial footprint is unchanged by the refusal
 *   5    ordinary modern source families still post
 *   6    legitimate replay for a modern source still works
 *   7    read-only audit of historical legacy-sourced events remains usable
 *
 * plus the boundary the ruling draws explicitly: a historical reversal of a
 * legacy-sourced event still succeeds, because reversing an old event is not
 * minting a new forward one.
 *
 * FAILING-FIRST CONTROL, executed: with `RETIRED_SOURCE_TYPES` emptied in
 * `convex/accounting/postingEngine.ts` and this file unchanged, the refusal
 * cases fail — the engine posts, and the footprint assertions catch the
 * resulting events, journals, lines and snapshots. The controls (items 5, 6, 7
 * and the reversal case) pass in BOTH states, which is what makes them
 * controls rather than blind tests. The run is recorded on SCRUM-234.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { postLegacyTransactionEvent } from "../test-utils/legacyMigrationSeed";
import { reverseAccountingEvent } from "./accounting/reversals";
import { enqueuePendingPost } from "./accountingOutbox";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "SCRUM-234 Source Family", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "sf_owner", email: "sf@example.com", name: "Owner" })
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

  const asOwner = t.withIdentity({ subject: "sf_owner", clerkId: "sf_owner" });
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

  return { t, orgId, userId, asOwner };
}

type Dealer = Awaited<ReturnType<typeof seedDealer>>;

type FootprintTable =
  | "accountingEvents"
  | "pendingAccountingEvents"
  | "journalEntries"
  | "journalLines"
  | "accountBalanceSnapshots"
  | "financialAuditLog"
  | "transactions";

/**
 * The complete financial footprint, as sorted identity lists.
 *
 * Sorted ids rather than counts: counts stay equal when one row is deleted and
 * another inserted, so `toEqual` on the ids fails on an addition, a removal, or
 * a swap. `transactions` is included because the ruling requires the source
 * legacy rows themselves to be asserted unchanged.
 */
async function footprint(t: Dealer["t"], orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
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
      transactions: await ids("transactions"),
    };
  });
}

/** A well-formed expense posting command, varying only the source family. */
function expenseCommand(orgId: Id<"organizations">, sourceType: string, sourceId: string, key: string) {
  const now = Date.now();
  return {
    orgId,
    eventType: "EXPENSE_POSTED" as const,
    sourceType,
    sourceId,
    eventVersion: 1,
    accountingDate: now,
    occurredAt: now,
    currency: "JOD",
    idempotencyKey: key,
    payload: { expenseId: sourceId, amountMinor: 100_000, currency: "JOD" },
  };
}

describe("SCRUM-234 — a new forward event cannot be sourced from the legacy cashbook", () => {
  test("the real posting boundary refuses it, with zero financial footprint", async () => {
    const dealer = await seedDealer();
    const { t, orgId, asOwner } = dealer;

    const before = await footprint(t, orgId);

    // `internal.accountingLedger.post` is the reachable production entry to the
    // shared engine, and the exact surface the finding was raised about: a
    // free-form `sourceType: v.string()` on an internalMutation. The payload is
    // otherwise entirely legitimate — this is not refused for being malformed.
    await expect(
      asOwner.mutation(internal.accountingLedger.post, expenseCommand(orgId, "transactions", "legacy_1", "sf_key_1"))
    ).rejects.toThrow(/retired and can no longer originate/i);

    expect(await footprint(t, orgId)).toEqual(before);
  });

  test("the refusal lands before the idempotency record, so the key stays reusable", async () => {
    const dealer = await seedDealer();
    const { t, orgId, asOwner } = dealer;

    // If the refusal landed after the idempotency probe completed, the key
    // would be burned and this second, LEGITIMATE post would be swallowed as a
    // duplicate. That is the specific ordering the ruling requires, asserted
    // behaviourally rather than by reading the source.
    await expect(
      asOwner.mutation(internal.accountingLedger.post, expenseCommand(orgId, "transactions", "shared_id", "shared_key"))
    ).rejects.toThrow(/retired and can no longer originate/i);

    await asOwner.mutation(internal.accountingLedger.post, expenseCommand(orgId, "expenses", "shared_id", "shared_key"));

    const events = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(events).toHaveLength(1);
    expect(events[0].sourceType).toBe("expenses");
    expect(events[0].status).toBe("POSTED");
  });

  test("a queued POST carrying the retired family cannot drain into the books", async () => {
    const dealer = await seedDealer();
    const { t, orgId, userId } = dealer;

    // The outbox forwards a STORED source type on redrive, so a row queued
    // before the retirement is its own path to the engine. Seeded through the
    // PRODUCTION enqueue helper rather than a hand-built insert, so the row is
    // shaped exactly as pre-retirement code would have left it.
    await t.run((ctx) =>
      enqueuePendingPost(
        ctx,
        {
          orgId,
          eventType: "EXPENSE_POSTED",
          sourceType: "transactions",
          sourceId: "queued_legacy",
          eventVersion: 1,
          accountingDate: Date.now(),
          occurredAt: Date.now(),
          currency: "JOD",
          idempotencyKey: "queued_legacy_key",
          payload: { expenseId: "queued_legacy", amountMinor: 50_000, currency: "JOD" },
          actorId: userId,
        },
        "seeded as if queued before the retirement"
      )
    );

    const queued = await t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect());
    expect(queued).toHaveLength(1);
    expect(queued[0].sourceType).toBe("transactions");
    expect(queued[0].status).toBe("PENDING");

    const before = await footprint(t, orgId);
    expect(before.accountingEvents).toHaveLength(0);

    // Drain through the real operator-facing outbox entry point.
    await dealer.asOwner.mutation(api.accountingOutbox.redrive, { orgId });

    const after = await footprint(t, orgId);
    // No event, no journal, no line, no snapshot came from that queued row.
    expect(after.accountingEvents).toEqual([]);
    expect(after.journalEntries).toEqual([]);
    expect(after.journalLines).toEqual([]);
    expect(after.accountBalanceSnapshots).toEqual([]);
  });
});

describe("SCRUM-234 — the refusal is narrow: legitimate accounting is untouched", () => {
  test("ordinary modern source families still post", async () => {
    const dealer = await seedDealer();
    const { t, orgId, asOwner } = dealer;

    // A control. This must pass both before and after the guard exists — if it
    // ever fails, the refusal has stopped being narrow.
    for (const [sourceType, sourceId, key] of [
      ["expenses", "exp_1", "ctl_exp"],
      ["collectionPayments", "col_1", "ctl_col"],
      ["sales", "sale_1", "ctl_sale"],
    ] as const) {
      await asOwner.mutation(internal.accountingLedger.post, expenseCommand(orgId, sourceType, sourceId, key));
    }

    const events = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(events.map((e) => e.sourceType).sort()).toEqual(["collectionPayments", "expenses", "sales"]);
    expect(events.every((e) => e.status === "POSTED")).toBe(true);
  });

  test("legitimate replay of a modern source is still idempotent, not double-posted", async () => {
    const dealer = await seedDealer();
    const { t, orgId, asOwner } = dealer;
    const cmd = expenseCommand(orgId, "expenses", "replay_1", "replay_key");

    await asOwner.mutation(internal.accountingLedger.post, cmd);
    await asOwner.mutation(internal.accountingLedger.post, cmd);

    const events = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    const lines = await t.run((ctx) => ctx.db.query("journalLines").collect());
    expect(events).toHaveLength(1);
    expect(lines).toHaveLength(2);
  });
});

describe("SCRUM-234 — historical legacy-sourced events stay readable and reversible", () => {
  test("read-only audit of a historical legacy-sourced event still works", async () => {
    const dealer = await seedDealer();
    const { t, orgId, userId, asOwner } = dealer;

    const transactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 100, date: Date.now(),
        category: "EXPENSE", description: "Historical legacy row",
      })
    );
    await t.run((ctx) => postLegacyTransactionEvent(ctx, { orgId, transactionId, actorId: userId }));

    // The historical row exists with legacy provenance...
    const events = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(events).toHaveLength(1);
    expect(events[0].sourceType).toBe("transactions");

    // ...and every read-only surface can still see it. The ruling is explicit
    // that the boundary must not make historical evidence unreadable.
    const gap = await asOwner.query(api.accountingMigration.migrationGapAnalysis, { orgId });
    expect(gap.gl.events).toBe(1);

    const audit = await asOwner.query(api.accountingMigration.auditLegacyTransactions, { orgId });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].hasJournalEntry).toBe(true);

    const listed = await asOwner.query(api.accountingLedger.listAccountingEvents, {
      orgId, sourceType: "transactions", sourceId: transactionId.toString(),
    });
    expect(listed).toHaveLength(1);
  });

  test("a historical legacy-sourced event can still be reversed", async () => {
    const dealer = await seedDealer();
    const { t, orgId, userId } = dealer;

    const transactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 100, date: Date.now(),
        category: "EXPENSE", description: "Historical row to reverse",
      })
    );
    await t.run((ctx) => postLegacyTransactionEvent(ctx, { orgId, transactionId, actorId: userId }));

    const original = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(original[0].sourceType).toBe("transactions");

    // The ruling draws this boundary explicitly: reversing a historical event
    // is not minting a new forward occurrence, and `reverseAccountingEvent`
    // does not route through `postAccountingEvent` at all. So this must still
    // succeed even though the original's stored source is the retired family.
    await t.run((ctx) =>
      reverseAccountingEvent(ctx, {
        orgId,
        originalEventId: original[0]._id,
        reversalDate: Date.now(),
        reason: "historical correction",
        idempotencyKey: "rev_legacy_1",
        actorId: userId,
      })
    );

    const after = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    const reversal = after.find((e) => e.eventType === "JOURNAL_REVERSAL");
    expect(reversal).toBeTruthy();
    expect(reversal?.reversalOfEventId).toBe(original[0]._id);
  });
});
