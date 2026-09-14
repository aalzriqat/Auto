import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { assertSupportedDenomination, supportedCurrencyScale } from "./money";
import { MAX_LIVE_DEAL_FEE_LINES, frozenPolicyExceedsLiveCapacity } from "./dealCostLimits";

/**
 * A caller-stated denomination, validated against server authority BEFORE any
 * write (SCRUM-319). The client says what currency and scale it believes it is
 * sending minor units in; the server refuses anything it cannot vouch for —
 * an unrecognised code, a non-canonical spelling, an empty string — rather than
 * comparing it later against a stored value and calling the mismatch "wrong
 * currency" when the real fault is that the input never named one.
 */
export function assertExpectedCurrency(expectedCurrency: string, action: string): void {
  // An empty string falls out of the scale lookup like any other unknown code.
  if (
    expectedCurrency !== expectedCurrency.toUpperCase() ||
    supportedCurrencyScale(expectedCurrency) === null
  ) {
    throw new ConvexError(
      `The currency this request was entered in ("${expectedCurrency}") is not one AutoFlow can use, so ${action} would store an amount at a scale nobody verified. Reload the deal and try again.`
    );
  }
}

/**
 * Every live cost line on a deal, from ONE bounded read on
 * `by_application_voidedAt` — the index answers "live" itself, so removed
 * lines are neither read nor counted. Callers hand the lines on to the pure
 * rules below rather than reading them again: the completeness check and the
 * deductions it feeds are then judged on the same lines by construction.
 * Past the cap it refuses with nothing written; removing a line that should
 * not be there brings the deal back under it.
 */
export async function loadActiveFees(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"financeDealFees">>> {
  const live = await ctx.db
    .query("financeDealFees")
    .withIndex("by_application_voidedAt", (q) =>
      q.eq("applicationId", applicationId).eq("voidedAt", undefined)
    )
    .take(MAX_LIVE_DEAL_FEE_LINES + 1);
  if (live.length > MAX_LIVE_DEAL_FEE_LINES) {
    throw new ConvexError(
      `This deal has more than ${MAX_LIVE_DEAL_FEE_LINES} live cost lines, which is more than one read can verify. Nothing has been changed: a partial list of a deal's costs reads like the whole one. Remove the lines that should not be there to bring it back under the limit.`
    );
  }
  return live;
}

/**
 * Refuses the line that would take a deal past `MAX_LIVE_DEAL_FEE_LINES`.
 * Judged on the live lines one `loadActiveFees` read returned, by BOTH
 * writers that create a line, inside their idempotent section — so an exact
 * replay of a line already written still returns it, and the product never
 * creates the state the bounded read refuses to serve.
 */
export function assertRoomForAnotherLine(
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): void {
  if (liveFees.length >= MAX_LIVE_DEAL_FEE_LINES) {
    throw new ConvexError(
      `This deal already has ${MAX_LIVE_DEAL_FEE_LINES} live cost lines, the most one deal can carry, so ${action} is refused. Nothing has been changed; remove a line that should not be there first.`
    );
  }
}

/** The denominations carried by a deal's live money facts: cost lines and custody records. */
export async function dealMoneyFactCurrencies(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Set<string>> {
  const [fees, custody] = await Promise.all([
    loadActiveFees(ctx, applicationId),
    ctx.db
      .query("financeDealCustody")
      .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
      .collect(),
  ]);
  const currencies = new Set<string>();
  for (const fee of fees) currencies.add(fee.currency);
  for (const row of custody) currencies.add(row.currency);
  return currencies;
}

/**
 * The denomination a deal's money is recorded in, proven rather than guessed.
 *
 * The pinned `economicsCurrency` wins when present. Before the pin exists the
 * organization's verified currency is the only authority — and the FIRST money
 * fact recorded against it (an early licensing estimate, a custody advance)
 * fixes it: `orgSettings.upsert` refuses a currency change once any such row
 * exists, and every later pin has to agree with those rows. So "no pin yet" is
 * not "free to reinterpret"; it is "denominated by what was already written".
 *
 * Refuses when the facts already on the deal disagree with the currency about
 * to be used. That state is unreachable through the product (the lock closes
 * every ordering) and reachable through a raw edit, and a raw edit is exactly
 * when a write that silently picks one side would turn a visible contradiction
 * into a quiet mis-scaling.
 */
export async function resolveDealCurrency(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  action: string
): Promise<string> {
  assertSupportedDenomination(app.economicsCurrency, action);
  const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, app.orgId));
  const facts = await dealMoneyFactCurrencies(ctx, app._id);
  const contradicting = [...facts].filter((code) => code !== currency);
  if (contradicting.length > 0) {
    throw new ConvexError(
      `This deal already has costs or custody recorded in ${contradicting.join(", ")}, but ${action} would use ${currency}. A deal's money is kept in one currency; restore the organization's currency to ${contradicting[0]} or correct the records before continuing.`
    );
  }
  return currency;
}

