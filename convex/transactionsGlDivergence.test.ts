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
import { ALL_PERMISSIONS } from "./utils/permissions";
import type { Id } from "./_generated/dataModel";

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

  const transactionId = (await asManager.mutation(api.transactions.add, {
    orgId,
    type: "IN",
    amount: 1_500,
    category: "OTHER",
    description: "Counter cash",
    date: Date.now(),
    idempotencyKey: "cashbook-1",
  })) as Id<"transactions">;

  /** Mirrors what `migrateUnpostedTransactions` records when it posts the row. */
  async function representInGl(status: "POSTED" | "PENDING" | "REVERSED") {
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

  test("a REVERSED migration event does not block — the GL no longer represents the row", async () => {
    const { orgId, asManager, transactionId, representInGl } = await setupOrgWithCashbookRow();
    await representInGl("REVERSED");

    await asManager.mutation(api.transactions.remove, { orgId, transactionId });
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
