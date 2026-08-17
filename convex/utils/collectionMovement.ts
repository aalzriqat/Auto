import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * SCRUM-121 — THE COLLECTION MOVEMENT AUTHORITY.
 *
 * One place decides which canonical debt a movement is directed at, whether the
 * caller's references agree, and whether that decision still holds when the
 * money actually arrives. Implements CONTRACT v5 (SCRUM-121 description) —
 * R1-R12. Where an earlier rule is ambiguous, R12 decides.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO BOUNDARIES BEHAVE DIFFERENTLY, AND THAT IS THE WHOLE DESIGN (R3)
 * ─────────────────────────────────────────────────────────────────────────────
 * BEFORE the money exists — create, register, manual cash — a reference that is
 * contradictory, foreign, dangling, terminal or payer-mismatched HARD-FAILS
 * ATOMICALLY. Nothing survives. `resolveTargetAtCreation` throws.
 *
 * AFTER the money is confirmed — intent settlement, cheque clearing — a target
 * that is no longer provable must NOT be allocated to and must NOT be lost.
 * `reproveTargetAtSettlement` NEVER THROWS; it returns `proven: false` and the
 * caller routes to the R6 safe harbour. A throw here would roll back the
 * confirmed receipt, and the provider would retry into the same throw forever.
 *
 * ⚠️ R12.1 — A CONFIRMED RECEIPT AND AN AR APPLICATION ARE SEPARATE QUANTITIES.
 * `requestedMinor` is what arrived. `appliedMinor` is what paid down debt. They
 * are never derived from one another, and `unappliedMinor` is the difference —
 * not a second opinion about either.
 */

/** R2 — the one permitted target, plus the provenance derived FROM it (R4/R2). */
export type ResolvedTarget = {
  /** null means "no debt was named" — an unallocated receipt (R6), not a failure. */
  targetDocumentId: Id<"receivableDocuments"> | null;
  /** The legacy row this movement came through, retained as SOURCE LINEAGE ONLY. */
  sourceReceivableId?: Id<"receivables">;
  /**
   * Provenance derives from the VERIFIED TARGET, never from an independent
   * fallback expression. `row.saleId ?? args.saleId` is the named anti-pattern
   * (R2) and does not appear anywhere in this module.
   */
  saleId?: Id<"sales">;
  vehicleId?: Id<"vehicles">;
  customerId: Id<"customers">;
};

/** R5 — ONE movement result. The same `appliedMinor` drives allocation and mirror. */
export type MovementResult = {
  targetDocumentId: Id<"receivableDocuments"> | null;
  requestedMinor: number;
  appliedMinor: number;
  unappliedMinor: number;
  sourceReceivableId?: Id<"receivables">;
  canonicalPaymentId?: Id<"canonicalPayments">;
  /** Why nothing was applied, when nothing was. Null when the target was proven. */
  unprovenReason: string | null;
};

const TERMINAL_DOCUMENT_STATUSES = ["CANCELLED", "WRITTEN_OFF", "REVERSED"] as const;

function isTerminal(status: string): boolean {
  return (TERMINAL_DOCUMENT_STATUSES as readonly string[]).includes(status);
}

/**
 * The canonical document a legacy row's money belongs to, per R2.
 *
 * A row that carries a `saleId` is a REPRESENTATION of that sale's debt, so its
 * money belongs on the sale's invoice and the row is source lineage only. Only a
 * standalone row owns its own document. This single rule is what retires the
 * duplicate authority SCRUM-56 exists to close — and it is why S4 (a sale-linked
 * row named alone) resolves to the invoice rather than to the row's twin.
 */
async function targetForLegacyRow(
  ctx: QueryCtx | MutationCtx,
  row: Doc<"receivables">,
  ensureLegacyDocument: EnsureLegacyDocument
): Promise<Id<"receivableDocuments">> {
  if (row.saleId) {
    const sale = await ctx.db.get(row.saleId);
    if (!sale || sale.orgId !== row.orgId) {
      throw new ConvexError("Receivable references a sale that is not available.");
    }
    if (sale.canonicalReceivableDocumentId) return sale.canonicalReceivableDocumentId;
    // A sale predating canonical AR has no invoice to pay down. The row still
    // owns its own document, so the money has a home; it simply is not the
    // sale's, because the sale has none.
  }
  if (row.canonicalReceivableDocumentId) return row.canonicalReceivableDocumentId;
  // Raised on demand, exactly as `main` does when a movement first touches a row
  // that predates the canonical layer. Not creating it here would refuse a
  // payment `main` accepts — SCRUM-109's unconditional twin is a separate
  // defect and its remediation does not belong in this branch.
  return await ensureLegacyDocument(row);
}

/** Supplied by the caller so the authority never imports back into `collections`. */
export type EnsureLegacyDocument = (
  row: Doc<"receivables">
) => Promise<Id<"receivableDocuments">>;

