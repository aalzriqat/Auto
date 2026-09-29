import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { planVersionOf } from "./financedSalePostingPlan";

/**
 * SCRUM-435 - the ONE proof that the dealership has (or has not) forwarded the
 * customer's deposit and its own contribution to the finance company.
 *
 * Every consumer asks THIS: the transfer gate in `confirmDisbursement`, the
 * CLOSED cancellation gate, replacement eligibility, the deal cockpit query,
 * closing readiness and the stage rail. There is no second implementation, so
 * no two screens can disagree about whether the forward happened.
 *
 * The state is DERIVED from the exact versioned accounting events read by their
 * stored idempotency keys - never from a label on the forward row, never from
 * `.first()` on a source. The row carries facts and reversal INTENT only.
 */

/** The most forward versions one deal may carry; beyond it the proof refuses. */
export const MAX_FORWARD_VERSIONS = 10;

export const forwardPostKey = (applicationId: Id<"financeApplications">, version: number): string =>
  `finance_company_forward_${applicationId}_v${version}`;
export const forwardReversalKey = (applicationId: Id<"financeApplications">, version: number): string =>
  `finance_company_forward_reversal_${applicationId}_v${version}`;

export type ForwardVersionState =
  | "POSTING_PENDING"
  | "POSTING_FAILED"
  | "ON_BOOKS"
  | "REVERSAL_PENDING"
  | "REVERSED"
  | "RETURNED"
  | "NEEDS_REPAIR";

export type ForwardState =
  | "NOT_DUE"
  | "DUE"
  | "SETTLED"
  | "POSTING_PENDING"
  | "POSTING_FAILED"
  | "REVERSAL_PENDING"
  | "NEEDS_REPAIR";

export interface ForwardVersionProof {
  forwardId: Id<"financeCompanyForwards">;
  version: number;
  state: ForwardVersionState;
  amountMinor: number;
}

export interface ForwardProof {
  /** v2 and H + C > 0 - what "due" means. False on v1, pre-plan and H + C = 0. */
  applies: boolean;
  dueMinor: number;
  state: ForwardState;
  versions: ForwardVersionProof[];
  /** The version currently ON_BOOKS, if any. */
  onBooksForwardId: Id<"financeCompanyForwards"> | null;
  /** True when a RETURNED version exists and no replacement is SETTLED. */
  returnedExceptionOpen: boolean;
}

/** States that stop a cancellation of a finalized deal until they are resolved. */
export const FORWARD_BLOCKS_CANCEL: ReadonlySet<ForwardVersionState> = new Set([
  "ON_BOOKS",
  "POSTING_PENDING",
  "POSTING_FAILED",
  "REVERSAL_PENDING",
  "NEEDS_REPAIR",
]);

type ForwardApp = Pick<
  Doc<"financeApplications">,
  | "_id"
  | "orgId"
  | "financedSalePlanVersion"
  | "financedSaleRecognitionFingerprint"
  | "financeCompanyForwardDueMinor"
>;

async function versionState(
  ctx: QueryCtx,
  row: Doc<"financeCompanyForwards">
): Promise<ForwardVersionState> {
  const postKey = forwardPostKey(row.applicationId, row.version);
  const reversalKey = forwardReversalKey(row.applicationId, row.version);

  const originals = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", row.orgId).eq("idempotencyKey", postKey))
    .take(2);
  if (originals.length > 1) return "NEEDS_REPAIR";
  const original = originals[0];

  const queuedRows = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", row.orgId).eq("idempotencyKey", postKey))
    .take(2);
  if (queuedRows.length > 1) return "NEEDS_REPAIR";
  const queuedPost = queuedRows[0]?.kind === "POST" && queuedRows[0].status !== "POSTED" ? queuedRows[0] : undefined;

  const reversalRequested = row.reversalRequestedAt !== undefined;
  const reversedState: ForwardVersionState = row.reversalKind === "RETURNED" ? "RETURNED" : "REVERSED";

  if (original === undefined) {
    if (queuedPost !== undefined) {
      return queuedPost.status === "FAILED" ? "POSTING_FAILED" : "POSTING_PENDING";
    }
    // Nothing on the books and nothing queued. Legitimate only for a forward
    // that was voided BEFORE it ever posted (the queued post was cancelled).
    if (reversalRequested && row.reversalKind === "VOID") return "REVERSED";
    return "NEEDS_REPAIR";
  }

  if (original.eventType !== "FINANCE_COMPANY_FORWARD_PAID" || original.orgId !== row.orgId) {
    return "NEEDS_REPAIR";
  }

  if (original.status === "FAILED") return "POSTING_FAILED";
  if (original.status === "PENDING") return "POSTING_PENDING";

  if (original.status === "POSTED") {
    if (!reversalRequested) return "ON_BOOKS";
    // Reversal requested while the original is still POSTED: the reversal is
    // queued (no open period) or failed.
    const reversalQueued = await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_idempotency", (q) =>
        q.eq("orgId", row.orgId).eq("idempotencyKey", row.reversalIdempotencyKey ?? reversalKey)
      )
      .take(2);
    if (reversalQueued.length === 1 && reversalQueued[0].kind === "REVERSE") {
      return reversalQueued[0].status === "FAILED" ? "NEEDS_REPAIR" : "REVERSAL_PENDING";
    }
    return "NEEDS_REPAIR";
  }

  if (original.status === "REVERSED") {
    // Completion proof: the reversal event is linked from the original AND is
    // the exact event stored under the reversal key, POSTED.
    if (original.reversedByEventId === undefined) return "NEEDS_REPAIR";
    const linked = await ctx.db.get(original.reversedByEventId);
    if (
      linked === null ||
      linked.orgId !== row.orgId ||
      linked.status !== "POSTED" ||
      linked.reversalOfEventId !== original._id ||
      linked.idempotencyKey !== (row.reversalIdempotencyKey ?? reversalKey)
    ) {
      return "NEEDS_REPAIR";
    }
    return reversedState;
  }
  return "NEEDS_REPAIR";
}

