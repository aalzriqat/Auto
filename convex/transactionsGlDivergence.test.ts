/**
 * SCRUM-53 — the legacy cashbook must not be editable once the GL represents it.
 *
 * `transactions` is the operational cashbook. The authoritative books are
 * `journalEntries` + `journalLines`, and `migrateUnpostedTransactions` copies a
 * cashbook row into the GL, recording an `accountingEvents` row with
 * `sourceType: "transactions"` and `sourceId` = the transaction id.
 *
 * After that point the amount exists twice and only one copy is the books.
 * Editing or deleting the cashbook row moves the copy nobody reports from,
 * while the Trial Balance, P&L and Balance Sheet keep the original figure —
 * so a finance user watches their correction succeed and the statements
 * disagree with it permanently, with nothing on screen saying which is right.
 *
 * These assert the REFUSAL, not the shape of the guard.
 */
import fs from "node:fs";
import path from "node:path";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { anyApi } from "convex/server";
import { ALL_PERMISSIONS } from "./utils/permissions";

const MODULES = import.meta.glob("./**/*.*s");

async function setupOrgWithCashbookRow() {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Cashbook Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "cashbook_manager",
      email: "cashbook@example.com",
      name: "Cashbook Manager",
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
  const asManager = t.withIdentity({ subject: "cashbook_manager" });

  // Inserted directly, the way the seven domain modules that own real cashbook
  // rows do it (collections, expenses, deposits, sales, vehicles, work orders).
  // There is no longer a public mutation that creates one — see the
  // "no public door" suite at the bottom of this file.
  const transactionId = await t.run((ctx) =>
    ctx.db.insert("transactions", {
      orgId,
      type: "IN",
      amount: 1_500,
      category: "OTHER",
      description: "Counter cash",
      date: Date.now(),
    })
  );

  /** Mirrors what `migrateUnpostedTransactions` records when it posts the row. */
  async function representInGl(
    status: "POSTED" | "PENDING" | "REVERSED" | "FAILED",
    options: { withJournalEntry?: boolean } = {}
  ) {
    const journalEntryId = options.withJournalEntry
      ? await t.run((ctx) =>
          ctx.db.insert("journalEntries", {
            orgId,
            journalNumber: `JE-${status}-${Date.now()}`,
            accountingDate: Date.now(),
            sourceType: "transactions",
            sourceId: transactionId as string,
            category: "SYSTEM",
            memo: "Migrated cashbook row",
            currency: "JOD",
            status: status === "REVERSED" ? "REVERSED" : "POSTED",
            postedBy: userId,
            postedAt: Date.now(),
            createdAt: Date.now(),
          })
        )
      : undefined;

    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId,
        eventType: "LEGACY_TRANSACTION_MIGRATED",
        sourceType: "transactions",
        sourceId: transactionId as string,
        eventVersion: 1,
        idempotencyKey: `migrated-${transactionId}-${status}`,
        occurredAt: Date.now(),
        accountingDate: Date.now(),
        currency: "JOD",
        payload: {},
        status,
        journalEntryId,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
  }

  return { t, orgId, asManager, transactionId, representInGl };
}

