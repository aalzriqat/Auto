import { ConvexError } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { PostCommand } from "../accounting/postingEngine";
import { createOpeningSettlementReader, type OpeningSettlementReader, resolveOpeningSettlementBasis } from "./openingSettlementBasis";
import { isOpeningCommissionAccount } from "./openingCommissionLiabilities";
import { orgResetState } from "./orgResetGeneration";

type Ctx = QueryCtx | MutationCtx;
const unavailable = () => ({ kind: "UNAVAILABLE" as const, reason: "Opening commission source is unavailable. Ask finance to reconcile it." });

export async function resolveOpeningCommissionBasis(ctx: Ctx, orgId: Id<"organizations">, liabilityId: Id<"openingCommissionLiabilities">, reader?: OpeningSettlementReader) {
  const org = await ctx.db.get(orgId);
  if (!org || orgResetState(org).inProgress) return unavailable();
  const liability = await ctx.db.get(liabilityId);
  if (!liability || liability.orgId !== orgId || liability.version !== 1 ||
      liability.sourceKey !== `opening:${liability.openingDraftId}:${liability.openingRowKey}` ||
      !Number.isSafeInteger(liability.amountMinor) || liability.amountMinor <= 0 ||
      !Number.isSafeInteger(liability.paidMinor) || (liability.paidMinor !== 0 && liability.paidMinor !== liability.amountMinor)) return unavailable();
  const source = await resolveOpeningSettlementBasis(ctx, orgId, { draftId: liability.openingDraftId, rowKey: liability.openingRowKey }, "EMPLOYEE_COMMISSION", reader);
  if (source.kind !== "AVAILABLE" || source.allocation.kind !== "EMPLOYEE_COMMISSION" ||
      source.allocation.userId !== liability.userId || source.amountMinor !== liability.amountMinor || source.currency !== liability.currency) return unavailable();
  const account = await ctx.db.get(source.accountId);
  if (!account || !isOpeningCommissionAccount(account)) return unavailable();
  if (source.result.kind !== "EMPLOYEE_COMMISSION" || source.result.openingCommissionLiabilityId !== liability._id) return unavailable();
  const siblings = await ctx.db.query("openingCommissionLiabilities").withIndex("by_org_source", q => q.eq("orgId", orgId).eq("sourceKey", liability.sourceKey)).take(2);
  if (siblings.length !== 1 || siblings[0]._id !== liability._id) return unavailable();
  if (liability.paidMinor === 0) {
    if (liability.paidAt !== undefined || liability.paidBy !== undefined || liability.paidPayrollItemId !== undefined) return unavailable();
  } else {
    if (liability.paidAt === undefined || !Number.isSafeInteger(liability.paidAt) || liability.paidAt < source.asOfDate || !liability.paidBy || !liability.paidPayrollItemId) return unavailable();
    const item = await ctx.db.get(liability.paidPayrollItemId);
    if (!item || item.orgId !== orgId || item.userId !== liability.userId || item.currency !== liability.currency ||
        !(item.openingCommissionLiabilityIds ?? []).includes(liability._id)) return unavailable();
    const run = await ctx.db.get(item.runId);
    if (!run || run.orgId !== orgId || (run.status !== "APPROVED" && run.status !== "PAID")) return unavailable();
  }
  return { kind: "AVAILABLE" as const, liability, accountId: source.accountId, basisDate: source.asOfDate };
}

export async function requireOpeningCommissionBasis(ctx: Ctx, orgId: Id<"organizations">, liabilityId: Id<"openingCommissionLiabilities">, reader?: OpeningSettlementReader) {
  const basis = await resolveOpeningCommissionBasis(ctx, orgId, liabilityId, reader);
  if (basis.kind !== "AVAILABLE") throw new ConvexError(basis.reason);
  return basis;
}

export async function requireOpeningCommissionEmployee(ctx: Ctx, orgId: Id<"organizations">, userId: Id<"users">) {
  const membership = await ctx.db.query("memberships").withIndex("by_org_user", q => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!membership || membership.offboardingStatus || !(await ctx.db.get(userId))) {
    throw new ConvexError("This opening commission remains owed, but its employee is unavailable for native payroll.");
  }
}

export type OpeningCommissionSettlement = { liabilityId: Id<"openingCommissionLiabilities">; draftId: Id<"openingBalanceDrafts">; rowKey: string; amountMinor: number };

