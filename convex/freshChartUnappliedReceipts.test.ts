/**
 * RC-FRESH-CHART-2110 — a fresh organization is born able to hold customer
 * money it has not yet applied.
 *
 * ## What changed, and why this file exists
 *
 * SCRUM-218-C DECLARED `UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY` and deliberately
 * did NOT seed it: the account row was a SCRUM-231 cutover artifact, and seeding
 * it from the default chart would have made every existing org's chart claim a
 * liability account nobody had classified.
 *
 * The launch architecture then moved to a NEW EMPTY production deployment. There
 * is no cutover step left to seed anything in, so 231's preserved requirement
 * became an Accounting-RC obligation by owner ruling: a fresh organization must
 * receive 2110 at BOOTSTRAP, before any economic activity.
 *
 * ## Where it is seeded, and where it is deliberately NOT
 *
 * `convex/utils/defaultChart.ts :: DEFAULT_CHART` — the single list
 * `chartOfAccounts.initialize` iterates, which is the one chart bootstrap a
 * newly created organization runs. That is the whole mechanism. In particular:
 *
 *   - NOT `ensureSystemAccount`, the code-keyed self-heal. Nothing added 2110 to
 *     any of its call sites, so no posting path can create the account on
 *     demand. SCRUM-218 forbids inventing or adopting 2110 for a received
 *     payment and that prohibition is untouched — §5 below proves it.
 *   - NOT `test-utils/legacyMigrationSeed.ts`. That fixture carries legacy
 *     NO-RESTATEMENT semantics and must stay separate — §8 below proves it.
 *
 * 2110 was also added to `REQUIRED_SYSTEM_KEYS`, but only after checking what
 * that list DOES: both consumers (`chartOfAccounts.validateSystemAccounts` and
 * `accountingSetup.status`) are read-only queries that append to a `missing`
 * array. Membership makes an org REPORT a missing account. It does not make one
 * appear.
 *
 * ## The 1220 half
 *
 * `UNAPPLIED_CUSTOMER_CASH` / 1220 was ASSET / DEBIT — the wrong side of the
 * balance sheet for money the dealership OWES back. It is no longer seeded. The
 * system KEY is kept so historical rows stay describable; what is removed is a
 * fresh org receiving the wrong-sided account at all.
 *
 * ## Evidence boundary
 *
 * `convex-test` only. This is repository behaviour — not the Convex runtime, and
 * not data parity with a real production chart.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { DEFAULT_CHART, REQUIRED_SYSTEM_KEYS, SYSTEM_KEYS } from "./utils/defaultChart";
import { postLegacyTransactionEvent } from "../test-utils/legacyMigrationSeed";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

type TestHarness = ReturnType<typeof convexTestWithComponents<typeof schema>>;

/**
 * A brand-new organization taken through the REAL chart bootstrap.
 *
 * `chartOfAccounts.initialize` is driven as the registered mutation rather than
 * by inserting chart rows directly: the claim under test is what a fresh org
 * RECEIVES, and hand-inserting the accounts would prove only that this file can
 * write the rows it then asserts.
 */
