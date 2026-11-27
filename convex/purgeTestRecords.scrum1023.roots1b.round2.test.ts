import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { seedWorld as seedWorldWith, OCT_20 } from "../test-utils/scrum987Fixture";
import { cloneEntry, codes, dealEvents, openOctober, preview, reverseDeal } from "../test-utils/purgePreview";
import { checkHandover } from "./utils/purgeHandover";
import { PurgeSet, TokenIndex, type ManifestRefusal, type Row } from "./utils/purgeSurvivors";
import type { Id } from "./_generated/dataModel";
import type { World } from "../test-utils/scrum987Fixture";

/**
 * SCRUM-1023 PR #911 round 2 (both seats BLOCKED 1dbd0df3a). Each test changes ONE fact of an otherwise ok manifest.
 *  C1: every receipt and refund the deposit proof counts must carry a POSTED journal that is in the purge.
 *  C2: a handed-over application proves EVERY vehicle it names (vehicleId and each vehicleItems entry), and a handover with
 *      no vehicle to prove fails closed.
 */

const MODULES = import.meta.glob("./**/*.*s");
const seedWorld = (suffix: string) => seedWorldWith(MODULES, suffix, {});
const APPLICATIONS = "financeApplications" as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => { vi.useRealTimers(); });

async function reversedWorld(suffix: string) {
  const w = await seedWorld(suffix);
  await reverseDeal(w, 0);
  return { w, app: w.targets[0].applicationId };
}

