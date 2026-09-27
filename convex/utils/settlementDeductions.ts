import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { assertSupportedDenomination, supportedCurrencyScale } from "./money";
import { reconcileEmployeeCustody } from "../../lib/financingEconomics";
import { isMinorAmount } from "./financingEconomics";
import {
  MAX_DEAL_CUSTODY_DECISION_RECORDS,
  MAX_LIVE_DEAL_FEE_LINES,
  frozenPolicyExceedsLiveCapacity,
} from "./dealCostLimits";

export function assertExpectedCurrency(expectedCurrency: string, action: string): void {
  if (expectedCurrency !== expectedCurrency.toUpperCase() || supportedCurrencyScale(expectedCurrency) === null) {
    throw new ConvexError(`The currency this request was entered in ("${expectedCurrency}") is not one AutoFlow can use, so ${action} would store an amount at a scale nobody verified. Reload the deal and try again.`);
  }
}

export async function loadActiveFees(ctx: QueryCtx | MutationCtx, applicationId: Id<"financeApplications">): Promise<Array<Doc<"financeDealFees">>> {
  const live = await ctx.db.query("financeDealFees").withIndex("by_application_voidedAt", (q) => q.eq("applicationId", applicationId).eq("voidedAt", undefined)).take(MAX_LIVE_DEAL_FEE_LINES + 1);
  if (live.length > MAX_LIVE_DEAL_FEE_LINES) throw new ConvexError(`This deal has more than ${MAX_LIVE_DEAL_FEE_LINES} live cost lines, which is more than one read can verify. Nothing has been changed: a partial list of a deal's costs reads like the whole one. Remove the lines that should not be there to bring it back under the limit.`);
  return live;
}

export function assertRoomForAnotherLine(liveFees: ReadonlyArray<Doc<"financeDealFees">>, action: string): void {
  if (liveFees.length >= MAX_LIVE_DEAL_FEE_LINES) throw new ConvexError(`This deal already has ${MAX_LIVE_DEAL_FEE_LINES} live cost lines, the most one deal can carry, so ${action} is refused. Nothing has been changed; remove a line that should not be there first.`);
}

export async function loadCustodyRecords(ctx: QueryCtx | MutationCtx, applicationId: Id<"financeApplications">, action: string): Promise<Array<Doc<"financeDealCustody">>> {
  const rows = await ctx.db.query("financeDealCustody").withIndex("by_application", (q) => q.eq("applicationId", applicationId)).take(MAX_DEAL_CUSTODY_DECISION_RECORDS + 1);
  if (rows.length > MAX_DEAL_CUSTODY_DECISION_RECORDS) throw new ConvexError(`This deal carries more than ${MAX_DEAL_CUSTODY_DECISION_RECORDS} custody records, which is past what ${action} can decide on completely; nothing has been changed. Have the deal's custody reviewed.`);
  return rows;
}

export async function dealMoneyFactCurrencies(ctx: QueryCtx | MutationCtx, applicationId: Id<"financeApplications">): Promise<Set<string>> {
  const [fees, custody] = await Promise.all([loadActiveFees(ctx, applicationId), loadCustodyRecords(ctx, applicationId, "proving this deal's currency")]);
  const currencies = new Set<string>();
  for (const fee of fees) currencies.add(fee.currency);
  for (const row of custody) currencies.add(row.currency);
  return currencies;
}

export async function resolveDealCurrency(ctx: QueryCtx | MutationCtx, app: Doc<"financeApplications">, action: string): Promise<string> {
  assertSupportedDenomination(app.economicsCurrency, action);
  const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, app.orgId));
  const facts = await dealMoneyFactCurrencies(ctx, app._id);
  const contradicting = [...facts].filter((code) => code !== currency);
  if (contradicting.length > 0) throw new ConvexError(`This deal already has costs or custody recorded in ${contradicting.join(", ")}, but ${action} would use ${currency}. A deal's money is kept in one currency; restore the organization's currency to ${contradicting[0]} or correct the records before continuing.`);
  return currency;
}

export function exactTemplateLine(liveFees: ReadonlyArray<Doc<"financeDealFees">>, templateIndex: number): Doc<"financeDealFees"> | undefined {
  return liveFees.find((fee) => fee.voidedAt === undefined && fee.source === "COMPANY_TEMPLATE" && fee.templateIndex === templateIndex);
}