/** Draft/approval/payment all derive from the same current debt, never a sale surrogate. */
export async function openingCommissionsForItem(ctx: Ctx, item: Pick<Doc<"payrollItems">, "orgId" | "userId" | "currency" | "openingCommissionLiabilityIds">, reader?: OpeningSettlementReader) {
  const ids = item.openingCommissionLiabilityIds ?? [];
  if (ids.length > 100 || new Set(ids).size !== ids.length) throw new ConvexError("Opening commission references require a finance review.");
  const settlements: OpeningCommissionSettlement[] = [];
  let minor = 0;
  for (const id of ids) {
    const { liability, basisDate } = await requireOpeningCommissionBasis(ctx, item.orgId, id, reader);
    if (liability.userId !== item.userId || liability.currency !== item.currency || basisDate > Date.now()) throw new ConvexError("Opening commission does not match this payslip.");
    if (liability.paidMinor === liability.amountMinor) continue;
    await requireOpeningCommissionEmployee(ctx, item.orgId, item.userId);
    minor += liability.amountMinor;
    if (!Number.isSafeInteger(minor)) throw new ConvexError("Opening commission total is unavailable.");
    settlements.push({ liabilityId: id, draftId: liability.openingDraftId, rowKey: liability.openingRowKey, amountMinor: liability.amountMinor });
  }
  return { minor, settlements };
}

export async function collectOpeningCommissions(ctx: Ctx, orgId: Id<"organizations">, currency: string, activeMembers: Set<string>, cutoff: number, suppliedReader?: OpeningSettlementReader) {
  const reader = suppliedReader ?? createOpeningSettlementReader(ctx, orgId);
  const rows = await ctx.db.query("openingCommissionLiabilities").withIndex("by_org", q => q.eq("orgId", orgId)).take(101);
  if (rows.length > 100) throw new ConvexError("Opening commissions require a finance review because their source count is unavailable.");
  const byUser = new Map<string, { minor: number; liabilityIds: Id<"openingCommissionLiabilities">[] }>();
  for (const row of rows) {
    const { liability, basisDate } = await requireOpeningCommissionBasis(ctx, orgId, row._id, reader);
    if (liability.paidMinor === liability.amountMinor || basisDate > cutoff || !activeMembers.has(liability.userId)) continue;
    if (liability.currency !== currency) throw new ConvexError("Opening commission currency differs from this payroll run.");
    await requireOpeningCommissionEmployee(ctx, orgId, liability.userId);
    const group = byUser.get(liability.userId) ?? { minor: 0, liabilityIds: [] };
    group.minor += liability.amountMinor; group.liabilityIds.push(liability._id);
    if (!Number.isSafeInteger(group.minor)) throw new ConvexError("Opening commission total is unavailable.");
    byUser.set(liability.userId, group);
  }
  return byUser;
}

const settlementSchema = z.object({ liabilityId: z.string(), draftId: z.string(), rowKey: z.string(),
  amountMinor: z.number().refine(value => Number.isSafeInteger(value) && value > 0) }).strict();
const settlementsSchema = z.array(settlementSchema).max(100);

/** Posting-time proof runs before idempotent success/queue/caught write paths. */
export async function assertOpeningCommissionPosting(ctx: Ctx, cmd: Pick<PostCommand, "orgId" | "eventType" | "sourceType" | "sourceId" | "currency" | "payload" | "idempotencyKey" | "occurredAt" | "accountingDate" | "actorId">, reader?: OpeningSettlementReader) {
  if (cmd.eventType !== "PAYROLL_PAID") return;
  const fromSource = cmd.sourceType === "payrollItems" && cmd.sourceId.startsWith("paid_") ? ctx.db.normalizeId("payrollItems", cmd.sourceId.slice(5)) : null;
  const item = fromSource ? await ctx.db.get(fromSource) : null;
  const rows = fromSource ? await ctx.db.query("openingCommissionLiabilities").withIndex("by_org_payroll_item", q => q.eq("orgId", cmd.orgId).eq("paidPayrollItemId", fromSource)).take(101) : [];
  if (rows.length > 100) throw new ConvexError("Opening commission posting proof is unavailable.");
  const linked = rows.filter(row => row.paidPayrollItemId === fromSource);
  const itemIds = item?.openingCommissionLiabilityIds ?? [];
  if (cmd.payload.openingCommissionSettlements === undefined && linked.length === 0 && itemIds.length === 0 && !(item?.openingCommissionMinor)) return;
  const parsed = settlementsSchema.safeParse(cmd.payload.openingCommissionSettlements);
  if (!parsed.success || !item || item.orgId !== cmd.orgId || item.currency !== cmd.currency || cmd.payload.itemId !== item._id ||
      cmd.payload.userId !== item.userId || cmd.idempotencyKey !== `payroll_paid_${item._id}` ||
      parsed.data.length !== linked.length || itemIds.length !== linked.length || new Set(itemIds).size !== itemIds.length) {
    throw new ConvexError("Opening commission payment occurrence is unavailable.");
  }
  let total = 0;
  const seen = new Set<string>();
  for (const settlement of parsed.data) {
    const id = ctx.db.normalizeId("openingCommissionLiabilities", settlement.liabilityId);
    if (!id || seen.has(id) || !itemIds.includes(id)) throw new ConvexError("Opening commission payment occurrence is unavailable.");
    seen.add(id);
    const { liability, basisDate } = await requireOpeningCommissionBasis(ctx, cmd.orgId, id, reader);
    if (liability.openingDraftId !== settlement.draftId || liability.openingRowKey !== settlement.rowKey || liability.amountMinor !== settlement.amountMinor ||
        liability.paidMinor !== settlement.amountMinor || liability.paidPayrollItemId !== item._id || liability.paidBy !== cmd.actorId ||
        liability.paidAt !== cmd.occurredAt || cmd.accountingDate !== cmd.occurredAt || cmd.occurredAt < basisDate || liability.userId !== item.userId) {
      throw new ConvexError("Opening commission payment occurrence is unavailable.");
    }
    total += settlement.amountMinor;
  }
  if (!Number.isSafeInteger(total) || total !== (item.openingCommissionMinor ?? 0)) throw new ConvexError("Opening commission payment amount is unavailable.");
}


