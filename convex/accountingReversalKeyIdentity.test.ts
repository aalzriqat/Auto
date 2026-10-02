/**
 * SCRUM-515 — a reversal may report success only when the ledger PROVES the
 * requested original event is reversed (or a dispatchable reversal of THAT
 * event is queued). An idempotency key already held — in `accountingEvents` OR
 * `pendingAccountingEvents` — by a row for a different obligation must fail
 * closed. Symmetrically, a forward post must never be satisfied by a
 * JOURNAL_REVERSAL row.
 *
 * Every case below drives the real functions against the real convex-test
 * ledger; nothing is mocked. The error text asserted is server-side only
 * (internal invariant, plain Error), never a user-facing string.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { reverseAccountingEvent } from "./accounting/reversals";
import { drainEntries, enqueuePendingReversal } from "./accountingOutbox";
import { hookCustodyWriteOffReversed } from "./accounting/workflowHooks";

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const KEY_CONFLICT = /idempotency key/i;

async function seed() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const { orgId, userId, identity: asUser } = await seedOrgWithMember(t, {
    clerkId: "rk_user",
    permissions: ["view:sales", "manage:finance", "view:finance"],
    orgName: "Reversal Key Dealer",
    roleName: "Finance",
    memberName: "RK User",
  });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  const now = Date.now();
  const d = new Date(now);
  const periodId = await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    fiscalYear: d.getFullYear(),
    periodNumber: d.getMonth() + 1,
    startDate: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    endDate: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime(),
    openImmediately: true,
  });
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Key", lastName: "Customer" })
  );
  return { t, orgId, userId, asUser, periodId, customerId, now };
}
type Seed = Awaited<ReturnType<typeof seed>>;

/** A real forward posting through the engine: DEPOSIT_RECEIVED. */
async function postDeposit(s: Seed, tag: string, key = `dep_post_${tag}`) {
  const res = await s.asUser.mutation(internal.accountingLedger.post, {
    orgId: s.orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits",
    sourceId: `dep_${tag}`, eventVersion: 1, accountingDate: s.now,
    occurredAt: s.now, currency: "JOD", idempotencyKey: key,
    payload: {
      depositId: `dep_${tag}`, amountMinor: 1500, currency: "JOD",
      customerId: s.customerId.toString(),
    },
  });
  return res.eventId as any;
}

function reverse(s: Seed, originalEventId: any, idempotencyKey: string) {
  return s.t.run((ctx) =>
    reverseAccountingEvent(ctx, {
      orgId: s.orgId, originalEventId, reversalDate: s.now,
      reason: "SCRUM-515", actorId: s.userId, idempotencyKey,
    })
  );
}

async function footprint(s: Seed) {
  return await s.t.run(async (ctx) => {
    const events = await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const journals = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const pending = await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", s.orgId))
      .collect();
    return { events: events.length, journals: journals.length, pending: pending.length };
  });
}

/** A POSTED event + balanced journal written directly, for a tuple no posting rule would accept in a test. */
async function rawPosted(
  s: Seed,
  e: { eventType: string; sourceType: string; sourceId: string; key: string }
) {
  return await s.t.run(async (ctx) => {
    const accounts = await ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).take(2);
    const eventId = await ctx.db.insert("accountingEvents", {
      orgId: s.orgId, eventType: e.eventType, sourceType: e.sourceType, sourceId: e.sourceId,
      eventVersion: 1, idempotencyKey: e.key, occurredAt: s.now, accountingDate: s.now,
      currency: "JOD", payload: {}, status: "POSTED", createdBy: s.userId, createdAt: s.now,
    });
    const journalEntryId = await ctx.db.insert("journalEntries", {
      orgId: s.orgId, accountingEventId: eventId, journalNumber: `JE-RAW-${e.key}`.slice(0, 20),
      accountingDate: s.now, periodId: s.periodId, sourceType: e.sourceType, sourceId: e.sourceId,
      category: "SYSTEM", memo: "raw fixture", status: "POSTED", currency: "JOD",
      postedBy: s.userId, postedAt: s.now, createdAt: s.now,
    });
    for (let i = 0; i < 2; i++) {
      await ctx.db.insert("journalLines", {
        orgId: s.orgId, journalEntryId, lineNumber: i + 1, accountId: accounts[i]._id,
        debitMinor: i === 0 ? 700 : 0, creditMinor: i === 0 ? 0 : 700,
        currency: "JOD", scale: 3, accountingDate: s.now,
      });
    }
    await ctx.db.patch(eventId, { journalEntryId });
    return eventId as any;
  });
}

async function pendingRow(s: Seed, key: string) {
  return await s.t.run((ctx) =>
    ctx.db.query("pendingAccountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", s.orgId).eq("idempotencyKey", key))
      .collect()
  );
}

