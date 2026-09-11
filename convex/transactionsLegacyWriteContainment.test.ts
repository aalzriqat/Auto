/**
 * SCRUM-53 — the legacy `transactions` write surface is contained server-side.
 *
 * The defect these tests pin: `transactions.add` / `.update` / `.remove` let a
 * finance user create, edit or delete something the client presents as
 * Accounting while `accountingEvents` / `journalEntries` / `journalLines` — the
 * authoritative books — did not move at all. A false book.
 *
 * The containment is an UNCONDITIONAL refusal, not a representation guard. The
 * `transactions` table carries no field naming the posting that represents a
 * row, and only rows posted by `accountingMigration` are discoverable through
 * an `accountingEvents` row with `sourceType: "transactions"` — a row whose
 * accounting was written by its owning domain workflow carries that workflow's
 * own source identity instead. So a guard that tried to refuse only
 * "GL-represented" rows would fail open on exactly the rows with real books
 * behind them. Refusing every row removes the thing that had to be guessed.
 *
 * The three names stay exported on purpose: installed mobile clients bind
 * Convex functions by hand-written string in `apps/mobile/src/convexApi.ts`,
 * so a deleted name would surface as "function not found" rather than as a
 * refusal that says what to do instead. Deleting them is the ordered
 * client-second stage and is not this unit.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { postLegacyTransactionEvent } from "../test-utils/legacyMigrationSeed";
import type { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.*s");

/** The refusal every legacy write door must produce. */
const REFUSAL = /view only and is not the General Ledger/i;

async function seedFinanceOrg() {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Containment Dealer", createdAt: Date.now() })
  );
  // A paid subscription is what enables the `accounting` feature the
  // authoritative reports require.
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
    ctx.db.insert("users", {
      clerkId: "containment_owner",
      email: "containment-owner@example.com",
      name: "Containment Owner",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    })
  );
  const asOwner = t.withIdentity({ subject: "containment_owner", clerkId: "containment_owner" });
  return { t, orgId, userId, asOwner };
}

type FinanceOrg = Awaited<ReturnType<typeof seedFinanceOrg>>;

/** A legacy cash-movement row, written the way domain workflows write one. */
async function insertLegacyRow(s: FinanceOrg, overrides: Record<string, unknown> = {}) {
  return await s.t.run((ctx) =>
    ctx.db.insert("transactions", {
      orgId: s.orgId,
      type: "OUT" as const,
      amount: 100,
      date: Date.UTC(2025, 1, 1),
      category: "EXPENSE" as const,
      description: "Legacy cash movement",
      ...overrides,
    })
  );
}

async function readRow(s: FinanceOrg, id: Id<"transactions">) {
  return await s.t.run((ctx) => ctx.db.get(id));
}

async function countRows(s: FinanceOrg) {
  return (await s.t.run((ctx) => ctx.db.query("transactions").collect())).length;
}

