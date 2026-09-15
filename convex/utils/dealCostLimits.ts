import { ConvexError } from "convex/values";

/**
 * The two bounds on a deal's cost lines, kept together because they are one
 * invariant: every fee a finance company configures becomes a line the deal
 * must carry LIVE to close, so the templates one company may configure have
 * to leave room, under the live-line cap, for the additional costs a deal
 * records beside them. The two bounds are DIFFERENT questions and are asked
 * by different doors: `MAX_FEE_TEMPLATES` is configuration policy, applied
 * where a policy is written or frozen; `MAX_LIVE_DEAL_FEE_LINES` is closure
 * capacity, the only bound a policy ALREADY frozen is held to — a deal frozen
 * with more templates than the policy limit but within capacity is still
 * closeable, and is never declared otherwise. Frozen policy is never
 * rewritten by either.
 *
 * This module imports nothing of the product's, so the company writers
 * (`finance.ts`), the application snapshot (`applications.ts`) and the
 * deal-cost readers (`settlementDeductions.ts`) share it without a cycle.
 */

/**
 * Upper bound on the LIVE cost lines one deal is ever read with —
 * `.take(cap + 1)`, never `.collect()`. Everything read under it is a
 * completeness rule or a sum (a configured fee with no actual, the lines a
 * company withholds), and a prefix of the lines reads exactly like the whole,
 * so past the cap the read REFUSES rather than returns what fits. Live lines,
 * not rows: a removed line stays as a row for its trace, and a bound that
 * counted it would leave a deal unreadable for good once enough lines had
 * been added and removed — removing never lowers a row count. Far above
 * anything the product keeps live on one deal (a company's templates plus
 * the additional costs) and far below the transaction's own document limit,
 * which would fail as a platform error instead of a sentence.
 */
export const MAX_LIVE_DEAL_FEE_LINES = 500;

/**
 * Upper bound on the fee templates one finance company configures. Far above
 * any real policy — a handful of fees — and far enough under
 * `MAX_LIVE_DEAL_FEE_LINES` that a deal with every configured fee recorded
 * still has room for its additional costs.
 */
export const MAX_FEE_TEMPLATES = 100;

/**
 * How many custody records one deal's DECISION reads may carry.
 *
 * The one-open-per-person rule, the classification gate and the deal's
 * denomination proof decide on EVERY custody record of the deal, so their
 * read is not the screen's bounded prefix (`MAX_DEAL_CUSTODY_RECORDS` in
 * `financeDealCosts`, which reports truncation) — a prefix would let a second
 * open record, or a foreign-currency record, hide past the cap. Nor is it
 * unbounded: a `.collect()` grows until the platform's read limits fail the
 * mutation opaquely. So the read takes ONE past this cap and, past it,
 * REFUSES with a named reason; nothing is sampled. A deal has one custodian,
 * occasionally two; a hundred records is not a deal, it is a record that
 * needs a person.
 */
export const MAX_DEAL_CUSTODY_DECISION_RECORDS = 100;

/** Configuration policy: whether a list has more templates than one company may configure. */
export function feeTemplatesExceedConfigurationLimit(
  feeTemplates: ReadonlyArray<unknown> | undefined
): boolean {
  return feeTemplates !== undefined && feeTemplates.length > MAX_FEE_TEMPLATES;
}

/**
 * Closure capacity: whether a policy ALREADY FROZEN on a deal configures more
 * fees than the deal could ever carry live — the one case a frozen policy
 * makes closing impossible. Judged against the live-line cap, not the
 * configuration limit: a policy frozen past the latter but within the former
 * is still closeable.
 */
export function frozenPolicyExceedsLiveCapacity(
  feeTemplates: ReadonlyArray<unknown> | undefined
): boolean {
  return feeTemplates !== undefined && feeTemplates.length > MAX_LIVE_DEAL_FEE_LINES;
}

/**
 * Refuses a template list that exceeds the new-configuration policy. The
 * lower policy limit reserves room under live-line capacity for a deal's
 * additional costs. Applied where a policy is WRITTEN or FROZEN — a company
 * created, a company explicitly given a new list, an application snapshotting
 * its company — before any write. Never applied where a policy is merely read
 * or preserved: a legacy company past the policy limit still takes an
 * unrelated edit, its list carried verbatim, and is repaired by an explicit
 * compliant list; a deal already frozen past the configuration limit is held
 * only to closure capacity, by
 * `frozenPolicyExceedsLiveCapacity`.
 */
export function assertFeeTemplatesWithinLimit(
  feeTemplates: ReadonlyArray<unknown> | undefined,
  action: string
): void {
  if (feeTemplatesExceedConfigurationLimit(feeTemplates)) {
    throw new ConvexError(
      `${feeTemplates?.length} fee templates is more than the ${MAX_FEE_TEMPLATES} one finance company can configure. That policy reserves room below the deal's ${MAX_LIVE_DEAL_FEE_LINES}-line live-cost ceiling for additional costs. ${action} is refused; nothing has been changed.`
    );
  }
}