/**
 * R3 (pre-funds) + R2 + R12.6 — prove correlation and payer, or FAIL CLOSED.
 *
 * Every supplied reference is resolved to the document it implies, and they must
 * all imply the SAME document. Disagreement is refused, never reconciled by
 * preference — silently dropping one reference is not a resolution (R3).
 *
 * ⚠️ THIS THROWS BEFORE ANY WRITE. Convex mutations are atomic, so a throw here
 * leaves a whole-world delta of zero, which is what "hard-fail atomically" means
 * and what the matrix asserts.
 */
export async function resolveTargetAtCreation(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId?: Id<"customers">;
    receivableId?: Id<"receivables">;
    receivableDocumentId?: Id<"receivableDocuments">;
    saleId?: Id<"sales">;
    ensureLegacyDocument: EnsureLegacyDocument;
  }
): Promise<ResolvedTarget> {
  const implied: { from: string; documentId: Id<"receivableDocuments"> }[] = [];
  let row: Doc<"receivables"> | null = null;
  let sale: Doc<"sales"> | null = null;
  let document: Doc<"receivableDocuments"> | null = null;

  if (args.receivableId) {
    row = await ctx.db.get(args.receivableId);
    if (!row || row.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
    implied.push({
      from: "receivable",
      documentId: await targetForLegacyRow(ctx, row, args.ensureLegacyDocument),
    });
  }

  const referenceCount =
    (args.receivableId ? 1 : 0) + (args.saleId ? 1 : 0) + (args.receivableDocumentId ? 1 : 0);

  if (args.saleId) {
    sale = await ctx.db.get(args.saleId);
    if (!sale || sale.orgId !== args.orgId) throw new ConvexError("Sale not found.");
    if (sale.canonicalReceivableDocumentId) {
      implied.push({ from: "sale", documentId: sale.canonicalReceivableDocumentId });
    } else if (referenceCount > 1) {
      // A sale with no canonical invoice names no debt, so it cannot be PROVEN
      // to describe the same debt as whatever else the caller supplied. R3 says
      // an unprovable reference fails closed rather than being quietly ignored.
      throw new ConvexError(
        "The selected sale has no accounting document, so it cannot be reconciled with the other references supplied."
      );
    }
    // Supplied ALONE with no invoice, it is a counter payment tagged to a sale
    // for context: provenance the caller stated, not a debt. That is `main`'s
    // long-standing ad-hoc flow and stays working.
  }

  if (args.receivableDocumentId) {
    // Read it. `main` stored this reference completely unvalidated, which is how
    // a cross-tenant document id reached a public boundary and was only caught
    // one layer down in the subledger, after the provider had confirmed funds.
    document = await ctx.db.get(args.receivableDocumentId);
    if (!document || document.orgId !== args.orgId) {
      throw new ConvexError("Receivable document not found.");
    }
    implied.push({ from: "document", documentId: document._id });
  }

  // R6 — no debt named at all. A valid movement, not a failure.
  if (implied.length === 0) {
    const customerId = args.customerId ?? sale?.customerId;
    if (!customerId) {
      throw new ConvexError("Customer is required when no receivable is selected.");
    }
    return {
      targetDocumentId: null,
      customerId,
      // Stated by the caller and validated in-org — not invented by a fallback.
      saleId: sale?._id,
      vehicleId: sale?.vehicleId,
    };
  }

  // R3 — every supplied reference must name the same debt.
  const targetDocumentId = implied[0].documentId;
  const disagreement = implied.find((c) => String(c.documentId) !== String(targetDocumentId));
  if (disagreement) {
    throw new ConvexError(
      "The selected receivable, sale and accounting document do not describe the same debt."
    );
  }

  const target = document ?? (await ctx.db.get(targetDocumentId));
  if (!target || target.orgId !== args.orgId) {
    throw new ConvexError("Receivable document not found.");
  }
  if (isTerminal(target.status)) {
    throw new ConvexError(`This debt is ${target.status.toLowerCase()} and cannot accept payment.`);
  }

  // R3 — payer identity is proven at the same boundary as the target. Every
  // known identity must agree; a movement may not be applied to one payer's debt
  // while recorded against another's.
  const payerCandidates = [args.customerId, row?.customerId, sale?.customerId, target.customerId]
    .filter((c): c is Id<"customers"> => Boolean(c))
    .map(String);
  const payer = payerCandidates[0];
  if (payerCandidates.some((c) => c !== payer)) {
    throw new ConvexError("The payer does not match the customer this debt belongs to.");
  }
  const customerId = (args.customerId ?? row?.customerId ?? target.customerId) as Id<"customers">;
  if (!customerId) throw new ConvexError("Customer is required when no receivable is selected.");

  const payerRecord = await ctx.db.get(customerId);
  if (!payerRecord || payerRecord.orgId !== args.orgId || payerRecord.isDeleted) {
    throw new ConvexError("Customer not found.");
  }

  // R2 — provenance from the VERIFIED TARGET. When the target is a sale invoice
  // the sale is the one that owns it, never `args.saleId` as an independent
  // fallback; when it is a row's own document there is no sale, and none is
  // invented no matter what the caller passed.
  const resolvedSale = await saleOwningDocument(ctx, target);
  return {
    targetDocumentId: target._id,
    sourceReceivableId: row?._id,
    saleId: resolvedSale?._id,
    vehicleId: resolvedSale?.vehicleId ?? row?.vehicleId,
    customerId,
  };
}

/**
 * The sale a canonical document belongs to, or null. Derived from the document's
 * own `sourceType`/`sourceId`, so provenance can never disagree with the target.
 */
async function saleOwningDocument(
  ctx: QueryCtx | MutationCtx,
  document: Doc<"receivableDocuments">
): Promise<Doc<"sales"> | null> {
  // `saleCompletion.ts:1277` writes the sale invoice with sourceType "sales".
  if (document.sourceType !== "sales") return null;
  const sale = await ctx.db.get(document.sourceId as Id<"sales">);
  if (!sale || sale.orgId !== document.orgId) return null;
  return sale;
}

/** R5 — the live ACTIVE applied total for a canonical payment. Never a pointer. */
export async function activeAppliedMinorForPayment(
  ctx: QueryCtx | MutationCtx,
  paymentId: Id<"canonicalPayments">
): Promise<number> {
  const allocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();
  return allocations.reduce((sum, a) => sum + a.amountMinor, 0);
}

/**
 * R3 (post-confirmation) — re-prove the target when the money has ALREADY
 * arrived. NEVER THROWS.
 *
 * The caller has confirmed funds. If the target can no longer be proven, the
 * money is still real and must be recorded; it simply pays nothing down. That is
 * the R6 safe harbour, and `proven: false` is how this function says so.
 *
 * ⚠️ Re-proving means the TARGET and the PAYER, never merely the amount. A
 * cheque-amount comparison passes unchanged while the sale behind the invoice is
 * cancelled or the payer is deleted — both measured, both red before this.
 */
export async function reproveTargetAtSettlement(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    targetDocumentId: Id<"receivableDocuments"> | null;
    customerId: Id<"customers">;
    requestedMinor: number;
  }
): Promise<{ proven: boolean; reason: string | null; allocatableMinor: number }> {
  if (!args.targetDocumentId) {
    return { proven: false, reason: "no debt was named", allocatableMinor: 0 };
  }

  const target = await ctx.db.get(args.targetDocumentId);
  if (!target || target.orgId !== args.orgId) {
    return { proven: false, reason: "the target debt no longer exists", allocatableMinor: 0 };
  }
  if (isTerminal(target.status)) {
    return {
      proven: false,
      reason: `the target debt is ${target.status.toLowerCase()}`,
      allocatableMinor: 0,
    };
  }

  const payer = await ctx.db.get(args.customerId);
  if (!payer || payer.orgId !== args.orgId || payer.isDeleted) {
    return { proven: false, reason: "the payer can no longer be proven", allocatableMinor: 0 };
  }
  if (target.customerId && String(target.customerId) !== String(args.customerId)) {
    return { proven: false, reason: "the payer no longer matches the debt", allocatableMinor: 0 };
  }

  // R3 — target still proven but owing less: allocate the LIVE outstanding and
  // leave the remainder unapplied. One clamp, computed once, here.
  const allocated = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", target._id))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();
  const outstandingMinor = Math.max(
    0,
    target.originalAmountMinor - allocated.reduce((s, a) => s + a.amountMinor, 0)
  );

  return {
    proven: true,
    reason: null,
    allocatableMinor: Math.min(args.requestedMinor, outstandingMinor),
  };
}

