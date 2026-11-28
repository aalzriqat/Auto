import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { seedWorld as seedWorldWith, OCT_20 } from "../test-utils/scrum987Fixture";
import type { World } from "../test-utils/scrum987Fixture";
import { cloneEntry, codes, dealEvents, preview, reverseDeal } from "../test-utils/purgePreview";
import type { Id } from "./_generated/dataModel";

/**
 * SCRUM-1023 Phase 1, PR #908 round 1 - the manifest must see every link. Each worlds is built from COMPLETE
 * reversed pairs (the production shape: 26 of its 28 reversed originals), so a refusal can only come from the
 * one fact the test changes; the passing twin is `preview ... ok === true` right beside it.
 */

const MODULES = import.meta.glob("./**/*.*s");
const seedWorld = (suffix: string) => seedWorldWith(MODULES, suffix, {});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => { vi.useRealTimers(); });

/** A world whose deal 0 is fully reversed (events, journals, lines): purging it nets to zero with no exception. */
async function reversedWorld(suffix: string) {
  const w = await seedWorld(suffix);
  const { originals, reversals } = await reverseDeal(w, 0);
  return { w, app: w.targets[0].applicationId, originals, reversals };
}

async function journalLineOf(w: World, journalId: Id<"journalEntries">): Promise<Id<"journalLines">> {
  const line = await w.t.run((ctx) => ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId)).first());
  if (!line) throw new Error("journal has no line");
  return line._id;
}

async function insertBank(w: World): Promise<Id<"bankAccounts">> {
  return await w.t.run((ctx) => ctx.db.insert("bankAccounts", {
    orgId: w.orgId, name: "Main", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: 1, isActive: true,
    isReconciliationTarget: true, createdBy: w.actorId, createdAt: 1, updatedAt: 1,
  }));
}

async function insertSale(w: World, extra: Record<string, unknown>): Promise<Id<"sales">> {
  return await w.t.run(async (ctx) => {
    const app = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
    return ctx.db.insert("sales", {
      orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, salespersonId: w.actorId, salePrice: 10_500,
      saleDate: Date.now(), status: "CANCELLED", ...extra,
    } as never);
  });
}

describe("round 1 / R1 - journal lines join the purge set before the survivor check", () => {
  test("the happy path of complete reversed pairs passes with no refusal", async () => {
    const { w, app, originals, reversals } = await reversedWorld("happy");
    const m = await preview(w, { applicationIds: [app] });
    expect(m.refusals).toEqual([]);
    expect(m.ok).toBe(true);
    expect(m.countsByTable.accountingEvents).toBe(originals.length + reversals.length);
    expect(m.countsByTable.journalEntries).toBe(originals.length + reversals.length);
    expect(m.accountNet.every((r) => r.netMinor === 0)).toBe(true);
    expect(m.exceptionItems).toEqual([]);
  });

  test("a bank statement line matched to a purged journal line is a SURVIVING_REFERENCE, nothing else", async () => {
    const { w, app, originals } = await reversedWorld("bank-line");
    const lineId = await journalLineOf(w, originals[0].journalEntryId as Id<"journalEntries">);
    const bankAccountId = await insertBank(w);
    await w.t.run((ctx) => ctx.db.insert("bankStatementLines", {
      orgId: w.orgId, bankAccountId, importBatchId: "b1", statementDate: 1, description: "x", amountMinor: 1, status: "MATCHED",
      matchedJournalLineId: lineId, createdAt: 1, createdBy: w.actorId,
    }));
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["SURVIVING_REFERENCE"]);
    expect(m.survivingReferences.map((s) => [s.table, s.count])).toEqual([["bankStatementLines", 1]]);
  });

  test("a bank aggregate item of a purged line joins the manifest; one of another deal's line does not", async () => {
    const { w, app, originals } = await reversedWorld("aggregate");
    const other = (await dealEvents(w, 1))[0];
    const [mine, theirs] = [await journalLineOf(w, originals[0].journalEntryId as Id<"journalEntries">), await journalLineOf(w, other.journalEntryId as Id<"journalEntries">)];
    const accountId = (await w.t.run((ctx) => ctx.db.get(mine)))!.accountId;
    const item = (lineId: Id<"journalLines">) => w.t.run((ctx) => ctx.db.insert("bankBalanceAggregateItems", {
      orgId: w.orgId, journalLineId: lineId, namespace: "ns", accountId, currency: "JOD", accountingDate: 1, netMinor: 1, absMinor: 1,
    }));
    const [itemMine, itemTheirs] = [await item(mine), await item(theirs)];
    const m = await preview(w, { applicationIds: [app] });
    expect(m.ok).toBe(true);
    expect(m.idsByTable.bankBalanceAggregateItems).toEqual([itemMine]);
    expect(Object.values(m.idsByTable).flat()).not.toContain(itemTheirs);
  });
});

