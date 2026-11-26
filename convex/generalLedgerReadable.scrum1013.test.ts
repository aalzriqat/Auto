/**
 * SCRUM-1013 — the General Ledger journal reads as words, not internal keys.
 *
 * Production showed `treasuryTransfers: ["pd7…",…]:9a19…` in the Source column
 * (the transfer's idempotency key), English system memos, and a bank line with
 * no bank name. The journal queries now return structured display facts — the
 * source family, the economic event, the typed note, the banks, and the links
 * between a reversal and its original — so the screen can localize them. These
 * tests pin those facts through the real transfer and reversal doors, and that
 * a bank belonging to another organization is never named.
 */
import { expect, test } from "vitest";
import { bankOpening, seedBankOpeningFixture as seed } from "../test-utils/openingBalanceBankFixture";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const PAGE = { numItems: 20, cursor: null };

async function transferAndReverse() {
  const fx = await seed();
  const fromBankAccountId = await fx.createBank("Funding bank", "JOD", true);
  await fx.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, bankOpening(fx, fromBankAccountId));
  const toBankAccountId = await fx.createBank("Arab Bank Amman");
  const moved = await fx.asOwner.mutation(api.bankTransfers.record, {
    orgId: fx.orgId, currency: "JOD", fromBankAccountId, toBankAccountId, amountMinor: 4_641_000,
    accountingDate: Date.now(), reference: "4641",
    // The shape production used as the idempotency key, which then became the sourceId.
    idempotencyKey: '["pd7pw6","k179v2",null,"JOD",4641000,1795651200000,"4641"]:9a19c2be-0000',
  });
  const reversed = await fx.asOwner.mutation(api.bankTransfers.reverse, {
    orgId: fx.orgId, eventId: moved.eventId, accountingDate: Date.now(),
    reason: "Entered against the wrong bank", idempotencyKey: "scrum1013-reversal",
  });
  const numberOf = (id: Id<"journalEntries">) =>
    fx.t.run(async (ctx) => (await ctx.db.get(id))?.journalNumber ?? "missing");
  return {
    fx, fromBankAccountId, toBankAccountId, moved, reversed,
    originalNumber: await numberOf(moved.journalEntryId),
    reversalNumber: await numberOf(reversed.reversalJournalEntryId),
  };
}

test("SCRUM-1013 journal list returns the source family, typed note, banks and reversal links", async () => {
  const s = await transferAndReverse();
  const page = await s.fx.asOwner.query(api.accountingLedger.listJournalEntries, { orgId: s.fx.orgId, paginationOpts: PAGE });
  const original = page.page.find((entry) => entry._id === s.moved.journalEntryId);
  const reversal = page.page.find((entry) => entry._id === s.reversed.reversalJournalEntryId);
  const banks = {
    from: { kind: "BANK", bankName: "Funding bank" },
    to: { kind: "BANK", bankName: "Arab Bank Amman" },
  };

  expect(original?.display).toEqual({
    sourceFamily: "TREASURY_TRANSFER", eventType: "TREASURY_TRANSFER", isReversal: false, note: "4641",
    transfer: banks, reversalOf: null,
    reversedBy: { journalEntryId: s.reversed.reversalJournalEntryId, journalNumber: s.reversalNumber },
  });
  expect(reversal?.display).toEqual({
    sourceFamily: "TREASURY_TRANSFER", eventType: "TREASURY_TRANSFER", isReversal: true,
    note: "Entered against the wrong bank", transfer: banks,
    reversalOf: { journalEntryId: s.moved.journalEntryId, journalNumber: s.originalNumber },
    reversedBy: null,
  });

  // The account-filtered branch reads entries through the lines index; it carries the same facts.
  const filtered = await s.fx.asOwner.query(api.accountingLedger.listJournalEntries, {
    orgId: s.fx.orgId, accountId: s.fx.bankControlId, paginationOpts: PAGE,
  });
  expect(filtered.page.find((entry) => entry._id === s.moved.journalEntryId)?.display).toEqual(original?.display);
}, 30_000);