/**
 * R12.5 / R8 — the cheque's own movement row, reached by its typed link.
 *
 * Identity follows `chequeId` and then `canonicalPaymentId` plus ACTIVE
 * allocations. Never recency, never amount matching, never cheque-number text,
 * never a guessed idempotency key.
 */
export async function movementRowForCheque(
  ctx: QueryCtx | MutationCtx,
  chequeId: Id<"postDatedCheques">
): Promise<Doc<"collectionPayments"> | null> {
  return await ctx.db
    .query("collectionPayments")
    .withIndex("by_cheque", (q) => q.eq("chequeId", chequeId))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();
}

/**
 * R12.6 — missing lineage refuses BEFORE any status, GL, payment, allocation or
 * balance change. The refusal precedes every write, not merely the money ones.
 *
 * Partial recovery is forbidden: on `main` the reversal sat inside
 * `if (clearedPayment)` while the debt was reopened outside it, so a cheque
 * could be marked RETURNED with the money never reversed AND the debt inflated.
 * Called first, this makes that state unreachable.
 */
export function assertChequeLineagePresent(
  movementRow: Doc<"collectionPayments"> | null
): asserts movementRow is Doc<"collectionPayments"> {
  if (!movementRow) {
    throw new ConvexError(
      "This cheque has no recorded payment movement, so its money cannot be reversed. Resolve the missing record before returning the cheque."
    );
  }
}
