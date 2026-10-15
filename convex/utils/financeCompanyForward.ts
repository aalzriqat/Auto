import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { AppErrorCode, throwAppError } from "./errors";
import { isForwardPlanVersion, planVersionOf } from "./financedSalePostingPlan";

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
  /** The sale plan fingerprint this payment was recorded against (SCRUM-411 P2-01), when stamped. */
  planFingerprint?: string;
  /** The reversal INTENT on the row, when one was requested (VOID = taken back, RETURNED = reported returned). */
  reversalKind?: "VOID" | "RETURNED";
}

/**
 * SCRUM-411 P2-01 - a deal that is NOT finalized yet has no frozen plan fields, so
 * the proof is judged against the plan finalize WOULD freeze: its forward due and
 * its fingerprint. `fingerprint: null` lists the versions without judging them
 * against a plan (taking a payment back, the cancel guard).
 */
export interface ProspectiveForward {
  dueMinor: number;
  fingerprint: string | null;
}

/** Versions only: for a deal with no plan yet (reversing a payment, guarding a cancel). */
export const FORWARD_VERSIONS_ONLY: ProspectiveForward = { dueMinor: 0, fingerprint: null };

export interface ForwardProof {
  /** v2 and H + C > 0 - what "due" means. False on v1, pre-plan and H + C = 0. */
  applies: boolean;
  dueMinor: number;
  state: ForwardState;
  versions: ForwardVersionProof[];
  /** The version currently ON_BOOKS, if any. */
  onBooksForwardId: Id<"financeCompanyForwards"> | null;
  /**
   * True from the moment a return is REPORTED (the row carries the RETURNED
   * intent) until a replacement is SETTLED - whether its reversal is queued,
   * failed or posted. A take-back before the transfer never opens it.
   */
  returnedExceptionOpen: boolean;
}

/** A payment that is neither settled nor gone: someone must resolve it before anything else moves. */
const FORWARD_UNSETTLED_STATES: readonly ForwardVersionState[] = [
  "POSTING_PENDING",
  "POSTING_FAILED",
  "REVERSAL_PENDING",
  "NEEDS_REPAIR",
];
export const FORWARD_UNSETTLED: ReadonlySet<ForwardVersionState> = new Set(FORWARD_UNSETTLED_STATES);