test("SCRUM-1013 journal entry lines name the bank and the transfer leg, and strip the reversal marker", async () => {
  const s = await transferAndReverse();
  const original = await s.fx.asOwner.query(api.accountingLedger.getJournalEntry, {
    orgId: s.fx.orgId, journalEntryId: s.moved.journalEntryId,
  });
  expect(original?.display?.sourceFamily).toBe("TREASURY_TRANSFER");
  expect(original?.lines.map((line) => line.display)).toEqual([
    { bankName: "Arab Bank Amman", transferLeg: "IN", description: "Transfer in", isReversalLine: false },
    { bankName: "Funding bank", transferLeg: "OUT", description: "Transfer out", isReversalLine: false },
  ]);

  const reversal = await s.fx.asOwner.query(api.accountingLedger.getJournalEntry, {
    orgId: s.fx.orgId, journalEntryId: s.reversed.reversalJournalEntryId,
  });
  expect(reversal?.display).toMatchObject({ isReversal: true, reversalOf: { journalNumber: s.originalNumber } });
  expect(reversal?.lines.map((line) => line.display)).toEqual([
    { bankName: "Arab Bank Amman", transferLeg: "IN", description: "Transfer in", isReversalLine: true },
    { bankName: "Funding bank", transferLeg: "OUT", description: "Transfer out", isReversalLine: true },
  ]);
  // Stored history is untouched: the line still carries the engine's own text.
  expect(reversal?.lines.map((line) => line.description)).toEqual(["[REVERSAL] Transfer in", "[REVERSAL] Transfer out"]);
}, 30_000);

test("SCRUM-1013 a cash leg reads as cash, not as an unnamed bank", async () => {
  const fx = await seed();
  const toBankAccountId = await fx.createBank("Deposit bank", "JOD", true);
  const moved = await fx.asOwner.mutation(api.bankTransfers.record, {
    orgId: fx.orgId, currency: "JOD", fromBankAccountId: null, toBankAccountId, amountMinor: 126_400,
    accountingDate: Date.now(), reference: "126.4", idempotencyKey: "scrum1013-cash-deposit",
  });
  const entry = await fx.asOwner.query(api.accountingLedger.getJournalEntry, { orgId: fx.orgId, journalEntryId: moved.journalEntryId });
  expect(entry?.display?.transfer).toEqual({ from: { kind: "CASH" }, to: { kind: "BANK", bankName: "Deposit bank" } });
  expect(entry?.lines.map((line) => line.display?.bankName ?? null)).toEqual(["Deposit bank", null]);
}, 30_000);

test("SCRUM-1013 a bank from another organization is never named on this org's journal", async () => {
  const s = await transferAndReverse();
  // Damaged cross-tenant link, written directly: the bank the line and the
  // transfer point at now belongs to another organization. No door produces
  // this (the bank-line trigger refuses a foreign bank on a posted line), so
  // the row is moved instead of the line.
  await s.fx.t.run(async (ctx) => {
    const otherOrgId = await ctx.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() });
    await ctx.db.patch(s.toBankAccountId, { orgId: otherOrgId, name: "Foreign tenant bank" });
  });

  const entry = await s.fx.asOwner.query(api.accountingLedger.getJournalEntry, {
    orgId: s.fx.orgId, journalEntryId: s.moved.journalEntryId,
  });
  const page = await s.fx.asOwner.query(api.accountingLedger.listJournalEntries, { orgId: s.fx.orgId, paginationOpts: PAGE });
  expect(entry?.lines[0]?.display?.bankName).toBeNull();
  expect(entry?.display?.transfer?.to).toEqual({ kind: "BANK", bankName: null });
  expect(JSON.stringify(entry)).not.toContain("Foreign tenant bank");
  expect(JSON.stringify(page)).not.toContain("Foreign tenant bank");
}, 30_000);
