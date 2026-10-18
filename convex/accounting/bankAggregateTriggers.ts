import { Triggers } from "convex-helpers/server/triggers";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { SYSTEM_KEYS } from "../utils/defaultChart";
import {
  addBankControlLine,
  bankAggregateNamespace,
  clearBankAggregateNamespace,
  removeBankControlLine,
  type BankAggregateLine,
} from "./bankLineAggregate";

const MAX_GROSS_MINOR = Number.MAX_SAFE_INTEGER;

function refuseBankLine(reason: string): never {
  console.error("Bank-control journal line rejected", reason);
  throw new Error("Accounting data could not be verified. Please try again later.");
}

function projected(line: Doc<"journalLines">): BankAggregateLine {
  const netMinor = line.debitMinor - line.creditMinor;
  if (
    !Number.isSafeInteger(line.debitMinor) || !Number.isSafeInteger(line.creditMinor) ||
    line.debitMinor < 0 || line.creditMinor < 0 ||
    (line.debitMinor > 0 && line.creditMinor > 0) ||
    !Number.isSafeInteger(netMinor)
  ) {
    refuseBankLine("Invalid minor-unit amounts");
  }
  return {
    id: line._id,
    accountId: line.accountId,
    currency: line.currency,
    accountingDate: line.accountingDate,
    bankAccountId: line.bankAccountId,
    netMinor,
  };
}

function storedProjection(item: Doc<"bankBalanceAggregateItems">): BankAggregateLine {
  return {
    id: item.journalLineId,
    accountId: item.accountId,
    currency: item.currency,
    accountingDate: item.accountingDate,
    bankAccountId: item.bankAccountId,
    netMinor: item.netMinor,
  };
}

function sameProjection(item: Doc<"bankBalanceAggregateItems">, line: Doc<"journalLines">): boolean {
  return item.accountId === line.accountId && item.currency === line.currency &&
    item.accountingDate === line.accountingDate && item.bankAccountId === line.bankAccountId &&
    item.netMinor === line.debitMinor - line.creditMinor;
}

function generation(org: Doc<"organizations">) {
  return {
    mapping: org.bankAggregateMappingGeneration ?? 0,
    reset: org.financialResetGeneration ?? 0,
  };
}

async function bumpGeneration(ctx: MutationCtx, orgId: Id<"organizations">): Promise<void> {
  const org = await ctx.db.get(orgId);
  if (!org) return;
  await ctx.db.patch(orgId, { bankAggregateMappingGeneration: (org.bankAggregateMappingGeneration ?? 0) + 1 });
}

async function validatePostedLine(
  ctx: MutationCtx,
  line: Doc<"journalLines">,
  chart: Doc<"chartOfAccounts">,
  allowLegacyUnattributed: boolean,
): Promise<boolean> {
  const entry = await ctx.db.get(line.journalEntryId);
  if (!entry || entry.orgId !== line.orgId || chart.orgId !== line.orgId || entry.currency !== line.currency) {
    refuseBankLine("Parent, chart, tenant, or currency mismatch");
  }
  if (entry.status !== "POSTED" && entry.status !== "REVERSED") return false;
  const period = entry.periodId ? await ctx.db.get(entry.periodId) : null;
  if (
    !period || period.orgId !== line.orgId ||
    line.accountingDate !== entry.accountingDate ||
    line.accountingDate < period.startDate || line.accountingDate > period.endDate
  ) {
    refuseBankLine("Line date or period differs from posted entry");
  }
  if (!line.bankAccountId && !allowLegacyUnattributed && !(await isExactLegacyReversal(ctx, line, entry))) {
    refuseBankLine("Missing physical bank identity on live write");
  }
  if (line.bankAccountId) {
    const bank = await ctx.db.get(line.bankAccountId);
    if (!bank || bank.orgId !== line.orgId || bank.currency !== line.currency) {
      refuseBankLine("Physical bank tenant or currency mismatch");
    }
  }
  return true;
}