describe("legacy cashbook rows already represented in the GL", () => {
  test("cannot be edited once the migration event is POSTED", async () => {
    const { orgId, asManager, transactionId, representInGl } = await setupOrgWithCashbookRow();
    await representInGl("POSTED");

    await expect(
      asManager.mutation(api.transactions.update, {
        orgId,
        transactionId,
        amount: 9_999,
      })
    ).rejects.toThrow(/already been posted to the general ledger/i);
  });

  test("the refused edit really did not happen", async () => {
    // A guard that throws AFTER patching would still satisfy the assertion
    // above. The point of the refusal is that the cashbook and the GL keep
    // agreeing, so the stored amount is what actually matters.
    const { t, orgId, asManager, transactionId, representInGl } = await setupOrgWithCashbookRow();
    await representInGl("POSTED");

    await expect(
      asManager.mutation(api.transactions.update, { orgId, transactionId, amount: 9_999 })
    ).rejects.toThrow();

    const row = await t.run((ctx) => ctx.db.get(transactionId));
    expect(row?.amount).toBe(1_500);
  });

  test("cannot be soft-deleted once the migration event is POSTED", async () => {
    // A delete is not gentler than an edit here: it removes the row from the
    // cashbook while the GL keeps the posting, so the books disagree in the
    // direction that HIDES money rather than restating it.
    const { t, orgId, asManager, transactionId, representInGl } = await setupOrgWithCashbookRow();
    await representInGl("POSTED");

    await expect(
      asManager.mutation(api.transactions.remove, { orgId, transactionId })
    ).rejects.toThrow(/already been posted to the general ledger/i);

    const row = await t.run((ctx) => ctx.db.get(transactionId));
    expect(row?.isDeleted).not.toBe(true);
  });

  test("a PENDING migration event does not block — nothing has posted yet", async () => {
    const { orgId, asManager, transactionId, representInGl } = await setupOrgWithCashbookRow();
    await representInGl("PENDING");

    await asManager.mutation(api.transactions.update, {
      orgId,
      transactionId,
      amount: 1_750,
    });
  });

  test("a REVERSED migration event still blocks — a reversal does not un-write the GL", async () => {
    // The original event is patched to REVERSED *in place* and keeps its
    // journal entry; a second, inverted entry is posted beside it. Both halves
    // stay in the books and `getPostedLines` reads both. Letting the cashbook
    // row change afterwards leaves the surviving audit trail describing an
    // amount that no longer exists at its own source.
    const { t, orgId, asManager, transactionId, representInGl } = await setupOrgWithCashbookRow();
    await representInGl("REVERSED", { withJournalEntry: true });

    await expect(
      asManager.mutation(api.transactions.remove, { orgId, transactionId })
    ).rejects.toThrow(/already been posted to the general ledger/i);

    await expect(
      asManager.mutation(api.transactions.update, { orgId, transactionId, amount: 9_999 })
    ).rejects.toThrow(/already been posted to the general ledger/i);

    const row = await t.run((ctx) => ctx.db.get(transactionId));
    expect(row?.amount).toBe(1_500);
    expect(row?.isDeleted).not.toBe(true);
  });

  test("an event carrying a journal entry blocks whatever its status says", async () => {
    // Status alone is not evidence in either direction: POSTED without a
    // journal entry posted nothing, and a journal entry can be attached under
    // another status. The guard fails closed on the journal entry itself.
    const { orgId, asManager, transactionId, representInGl } = await setupOrgWithCashbookRow();
    await representInGl("FAILED", { withJournalEntry: true });

    await expect(
      asManager.mutation(api.transactions.update, { orgId, transactionId, amount: 9_999 })
    ).rejects.toThrow(/already been posted to the general ledger/i);
  });

  test("a FAILED event with no journal entry does not block — nothing reached the books", async () => {
    const { t, orgId, asManager, transactionId, representInGl } = await setupOrgWithCashbookRow();
    await representInGl("FAILED");

    await asManager.mutation(api.transactions.update, { orgId, transactionId, amount: 1_800 });
    const row = await t.run((ctx) => ctx.db.get(transactionId));
    expect(row?.amount).toBe(1_800);
  });

  test("an unmigrated row is still fully editable", async () => {
    // The guard must not become a blanket freeze on the cashbook: rows that
    // never reached the GL are exactly what the legacy screen is still for.
    const { t, orgId, asManager, transactionId } = await setupOrgWithCashbookRow();

    await asManager.mutation(api.transactions.update, {
      orgId,
      transactionId,
      amount: 2_000,
    });
    const row = await t.run((ctx) => ctx.db.get(transactionId));
    expect(row?.amount).toBe(2_000);
  });

  test("another org's posted event cannot freeze this org's row", async () => {
    // `by_org_source` is keyed on orgId first; if the guard ever dropped that
    // it would leak one tenant's migration state into another's cashbook.
    const { t, orgId, asManager, transactionId } = await setupOrgWithCashbookRow();
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const otherUserId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "other", email: "other@example.com", name: "Other" })
    );
    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId: otherOrgId,
        eventType: "LEGACY_TRANSACTION_MIGRATED",
        sourceType: "transactions",
        sourceId: transactionId as string,
        eventVersion: 1,
        idempotencyKey: "cross-tenant",
        occurredAt: Date.now(),
        accountingDate: Date.now(),
        currency: "JOD",
        payload: {},
        status: "POSTED",
        createdBy: otherUserId,
        createdAt: Date.now(),
      })
    );

    await asManager.mutation(api.transactions.update, { orgId, transactionId, amount: 2_500 });
    const row = await t.run((ctx) => ctx.db.get(transactionId));
    expect(row?.amount).toBe(2_500);
  });
});

/**
 * The replay question, asked of the real migration rather than of the guard.
 *
 * A row whose GL posting was reversed is the one case where "is this on the
 * books?" has a genuinely ambiguous answer. The danger is not the edit itself
 * but what a later replay concludes: if `migrateUnpostedTransactions` decided
 * "no live posting, therefore unposted money", it would post the row a SECOND
 * time — and if the row had been edited in between, it would post an amount
 * nobody ever recorded.
 */