/**
 * The forward proof for one application. See the module note; states are the
 * v3 state table:
 *  - SETTLED  exactly one version ON_BOOKS whose amount equals H + C.
 *  - DUE      no version on the books or pending and H + C > 0.
 *  - NOT_DUE  v1 / pre-plan deals and H + C = 0 (the gate is satisfied).
 *  - otherwise the state of the blocking version.
 */
export async function deriveForwardState(ctx: QueryCtx, app: ForwardApp): Promise<ForwardProof> {
  const dueMinor = app.financeCompanyForwardDueMinor ?? 0;
  const empty: ForwardProof = {
    applies: false,
    dueMinor,
    state: "NOT_DUE",
    versions: [],
    onBooksForwardId: null,
    returnedExceptionOpen: false,
  };
  if (planVersionOf(app) !== 2) return empty;

  const rows = await ctx.db
    .query("financeCompanyForwards")
    .withIndex("by_org_application", (q) => q.eq("orgId", app.orgId).eq("applicationId", app._id))
    .take(MAX_FORWARD_VERSIONS + 1);

  if (rows.length > MAX_FORWARD_VERSIONS) {
    return { ...empty, applies: true, state: "NEEDS_REPAIR" };
  }
  if (dueMinor <= 0 && rows.length === 0) return empty;

  const versions: ForwardVersionProof[] = [];
  for (const row of [...rows].sort((a, b) => a.version - b.version)) {
    versions.push({
      forwardId: row._id,
      version: row.version,
      state: await versionState(ctx, row),
      amountMinor: row.amountMinor,
    });
  }

  const onBooks = versions.filter((v) => v.state === "ON_BOOKS");
  const blocking = versions.find(
    (v) => v.state === "POSTING_PENDING" || v.state === "POSTING_FAILED" || v.state === "REVERSAL_PENDING" || v.state === "NEEDS_REPAIR"
  );
  const returned = versions.some((v) => v.state === "RETURNED");

  let state: ForwardState;
  if (blocking !== undefined) {
    state = blocking.state as ForwardState;
  } else if (onBooks.length === 1 && onBooks[0].amountMinor === dueMinor) {
    state = "SETTLED";
  } else if (onBooks.length > 0) {
    state = "NEEDS_REPAIR";
  } else if (dueMinor > 0) {
    state = "DUE";
  } else {
    state = "NOT_DUE";
  }

  return {
    applies: dueMinor > 0 || versions.length > 0,
    dueMinor,
    state,
    versions,
    onBooksForwardId: onBooks.length === 1 ? onBooks[0].forwardId : null,
    returnedExceptionOpen: returned && state !== "SETTLED",
  };
}

/**
 * The CLOSED-cancellation gate. Cancelling reverses the sale, which would leave
 * a posted payment to the finance company with nothing to clear. So a forward
 * that is on the books, or in ANY unsettled state, refuses the cancel and names
 * who acts next. RETURNED and REVERSED versions do not block. No amounts.
 */
export function forwardCancelRefusal(proof: ForwardProof): string | null {
  const blocking = proof.versions.find((version) => FORWARD_BLOCKS_CANCEL.has(version.state));
  if (blocking === undefined) return null;
  switch (blocking.state) {
    case "ON_BOOKS":
      return "The deposit and the dealership's contribution have already been paid to the finance company. A manager reports the payment as returned by the company, or an accountant records the correction, before this deal can be cancelled.";
    case "POSTING_PENDING":
    case "POSTING_FAILED":
      return "The payment to the finance company is not yet settled on the books. An accountant resolves it before this deal can be cancelled.";
    case "REVERSAL_PENDING":
      return "The reversal of the payment to the finance company is not yet posted. An accountant posts it before this deal can be cancelled.";
    default:
      return "The record of the payment to the finance company does not match the books. An accountant reviews it before this deal can be cancelled.";
  }
}

/** A refusal message for a gate that must not echo H or C (finance tier). */
export function forwardGateRefusal(state: ForwardState): string | null {
  switch (state) {
    case "NOT_DUE":
    case "SETTLED":
      return null;
    case "DUE":
      return "The deposit and contribution owed to the finance company have not been paid yet. A manager or accountant records that payment before the transfer can be confirmed.";
    case "POSTING_PENDING":
      return "The payment to the finance company is recorded but not yet posted to the books. An accountant must post it before the transfer can be confirmed.";
    case "POSTING_FAILED":
      return "The payment to the finance company failed to post to the books. An accountant must resolve it before the transfer can be confirmed.";
    case "REVERSAL_PENDING":
      return "The payment to the finance company is being reversed and the reversal is not yet posted. An accountant must post it before the transfer can be confirmed.";
    case "NEEDS_REPAIR":
      return "The record of the payment to the finance company does not match the books. An accountant must review it before the transfer can be confirmed.";
  }
}