async function freshOrg(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Fresh ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `fc_${suffix}`, email: `${suffix}@fc.com`, name: "Owner" })
  )) as Id<"users">;
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "OWNER", isSystemOwnerRole: true,
      permissions: ["view:finance", "manage:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "USD", currencySymbol: "$",
      enabledPaymentTypes: ["CASH", "CHEQUE", "BANK_TRANSFER"],
    })
  );
  const asAdmin = t.withIdentity({ subject: `fc_${suffix}`, clerkId: `fc_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });

  // An OPEN period, so a receipt that reaches the engine can actually post.
  // Without it every case below would be held for the wrong reason and §6's
  // "held because 2110 is missing" would prove nothing.
  const year = new Date().getUTCFullYear();
  await asAdmin.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
  await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = (await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: suffix, createdAt: Date.now() })
  )) as Id<"customers">;

  return { t, asAdmin, orgId, userId, customerId };
}

async function accountBySystemKey(
  t: TestHarness,
  orgId: Id<"organizations">,
  systemKey: string
): Promise<Doc<"chartOfAccounts"> | null> {
  return await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
      .unique()
  );
}

async function accountByCode(t: TestHarness, orgId: Id<"organizations">, code: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_code", (q) => q.eq("orgId", orgId).eq("code", code))
      .unique()
  );
}

/** Far above anything one test org can write; see the assertion at its use. */
const SNAPSHOT_SCAN_BOUND = 500;

/** Every GL artifact one posting attempt can produce, counted in one value. */
async function glFootprint(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    // Written out per table rather than through a generic helper: the index
    // callback's field type is resolved per table, so a generic loses `orgId`.
    const [events, entries, lines, allSnapshots] = await Promise.all([
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
      ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
      // `accountBalanceSnapshots` has no `by_org` index — its indexes are
      // account/period shaped, so there is none to narrow on here. Bounded with
      // `.take` rather than left unbounded, and the bound is asserted below so a
      // silently truncated read can never read as "no snapshots were written".
      ctx.db.query("accountBalanceSnapshots").take(SNAPSHOT_SCAN_BOUND),
    ]);
    if (allSnapshots.length === SNAPSHOT_SCAN_BOUND) {
      throw new Error(
        `glFootprint hit its ${SNAPSHOT_SCAN_BOUND}-row snapshot bound, so the count below ` +
          "would be a truncation rather than a measurement."
      );
    }
    const snapshots = allSnapshots.filter((s) => s.orgId === orgId);
    return {
      events: events.length,
      entries: entries.length,
      lines: lines.length,
      snapshots: snapshots.length,
    };
  });
}

/**
 * Every journal line this org wrote, resolved to the SYSTEM KEY of the account
 * it hit.
 *
 * ⚠️ `journalLines` carries `accountId`, not `systemKey`. Filtering lines on a
 * `systemKey` field would silently match nothing and read as "2110 was never
 * touched" — a false negative in exactly the direction these tests care about —
 * so the account is resolved rather than assumed.
 */
async function linesWithSystemKey(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const out: Array<{
      systemKey: string | undefined;
      accountId: Id<"chartOfAccounts">;
      debitMinor: number;
      creditMinor: number;
    }> = [];
    for (const line of lines) {
      const account = await ctx.db.get(line.accountId);
      out.push({
        systemKey: account?.systemKey,
        accountId: line.accountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
      });
    }
    return out;
  });
}

async function removeRetainedCreditAccount(t: TestHarness, orgId: Id<"organizations">) {
  const row = await accountBySystemKey(t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY);
  if (!row) throw new Error("nothing to remove — 2110 is not being seeded at bootstrap");
  await t.run((ctx) => ctx.db.delete(row._id));
}

/* ══════════════════════════════════════════════════════════════════════════
 * §1 / §2 / §3 — what a fresh organization receives
 * ══════════════════════════════════════════════════════════════════════════ */

describe("RC-FRESH-CHART-2110 §1 — a fresh org receives 2110 at bootstrap", () => {
  test("the account exists before any economic activity", async () => {
    const { t, orgId } = await freshOrg("f1");

    // Nothing economic has happened yet, asserted rather than assumed — the
    // claim is that BOOTSTRAP produced it, not that some posting path did.
    expect(await glFootprint(t, orgId)).toEqual({
      events: 0, entries: 0, lines: 0, snapshots: 0,
    });

    const account = await accountBySystemKey(
      t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    );
    expect(account).not.toBeNull();
    expect(account!.active).toBe(true);
  });

  test("exactly ONE account carries the key, and it is reachable by code 2110", async () => {
    // `resolveSystemAccount` reads with `.unique()`, so a duplicate would throw
    // at posting time rather than being tolerated. One row is part of the
    // contract, not an incidental detail.
    const { t, orgId } = await freshOrg("f1b");
    const byKey = await accountBySystemKey(
      t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    );
    const byCode = await accountByCode(t, orgId, "2110");
    expect(byKey).not.toBeNull();
    expect(byCode).not.toBeNull();
    expect(byCode!._id).toBe(byKey!._id);
  });
});

describe("RC-FRESH-CHART-2110 §2 — the exact classification, field by field", () => {
  test("2110 is LIABILITY / CREDIT, a control account, and manual posting is refused", async () => {
    const { t, orgId } = await freshOrg("f2");
    const account = await accountBySystemKey(
      t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    );

    // Asserted one field at a time rather than with a shape match, so a failure
    // names the field that drifted. Every one of these is load-bearing:
    // LIABILITY/CREDIT is the side of the balance sheet, isControlAccount says
    // the receipt subledger is its detail, and allowManualPosting: false keeps a
    // journal-entry author out of it.
    expect(account!.code).toBe("2110");
    expect(account!.systemKey).toBe("UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY");
    expect(account!.type).toBe("LIABILITY");
    expect(account!.normalBalance).toBe("CREDIT");
    expect(account!.isControlAccount).toBe(true);
    expect(account!.allowManualPosting).toBe(false);
  });

  test("the DEFINITION itself carries those properties, so a fresh org cannot get another shape", async () => {
    // The org-level assertion above proves what one bootstrap produced. This
    // pins the source it produced it from, so a future edit to the definition
    // fails here with the field named rather than somewhere downstream.
    const def = DEFAULT_CHART.find(
      (d) => d.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    );
    expect(def).toBeDefined();
    expect(def!.code).toBe("2110");
    expect(def!.type).toBe("LIABILITY");
    expect(def!.normalBalance).toBe("CREDIT");
    expect(def!.isControlAccount).toBe(true);
    expect(def!.allowManualPosting).toBe(false);

    // Exactly one definition claims the key and exactly one claims the code.
    expect(
      DEFAULT_CHART.filter(
        (d) => d.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
      )
    ).toHaveLength(1);
    expect(DEFAULT_CHART.filter((d) => d.code === "2110")).toHaveLength(1);

    // And Accounting -> Setup reports it when it is missing.
    expect(REQUIRED_SYSTEM_KEYS).toContain(SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY);
  });
});

describe("RC-FRESH-CHART-2110 §3 — the old 1220 model is NOT the unapplied-receipt authority", () => {
  test("a fresh org receives no 1220 unapplied-cash asset at all", async () => {
    const { t, orgId } = await freshOrg("f3");
    expect(await accountBySystemKey(t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_CASH)).toBeNull();
    expect(await accountByCode(t, orgId, "1220")).toBeNull();
  });

  test("no default definition seeds the wrong-sided model under any name", async () => {
    // Both halves, because either alone could be reintroduced: the CODE and the
    // KEY. Without this, restoring 1220 to DEFAULT_CHART would turn nothing red.
    expect(DEFAULT_CHART.some((d) => d.code === "1220")).toBe(false);
    expect(
      DEFAULT_CHART.some((d) => d.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_CASH)
    ).toBe(false);

    // ⚠️ And the ASSET/DEBIT shape must not reappear on the retained-credit key
    // either — the substitution this whole classification exists to prevent.
    const retained = DEFAULT_CHART.find(
      (d) => d.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    )!;
    expect(retained.type).not.toBe("ASSET");
    expect(retained.normalBalance).not.toBe("DEBIT");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * §4 / §5 / §7 — what posting does with it
 * ══════════════════════════════════════════════════════════════════════════ */

describe("RC-FRESH-CHART-2110 §4 — a receipt with a residue resolves the seeded account", () => {
  test("an unapplied receipt credits the 2110 that bootstrap created", async () => {
    const { t, asAdmin, orgId, customerId } = await freshOrg("f4");
    const seeded = await accountBySystemKey(
      t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    );

    // No receivable, so the whole receipt is residue.
    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, customerId, amount: 60, method: "CASH", paymentDate: Date.now(),
    });

    const lines = await linesWithSystemKey(t, orgId);
    const retained = lines.filter(
      (l) => l.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
    );
    expect(retained).toHaveLength(1);
    expect(retained[0].creditMinor).toBe(60_00);

    // ⚠️ It resolved the ROW bootstrap created, not one it minted for itself.
    // Comparing the account id is the assertion; a systemKey match alone would
    // be satisfied by a second row created on demand.
    expect(retained[0].accountId).toBe(seeded!._id);
  });
});

describe("RC-FRESH-CHART-2110 §5 — posting never creates, adopts or reclassifies 2110", () => {
  test("no chart row is created, and none is reclassified, by posting a residual receipt", async () => {
    const { t, asAdmin, orgId, customerId } = await freshOrg("f5");
    const before = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );

    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, customerId, amount: 35, method: "CASH", paymentDate: Date.now(),
    });

    const after = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );

    // The whole chart, compared as a set of (id, code, key, type, balance)
    // tuples: creation shows up as a length change, reclassification as a tuple
    // change. Asserting only the count would miss the second one entirely.
    const shape = (rows: Doc<"chartOfAccounts">[]) =>
      rows
        .map((r) => `${r._id}|${r.code}|${r.systemKey ?? ""}|${r.type}|${r.normalBalance}|${r.active}`)
        .sort();
    expect(shape(after)).toEqual(shape(before));
  });

  test("a chart with NO 2110 does not grow one when a residual receipt arrives", async () => {
    // The adoption case stated directly. If any posting path self-healed the
    // account the way GENERAL_EXPENSE does, this is where it would show.
    const { t, asAdmin, orgId, customerId } = await freshOrg("f5b");
    await removeRetainedCreditAccount(t, orgId);

    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, customerId, amount: 35, method: "CASH", paymentDate: Date.now(),
    });

    expect(
      await accountBySystemKey(t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)
    ).toBeNull();
    expect(await accountByCode(t, orgId, "2110")).toBeNull();
    // Nor did it fall back to the wrong-sided model by creating THAT.
    expect(await accountBySystemKey(t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_CASH)).toBeNull();
  });
});

describe("RC-FRESH-CHART-2110 §7 — a zero-residue receipt does not depend on 2110", () => {
  test("a receipt that fully discharges a receivable posts with 2110 absent", async () => {
    const { t, asAdmin, orgId, customerId } = await freshOrg("f7");
    await removeRetainedCreditAccount(t, orgId);

    const receivableId = (await asAdmin.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      sourceType: "OTHER",
      // `OTHER` is deliberately ambiguous in `resolveReceivableCreditKey`, so
      // the credit account is stated rather than defaulted to income.
      creditSystemKey: "MISCELLANEOUS_INCOME",
      title: "Exact debt",
      amount: 100,
      dueDate: Date.now() + 86_400_000,
    })) as Id<"receivables">;

    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, customerId, amount: 100, method: "CASH", paymentDate: Date.now(),
      receivableId,
    });

    // It posted — the absence of 2110 did not hold hostage a receipt that never
    // needed it.
    const footprint = await glFootprint(t, orgId);
    expect(footprint.lines).toBeGreaterThan(0);

    // ...and it touched 2110 not at all, which is the other half: "it posted" is
    // compatible with having silently booked the residue somewhere.
    const lines = await linesWithSystemKey(t, orgId);
    expect(
      lines.some((l) => l.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)
    ).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * §6 — 2110 missing at receipt time still fails SAFELY
 * ══════════════════════════════════════════════════════════════════════════ */

describe("RC-FRESH-CHART-2110 §6 — a missing 2110 fails closed through SCRUM-222", () => {
  test("receipt and durable outbox survive, with zero partial GL delta", async () => {
    const { t, asAdmin, orgId, customerId } = await freshOrg("f6");
    await removeRetainedCreditAccount(t, orgId);

    const emptyBooks = await glFootprint(t, orgId);
    expect(emptyBooks).toEqual({ events: 0, entries: 0, lines: 0, snapshots: 0 });

    const paymentId = (await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, customerId, amount: 45, method: "CASH", paymentDate: Date.now(),
    })) as Id<"collectionPayments">;

    // 1. THE RECEIPT SURVIVES. The customer's money is recorded even though the
    //    books could not take it — losing the receipt would be far worse than
    //    failing to post it.
    const payment = await t.run((ctx) => ctx.db.get(paymentId));
    expect(payment).not.toBeNull();

    // 2. THE MOVEMENT SURVIVES — what the receipt WAS is sealed regardless.
    const movements = await t.run((ctx) =>
      ctx.db.query("receiptMovements").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(movements).toHaveLength(1);

    // 3. ZERO PARTIAL GL DELTA. Not "no journal entry" — NOTHING: no event, no
    //    entry, no line, no balance snapshot. A partial write here is the defect
    //    class SCRUM-222 exists for, and a caught exception in Convex COMMITS
    //    everything written before it.
    expect(await glFootprint(t, orgId)).toEqual(emptyBooks);

    // 4. SCRUM-222 BOOKKEEPING OWNS THE FAILURE. The obligation is durable and
    //    still owed, with a reason naming the account, rather than dropped.
    const pending = await t.run((ctx) =>
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId))
        .collect()
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("PENDING");
    expect(pending[0].reason).toContain("UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY");
  });

  test("POSITIVE CONTROL — the identical receipt posts once 2110 is present", async () => {
    // Without this the test above cannot distinguish "held for the right reason"
    // from "this receipt never posts under any chart".
    const { t, asAdmin, orgId, customerId } = await freshOrg("f6ctl");
    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, customerId, amount: 45, method: "CASH", paymentDate: Date.now(),
    });

    const footprint = await glFootprint(t, orgId);
    expect(footprint.lines).toBeGreaterThan(0);
    const pending = await t.run((ctx) =>
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId))
        .collect()
    );
    expect(pending.filter((p) => p.status === "PENDING")).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * §8 — the legacy seed keeps its own, separate semantics
 * ══════════════════════════════════════════════════════════════════════════ */

describe("RC-FRESH-CHART-2110 §8 — legacy no-restatement semantics stay separate", () => {
  test("the legacy seed posts through its own family and never touches 2110", async () => {
    // The requirement is that seeding 2110 into the default chart did NOT leak
    // into the legacy fixture. A legacy EXPENSE row still posts under the
    // `transactions` provenance and books nothing against the new liability.
    const { t, orgId, userId } = await freshOrg("f8");
    expect(
      await accountBySystemKey(t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)
    ).not.toBeNull();

    const transactionId = (await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "OUT", amount: 100, date: Date.now(),
        category: "EXPENSE", description: "Legacy expense",
      })
    )) as Id<"transactions">;
    await t.run((ctx) => postLegacyTransactionEvent(ctx, { orgId, transactionId, actorId: userId }));

    const events = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(events).toHaveLength(1);
    expect(events[0].sourceType).toBe("transactions");

    const lines = await linesWithSystemKey(t, orgId);
    expect(lines.length).toBeGreaterThan(0);
    expect(
      lines.some((l) => l.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)
    ).toBe(false);
  });

  test("the legacy seed still refuses the reserved receipt tuple outright", async () => {
    // SCRUM-249's boundary, re-asserted here because THIS ticket is the one that
    // made 2110 available everywhere and could plausibly have been read as
    // permission to reopen legacy receipt seeding. It was not.
    const { t, orgId, userId } = await freshOrg("f8b");
    const transactionId = (await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "IN", amount: 42, date: Date.now(),
        category: "COLLECTION_PAYMENT", description: "Legacy collection",
      })
    )) as Id<"transactions">;

    await expect(
      t.run((ctx) => postLegacyTransactionEvent(ctx, { orgId, transactionId, actorId: userId }))
    ).rejects.toThrow(/can no longer seed category "COLLECTION_PAYMENT"/);
  });
});

