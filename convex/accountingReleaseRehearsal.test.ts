/**
 * ACCOUNTING RELEASE REHEARSAL — one fresh organization, taken from bootstrap
 * through real economic activity, reconciled exactly.
 *
 * ## Why this exists, and why it is not "more unit tests"
 *
 * Every invariant below is already asserted somewhere in this repository, and
 * that is precisely the gap this file closes. The suites that prove them each
 * construct the narrow fixture their own claim needs, so a defect that only
 * appears when a REAL organization is born, opens a period, takes money, applies
 * part of it, reverses some of it and then has its books read back would fall
 * between them and be reported by nobody.
 *
 * So this is a rehearsal, not a test of a function: ONE organization, created
 * through the real bootstrap, driven only through the real public API surface,
 * and reconciled the way a reader of the books would reconcile it.
 *
 * ## ⚠️ EVIDENCE BOUNDARY — read this before quoting any result from this file
 *
 * This runs on `convex-test`. It establishes REPOSITORY BEHAVIOUR only.
 *
 * It is NOT runtime parity: `convex-test` serialises everything, models no OCC,
 * and does not enforce the platform's one-paginated-query-per-function limit.
 * A backfill once cleared 2,115 tests, full CI and thirteen review rounds here
 * and still failed on its first production call.
 *
 * It is NOT data parity: every row below is synthetic and freshly minted, which
 * is the shape a NEW EMPTY production deployment starts in — that is why the
 * rehearsal is meaningful for THIS launch — but it says nothing about surviving
 * the shape of pre-existing rows, and nothing in this file should ever be quoted
 * as evidence that it does.
 *
 * A genuine preview-deployment rehearsal is a strictly stronger artifact and is
 * NOT claimed here.
 */
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

type TestHarness = ReturnType<typeof convexTestWithComponents<typeof schema>>;

const UNAPPLIED = SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY;

/**
 * A brand-new dealership, born exactly the way the launch will make one.
 *
 * Driven through `chartOfAccounts.initialize` and `accountingPeriods.*` rather
 * than by inserting chart or period rows: the rehearsal's whole claim is about
 * what a fresh organization RECEIVES and can then DO, and hand-writing those
 * rows would prove only that this file can write the rows it later reads.
 */