// Old dimensionless bank lines must remain unmatched, including when reversed.
// Permit only the exact inverse of an existing legacy line, never a new
// dimensionless bank posting disguised as a reversal.
async function isExactLegacyReversal(
  ctx: MutationCtx,
  line: Doc<"journalLines">,
  entry: Doc<"journalEntries">,
): Promise<boolean> {
  if (entry.category !== "REVERSAL" || !entry.reversalOfJournalEntryId || !entry.accountingEventId) return false;
  const original = await ctx.db.get(entry.reversalOfJournalEntryId);
  if (!original || original.orgId !== line.orgId || original.currency !== line.currency ||
      !original.accountingEventId || (original.status !== "POSTED" && original.status !== "REVERSED")) return false;
  const reversalEvent = await ctx.db.get(entry.accountingEventId);
  if (!reversalEvent || reversalEvent.orgId !== line.orgId ||
      reversalEvent.eventType !== "JOURNAL_REVERSAL" ||
      reversalEvent.reversalOfEventId !== original.accountingEventId) return false;
  const originals = await ctx.db.query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", original._id)).take(101);
  if (originals.length > 100) return false;
  const source = originals.find((candidate) => candidate.lineNumber === line.lineNumber);
  return !!source && !source.bankAccountId && source.orgId === line.orgId &&
    source.accountId === line.accountId && source.currency === line.currency &&
    source.debitMinor === line.creditMinor && source.creditMinor === line.debitMinor;
}

async function stateForLiveLine(
  ctx: MutationCtx,
  line: Doc<"journalLines">,
  org: Doc<"organizations">,
): Promise<{ _id: Id<"bankBalanceAggregateStates">; grossAbsMinor: number; mappingGeneration: number; resetGeneration: number }> {
  const gen = generation(org);
  const existing = await ctx.db.query("bankBalanceAggregateStates")
    .withIndex("by_org", (q) => q.eq("orgId", line.orgId)).unique();
  if (existing && existing.controlAccountId === line.accountId &&
      existing.mappingGeneration === gen.mapping && existing.resetGeneration === gen.reset) {
    return existing;
  }
  const firstTwo = await ctx.db.query("journalLines")
    .withIndex("by_org_account", (q) => q.eq("orgId", line.orgId).eq("accountId", line.accountId))
    .take(2);
  const emptyBeforeThisInsert = !existing && firstTwo.length === 1 && firstTwo[0]._id === line._id;
  const fields = {
    orgId: line.orgId,
    controlAccountId: line.accountId,
    mappingGeneration: gen.mapping,
    resetGeneration: gen.reset,
    status: emptyBeforeThisInsert ? "READY" as const : "BACKFILL_REQUIRED" as const,
    grossAbsMinor: 0,
    cursor: undefined,
    updatedAt: Date.now(),
  };
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    return { ...existing, ...fields };
  }
  const id = await ctx.db.insert("bankBalanceAggregateStates", fields);
  return { _id: id, grossAbsMinor: 0, mappingGeneration: gen.mapping, resetGeneration: gen.reset };
}