/**
 * What a financing company withholds from the money it sends the dealership.
 *
 * One derivation, read by two callers that must never disagree: the economics
 * recompute that stores `expectedDealerRemittanceMinor`, and the posting plan
 * that opens the finance-company receivable from it. When those two were allowed
 * to differ the stored figure was computed as though nothing were ever withheld
 * — the recompute passed a literal zero — so a deal whose company netted a
 * commission out of the settlement recorded a receivable for more than it would
 * ever be paid, and nothing downstream could tell.
 *
 * Lives in its own file rather than in either caller so both can import it
 * without a cycle.
 */

/**
 * The live line that records the actual for the configured fee at
 * `templateIndex` — the one `recordTemplateFeeActual` wrote against that
 * position — or nothing. EXACT by construction: a COMPANY_TEMPLATE line with no
 * position (legacy, or written to the table by anything else) never satisfies a
 * configured row, however well its type and description happen to match.
 * Shared by the checklist (`listDealCosts.expected`) and both closure gates,
 * so the screen and the refusals cannot disagree about what "recorded" means.
 */
export function exactTemplateLine(
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  templateIndex: number
): Doc<"financeDealFees"> | undefined {
  return liveFees.find(
    (fee) =>
      fee.voidedAt === undefined &&
      fee.source === "COMPANY_TEMPLATE" &&
      fee.templateIndex === templateIndex
  );
}

/**
 * Positions in the deal's frozen `companyRuleSnapshot.feeTemplates` that have
 * no exact live line carrying an actual. Empty when nothing is configured.
 */
export function unrecordedConfiguredFeePositions(
  snapshot: Doc<"financeApplications">["companyRuleSnapshot"],
  liveFees: ReadonlyArray<Doc<"financeDealFees">>
): number[] {
  const templates = snapshot?.feeTemplates ?? [];
  const missing: number[] = [];
  templates.forEach((_template, templateIndex) => {
    const line = exactTemplateLine(liveFees, templateIndex);
    if (!line || line.actualAmountMinor === undefined) missing.push(templateIndex);
  });
  return missing;
}

/**
 * Every fee the finance company's FROZEN policy configures must have an actual
 * on the record before the deal's accounting can be established or posted.
 *
 * The expected rows are derived from the snapshot and are not lines, so the
 * line-based counts (`linesAwaitingActual`, `fullyReconciled`) cannot see a
 * configured fee nobody recorded: with two templates and one reconciled actual
 * they are satisfied. This asks the snapshot directly. A fee the company did
 * not charge is recorded as an actual of zero — a fact — not left blank.
 *
 * Applied at BOTH doors, by this one function. `classifyDealAccounting` is the
 * first; `finalizeDeal` (through `resolveFinancedSalePlan`, on every route,
 * before the plan's own coverage question) is the second — because a deal
 * classified under the OLDER rule, before this check existed, still carries
 * a valid `CLASSIFIED` flag, and finalization trusting that flag alone would
 * post the sale with every configured position unrecorded (Codex-high MEDIUM
 * on 229608039); and because a DIRECT-route deal is never asked for a
 * classification at all, so finalization is the only door its configured
 * fees are checked at. Checking at the commit point makes the rule bind from
 * this deploy forward for every deal not yet closed, whichever route it
 * takes and whichever rule it was classified under.
 *
 * Pure: it judges the live rows it is handed — each door reads them once,
 * bounded, through `loadActiveFees`, and every other rule at that door is
 * applied to the same rows. Nothing is read again here.
 */