export function unrecordedConfiguredFeePositions(snapshot: Doc<"financeApplications">["companyRuleSnapshot"], liveFees: ReadonlyArray<Doc<"financeDealFees">>): number[] {
  // adminFees is the single configured execution-fee authority. Historical
  // snapshots may still carry stale feeTemplates; once adminFees exists those
  // retired rows must never regain settlement/finalization authority.
  if (snapshot?.adminFees !== undefined) return [];
  const templates = snapshot?.feeTemplates ?? [];
  const missing: number[] = [];
  templates.forEach((_template, templateIndex) => {
    const line = exactTemplateLine(liveFees, templateIndex);
    if (!line || line.actualAmountMinor === undefined) missing.push(templateIndex);
  });
  return missing;
}

export function assertConfiguredFeesRecorded(snapshot: Doc<"financeApplications">["companyRuleSnapshot"], liveFees: ReadonlyArray<Doc<"financeDealFees">>, action: string): void {
  // Single-fee authority wins even for mixed historical snapshots that still
  // contain retired feeTemplates. Only genuinely legacy snapshots (no
  // adminFees field) remain governed by template completeness/capacity rules.
  if (snapshot?.adminFees !== undefined) return;
  if (frozenPolicyExceedsLiveCapacity(snapshot?.feeTemplates)) throw new ConvexError(`This deal's frozen finance-company policy configures ${snapshot?.feeTemplates?.length} fees, more than the ${MAX_LIVE_DEAL_FEE_LINES} live cost lines a deal can carry, so it cannot be closed under that policy. A frozen policy is never rewritten: correct the company's fee templates and re-create this application.`);
  const missing = unrecordedConfiguredFeePositions(snapshot, liveFees);
  if (missing.length > 0) throw new ConvexError(`${missing.length} fee(s) configured by this deal's finance company have no actual recorded. Record what was actually paid for each of them — zero if it was not charged — before ${action}.`);
}

export function settlementDeductedFees(liveFees: ReadonlyArray<Doc<"financeDealFees">>): Array<Doc<"financeDealFees">> {
  return liveFees.filter((row) => row.deductedFromSettlement === true);
}