describe("round 1 / R2 - rows of the root tables and their links are survivors too", () => {
  test("a live sale whose applicationId names a purged application is a SURVIVING_REFERENCE on sales", async () => {
    const { w, app } = await reversedWorld("live-sale");
    await insertSale(w, { applicationId: app });
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["SURVIVING_REFERENCE"]);
    expect(m.survivingReferences.map((s) => [s.table, s.count])).toEqual([["sales", 1]]);
  });

  test("a sale root whose application is not in the purge set is a SURVIVING_REFERENCE on financeApplications", async () => {
    const w = await seedWorld("sale-root-app");
    const saleId = await insertSale(w, { isDeleted: true });
    await w.t.run((ctx) => ctx.db.patch(w.targets[0].applicationId as Id<"financeApplications">, { finalizedSaleId: saleId }));
    const m = await preview(w, { saleIds: [saleId] });
    expect(codes(m)).toEqual(["SURVIVING_REFERENCE"]);
    expect(m.survivingReferences.map((s) => [s.table, s.count])).toEqual([["financeApplications", 1]]);
  });

  test("the organization row is token-scanned: one that mentions a purged id is a SURVIVING_REFERENCE on organizations", async () => {
    const { w, app } = await reversedWorld("org-row");
    // The real fields that hold ids (the opening-cleanup scans) need rows no fixture builds; a free-text field exercises the same scan.
    await w.t.run((ctx) => ctx.db.patch(w.orgId, { name: `Showroom ${app}` }));
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["SURVIVING_REFERENCE"]);
    expect(m.survivingReferences).toEqual([{ table: "organizations", count: 1, ids: [w.orgId] }]);
  });

  test("an application root whose finalized sale is not in the purge set is SHARED_WITH_LIVE", async () => {
    const { w, app } = await reversedWorld("app-root-sale");
    const liveSale = await insertSale(w, {});
    await w.t.run((ctx) => ctx.db.patch(app as Id<"financeApplications">, { finalizedSaleId: liveSale }));
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["SHARED_WITH_LIVE"]);
  });
});