/** States that stop a cancellation of a finalized deal until they are resolved. */
export const FORWARD_BLOCKS_CANCEL: ReadonlySet<ForwardVersionState> = new Set<ForwardVersionState>([
  "ON_BOOKS",
  ...FORWARD_UNSETTLED_STATES,
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

/** A reported return whose money is owed again, whether or not its reversal has posted yet. */
export function isReportedReturn(version: Pick<ForwardVersionProof, "state" | "reversalKind">): boolean {
  return (
    version.reversalKind === "RETURNED" &&
    (version.state === "RETURNED" || version.state === "REVERSAL_PENDING" || version.state === "NEEDS_REPAIR")
  );
}

/**
 * The forward proof for one application. See the module note; states are the
 * v3 state table:
 *  - SETTLED  exactly one version ON_BOOKS whose amount equals H + C.
 *  - DUE      no version on the books or pending and H + C > 0.
 *  - NOT_DUE  v1 / pre-plan deals and H + C = 0 (the gate is satisfied).
 *  - otherwise the state of the blocking version.
 */
export async function deriveForwardState(
  ctx: QueryCtx,
  app: ForwardApp,
  prospective?: ProspectiveForward
): Promise<ForwardProof> {
  const dueMinor = prospective?.dueMinor ?? app.financeCompanyForwardDueMinor ?? 0;
  const empty: ForwardProof = {
    applies: false,
    dueMinor,
    state: "NOT_DUE",
    versions: [],
    onBooksForwardId: null,
    returnedExceptionOpen: false,
  };
  if (prospective === undefined && !isForwardPlanVersion(planVersionOf(app))) return empty;

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
      ...(row.planFingerprint === undefined ? {} : { planFingerprint: row.planFingerprint }),
      reversalKind: row.reversalKind,
    });
  }

  const onBooks = versions.filter((v) => v.state === "ON_BOOKS");
  const blocking = versions.find((v) => FORWARD_UNSETTLED.has(v.state));
  const returned = versions.some(isReportedReturn);

  let state: ForwardState;
  if (blocking !== undefined) {
    state = blocking.state as ForwardState;
  } else if (
    onBooks.length === 1 &&
    onBooks[0].amountMinor === dueMinor &&
    // A payment made before finalizing counts only against the plan it was made for.
    (prospective?.fingerprint == null || onBooks[0].planFingerprint === prospective.fingerprint)
  ) {
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
 * A coded cancel refusal. Thrown with `throwAppError(code, message)`; the EN
 * dictionary entry `ServerError_<code>` equals `message` (lib/errors.test.ts).
 */
export type ForwardCancelRefusal = { code: AppErrorCode; message: string };

const CANCEL_REFUSAL_ON_BOOKS: ForwardCancelRefusal = {
  code: AppErrorCode.FORWARD_CANCEL_ON_BOOKS,
  message:
    "The deposit and the dealership's contribution have already been paid to the finance company. A manager reports the payment as returned by the company, or an accountant records the correction, before this deal can be cancelled.",
};
const CANCEL_REFUSAL_POSTING_UNSETTLED: ForwardCancelRefusal = {
  code: AppErrorCode.FORWARD_CANCEL_POSTING_UNSETTLED,
  message:
    "The payment to the finance company is not yet settled on the books. An accountant resolves it before this deal can be cancelled.",
};
const CANCEL_REFUSAL_REVERSAL_PENDING: ForwardCancelRefusal = {
  code: AppErrorCode.FORWARD_CANCEL_REVERSAL_PENDING,
  message:
    "The reversal of the payment to the finance company is not yet posted. An accountant posts it before this deal can be cancelled.",
};
const FORWARD_MISMATCH_CANCEL_REFUSAL: ForwardCancelRefusal = {
  code: AppErrorCode.FORWARD_CANCEL_NEEDS_REPAIR,
  message:
    "The record of the payment to the finance company does not match the books. An accountant reviews it before this deal can be cancelled.",
};
/** Blocking forward state -> refusal. Any state not listed (NEEDS_REPAIR) is the mismatch refusal. */
const CANCEL_REFUSAL_BY_STATE: Readonly<Record<string, ForwardCancelRefusal>> = {
  ON_BOOKS: CANCEL_REFUSAL_ON_BOOKS,
  POSTING_PENDING: CANCEL_REFUSAL_POSTING_UNSETTLED,
  POSTING_FAILED: CANCEL_REFUSAL_POSTING_UNSETTLED,
  REVERSAL_PENDING: CANCEL_REFUSAL_REVERSAL_PENDING,
};

/**
 * True while any version of the payment to the finance company is on the books or
 * in ANY unsettled state, or the proof cannot be read (over the version limit,
 * NEEDS_REPAIR with no versions): cannot tell is live. RETURNED and REVERSED
 * versions are not live. The predicate behind `forwardCancelRefusal`.
 */
export function forwardIsLive(proof: ForwardProof): boolean {
  return proof.state === "NEEDS_REPAIR" || proof.versions.some((version) => FORWARD_BLOCKS_CANCEL.has(version.state));
}

/**
 * The CLOSED-cancellation gate. Cancelling reverses the sale, which would leave
 * a posted payment to the finance company with nothing to clear. So a forward
 * that is on the books, or in ANY unsettled state, refuses the cancel and names
 * who acts next. RETURNED and REVERSED versions do not block. No amounts.
 */
export function forwardCancelRefusal(proof: ForwardProof): ForwardCancelRefusal | null {
  if (!forwardIsLive(proof)) return null;
  const blocking = proof.versions.find((version) => FORWARD_BLOCKS_CANCEL.has(version.state));
  // Fails CLOSED: a proof that could not be read (over the version limit,
  // `deriveForwardState` returns NEEDS_REPAIR with NO versions) is not "nothing
  // blocks", it is "cannot tell", and cancelling reverses the sale.
  return (blocking && CANCEL_REFUSAL_BY_STATE[blocking.state]) ?? FORWARD_MISMATCH_CANCEL_REFUSAL;
}

export const DEPOSIT_PAID_ONWARD_REFUSAL: ForwardCancelRefusal = {
  code: AppErrorCode.DEPOSIT_PAID_ONWARD_TO_FINANCE_COMPANY,
  message:
    "This deposit has already been paid to the finance company as part of the deal's first payment. Take that payment back before the deposit is refunded, forfeited, voided or paid out.",
};

export const FORWARD_DEPOSIT_PROVENANCE_REFUSAL: ForwardCancelRefusal = {
  code: AppErrorCode.FORWARD_DEPOSIT_PROVENANCE_UNCLEAR,
  message:
    "The deposits held on this deal changed since the amount due was worked out, or cannot be tied to the payment. Review the deal and try again. Nothing has been recorded.",
};

/** More applications than this on one quote cannot be judged one by one: the guard fails closed. */
const MAX_QUOTE_APPLICATIONS = 20;

/** More slices than this on one deposit (forward versions x applications) cannot be judged: fail closed. */
const MAX_DEPOSIT_SLICES = 50;

/**
 * SCRUM-411 P2-02 - where a deposit's money is, as far as the finance company's first payment
 * is concerned. DERIVED, never stored (the same rule as the forward's own state: no label that
 * can disagree with the ledger):
 *  - NOT_FORWARDED  no forward version ever carried a slice of this deposit (cash sales, a deposit
 *                   added after the payment, a deal that never paid ahead).
 *  - FORWARDED      a slice of it sits in a forward version that is on the books or in ANY unsettled
 *                   state (the cancel-blocking states), or the proof cannot tell. The money is
 *                   with the finance company; it must be RECOVERED before it can leave here again.
 *  - RECOVERED      every slice belongs to a version that is REVERSED (taken back) or RETURNED
 *                   (reported returned), each proven by a POSTED reversal event. Spendable again.
 * A reversal that is only REQUESTED (REVERSAL_PENDING) is not recovery.
 */
export type DepositForwardDisposition = "NOT_FORWARDED" | "FORWARDED" | "RECOVERED";

/**
 * True while a COMPLETED sale holds the deal: finalize writes `status: "CLOSED"` and
 * `finalizedSaleId` together and consumes the deposit into that sale. `cancelApplication` keeps
 * `finalizedSaleId` but moves the status to CANCELLED and hands the deposit back, so the id alone
 * is not evidence that the deposit is still consumed. Anything that is not both is judged by the
 * ledger, never skipped.
 */
function consumedBySale(app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">): boolean {
  return app.status === "CLOSED" && app.finalizedSaleId !== undefined;
}

/**
 * The disposition of a deposit - or of one hold of it when `holdId` is given (a slice that names
 * another hold of the same deposit does not count; a slice that names no hold covers the whole
 * deposit). A slice of a deal whose COMPLETED sale consumed the deposit is skipped: its payment
 * is judged by the cancel gate (`forwardCancelRefusal`). Once that sale is cancelled the deposit
 * is held again, so its slice is judged by the ledger like any other.
 */
export async function depositForwardDisposition(
  ctx: QueryCtx,
  deposit: Pick<Doc<"deposits">, "_id" | "orgId">,
  holdId?: Id<"depositVehicleHolds">
): Promise<DepositForwardDisposition> {
  const slices = await ctx.db
    .query("financeCompanyForwardSlices")
    .withIndex("by_org_deposit", (q) => q.eq("orgId", deposit.orgId).eq("depositId", deposit._id))
    .take(MAX_DEPOSIT_SLICES + 1);
  if (slices.length > MAX_DEPOSIT_SLICES) return "FORWARDED";

  // One proof per deal. `"FINALIZED"`: the sale consumed the deposit, so the slice no longer speaks for it.
  const proofs = new Map<Id<"financeApplications">, ForwardProof | "FINALIZED">();
  let recovered = false;
  for (const slice of slices) {
    if (holdId !== undefined && slice.holdId !== undefined && slice.holdId !== holdId) continue;
    let proof = proofs.get(slice.applicationId);
    if (proof === undefined) {
      const application = await ctx.db.get(slice.applicationId);
      // The deal cannot be read, so its slice cannot be judged: cannot tell is FORWARDED.
      if (application === null || application.orgId !== deposit.orgId) return "FORWARDED";
      proof = consumedBySale(application) ? "FINALIZED" : await deriveForwardState(ctx, application, FORWARD_VERSIONS_ONLY);
      proofs.set(slice.applicationId, proof);
    }
    if (proof === "FINALIZED") continue;
    const version = proof.versions.find((candidate) => candidate.forwardId === slice.forwardId);
    if (version === undefined || FORWARD_BLOCKS_CANCEL.has(version.state)) return "FORWARDED";
    recovered = true;
  }
  return recovered ? "RECOVERED" : "NOT_FORWARDED";
}

/**
 * SCRUM-411 P2-02. A deposit's held amount H is paid to the finance company BEFORE the sale
 * (inside H + D) and the deposit liability stays credited until the sale journal clears it, so
 * while that deposit is FORWARDED it must not also leave as a refund, forfeiture, void, write-off,
 * released-slice payout - or be moved to another car or back to the pool (`holdId` narrows the
 * question to one released slice): H would leave twice. The way out is recovery: the payment is
 * taken back, or reported returned by the finance company, and that reversal is POSTED. A
 * request to reverse is not recovery. A claim on the finance company (keep the deposit spendable
 * against a recorded receivable) is NOT built: the route is fail-closed full return only.
 *
 * Per-slice, so a deposit the payment did not carry - one added after it was recorded - stays
 * spendable (the plan changed, so finalize refuses the stale payment on its own). A live version
 * with NO slices (recorded before slices existed) cannot say which deposits it carried, so it
 * holds back every deposit of its quote, as before. The one exception is a payment that is
 * provably contribution-only: stamped with a plan fingerprint (so recorded after slices existed)
 * and `depositPortionMinor === 0`. It carried no deposit and wrote no slice by design.
 *
 * Call it at every mutation that SPENDS or MOVES a deposit. Finalize consumes the deposit into
 * the sale through `applyHeldDeposits`, which is the intended use and is not guarded.
 */
export async function assertDepositNotInLiveForward(
  ctx: QueryCtx,
  deposit: Pick<Doc<"deposits">, "_id" | "orgId" | "quoteId">,
  holdId?: Id<"depositVehicleHolds">
): Promise<void> {
  const refusePaidOnward = (): never =>
    throwAppError(DEPOSIT_PAID_ONWARD_REFUSAL.code, DEPOSIT_PAID_ONWARD_REFUSAL.message);
  if ((await depositForwardDisposition(ctx, deposit, holdId)) === "FORWARDED") refusePaidOnward();
  const quoteId = deposit.quoteId;
  if (quoteId === undefined) return;
  const applications = await ctx.db
    .query("financeApplications")
    .withIndex("by_org_quote", (q) => q.eq("orgId", deposit.orgId).eq("quoteId", quoteId))
    .take(MAX_QUOTE_APPLICATIONS + 1);
  if (applications.length > MAX_QUOTE_APPLICATIONS) refusePaidOnward();
  for (const application of applications) {
    if (consumedBySale(application)) continue;
    const proof = await deriveForwardState(ctx, application, FORWARD_VERSIONS_ONLY);
    // An unreadable proof (over the version limit) has no versions: cannot tell, so hold.
    if (proof.versions.length === 0 && proof.state === "NEEDS_REPAIR") refusePaidOnward();
    for (const version of proof.versions) {
      if (!FORWARD_BLOCKS_CANCEL.has(version.state)) continue;
      const carried = await ctx.db
        .query("financeCompanyForwardSlices")
        .withIndex("by_org_forward", (q) => q.eq("orgId", deposit.orgId).eq("forwardId", version.forwardId))
        .take(1);
      if (carried.length > 0) continue;
      // A stamped payment that carried no deposit (H = 0, contribution only) writes no slice by design.
      const row = await ctx.db.get(version.forwardId);
      if (row !== null && row.orgId === deposit.orgId && row.planFingerprint !== undefined && row.depositPortionMinor === 0) continue;
      // Any other live version with no slices cannot say which deposits it carried: hold the whole quote.
      refusePaidOnward();
    }
  }
}

export const CUSTOMER_PAYMENT_FORWARD_LIVE_REFUSAL: ForwardCancelRefusal = {
  code: AppErrorCode.CUSTOMER_PAYMENT_FORWARD_LIVE,
  message:
    "The deposit and the dealership's contribution have already been paid to the finance company, or that payment is not yet settled on the books. Recording or taking back the customer's payment to the finance company would change the amount that was paid. A manager reports the payment as returned by the company, or takes it back, and an accountant resolves anything unsettled, before this is changed. Nothing has been changed.",
};

/**
 * SCRUM-411 P2-01 / SCRUM-766 Q2. A confirmed customer payment to the finance company lowers the
 * showroom's contribution D, and the payment the showroom makes BEFORE finalizing is exactly H + D,
 * stamped with the plan fingerprint it was made for. Changing D after that cash left (confirming or
 * taking back the customer's payment) would leave the amount paid, and its fingerprint, describing a
 * plan that no longer exists. So while ANY version of this deal's payment is on the books, or in any
 * unsettled state, or the proof cannot be read (over the version limit), the change is refused.
 * A version that is REVERSED or RETURNED - proven by a POSTED reversal - no longer blocks.
 *
 * Judged from the versions alone (`FORWARD_VERSIONS_ONLY`): the deal is not finalized, so there is
 * no plan to compare against, and a plan-version gate would read "nothing due" and pass. Scoped to
 * `app.orgId` by the proof. Call it before any write. Throws a coded refusal with no amounts.
 * Every other writer of D refuses through `assertForwardAllowsEconomicsChange`.
 */
export async function assertForwardAllowsContributionChange(ctx: QueryCtx, app: ForwardApp): Promise<void> {
  await refuseWhileForwardLive(ctx, app, CUSTOMER_PAYMENT_FORWARD_LIVE_REFUSAL);
}

/** The judgment both contribution guards share; only the refusal they throw differs. */
async function refuseWhileForwardLive(ctx: QueryCtx, app: ForwardApp, refusal: ForwardCancelRefusal): Promise<void> {
  if (forwardIsLive(await deriveForwardState(ctx, app, FORWARD_VERSIONS_ONLY))) {
    throwAppError(refusal.code, refusal.message);
  }
}

export const DEAL_ECONOMICS_FORWARD_LIVE_REFUSAL: ForwardCancelRefusal = {
  code: AppErrorCode.DEAL_ECONOMICS_FORWARD_LIVE,
  message:
    "The deposit and the dealership's contribution have already been paid to the finance company, or that payment is not yet settled on the books. This change would alter the amount that was paid. A manager reports the payment as returned by the company, or takes it back, and an accountant resolves anything unsettled, before the deal's figures are changed. Nothing has been changed.",
};

/**
 * SCRUM-411 P2-01, the shared-writer half of `assertForwardAllowsContributionChange`. Every writer of the
 * stored contribution D (the economics recompute behind the quotation, approval, first payment, gap
 * resolution, customer payment and deducted-fee commands, and the two commands that clear D) calls this with
 * the D it is about to store, BEFORE it patches. `nextContributionMinor` of `undefined` is a clear. A write
 * that leaves D exactly as it is (a deducted fee moves the expected remittance, not D) is not a change to the
 * amount paid and passes; any other change is refused while a payment is live, judged as in
 * `assertForwardAllowsContributionChange`. Throws a coded refusal with no amounts.
 *
 * It refuses by throwing, so the caller's earlier input writes in the same mutation roll back with it; a
 * caller must never catch it. Writers that sit behind the handover seal cannot reach a live payment today;
 * the check is what keeps a future or repaired path from doing so silently.
 */
export async function assertForwardAllowsEconomicsChange(
  ctx: QueryCtx,
  app: ForwardApp & { dealerContributionMinor?: number },
  nextContributionMinor: number | undefined
): Promise<void> {
  if (nextContributionMinor === app.dealerContributionMinor) return;
  await refuseWhileForwardLive(ctx, app, DEAL_ECONOMICS_FORWARD_LIVE_REFUSAL);
}

/**
 * The FINALIZE gate (SCRUM-411 P2-01). The deposit and the contribution are paid
 * to the finance company BEFORE the deal is finalized, so finalize refuses until
 * the CURRENT amount is on the books against the plan it is about to freeze.
 * `proof` is `deriveForwardState(ctx, app, { dueMinor, fingerprint })`. No amounts.
 */
export function forwardFinalizeRefusal(proof: ForwardProof): ForwardGateRefusal | null {
  const block = forwardFinalizeBlock(proof);
  return block === null ? null : forwardGateRefusal(block, "FINALIZE");
}

/**
 * Why finalize cannot proceed on this proof, as a code: the one derivation
 * behind `forwardFinalizeRefusal`'s sentence AND the cockpit's pre-finalize
 * status, so the screen names exactly the refusal the server will make.
 * STALE: a payment is on the books but against other figures than the plan
 * finalize would freeze now. `null` when nothing blocks finalize.
 */
export type ForwardFinalizeBlock =
  | "UNPAID"
  | "STALE"
  | "POSTING_PENDING"
  | "POSTING_FAILED"
  | "REVERSAL_PENDING"
  | "NEEDS_REPAIR";

export function forwardFinalizeBlock(proof: ForwardProof): ForwardFinalizeBlock | null {
  if (proof.state === "NOT_DUE" || proof.state === "SETTLED") return null;
  const unsettled = proof.versions.some((version) => FORWARD_UNSETTLED.has(version.state));
  if (proof.state === "NEEDS_REPAIR" && !unsettled && proof.versions.some((version) => version.state === "ON_BOOKS")) {
    return "STALE";
  }
  return proof.state === "DUE" ? "UNPAID" : proof.state;
}

/** Which caller is being refused: the sale (`finalizeDeal`) or the finance company's transfer. */
export type ForwardGate = "FINALIZE" | "TRANSFER";

/** A coded gate refusal: thrown with `throwAppError(code, message)`; the EN dictionary entry `ServerError_<code>` equals `message`. */
export type ForwardGateRefusal = { code: AppErrorCode; message: string };

const FORWARD_GATE_TAIL: Readonly<Record<ForwardGate, string>> = {
  FINALIZE: "before finalizing.",
  TRANSFER: "before the transfer can be confirmed.",
};

/** The accountant-owned states: the sentence, the action, and one code per gate. No amounts. */
const FORWARD_GATE_ACCOUNTANT: Readonly<
  Record<"POSTING_PENDING" | "POSTING_FAILED" | "REVERSAL_PENDING" | "NEEDS_REPAIR", { text: string; codes: Record<ForwardGate, AppErrorCode> }>
> = {
  POSTING_PENDING: {
    text: "The payment to the finance company is recorded but not yet posted to the books. An accountant must post it",
    codes: { FINALIZE: AppErrorCode.FORWARD_FINALIZE_POSTING_PENDING, TRANSFER: AppErrorCode.FORWARD_TRANSFER_POSTING_PENDING },
  },
  POSTING_FAILED: {
    text: "The payment to the finance company failed to post to the books. An accountant must resolve it",
    codes: { FINALIZE: AppErrorCode.FORWARD_FINALIZE_POSTING_FAILED, TRANSFER: AppErrorCode.FORWARD_TRANSFER_POSTING_FAILED },
  },
  REVERSAL_PENDING: {
    text: "The payment to the finance company is being reversed and the reversal is not yet posted. An accountant must post it",
    codes: { FINALIZE: AppErrorCode.FORWARD_FINALIZE_REVERSAL_PENDING, TRANSFER: AppErrorCode.FORWARD_TRANSFER_REVERSAL_PENDING },
  },
  NEEDS_REPAIR: {
    text: "The record of the payment to the finance company does not match the books. An accountant must review it",
    codes: { FINALIZE: AppErrorCode.FORWARD_FINALIZE_NEEDS_REPAIR, TRANSFER: AppErrorCode.FORWARD_TRANSFER_NEEDS_REPAIR },
  },
};

/**
 * The refusal a forward gate makes for a block, for ONE gate. Never echoes H or C
 * (finance tier). STALE is a finalize-only judgment (a payment against other
 * figures than the plan about to be frozen); the transfer gate has no plan to
 * compare, so there it is the books-mismatch refusal.
 */
export function forwardGateRefusal(block: ForwardFinalizeBlock, gate: ForwardGate): ForwardGateRefusal {
  if (block === "UNPAID") {
    return gate === "FINALIZE"
      ? {
          code: AppErrorCode.FORWARD_FINALIZE_UNPAID,
          message:
            "The deposit and contribution owed to the finance company have not been paid yet. A manager or accountant records the payment to the finance company before finalizing.",
        }
      : {
          code: AppErrorCode.FORWARD_TRANSFER_UNPAID,
          message:
            "The deposit and contribution owed to the finance company have not been paid yet. A manager or accountant records that payment before the transfer can be confirmed.",
        };
  }
  if (block === "STALE" && gate === "FINALIZE") {
    return {
      code: AppErrorCode.FORWARD_FINALIZE_STALE,
      message:
        "The payment to the finance company was recorded against different figures than this deal has now (the approved amount, the deposit or the contribution changed since). A manager or accountant takes that payment back and records it again before finalizing.",
    };
  }
  const entry = FORWARD_GATE_ACCOUNTANT[block === "STALE" ? "NEEDS_REPAIR" : block];
  return { code: entry.codes[gate], message: `${entry.text} ${FORWARD_GATE_TAIL[gate]}` };
}

/** The transfer gate's refusal for a proof state, or null when the payment is settled (or nothing is owed). */
export function forwardTransferRefusal(state: ForwardState): ForwardGateRefusal | null {
  if (state === "NOT_DUE" || state === "SETTLED") return null;
  return forwardGateRefusal(state === "DUE" ? "UNPAID" : state, "TRANSFER");
}

/**
 * The finance company's transfer is confirmed only once the payment to it is
 * proven on the books (or nothing is due), by the ONE proof - never a second
 * check. Shared by `confirmDisbursement` and `confirmSupplierDisbursement`.
 */
export async function assertForwardSettledForTransfer(ctx: QueryCtx, app: ForwardApp): Promise<void> {
  const refusal = forwardTransferRefusal((await deriveForwardState(ctx, app)).state);
  if (refusal !== null) throwAppError(refusal.code, refusal.message);
}