describe("a reversed cashbook row cannot come back as fresh unposted money", () => {
  async function seedMigratableOrg() {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Replay Dealer", createdAt: Date.now() })
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
      ctx.db.insert("users", { clerkId: "replay_owner", email: "replay@example.com", name: "Owner" })
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
    const asOwner = t.withIdentity({ subject: "replay_owner", clerkId: "replay_owner" });
    await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });

    return { t, orgId, userId, asOwner };
  }

  test("the migration skips it as already represented, at whatever amount", async () => {
    const { t, orgId, userId, asOwner } = await seedMigratableOrg();

    const transactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "OUT",
        amount: 1_000,
        category: "EXPENSE",
        description: "Workshop consumables",
        date: Date.now(),
      })
    );

    // Posted, then reversed — the original event keeps its journal entry and is
    // patched to REVERSED in place, exactly as `reversals.ts` leaves it.
    const journalEntryId = await t.run((ctx) =>
      ctx.db.insert("journalEntries", {
        orgId,
        journalNumber: "JE-REPLAY-1",
        accountingDate: Date.now(),
        sourceType: "transactions",
        sourceId: transactionId as string,
        category: "SYSTEM",
        memo: "Migrated then reversed",
        currency: "JOD",
        status: "REVERSED",
        postedBy: userId,
        postedAt: Date.now(),
        createdAt: Date.now(),
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId,
        eventType: "EXPENSE_POSTED",
        sourceType: "transactions",
        sourceId: transactionId as string,
        eventVersion: 1,
        idempotencyKey: `migrate_${transactionId}`,
        occurredAt: Date.now(),
        accountingDate: Date.now(),
        currency: "JOD",
        payload: {},
        status: "REVERSED",
        journalEntryId,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    const journalCountBefore = await t.run(async (ctx) =>
      (await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).length
    );

    const result = await asOwner.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId,
      dryRun: false,
    });

    const row = result.results.find((r: { transactionId: string }) => r.transactionId === transactionId.toString());
    expect(row).toMatchObject({ action: "SKIP", reason: "already_posted" });

    // The decisive assertion: no second posting of a row the books already
    // carry. A status-sensitive `existing` check would have re-posted here.
    const journalCountAfter = await t.run(async (ctx) =>
      (await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).length
    );
    expect(journalCountAfter).toBe(journalCountBefore);
  });
});

/**
 * Fails the build if a THIRD writer of the `transactions` table appears without
 * the guard.
 *
 * The two guarded paths are the only ones today, but sibling paths do not
 * inherit a fix — that is how this repository has shipped the same defect twice
 * before. Every other module only INSERTS into `transactions`, which is fine:
 * a brand-new row cannot already be represented in the GL.
 */
describe("no unguarded writer of an existing transactions row", () => {
  test("every patch of a transactions row is preceded by the GL guard", () => {
    const convexDir = path.join(process.cwd(), "convex");
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "_generated") walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          files.push(full);
        }
      }
    })(convexDir);

    // Sanity floor: if the walk ever matches nothing, this whole test passes
    // vacuously and stops protecting anything.
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      // Only `transactions.ts` may patch a transactions row, and only because
      // both of its writers call the guard (asserted by the tests above).
      if (path.basename(file) === "transactions.ts") continue;
      if (/\.db\.patch\(\s*(args\.)?transactionId/.test(source)) {
        offenders.push(path.relative(convexDir, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * No public door into the cashbook.
 *
 * A Convex `mutation` is a public API endpoint. Whether the shipped UI offers a
 * button is irrelevant — any authenticated client holding `manage:finance` can
 * call it. `transactions.add` was such a door: it wrote money into the
 * operational cashbook with no accounting event, no journal entry, no period
 * check and no audit record. Its removal is the point of this change, so it is
 * asserted rather than assumed.
 */
describe("no public door into the legacy cashbook", () => {
  test("convex/transactions.ts exposes no mutation that inserts a transactions row", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "convex", "transactions.ts"), "utf8");

    // Comments describe the removed mutation on purpose; strip them so the
    // explanation of the fix cannot be mistaken for the defect.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(code).not.toMatch(/\.db\.insert\(\s*["']transactions["']/);

    // And the module still exports the guarded writers, so this suite cannot
    // pass by the file having been emptied.
    expect(code).toMatch(/export const update = mutation\(/);
    expect(code).toMatch(/export const remove = mutation\(/);
  });

  test("the mutation is gone from the generated public API surface", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Door Dealer", createdAt: Date.now() })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "door_manager", email: "door@example.com", name: "Door" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

    // Referenced through `anyApi` so this stays a RUNTIME assertion about the
    // deployed function surface. A typed `api.transactions.add` reference would
    // fail to compile instead, which proves nothing about a client that was
    // built before the mutation was removed and still calls it by name.
    const asManager = t.withIdentity({ subject: "door_manager" });
    await expect(
      asManager.mutation(anyApi.transactions.add, {
        orgId,
        type: "IN",
        amount: 5_000,
        date: Date.now(),
        category: "CAPITAL_INJECTION",
        description: "Straight into the cashbook",
      })
    ).rejects.toThrow();
  });
});
