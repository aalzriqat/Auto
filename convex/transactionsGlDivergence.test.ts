/**
 * SCRUM-53 — the legacy cashbook must not be a second set of books.
 *
 * `transactions` is the operational CASHBOOK. The authoritative books are
 * `journalEntries` + `journalLines`. Rows are written as a side effect of the
 * domain event that caused them; nothing may create, edit or delete one through
 * the public API, because none of those writes reaches the GL.
 *
 * An earlier revision of this change tried to allow edits and refuse only the
 * rows the GL already represented, by looking for an `accountingEvents` row
 * keyed `sourceType: "transactions"`. That key has exactly one producer —
 * `migrateUnpostedTransactions`, backfilling legacy rows. Every real-time
 * workflow posts against the DOMAIN entity instead ("vehicles", "sales",
 * "expenses", "deposits", "collectionPayments"), so the guard could not see the
 * postings that matter, and a production audit found 113 cashbook rows and ZERO
 * events keyed to "transactions" — it protected nothing that existed.
 *
 * These tests assert the REFUSAL and the absence of the doors, not the shape of
 * any particular guard.
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

  return { t, orgId, userId, asManager, transactionId };
}

describe("no public write door into the legacy cashbook", () => {
  test("convex/transactions.ts declares no mutation at all", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "convex", "transactions.ts"), "utf8");

    // The file explains the removed mutations at length on purpose. Strip
    // comments so the explanation of the fix cannot be mistaken for the defect.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code).not.toMatch(/\bmutation\s*\(/);
    expect(code).not.toMatch(/\.db\.(insert|patch|replace)\(/);

    // …and the module is still the cashbook reader, so this cannot pass by the
    // file having been emptied or renamed.
    expect(code).toMatch(/export const list = query\(/);
  });

  test.each(["add", "update", "remove"])(
    "transactions.%s is gone from the generated public API surface",
    async (name) => {
      const { orgId, asManager, transactionId } = await setupOrgWithCashbookRow();

      // Referenced through `anyApi` so this stays a RUNTIME assertion about the
      // deployed function surface. A typed `api.transactions.add` reference
      // would fail to COMPILE instead, which proves nothing about a client that
      // was built before the mutation was removed and still calls it by name —
      // an already-installed mobile build is exactly that client.
      //
      // Asserted on "no such export" specifically, not on any rejection at all.
      // These payloads are a superset of each mutation's arguments, so a plain
      // `.rejects.toThrow()` would also be satisfied by an ARGUMENT VALIDATOR
      // error from a mutation that still exists — the test would pass while the
      // door stood open. That is exactly how it first passed for `remove`.
      await expect(
        asManager.mutation(anyApi.transactions[name], {
          orgId,
          transactionId,
          type: "IN",
          amount: 5_000,
          date: Date.now(),
          category: "CAPITAL_INJECTION",
          description: "Straight into the cashbook",
        })
      ).rejects.toThrow(/no such export/i);
    }
  );

  test("a refused call leaves the cashbook exactly as it was", async () => {
    // A door that throws AFTER writing would satisfy the assertions above.
    const { t, orgId, asManager, transactionId } = await setupOrgWithCashbookRow();

    for (const name of ["update", "remove"]) {
      await expect(
        asManager.mutation(anyApi.transactions[name], { orgId, transactionId, amount: 9_999 })
      ).rejects.toThrow();
    }

    const row = await t.run((ctx) => ctx.db.get(transactionId));
    expect(row?.amount).toBe(1_500);
    expect(row?.isDeleted).not.toBe(true);

    const rowCount = await t.run(async (ctx) =>
      (await ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).length
    );
    expect(rowCount).toBe(1);
  });
});

/**
 * The case a `sourceType: "transactions"` guard could never see.
 *
 * `vehicles.ts` inserts the VEHICLE_PURCHASE cashbook row and then calls
 * `hookVehicleAcquired`, which posts the GL event against the VEHICLE. Both
 * halves describe the same money. A guard querying `by_org_source` for
 * `sourceType: "transactions"` finds nothing here and would allow the edit —
 * which is why the doors are gone instead of guarded.
 */