export async function onBankLineChange(
  ctx: MutationCtx,
  oldLine: Doc<"journalLines"> | null,
  newLine: Doc<"journalLines"> | null,
  allowLegacyUnattributed = false,
): Promise<void> {
  const lineId = newLine?._id ?? oldLine?._id;
  if (!lineId) return;
  const item = await ctx.db.query("bankBalanceAggregateItems")
    .withIndex("by_line", (q) => q.eq("journalLineId", lineId)).unique();
  if (item && newLine && sameProjection(item, newLine)) {
    const org = await ctx.db.get(newLine.orgId);
    if (org) {
      const gen = generation(org);
      if (item.namespace === bankAggregateNamespace(newLine.orgId, gen.reset, gen.mapping)) return;
    }
  }

  if (item) {
    await removeBankControlLine(ctx, storedProjection(item), item.namespace);
    await ctx.db.delete(item._id);
    const state = await ctx.db.query("bankBalanceAggregateStates")
      .withIndex("by_org", (q) => q.eq("orgId", item.orgId)).unique();
    if (state && item.namespace === bankAggregateNamespace(item.orgId, state.resetGeneration, state.mappingGeneration)) {
      await ctx.db.patch(state._id, { grossAbsMinor: state.grossAbsMinor - item.absMinor, updatedAt: Date.now() });
    }
  }
  if (!newLine) return;

  const chart = await ctx.db.get(newLine.accountId);
  if (!chart || chart.systemKey !== SYSTEM_KEYS.BANK_ACCOUNT) return;
  if (!(await validatePostedLine(ctx, newLine, chart, allowLegacyUnattributed))) return;
  const org = await ctx.db.get(newLine.orgId);
  if (!org) throw new Error("Bank-control line has no organization.");
  const state = await stateForLiveLine(ctx, newLine, org);
  const projection = projected(newLine);
  const absMinor = Math.abs(projection.netMinor);
  const grossAbsMinor = state.grossAbsMinor + absMinor;
  if (!Number.isSafeInteger(grossAbsMinor) || grossAbsMinor > MAX_GROSS_MINOR) {
    throw new Error("Bank-control aggregate would exceed exact integer precision.");
  }
  const namespace = bankAggregateNamespace(newLine.orgId, state.resetGeneration, state.mappingGeneration);
  await addBankControlLine(ctx, projection, namespace);
  await ctx.db.insert("bankBalanceAggregateItems", {
    orgId: newLine.orgId,
    journalLineId: newLine._id,
    namespace,
    accountId: newLine.accountId,
    currency: newLine.currency,
    accountingDate: newLine.accountingDate,
    bankAccountId: newLine.bankAccountId,
    netMinor: projection.netMinor,
    absMinor,
  });
  await ctx.db.patch(state._id, { grossAbsMinor, updatedAt: Date.now() });
}

export function registerBankBalanceTriggers<Ctx extends MutationCtx>(triggers: Triggers<DataModel, Ctx>): void {
  triggers.register("journalLines", async (ctx, change) => {
    await onBankLineChange(ctx, change.oldDoc, change.newDoc);
  });
  triggers.register("journalEntries", async (ctx, change) => {
    if (change.operation !== "update") return;
    const before = change.oldDoc;
    const after = change.newDoc;
    if (before.status !== after.status &&
        (before.status === "POSTED" || after.status === "POSTED" ||
         before.status === "REVERSED" || after.status === "REVERSED") &&
        !(before.status === "POSTED" && after.status === "REVERSED")) {
      await bumpGeneration(ctx, after.orgId);
    } else if (before.accountingDate !== after.accountingDate || before.periodId !== after.periodId || before.orgId !== after.orgId) {
      await bumpGeneration(ctx, after.orgId);
    }
  });
  triggers.register("chartOfAccounts", async (ctx, change) => {
    if (change.operation !== "update") return;
    if (change.oldDoc.systemKey !== change.newDoc.systemKey ||
        change.oldDoc.active !== change.newDoc.active ||
        change.oldDoc.currencyRestriction !== change.newDoc.currencyRestriction) {
      await bumpGeneration(ctx, change.newDoc.orgId);
    }
  });
  triggers.register("accountingPeriods", async (ctx, change) => {
    if (change.operation !== "update") return;
    if (change.oldDoc.startDate !== change.newDoc.startDate || change.oldDoc.endDate !== change.newDoc.endDate) {
      await bumpGeneration(ctx, change.newDoc.orgId);
    }
  });
  triggers.register("organizations", async (ctx, change) => {
    const before = change.oldDoc;
    if (!before) return;
    const after = change.newDoc;
    if (after && before.bankAggregateMappingGeneration === after.bankAggregateMappingGeneration &&
        before.financialResetGeneration === after.financialResetGeneration) return;
    await clearBankAggregateNamespace(ctx, bankAggregateNamespace(
      before._id,
      before.financialResetGeneration ?? 0,
      before.bankAggregateMappingGeneration ?? 0,
    ));
  });
}
