import { type Id } from "../../_generated/dataModel";
import { type MutationCtx } from "../../_generated/server";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureCommissionAccounts } from "../chartAccountsProvision";
import { postDomainEvent, isEventQueued } from "./posting";
import { makeReversalHook } from "./reversal";
import { safeAdjustmentSeq, MAX_COMMISSION_ADJUSTMENTS } from "./commissionLedger";
import { ConvexError } from "convex/values";
import { allLinesForSale } from "../../utils/dealCommissionLineReads";

type CommissionHookArgs = {
  orgId: Id<"organizations">;
  saleId: Id<"sales">;
  salespersonId: Id<"users">;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  bankAccountId?: Id<"bankAccounts">;
  actorId: Id<"users">;
  occurredAt: number;
};

/**
 * Maps the commission accounts before a commission entry tries to resolve them.
 * Scoped to the commission hooks (like ensurePayrollAccountsIfChartReady) rather
 * than added to the shared choke point, since only these events touch them.
 */
async function ensureCommissionAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensureCommissionAccounts(ctx, orgId, actorId);
  }
}

function makeCommissionHook(
  eventType: "COMMISSION_ACCRUED" | "COMMISSION_PAID",
  sourceIdPrefix: string,
  keyPrefix: string
) {
  return async (ctx: MutationCtx, args: CommissionHookArgs) => {
    await ensureCommissionAccountsIfChartReady(ctx, args.orgId, args.actorId);
    const payload: Record<string, unknown> = {
      saleId: args.saleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      salespersonId: args.salespersonId.toString(),
    };
    if (args.paymentMethod) payload.paymentMethod = args.paymentMethod;
    if (args.bankAccountId) payload.bankAccountId = args.bankAccountId.toString();
    await postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: "sales",
      sourceId: `${sourceIdPrefix}_${args.saleId}`,
      idempotencyKey: `${keyPrefix}_${args.saleId}`,
      currency: args.currency,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      payload,
    });
  };
}

export const hookCommissionAccrued = makeCommissionHook("COMMISSION_ACCRUED", "commission", "commission_accrued");

export const hookCommissionPaid = makeCommissionHook("COMMISSION_PAID", "commission_paid", "commission_paid");

/**
 * Accrues one extra deal commission line (purchase / execution / another sale
 * commission). Keyed on the LINE, not the sale, so it never collides with the
 * salesperson's own `commission_accrued_<saleId>`. The payload still names the
 * sale, which keeps the outbox guard holding it behind the sale's own entry.
 */
export async function hookDealCommissionLineAccrued(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    lineId: Id<"dealCommissionLines">;
    saleId: Id<"sales">;
    employeeId: Id<"users">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensureCommissionAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "COMMISSION_ACCRUED",
    sourceType: "dealCommissionLines",
    sourceId: args.lineId.toString(),
    idempotencyKey: `commission_line_accrued_${args.lineId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      lineId: args.lineId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      salespersonId: args.employeeId.toString(),
    },
  });
}

/**
 * Corrects an already-recognized commission by a SIGNED delta. Each correction
 * is its own economic event, so — like hookVehicleLandedCostCapitalized's
 * editToken — the source and idempotency keys carry a `sequence` discriminator
 * rather than being derived from saleId alone, which would collide on the
 * second correction and silently drop it.
 *
 * The sequence is the sale's monotonically-incremented commissionAdjustmentSeq,
 * assigned inside the same mutation as the amount change. Convex mutations are
 * serializable, so two concurrent corrections cannot be handed the same number.
 */
export async function hookCommissionAdjusted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    salespersonId: Id<"users">;
    sequence: number;
    /** New amount minus the amount currently on the books. Never the new amount. */
    deltaMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensureCommissionAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "COMMISSION_ADJUSTED",
    sourceType: "sales",
    sourceId: commissionAdjustmentSourceId(args.saleId, args.sequence),
    idempotencyKey: `commission_adjusted_${args.saleId}_${args.sequence}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      deltaMinor: args.deltaMinor,
      currency: args.currency,
      salespersonId: args.salespersonId.toString(),
    },
  });
}

/** Shared so the forward hook and its reversal can never disagree on the key. */
export function commissionAdjustmentSourceId(saleId: Id<"sales">, sequence: number): string {
  return `commission_adj_${saleId}_${sequence}`;
}

/** Reverses a COMMISSION_ACCRUED entry when the underlying sale is voided. */
export const hookCommissionReversed = makeReversalHook<{ saleId: Id<"sales"> }>({
  eventType: "COMMISSION_ACCRUED",
  sourceType: "sales",
  sourceId: (a) => `commission_${a.saleId}`,
  reversalKey: (a) => `commission_reversed_${a.saleId}`,
  pendingPostKey: (a) => `commission_accrued_${a.saleId}`,
});

