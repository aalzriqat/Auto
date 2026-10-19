import { convexTestWithComponents } from "../test-utils/convexTest";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { getPostedLines } from "./accountingReports";
import { aggregateTriggers } from "./aggregates";
import { synchronizeJournalLineEligibility, invalidateJournalEligibility } from "./utils/journalReportEligibility";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");
const begin = makeFunctionReference<"mutation", { orgId: Id<"organizations"> }>("journalReportEligibility:begin");
const page = makeFunctionReference<"mutation", { orgId: Id<"organizations"> }>("journalReportEligibility:backfillPage");
const block = makeFunctionReference<"mutation", { orgId: Id<"organizations"> }>("journalReportEligibility:blockForImport");
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture(count = 1) {
  // Components registered for the bank-balance triggers; `run` stays raw so the
  // tests choose when triggers fire, as they did before.
  const t = convexTestWithComponents(schema, modules);
  t.run = t.runUnwrapped;
  const seed = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Ledger eligibility", createdAt: 1 });
    const otherOrg = await ctx.db.insert("organizations", { name: "Other", createdAt: 1 });
    const user = await ctx.db.insert("users", { clerkId: "eligibility-test", email: "eligibility@example.test", name: "Test" });
    const accountId = await ctx.db.insert("chartOfAccounts", {
      orgId, code: "100", name: "Cash", type: "ASSET", normalBalance: "DEBIT",
      isControlAccount: true, allowManualPosting: true, active: true, createdAt: 1, updatedAt: 1,
    });
    const entries: Id<"journalEntries">[] = [];
    const lines: Id<"journalLines">[] = [];
    for (let i = 0; i < count; i++) {
      const entry = await ctx.db.insert("journalEntries", {
        orgId, journalNumber: `E${i}`, accountingDate: 999, sourceType: "test", sourceId: `${i}`,
        category: "MANUAL", memo: "Test", status: i === 0 ? "POSTED" : "DRAFT",
        postedBy: user, postedAt: 1, createdAt: 1,
      });
      entries.push(entry);
      lines.push(await ctx.db.insert("journalLines", {
        orgId, journalEntryId: entry, accountId, lineNumber: 1, debitMinor: 123456,
        creditMinor: 0, currency: "JOD", scale: 3, accountingDate: i === 0 ? 10 : 20,
      }));
    }
    return { orgId, otherOrg, entries, lines };
  });
  const state = () => t.run(ctx => ctx.db.query("journalReportEligibility").withIndex("by_org", q => q.eq("orgId", seed.orgId)).unique());
  const read = () => t.run(ctx => getPostedLines(ctx, seed.orgId, 0, 30));
  const drain = () => t.finishAllScheduledFunctions(() => vi.runAllTimers());
  return { t, ...seed, state, read, drain };
}

test("legacy backfill keeps exact IDs, minor amounts and line dates while excluding draft parents", async () => {
  const f = await fixture(65);
  const original = await f.read();
  await f.t.mutation(begin, { orgId: f.orgId });
  await f.drain();
  expect((await f.state())?.phase).toBe("READY");
  const current = await f.read();
  expect(current.map(l => [l._id, l.debitMinor, l.creditMinor, l.currency, l.accountingDate]))
    .toEqual(original.map(l => [l._id, l.debitMinor, l.creditMinor, l.currency, l.accountingDate]));
  expect(current.map(l => l._id)).toEqual([f.lines[0]]);
});

test("READY eliminates parent scans and point joins even above 512 window parents", async () => {
  const f = await fixture(513);
  await f.t.mutation(begin, { orgId: f.orgId }); await f.drain();
  const lines = await f.t.run(ctx => {
    const db = new Proxy(ctx.db, { get(target, key, receiver) {
      if (key === "query") return (table: string) => {
        if (table === "journalEntries") throw new Error("Unbounded parent scan");
        return target.query(table as Parameters<typeof target.query>[0]);
      };
      if (key === "get") return () => { throw new Error("Parent point join"); };
      return Reflect.get(target, key, receiver);
    } });
    return getPostedLines({ ...ctx, db }, f.orgId, 0, 30);
  });
  expect(lines.map(line => line._id)).toEqual([f.lines[0]]);
  expect(lines[0].debitMinor).toBe(123456);
});

test("wrapped line edits cannot forge eligibility and a cross-org parent is excluded", async () => {
  const f = await fixture();
  await f.t.mutation(begin, { orgId: f.orgId }); await f.drain();
  await f.t.run(async ctx => { const { db } = aggregateTriggers.wrapDB(ctx); await db.patch(f.lines[0], { reportPosted: false }); });
  expect((await f.read()).map(l => l._id)).toEqual([f.lines[0]]);
  await f.t.run(async ctx => { const { db } = aggregateTriggers.wrapDB(ctx); await db.patch(f.lines[0], { orgId: f.otherOrg, reportPosted: true }); });
  expect(await f.read()).toEqual([]);
  expect(await f.t.run(ctx => ctx.db.get(f.lines[0]).then(l => l?.reportPosted))).toBe(false);
});