export function assertConfiguredFeesRecorded(
  snapshot: Doc<"financeApplications">["companyRuleSnapshot"],
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): void {
  // Closure CAPACITY, not configuration policy: a frozen policy with more
  // fees than a deal can carry live can never be completed, and the count
  // below would describe that as "N fees have no actual" for as long as
  // anyone tried. Name the cause instead. A policy frozen past the
  // configuration limit but within capacity is still closeable and passes
  // through to the count. Frozen policy is never rewritten here.
  if (frozenPolicyExceedsLiveCapacity(snapshot?.feeTemplates)) {
    throw new ConvexError(
      `This deal's frozen finance-company policy configures ${snapshot?.feeTemplates?.length} fees, more than the ${MAX_LIVE_DEAL_FEE_LINES} live cost lines a deal can carry, so it cannot be closed under that policy. A frozen policy is never rewritten: correct the company's fee templates and re-create this application.`
    );
  }
  const missing = unrecordedConfiguredFeePositions(snapshot, liveFees);
  if (missing.length > 0) {
    throw new ConvexError(
      `${missing.length} fee(s) configured by this deal's finance company have no actual recorded. Record what was actually paid for each of them — zero if it was not charged — before ${action}.`
    );
  }
}

/**
 * The live cost lines the company takes out of the remittance rather than
 * billing separately.
 *
 * `deductedFromSettlement` is recorded per line and is not derivable from who
 * pays or who is paid: a dealership can bear a cost the company still bills it
 * for, and the company can withhold a cost somebody else ultimately owes. Only
 * the flag says whether this particular amount reduces the transfer.
 *
 * Pure, over the rows one `loadActiveFees` read returned.
 */
export function settlementDeductedFees(
  liveFees: ReadonlyArray<Doc<"financeDealFees">>
): Array<Doc<"financeDealFees">> {
  return liveFees.filter((row) => row.deductedFromSettlement === true);
}

/**
 * What those lines actually withhold, in minor units.
 *
 * Recorded actuals only. A line with no actual amount is an unanswered question
 * — nobody has said what was withheld — and answering it with the estimate
 * would store a remittance the company never agreed to. Contributing nothing is
 * not a claim that nothing was withheld either: `classifyDealAccounting`
 * refuses while any line is still awaiting its actual, and finalization refuses
 * an unclassified deal, so by the time this figure reaches a journal every line
 * behind it has both an actual and a reconciliation.
 *
 * Negative and non-integer amounts are ignored rather than trusted. Every
 * writer validates before storing, so one here would mean the row was written
 * around them, and a settlement that silently grew because a stored amount was
 * negative is worse than one that ignores it and fails the plan's balance check.
 *
 * A row in another DENOMINATION is not ignored — it refuses (SCRUM-319). Each
 * line carries its own `currency`, and an integer recorded as fils cannot be
 * subtracted from a remittance in cents. Ignoring it would understate what the
 * company withholds; summing it would misstate it by an order of magnitude.
 * Neither is a settlement anybody agreed to, so the caller has to say which
 * currency it is settling in, and every line has to be in it.
 */
export function settlementDeductedActualMinor(
  fees: Array<Doc<"financeDealFees">>,
  currency: string
): number {
  const foreign = fees.filter((fee) => fee.currency !== currency);
  if (foreign.length > 0) {
    const codes = [...new Set(foreign.map((fee) => fee.currency))].join(", ");
    throw new ConvexError(
      `${foreign.length} settlement-deducted cost line(s) on this deal are recorded in ${codes}, but the settlement is in ${currency}. Costs cannot be deducted across currencies; correct the lines before continuing.`
    );
  }
  let total = 0;
  for (const fee of fees) {
    const amount = fee.actualAmountMinor;
    if (amount === undefined) continue;
    if (!Number.isInteger(amount) || amount <= 0) continue;
    total += amount;
  }
  return total;
}

/** All three steps together — one bounded read, the filter, the sum — for a caller that only wants the number. */
export async function settlementDeductedTotalMinor(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">,
  currency: string
): Promise<number> {
  return settlementDeductedActualMinor(
    settlementDeductedFees(await loadActiveFees(ctx, applicationId)),
    currency
  );
}