export async function assertNoOpeningCommissionObligation(ctx: Ctx, orgId: Id<"organizations">, userId: Id<"users">) {
  const rows = await ctx.db.query("openingCommissionLiabilities").withIndex("by_org_user", q => q.eq("orgId", orgId).eq("userId", userId)).take(101);
  if (rows.length > 100) throw new ConvexError("Opening commission obligations require a finance review before removing this employee.");
  for (const row of rows) {
    const { liability } = await requireOpeningCommissionBasis(ctx, orgId, row._id);
    if (liability.paidMinor < liability.amountMinor) throw new ConvexError("This employee has an outstanding opening commission. Settle it through native payroll before removing them.");
  }
}


/** Historical debt follows the actual native settlement occurrence, not today's paid flag alone. */
export async function openingCommissionRemainingAsOf(ctx: Ctx, orgId: Id<"organizations">,
  liabilityId: Id<"openingCommissionLiabilities">, asOfDate: number, reader?: OpeningSettlementReader) {
  const basis = await resolveOpeningCommissionBasis(ctx, orgId, liabilityId, reader);
  if (basis.kind !== "AVAILABLE") return basis;
  const { liability } = basis;
  if (basis.basisDate > asOfDate) return { ...basis, remainingMinor: 0, settlementPosted: false };
  if (liability.paidMinor === 0 || liability.paidAt === undefined || liability.paidAt > asOfDate) {
    return { ...basis, remainingMinor: liability.amountMinor, settlementPosted: false };
  }
  const itemId = liability.paidPayrollItemId;
  if (!itemId) return unavailable();
  const events = await ctx.db.query("accountingEvents").withIndex("by_org_source", q => q.eq("orgId", orgId)
    .eq("sourceType", "payrollItems").eq("sourceId", `paid_${itemId}`)).collect();
  const forward = events.filter(event => event.eventType === "PAYROLL_PAID" && event.reversalOfEventId === undefined);
  if (forward.length > 1) return unavailable();
  const event = forward[0];
  if (!event || event.status === "PENDING" || event.status === "FAILED") {
    const queued = await ctx.db.query("pendingAccountingEvents").withIndex("by_org_idempotency", q => q.eq("orgId", orgId).eq("idempotencyKey", `payroll_paid_${itemId}`)).collect();
    if (queued.length !== 1 || (queued[0].status !== "PENDING" && queued[0].status !== "FAILED")) return unavailable();
    return { ...basis, remainingMinor: liability.amountMinor, settlementPosted: false };
  }
  if (event.status !== "POSTED" && event.status !== "REVERSED") return unavailable();
  if (event.accountingDate > asOfDate) return { ...basis, remainingMinor: liability.amountMinor, settlementPosted: false };
  const settlements = settlementsSchema.safeParse(event.payload?.openingCommissionSettlements);
  if (!settlements.success || settlements.data.filter(row => row.liabilityId === liabilityId && row.draftId === liability.openingDraftId &&
      row.rowKey === liability.openingRowKey && row.amountMinor === liability.amountMinor).length !== 1 ||
      event.payload?.itemId !== itemId || event.payload?.userId !== liability.userId || event.currency !== liability.currency ||
      event.occurredAt !== liability.paidAt || event.createdBy !== liability.paidBy) return unavailable();
  const journal = event.journalEntryId ? await ctx.db.get(event.journalEntryId) : null;
  if (!journal || journal.orgId !== orgId || journal.accountingEventId !== event._id || journal.currency !== liability.currency ||
      (journal.status !== "POSTED" && journal.status !== "REVERSED")) return unavailable();
  if (event.status === "REVERSED") {
    const reversal = event.reversedByEventId ? await ctx.db.get(event.reversedByEventId) : null;
    if (!reversal || reversal.orgId !== orgId || reversal.accountingDate <= asOfDate) return unavailable();
  }
  return { ...basis, remainingMinor: 0, settlementPosted: true };
}