describe("C1 - a deposit's receipt and refund each need a POSTED journal in the purge", () => {
  /** Seeds one deposit (test 1 calls `ledger` once; tests with two deposits call `openOctober` once themselves). */
  async function deposit(w: World): Promise<Id<"deposits">> {
    return await w.t.run(async (ctx) => {
      const app = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
      return ctx.db.insert("deposits", {
        orgId: w.orgId, customerId: app.customerId, vehicleId: app.vehicleId, quoteId: app.quoteId, amount: 50, amountMinor: 50_000, currency: "JOD",
        status: "REFUNDED", holdActive: false, refundedAmountMinor: 50_000, releasedAmountMinor: 50_000, releaseCount: 1, createdBy: w.actorId, createdAt: 1,
      });
    });
  }
  /** One receipt per amount and one refund per amount (so the cloned journal lines net to zero), all with journals. */
  async function ledger(w: World, depositId: Id<"deposits">, receipts: number[] = [50_000], tag = "r2") {
    const source = (await dealEvents(w, 1))[0];
    const made = [];
    for (const [i, amountMinor] of receipts.entries()) {
      made.push(await cloneEntry(w, source._id, `${tag}-receipt-${i}`, false, { depositId, amountMinor }, "DEPOSIT_RECEIVED"));
    }
    const refunds = [];
    for (const [i, amountMinor] of receipts.entries()) {
      refunds.push(await cloneEntry(w, source._id, `${tag}-refund-${i}`, true, { depositId, amountMinor }, "DEPOSIT_REFUNDED"));
    }
    return { receipts: made, refund: refunds[0] };
  }

  test("control: one receipt and one refund, each with a POSTED journal, is ok", async () => {
    const { w } = await reversedWorld("c1-ok");
    const depositId = await deposit(w);
    await openOctober(w);
    await ledger(w, depositId);
    expect((await preview(w, { depositIds: [depositId] })).refusals).toEqual([]);
  });

  test("two receipts of half each and two refunds of half each (all with journals) is still ok", async () => {
    const { w } = await reversedWorld("c1-two-receipts");
    const depositId = await deposit(w);
    await openOctober(w);
    const { receipts } = await ledger(w, depositId, [25_000, 25_000]);
    const m = await preview(w, { depositIds: [depositId] });
    expect(m.refusals).toEqual([]);
    expect(m.rootProofs[0].receiptEventIds).toHaveLength(2);
    expect(receipts).toHaveLength(2);
  });

  /** The event has no journal at all: the link is gone and the journal with its lines is deleted. */
  async function dropJournal(w: World, e: { eventId: Id<"accountingEvents">; journalId: Id<"journalEntries"> }): Promise<void> {
    await w.t.run(async (ctx) => {
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", e.journalId)).collect();
      for (const l of lines) await ctx.db.delete(l._id);
      await ctx.db.delete(e.journalId);
      await ctx.db.patch(e.eventId, { journalEntryId: undefined });
    });
  }

  test("receipt AND refund with no journal at all (the reviewer's shape: zero lines, nets to zero) refuses DEPOSIT_REFUND_PROOF", async () => {
    const { w } = await reversedWorld("c1-both-nojournal");
    const depositId = await deposit(w);
    await openOctober(w);
    const { receipts, refund } = await ledger(w, depositId);
    await dropJournal(w, receipts[0]);
    await dropJournal(w, refund);
    expect(codes(await preview(w, { depositIds: [depositId] }))).toEqual(["DEPOSIT_REFUND_PROOF"]);
  });

  test("a receipt with NO journal refuses DEPOSIT_REFUND_PROOF (the lone refund journal would also not net)", async () => {
    const { w } = await reversedWorld("c1-receipt-nojournal");
    const depositId = await deposit(w);
    await openOctober(w);
    const { receipts } = await ledger(w, depositId);
    await dropJournal(w, receipts[0]);
    expect(codes(await preview(w, { depositIds: [depositId] }))).toContain("DEPOSIT_REFUND_PROOF");
  });

  test("a refund with NO journal refuses DEPOSIT_REFUND_PROOF (the lone receipt journal would also not net)", async () => {
    const { w } = await reversedWorld("c1-refund-nojournal");
    const depositId = await deposit(w);
    await openOctober(w);
    const { refund } = await ledger(w, depositId);
    await dropJournal(w, refund);
    expect(codes(await preview(w, { depositIds: [depositId] }))).toContain("DEPOSIT_REFUND_PROOF");
  });
  test("an event whose journal row still exists but is no longer linked from it: DEPOSIT_REFUND_PROOF, and the orphan journal is JOURNAL_NOT_PAIRED", async () => {
    const { w } = await reversedWorld("c1-orphan-journal");
    const depositId = await deposit(w);
    await openOctober(w);
    const { receipts } = await ledger(w, depositId);
    await w.t.run((ctx) => ctx.db.patch(receipts[0].eventId, { journalEntryId: undefined }));
    expect(codes(await preview(w, { depositIds: [depositId] }))).toEqual(["DEPOSIT_REFUND_PROOF", "JOURNAL_NOT_PAIRED"]);
  });

  test("a receipt whose journal is DRAFT refuses DEPOSIT_REFUND_PROOF (and the journal itself is JOURNAL_NOT_PAIRED)", async () => {
    const { w } = await reversedWorld("c1-draft-journal");
    const depositId = await deposit(w);
    await openOctober(w);
    const { receipts } = await ledger(w, depositId);
    await w.t.run((ctx) => ctx.db.patch(receipts[0].journalId, { status: "DRAFT" }));
    expect(codes(await preview(w, { depositIds: [depositId] }))).toEqual(["DEPOSIT_REFUND_PROOF", "JOURNAL_NOT_PAIRED"]);
  });

  describe("C3 - the journal must be bound to the event (journal.accountingEventId) and the currency must match", () => {
    test("control: two deposits, each with its own receipt and refund journals, is ok", async () => {
      const { w } = await reversedWorld("c3-control");
      const [d1, d2] = [await deposit(w), await deposit(w)];
      await openOctober(w);
      await ledger(w, d1, [50_000], "c3a");
      await ledger(w, d2, [50_000], "c3b");
      expect((await preview(w, { depositIds: [d1, d2] })).refusals).toEqual([]);
    });

    test("shape A: deposit 1's receipt and refund point at deposit 2's journals (both POSTED, in the purge): DEPOSIT_REFUND_PROOF", async () => {
      const { w } = await reversedWorld("c3-cross");
      const [d1, d2] = [await deposit(w), await deposit(w)];
      await openOctober(w);
      const a = await ledger(w, d1, [50_000], "c3a");
      const b = await ledger(w, d2, [50_000], "c3b");
      await w.t.run(async (ctx) => {
        await ctx.db.patch(a.receipts[0].eventId, { journalEntryId: b.receipts[0].journalId });
        await ctx.db.patch(a.refund.eventId, { journalEntryId: b.refund.journalId });
      });
      expect(codes(await preview(w, { depositIds: [d1, d2] }))).toContain("DEPOSIT_REFUND_PROOF");
    });

    test("shape B: the receipt and the refund of one deposit both point at the receipt's journal: DEPOSIT_REFUND_PROOF", async () => {
      const { w } = await reversedWorld("c3-same-journal");
      const d = await deposit(w);
      await openOctober(w);
      const { receipts, refund } = await ledger(w, d);
      await w.t.run((ctx) => ctx.db.patch(refund.eventId, { journalEntryId: receipts[0].journalId }));
      expect(codes(await preview(w, { depositIds: [d] }))).toContain("DEPOSIT_REFUND_PROOF");
    });

    test("shape C: two receipts of 25,000 share one journal: DEPOSIT_REFUND_PROOF", async () => {
      const { w } = await reversedWorld("c3-shared-receipt");
      const d = await deposit(w);
      await openOctober(w);
      const { receipts } = await ledger(w, d, [25_000, 25_000]);
      await w.t.run((ctx) => ctx.db.patch(receipts[1].eventId, { journalEntryId: receipts[0].journalId }));
      expect(codes(await preview(w, { depositIds: [d] }))).toContain("DEPOSIT_REFUND_PROOF");
    });

    test("a receipt whose currency is not the deposit currency: DEPOSIT_REFUND_PROOF", async () => {
      const { w } = await reversedWorld("c3-currency");
      const d = await deposit(w);
      await openOctober(w);
      const { receipts } = await ledger(w, d);
      await w.t.run((ctx) => ctx.db.patch(receipts[0].eventId, { currency: "USD" }));
      expect(codes(await preview(w, { depositIds: [d] }))).toContain("DEPOSIT_REFUND_PROOF");
    });
  });
});