describe("a cashbook row whose money the GL already carries", () => {
  test("cannot be edited or deleted through the API, even though the GL posting is sourced from the vehicle", async () => {
    const { t, orgId, userId, asManager } = await setupOrgWithCashbookRow();

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "CASHBOOKGL0001",
        make: "Kia",
        model: "Sportage",
        year: 2023,
        mileage: 12_000,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 21_000,
        status: "AVAILABLE",
      })
    );

    // Exactly the pair `vehicles.ts` writes on acquisition.
    const purchaseRowId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "OUT",
        amount: 18_000,
        date: Date.now(),
        category: "VEHICLE_PURCHASE",
        description: "Purchase of vehicle 2023 Kia Sportage",
        vehicleId,
      })
    );
    const journalEntryId = await t.run((ctx) =>
      ctx.db.insert("journalEntries", {
        orgId,
        journalNumber: "JE-ACQ-1",
        accountingDate: Date.now(),
        sourceType: "vehicles",
        sourceId: vehicleId as string,
        category: "SYSTEM",
        memo: "Vehicle acquired",
        currency: "JOD",
        status: "POSTED",
        postedBy: userId,
        postedAt: Date.now(),
        createdAt: Date.now(),
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId,
        eventType: "VEHICLE_ACQUIRED",
        sourceType: "vehicles",
        sourceId: vehicleId as string,
        eventVersion: 1,
        idempotencyKey: `vehicle_acquired_${vehicleId}`,
        occurredAt: Date.now(),
        accountingDate: Date.now(),
        currency: "JOD",
        payload: {},
        status: "POSTED",
        journalEntryId,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    await expect(
      asManager.mutation(anyApi.transactions.update, {
        orgId,
        transactionId: purchaseRowId,
        amount: 999,
      })
    ).rejects.toThrow();

    await expect(
      asManager.mutation(anyApi.transactions.remove, { orgId, transactionId: purchaseRowId })
    ).rejects.toThrow();

    // The decisive assertion: capitalized inventory cost in the GL and the cash
    // side in the cashbook still agree. An edit here would have moved one and
    // left the balance sheet, COGS and every later margin on the original.
    const row = await t.run((ctx) => ctx.db.get(purchaseRowId));
    expect(row?.amount).toBe(18_000);
    expect(row?.isDeleted).not.toBe(true);
  });
});

/**
 * The replay question, asked of the real migration rather than of a guard.
 *
 * A row whose GL posting was reversed is the one case where "is this on the
 * books?" has a genuinely ambiguous answer. The danger is what a later replay
 * concludes: if `migrateUnpostedTransactions` decided "no live posting,
 * therefore unposted money", it would post the row a SECOND time.
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

    const row = result.results.find(
      (r: { transactionId: string }) => r.transactionId === transactionId.toString()
    );
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
 * Which modules may mutate an EXISTING cashbook row.
 *
 * The previous version of this test claimed `transactions.ts` held "the only two
 * writers". That was false — it matched only `.db.patch(transactionId` by
 * variable name and therefore missed `saleCancellation.ts`, which patches
 * `row._id` inside a loop, and `migrateConsignedSaleBasis.ts`, which patches
 * `tx._id` after `const tx = candidates[0]`. A test that asserts a false
 * inventory is worse than no test: it tells the next engineer the invariant is
 * covered.
 *
 * So the detector follows simple bindings out of a `transactions` query instead
 * of matching a name, and the inventory below is explicit and reviewed. A new
 * entry is not a build error to be silenced — it is a module that can move a
 * number the general ledger also carries, and it needs the same argument the two
 * below have.
 */