export function settlementDeductedActualMinor(fees: Array<Doc<"financeDealFees">>, currency: string): number {
  const foreign = fees.filter((fee) => fee.currency !== currency);
  if (foreign.length > 0) {
    const codes = [...new Set(foreign.map((fee) => fee.currency))].join(", ");
    throw new ConvexError(`${foreign.length} settlement-deducted cost line(s) on this deal are recorded in ${codes}, but the settlement is in ${currency}. Costs cannot be deducted across currencies; correct the lines before continuing.`);
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

export async function settlementDeductedTotalMinor(ctx: QueryCtx | MutationCtx, applicationId: Id<"financeApplications">, currency: string): Promise<number> {
  return settlementDeductedActualMinor(settlementDeductedFees(await loadActiveFees(ctx, applicationId)), currency);
}

// ---------------------------------------------------------------------------
// One custody record's readable balance (moved from financeDealCosts.ts so the
// finalization readiness evaluator and the custody writers share ONE
// calculation — SCRUM-407 P1.2).
// ---------------------------------------------------------------------------

/**
 * Where one custody record stands, using the shared engine for the arithmetic.
 *
 * Closure needs BOTH directions settled, which the engine alone does not tell
 * you: it computes what is *due*, and a debt that is owed but unpaid is not
 * settled. So `settled` requires the employee to hold nothing AND the
 * dealership to have actually paid back everything it owes.
 */
export function summarizeCustody(
  custody: Doc<"financeDealCustody">,
  actualExpensesMinor: number
) {
  const reconciliation = reconcileEmployeeCustody({
    advanceIssuedMinor: custody.issuedMinor,
    actualExpensesMinor,
    employeeReturnedMinor: custody.returnedMinor,
    alreadyReimbursedMinor: custody.reimbursedMinor,
  });

  return {
    ...reconciliation,
    actualExpensesMinor,
    reimbursedMinor: custody.reimbursedMinor,
    // The engine decides `reconciled` across all three directions — money still
    // held, money still owed, and money paid twice. Recomputing it here is how
    // the two would drift.
    settled: reconciliation.reconciled,
  };
}

/**
 * Sum recorded actuals for one custody from the deal's already-bounded LIVE
 * fee set — or `null` when a linked actual is not a readable minor-unit
 * figure, or the sum leaves the safe range. Callers must pass the result of
 * `loadActiveFees`: querying by custody and filtering voids afterwards would
 * read an unbounded add/void history and could strand both reconciliation and
 * finalization readiness at the platform transaction limit even while the deal had
 * fewer than 500 live lines.
 */
export function custodyActualExpensesMinor(
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  custodyId: Id<"financeDealCustody">
): number | null {
  let sum = 0;
  for (const row of liveFees) {
    if (row.voidedAt !== undefined || row.custodyId !== custodyId || row.actualAmountMinor === undefined) continue;
    if (!isMinorAmount(row.actualAmountMinor)) return null;
    sum += row.actualAmountMinor;
  }
  return Number.isSafeInteger(sum) ? sum : null;
}

/** The live line charged to this record that is not in the record's currency, if any (R5, F4). */
function custodyForeignCurrencyLine(
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  custody: Pick<Doc<"financeDealCustody">, "_id" | "currency">
): Doc<"financeDealFees"> | undefined {
  return liveFees.find((row) => row.voidedAt === undefined && row.custodyId === custody._id && row.currency !== custody.currency);
}

/** Why a custody record's balance cannot be stated from its stored totals and linked costs. */
export type CustodyAmountsUnreadableReason = "UNSAFE_AMOUNT";

/**
 * The readable-balance contract for one custody record: the three stored
 * totals and the linked actuals are each a readable minor-unit figure, and
 * the arithmetic the engine performs on them stays in the safe range. The
 * engine (`reconcileEmployeeCustody`) throws on a corrupt operand and does
 * not check its own results, and a NaN that reached a gate would compare as
 * neither owed nor settled — so no caller reaches it without passing here.
 */
export function unreadableCustodyAmounts(
  custody: Pick<Doc<"financeDealCustody">, "issuedMinor" | "returnedMinor" | "reimbursedMinor">,
  actualExpensesMinor: number | null
): CustodyAmountsUnreadableReason | null {
  if (actualExpensesMinor === null) return "UNSAFE_AMOUNT";
  const operands = [custody.issuedMinor, custody.returnedMinor, custody.reimbursedMinor, actualExpensesMinor];
  if (!operands.every(isMinorAmount)) return "UNSAFE_AMOUNT";
  // Every intermediate the engine forms is bounded in magnitude by the sum
  // of the four operands, so one safe-range check covers them all.
  return Number.isSafeInteger(operands.reduce((total, amount) => total + amount, 0)) ? null : "UNSAFE_AMOUNT";
}

/**
 * The custody summary a WRITER may act on, or a refusal. A closure,
 * reconciliation or finalization readiness gate that compared against a corrupt
 * balance would be deciding on a number that is not one; every such gate
 * calls this and fails closed with the reason instead.
 */
export function summarizeReadableCustody(
  custody: Doc<"financeDealCustody">,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): ReturnType<typeof summarizeCustody> {
  // Cents are not fils: a linked line in another currency makes the sum
  // below a non-figure, and every writer that reads the position refuses
  // before it is formed (R5, F4).
  const foreign = custodyForeignCurrencyLine(liveFees, custody);
  if (foreign !== undefined) assertFeeCustodyCurrency(foreign, custody, action);
  const actualExpensesMinor = custodyActualExpensesMinor(liveFees, custody._id);
  if (actualExpensesMinor === null || unreadableCustodyAmounts(custody, actualExpensesMinor) !== null) {
    throw new ConvexError(
      `A custody amount or a cost charged to this custody is not a readable figure, so ${action} is refused until the record is corrected.`
    );
  }
  return summarizeCustody(custody, actualExpensesMinor);
}

/**
 * A cost line and the custody record it is charged to share ONE currency
 * (R5, F4). The record's balance is `issued − returned − custody-paid
 * lines + reimbursed`, summed in minor units — and minor units are not one
 * scale: a USD line is in cents, a JOD record in fils, so a cross-currency
 * charge sums cents into fils and states a position that is not a figure.
 * Refused BEFORE anything is written or posted on every path that links a
 * line to a record or re-posts a linked one, excluded from the screen's
 * eligibility, and refused again by every command that reads the record's
 * position while such a line sits on it. The exit for a legacy link is to
 * release the line (`setFeeCustody` with no record), which reverses its
 * charge without summing it.
 */
export function assertFeeCustodyCurrency(
  line: Pick<Doc<"financeDealFees">, "currency">,
  custody: Pick<Doc<"financeDealCustody">, "currency">,
  action: string
): void {
  if (line.currency === custody.currency) return;
  throw new ConvexError(
    `This cost is recorded in ${line.currency} while the custody record is in ${custody.currency}; the two cannot be summed, so ${action} is refused. Correct the line's currency or release it from custody first; nothing has been changed.`
  );
}