describe("round 1 / R4 - a row joins only when nothing live still holds it", () => {
  const idemRow = (w: World, key: string) => w.t.run((ctx) => ctx.db.insert("commandIdempotency", {
    orgId: w.orgId, operation: "someCommand", idempotencyKey: key, status: "COMPLETED", createdAt: 1,
  }));

  test("an idempotency row that names only purged ids joins the manifest (the passing twin)", async () => {
    const { w, app } = await reversedWorld("idem-purged");
    const row = await idemRow(w, `k:${app}`);
    const m = await preview(w, { applicationIds: [app] });
    expect(m.ok).toBe(true);
    expect(m.idsByTable.commandIdempotency).toContain(row);
  });

  test("an idempotency row that mixes a purged application and a live one is SHARED_WITH_LIVE and does not join", async () => {
    const { w, app } = await reversedWorld("idem-mixed");
    const row = await idemRow(w, `k:${app}:${w.targets[1].applicationId}`);
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["SHARED_WITH_LIVE"]);
    expect(Object.values(m.idsByTable).flat()).not.toContain(row);
  });

  test("a successor claim (restoredFromClaimId) that a LIVE sale consumed is SHARED_WITH_LIVE", async () => {
    const w = await seedWorld("claim-chain");
    const app = (await w.t.run((ctx) => ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">)))!;
    const purgedSale = await insertSale(w, { isDeleted: true });
    const liveSale = await insertSale(w, {});
    const rootId = await w.t.run((ctx) => ctx.db.insert("commitmentRoots", {
      orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, status: "CONSUMED", openedAt: 1, openedBy: w.actorId, consumedBySaleId: purgedSale,
    }));
    const claim = (extra: Record<string, unknown>) => w.t.run((ctx) => ctx.db.insert("vehicleCommitmentClaims", {
      orgId: w.orgId, rootId, vehicleId: app.vehicleId, evidenceKind: "DEPOSIT", status: "CONSUMED", createdAt: 1, createdBy: w.actorId, ...extra,
    } as never));
    const first = await claim({ consumedBySaleId: purgedSale });
    const successor = await claim({ restoredFromClaimId: first, consumedBySaleId: liveSale });
    const m = await preview(w, { saleIds: [purgedSale] });
    expect(codes(m)).toEqual(["SHARED_WITH_LIVE"]);
    expect(m.idsByTable.vehicleCommitmentClaims).toEqual([first]);
    expect(Object.values(m.idsByTable).flat()).not.toContain(successor);
  });

  test("a CONFIRMED customer finance-company payment on a purged application is CONFIRMED_PAYMENT_EVIDENCE until its id is approved (ruling D replaced LIVE_STATE_ROW)", async () => {
    const { w, app } = await reversedWorld("live-state");
    const payment = await w.t.run((ctx) => ctx.db.insert("customerFinanceCompanyPayments", {
      orgId: w.orgId, applicationId: app as Id<"financeApplications">, status: "CONFIRMED", amountMinor: 2_800_000, currency: "JOD",
      paidAt: 1, reference: "r", confirmedBy: w.actorId, confirmedAt: 1,
    } as never));
    const refused = await preview(w, { applicationIds: [app] });
    expect(codes(refused)).toEqual(["CONFIRMED_PAYMENT_EVIDENCE"]);
    expect(refused.refusals.map((r) => r.table)).toEqual(["customerFinanceCompanyPayments"]);
    const approved = await preview(w, { applicationIds: [app] }, [], [payment]);
    expect(approved.refusals).toEqual([]);
    expect(approved.idsByTable.customerFinanceCompanyPayments).toEqual([payment]);
  });

  test("an approved live row id that is not in the purge set at all refuses, so a stale approval cannot linger", async () => {
    const { w, app } = await reversedWorld("stale-approval");
    const m = await preview(w, { applicationIds: [app] }, [], [w.targets[1].custodyId]);
    expect(codes(m)).toEqual(["APPROVED_ROW_NOT_IN_PURGE"]);
  });
});

describe("round 1 / R5 - a reversed pair must be complete in both directions", () => {
  test("a reversal that was itself reversed needs its reverser in the set: INCOMPLETE_REVERSAL_PAIR only", async () => {
    const { w, app, reversals } = await reversedWorld("reversed-reversal");
    const outside = await cloneEntry(w, reversals[0]._id, "outside-reverser", true, {});
    await w.t.run((ctx) => ctx.db.patch(reversals[0]._id, { status: "REVERSED", reversedByEventId: outside.eventId }));
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["INCOMPLETE_REVERSAL_PAIR"]);
  });

  test("an original and a reversal that do not point at each other are INCOMPLETE_REVERSAL_PAIR", async () => {
    const { w, app, reversals } = await reversedWorld("event-symmetry");
    const strangerOriginal = (await dealEvents(w, 0))[0];
    const other = reversals.find((r) => r.reversalOfEventId !== strangerOriginal._id);
    if (!other) throw new Error("need two reversals");
    // `other` claims to reverse an original whose own link names a different reversal.
    await w.t.run((ctx) => ctx.db.patch(other._id, { reversalOfEventId: strangerOriginal._id }));
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["INCOMPLETE_REVERSAL_PAIR"]);
  });

  test("two journal reversals that cross their links (each in the set) are JOURNAL_NOT_PAIRED, not 'paired by OR'", async () => {
    const w = await seedWorld("journal-symmetry");
    await reverseDeal(w, 0);
    await reverseDeal(w, 1);
    const journals = await w.t.run((ctx) => ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", w.orgId)).collect());
    const reversalJournals = journals.filter((j) => j.category === "REVERSAL");
    const originalOfOther = journals.find((j) => j._id !== reversalJournals[0].reversalOfJournalEntryId && j._id === reversalJournals[1].reversalOfJournalEntryId);
    if (!originalOfOther) throw new Error("need two reversed journals");
    await w.t.run((ctx) => ctx.db.patch(reversalJournals[0]._id, { reversalOfJournalEntryId: originalOfOther._id }));
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId, w.targets[1].applicationId] });
    expect(codes(m)).toEqual(["JOURNAL_NOT_PAIRED"]);
  });

  test("a DRAFT reversal journal is not a posted half of a pair: JOURNAL_NOT_PAIRED only", async () => {
    const { w, app } = await reversedWorld("draft-journal");
    const journals = await w.t.run((ctx) => ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", w.orgId)).collect());
    const reversal = journals.find((j) => j.category === "REVERSAL");
    if (!reversal) throw new Error("no reversal journal");
    await w.t.run((ctx) => ctx.db.patch(reversal._id, { status: "DRAFT" }));
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["JOURNAL_NOT_PAIRED"]);
  });
});