describe("every module that mutates an existing cashbook row is a reviewed one", () => {
  /**
   * Modules allowed to patch a `transactions` row, each with its reason.
   *
   * Every one of them is a DOMAIN module maintaining the cashbook row it
   * created, inside the same workflow that moves the underlying record — which
   * is the model SCRUM-53 endorses. The cashbook row is a side effect of the
   * domain event, so the domain owns it. That is categorically different from a
   * general-purpose "edit any cashbook row" endpoint, which is what was removed.
   */
  const REVIEWED_WRITERS: Record<string, string> = {
    // Soft-deletes the VEHICLE_SALE rows when a completed sale is cancelled.
    // Correct: it runs inside the cancellation that ALSO reverses the sale's GL
    // posting, so the cashbook and the books move together rather than apart.
    "utils/saleCancellation.ts": "runs inside the cancellation that also reverses the GL posting",
    // Sets `recognizedRevenueAmount` on a consigned sale's row so the P&L stops
    // counting the gross as revenue. Restates the REPORTING BASIS of a row whose
    // cash amount it deliberately refuses to touch, and bails out when the row
    // has already been changed.
    "migrateConsignedSaleBasis.ts": "restates reporting basis only, and refuses rows whose amount already moved",
    // Mirrors an expense edit onto the cashbook row the expense created
    // (amount/date), and soft-deletes it with the expense. The expense workflow
    // owns its own GL posting and reversal, so both sides move together.
    "expenses.ts": "mirrors the expense's own edit/delete onto the row it created, alongside its GL handling",
    // Patches the original deposit IN row when a deposit is voided or refunded,
    // in the same mutation that voids the mirrored payment.
    "deposits.ts": "adjusts the deposit's own cashbook row inside the void/refund workflow",
  };

  function transactionRowWriters(): string[] {
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

    // Sanity floor: if the walk ever matches nothing this whole suite passes
    // vacuously and stops protecting anything.
    expect(files.length).toBeGreaterThan(20);

    const writers: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      if (!/query\(\s*["']transactions["']\s*\)/.test(source)) continue;

      // Identifiers holding rows that came out of a `transactions` query, plus
      // anything derived from them by one simple hop — a for-of, an index, an
      // array callback parameter. That is how both real writers reach `_id`.
      const tainted = new Set<string>();
      const seed = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[\s\S]{0,400}?query\(\s*["']transactions["']\s*\)/g;
      for (const m of source.matchAll(seed)) tainted.add(m[1]);

      for (let pass = 0; pass < 5; pass++) {
        const before = tainted.size;
        for (const name of [...tainted]) {
          const derived = [
            new RegExp(`for\\s*\\(\\s*const\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${name}\\b`, "g"),
            new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${name}\\s*\\[`, "g"),
            new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${name}\\b[^;]*`, "g"),
            new RegExp(`${name}\\s*\\.\\s*(?:map|filter|find|forEach|flatMap)\\s*\\(\\s*\\(?\\s*([A-Za-z_$][\\w$]*)`, "g"),
          ];
          for (const re of derived) {
            for (const m of source.matchAll(re)) tainted.add(m[1]);
          }
        }
        if (tainted.size === before) break;
      }

      for (const name of tainted) {
        const patches = new RegExp(`\\.db\\.(?:patch|replace)\\(\\s*${name}\\b`);
        if (patches.test(source)) {
          writers.push(path.relative(convexDir, file).split(path.sep).join("/"));
          break;
        }
      }
    }
    return writers.sort();
  }

  test("the detector actually finds the writers it is meant to find", () => {
    // Positive control. Without this the test below passes just as happily when
    // the detector is broken and returns nothing — which is exactly how the
    // previous version shipped a false claim.
    const writers = transactionRowWriters();
    expect(writers).toContain("utils/saleCancellation.ts");
    expect(writers).toContain("migrateConsignedSaleBasis.ts");
    expect(writers).toContain("expenses.ts");
    expect(writers).toContain("deposits.ts");
  });

  test("no module outside the reviewed inventory patches a cashbook row", () => {
    const writers = transactionRowWriters();
    const unreviewed = writers.filter((file) => !(file in REVIEWED_WRITERS));
    expect(unreviewed).toEqual([]);
  });

  test("transactions.ts is not among them", () => {
    expect(transactionRowWriters()).not.toContain("transactions.ts");
  });
});
