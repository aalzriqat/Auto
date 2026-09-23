import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { assertSupportedDenomination, supportedCurrencyScale } from "./money";
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