describe("SCRUM-53 — legacy transactions write doors are closed server-side", () => {
  test("add refuses, writes no row, and reserves no idempotency", async () => {
    const s = await seedFinanceOrg();

    await expect(
      s.asOwner.mutation(api.transactions.add, {
        orgId: s.orgId,
        type: "IN",
        amount: 750,
        date: Date.now(),
        category: "COLLECTION_PAYMENT",
        description: "Money the books would never see",
        idempotencyKey: "containment-add-1",
      })
    ).rejects.toThrow(REFUSAL);

    expect(await countRows(s)).toBe(0);

    // The refusal precedes the idempotency reservation, so a refused call
    // leaves no command record that a later legitimate command could collide
    // with.
    const reservations = await s.t.run((ctx) =>
      ctx.db.query("commandIdempotency").collect()
    );
    expect(reservations).toHaveLength(0);
  });

  test("update refuses and leaves the row exactly as it was", async () => {
    const s = await seedFinanceOrg();
    const id = await insertLegacyRow(s);
    const before = await readRow(s, id);

    await expect(
      s.asOwner.mutation(api.transactions.update, {
        orgId: s.orgId,
        transactionId: id,
        amount: 999_999,
        category: "DEPOSIT",
        description: "Edited to say something else",
      })
    ).rejects.toThrow(REFUSAL);

    expect(await readRow(s, id)).toEqual(before);
  });

  test("remove refuses and leaves the row live", async () => {
    const s = await seedFinanceOrg();
    const id = await insertLegacyRow(s);
    const before = await readRow(s, id);

    await expect(
      s.asOwner.mutation(api.transactions.remove, { orgId: s.orgId, transactionId: id })
    ).rejects.toThrow(REFUSAL);

    const after = await readRow(s, id);
    expect(after).toEqual(before);
    expect(after?.isDeleted).toBeUndefined();
  });

  test("the refusal precedes authentication, membership and row lookup", async () => {
    const s = await seedFinanceOrg();
    const id = await insertLegacyRow(s);
    const before = await readRow(s, id);
    const anonymous = convexTestWithComponents(schema, MODULES);

    // An unauthenticated caller gets the same refusal, not an auth error:
    // proof that nothing runs ahead of it. If auth ran first this would throw
    // "Unauthenticated" instead.
    await expect(
      anonymous.mutation(api.transactions.add, {
        orgId: s.orgId,
        type: "IN",
        amount: 1,
        date: Date.now(),
        category: "OTHER",
        description: "No identity at all",
      })
    ).rejects.toThrow(REFUSAL);

    // A transaction id that belongs to another org also produces the refusal
    // rather than "transaction not found" — nothing is read first.
    const foreignId = await s.t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", {
        name: "Other Dealer",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("transactions", {
        orgId: otherOrgId,
        type: "IN" as const,
        amount: 5,
        date: Date.now(),
        category: "OTHER" as const,
        description: "A row owned by another org",
      });
    });

    await expect(
      s.asOwner.mutation(api.transactions.remove, { orgId: s.orgId, transactionId: foreignId })
    ).rejects.toThrow(REFUSAL);

    expect(await readRow(s, id)).toEqual(before);
    expect((await readRow(s, foreignId))?.isDeleted).toBeUndefined();
  });

  test("a migrated, GL-represented row cannot be edited or deleted, and the books do not move", async () => {
    const s = await seedFinanceOrg();
    await s.asOwner.mutation(api.chartOfAccounts.initialize, { orgId: s.orgId });
    await s.asOwner.mutation(api.accountingPeriods.create, {
      orgId: s.orgId,
      startDate: Date.UTC(2025, 0, 1),
      endDate: Date.UTC(2025, 11, 31, 23, 59, 59, 999),
      fiscalYear: 2025,
      periodNumber: 1,
    });
    const periods = await s.asOwner.query(api.accountingPeriods.list, { orgId: s.orgId });
    await s.asOwner.mutation(api.accountingPeriods.open, {
      orgId: s.orgId,
      periodId: periods[0]._id,
    });

    const id = await insertLegacyRow(s);
    // This is what makes the row GL-represented: an accountingEvent with
    // `sourceType: "transactions"` and a real journal entry behind it.
    //
    // ⚠️ RE-VEHICLED DURING RC INTEGRATION (SCRUM-313), AND THE TEST IS NOT
    // WEAKENED BY IT. This called `accountingMigration.migrateUnpostedTransactions`,
    // which was live at this artifact's base (`62b5a5b9c`, 61 commits behind
    // protected main). SCRUM-234 has since reduced that mutation to a
    // parameterless unconditional throw, so the call now fails before the row is
    // ever posted — and this is the DECISIVE case of the whole suite, the one
    // whose red proved `transactions.update` succeeding on a migrated,
    // GL-represented row.
    //
    // SCRUM-234 relocated legacy seeding into `postLegacyTransactionEvent`,
    // which posts through the SAME engine under the SAME source identity and the
    // SAME `migrate_<id>` idempotency key the retired writer built. The row this
    // produces is GL-represented in exactly the sense the assertions below check,
    // and they are unchanged: a POSTED event indexed by
    // `by_org_source` on `("transactions", <row id>)`, with a journal entry and
    // journal lines behind it. Only the seam that creates it moved.
    await s.t.run((ctx) =>
      postLegacyTransactionEvent(ctx, { orgId: s.orgId, transactionId: id, actorId: s.userId })
    );

    const event = await s.t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", s.orgId).eq("sourceType", "transactions").eq("sourceId", id.toString())
        )
        .first()
    );
    expect(event?.status).toBe("POSTED");
    expect(event?.journalEntryId).toBeTruthy();

    const rowBefore = await readRow(s, id);
    const linesBefore = await s.t.run((ctx) => ctx.db.query("journalLines").collect());
    const tbBefore = await s.asOwner.query(api.accountingReports.trialBalance, {
      orgId: s.orgId,
      toDate: Date.UTC(2025, 11, 31),
    });
    expect(linesBefore.length).toBeGreaterThan(0);

    await expect(
      s.asOwner.mutation(api.transactions.update, {
        orgId: s.orgId,
        transactionId: id,
        amount: 5_000,
      })
    ).rejects.toThrow(REFUSAL);

    await expect(
      s.asOwner.mutation(api.transactions.remove, { orgId: s.orgId, transactionId: id })
    ).rejects.toThrow(REFUSAL);

    // Neither the projection row nor the books moved.
    expect(await readRow(s, id)).toEqual(rowBefore);
    expect(await s.t.run((ctx) => ctx.db.query("journalLines").collect())).toEqual(linesBefore);
    const tbAfter = await s.asOwner.query(api.accountingReports.trialBalance, {
      orgId: s.orgId,
      toDate: Date.UTC(2025, 11, 31),
    });
    expect(tbAfter.rows).toEqual(tbBefore.rows);
  });

  test("the read projection still works, so nothing operational was broken", async () => {
    const s = await seedFinanceOrg();
    await insertLegacyRow(s, { description: "Still visible", amount: 42 });

    const page = await s.asOwner.query(api.transactions.list, {
      orgId: s.orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page).toHaveLength(1);
    expect(page.page[0]).toMatchObject({ description: "Still visible", amount: 42 });
  });
});