function pendingDoc(s: Seed, row: Record<string, unknown>) {
  return {
    orgId: s.orgId, attempts: 0, createdAt: Date.now(), actorId: s.userId,
    accountingDate: s.now, ...row,
  } as any;
}

function insertPending(s: Seed, row: Record<string, unknown>) {
  return s.t.run((ctx) => ctx.db.insert("pendingAccountingEvents", pendingDoc(s, row)));
}

/** A queued PENDING forward EXPENSE_POSTED row holding `key`. */
function queuedPost(s: Seed, key: string, expenseId: string) {
  return {
    kind: "POST", status: "PENDING", idempotencyKey: key,
    eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: expenseId,
    eventVersion: 1, occurredAt: s.now, currency: "JOD",
    payload: { expenseId, amountMinor: 5000, currency: "JOD", category: "OTHER" },
  };
}

describe("SCRUM-515 — reverseAccountingEvent proves the TARGET, not just the key", () => {
  test("1. key held by a POSTED reversal of a DIFFERENT event: throws, B stays POSTED, nothing written", async () => {
    const s = await seed();
    const a = await postDeposit(s, "1a");
    const b = await postDeposit(s, "1b");
    await reverse(s, a, "shared_rev_key");
    const before = await footprint(s);

    await expect(reverse(s, b, "shared_rev_key")).rejects.toThrow(KEY_CONFLICT);

    const bRow = await s.t.run((ctx) => ctx.db.get(b)) as any;
    expect(bRow.status).toBe("POSTED");
    expect(bRow.reversedByEventId).toBeUndefined();
    expect(await footprint(s)).toEqual(before);
  });

  test("2. key held by a FORWARD posted event: reverse throws", async () => {
    const s = await seed();
    const fwd = await postDeposit(s, "2f", "fwd_holds_this_key");
    const b = await postDeposit(s, "2b");
    const before = await footprint(s);

    await expect(reverse(s, b, "fwd_holds_this_key")).rejects.toThrow(KEY_CONFLICT);

    expect(((await s.t.run((ctx) => ctx.db.get(b))) as any).status).toBe("POSTED");
    expect(((await s.t.run((ctx) => ctx.db.get(fwd))) as any).status).toBe("POSTED");
    expect(await footprint(s)).toEqual(before);
  });

  test("3. control: same key + same target replay returns alreadyReversed with the original reversal", async () => {
    const s = await seed();
    const a = await postDeposit(s, "3a");
    const first = await reverse(s, a, "ctl_rev_key");
    const second = await reverse(s, a, "ctl_rev_key");
    expect(first.alreadyReversed).toBe(false);
    expect(second.alreadyReversed).toBe(true);
    expect(second.reversalEventId).toBe(first.reversalEventId);
  });

  test("4. A -> R1, R1 -> R2, then reverse A again: throws (R1 is no longer a live reversal)", async () => {
    const s = await seed();
    const a = await postDeposit(s, "4a");
    const r1 = await reverse(s, a, "r1_key");
    // Reversing a reversal must remain possible.
    const r2 = await reverse(s, r1.reversalEventId, "r2_key");
    expect(r2.alreadyReversed).toBe(false);

    const before = await footprint(s);
    await expect(reverse(s, a, "r3_key")).rejects.toThrow();
    expect(await footprint(s)).toEqual(before);
  });

  test("5a. reverse under a key held by a queued PENDING POST row: throws, no reversal written", async () => {
    const s = await seed();
    const b = await postDeposit(s, "5b");
    await insertPending(s, queuedPost(s, "queued_post_key", "exp_5"));
    const before = await footprint(s);

    await expect(reverse(s, b, "queued_post_key")).rejects.toThrow(KEY_CONFLICT);

    expect(((await s.t.run((ctx) => ctx.db.get(b))) as any).status).toBe("POSTED");
    expect(await footprint(s)).toEqual(before);
  });

  test("5b. the outbox's OWN matching REVERSE row is still allowed to reverse (drain path)", async () => {
    const s = await seed();
    const a = await postDeposit(s, "5c");
    await s.t.run((ctx) =>
      enqueuePendingReversal(ctx, {
        orgId: s.orgId, originalEventId: a, reversalDate: s.now, reason: "SCRUM-515",
        actorId: s.userId, idempotencyKey: "own_row_key", sourceType: "deposits", sourceId: "dep_5c",
      })
    );
    const res = await reverse(s, a, "own_row_key");
    expect(res.alreadyReversed).toBe(false);
  });

  test("5c. outbox end-to-end: a queued POST is never completed by a reversal's id", async () => {
    const s = await seed();
    const b = await postDeposit(s, "5e");
    const key = "queued_post_key_e2e";
    // One transaction, so no scheduled drain can interleave between the queue
    // insert and the reversal attempt. The attempt is caught here ONLY because
    // the fixed code throws before any write (so the catch commits nothing);
    // on the unfixed code it succeeds and writes the poisoned reversal row.
    await s.t.run(async (ctx) => {
      await ctx.db.insert("pendingAccountingEvents", pendingDoc(s, queuedPost(s, key, "exp_5e")));
      try {
        await reverseAccountingEvent(ctx, {
          orgId: s.orgId, originalEventId: b, reversalDate: s.now,
          reason: "SCRUM-515", actorId: s.userId, idempotencyKey: key,
        });
      } catch {
        /* expected after the fix */
      }
    });

    await drainOnce(s.t, s.orgId);

    const row = (await pendingRow(s, key))[0] as any;
    if (row.status === "POSTED" && row.resultEventId) {
      const ev = (await s.t.run((ctx) => ctx.db.get(row.resultEventId))) as any;
      // The queued POST may only ever be satisfied by ITS OWN forward event.
      expect(ev.eventType).toBe("EXPENSE_POSTED");
      expect(ev.sourceId).toBe("exp_5e");
    }
    const forward = await s.t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org_event_source_version", (q) =>
          q.eq("orgId", s.orgId).eq("eventType", "EXPENSE_POSTED").eq("sourceType", "expenses")
            .eq("sourceId", "exp_5e").eq("eventVersion", 1))
        .collect()
    );
    // And the books must contain that forward event: a POSTED row with no
    // forward event/journal for its tuple is the corruption being closed.
    expect(forward.filter((e) => e.status === "POSTED" && e.journalEntryId)).toHaveLength(1);
  });
});