/** Reverses (or cancels the queued post of) one extra deal commission line's accrual. */
export const hookDealCommissionLineReversed = makeReversalHook<{ lineId: Id<"dealCommissionLines"> }>({
  eventType: "COMMISSION_ACCRUED",
  sourceType: "dealCommissionLines",
  sourceId: (a) => a.lineId.toString(),
  reversalKey: (a) => `commission_line_reversed_${a.lineId}`,
  pendingPostKey: (a) => `commission_line_accrued_${a.lineId}`,
});

/**
 * Reverses ONE COMMISSION_ADJUSTED entry. A voided sale must back out every
 * correction as well as the original accrual — reversing only the accrual
 * leaves each adjustment's delta stranded in Commission Payable, so a sale
 * accrued at 100 and corrected to 150 would still owe 50 after cancellation.
 * Callers reverse sequences 1..commissionAdjustmentSeq; see reverseCommissionForSale.
 *
 * No account self-heal is needed on this path, despite what the comment that
 * used to sit here claimed: this runs through makeReversalHook, not
 * makeCommissionHook, so ensureCommissionAccountsIfChartReady is never called.
 * It is safe anyway — a correction can only be reversed after it posted, which
 * already resolved both commission accounts — but the stated reason was wrong.
 */
export const hookCommissionAdjustmentReversed = makeReversalHook<{ saleId: Id<"sales">; sequence: number }>({
  eventType: "COMMISSION_ADJUSTED",
  sourceType: "sales",
  sourceId: (a) => commissionAdjustmentSourceId(a.saleId, a.sequence),
  reversalKey: (a) => `commission_adj_reversed_${a.saleId}_${a.sequence}`,
  pendingPostKey: (a) => `commission_adjusted_${a.saleId}_${a.sequence}`,
});

/**
 * Backs a sale's commission out of the ledger completely: the original accrual
 * plus every correction posted against it. The single entry point for voiding a
 * commission, so no caller can reverse the accrual and forget the adjustments.
 */
export async function reverseCommissionForSale(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    adjustmentSeq: number;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<void> {
  await hookCommissionReversed(ctx, {
    orgId: args.orgId,
    saleId: args.saleId,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
  });
  // Validated, not clamped. `Math.min(NaN, MAX)` is NaN and `1 <= NaN` is
  // false, so a NaN or negative counter silently reversed the accrual alone and
  // left every correction's expense and payable posted against a sale that no
  // longer exists — the cancellation reporting success either way. A counter
  // this code cannot trust is a reason to refuse the cancellation, not to
  // reverse part of it: setCommissionAmount refuses to issue a sequence past
  // the ceiling, so a valid row can never be in this state.
  const seq = safeAdjustmentSeq(args.adjustmentSeq);
  if (seq === null) {
    throw new ConvexError(
      "This sale's commission correction count is not a usable number, so its ledger entries cannot be reversed safely. Have accounting review it before cancelling."
    );
  }
  // The counter says how many corrections there SHOULD be; the entries say how
  // many there are. Validating the counter's type and range does not make it
  // true — a row edited back to 0 while commission_adjusted_..._1 sits posted
  // passes every check, and cancellation would then reverse the accrual, walk
  // nothing, and report success, leaving that correction's expense and payable
  // on a voided sale. The divergence control excludes cancelled sales, so it
  // would never surface. So walk past the counter until the entries actually
  // run out, and reverse what is really there.
  let actualSeq = seq;
  while (actualSeq < MAX_COMMISSION_ADJUSTMENTS) {
    const next = actualSeq + 1;
    const exists =
      (await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", args.orgId).eq("idempotencyKey", `commission_adjusted_${args.saleId}_${next}`)
        )
        .first()) !== null ||
      (await isEventQueued(ctx, args.orgId, `commission_adjusted_${args.saleId}_${next}`));
    if (!exists) break;
    actualSeq = next;
  }
  for (let sequence = 1; sequence <= actualSeq; sequence++) {
    await hookCommissionAdjustmentReversed(ctx, {
      orgId: args.orgId,
      saleId: args.saleId,
      sequence,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
    });
  }
  // The extra deal commission lines are part of the same commission: back each
  // unpaid one out and mark it removed. A paid line is refused, like the
  // salesperson's own paid commission.
  const lines = await allLinesForSale(ctx, args.orgId, args.saleId);
  for (const line of lines) {
    if (line.removedAt !== undefined) continue;
    if (line.paidAt !== undefined) {
      throw new ConvexError(
        "Cannot automatically cancel a sale after a commission line has been paid. Use a manual accounting correction."
      );
    }
    await hookDealCommissionLineReversed(ctx, {
      orgId: args.orgId,
      lineId: line._id,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
    });
    await ctx.db.patch(line._id, { removedAt: args.reversalDate, removedBy: args.actorId });
  }
}