describe("C2 - a handed-over application proves every vehicle it names", () => {
  async function handedOver(suffix: string) {
    const base = await reversedWorld(suffix);
    const { vehicleId, otherVehicleId } = await base.w.t.run(async (ctx) => {
      const app = (await ctx.db.get(base.app as Id<"financeApplications">))!;
      const other = (await ctx.db.get(base.w.targets[1].applicationId as Id<"financeApplications">))!;
      await ctx.db.patch(base.app as Id<"financeApplications">, {
        handoverStatus: "HANDED_OVER", vehicleHandoverAt: 5,
        vehicleItems: [{ vehicleId: app.vehicleId, unitPrice: 1 }, { vehicleId: other.vehicleId, unitPrice: 1 }],
      });
      await ctx.db.patch(app.vehicleId, { status: "AVAILABLE" });
      return { vehicleId: app.vehicleId, otherVehicleId: other.vehicleId };
    });
    return { ...base, vehicleId, otherVehicleId };
  }

  test("control: both vehicles AVAILABLE is proven, and both are itemized", async () => {
    const { w, app, vehicleId, otherVehicleId } = await handedOver("c2-both-available");
    await w.t.run((ctx) => ctx.db.patch(otherVehicleId, { status: "AVAILABLE" }));
    const m = await preview(w, { applicationIds: [app] }, [], [app]);
    expect(m.refusals).toEqual([]);
    expect(m.handoverOverrides[0].vehicles.map((v) => v.status)).toEqual(["AVAILABLE", "AVAILABLE"]);
    expect(m.handoverOverrides[0].vehicles.map((v) => v.vehicleId).toSorted((a, b) => (a < b ? -1 : 1))).toEqual([vehicleId, otherVehicleId].toSorted((a, b) => (a < b ? -1 : 1)));
  });

  test("vehicleId AVAILABLE but vehicleItems[1] is SOLD: HANDOVER_LIVE_CONSEQUENCE", async () => {
    const { w, app, otherVehicleId } = await handedOver("c2-second-sold");
    await w.t.run((ctx) => ctx.db.patch(otherVehicleId, { status: "SOLD" }));
    const m = await preview(w, { applicationIds: [app] }, [], [app]);
    expect(codes(m)).toEqual(["HANDOVER_LIVE_CONSEQUENCE"]);
    expect(m.handoverOverrides[0].liveConsequences.join(" ")).toContain("SOLD");
  });

  test("a handed-over application with no vehicle to prove fails closed (the pure check)", () => {
    const set = new PurgeSet();
    set.addRoot(APPLICATIONS, "app-1");
    const app: Row = { _id: "app-1", handoverStatus: "HANDED_OVER", status: "CANCELLED" };
    const out: ManifestRefusal[] = [];
    const overrides = checkHandover(set, new Map([[APPLICATIONS, [app]]]), new TokenIndex(), ["app-1"], out);
    expect(out.map((r) => r.code)).toEqual(["HANDOVER_LIVE_CONSEQUENCE"]);
    expect(overrides[0].liveConsequences.join(" ")).toContain("no vehicle");
  });
});