describe("SCRUM-515 — a forward post is never satisfied by a JOURNAL_REVERSAL row", () => {
  test("6. postAccountingEvent whose key is held by a JOURNAL_REVERSAL throws", async () => {
    const s = await seed();
    const a = await postDeposit(s, "6a");
    await reverse(s, a, "rev_holds_forward_key");
    const before = await footprint(s);

    await expect(
      s.asUser.mutation(internal.accountingLedger.post, {
        orgId: s.orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits",
        sourceId: "dep_6other", eventVersion: 1, accountingDate: s.now,
        occurredAt: s.now, currency: "JOD", idempotencyKey: "rev_holds_forward_key",
        payload: {
          depositId: "dep_6other", amountMinor: 900, currency: "JOD",
          customerId: s.customerId.toString(),
        },
      })
    ).rejects.toThrow(KEY_CONFLICT);
    expect(await footprint(s)).toEqual(before);
  });
});

describe("SCRUM-515 — enqueuePendingReversal key identity", () => {
  const enqueue = (s: Seed, target: any, key: string) =>
    s.t.run((ctx) =>
      enqueuePendingReversal(ctx, {
        orgId: s.orgId, originalEventId: target, reversalDate: s.now, reason: "SCRUM-515",
        actorId: s.userId, idempotencyKey: key, sourceType: "deposits", sourceId: "dep_q",
      })
    );
  const reverseRow = (kind: "REVERSE" | "POST", status: string, key: string, target: any) =>
    ({
      kind, status, idempotencyKey: key, sourceType: "deposits", sourceId: "dep_q",
      ...(kind === "REVERSE" ? { originalEventId: target } : {
        eventType: "EXPENSE_POSTED", eventVersion: 1, currency: "JOD", payload: {},
      }),
    });

  test("7a. pending PENDING REVERSE row for a DIFFERENT target: throws, still one row", async () => {
    const s = await seed();
    const a = await postDeposit(s, "7a");
    const b = await postDeposit(s, "7b");
    await insertPending(s, reverseRow("REVERSE", "PENDING", "q_key_a", a));
    await expect(enqueue(s, b, "q_key_a")).rejects.toThrow(KEY_CONFLICT);
    const rows = await pendingRow(s, "q_key_a");
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).originalEventId).toBe(a);
  });

  test("7b. pending POST row holds the key: throws", async () => {
    const s = await seed();
    const a = await postDeposit(s, "7c");
    await insertPending(s, reverseRow("POST", "PENDING", "q_key_b", a));
    await expect(enqueue(s, a, "q_key_b")).rejects.toThrow(KEY_CONFLICT);
    expect(await pendingRow(s, "q_key_b")).toHaveLength(1);
  });

  test("7c. FAILED REVERSE row for the same target: throws (not a live queued reversal)", async () => {
    const s = await seed();
    const a = await postDeposit(s, "7d");
    await insertPending(s, reverseRow("REVERSE", "FAILED", "q_key_c", a));
    await expect(enqueue(s, a, "q_key_c")).rejects.toThrow(KEY_CONFLICT);
  });

  test("7d. POSTED REVERSE row for the same target: throws (it is not dispatchable)", async () => {
    const s = await seed();
    const a = await postDeposit(s, "7e");
    await insertPending(s, reverseRow("REVERSE", "POSTED", "q_key_d", a));
    await expect(enqueue(s, a, "q_key_d")).rejects.toThrow(KEY_CONFLICT);
  });

  test("7e. ledger row holding the key for another obligation: throws, nothing queued", async () => {
    const s = await seed();
    await postDeposit(s, "7f", "ledger_holds_key");
    const b = await postDeposit(s, "7g");
    await expect(enqueue(s, b, "ledger_holds_key")).rejects.toThrow(KEY_CONFLICT);
    expect(await pendingRow(s, "ledger_holds_key")).toHaveLength(0);
  });

  test("7f. ledger POSTED JOURNAL_REVERSAL of THIS target is a no-op", async () => {
    const s = await seed();
    const a = await postDeposit(s, "7h");
    await reverse(s, a, "ledger_rev_same");
    await enqueue(s, a, "ledger_rev_same");
    expect(await pendingRow(s, "ledger_rev_same")).toHaveLength(0);
  });

  test("7g. control: PENDING REVERSE for the same target is a no-op, single row", async () => {
    const s = await seed();
    const a = await postDeposit(s, "7i");
    await enqueue(s, a, "q_key_ctl");
    await enqueue(s, a, "q_key_ctl");
    expect(await pendingRow(s, "q_key_ctl")).toHaveLength(1);
  });
});