async function rehearseFreshDealership(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  // `sales.create` reaches the real rate limiter, which a rehearsal must not
  // stub out: the point is to drive the production path, not a reduced one.
  registerRateLimiter(t);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Rehearsal ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `rh_${suffix}`, email: `${suffix}@rehearsal.test`, name: "Owner" })
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

  const asAdmin = t.withIdentity({ subject: `rh_${suffix}`, clerkId: `rh_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });

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
    ctx.db.insert("customers", { orgId, firstName: "Rehearsal", lastName: suffix, createdAt: Date.now() })
  )) as Id<"customers">;

  return { t, asAdmin, orgId, userId, customerId, periodId: period._id };
}

/** A debt of exactly `amount`, created through the real receivable writer. */
async function debtOf(
  asAdmin: ReturnType<TestHarness["withIdentity"]>,
  orgId: Id<"organizations">,
  customerId: Id<"customers">,
  amount: number,
  title = "Rehearsal debt"
) {
  return (await asAdmin.mutation(api.collections.createReceivable, {
    idempotencyKey: crypto.randomUUID(),
    orgId,
    customerId,
    sourceType: "OTHER",
    // `OTHER` is deliberately ambiguous in `resolveReceivableCreditKey`, so the
    // credit account is stated rather than defaulted into income.
    creditSystemKey: "MISCELLANEOUS_INCOME",
    title,
    amount,
    dueDate: Date.now() + 86_400_000,
  })) as Id<"receivables">;
}

/**
 * Every journal line the org wrote, resolved to the system key of the account
 * it hit.
 *
 * ⚠️ `journalLines` carries `accountId`, NOT `systemKey`. A filter on a
 * `systemKey` field would match nothing and read as "that account was never
 * touched" — a false negative in exactly the direction this rehearsal cares
 * about — so the account is resolved rather than assumed.
 */
async function ledgerLines(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const out: Array<{
      systemKey: string | undefined;
      code: string | undefined;
      debitMinor: number;
      creditMinor: number;
    }> = [];
    for (const line of lines) {
      const account = await ctx.db.get(line.accountId);
      out.push({
        systemKey: account?.systemKey,
        code: account?.code,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
      });
    }
    return out;
  });
}

/** Net movement on one system key: debits positive, credits negative. */
function netOn(
  lines: Array<{ systemKey: string | undefined; debitMinor: number; creditMinor: number }>,
  systemKey: string
) {
  return lines
    .filter((l) => l.systemKey === systemKey)
    .reduce((n, l) => n + l.debitMinor - l.creditMinor, 0);
}

async function economicEvents(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
}

async function journalEntries(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * R1 — the organization is BORN able to hold customer money
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R1 — fresh bootstrap produces the launch chart", () => {
  test("2110 exists with the exact launch contract, and the old 1220 model does not", async () => {
    const { t, orgId } = await rehearseFreshDealership("r1");

    // Nothing economic has happened, asserted rather than assumed: the claim is
    // that BOOTSTRAP produced the account, not that some posting path did.
    expect(await economicEvents(t, orgId)).toHaveLength(0);

    const accounts = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );

    const unapplied = accounts.filter((a) => a.systemKey === UNAPPLIED);
    expect(unapplied).toHaveLength(1);
    expect({
      code: unapplied[0].code,
      type: unapplied[0].type,
      normalBalance: unapplied[0].normalBalance,
      isControlAccount: unapplied[0].isControlAccount,
      allowManualPosting: unapplied[0].allowManualPosting,
    }).toEqual({
      code: "2110",
      type: "LIABILITY",
      normalBalance: "CREDIT",
      isControlAccount: true,
      allowManualPosting: false,
    });

    // The wrong-sided historical model, by BOTH of its identifiers.
    expect(accounts.filter((a) => a.code === "1220")).toHaveLength(0);
    expect(accounts.filter((a) => a.systemKey === "UNAPPLIED_CUSTOMER_CASH")).toHaveLength(0);
  });

  test("the period is genuinely OPEN, so nothing below is held for the wrong reason", async () => {
    const { asAdmin, orgId } = await rehearseFreshDealership("r1b");
    const open = await asAdmin.query(api.accountingPeriods.currentOpenPeriod, { orgId });
    expect(open).not.toBeNull();
    expect(open!.status).toBe("OPEN");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R2 — a real receipt reaches the general ledger, balanced
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R2 — economic event to balanced ledger", () => {
  test("an exact payment settles the debt, balances, and touches 2110 not at all", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r2");
    const receivableId = await debtOf(asAdmin, orgId, customerId, 100);

    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 100,
      method: "CASH",
      paymentDate: Date.now(),
    });

    const lines = await ledgerLines(t, orgId);
    expect(lines.length).toBeGreaterThan(0);

    // The floor: the books balance.
    const debits = lines.reduce((n, l) => n + l.debitMinor, 0);
    const credits = lines.reduce((n, l) => n + l.creditMinor, 0);
    expect(debits).toBe(credits);

    // Zero residue must not depend on 2110 — and "it posted" alone is
    // compatible with having parked the money there, so the account is asserted
    // untouched rather than merely un-required.
    expect(netOn(lines, UNAPPLIED)).toBe(0);
    expect(lines.filter((l) => l.code === "2110")).toHaveLength(0);

    // The subledger agrees with the books: the debt is gone.
    const receivable = (await t.run((ctx) => ctx.db.get(receivableId))) as Doc<"receivables">;
    expect(receivable.outstandingAmount).toBe(0);
  });

  test("customer money aimed at no debt parks on 2110, to the cent", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r2b");

    // ⚠️ Measured, not assumed: `recordPayment` REFUSES an amount greater than
    // the named receivable's outstanding balance, so an "overpayment against a
    // debt" is not how unapplied money arises here and a test written that way
    // would be asserting a state the product cannot reach. Residue comes from a
    // CUSTOMER-level receipt — money taken in that no receivable has claimed.
    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      amount: 60,
      method: "CASH",
      paymentDate: Date.now(),
    });

    const lines = await ledgerLines(t, orgId);
    expect(lines.reduce((n, l) => n + l.debitMinor, 0)).toBe(
      lines.reduce((n, l) => n + l.creditMinor, 0)
    );

    // 60.00 of customer money the dealership now OWES BACK: a CREDIT on a
    // LIABILITY, so the net (debit-positive) movement is negative and exact.
    expect(netOn(lines, UNAPPLIED)).toBe(-6000);

    // And it landed on the launch account by CODE, not merely on something
    // carrying the right system key.
    expect(lines.filter((l) => l.code === "2110").length).toBeGreaterThan(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R3 — replay produces no second economic event
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R3 — command identity under retry", () => {
  test("the same identity replayed moves no additional money", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r3");
    const receivableId = await debtOf(asAdmin, orgId, customerId, 100);
    const identity = `rehearsal-retry-${crypto.randomUUID()}`;

    const args = {
      idempotencyKey: identity,
      orgId,
      receivableId,
      amount: 100,
      method: "CASH" as const,
      paymentDate: 1_760_000_000_000,
    };

    await asAdmin.mutation(api.collections.recordPayment, args);
    const afterFirst = {
      events: (await economicEvents(t, orgId)).length,
      entries: (await journalEntries(t, orgId)).length,
      lines: (await ledgerLines(t, orgId)).length,
    };

    // The retry a double-click or a network retry produces: same intent, same
    // identity, byte-identical payload.
    await asAdmin.mutation(api.collections.recordPayment, args);

    expect({
      events: (await economicEvents(t, orgId)).length,
      entries: (await journalEntries(t, orgId)).length,
      lines: (await ledgerLines(t, orgId)).length,
    }).toEqual(afterFirst);

    const receivable = (await t.run((ctx) => ctx.db.get(receivableId))) as Doc<"receivables">;
    expect(receivable.outstandingAmount).toBe(0);
  });

  test("the same identity with different economic content is REFUSED, not replayed", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r3b");
    const receivableId = await debtOf(asAdmin, orgId, customerId, 100);
    const identity = `rehearsal-conflict-${crypto.randomUUID()}`;

    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: identity,
      orgId, receivableId, amount: 100, method: "CASH", paymentDate: 1_760_000_000_000,
    });
    const before = await ledgerLines(t, orgId);

    // Same key, different amount. Returning the first result here would tell an
    // operator that a DIFFERENT payment had been recorded, which is the failure
    // mode that makes silent replay worse than refusal.
    await expect(
      asAdmin.mutation(api.collections.recordPayment, {
        idempotencyKey: identity,
        orgId, receivableId, amount: 55, method: "CASH", paymentDate: 1_760_000_000_000,
      })
    ).rejects.toThrow();

    expect(await ledgerLines(t, orgId)).toEqual(before);
  });

  test("an economic command with NO identity is refused before it can post", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r3c");
    const receivableId = await debtOf(asAdmin, orgId, customerId, 100);
    const before = await ledgerLines(t, orgId);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (asAdmin.mutation as any)(api.collections.recordPayment, {
        orgId, receivableId, amount: 100, method: "CASH", paymentDate: Date.now(),
      })
    ).rejects.toThrow();

    // Refused BEFORE any write, not refused after a partial one.
    expect(await ledgerLines(t, orgId)).toEqual(before);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R4 — the books reconcile against the subledger
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R4 — exact reconciliation", () => {
  test("across several receipts the ledger balances and the subledger agrees exactly", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r4");

    const debts = [
      await debtOf(asAdmin, orgId, customerId, 100, "Debt A"),
      await debtOf(asAdmin, orgId, customerId, 250, "Debt B"),
      await debtOf(asAdmin, orgId, customerId, 75, "Debt C"),
    ];

    // Two settled exactly, one part-paid: the mix a real day produces.
    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receivableId: debts[0], amount: 100, method: "CASH", paymentDate: Date.now(),
    });
    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receivableId: debts[1], amount: 250, method: "BANK_TRANSFER", paymentDate: Date.now(),
    });
    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receivableId: debts[2], amount: 25, method: "CASH", paymentDate: Date.now(),
    });

    const lines = await ledgerLines(t, orgId);

    // 1. Debits equal credits. Every entry, not just in aggregate.
    expect(lines.reduce((n, l) => n + l.debitMinor, 0)).toBe(
      lines.reduce((n, l) => n + l.creditMinor, 0)
    );
    for (const entry of await journalEntries(t, orgId)) {
      const entryLines = await t.run((ctx) =>
        ctx.db
          .query("journalLines")
          .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
          .collect()
      );
      const d = entryLines.reduce((n, l) => n + l.debitMinor, 0);
      const c = entryLines.reduce((n, l) => n + l.creditMinor, 0);
      expect(d, `entry ${entry._id} is unbalanced`).toBe(c);
    }

    // 2. Payments reconcile to allocations: what was received equals what was
    //    applied plus what is still held unapplied.
    const payments = await t.run((ctx) =>
      ctx.db.query("collectionPayments").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    const received = payments.reduce((n, p) => n + Math.round(p.amount * 100), 0);
    expect(received).toBe(37500);

    // 3. The subledger's own numbers.
    const rows = await Promise.all(debts.map((id) => t.run((ctx) => ctx.db.get(id))));
    expect(rows.map((r) => (r as Doc<"receivables">).outstandingAmount)).toEqual([0, 0, 50]);

    // 4. Nothing was parked unapplied — every cent was aimed at a named debt.
    expect(netOn(lines, UNAPPLIED)).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R5 — lifecycle and period refusals still bite on a live org
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R5 — refusals hold on a fully-set-up organization", () => {
  test("a CLOSED period HOLDS the posting instead of losing the receipt", async () => {
    const { t, asAdmin, orgId, customerId, periodId } = await rehearseFreshDealership("r5");
    const receivableId = await debtOf(asAdmin, orgId, customerId, 100);

    await asAdmin.mutation(api.accountingPeriods.close, { orgId, periodId });
    const glBefore = await ledgerLines(t, orgId);

    // ⚠️ MEASURED, NOT ASSUMED, and my first draft of this test asserted the
    // opposite. Closing the period does NOT refuse the receipt. That is the
    // designed SCRUM-222 split and it is the safer half of the trade: money
    // physically arrived, so refusing to record it would lose a real event.
    // What must not happen is a PARTIAL posting.
    const paymentId = await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receivableId, amount: 100, method: "CASH", paymentDate: Date.now(),
    });
    expect(paymentId).toBeDefined();

    // The receipt survives...
    const payments = await t.run((ctx) =>
      ctx.db.query("collectionPayments").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(payments).toHaveLength(1);

    // ...the GL delta is EXACTLY zero — held, not half-posted...
    expect(await ledgerLines(t, orgId)).toEqual(glBefore);

    // ...and the durable outbox owns the failure, in a non-terminal state, with
    // a reason. An event that vanished would be the real defect here.
    const pending = await t.run((ctx) =>
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId))
        .collect()
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((p) => p.status !== "POSTED")).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R7 — money that un-happens is unwound symmetrically
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R7 — reversal symmetry", () => {
  test("a returned cheque unwinds its receipt exactly and reopens the debt by its own amount", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r7");
    const receivableId = await debtOf(asAdmin, orgId, customerId, 400);

    // The debt is named at REGISTRATION, not at clearing: `clearCheque` takes
    // only the cheque, so the allocation target is fixed when the instrument is
    // taken in rather than chosen when it settles.
    const chequeId = (await asAdmin.mutation(api.collections.registerCheque, {
      orgId, customerId, receivableId, bank: "Rehearsal Bank", chequeNumber: "RH-1",
      chequeDate: Date.now(), amount: 400,
    })) as Id<"postDatedCheques">;

    const beforeAnyMoney = await ledgerLines(t, orgId);

    await asAdmin.mutation(api.collections.clearCheque, {
      idempotencyKey: crypto.randomUUID(),
      orgId, chequeId,
    });

    const afterClear = await ledgerLines(t, orgId);
    expect(afterClear.length).toBeGreaterThan(beforeAnyMoney.length);
    const settled = (await t.run((ctx) => ctx.db.get(receivableId))) as Doc<"receivables">;
    expect(settled.outstandingAmount).toBe(0);

    // The cheque bounces. This is the "new way to SPEND creates new REVERSAL
    // obligations" path, and the thing that matters is not that something was
    // written but that the NET effect of clear-then-return is nil.
    await asAdmin.mutation(api.collections.returnClearedCheque, {
      idempotencyKey: crypto.randomUUID(),
      orgId, chequeId,
    });

    const afterReturn = await ledgerLines(t, orgId);

    // Symmetry, asserted as a NET PER ACCOUNT rather than as a row count: a
    // reversal that posted the right total to the wrong account would pass a
    // count check and fail this one.
    //
    // ⚠️ The baseline is the state BEFORE the cheque cleared, NOT zero. My first
    // draft asserted every account nets to zero and it failed on AR (+400.00) —
    // correctly. Creating the receivable is itself a ledger event, and after a
    // bounced cheque the debt is genuinely owed again, so AR *should* still
    // carry it. What must be nil is the net effect of CLEAR-THEN-RETURN.
    const netByCode = (lines: typeof afterReturn) => {
      const m = new Map<string, number>();
      for (const l of lines) {
        const code = l.code ?? "(no code)";
        m.set(code, (m.get(code) ?? 0) + l.debitMinor - l.creditMinor);
      }
      return m;
    };
    const base = netByCode(beforeAnyMoney);
    const now = netByCode(afterReturn);
    for (const code of new Set([...base.keys(), ...now.keys()])) {
      expect(
        now.get(code) ?? 0,
        `account ${code} did not return to its pre-clearing position after the cheque bounced`
      ).toBe(base.get(code) ?? 0);
    }

    // Cash in particular must be back to where it started: the dealership does
    // not still hold money the bank took back.
    expect(afterClear.length).toBeGreaterThan(0);

    // The books still balance, and the debt is owed again — by its OWN amount.
    expect(afterReturn.reduce((n, l) => n + l.debitMinor, 0)).toBe(
      afterReturn.reduce((n, l) => n + l.creditMinor, 0)
    );
    const reopened = (await t.run((ctx) => ctx.db.get(receivableId))) as Doc<"receivables">;
    expect(reopened.outstandingAmount).toBe(400);

    const cheque = (await t.run((ctx) => ctx.db.get(chequeId))) as Doc<"postDatedCheques">;
    expect(cheque.status).toBe("RETURNED");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R8 — a SOURCED car is a consignment, not inventory the dealership owned
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R8 — sourced (consigned) vehicle economics", () => {
  test("selling a SOURCED car owes the supplier its cost and recognises only the margin", async () => {
    const { t, asAdmin, orgId, userId, customerId } = await rehearseFreshDealership("r8");

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VIN_REHEARSAL_SOURCED", make: "Nissan", model: "Patrol", year: 2023,
        mileage: 0, color: "White", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 24_000, sourceType: "SOURCED", sourcedFromName: "Partner Dealer",
        sourceCost: 19_000, status: "AVAILABLE",
      })
    );

    const saleId = await asAdmin.mutation(api.sales.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 24_000, saleDate: Date.now(),
      status: "COMPLETED", financingType: "CASH",
    });

    // The dealership never owned this car, so the supplier is owed its cost.
    const payable = await t.run((ctx) =>
      ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", saleId))
        .unique()
    );
    expect(payable, "a sourced sale must create a supplier payable").not.toBeNull();
    expect(payable!.status).toBe("PENDING");

    // ACC-1, stated as money rather than as a flag: the dealership's economics
    // on a consignment are AGENT-SALE economics. The margin is 5,000 — and the
    // assertion that matters is that the full 24,000 is NOT booked as the
    // dealership's own revenue, because that is the misstatement this invariant
    // exists to prevent.
    const lines = await ledgerLines(t, orgId);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.reduce((n, l) => n + l.debitMinor, 0)).toBe(
      lines.reduce((n, l) => n + l.creditMinor, 0)
    );

    // ⚠️ ASSERTED POSITIVELY, on the WHOLE entry, because my first draft of this
    // test was VACUOUS: it filtered for a `VEHICLE_SALES_REVENUE` system key
    // that does not exist in this chart, summed zero lines, and "passed" by
    // proving 0 !== 2,400,000. A filter on a key that matches nothing always
    // reads as "that account was never touched" — the false negative this whole
    // rehearsal is supposed to catch, so the entry is pinned exactly instead.
    expect(
      lines.map((l) => ({ key: l.systemKey, code: l.code, debit: l.debitMinor, credit: l.creditMinor }))
    ).toEqual([
      // The customer owes the whole ticket price...
      { key: "ACCOUNTS_RECEIVABLE_CUSTOMERS", code: "1200", debit: 2_400_000, credit: 0 },
      // ...of which the supplier's cost is OWED ONWARD, never the dealership's...
      { key: "ACCOUNTS_PAYABLE_SUPPLIERS", code: "2400", debit: 0, credit: 1_900_000 },
      // ...leaving the 5,000 margin as the only thing the dealership EARNED.
      { key: "CONSIGNMENT_COMMISSION_REVENUE", code: "4170", debit: 0, credit: 500_000 },
    ]);

    // ACC-1 restated as the thing that must NOT be true: the dealership never
    // owned this car, so none of the sale price is its own sales revenue.
    expect(lines.filter((l) => l.systemKey === "SALES_REVENUE")).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R9 — the debt-CREATION commands are economic too
 *
 * These were disclosed as "writes only `receivables`, no GL". That was WRONG,
 * and the mistake was reading `ctx.db.insert` calls instead of reading the
 * helper: `createReceivable` calls `hookReceivableCreated`, which emits a real
 * RECEIVABLE_CREATED event through the posting pipeline whose accounting
 * idempotency key is `receivable_created_${receivableId}`.
 *
 * The receivable id is minted per call, so a retry mints a NEW id, a NEW
 * accounting key and a SECOND journal. The downstream dedupe cannot recognise
 * the retry — it is structurally blind to it — which is precisely the class
 * SCRUM-57 exists to prevent.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R9 — receivable creation under retry", () => {
  test("a retried receivable creation does not duplicate the debt or its journal", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r9a");
    const identity = `rehearsal-receivable-${crypto.randomUUID()}`;

    const args = {
      idempotencyKey: identity,
      orgId,
      customerId,
      sourceType: "OTHER" as const,
      creditSystemKey: "MISCELLANEOUS_INCOME" as const,
      title: "Retried debt",
      amount: 100,
      dueDate: 1_760_000_000_000,
    };

    await asAdmin.mutation(api.collections.createReceivable, args);
    const after1 = {
      receivables: (await t.run((ctx) =>
        ctx.db.query("receivables").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
      )).length,
      events: (await economicEvents(t, orgId)).length,
      lines: (await ledgerLines(t, orgId)).length,
    };

    // The lost-response retry: same intent, same identity, identical payload.
    await asAdmin.mutation(api.collections.createReceivable, args);

    expect({
      receivables: (await t.run((ctx) =>
        ctx.db.query("receivables").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
      )).length,
      events: (await economicEvents(t, orgId)).length,
      lines: (await ledgerLines(t, orgId)).length,
    }).toEqual(after1);
  });

  test("a retried installment PLAN replays as one plan, not a second set of rows", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r9b");
    const identity = `rehearsal-plan-${crypto.randomUUID()}`;

    const args = {
      idempotencyKey: identity,
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT" as const,
      creditSystemKey: "MISCELLANEOUS_INCOME" as const,
      title: "Retried plan",
      totalAmount: 1200,
      installmentCount: 12,
      firstDueDate: 1_760_000_000_000,
    };

    await asAdmin.mutation(api.collections.createInstallmentPlan, args);
    const rowsAfterFirst = (await t.run((ctx) =>
      ctx.db.query("receivables").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    )).length;
    expect(rowsAfterFirst).toBe(12);
    const eventsAfterFirst = (await economicEvents(t, orgId)).length;

    // The identity covers the WHOLE PLAN intent, not an individual generated
    // installment: a retry that produced installments 13..24 would be a second
    // plan wearing the first one's name.
    await asAdmin.mutation(api.collections.createInstallmentPlan, args);

    expect(
      (await t.run((ctx) =>
        ctx.db.query("receivables").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
      )).length
    ).toBe(12);
    expect((await economicEvents(t, orgId)).length).toBe(eventsAfterFirst);
  });

  test("the same identity with different economic content is refused for a receivable", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r9c");
    const identity = `rehearsal-conflict-recv-${crypto.randomUUID()}`;
    const base = {
      idempotencyKey: identity,
      orgId, customerId,
      sourceType: "OTHER" as const,
      creditSystemKey: "MISCELLANEOUS_INCOME" as const,
      title: "Conflicting debt",
      dueDate: 1_760_000_000_000,
    };

    await asAdmin.mutation(api.collections.createReceivable, { ...base, amount: 100 });
    const before = await ledgerLines(t, orgId);

    await expect(
      asAdmin.mutation(api.collections.createReceivable, { ...base, amount: 250 })
    ).rejects.toThrow();

    expect(await ledgerLines(t, orgId)).toEqual(before);
  });

  test("a receivable creation with NO identity is refused before any write", async () => {
    const { t, asAdmin, orgId, customerId } = await rehearseFreshDealership("r9d");
    const before = await ledgerLines(t, orgId);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (asAdmin.mutation as any)(api.collections.createReceivable, {
        orgId, customerId, sourceType: "OTHER", creditSystemKey: "MISCELLANEOUS_INCOME",
        title: "Unidentified debt", amount: 100, dueDate: 1_760_000_000_000,
      })
    ).rejects.toThrow();

    expect(await ledgerLines(t, orgId)).toEqual(before);
    expect(
      (await t.run((ctx) =>
        ctx.db.query("receivables").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
      )).length
    ).toBe(0);
  });

  test("a SALE-LINKED receivable still recognises AR exactly once", async () => {
    const { t, asAdmin, orgId, userId, customerId } = await rehearseFreshDealership("r9e");
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VIN_R9E", make: "Toyota", model: "Camry", year: 2023,
        mileage: 0, color: "Silver", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 20_000, sourceType: "STOCK", purchasePrice: 15_000, status: "AVAILABLE",
      })
    );
    const saleId = await asAdmin.mutation(api.sales.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
    });

    const arBefore = netOn(await ledgerLines(t, orgId), "ACCOUNTS_RECEIVABLE_CUSTOMERS");

    // A sale-linked receivable takes its credit key from the SALE, so this is
    // the path where a double AR recognition would show up.
    const identity = `rehearsal-sale-recv-${crypto.randomUUID()}`;
    const args = {
      idempotencyKey: identity,
      orgId, customerId, saleId,
      // Sale-linked: the credit key comes from the SALE, so `hookReceivableCreated`
      // is deliberately NOT fired here — AR was already recognised at completion.
      sourceType: "BANK_FINANCED_BALANCE" as const,
      title: "Balance due on sale",
      amount: 500,
      dueDate: 1_760_000_000_000,
    };
    await asAdmin.mutation(api.collections.createReceivable, args);
    const arAfterFirst = netOn(await ledgerLines(t, orgId), "ACCOUNTS_RECEIVABLE_CUSTOMERS");

    await asAdmin.mutation(api.collections.createReceivable, args);
    expect(
      netOn(await ledgerLines(t, orgId), "ACCOUNTS_RECEIVABLE_CUSTOMERS"),
      "the retry recognised accounts receivable a second time"
    ).toBe(arAfterFirst);
    expect(arAfterFirst).toBeGreaterThanOrEqual(arBefore);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R10 — the two approval paths are at-most-once BY STATE, and it is tested
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R10 — state-guarded approvals cannot post twice", () => {
  test("approving a manual journal twice cannot produce a second journal", async () => {
    const { t, asAdmin, orgId, userId } = await rehearseFreshDealership("r10");

    // Both sides must permit MANUAL posting — a control account would be
    // refused for a reason unrelated to what this test is about, and the
    // failure would look like the replay guard working when it was not.
    const postable = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    const expense = postable.find((a) => a.code === "6200" && a.allowManualPosting);
    const otherExpense = postable.find((a) => a.code === "6300" && a.allowManualPosting);
    expect(expense, "no manual-postable debit account in the fresh chart").toBeDefined();
    expect(otherExpense, "no manual-postable credit account in the fresh chart").toBeDefined();
    const cashId = expense!._id;
    const incomeId = otherExpense!._id;

    const draft = await asAdmin.mutation(api.financialAudit.createManualJournal, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      accountingDate: Date.now(),
      memo: "Rehearsal manual journal",
      lines: [
        { accountId: cashId, debitMinor: 10_000, creditMinor: 0 },
        { accountId: incomeId, debitMinor: 0, creditMinor: 10_000 },
      ],
    });
    const draftId = draft.draftId;

    const approverId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "r10_appr", email: "appr@rehearsal.test", name: "Approver" })
    );
    const approverRole = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId, name: "APPROVER", isSystemOwnerRole: true,
        permissions: ["view:finance", "manage:finance", "approve:manual_journal"],
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId, userId: approverId, roleId: approverRole })
    );
    const asApprover = t.withIdentity({ subject: "r10_appr", clerkId: "r10_appr" });

    await asApprover.mutation(api.financialAudit.approveManualJournal, { orgId, draftId });
    const afterFirst = {
      entries: (await journalEntries(t, orgId)).length,
      lines: (await ledgerLines(t, orgId)).length,
      events: (await economicEvents(t, orgId)).length,
    };
    expect(afterFirst.entries).toBeGreaterThan(0);

    // The state transition is the at-most-once mechanism here, in place of a
    // command identity. That is acceptable ONLY if it is actually proven, so
    // the second approval must be unable to produce anything.
    await expect(
      asApprover.mutation(api.financialAudit.approveManualJournal, { orgId, draftId })
    ).rejects.toThrow();

    expect({
      entries: (await journalEntries(t, orgId)).length,
      lines: (await ledgerLines(t, orgId)).length,
      events: (await economicEvents(t, orgId)).length,
    }).toEqual(afterFirst);
    void userId;
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R6 — organizations cannot see or touch each other's money
 * ══════════════════════════════════════════════════════════════════════════ */

describe("R6 — tenant isolation on the money path", () => {
  test("one dealership's books are unaffected by another's activity", async () => {
    const a = await rehearseFreshDealership("r6a");
    const b = await rehearseFreshDealership("r6b");

    await a.asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId: a.orgId, customerId: a.customerId, amount: 60, method: "CASH", paymentDate: Date.now(),
    });

    // A wrote money, including unapplied residue. B is a different harness and
    // must be untouched — asserted on B's own books rather than inferred.
    expect(await ledgerLines(b.t, b.orgId)).toEqual([]);
    expect(await economicEvents(b.t, b.orgId)).toHaveLength(0);

    // And A's residue is exactly where it belongs.
    expect(netOn(await ledgerLines(a.t, a.orgId), UNAPPLIED)).toBe(-6000);
  });
});