test("POSTED to REVERSED retains original postings without invalidating READY", async () => {
  const f = await fixture();
  await f.t.mutation(begin, { orgId: f.orgId }); await f.drain();
  await f.t.run(async ctx => { const { db } = aggregateTriggers.wrapDB(ctx); await db.patch(f.entries[0], { status: "REVERSED" }); });
  expect((await f.state())?.phase).toBe("READY");
  expect((await f.read()).map(l => l._id)).toEqual([f.lines[0]]);
});

test.each(["status", "org", "delete"] as const)("parent %s change invalidates before rebuilding and never returns stale membership", async kind => {
  const f = await fixture();
  await f.t.mutation(begin, { orgId: f.orgId }); await f.drain();
  await f.t.run(async ctx => {
    const { db } = aggregateTriggers.wrapDB(ctx);
    if (kind === "status") await db.patch(f.entries[0], { status: "DRAFT" });
    else if (kind === "org") await db.patch(f.entries[0], { orgId: f.otherOrg });
    else await db.delete(f.entries[0]);
  });
  expect((await f.state())?.phase).toBe("BUILDING");
  expect(await f.read()).toEqual([]);
  await f.drain();
  expect((await f.state())?.phase).toBe("READY");
  expect(await f.read()).toEqual([]);
});

test("invalidation during BUILDING restarts earlier pages before READY", async () => {
  const f = await fixture(65);
  await f.t.mutation(begin, { orgId: f.orgId });
  await f.t.mutation(page, { orgId: f.orgId });
  expect((await f.state())?.cursor).not.toBeNull();
  await f.t.run(async ctx => { const { db } = aggregateTriggers.wrapDB(ctx); await db.patch(f.entries[0], { status: "DRAFT" }); });
  expect((await f.state())?.cursor).toBeNull();
  await f.drain();
  expect((await f.state())?.phase).toBe("READY");
  expect(await f.read()).toEqual([]);
});

test("BLOCKED imports stop queued callbacks until explicit post-import rebuild", async () => {
  const f = await fixture();
  await f.t.mutation(begin, { orgId: f.orgId });
  await f.t.mutation(block, { orgId: f.orgId });
  await f.drain();
  expect((await f.state())?.phase).toBe("BLOCKED");
  await f.t.run(ctx => ctx.db.patch(f.entries[0], { status: "DRAFT" }));
  await f.t.mutation(page, { orgId: f.orgId });
  expect((await f.state())?.phase).toBe("BLOCKED");
  expect(await f.read()).toEqual([]);
  await f.t.mutation(begin, { orgId: f.orgId }); await f.drain();
  expect((await f.state())?.phase).toBe("READY");
  expect(await f.read()).toEqual([]);
});

test("caught scheduling failure leaves BOTH affected organizations non-READY", async () => {
  const f = await fixture();
  await f.t.mutation(begin, { orgId: f.orgId }); await f.drain();
  await f.t.mutation(begin, { orgId: f.otherOrg }); await f.drain();
  await f.t.run(async ctx => {
    try {
      await invalidateJournalEligibility({ ...ctx, scheduler: {
        ...ctx.scheduler, runAfter: async () => { throw new Error("Injected schedule failure"); },
      } }, [f.orgId, f.otherOrg]);
    } catch { /* A caller catches the scheduler error. */ }
  });
  expect((await f.state())?.phase).toBe("BUILDING");
  expect(await f.t.run(ctx => ctx.db.query("journalReportEligibility")
    .withIndex("by_org", q => q.eq("orgId", f.otherOrg)).unique().then(s => s?.phase))).toBe("BUILDING");
});

test("a caught maintenance error commits a non-READY certificate, not a stale indexed answer", async () => {
  const f = await fixture(2);
  await f.t.mutation(begin, { orgId: f.orgId }); await f.drain();
  await f.t.run(async ctx => {
    const oldDoc = await ctx.db.get(f.lines[0]);
    if (!oldDoc) throw new Error("Missing fixture");
    await ctx.db.patch(oldDoc._id, { journalEntryId: f.entries[1] });
    const newDoc = await ctx.db.get(oldDoc._id);
    if (!newDoc) throw new Error("Missing changed fixture");
    const db = new Proxy(ctx.db, { get(target, key, receiver) {
      if (key === "get") return async () => { throw new Error("Injected parent read failure"); };
      return Reflect.get(target, key, receiver);
    } });
    try { await synchronizeJournalLineEligibility({ ...ctx, db }, { operation: "update", id: oldDoc._id, oldDoc, newDoc }); }
    catch { /* Model a caller catching the trigger error inside its mutation. */ }
  });
  expect((await f.state())?.phase).toBe("BUILDING");
  expect(await f.read()).toEqual([]);
  await f.drain();
  expect(await f.read()).toEqual([]);
});