describe("SCRUM-515 — the workflow hook cannot report REVERSED / DEFERRED on a key conflict", () => {
  const fakeCustody = (tag: string) => `custody_fake_${tag}` as never;
  const keyFor = (custodyId: string) => `custody_write_off_reversal_${custodyId}_v1`;

  async function fixture(s: Seed, tag: string) {
    const custodyId = fakeCustody(tag) as string;
    const key = keyFor(custodyId);
    // The obligation the hook is asked to reverse.
    await rawPosted(s, {
      eventType: "CUSTODY_WRITTEN_OFF", sourceType: "financeDealCustody", sourceId: custodyId, key: `post_${tag}`,
    });
    // A DIFFERENT obligation, already reversed under the key the hook will use.
    const other = await rawPosted(s, {
      eventType: "DEPOSIT_RECEIVED", sourceType: "deposits", sourceId: `other_${tag}`, key: `other_post_${tag}`,
    });
    await reverse(s, other, key);
    return { custodyId: custodyId as never };
  }

  const callHook = (s: Seed, custodyId: never, reversalDate: number) =>
    s.t.run((ctx) =>
      hookCustodyWriteOffReversed(ctx, {
        orgId: s.orgId, custodyId, version: 1, reason: "SCRUM-515",
        actorId: s.userId, reversalDate,
      })
    );

  test("8a. open period: the originating mutation throws instead of returning REVERSED", async () => {
    const s = await seed();
    const { custodyId } = await fixture(s, "open");
    await expect(callHook(s, custodyId, s.now)).rejects.toThrow(KEY_CONFLICT);
    const target = await s.t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId).eq("sourceType", "financeDealCustody").eq("sourceId", custodyId as string))
        .collect()
    );
    expect(target[0].status).toBe("POSTED");
  });

  test("8b. no open period: the originating mutation throws instead of returning DEFERRED", async () => {
    const s = await seed();
    const { custodyId } = await fixture(s, "closed");
    const before = await footprint(s);
    await expect(callHook(s, custodyId, Date.UTC(2001, 0, 1))).rejects.toThrow(KEY_CONFLICT);
    expect(await footprint(s)).toEqual(before);
  });
});

// ── outbox drive helpers (same shape as accountingOutboxAtomicity.test.ts) ──

async function pump(t: any) {
  for (let pass = 0; pass < 10; pass += 1) {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const queued = (
      await t.run(async (ctx: any) => await ctx.db.system.query("_scheduled_functions").collect())
    ).filter((f: any) => f.state.kind === "pending" || f.state.kind === "inProgress").length;
    if (queued === 0) break;
  }
}

async function drainOnce(t: any, orgId: any) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    await t.run(async (ctx: any) => {
      const pending = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q: any) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .take(50);
      return await drainEntries(ctx, pending);
    });
    await pump(t);
    const claimed: any[] = await t.run(async (ctx: any) =>
      (
        await ctx.db
          .query("pendingAccountingEvents")
          .withIndex("by_org_status", (q: any) => q.eq("orgId", orgId))
          .collect()
      )
        .filter((r: any) => r.dispatchState === "DISPATCHED")
        .map((r: any) => r._id)
    );
    for (const rowId of claimed) {
      await t.mutation(internal.accountingOutbox.observeOutboxAttempt, { rowId });
    }
    await pump(t);
  } finally {
    vi.useRealTimers();
  }
}
