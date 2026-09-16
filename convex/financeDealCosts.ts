import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireOrgMember, requireOwnedRow, requireOwner, requireTenantAuth } from "./utils/tenancy";
import { AppErrorCode } from "./utils/errors";
import { runWithIdempotency } from "./utils/idempotency";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import {
  getOrgCurrency,
  hookCustodyCashMoved,
  hookCustodyCashReversed,
  hookCustodyFeePaid,
  hookCustodyFeeReversed,
  hookCustodyWrittenOff,
  hookCustodyWriteOffReversed,
  hookCustodyPayableReclassified,
  type ReversalOutcome,
} from "./accounting/workflowHooks";
import { dealCustodyAccountingReadiness } from "./chartOfAccounts";
import { getOpenPeriodForDate } from "./accountingPeriods";
import { custodyFeeExpenseKey } from "./utils/dealCustodyPosting";
import {
  assertCustodyLedgerFamilyComplete,
  assertStoredVersion,
  custodyEntryPostKey,
  custodyFeePostKey,
  custodyPayableReclassPosted,
  custodyPositionDependencies,
  foldAbandonedPayableDeltas,
  loadCustodyEntries,
  nextStoredVersion,
  type CustodyLedgerDependency,
} from "./utils/custodySourceLedger";
import {
  assertConfiguredFeesRecorded,
  assertExpectedCurrency,
  assertRoomForAnotherLine,
  exactTemplateLine,
  loadActiveFees,
  loadCustodyRecords,
  resolveDealCurrency,
} from "./utils/settlementDeductions";
import { assertSupportedDenomination } from "./utils/money";
import {
  assertFeeTemplatesWithinLimit,
  feeTemplatesExceedConfigurationLimit,
  MAX_CUSTODY_ENTRIES,
  MAX_DEAL_CUSTODY_DECISION_RECORDS,
} from "./utils/dealCostLimits";
export { MAX_CUSTODY_ENTRIES, MAX_DEAL_CUSTODY_DECISION_RECORDS };
import { reconcileEmployeeCustody } from "../lib/financingEconomics";
import { recomputeEconomicsForApplication } from "./financingEconomics";
import {
  assertMinorAmount,
  isMinorAmount,
  feeAccountingTreatmentValidator,
  feePartyValidator,
  financeFeeTypeValidator,
} from "./utils/financingEconomics";

/**
 * What a financed deal actually cost, itemized — and who is still holding money.
 *
 * Two concerns, one module, because they are the same question asked twice: an
 * employee sent out with cash to pay a deal's transfer and licensing fees IS the
 * deal's cost lines, seen from the other side. Splitting them meant the fee
 * total and the custody balance could disagree with nothing to notice.
 *
 * ## What this module deliberately does NOT do
 *
 * It posts nothing about the SALE. No receivable, no revenue, no change to any
 * existing sale posting. The accounting treatment of a financed sale is
 * undetermined until the invoice, the purchase agreement and the settlement
 * advice say how the purchase amount and the dealer contribution are legally
 * documented — so this records those facts and refuses to draw the
 * conclusion. `finalizeDeal` is untouched.
 *
 * ## What it DOES post: employee cash custody
 *
 * Cash handed to an employee, returned by them, reimbursed to them, the
 * handover costs they paid out of it and a written-off shortage are real cash
 * movements, and each posts through the canonical hooks in
 * `accounting/workflowHooks` against DEAL_CUSTODY_CLEARING (1250) — see the
 * note on that system key for the model. Every money mutation here refuses
 * outright when the org's chart cannot resolve those accounts
 * (`assertCustodyAccountingReady`), so a custody movement is never recorded
 * operationally without its ledger record: it posts now, or it queues to the
 * outbox for a period that is not open yet.
 *
 * ## The rule every function here obeys
 *
 * Nothing is inferred from the gap between two other numbers. Not the expenses,
 * not the buffer, not a residual. A deal with nothing itemized reports nothing
 * itemized. Working backwards from a quotation to make the arithmetic close is
 * how a leftover becomes a business fact nobody stated.
 */

const APPLICATION_NOT_FOUND = "Finance application not found in this organization.";
const CUSTODY_NOT_FOUND = "Custody record not found in this organization.";
const FEE_NOT_FOUND = "Deal cost not found in this organization.";

/**
 * The custody money boundary: refuses before anything is written when the
 * org's ledger cannot take the posting. A movement recorded "operationally
 * only" would present un-posted cash as accounted for — exactly what the
 * read-only custody screen existed to avoid — so the refusal is here, at the
 * mutation, and the screen reads the same predicate to explain a disabled
 * button (`listDealCosts.custodyAccounting`).
 */
async function assertCustodyAccountingReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  action: string
): Promise<void> {
  const readiness = await dealCustodyAccountingReadiness(ctx, orgId);
  if (readiness.ready) return;
  const why: Record<typeof readiness.reason, string> = {
    CHART_NOT_INITIALIZED:
      "The chart of accounts has not been initialized for this organization, so cash cannot be posted.",
    ACCOUNT_UNMAPPED: `The "${readiness.systemKey}" system account is missing or inactive in the chart of accounts.`,
    ACCOUNT_CODE_CONFLICT: `The chart of accounts has a custom account on the code reserved for "${readiness.systemKey}"; resolve it under Accounting > Chart of Accounts.`,
  };
  throw new ConvexError(`${why[readiness.reason]} Set up accounting before ${action}; nothing has been recorded.`);
}

/**
 * The person HOLDING the cash never records its movements or closes its
 * record: the same separation `openDealCustody` enforces on the issuer. A
 * custodian issuing to, reimbursing or reconciling themselves is an
 * uncontrolled loop around the one control this table provides.
 */
function assertNotCustodian(
  custody: Pick<Doc<"financeDealCustody">, "userId">,
  actorId: Id<"users">,
  action: string
): void {
  if (custody.userId === actorId) {
    throw new ConvexError(`${action} has to be done by somebody other than the person holding the cash.`);
  }
}

/**
 * The same separation for a path that only holds the custody's id (final
 * round E): a line charged to a record, released from it, re-recorded,
 * voided or reconciled changes what that record's holder is reimbursed for,
 * so the holder never does it. Every fee path that touches a custody id —
 * `resolveFeeCustody` for the record being charged, and this for the record
 * a line already sits on — refuses BEFORE any write.
 */
async function assertActorNotCustodianOf(
  ctx: MutationCtx,
  line: Pick<Doc<"financeDealFees">, "orgId" | "applicationId">,
  custodyId: Id<"financeDealCustody">,
  actorId: Id<"users">,
  action: string
): Promise<void> {
  const custody = await requireLinkedCustody(ctx, line, custodyId, action);
  assertNotCustodian(custody, actorId, action);
}

/**
 * The custody record a cost line's STORED link names — `custodyId`, or the
 * `custodyPosted.custodyId` its live charge sits on — loaded as the line's
 * own organization's row on the line's own deal, or refused (R7, F3).
 *
 * A stored link is not a caller's argument: `resolveFeeCustody` vets the
 * record a caller asks to charge, but nothing vetted what the row already
 * carried, and a raw `get` on it reversed, re-posted and reclassified
 * against whatever the id named — a record of another tenant, a record on
 * another deal — or, when the record was gone, skipped the guards that
 * needed it and went on to post. So every door that acts on a stored link
 * (re-record, void, release, reconcile, and the posting sync behind them)
 * loads it here first, and a link that is not this org's on this deal
 * refuses before any write. Tenancy: `requireOwnedRow` on the line's
 * `orgId`; identity: the record's `applicationId` must be the line's.
 */
async function requireLinkedCustody(
  ctx: MutationCtx,
  line: Pick<Doc<"financeDealFees">, "orgId" | "applicationId">,
  custodyId: Id<"financeDealCustody">,
  action: string
): Promise<Doc<"financeDealCustody">> {
  const custody = await requireOwnedRow(
    ctx, line.orgId, "financeDealCustody", custodyId,
    `This cost is linked to a custody record that is not in this organization, so ${action} is refused until the line is corrected; nothing has been changed.`
  );
  if (custody.applicationId !== line.applicationId) {
    throw new ConvexError(
      `This cost is linked to a custody record on a different deal, so ${action} is refused until the line is corrected; nothing has been changed.`
    );
  }
  return custody;
}

/**
 * Keeps EMPLOYEE_REIMBURSEMENTS_PAYABLE carrying exactly this record's
 * out-of-pocket position (Codex AF-CUST-01).
 *
 * After every movement that can change the position — a cash leg, its
 * reversal, a custody-paid fee posted, re-posted or reversed — the target
 * payable is `max(0, −position)` with `position = issued − returned −
 * custody-paid fees + reimbursed`, the engine's own identity. The difference
 * against what is already on the books posts as ONE signed delta, so the
 * split is a function of the position and not of the order cash and receipts
 * arrived. The primary journals are never touched: a reversed movement keeps
 * its exact inverse, and the delta that follows restores the split. Nothing
 * posts when the delta is zero, and a legacy record (nothing on the ledger)
 * carries no payable either.
 *
 * Refuses (and rolls the caller back) when the position cannot be read — an
 * unreadable amount is not a liability anyone can state.
 *
 * Each version is CAUSALLY CHAINED behind the one before it (final round A):
 * a delta whose predecessor is still queued — dated into a closed month — is
 * queued behind it rather than posted, and the outbox posts them in order.
 * The row therefore carries the chain's target (`payableTargetMinor`), and
 * what the ledger holds right now is asked of the ledger.
 *
 * And each version is chained behind the PRIMARY POSTINGS it reflects: the
 * delta is computed from the rows, so it is only true of the books once
 * every leg and line the position is made of is where the ledger must show
 * it — `custodyPositionDependencies` names the WHOLE position (every leg
 * SETTLED or OFF the books, every ever-posted line at its current version
 * and off it at every other), and the caller adds the postings this very
 * correction changed (the forward key that must be POSTED, the replaced key
 * that must be OFF the books). The hook queues the delta behind an unmet
 * one, the worker re-proving the same off the queued row. A payable that
 * moved to the corrected position while the clearing account still carried
 * the old charge — or that credited an issuance still queued for a closed
 * month — is exactly what a snapshot between the two would report.
 *
 * And a queued version whose primary was CANCELLED before it posted is not
 * awaited and not posted: `foldAbandonedPayableDeltas` drops it, with the
 * queued tail above it, and this version is issued in its place from the
 * target the POSTED chain reached (follow-up audit, H3).
 */
async function syncCustodyPayable(
  ctx: MutationCtx,
  custodyId: Id<"financeDealCustody">,
  actorId: Id<"users">,
  occurredAt: number,
  dependencies: ReadonlyArray<CustodyLedgerDependency>
): Promise<void> {
  const custody = await ctx.db.get(custodyId);
  if (custody === null) throw new ConvexError(CUSTODY_NOT_FOUND);
  if (custody.ledgerPosting !== "CANONICAL") return;
  const action = "reclassifying this custody record's balance";
  const summary = summarizeReadableCustody(custody, await loadActiveFees(ctx, custody.applicationId), action);
  const position = summary.remainingEmployeeBalanceMinor + custody.reimbursedMinor;
  const target = Math.max(0, -position);
  // The delta is against the chain's TARGET, not the ledger's balance: a
  // version still waiting in the outbox is part of the chain and will post
  // in order (the hook queues each version behind an unposted predecessor),
  // so the next delta is measured from where the chain will land — less any
  // queued version that followed a primary the ledger will never carry,
  // which is dropped here and re-based into this one.
  const { nextVersion, baseTargetMinor } = await foldAbandonedPayableDeltas(ctx, custody, action);
  const delta = target - baseTargetMinor;
  if (delta === 0) {
    if (nextVersion !== (custody.payableReclassVersion ?? 0) + 1) {
      await ctx.db.patch(custodyId, { payableTargetMinor: target, payableReclassVersion: nextVersion - 1, updatedAt: Date.now() });
    }
    return;
  }
  const positionDependencies = await custodyPositionDependencies(ctx, custody, action);
  const seen = new Set(positionDependencies.map((d) => `${d.must}:${d.idempotencyKey}`));
  const merged = [...positionDependencies];
  for (const dependency of dependencies) {
    const key = `${dependency.must}:${dependency.idempotencyKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(dependency);
  }
  await hookCustodyPayableReclassified(ctx, {
    orgId: custody.orgId,
    custody,
    version: nextVersion,
    deltaMinor: delta,
    payableAfterMinor: target,
    actorId,
    occurredAt,
    dependencies: merged,
  });
  await ctx.db.patch(custodyId, {
    payableTargetMinor: target,
    payableReclassVersion: nextVersion,
    updatedAt: Date.now(),
  });
}

/** A timestamp the ledger can date an event at: a safe non-negative integer. */
function isTimestamp(value: number | undefined): boolean {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** Refuses a `v.number()` date that is not a real timestamp — BEFORE it is fingerprinted or written. */
function assertTimestamp(value: number | undefined, label: string): void {
  if (value !== undefined && !isTimestamp(value)) {
    throw new ConvexError(`${label} must be a real timestamp (got ${value}).`);
  }
}

/**
 * Refuses an economic date that has not happened yet (final round C).
 *
 * `now` is captured ONCE per mutation and shared by every date the command
 * judges, so a value equal to the server's instant passes and one
 * millisecond past it does not, with no second clock read to race against.
 * A backdated day is legitimate history and passes untouched. There is no
 * tolerance window: a calendar date the client picks is sent as UTC
 * midnight for a past day and as the current instant for today, so a
 * timestamp past the server's clock is always a day that has not occurred.
 * Thrown before anything is fingerprinted or written, like `assertTimestamp`.
 */
function assertNotFuture(value: number | undefined, now: number, label: string): void {
  if (value !== undefined && value > now) {
    throw new ConvexError(`${label} cannot be in the future.`);
  }
}

/**
 * Whether the deal's recognized economics are FROZEN: the sale has been
 * finalized (or the application is CLOSED), so the legal invoice, every cost
 * line and every custody charge now stand behind a posted sale journal.
 *
 * After that point a posting-bearing edit — a new or adopted fee, a changed
 * actual or paid date, a void, a replaced invoice, a cost moved onto or off
 * custody, fresh cash handed over — would change what was recognized without
 * a correction journal on record. There is no immutable correction path in
 * this bounded change, so every such edit is REFUSED here with the reason,
 * and the screen reads the same predicate (`listDealCosts.economicsFrozen`)
 * to explain a disabled control. What is still allowed: settling custody that
 * already exists (return, reimburse, reverse a cash leg, reconcile, write
 * off, reopen), reconciling a recorded figure, and every read.
 */
export function dealEconomicsFrozen(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">
): { frozen: true; reason: "SALE_FINALIZED" | "APPLICATION_CLOSED" } | { frozen: false } {
  if (app.finalizedSaleId !== undefined) return { frozen: true, reason: "SALE_FINALIZED" };
  if (app.status === "CLOSED") return { frozen: true, reason: "APPLICATION_CLOSED" };
  return { frozen: false };
}

function assertDealEconomicsOpen(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">,
  action: string
): void {
  const state = dealEconomicsFrozen(app);
  if (!state.frozen) return;
  throw new ConvexError(
    `This deal has been finalized, so its costs, invoice and custody charges are on the books as recognized; ${action} is refused because there is no correction journal to carry the change. Nothing has been changed.`
  );
}

/**
 * Whether the deal still takes NEW custody cash (R5, F3): an issuance opens
 * a claim on the drawer for a handover that is going to happen. A deal that
 * is CANCELLED or REJECTED has no handover to fund, exactly as a finalized
 * or CLOSED one has none left to fund — yet the freeze above covers only
 * the recognized states, and the screen alone withheld the door on the
 * stopped ones, so a direct caller could still hand cash to an employee on
 * a deal that had stopped. The server's own predicate, read by the screen
 * (`listDealCosts.acceptsNewCustodyCash`) and enforced INSIDE each
 * issuing command's idempotent section, so an exact replay of an issuance
 * that succeeded before the deal stopped still returns its stored result.
 *
 * NEW cash only. Settling custody that already exists — a return, a
 * reimbursement, a reversal, a reconciliation, a write-off, a reopen — is
 * what a stopped deal still needs, and stays open.
 */
export function dealAcceptsNewCustodyCash(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">
):
  | { accepts: true }
  | { accepts: false; reason: "SALE_FINALIZED" | "APPLICATION_CLOSED" | "APPLICATION_CANCELLED" | "APPLICATION_REJECTED" } {
  const frozen = dealEconomicsFrozen(app);
  if (frozen.frozen) return { accepts: false, reason: frozen.reason };
  if (app.status === "CANCELLED") return { accepts: false, reason: "APPLICATION_CANCELLED" };
  if (app.status === "REJECTED") return { accepts: false, reason: "APPLICATION_REJECTED" };
  return { accepts: true };
}

function assertDealAcceptsNewCustodyCash(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">,
  action: string
): void {
  const state = dealAcceptsNewCustodyCash(app);
  if (state.accepts) return;
  if (state.reason === "APPLICATION_CANCELLED" || state.reason === "APPLICATION_REJECTED") {
    throw new ConvexError(
      `This deal has been ${state.reason === "APPLICATION_CANCELLED" ? "cancelled" : "rejected"}, so there is no handover left to fund; ${action} is refused. Custody the employee already holds can still be returned, reimbursed, reversed or reconciled. Nothing has been changed.`
    );
  }
  assertDealEconomicsOpen(app, action);
}

/**
 * Makes the ledger agree with one fee line's custody charge.
 *
 * The line is on the books as a custody-paid cost at most ONCE, at its
 * current actual, against its current custody — `custodyPosted` says what
 * that is. Anything that changes it (a corrected amount, a re-charge to
 * another record, an unlink, a void) reverses the live version through the
 * canonical reversal path and, if a live charge remains, posts the next
 * version. Called AFTER the row has been written, on the row as it now is,
 * so the ledger follows the record and never the caller's intent.
 *
 * Nothing posts for a line without an actual, or with a zero actual: "the
 * company charged nothing for it" is a fact with no journal.
 */
async function syncCustodyFeePosting(
  ctx: MutationCtx,
  feeId: Id<"financeDealFees">,
  actorId: Id<"users">,
  reason: string
): Promise<void> {
  const fee = await ctx.db.get(feeId);
  if (fee === null) throw new ConvexError(FEE_NOT_FOUND);
  const live =
    fee.voidedAt === undefined &&
    fee.custodyId !== undefined &&
    fee.actualAmountMinor !== undefined &&
    isMinorAmount(fee.actualAmountMinor) &&
    fee.actualAmountMinor > 0;
  const target = live ? { custodyId: fee.custodyId!, amountMinor: fee.actualAmountMinor! } : null;
  const posted = fee.custodyPosted;
  const unchanged =
    posted !== undefined &&
    target !== null &&
    posted.custodyId === target.custodyId &&
    posted.amountMinor === target.amountMinor;
  if (unchanged) return;

  // Both stored links are proven this org's, on this deal, and the claimed
  // version proven a version, BEFORE the reversal, the re-post and the
  // payable syncs they drive (R7, F3 + F4): nothing below acts on a link or
  // a number the row merely carries.
  const action = "syncing this cost's custody posting";
  if (posted !== undefined) {
    await requireLinkedCustody(ctx, fee, posted.custodyId, action);
    assertStoredVersion(posted.version, "This cost line's custody posting", action);
  }
  if (target !== null) await requireLinkedCustody(ctx, fee, target.custodyId, action);

  const now = Date.now();
  // What became of the live version: a DEFERRED reversal leaves it POSTED
  // until the outbox drains, and the replacement below is queued behind it
  // rather than posted beside it (consolidated round, item 2).
  let reversal: ReversalOutcome | undefined;
  if (posted !== undefined) {
    reversal = await hookCustodyFeeReversed(ctx, {
      orgId: fee.orgId,
      feeId: fee._id,
      version: posted.version,
      reason,
      actorId,
      reversalDate: now,
    });
    await ctx.db.patch(fee._id, { custodyPosted: undefined, updatedAt: now });
  }
  // The postings the payable deltas below are consequences of: the version
  // that was on the books must be OFF it, the replacement (if any) ON it.
  const replacedOffBooks: CustodyLedgerDependency[] =
    posted !== undefined ? [{ must: "OFF_BOOKS", idempotencyKey: custodyFeePostKey(fee._id, posted.version) }] : [];
  if (target === null) {
    // The record the line left (or was voided on) may have owed the employee
    // for it; its payable follows the position, dated with the correction —
    // and held behind the reversal of the charge it no longer carries.
    if (posted !== undefined) await syncCustodyPayable(ctx, posted.custodyId, actorId, now, replacedOffBooks);
    return;
  }

  const expense = custodyFeeExpenseKey(fee.accountingTreatment);
  if (expense.systemKey === null) throw new ConvexError(expense.refusal);
  const version = nextStoredVersion(fee.custodyPostingVersion, "This cost line", action);
  // A fresh charge is posted against a deal that EXISTS in this org (R6,
  // F3): a line whose parent is gone or another tenant's is never put on
  // the books, whatever door led here. Thrown before the forward posts, so
  // the mutation rolls back — the reversal above with it — and nothing moves.
  const app = await requireOwnedRow(ctx, fee.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
  await hookCustodyFeePaid(ctx, {
    orgId: fee.orgId,
    fee,
    custodyId: target.custodyId,
    vehicleId: app.vehicleId,
    version,
    amountMinor: target.amountMinor,
    actorId,
    // Dated when the employee paid it, where that is known and readable;
    // otherwise when it was recorded. A past date in a closed period queues.
    occurredAt: fee.paidAt !== undefined && isTimestamp(fee.paidAt) ? fee.paidAt : now,
    replacesReversal: reversal,
  });
  await ctx.db.patch(fee._id, {
    custodyPosted: { version, amountMinor: target.amountMinor, custodyId: target.custodyId },
    custodyPostingVersion: version,
    updatedAt: now,
  });
  // The receiving record's payable, dated with the fee and held behind the
  // replacement version (which is itself queued behind the deferred reversal
  // of the version it replaces) and, on the same record, behind that
  // reversal too; and the record the line moved off, if any, dated with the
  // correction and held behind the reversal alone.
  const replacementPosted: CustodyLedgerDependency = {
    must: "SETTLED",
    idempotencyKey: custodyFeePostKey(fee._id, version),
  };
  await syncCustodyPayable(
    ctx, target.custodyId, actorId,
    fee.paidAt !== undefined && isTimestamp(fee.paidAt) ? fee.paidAt : now,
    posted !== undefined && posted.custodyId === target.custodyId
      ? [...replacedOffBooks, replacementPosted]
      : [replacementPosted]
  );
  if (posted !== undefined && posted.custodyId !== target.custodyId) {
    await syncCustodyPayable(ctx, posted.custodyId, actorId, now, replacedOffBooks);
  }
}

/**
 * How much cash the deal's policy says an employee will need at the counter:
 * the configured fees the finance company expects an EMPLOYEE to pay, less
 * those already recorded as paid. A recommendation for the person handing
 * over the money, never an amount anything issues or stores — and withheld
 * (null, with the reason) rather than partial when a relevant estimate is
 * unreadable or nothing is configured.
 */
export function deriveRecommendedCustody(expected: {
  source: "COMPANY_RULE_SNAPSHOT" | "NO_SNAPSHOT" | "NO_TEMPLATES";
  rows: ReadonlyArray<
    Pick<ExpectedFeeRow, "paidBy" | "deductedFromSettlement" | "accountingTreatment" | "expectedAmountMinor" | "actual">
  >;
}): {
  recommendedMinor: number | null;
  reason: "NOT_CONFIGURED" | "NO_EMPLOYEE_PAID_FEES" | "UNSAFE_AMOUNT" | null;
  /** How many employee-paid configured fees still have no actual on record. */
  outstandingCount: number;
} {
  if (expected.source !== "COMPANY_RULE_SNAPSHOT") {
    return { recommendedMinor: null, reason: "NOT_CONFIGURED", outstandingCount: 0 };
  }
  // The rows an employee will pay AT THE COUNTER out of the cash they hold —
  // the same eligibility `resolveFeeCustody` enforces. A fee the company
  // withholds from the remittance is never handed over in cash, and a
  // treatment custody cannot post is not one this money will be charged for.
  const employeeRows = expected.rows.filter(
    (row) =>
      row.paidBy === "EMPLOYEE" &&
      !row.deductedFromSettlement &&
      custodyFeeExpenseKey(row.accountingTreatment).systemKey !== null
  );
  if (employeeRows.length === 0) {
    return { recommendedMinor: null, reason: "NO_EMPLOYEE_PAID_FEES", outstandingCount: 0 };
  }
  const outstanding = employeeRows.filter((row) => row.actual === null);
  if (outstanding.some((row) => row.expectedAmountMinor === null)) {
    return { recommendedMinor: null, reason: "UNSAFE_AMOUNT", outstandingCount: outstanding.length };
  }
  const sum = outstanding.reduce((total, row) => total + (row.expectedAmountMinor ?? 0), 0);
  if (!Number.isSafeInteger(sum)) {
    return { recommendedMinor: null, reason: "UNSAFE_AMOUNT", outstandingCount: outstanding.length };
  }
  return { recommendedMinor: sum, reason: null, outstandingCount: outstanding.length };
}

/**
 * Refuses to change anything a closed custody record was balanced against.
 *
 * Closing is a claim that the money is accounted for. Nothing froze the fee
 * lines that determine that, so a late receipt recorded afterwards left the
 * record stored as RECONCILED while the arithmetic said the employee was out of
 * pocket — and `recordCustodyMovement` then refused the reimbursement, its
 * error naming a `reopenDealCustody` mutation that did not exist. Reopen it
 * deliberately instead.
 */
function assertCustodyOpen(custody: Doc<"financeDealCustody">): void {
  if (custody.status !== "OPEN") {
    throw new ConvexError(
      "This custody record is closed. Reopen it before changing the costs it was balanced against."
    );
  }
}

/**
 * Withdraws a deal's accounting classification when its basis changes.
 *
 * CLASSIFIED means somebody established the treatment against a specific set of
 * costs, custody balances and an invoice. Nothing re-checked it afterwards, so
 * adding an unquantified cost — or editing the invoice figure the treatment was
 * granted on — left a deal reading as settled while its own summary said
 * otherwise. This flag exists to be the gate a posting design reads; a gate
 * that silently stops representing its precondition is the whole hazard.
 *
 * Withdrawn with a row rather than silently: it is a human judgement, and
 * losing the fact that it was made and then invalidated is losing the audit.
 */
async function invalidateClassification(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  actorId: Id<"users">,
  because: string
): Promise<void> {
  if (app.accountingClassification !== "CLASSIFIED") return;
  const now = Date.now();
  await ctx.db.insert("financeApplicationOverrides", {
    orgId: app.orgId,
    applicationId: app._id,
    field: "accountingClassification",
    previousValue: "CLASSIFIED",
    newValue: "PENDING_CLASSIFICATION",
    reason: because,
    changedBy: actorId,
    changedAt: now,
  });
  await ctx.db.patch(app._id, {
    accountingClassification: "PENDING_CLASSIFICATION",
    accountingClassifiedBy: undefined,
    accountingClassifiedAt: undefined,
    accountingClassificationNotes: undefined,
    updatedAt: now,
  });
}

/**
 * Refuses to let a CREATE-level caller destroy CONFIRM-level work.
 *
 * Reconciling a cost requires `CONFIRM_FINANCE_DISBURSEMENT`, which SALES does
 * not hold; recording and voting an amount requires only
 * `CREATE_FINANCE_APPLICATION`, which it does. So without this a salesperson
 * could overwrite an accountant's checked figure, identity and notes.
 *
 * Checked against the role already loaded rather than by calling
 * `requireTenantAuth` a second time: that helper is not side-effect-free in a
 * mutation — it writes an impersonation audit row — so re-calling it logged a
 * second `impersonated-write:` entry naming an operation that never happened.
 */
function assertMayUndoReconciliation(
  auth: { role: Doc<"roles"> },
  action: string
): void {
  if (isSystemOwnerRole(auth.role)) return;
  if (auth.role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT)) return;
  throw new ConvexError(
    `${action} needs the permission to confirm finance disbursements, because somebody has already reconciled it.`
  );
}

/**
 * A cost line that touches an employee's custody is a LEDGER command — it
 * posts, re-posts or reverses a custody journal — so it carries the custody
 * authority, not the cost-entry one (Codex AF-CUST-04). CREATE is held by
 * SALES; confirming disbursements is not. Same shape as
 * `assertMayUndoReconciliation`: judged on the role already loaded.
 */
function assertMayPostCustody(auth: { role: Doc<"roles"> }, action: string): void {
  if (isSystemOwnerRole(auth.role)) return;
  if (auth.role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT)) return;
  throw new ConvexError(
    `${action} needs the permission to confirm finance disbursements, because it moves what an employee's custody has on the books.`
  );
}

/**
 * A custody record opened BEFORE custody posted to the ledger carries
 * movements with no journal behind them (Codex AF-CUST-07). Posting a new
 * movement against it would put one leg of the record on the books and leave
 * the rest off — a partial ledger that reads like a whole one. Such a record
 * is refused every money command and reported as legacy; it is settled
 * through an explicit migration, never through the product's own doors.
 */
function assertCustodyOnLedger(custody: Doc<"financeDealCustody">, action: string): void {
  if (custody.ledgerPosting === "CANONICAL") return;
  throw new ConvexError(
    `This custody record predates ledger posting, so ${action} is refused: its earlier movements were never posted and a new one would leave the books telling half the story. It needs the custody accounting migration, not another movement.`
  );
}

/**
 * How many custody records one deal read is allowed to hydrate.
 *
 * A deal has one custodian, occasionally two; the cap exists so a read can
 * never grow past the platform's result limits and blank the screen. Past it
 * the read reports `custodyTruncated: true` rather than a prefix that looks
 * like the whole.
 */
export const MAX_DEAL_CUSTODY_RECORDS = 20;

/**
 * Every movement of one custody record, or a refusal — never a prefix.
 * The invariant is `entries.length <= MAX_CUSTODY_ENTRIES` (see
 * `utils/dealCostLimits`) for any record a writer decides on; it is
 * established at every decision read by the shared loader in
 * `utils/custodySourceLedger`, which the ledger-side family proof reads
 * the log through as well.
 */
const custodyEntriesFor = loadCustodyEntries;

/**
 * Every custody record of a deal, or a refusal — the WRITERS' read, never a
 * prefix. The ONE bounded loader (`loadCustodyRecords`, beside
 * `loadActiveFees`) serves the one-open-per-person rule, the classification
 * gate and the denomination proof alike; see `MAX_DEAL_CUSTODY_DECISION_RECORDS`.
 */
async function custodyFor(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">,
  action: string
): Promise<Array<Doc<"financeDealCustody">>> {
  return await loadCustodyRecords(ctx, applicationId, action);
}

/** The screen's bounded read: one row past the cap, so truncation is detectable. */
async function custodyPageFor(
  ctx: QueryCtx,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"financeDealCustody">>> {
  return await ctx.db
    .query("financeDealCustody")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .take(MAX_DEAL_CUSTODY_RECORDS + 1);
}

// The pure fee summary (`deriveFeeStatus`, `summarizeFees`, `unreadableFeeAmounts`)
// lives in `./utils/feeSummary` so the finalization path can read the same
// verdict without importing this module; re-exported here for its callers.
import { deriveFeeStatus, summarizeFees, unreadableFeeAmounts, type FeeAmountsUnreadableReason } from "./utils/feeSummary";
export { deriveFeeStatus, summarizeFees, unreadableFeeAmounts, type FeeAmountsUnreadableReason };

// ---------------------------------------------------------------------------
// What the finance company's policy says this handover SHOULD cost
// ---------------------------------------------------------------------------

/** One configured fee, as the application's frozen rule snapshot carries it. */
type FeeTemplate = NonNullable<
  NonNullable<Doc<"financeApplications">["companyRuleSnapshot"]>["feeTemplates"]
>[number];

/** Display-only identity used to flag duplicate configured rows; never a match key. */
function templateIdentity(template: { feeType: string; description?: string }): string {
  return `${template.feeType}|${(template.description ?? "").trim().toLowerCase()}`;
}

export type ExpectedFeeRow = {
  /** Position in the frozen snapshot — the ONLY stable reference to this template. */
  templateIndex: number;
  feeType: FeeTemplate["feeType"];
  description: string | undefined;
  /**
   * The template's frozen estimate — or `null` with `expectedAmountReason`
   * when the stored value is not a readable minor-unit figure. The snapshot
   * is never rewritten to repair it; the row keeps its identity (type,
   * description, payer, treatment) so the position stays addressable, and
   * only the money is withheld.
   */
  expectedAmountMinor: number | null;
  expectedAmountReason: FeeAmountsUnreadableReason | null;
  paidBy: FeeTemplate["paidBy"];
  paidTo: FeeTemplate["paidTo"];
  includedInQuotation: boolean;
  deductedFromSettlement: boolean;
  refundable: boolean;
  accountingTreatment: FeeTemplate["accountingTreatment"];
  /**
   * Another template in the same snapshot shares this one's feeType and
   * description. Addressing by position keeps the two distinct, so an actual
   * recorded against one never satisfies the other; the flag exists so a
   * screen can label the pair.
   */
  duplicateIdentity: boolean;
  /**
   * The live line that records this fee's actual — the one
   * `recordTemplateFeeActual` wrote against this position, and nothing else.
   */
  actual: {
    feeId: Id<"financeDealFees">;
    actualAmountMinor: number | undefined;
    currency: string;
    status: ReturnType<typeof deriveFeeStatus>;
  } | null;
};

/**
 * The expected side of the handover-cost checklist, derived READ-ONLY from
 * the application's frozen `companyRuleSnapshot.feeTemplates` (owner product
 * correction, #scrum-215 2026-09-12 21:05).
 *
 * The rules a deal was created under are the rules it is costed against. The
 * snapshot is written once at application creation and never re-read from the
 * live company, so editing the company's fees next month changes what FUTURE
 * deals expect and leaves this one exactly as it was — the same property the
 * LTV and tolerance rules already have. Nothing here reads `financeCompanies`.
 *
 * What is NOT invented:
 *   - a deal with no snapshot, or a snapshot with no templates, has no expected
 *     rows and a null expected total — "not configured" is reported as such,
 *     never as zero;
 *   - the expected total sums the configured template estimates only; the
 *     actual total sums recorded actuals only (every live line, template or
 *     unplanned); their difference is a COMPARISON and is never an amount
 *     assumed still payable;
 *   - an unplanned line (no template) leaves the expected total untouched.
 *
 * Denomination: the snapshot carries no currency. Template amounts were
 * entered under the organisation's currency, which the SCRUM-319 lock freezes
 * once any cost or custody row exists, and the deal's lines are kept in that
 * same currency — so the expected figures are stated in the deal currency the
 * caller passes. The comparison is withheld (null) whenever the actual total
 * is, i.e. over mixed-denomination lines.
 *
 * Matching an actual to its template is EXACT or nothing. A line written by
 * `recordTemplateFeeActual` carries the template's POSITION and is the only
 * line a configured row ever shows as its actual, duplicates or not. A
 * COMPANY_TEMPLATE line with no position — from before that writer, or
 * written to the table by anything else — is never attached to a configured
 * row, however well its feeType and description happen to match: attaching it
 * would show the fee as recorded and hide the exact record action while
 * closure (which trusts positions only) still refused, and once the exact
 * line was recorded both would count toward the actual total. Such a line
 * stays visible as an unplanned/history line instead. The same stable
 * reference governs the checklist and the closure gate.
 */
export function deriveExpectedFees(args: {
  snapshot: Doc<"financeApplications">["companyRuleSnapshot"];
  /** Live (non-void) lines on the deal. */
  fees: Array<Doc<"financeDealFees">>;
  /** The deal's currency, as `listDealCosts` resolves it. */
  currency: string;
  /** Null when the recorded actuals cannot be summed (mixed denomination). */
  actualTotalMinor: number | null;
}): {
  source: "COMPANY_RULE_SNAPSHOT" | "NO_SNAPSHOT" | "NO_TEMPLATES";
  currency: string;
  rows: ExpectedFeeRow[];
  /**
   * Sum of the configured template estimates; null when nothing is
   * configured, and null with `expectedTotalReason` when any configured
   * estimate is unreadable or the sum leaves the safe range.
   */
  expectedTotalMinor: number | null;
  expectedTotalReason: FeeAmountsUnreadableReason | null;
  /** Sum of recorded actuals over every live line, template or unplanned; null over mixed denomination. */
  actualTotalMinor: number | null;
  /** expected − actual, a comparison only; null whenever either side is. */
  differenceMinor: number | null;
  /** Live lines outside the checklist: unplanned costs, and template lines that carry no position (legacy or otherwise). */
  unplannedLineIds: Id<"financeDealFees">[];
} {
  const templates = args.snapshot?.feeTemplates;
  const source =
    args.snapshot === undefined
      ? ("NO_SNAPSHOT" as const)
      : !templates || templates.length === 0
        ? ("NO_TEMPLATES" as const)
        : ("COMPANY_RULE_SNAPSHOT" as const);
  const configured = source === "COMPANY_RULE_SNAPSHOT" && templates ? templates : [];

  const identityCounts = new Map<string, number>();
  for (const template of configured) {
    const key = templateIdentity(template);
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
  }

  const claimed = new Set<Id<"financeDealFees">>();
  const rows: ExpectedFeeRow[] = configured.map((template, templateIndex) => {
    const duplicateIdentity = (identityCounts.get(templateIdentity(template)) ?? 0) > 1;

    // The line that names this position, or nothing — the same matcher the
    // closure gates use, so the checklist cannot show a row as recorded that
    // classification or finalization would refuse.
    const matched = exactTemplateLine(args.fees, templateIndex);
    if (matched) claimed.add(matched._id);

    // Validated positively on the way OUT of the frozen snapshot: the writers
    // assert this rule, the schema does not, and a legacy or raw-edited
    // template carries whatever it carries. The money is withheld per row
    // with the reason; nothing about the snapshot is changed.
    const expectedReadable = isMinorAmount(template.estimatedAmountMinor);

    return {
      templateIndex,
      feeType: template.feeType,
      description: template.description,
      expectedAmountMinor: expectedReadable ? template.estimatedAmountMinor : null,
      expectedAmountReason: expectedReadable ? null : "UNSAFE_AMOUNT",
      paidBy: template.paidBy,
      paidTo: template.paidTo,
      includedInQuotation: template.includedInQuotation,
      deductedFromSettlement: template.deductedFromSettlement,
      refundable: template.refundable,
      accountingTreatment: template.accountingTreatment,
      duplicateIdentity,
      actual: matched
        ? {
            feeId: matched._id,
            actualAmountMinor: matched.actualAmountMinor,
            currency: matched.currency,
            status: deriveFeeStatus(matched),
          }
        : null,
    };
  });

  // One unreadable row, or a sum that leaves the safe range, withholds the
  // total and everything compared against it — never a partial or corrupt
  // figure wearing a total's name.
  const expectedSum =
    source === "COMPANY_RULE_SNAPSHOT" && rows.every((row) => row.expectedAmountMinor !== null)
      ? rows.reduce((total, row) => total + (row.expectedAmountMinor ?? 0), 0)
      : null;
  const expectedTotalReason: FeeAmountsUnreadableReason | null =
    source === "COMPANY_RULE_SNAPSHOT" && (expectedSum === null || !Number.isSafeInteger(expectedSum))
      ? "UNSAFE_AMOUNT"
      : null;
  const expectedTotalMinor = expectedTotalReason === null ? expectedSum : null;
  const differenceMinor =
    expectedTotalMinor !== null && args.actualTotalMinor !== null
      ? expectedTotalMinor - args.actualTotalMinor
      : null;

  return {
    source,
    currency: args.currency,
    rows,
    expectedTotalMinor,
    expectedTotalReason,
    actualTotalMinor: args.actualTotalMinor,
    differenceMinor,
    unplannedLineIds: args.fees.filter((fee) => !claimed.has(fee._id)).map((fee) => fee._id),
  };
}

/**
 * The movement log of ONE custody record, paginated, oldest first.
 *
 * Kept out of `listDealCosts` so that read stays bounded whatever the log's
 * length. Each page row says whether a later REVERSAL cancelled it, through
 * one indexed point read per row (`by_reverses`) rather than a re-read of the
 * whole log. The custody row itself is proven to belong to the caller's org.
 */
export const listCustodyMovements = query({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
    const custody = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealCustody",
      args.custodyId,
      CUSTODY_NOT_FOUND
    );
    const result = await ctx.db
      .query("financeDealCustodyEntries")
      .withIndex("by_custody", (q) => q.eq("custodyId", custody._id))
      .order("asc")
      .paginate(args.paginationOpts);

    const names = new Map<Id<"users">, string>();
    const page = [];
    for (const entry of result.page) {
      let recordedByName = names.get(entry.recordedBy);
      if (recordedByName === undefined) {
        const user = await ctx.db.get(entry.recordedBy);
        recordedByName = user?.name ?? "";
        names.set(entry.recordedBy, recordedByName);
      }
      const reversal =
        entry.kind === "REVERSAL"
          ? null
          : await ctx.db
              .query("financeDealCustodyEntries")
              .withIndex("by_reverses", (q) => q.eq("reversesEntryId", entry._id))
              .first();
      page.push({
        _id: entry._id,
        kind: entry.kind,
        reversesEntryId: entry.reversesEntryId,
        amountMinor: entry.amountMinor,
        method: entry.method,
        reference: entry.reference,
        note: entry.note,
        occurredAt: entry.occurredAt,
        recordedAt: entry.recordedAt,
        recordedByName,
        reversed: reversal !== null,
      });
    }
    return { ...result, page };
  },
});

// ---------------------------------------------------------------------------
// Adopting a company's configured fees onto a deal frozen without them
// ---------------------------------------------------------------------------

export type FeeTemplateAdoptionState =
  /** The snapshot already carries templates — frozen at creation, or adopted. */
  | "NOT_NEEDED"
  /** No templates on the deal, the company has some, nothing blocks adoption. */
  | "AVAILABLE"
  /** No templates on the deal, and the company has none configured either. */
  | "COMPANY_HAS_NO_TEMPLATES"
  /** A manual-financier or legacy deal: no company row, or no rule snapshot to adopt into. */
  | "NO_COMPANY_SNAPSHOT"
  /** The company is deactivated: its policy is not adopted onto anything, whatever it says. */
  | "COMPANY_INACTIVE"
  /** A cost or custody row already exists — the deal has been costed without a policy. */
  | "BLOCKED_COSTS_RECORDED"
  /** The vehicle was handed over or the deal is closed/stopped — its costs are history. */
  | "BLOCKED_DEAL_PROGRESSED"
  /**
   * A stored company template carries an amount that is not a readable
   * minor-unit figure (legacy or raw-edited). The mutation refuses such a
   * policy, so the read never advertises it as adoptable.
   */
  | "COMPANY_TEMPLATES_UNREADABLE"
  /**
   * The company has more templates configured than the configuration policy
   * admits (`MAX_FEE_TEMPLATES`). The mutation refuses such a policy, so the
   * read never advertises it as adoptable; the company is repaired by an
   * explicit compliant list.
   */
  | "COMPANY_TEMPLATES_OVER_LIMIT";

export type FeeTemplateAdoption = {
  state: FeeTemplateAdoptionState;
  /** How many fees the company has configured RIGHT NOW — informational, never used as an expectation. */
  liveTemplateCount: number;
  liveRuleVersion: number | null;
  /** When and from which company revision templates were adopted, if they were. */
  adopted: { at: number; fromRuleVersion: number } | null;
};

/**
 * Whether the finance company's configured fees can be adopted onto this deal.
 *
 * The honest answer to "the company has fees configured but this deal says it
 * expects none". The snapshot is frozen at creation (owner ruling, #scrum-215
 * 2026-09-12) and a company configured AFTER that instant legitimately leaves
 * the deal with no expected fees. Reading the live company as if the deal had
 * always carried its fees would rewrite history; refusing to ever reconcile
 * the two strands a deal created a day too early. So the live state is
 * REPORTED here, and adoption is a separate, explicit, audited act with the
 * preconditions below — never a silent fallback in a read.
 *
 * The boundary is "before the first cost is recorded and before handover":
 * once a line, a custody record or a handover exists the deal has been costed
 * on the basis that nothing was expected, and adopting a policy under it
 * would retroactively make every closure gate demand actuals for fees nobody
 * planned. That deal keeps its honest "not configured" state.
 */
export function deriveFeeTemplateAdoption(args: {
  app: Doc<"financeApplications">;
  company: Doc<"financeCompanies"> | null;
  liveFeeCount: number;
  /** Whether ANY custody record exists — existence is all the boundary asks. */
  custodyRecorded: boolean;
}): FeeTemplateAdoption {
  const { app, company } = args;
  const snapshot = app.companyRuleSnapshot;
  const liveTemplates = company?.feeTemplates ?? [];
  const base = {
    liveTemplateCount: liveTemplates.length,
    liveRuleVersion: company ? (company.ruleVersion ?? 1) : null,
    adopted:
      snapshot?.feeTemplatesAdoptedAt !== undefined &&
      snapshot.feeTemplatesAdoptedFromRuleVersion !== undefined
        ? { at: snapshot.feeTemplatesAdoptedAt, fromRuleVersion: snapshot.feeTemplatesAdoptedFromRuleVersion }
        : null,
  };
  const state = ((): FeeTemplateAdoptionState => {
    if (snapshot !== undefined && (snapshot.feeTemplates?.length ?? 0) > 0) return "NOT_NEEDED";
    if (company === null || snapshot === undefined) return "NO_COMPANY_SNAPSHOT";
    if (company.isActive === false) return "COMPANY_INACTIVE";
    if (liveTemplates.length === 0) return "COMPANY_HAS_NO_TEMPLATES";
    // The same amount rule `adoptCompanyFeeTemplates` asserts: a read that
    // offered an action the mutation would refuse is a dead end on the screen.
    if (!liveTemplates.every((template) => isMinorAmount(template.estimatedAmountMinor))) {
      return "COMPANY_TEMPLATES_UNREADABLE";
    }
    // The same count predicate `assertFeeTemplatesWithinLimit` refuses on.
    if (feeTemplatesExceedConfigurationLimit(liveTemplates)) return "COMPANY_TEMPLATES_OVER_LIMIT";
    if (
      app.status === "CLOSED" ||
      app.status === "CANCELLED" ||
      app.status === "REJECTED" ||
      app.handoverStatus === "HANDED_OVER" ||
      app.vehicleHandoverAt !== undefined ||
      app.finalizedSaleId !== undefined
    ) {
      return "BLOCKED_DEAL_PROGRESSED";
    }
    if (args.liveFeeCount > 0 || args.custodyRecorded) return "BLOCKED_COSTS_RECORDED";
    return "AVAILABLE";
  })();
  return { state, ...base };
}

/**
 * The deal's finance company row, re-scoped to the org, or null when the deal
 * has none (a manual financier) or the row is gone.
 */
async function companyFor(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">
): Promise<Doc<"financeCompanies"> | null> {
  if (app.companyId === undefined) return null;
  const company = await ctx.db.get(app.companyId);
  return company !== null && company.orgId === app.orgId ? company : null;
}

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
 * classification at the platform transaction limit even while the deal had
 * fewer than 500 live lines.
 */
function custodyActualExpensesMinor(
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
 * reconciliation or classification gate that compared against a corrupt
 * balance would be deciding on a number that is not one; every such gate
 * calls this and fails closed with the reason instead.
 */
function summarizeReadableCustody(
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
function assertFeeCustodyCurrency(
  line: Pick<Doc<"financeDealFees">, "currency">,
  custody: Pick<Doc<"financeDealCustody">, "currency">,
  action: string
): void {
  if (line.currency === custody.currency) return;
  throw new ConvexError(
    `This cost is recorded in ${line.currency} while the custody record is in ${custody.currency}; the two cannot be summed, so ${action} is refused. Correct the line's currency or release it from custody first; nothing has been changed.`
  );
}

/**
 * Resolves the custody record a fee line may be charged against.
 *
 * Shared by `recordDealFee` and `recordActualFeeAmount`, which had the same
 * four checks written out twice — and a divergence between two copies of a
 * money guard is the kind that survives review because both copies look right
 * on their own.
 */
async function resolveFeeCustody(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">,
  custodyId: Id<"financeDealCustody">,
  line: Pick<Doc<"financeDealFees">, "paidBy" | "deductedFromSettlement" | "accountingTreatment" | "currency">,
  actorId: Id<"users">
): Promise<Id<"financeDealCustody">> {
  const custody = await requireOwnedRow(
    ctx, orgId, "financeDealCustody", custodyId, CUSTODY_NOT_FOUND
  );
  if (custody.applicationId !== applicationId) {
    throw new ConvexError("That custody record belongs to a different deal.");
  }
  assertFeeCustodyCurrency(line, custody, "charging this cost to the custody record");
  // The holder never charges a cost to their own record: it is the amount
  // they are reimbursed for (final round E).
  assertNotCustodian(custody, actorId, "Charging a cost to a custody record");
  assertCustodyOpen(custody);
  assertCustodyOnLedger(custody, "charging a cost to it");
  // The custody balance is "what this person spent of the money they hold".
  // Charging it for a cost somebody ELSE paid drives that balance to zero while
  // the cash is still in their pocket, and the record then reconciles and
  // closes clean. An obvious mis-click once a UI offers the deal's custody in a
  // dropdown.
  if (line.paidBy !== "EMPLOYEE") {
    throw new ConvexError(
      "A cost charged to an employee's custody must be recorded as paid by that employee. Remove the custody link, or record who actually paid."
    );
  }
  // A line the finance company WITHHOLDS from the remittance is recognised by
  // the financed-sale plan at finalization. Charging the same line to custody
  // would expense it a second time — once from the employee's cash and once
  // out of the consideration. One fee, one place.
  if (line.deductedFromSettlement) {
    throw new ConvexError(
      "This cost is deducted from the finance company's settlement, so it is recognised there; it cannot also be paid out of an employee's custody."
    );
  }
  // The same eligibility the posting rule enforces, asked at the boundary so
  // the line is refused BEFORE it exists rather than when its actual posts.
  const expense = custodyFeeExpenseKey(line.accountingTreatment);
  if (expense.systemKey === null) throw new ConvexError(expense.refusal);
  await assertCustodyAccountingReady(ctx, orgId, "charging a cost to an employee's custody");
  return custody._id;
}

/**
 * Deletes the blobs a replacement attachment list drops.
 *
 * Replacing the attachments wholesale left the old blobs referenced by nothing
 * — and both deletion paths enumerate ROWS, so an orphan survives the org
 * hard-delete and the financial reset alike. `financeAppraisals`, the only
 * other storage carrier here, is append-only and never hit this.
 */
async function deleteDroppedAttachments(
  ctx: MutationCtx,
  previous: Array<Id<"_storage">> | undefined,
  next: Array<Id<"_storage">> | undefined
): Promise<void> {
  if (!next) return;
  for (const storageId of (previous ?? []).filter((id) => !next.includes(id))) {
    const metadata = await ctx.db.system.get("_storage", storageId);
    if (metadata) await ctx.storage.delete(storageId);
  }
}

/**
 * Whether a reversal may cancel the movement it names.
 *
 * Seven checks that all have to hold before an entry is admitted, lifted out of
 * the handler so the handler reads as: authorize, validate the amount, validate
 * the kind, insert.
 */
async function assertReversalAllowed(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  custodyId: Id<"financeDealCustody">,
  reversesEntryId: Id<"financeDealCustodyEntries"> | undefined,
  amountMinor: number
): Promise<void> {
  if (!reversesEntryId) {
    throw new ConvexError("Say which movement this reverses.");
  }
  const target = await requireOwnedRow(
    ctx, orgId, "financeDealCustodyEntries", reversesEntryId,
    "That movement was not found in this organization."
  );
  if (target.custodyId !== custodyId) {
    throw new ConvexError("That movement belongs to a different custody record.");
  }
  if (target.kind === "REVERSAL") {
    throw new ConvexError("A reversal cannot itself be reversed. Record the movement again.");
  }
  if (target.amountMinor !== amountMinor) {
    throw new ConvexError(
      `A reversal must cancel the whole movement. That one was ${target.amountMinor} minor units.`
    );
  }
  // "Already reversed?" is one indexed point read (`by_reverses`), the same
  // read the movement log answers it with — not a scan of the whole log.
  const priorReversal = await ctx.db
    .query("financeDealCustodyEntries")
    .withIndex("by_reverses", (q) => q.eq("reversesEntryId", reversesEntryId))
    .first();
  if (priorReversal !== null) {
    throw new ConvexError("That movement has already been reversed.");
  }

  // A reimbursement is calculated against what the person was given: they spent
  // more than the advance, so the difference was paid back to them. Retracting
  // the issuance afterwards leaves that payment standing on a baseline that no
  // longer exists, and the outstanding figure silently re-derives the entire
  // advance as a fresh debt — a settled record turning into "700 still owed"
  // with nobody having moved any money.
  //
  // This is not the totals invariant and cannot be enforced there: zero issued
  // alongside a reimbursement is a perfectly true state on its own, it is what
  // paying out of pocket looks like. What is not true is reaching it by
  // withdrawing the issuance the reimbursement was measured from, so the guard
  // belongs on that dependency.
  if (target.kind !== "ISSUED") return;
  // The whole log, bounded, for the one check that needs it; refused past
  // the cap rather than decided on a prefix.
  const already = await custodyEntriesFor(ctx, custodyId, "reversing this issuance");
  const reversed = new Set(
    already
      .filter((row) => row.kind === "REVERSAL" && row.reversesEntryId)
      .map((row) => row.reversesEntryId!)
  );
  const settledAgainst = already.filter(
    (row) => row.kind === "REIMBURSED" && !reversed.has(row._id)
  );
  if (settledAgainst.length > 0) {
    const paidMinor = settledAgainst.reduce((sum, row) => sum + row.amountMinor, 0);
    throw new ConvexError(
      `A reimbursement of ${paidMinor} minor units was already paid against this handover. Reverse that reimbursement first, otherwise the payment stays on the record measured against an issuance that no longer exists.`
    );
  }
}

/**
 * The entries a custody log's reversals cancel — after EVERY historical
 * reversal has been proven well-formed against the same bounded log.
 *
 * A reversal is a claim that one earlier movement never counted. Taken on
 * trust, a corrupt one (legacy or raw-edited; the schema admits it) removes
 * money from the totals that was really moved: a reversal of 1 against an
 * issuance of 700,000 erased the whole advance, a reversal naming an entry on
 * another custody record erased a movement that was never on this log, and
 * two reversals of one target cancelled it twice as far as the set was
 * concerned. `assertReversalAllowed` proves all of this for the reversal
 * being RECORDED; the totals are recomputed from the stored log, so the log
 * is proven again here, in full, before a single amount is added. Any
 * failure throws uncaught, and the caller's insert rolls back with it.
 */
function validatedReversalTargets(
  entries: ReadonlyArray<Doc<"financeDealCustodyEntries">>,
  custody: Pick<Doc<"financeDealCustody">, "_id" | "orgId">
): Set<Id<"financeDealCustodyEntries">> {
  const byId = new Map(entries.map((entry) => [entry._id, entry]));
  const reversedIds = new Set<Id<"financeDealCustodyEntries">>();
  // Annotated on the binding, which is what lets control flow treat a call
  // as a throw and narrow `target` below it.
  const refuse: (what: string) => never = (what) => {
    throw new ConvexError(
      `A reversal on this custody record ${what}, so its totals cannot be recomputed. Correct that movement before recording more.`
    );
  };
  for (const reversal of entries) {
    if (reversal.kind !== "REVERSAL") continue;
    if (!isMinorAmount(reversal.amountMinor) || reversal.amountMinor <= 0) {
      refuse(`carries an amount that is not a positive readable figure (${reversal.amountMinor})`);
    }
    if (reversal.reversesEntryId === undefined) refuse("names no movement to cancel");
    // Both rows are anchored to the CUSTODY RECORD's org — never to each
    // other, which would let two rows sharing the same wrong org pass.
    if (reversal.orgId !== custody.orgId) refuse("belongs to another organization");
    const target = byId.get(reversal.reversesEntryId);
    // Same bounded log, so same custody by construction — the org and custody
    // are still compared, because a row is what it says, not where it was read.
    if (target === undefined || target.custodyId !== custody._id || target.orgId !== custody.orgId) {
      refuse("names a movement that is not on this custody record");
    }
    if (target.kind === "REVERSAL") refuse("names another reversal, which cannot itself be reversed");
    if (!isMinorAmount(target.amountMinor) || target.amountMinor !== reversal.amountMinor) {
      refuse(`cancels ${reversal.amountMinor} against a movement of ${target.amountMinor}; a reversal must cancel the whole movement`);
    }
    if (reversedIds.has(target._id)) refuse("names a movement that is already reversed");
    reversedIds.add(target._id);
  }
  return reversedIds;
}

/**
 * The totals a custody log projects to, after every entry and every reversal
 * on it has been proven well-formed. Shared by `recomputeCustodyTotals`,
 * which persists them, and by the legacy migration, which compares them with
 * what the row already claims and refuses on a disagreement rather than
 * deciding which side to believe.
 */
function custodyTotalsFromLog(
  entries: ReadonlyArray<Doc<"financeDealCustodyEntries">>,
  custody: Pick<Doc<"financeDealCustody">, "_id" | "orgId">
): { issuedMinor: number; returnedMinor: number; reimbursedMinor: number } {
  const reversedIds = validatedReversalTargets(entries, custody);

  let issuedMinor = 0;
  let returnedMinor = 0;
  let reimbursedMinor = 0;
  const add = (kind: Doc<"financeDealCustodyEntries">["kind"], amount: number): void => {
    // No `else` fallback. A future kind falling through to "reimbursed" would
    // inflate what the dealership has paid back, drive the outstanding figure
    // to zero and report the record settled — the "unknown treated as fine"
    // shape, with the compiler silent because `else` accepts anything.
    switch (kind) {
      case "ISSUED":
        issuedMinor += amount;
        return;
      case "RETURNED":
        returnedMinor += amount;
        return;
      case "REIMBURSED":
        reimbursedMinor += amount;
        return;
      case "REVERSAL":
        return;
      default: {
        const unhandled: never = kind;
        throw new ConvexError(
          `Unhandled custody entry kind ${String(unhandled)}. Its effect on the balance has to be stated explicitly.`
        );
      }
    }
  };

  for (const entry of entries) {
    // A reversal and the entry it cancels contribute nothing between them, so
    // both are skipped rather than one being subtracted from the other —
    // netting a negative AND skipping the target applied the correction twice.
    // Both rows stay in the table; only their effect on the totals is removed.
    if (entry.kind === "REVERSAL") continue;
    if (reversedIds.has(entry._id)) continue;
    // Every HISTORICAL entry is re-validated, not only the one this mutation
    // just inserted: the writers assert the amount, the schema does not, and
    // a corrupt entry (legacy or raw-edited) would otherwise be folded into a
    // total that the mutation then persists as fact. The throw rolls the
    // caller's insert back with it — nothing commits.
    if (!isMinorAmount(entry.amountMinor)) {
      throw new ConvexError(
        `A recorded movement on this custody record (${entry.kind}, ${entry.amountMinor}) is not a readable amount, so its totals cannot be recomputed. Correct that movement before recording more.`
      );
    }
    add(entry.kind, entry.amountMinor);
  }
  // Safe entries can still add to an unsafe total; a total that is not a
  // safe integer is not persisted.
  if (![issuedMinor, returnedMinor, reimbursedMinor].every((total) => Number.isSafeInteger(total))) {
    throw new ConvexError(
      "The movements on this custody record add up to an amount outside the readable range, so its totals cannot be recomputed."
    );
  }

  // The invariant, enforced once where every path converges rather than per
  // movement. Guarding only the RETURNED mutation left the reversal of an
  // ISSUED entry free to reach the same state from the other side: return the
  // whole advance, then reverse the issuance, and the log says more came back
  // than ever went out — after which the module reported a reimbursement due
  // and instructed somebody to pay it. A throw here rolls the entry insert back
  // with it, so no path can commit a log that cannot be true.
  if (returnedMinor > issuedMinor) {
    throw new ConvexError(
      `That would leave ${returnedMinor} minor units returned against ${issuedMinor} issued, which cannot both be true. Reverse the return as well, or record the issuance that is missing.`
    );
  }
  return { issuedMinor, returnedMinor, reimbursedMinor };
}

/**
 * Recomputes a custody record's totals from its entries.
 *
 * The totals are a projection of the movement log, never a number a caller
 * hands in — so correcting a mistyped issuance means adding a correcting entry
 * that stays visible, rather than overwriting a figure and losing the fact that
 * it ever differed.
 */
async function recomputeCustodyTotals(
  ctx: MutationCtx,
  custodyId: Id<"financeDealCustody">
): Promise<void> {
  // Bounded, and refused past the bound: a total decided on a prefix of the
  // log would be persisted as fact. The throw rolls the caller's insert back.
  const entries = await custodyEntriesFor(ctx, custodyId, "recomputing this custody record's totals");
  // The custody row is the anchor every entry is proven against — its org and
  // its id — not the entries' own claims about themselves.
  const custody = await ctx.db.get(custodyId);
  if (custody === null) throw new ConvexError(CUSTODY_NOT_FOUND);
  await ctx.db.patch(custodyId, {
    ...custodyTotalsFromLog(entries, custody),
    updatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every cost and custody record on a deal, with the totals a person reads. */
export const listDealCosts = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    // The plan names a person and an amount: `financeApplicationProjection`
    // classes it DISBURSEMENT_WORKFLOW (VIEW_FINANCE or the disbursement
    // permission), and this secondary read honours the same tier rather than
    // serving it to every application viewer (Codex AF-CUST-05, ACC-10).
    const mayReadPlan =
      isSystemOwnerRole(auth.role) ||
      auth.role.permissions.includes(PERMISSIONS.VIEW_FINANCE) ||
      auth.role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);

    // The same bounded read the writers make, and the ONE thing this read
    // refuses on: past `MAX_LIVE_DEAL_FEE_LINES` the screen would be showing
    // a prefix of a deal's costs that reads like the whole of them.
    const fees = await loadActiveFees(ctx, args.applicationId);
    const custodyRows = await custodyPageFor(ctx, args.applicationId);

    // The deal's denomination as the WRITERS would resolve it. Short of that
    // row cap a read does not refuse (a query that throws blanks the screen),
    // so a contradiction is reported in the payload instead: the per-line
    // facts stay readable in their own currency, and every scalar total is
    // withheld with the reason.
    const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));
    const lineCurrencies = [...new Set(fees.map((fee) => fee.currency))];
    const foreignLineCurrencies = lineCurrencies.filter((code) => code !== currency);
    // The same contract for an amount nobody can read: a line carrying NaN, a
    // fraction, a negative or an unsafe value (legacy or raw-edited — the
    // writers refuse them, the rows do not) makes every total a non-figure,
    // and the totals are withheld with the reason rather than served corrupt.
    const amountsUnreadable = unreadableFeeAmounts(fees);
    const summaryUnavailable =
      foreignLineCurrencies.length > 0
        ? {
            reason: "MIXED_DENOMINATION" as const,
            dealCurrency: currency,
            lineCurrencies,
            message: `Costs on this deal are recorded in ${lineCurrencies.join(", ")} while the deal is in ${currency}; totals are unavailable until the records agree.`,
          }
        : amountsUnreadable !== null
          ? {
              reason: amountsUnreadable,
              dealCurrency: currency,
              lineCurrencies,
              message:
                "A cost amount on this deal is not a readable minor-unit figure; totals are unavailable until the line is corrected.",
            }
          : null;

    // Bounded on purpose: the custody SUMMARY is served here, capped and
    // flagged; the movement log behind each record is served by
    // `listCustodyMovements`, paginated, one record at a time. Hydrating
    // every movement of every record inside this read is what could take a
    // deal past the platform's read limits and blank the screen.
    const custodyTruncated = custodyRows.length > MAX_DEAL_CUSTODY_RECORDS;
    const boundedCustody = custodyRows.slice(0, MAX_DEAL_CUSTODY_RECORDS);

    const custody = [];
    for (const row of boundedCustody) {
      // A custody record is balanced against the actuals on the lines it paid
      // for. If any of those lines is in another currency the arithmetic is
      // meaningless, and the record is reported without a summary.
      const paidLines = fees.filter((fee) => fee.custodyId === row._id);
      const custodyMismatch =
        row.currency !== currency || paidLines.some((fee) => fee.currency !== row.currency);
      // The same fail-closed contract as the deal totals: a stored total or a
      // linked actual that is not a readable figure withholds the balance
      // with its own reason. The screen stays up; the record shows no money.
      const actualExpensesMinor = custodyActualExpensesMinor(fees, row._id);
      const custodyUnreadable = custodyMismatch ? null : unreadableCustodyAmounts(row, actualExpensesMinor);
      const holder = await ctx.db.get(row.userId);
      // The latest payable reclassification issued for this record, and
      // whether the ledger has it yet: a version dated into a closed month
      // waits in the outbox with every later one queued behind it, and the
      // screen must not present the row's target as a posted balance.
      const latestReclass = row.payableReclassVersion ?? 0;
      const payableAwaitingPost =
        latestReclass > 0 && !(await custodyPayableReclassPosted(ctx, args.orgId, row._id, latestReclass));
      custody.push({
        ...row,
        /** Who holds the money — the assignee, by display name only; never an address. */
        userName: holder?.name ?? "",
        /** Opened before custody posted to the ledger: every money command refuses it (`assertCustodyOnLedger`). */
        legacy: row.ledgerPosting !== "CANONICAL",
        /** The latest EMPLOYEE_REIMBURSEMENTS_PAYABLE reclassification for this record is still queued, so `payableTargetMinor` is not yet what the books carry. */
        payableAwaitingPost,
        /** The live lines this custody paid for, by id. */
        paidFeeIds: paidLines.map((fee) => fee._id),
        summary:
          custodyMismatch || custodyUnreadable !== null || actualExpensesMinor === null
            ? null
            : summarizeCustody(row, actualExpensesMinor),
        summaryUnavailable: custodyMismatch
          ? { reason: "MIXED_DENOMINATION" as const, custodyCurrency: row.currency, dealCurrency: currency }
          : custodyUnreadable !== null
            ? { reason: custodyUnreadable, custodyCurrency: row.currency, dealCurrency: currency }
            : null,
      });
    }

    const summary = summaryUnavailable === null ? summarizeFees(fees) : null;
    const expectedFees = deriveExpectedFees({
      snapshot: app.companyRuleSnapshot,
      fees,
      currency,
      actualTotalMinor: summary ? summary.actualTotalMinor : null,
    });
    const plannedHolder = mayReadPlan && app.plannedCustody ? await ctx.db.get(app.plannedCustody.userId) : null;
    return {
      currency,
      fees: fees.map((fee) => ({
        ...fee,
        status: deriveFeeStatus(fee),
        /** Whether this line may be charged to an employee's custody from the screen — the boundary's own rules. */
        custodyEligible:
          fee.paidBy === "EMPLOYEE" &&
          !fee.deductedFromSettlement &&
          custodyFeeExpenseKey(fee.accountingTreatment).systemKey !== null &&
          // Every custody record is opened in the deal's currency, so a line
          // in any other currency matches no record (R5, F4).
          fee.currency === currency,
      })),
      /**
       * Whether the org's ledger can take a custody posting right now, with the
       * reason it cannot — the same predicate every custody money mutation
       * refuses on, so a disabled button and a refusal say one thing.
       */
      custodyAccounting: await dealCustodyAccountingReadiness(ctx, args.orgId),
      /** Whether a posting dated today lands now or queues for a period to be opened. */
      custodyPostsNow: (await getOpenPeriodForDate(ctx, args.orgId, Date.now())) !== null,
      /** Whether posting-bearing edits are refused because the sale is recognized — the writers' own predicate. */
      economicsFrozen: dealEconomicsFrozen(app),
      /** Whether NEW custody cash may be issued on this deal — the issuing commands' own predicate, stopped states included. */
      acceptsNewCustodyCash: dealAcceptsNewCustodyCash(app),
      /** Withheld from a caller below the disbursement tier — `plannedCustody` is then null and says nothing about whether a plan exists. */
      plannedCustodyWithheld: !mayReadPlan,
      /** Who is planned to handle the payments, before any cash moves. Display name only. */
      plannedCustody: mayReadPlan && app.plannedCustody
        ? {
            userId: app.plannedCustody.userId,
            userName: plannedHolder?.name ?? "",
            amountMinor: app.plannedCustody.amountMinor ?? null,
            note: app.plannedCustody.note ?? null,
            plannedAt: app.plannedCustody.plannedAt,
          }
        : null,
      /** What the policy says the employee will need at the counter — a recommendation, never issued or stored. */
      recommendedCustody: deriveRecommendedCustody(expectedFees),
      // Null, never a plausible number, when the lines do not share the deal's
      // currency. A client that renders `summary.actualTotalMinor` has to
      // handle the absence — that is the contract, not a hidden total.
      summary,
      summaryUnavailable,
      // The checklist the finance company's frozen policy implies — expected
      // rows and total derived from the application's own rule snapshot, each
      // matched to the live line that records its actual. Read-only: nothing
      // here is a line, and nothing here is written.
      expected: {
        ...expectedFees,
        // Whether "not configured" is the whole story, or the company has
        // since configured fees an owner may adopt. Reported, never applied.
        adoption: deriveFeeTemplateAdoption({
          app,
          company: await companyFor(ctx, app),
          liveFeeCount: fees.length,
          custodyRecorded: custodyRows.length > 0,
        }),
      },
      custody,
      /** More custody records exist than this read hydrates; the list above is a prefix. */
      custodyTruncated,
      // Stated rather than derived: PENDING_CLASSIFICATION is what an unset
      // value means, and saying so beats every caller re-deriving it.
      accountingClassification: app.accountingClassification ?? "PENDING_CLASSIFICATION",
      legalInvoiceAmountMinor: app.legalInvoiceAmountMinor,
      legalInvoiceNumber: app.legalInvoiceNumber,
      legalInvoiceDate: app.legalInvoiceDate,
      legalInvoiceIssuedTo: app.legalInvoiceIssuedTo,
    };
  },
});

/**
 * Adopts the finance company's CURRENTLY configured fee templates onto a deal
 * whose rule snapshot was frozen without any.
 *
 * Explicit and owner-only — the same authority that edits the company's fees
 * (`finance.updateCompany` requires the owner). Audited with an override row
 * naming what was adopted and from which company revision, and the snapshot
 * itself records the adoption, so a later reader can tell "frozen with these
 * fees at creation" from "adopted these fees on <date> from version N".
 *
 * Refuses exactly where `deriveFeeTemplateAdoption` says it is not AVAILABLE,
 * from the same predicate, so the screen never offers an action the server
 * would reject. A snapshot that already carries templates is NEVER rewritten
 * here — this adopts INTO an empty slot, it does not replace.
 */
export const adoptCompanyFeeTemplates = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireOwner(ctx, args.orgId);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError("Say why this deal is adopting the company's configured fees.");
    }

    const company = await companyFor(ctx, app);
    const fees = await loadActiveFees(ctx, app._id);
    // Existence is the whole question here, so the read is one indexed row —
    // never the full custody set, which only the writers that balance every
    // record need to hydrate.
    const anyCustody = await ctx.db
      .query("financeDealCustody")
      .withIndex("by_application", (q) => q.eq("applicationId", app._id))
      .first();
    const adoption = deriveFeeTemplateAdoption({
      app,
      company,
      liveFeeCount: fees.length,
      custodyRecorded: anyCustody !== null,
    });
    if (adoption.state !== "AVAILABLE" || company === null || app.companyRuleSnapshot === undefined) {
      const why: Record<FeeTemplateAdoptionState, string> = {
        NOT_NEEDED: "This deal already carries configured fees; they are never replaced.",
        AVAILABLE: "",
        COMPANY_HAS_NO_TEMPLATES: "The finance company has no fees configured to adopt.",
        NO_COMPANY_SNAPSHOT: "This deal has no finance-company rule snapshot to adopt fees into.",
        COMPANY_INACTIVE: "This finance company is deactivated; its fees are not adopted onto deals.",
        BLOCKED_COSTS_RECORDED:
          "Costs or custody have already been recorded on this deal without a policy; adopting one now would rewrite what was expected of them.",
        BLOCKED_DEAL_PROGRESSED:
          "The vehicle has been handed over or the deal is closed; its expected costs are history and are not rewritten.",
        COMPANY_TEMPLATES_UNREADABLE:
          "One of the finance company's configured fees has an amount that cannot be read as money. Correct the company's fee configuration before adopting it onto this deal.",
        COMPANY_TEMPLATES_OVER_LIMIT:
          "The finance company has more fees configured than one policy may carry. Save a compliant fee list on the company before adopting it onto this deal.",
      };
      throw new ConvexError(why[adoption.state] || "The company's fees cannot be adopted onto this deal.");
    }
    const templates = company.feeTemplates ?? [];
    // Held to the same configuration policy a fresh snapshot is held to.
    assertFeeTemplatesWithinLimit(templates, `Adopting ${company.name}'s fees onto this deal`);
    // And to the same amount rule the company WRITERS enforce — on the stored
    // rows, not on what was once submitted. `v.number()` admits NaN, Infinity,
    // fractions, negatives and unsafe values, and a template written before
    // that guard existed, or raw-edited since, carries whatever it carries.
    // Refused BEFORE the audit row and the snapshot patch: a corrupt policy is
    // never frozen onto a deal as what its costs are expected to be.
    templates.forEach((template, index) => {
      assertMinorAmount(
        template.estimatedAmountMinor,
        `Configured fee #${index + 1} (${template.feeType}) estimated amount`
      );
    });

    const now = Date.now();
    const fromRuleVersion = company.ruleVersion ?? 1;
    await ctx.db.insert("financeApplicationOverrides", {
      orgId: args.orgId,
      applicationId: app._id,
      field: "companyRuleSnapshot.feeTemplates",
      previousValue: "none (frozen without fee templates)",
      newValue: `${templates.length} configured fee(s) adopted from ${company.name} rule version ${fromRuleVersion}`,
      reason,
      changedBy: user._id,
      changedAt: now,
    });
    await invalidateClassification(
      ctx, app, user._id,
      "The finance company's configured fees were adopted onto the deal after its accounting was classified."
    );
    await ctx.db.patch(app._id, {
      companyRuleSnapshot: {
        ...app.companyRuleSnapshot,
        feeTemplates: templates,
        feeTemplatesAdoptedFromRuleVersion: fromRuleVersion,
        feeTemplatesAdoptedAt: now,
        feeTemplatesAdoptedBy: user._id,
      },
      updatedAt: now,
    });
    return { adoptedCount: templates.length, fromRuleVersion };
  },
});

// ---------------------------------------------------------------------------
// Cost lines
// ---------------------------------------------------------------------------

export const recordDealFee = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    feeType: financeFeeTypeValidator,
    description: v.optional(v.string()),
    estimatedAmountMinor: v.optional(v.number()),
    actualAmountMinor: v.optional(v.number()),
    paidBy: feePartyValidator,
    paidTo: feePartyValidator,
    /** Required on purpose — see the schema note. Never inferred from paidBy. */
    accountingTreatment: feeAccountingTreatmentValidator,
    includedInQuotation: v.optional(v.boolean()),
    deductedFromSettlement: v.optional(v.boolean()),
    refundable: v.optional(v.boolean()),
    custodyId: v.optional(v.id("financeDealCustody")),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    source: v.optional(v.union(v.literal("COMPANY_TEMPLATE"), v.literal("MANUAL"))),
    /**
     * REQUIRED. The currency the caller entered the minor-unit amounts in
     * (SCRUM-319). The server never trusts it as the denomination — it proves
     * the deal's own and refuses when the two differ — but without it a form
     * rendered in USD could submit cents onto a deal whose lines are fils and
     * nothing would notice until settlement.
     */
    expectedCurrency: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
    const user = auth.user;
    assertExpectedCurrency(args.expectedCurrency, "recording this cost");
    // A configured fee's line is written by `recordTemplateFeeActual` alone,
    // which copies the finance company's policy from the deal's frozen
    // snapshot. Minting the COMPANY_TEMPLATE source here would let a caller
    // author a line that reads exactly like one — feeType, description,
    // expectation and all — and have the checklist and the closure gate treat
    // a configured fee as recorded on the caller's say-so.
    if (args.source === "COMPANY_TEMPLATE") {
      throw new ConvexError(
        "A configured fee is recorded through the deal's checklist, against the finance company's own template — not as a typed line. Record the actual for the configured fee, or record this as an additional cost."
      );
    }
    // Inline rather than behind a helper: scripts/tenantWriteGuard only accepts
    // proof it can see inside the handler, and "the ownership check is
    // somewhere else" is the exact shape that shipped two Criticals.
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );

    if (args.estimatedAmountMinor !== undefined) {
      assertMinorAmount(args.estimatedAmountMinor, "Estimated amount");
    }
    if (args.actualAmountMinor !== undefined) {
      assertMinorAmount(args.actualAmountMinor, "Actual amount");
    }
    // A line with neither figure is allowed — "there will be a transfer fee,
    // amount unknown" is a real state, and one worth recording rather than
    // leaving to memory. It just cannot close the deal; see requireCostsClosable.

    assertTimestamp(args.paidAt, "The paid date");
    assertNotFuture(args.paidAt, Date.now(), "The paid date");
    // A line charged to custody posts a custody journal: custody authority.
    if (args.custodyId) assertMayPostCustody(auth, "Charging a cost to an employee's custody");

    // A cost line is additive: a retried submit does not overwrite anything, it
    // adds a second real charge, and `actualTotalMinor` rises by an amount
    // nobody spent. Every other money-recording surface in this codebase
    // (expenses, deposits, the cash drawer) already takes a key for exactly
    // this; there is no reason a deal's costs should be the one that does not.
    // Ownership and permission are checked above, outside the wrapper, so a
    // replay is still authorized rather than trusting the stored result.
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.recordDealFee",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // The command's WHOLE persisted input, normalised exactly as it is
        // stored below (SCRUM-319 / AF-215-02). The previous fingerprint
        // omitted description, paidAt, includedInQuotation, refundable, the
        // attachments and the source — so a retry carrying a different
        // description or payment date under the same key replayed the first
        // row's id and silently dropped the operator's second intent. Same
        // key + same intent replays; same key + any changed field refuses.
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          feeType: args.feeType,
          expectedCurrency: args.expectedCurrency,
          description: args.description?.trim() || null,
          estimatedAmountMinor: args.estimatedAmountMinor ?? null,
          actualAmountMinor: args.actualAmountMinor ?? null,
          paidBy: args.paidBy,
          paidTo: args.paidTo,
          accountingTreatment: args.accountingTreatment,
          includedInQuotation: args.includedInQuotation ?? false,
          // Persisted below and summed by settlementDeductedTotalMinor, so it
          // changes the dealer remittance. Two fees identical except for this
          // flag are DIFFERENT economic instructions.
          deductedFromSettlement: args.deductedFromSettlement ?? false,
          refundable: args.refundable ?? false,
          custodyId: args.custodyId ?? null,
          paidAt: args.paidAt ?? null,
          receiptReference: args.receiptReference?.trim() || null,
          documentStorageIds: args.documentStorageIds?.map((id) => id.toString()) ?? null,
          source: args.source ?? "MANUAL",
        }),
      },
      async () => {
        // ⚠️ Every MUTABLE-state check lives inside the section (Codex
        // AF-CUST-06): a replay of a line that was written must return it
        // even if the deal froze, the custody closed or the org's currency
        // moved since — those refusals describe the world after the success
        // they would otherwise deny. Caller authority and the input's own
        // shape stay outside, where a replay is still authorized.
        assertDealEconomicsOpen(app, "adding a cost");
        // The deal's denomination, proven BEFORE any write: the pin when
        // there is one, else the org's verified currency — which the first
        // cost line then fixes, because `orgSettings.upsert` refuses to
        // change it once this row exists. Resolved before the custody
        // record is, because the line's currency is what that record must
        // match (R5, F4).
        const currency = await resolveDealCurrency(ctx, app, "recording this cost");
        if (args.expectedCurrency !== currency) {
          throw new ConvexError(
            `This cost was entered in ${args.expectedCurrency}, but the deal's costs are kept in ${currency}. Reload the deal and enter the amount in ${currency}.`
          );
        }
        let custodyId: Id<"financeDealCustody"> | undefined;
        if (args.custodyId) {
          custodyId = await resolveFeeCustody(ctx, args.orgId, args.applicationId, args.custodyId, {
            paidBy: args.paidBy,
            deductedFromSettlement: args.deductedFromSettlement ?? false,
            accountingTreatment: args.accountingTreatment,
            currency,
          }, user._id);
        }
        // An exact replay of a line already recorded returns it above this,
        // and a NEW line on a deal already at the live-line cap is refused
        // with the classification untouched and no command record kept.
        assertRoomForAnotherLine(await loadActiveFees(ctx, args.applicationId), "recording this cost");

        await invalidateClassification(
          ctx, app, user._id,
          "A new cost was added to the deal after its accounting was classified."
        );

        const now = Date.now();
        const feeId = await ctx.db.insert("financeDealFees", {
          orgId: args.orgId,
          applicationId: args.applicationId,
          feeType: args.feeType,
          description: args.description?.trim() || undefined,
          currency,
          estimatedAmountMinor: args.estimatedAmountMinor,
          actualAmountMinor: args.actualAmountMinor,
          paidBy: args.paidBy,
          paidTo: args.paidTo,
          accountingTreatment: args.accountingTreatment,
          includedInQuotation: args.includedInQuotation ?? false,
          deductedFromSettlement: args.deductedFromSettlement ?? false,
          refundable: args.refundable ?? false,
          custodyId,
          paidAt: args.paidAt,
          receiptReference: args.receiptReference?.trim() || undefined,
          documentStorageIds: args.documentStorageIds,
          source: args.source ?? "MANUAL",
          createdBy: user._id,
          createdAt: now,
          updatedAt: now,
        });
        // Inside the idempotent section with the insert: a replay returns the
        // stored id above and never posts a second time.
        if (custodyId) await syncCustodyFeePosting(ctx, feeId, user._id, "Handover cost recorded against custody.");
        return feeId;
      }
    );
  },
});

/**
 * Records the ACTUAL paid for a fee the finance company's frozen policy
 * configures — the only thing an operator enters on a configured row (owner
 * product correction, #scrum-215 2026-09-12 21:05).
 *
 * The caller names WHICH configured fee, by its position in the application's
 * frozen `companyRuleSnapshot.feeTemplates`, and the amount they paid. Every
 * other field of the line — the expected amount, description, who pays, who is
 * paid, the quotation and settlement flags, the accounting treatment — is
 * copied from that snapshot entry HERE. The client restates none of the
 * company's policy and cannot author an expectation: the line's
 * `estimatedAmountMinor` is the template's, so a receipt that differs from it
 * is a comparison, never a rewrite.
 *
 * The position is the reference because the snapshot is immutable per
 * application, so it is exact even when two templates are identical — a name
 * would be ambiguous there; a position is not. It is validated the way
 * `v.number()` does not: a safe non-negative integer inside the array, and the
 * `feeType` the caller saw must be the one at that position (a stale reference
 * from an older render is refused, not silently re-pointed). Stored on the
 * line so the checklist can match it back exactly.
 *
 * One live line per position. A second recording against the same position
 * is refused and directed to `recordActualFeeAmount` on the existing line —
 * the same rule keeps a retry honest: the same key with the same intent
 * replays the first line's id; a new key against an existing line is refused
 * inside the idempotent section, so nothing is committed. Voiding the line
 * (audited) frees the position again.
 *
 * Not a new way to spend. The row it writes is an ordinary `financeDealFees`
 * line with the same fates as every other: re-recorded through
 * `recordActualFeeAmount`, checked through `reconcileDealFee`, voided through
 * `voidDealFee`, invalidating the classification like any other cost, summed
 * by `summarizeFees` and by `settlementDeductedTotalMinor` under the template's
 * own `deductedFromSettlement` flag.
 */
export const recordTemplateFeeActual = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /** Position of the template in the application's frozen snapshot. */
    templateIndex: v.number(),
    /** The fee type the caller saw at that position — a cross-check, never a source of policy. */
    feeType: financeFeeTypeValidator,
    actualAmountMinor: v.number(),
    /** REQUIRED. The currency the caller counted `actualAmountMinor` in (SCRUM-319). */
    expectedCurrency: v.string(),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    custodyId: v.optional(v.id("financeDealCustody")),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
    const user = auth.user;
    assertExpectedCurrency(args.expectedCurrency, "recording this cost");
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );

    // The reference, validated positively. `v.number()` admits NaN, Infinity,
    // negatives and fractions, and every one of them indexes an array to
    // `undefined` without a word.
    if (!Number.isSafeInteger(args.templateIndex) || args.templateIndex < 0) {
      throw new ConvexError(
        `The configured fee reference must be a non-negative whole number (got ${args.templateIndex}).`
      );
    }
    const templates = app.companyRuleSnapshot?.feeTemplates ?? [];
    if (app.companyRuleSnapshot === undefined || templates.length === 0) {
      throw new ConvexError(
        "This deal's finance company configured no fees when the deal was created, so there is no configured fee to record an actual for. Record it as an additional cost instead."
      );
    }
    if (args.templateIndex >= templates.length) {
      throw new ConvexError(
        `This deal's finance company configured ${templates.length} fee(s); there is no configured fee at position ${args.templateIndex}. Reload the deal.`
      );
    }
    const template = templates[args.templateIndex];
    if (template.feeType !== args.feeType) {
      throw new ConvexError(
        "The configured fee at that position is not the one you were shown. Reload the deal and record the actual against the fee as it is now listed."
      );
    }
    assertMinorAmount(args.actualAmountMinor, "Actual amount");
    if (args.custodyId) assertMayPostCustody(auth, "Charging a configured fee to an employee's custody");
    // The template's estimate is COPIED onto the line below — only when it is
    // a readable figure. A frozen snapshot is never rewritten, so a corrupt
    // estimate (legacy or raw-edited; the schema admits it) is neither
    // repaired nor propagated: the line is written WITHOUT an estimate, the
    // checklist keeps reporting the expected amount as unreadable, and the
    // real actual still satisfies the configured-position gate — the
    // operator is not stranded on a position nobody can record against.
    const estimatedAmountMinor = isMinorAmount(template.estimatedAmountMinor)
      ? template.estimatedAmountMinor
      : undefined;
    // A timestamp, not a number: `v.number()` admits NaN, Infinity and
    // negatives, and a stored NaN date is a row no report can order.
    assertTimestamp(args.paidAt, "The paid date");
    assertNotFuture(args.paidAt, Date.now(), "The paid date");

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.recordTemplateFeeActual",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // The WHOLE persisted input, position included: the same key against a
        // different position, amount, date, reference, attachment or custody
        // is a different intent and is refused, not replayed.
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          templateIndex: args.templateIndex,
          feeType: args.feeType,
          expectedCurrency: args.expectedCurrency,
          actualAmountMinor: args.actualAmountMinor,
          custodyId: args.custodyId ?? null,
          paidAt: args.paidAt ?? null,
          receiptReference: args.receiptReference?.trim() || null,
          documentStorageIds: args.documentStorageIds?.map((id) => id.toString()) ?? null,
        }),
      },
      async () => {
        // Mutable-state checks inside the section, as in `recordDealFee`
        // (Codex AF-CUST-06): the freeze, the custody's state and the deal's
        // denomination are judged for a NEW intent, never for a replay.
        assertDealEconomicsOpen(app, "recording a configured fee's actual");
        const currency = await resolveDealCurrency(ctx, app, "recording this cost");
        if (args.expectedCurrency !== currency) {
          throw new ConvexError(
            `This cost was entered in ${args.expectedCurrency}, but the deal's costs are kept in ${currency}. Reload the deal and enter the amount in ${currency}.`
          );
        }
        let custodyId: Id<"financeDealCustody"> | undefined;
        if (args.custodyId) {
          // The line is written in the deal's currency; the record must match it.
          custodyId = await resolveFeeCustody(ctx, args.orgId, args.applicationId, args.custodyId, { ...template, currency }, user._id);
        }
        // A replay of the SAME intent returns the line it already wrote
        // before reaching this, while
        // a NEW intent against a position that already has a live line is
        // refused here and rolls back with nothing committed. Proven on the
        // live-position index with every field an equality and `.unique()`:
        // a second live line at one position is a state this writer never
        // creates, and if one is ever found the read refuses rather than picks.
        const existing = await ctx.db
          .query("financeDealFees")
          .withIndex("by_application_source_templateIndex_voidedAt", (q) =>
            q
              .eq("applicationId", args.applicationId)
              .eq("source", "COMPANY_TEMPLATE")
              .eq("templateIndex", args.templateIndex)
              .eq("voidedAt", undefined)
          )
          .unique();
        if (existing) {
          throw new ConvexError(
            "An actual is already recorded for this configured fee. Edit that line to change the amount, or remove it first."
          );
        }
        // Same bound as `recordDealFee`, in the same place: before the
        // classification is touched or the line exists.
        assertRoomForAnotherLine(await loadActiveFees(ctx, args.applicationId), "recording this cost");

        await invalidateClassification(
          ctx, app, user._id,
          "A new cost was added to the deal after its accounting was classified."
        );

        const now = Date.now();
        const feeId = await ctx.db.insert("financeDealFees", {
          orgId: args.orgId,
          applicationId: args.applicationId,
          feeType: template.feeType,
          description: template.description?.trim() || undefined,
          currency,
          // The template's expectation, copied — never the caller's, and
          // never a corrupt one (see above).
          estimatedAmountMinor,
          actualAmountMinor: args.actualAmountMinor,
          paidBy: template.paidBy,
          paidTo: template.paidTo,
          accountingTreatment: template.accountingTreatment,
          includedInQuotation: template.includedInQuotation,
          deductedFromSettlement: template.deductedFromSettlement,
          refundable: template.refundable,
          custodyId,
          paidAt: args.paidAt,
          receiptReference: args.receiptReference?.trim() || undefined,
          documentStorageIds: args.documentStorageIds,
          source: "COMPANY_TEMPLATE",
          templateIndex: args.templateIndex,
          createdBy: user._id,
          createdAt: now,
          updatedAt: now,
        });
        if (custodyId) await syncCustodyFeePosting(ctx, feeId, user._id, "Configured fee actual recorded against custody.");
        return feeId;
      }
    );
  },
});

/**
 * Records what a cost actually came to.
 *
 * Kept apart from the estimate rather than replacing it, so the comparison
 * survives. Re-recording a different actual is allowed — a receipt can be wrong
 * — but it clears any prior reconciliation, because a figure somebody checked
 * and a figure somebody then changed are not the same claim.
 *
 * No idempotency key, unlike its neighbours: this sets a named field on one
 * identified row to a value the caller supplies, so replaying it converges on
 * the same state instead of accumulating. The keys belong on the inserts, where
 * a retry adds a charge or a payment that nobody made.
 *
 * The amount is a bare integer, so the caller MUST say which currency it
 * counted it in (SCRUM-319). It is compared with the row's stored `currency` —
 * never with the org's current one, and never used to relabel the row: a form
 * still open from before a settings change sends its integer at the scale it
 * was rendered in, and that integer is refused rather than patched onto a
 * row denominated in something else.
 */
export const recordActualFeeAmount = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    actualAmountMinor: v.number(),
    /** REQUIRED. The currency the caller counted `actualAmountMinor` in. */
    expectedCurrency: v.string(),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    custodyId: v.optional(v.id("financeDealCustody")),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
    const user = auth.user;
    const fee = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealFees",
      args.feeId,
      FEE_NOT_FOUND
    );
    if (fee.voidedAt !== undefined) {
      throw new ConvexError("This cost has been voided. Add a new line instead.");
    }
    assertExpectedCurrency(args.expectedCurrency, "recording this actual amount");
    // A stored denomination nobody can vouch for (a raw-edited "JD") is not one
    // the integer can be checked against; refuse rather than patch blind.
    assertSupportedDenomination(fee.currency, "recording this actual amount");
    if (args.expectedCurrency !== fee.currency) {
      throw new ConvexError(
        `This amount was entered in ${args.expectedCurrency}, but this cost line is recorded in ${fee.currency}. Reload the deal and enter the amount in ${fee.currency}.`
      );
    }
    assertMinorAmount(args.actualAmountMinor, "Actual amount");
    assertTimestamp(args.paidAt, "The paid date");
    assertNotFuture(args.paidAt, Date.now(), "The paid date");
    // The parent must exist in this org (R6, F3): a line whose deal is gone or
    // another tenant's has no freeze to judge and is refused, never let through.
    const parent = await requireOwnedRow(ctx, args.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
    assertDealEconomicsOpen(parent, "changing a recorded cost");
    // The record the line already sits on, proven this org's on this deal
    // (R7, F3), and its holder never re-records the line (final round E) —
    // before the reconciliation override below is written.
    const existing = fee.custodyId
      ? await requireLinkedCustody(ctx, fee, fee.custodyId, "changing a cost charged to a custody record")
      : null;
    if (existing !== null) assertNotCustodian(existing, user._id, "Changing a cost charged to a custody record");
    // The more destructive of the two siblings: voiding preserves the amount
    // and records a reason, while this replaces the figure, the checker's
    // identity and their notes outright. Escalating only `voidDealFee` left the
    // easier route wide open.
    if (fee.reconciledAt !== undefined) {
      assertMayUndoReconciliation(auth, "Changing an amount that has been reconciled");
      await ctx.db.insert("financeApplicationOverrides", {
        orgId: args.orgId,
        applicationId: fee.applicationId,
        field: "financeDealFees.actualAmountMinor",
        previousValue: `${fee.actualAmountMinor} (reconciled: ${fee.reconciliationNotes ?? "no note"})`,
        newValue: String(args.actualAmountMinor),
        reason: "A reconciled cost was re-recorded, withdrawing the reconciliation.",
        changedBy: user._id,
        changedAt: Date.now(),
      });
    }

    // A line on custody re-posts its journal at the new figure; charging one
    // now posts it. Either way this is custody authority (AF-CUST-04).
    if (args.custodyId || fee.custodyId) {
      assertMayPostCustody(auth, "Changing a cost charged to an employee's custody");
    }
    const custodyId = args.custodyId
      ? await resolveFeeCustody(ctx, args.orgId, fee.applicationId, args.custodyId, fee, user._id)
      : fee.custodyId;
    // Editing the amount on a line that a CLOSED custody record was balanced
    // against would leave that record permanently wrong with no way to correct
    // it — `recordCustodyMovement` refuses once it is closed. A legacy record
    // (no ledger behind it) refuses too: a new figure would post one leg.
    if (existing !== null) {
      assertCustodyOpen(existing);
      assertCustodyOnLedger(existing, "changing a cost charged to it");
      // A re-record re-posts the charge at the new figure against the
      // record's balance: a legacy link in another currency is refused
      // before the row or the ledger moves (R5, F4).
      assertFeeCustodyCurrency(fee, existing, "re-recording a cost charged to this custody record");
    }

    const nextStorageIds = args.documentStorageIds ?? fee.documentStorageIds;
    await deleteDroppedAttachments(ctx, fee.documentStorageIds, args.documentStorageIds);

    await invalidateClassification(
      ctx, parent, user._id,
      "A recorded cost was changed after the deal's accounting was classified."
    );

    await ctx.db.patch(args.feeId, {
      actualAmountMinor: args.actualAmountMinor,
      paidAt: args.paidAt ?? fee.paidAt,
      receiptReference: args.receiptReference?.trim() || fee.receiptReference,
      documentStorageIds: nextStorageIds,
      custodyId,
      // Changing the amount invalidates the check that was made against the old
      // one. Leaving the reconciliation in place would let an edit slip past
      // the only gate that stands between an estimate and a closed deal.
      reconciledAt: undefined,
      reconciledBy: undefined,
      reconciliationNotes: undefined,
      updatedAt: Date.now(),
    });
    // The ledger follows the row: a changed amount or custody reverses what
    // was posted and posts the line again at its new figure.
    if (custodyId || fee.custodyPosted) {
      await syncCustodyFeePosting(ctx, args.feeId, user._id, "Handover cost actual re-recorded.");
    }
    return args.feeId;
  },
});

/**
 * Confirms an actual against its evidence.
 *
 * Separate from recording the amount because they are separate acts, usually by
 * separate people. This is the one that lets a deal close, so it demands a note
 * saying what was checked — a reconciliation with no record of what was looked
 * at is indistinguishable from a click.
 */
export const reconcileDealFee = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const fee = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealFees",
      args.feeId,
      FEE_NOT_FOUND
    );
    if (fee.voidedAt !== undefined) {
      throw new ConvexError("This cost has been voided and cannot be reconciled.");
    }
    if (fee.actualAmountMinor === undefined) {
      throw new ConvexError(
        "Record what this cost actually came to before reconciling it. An estimate is not evidence."
      );
    }
    // A line charged to custody is the evidence its holder is reimbursed
    // on; the holder does not certify it (final round E) — and the link is
    // proven this org's on this deal before it is trusted (R7, F3).
    if (fee.custodyId) {
      await assertActorNotCustodianOf(ctx, fee, fee.custodyId, user._id, "Reconciling a cost charged to a custody record");
    }
    // Re-reconciling silently replaced the first checker's identity and notes.
    // Same privilege on both sides, so this is attribution loss rather than
    // escalation — but the notes are the evidence that anybody looked.
    if (fee.reconciledAt !== undefined) {
      throw new ConvexError(
        "This cost has already been reconciled. Re-record its amount if the figure is wrong; that withdraws the reconciliation."
      );
    }
    const notes = args.notes.trim();
    if (!notes) {
      throw new ConvexError("Record what was checked before reconciling this cost.");
    }

    await ctx.db.patch(args.feeId, {
      reconciledAt: Date.now(),
      reconciledBy: user._id,
      reconciliationNotes: notes,
      updatedAt: Date.now(),
    });
    return args.feeId;
  },
});

/** Voids a cost line, keeping it visible. Deleting it would erase that it existed. */
export const voidDealFee = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    // Voiding a RECONCILED line destroys work done under a higher permission —
    // it removes the amount from every total, which can unbalance a closed
    // custody record and turn a deal that failed the classification gate into
    // one that passes it. CREATE is held by SALES; confirming is not.
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
    const user = auth.user;
    const fee = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealFees",
      args.feeId,
      FEE_NOT_FOUND
    );
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError("Say why this cost is being removed.");
    }
    if (fee.voidedAt !== undefined) return args.feeId;
    // The parent must exist in this org (R6, F3); see recordActualFeeAmount.
    const parent = await requireOwnedRow(ctx, args.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
    assertDealEconomicsOpen(parent, "removing a cost");
    if (fee.reconciledAt !== undefined) {
      assertMayUndoReconciliation(auth, "Removing a cost that has been reconciled");
    }
    // Voiding a custody-charged line reverses its journal (AF-CUST-04).
    if (fee.custodyId) assertMayPostCustody(auth, "Removing a cost charged to an employee's custody");
    // The record the line sits on, proven this org's on this deal (R7, F3)
    // — a link nobody can load is refused, never skipped past.
    if (fee.custodyId) {
      const custody = await requireLinkedCustody(ctx, fee, fee.custodyId, "removing a cost charged to a custody record");
      assertNotCustodian(custody, user._id, "Removing a cost charged to a custody record");
      assertCustodyOpen(custody);
    }

    await invalidateClassification(
      ctx, parent, user._id,
      "A cost was removed from the deal after its accounting was classified."
    );

    await ctx.db.patch(args.feeId, {
      voidedAt: Date.now(),
      voidedBy: user._id,
      voidReason: reason,
      updatedAt: Date.now(),
    });
    // A voided line is no longer a custody-paid cost: its posting is reversed
    // (or its queued post cancelled) and the employee's clearing balance rises
    // back by the amount — the same arithmetic the summary performs.
    if (fee.custodyPosted) {
      await syncCustodyFeePosting(ctx, args.feeId, user._id, `Handover cost removed: ${reason}`);
    }
    return args.feeId;
  },
});

/**
 * Charges an existing cost line to an employee's custody, or releases it.
 *
 * The attach action the deal screen offers beside a custody record: a
 * handover cost recorded as paid by the employee, with its actual on file,
 * moves onto (or off) the record and posts through `syncCustodyFeePosting`.
 * Same preconditions as recording a line against custody in the first place
 * (`resolveFeeCustody`); releasing needs the record open, since the line was
 * part of what it balanced against.
 *
 * Converges on a state rather than accumulating, so it takes no idempotency
 * key: a replay after a lost response finds `custodyPosted` already matching
 * and posts nothing.
 */
export const setFeeCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    /** The custody record to charge; omitted releases the line from its current one. */
    custodyId: v.optional(v.id("financeDealCustody")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const fee = await requireOwnedRow(ctx, args.orgId, "financeDealFees", args.feeId, FEE_NOT_FOUND);
    if (fee.voidedAt !== undefined) {
      throw new ConvexError("This cost has been voided and cannot be charged to custody.");
    }
    if (fee.custodyId === args.custodyId) return args.feeId;
    // The parent must exist in this org (R6, F3); see recordActualFeeAmount.
    const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
    assertDealEconomicsOpen(app, "moving a cost onto or off custody");
    // The record the line leaves, proven this org's on this deal (R7, F3).
    if (fee.custodyId) {
      const current = await requireLinkedCustody(ctx, fee, fee.custodyId, "releasing a cost from a custody record");
      assertNotCustodian(current, user._id, "Releasing a cost from a custody record");
      assertCustodyOpen(current);
    }
    const custodyId = args.custodyId
      ? await resolveFeeCustody(ctx, args.orgId, fee.applicationId, args.custodyId, fee, user._id)
      : undefined;
    await invalidateClassification(
      ctx, app, user._id,
      "A cost was moved onto or off an employee's custody after the deal's accounting was classified."
    );
    const now = Date.now();
    await ctx.db.patch(args.feeId, { custodyId, updatedAt: now });
    await syncCustodyFeePosting(
      ctx, args.feeId, user._id,
      custodyId ? "Handover cost charged to employee custody." : "Handover cost released from employee custody."
    );
    return args.feeId;
  },
});

// ---------------------------------------------------------------------------
// Employee custody
// ---------------------------------------------------------------------------

/** Posts one freshly inserted cash entry (ISSUED / RETURNED / REIMBURSED) against its custody record. */
async function postCustodyEntry(
  ctx: MutationCtx,
  custodyId: Id<"financeDealCustody">,
  entryId: Id<"financeDealCustodyEntries">,
  actorId: Id<"users">
): Promise<void> {
  const [custody, entry] = await Promise.all([ctx.db.get(custodyId), ctx.db.get(entryId)]);
  if (custody === null || entry === null || entry.kind === "REVERSAL") {
    throw new ConvexError(CUSTODY_NOT_FOUND);
  }
  await hookCustodyCashMoved(ctx, { orgId: custody.orgId, entry, custody, kind: entry.kind, actorId });
  // The split follows the leg, so it is held behind the leg's own posting.
  await syncCustodyPayable(ctx, custodyId, actorId, entry.occurredAt, [
    { must: "SETTLED", idempotencyKey: custodyEntryPostKey(entry._id) },
  ]);
}

/**
 * Opens a custody record for an employee sent out to pay a deal's costs.
 *
 * One open record per employee per deal: a second would let the same receipt be
 * reconciled twice and make "what is this person holding" ambiguous.
 */
export const openDealCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    userId: v.id("users"),
    issuedMinor: v.number(),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD")
      )
    ),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    assertMinorAmount(args.issuedMinor, "Issued amount");
    if (args.issuedMinor <= 0) {
      throw new ConvexError("The amount handed over must be greater than zero.");
    }

    // The sole record of cash handed to a person. Letting the same someone
    // issue it to themselves, reimburse themselves and close the record is an
    // uncontrolled loop around the one control this table provides — the same
    // separation the approval path already enforces.
    if (args.userId === user._id) {
      throw new ConvexError(
        "Custody has to be issued by somebody other than the person receiving it."
      );
    }

    assertTimestamp(args.occurredAt, "The movement date");
    assertNotFuture(args.occurredAt, Date.now(), "The movement date");

    // The one-open-record rule stops a retry creating a second custody, so the
    // key is not what protects the money here — it is what makes the retry
    // return the record instead of an error about a record the caller's own
    // first attempt created.
    //
    // Which is why the rule lives INSIDE the callback. Checked before the
    // wrapper it ran on every replay, found the row the first attempt had just
    // inserted, and threw the exact error the key exists to prevent — the
    // comment here described behaviour the ordering made impossible. A replay
    // never reaches the callback, so it returns the stored id; a genuine second
    // request does reach it, and still fails.
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.openDealCustody",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // EVERY persisted intent field, normalised as it is stored (final
        // round D): the note is on the entry, so a retry carrying a
        // different note under the same key is a different intent.
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          userId: args.userId,
          issuedMinor: args.issuedMinor,
          method: args.method ?? null,
          reference: args.reference?.trim() || null,
          note: args.note?.trim() || null,
          occurredAt: args.occurredAt ?? null,
        }),
      },
      async () => {
        // ⚠️ Every MUTABLE-state check is inside the section (Codex
        // AF-CUST-06): a replay of an issuance that succeeded must return the
        // stored record even if the recipient has since begun offboarding, the
        // deal has since finalized or the chart has since changed — refusing
        // it would tell the operator the cash never left when it did.
        //
        // The recipient must be a member of this organization. Without this a
        // caller could hand custody — and a reimbursement claim — to a user id
        // from another tenant. The shared helper also rejects a membership
        // mid-offboarding: cash handed to somebody on the way out leaves a
        // balance they can never return, reconcile or claim against themselves.
        await requireOrgMember(
          ctx,
          args.orgId,
          args.userId,
          AppErrorCode.ASSIGNED_USER_NOT_MEMBER,
          "That person is not a member of this organization."
        );
        // Fresh cash for a finalized, closed, cancelled or rejected deal is a
        // new economic fact on a deal with no handover to fund, not the
        // settlement of an existing one (R5, F3).
        assertDealAcceptsNewCustodyCash(app, "handing cash to an employee");
        // Cash leaves the drawer here. Refused before anything is written when
        // the ledger cannot take the posting.
        await assertCustodyAccountingReady(ctx, args.orgId, "handing cash to an employee");
        const existing = (await custodyFor(ctx, args.applicationId, "opening custody on this deal")).find(
          (row) => row.userId === args.userId && row.status === "OPEN"
        );
        if (existing) {
          throw new ConvexError(
            "This person already holds an open custody record on this deal. Record the money against that one."
          );
        }

        await invalidateClassification(
          ctx, app, user._id,
          "Custody was opened on the deal after its accounting was classified."
        );

        const currency = await resolveDealCurrency(ctx, app, "opening custody on this deal");
        const now = Date.now();
        const custodyId = await ctx.db.insert("financeDealCustody", {
          orgId: args.orgId,
          applicationId: args.applicationId,
          userId: args.userId,
          currency,
          issuedMinor: 0,
          returnedMinor: 0,
          reimbursedMinor: 0,
          status: "OPEN",
          // Opened by a writer that posts: every movement on this record has
          // a journal behind it. A record without the marker predates that.
          ledgerPosting: "CANONICAL",
          createdBy: user._id,
          createdAt: now,
          updatedAt: now,
        });

        const entryId = await ctx.db.insert("financeDealCustodyEntries", {
          orgId: args.orgId,
          custodyId,
          kind: "ISSUED",
          amountMinor: args.issuedMinor,
          method: args.method,
          reference: args.reference?.trim() || undefined,
          note: args.note?.trim() || undefined,
          occurredAt: args.occurredAt ?? now,
          recordedBy: user._id,
          recordedAt: now,
        });
        await recomputeCustodyTotals(ctx, custodyId);
        await postCustodyEntry(ctx, custodyId, entryId, user._id);
        return custodyId;
      }
    );
  },
});

/**
 * Records a movement on an open custody record.
 *
 * Every total on the record is the sum of these, so a correction is a further
 * entry rather than an overwrite — the movement that was wrong stays visible
 * alongside the one that fixed it.
 */
export const recordCustodyMovement = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    kind: v.union(
      v.literal("ISSUED"),
      v.literal("RETURNED"),
      v.literal("REIMBURSED"),
      v.literal("REVERSAL")
    ),
    /** Required on a REVERSAL, rejected otherwise. */
    reversesEntryId: v.optional(v.id("financeDealCustodyEntries")),
    amountMinor: v.number(),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD")
      )
    ),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealCustody",
      args.custodyId,
      CUSTODY_NOT_FOUND
    );
    assertMinorAmount(args.amountMinor, "Amount");
    if (args.amountMinor <= 0) {
      throw new ConvexError("The amount must be greater than zero.");
    }
    assertTimestamp(args.occurredAt, "The movement date");
    assertNotFuture(args.occurredAt, Date.now(), "The movement date");
    // Shape-only: a non-reversal naming a target is malformed whatever the
    // state. Every check that reads MUTABLE state lives inside the idempotent
    // section below.
    if (args.kind !== "REVERSAL" && args.reversesEntryId) {
      throw new ConvexError("Only a reversal may name the movement it cancels.");
    }

    // The one that matters most: a retried REIMBURSED records the dealership
    // paying the same person twice. The module surfaces that afterwards as
    // `reimbursementOverpaidMinor` rather than clamping it away, which is right
    // — but detecting a double payment is a worse outcome than not making one.
    //
    // ⚠️ EVERY STATE-DEPENDENT ADMISSIBILITY CHECK IS INSIDE THE CALLBACK. A
    // replay of a movement that already SUCCEEDED must return the stored
    // result, not a refusal describing the state that success created: a
    // RETURNED whose own first attempt filled the advance ("would return more
    // than issued"), a REVERSAL whose target its own first attempt reversed
    // ("already reversed"), a movement whose record was reconciled between the
    // lost response and the retry ("already closed"), an org whose chart was
    // torn down since. Checked before the wrapper, each one threw on the retry
    // and told the operator the money had NOT moved when it had.
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.recordCustodyMovement",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // Every persisted intent field (final round D): the note is stored
        // on the entry and, for a reversal, is the reason its journal
        // carries — a note-only change is a different command.
        fingerprint: JSON.stringify({
          custodyId: args.custodyId,
          kind: args.kind,
          reversesEntryId: args.reversesEntryId ?? null,
          amountMinor: args.amountMinor,
          method: args.method ?? null,
          reference: args.reference?.trim() || null,
          note: args.note?.trim() || null,
          occurredAt: args.occurredAt ?? null,
        }),
      },
      async () => {
        // Re-read inside the section: the row loaded for ownership above is
        // the same row, but the state it carries is what this attempt acts on.
        const current = await ctx.db.get(args.custodyId);
        if (current === null) throw new ConvexError(CUSTODY_NOT_FOUND);
        if (current.status !== "OPEN") {
          throw new ConvexError(
            "This custody record is already closed. Reopen it before recording more movement."
          );
        }
        assertCustodyOnLedger(current, "recording a movement on it");
        assertNotCustodian(current, user._id, "Recording a custody movement");
        // Every kind moves cash or cancels a cash posting; none is recorded
        // operationally without the ledger — see `assertCustodyAccountingReady`.
        await assertCustodyAccountingReady(ctx, args.orgId, "recording this custody movement");
        // A reimbursement pays a DEBT the record itself states (Codex
        // AF-CUST-02): nothing owed means nothing to pay, and more than is
        // owed is a double payment the module used to merely surface
        // afterwards. Now that it moves real cash it is refused before any
        // write — judged on the live lines inside the transaction, never on a
        // figure the screen carried in.
        if (args.kind === "REIMBURSED") {
          const owed = summarizeReadableCustody(
            current,
            await loadActiveFees(ctx, current.applicationId),
            "reimbursing this employee"
          ).reimbursementOutstandingMinor;
          if (owed <= 0) {
            throw new ConvexError("Nothing is owed to this employee on this custody record; there is no reimbursement to pay.");
          }
          if (args.amountMinor > owed) {
            throw new ConvexError(
              `That would reimburse ${args.amountMinor} minor units against ${owed} owed. Pay what is owed, or correct the costs first.`
            );
          }
        }
        // More cash against an EXISTING record is still fresh cash on a
        // recognized deal — the same door `openDealCustody` closes. Settling
        // what the employee already holds (return, reimburse, reverse) stays
        // open; only ISSUED is new. Inside the section, like every other
        // state check here, so a replay of an issuance that succeeded before
        // the deal froze still returns its stored result. The parent is
        // loaded through the owned-row check, never optionally: an anchor
        // that is missing or in another organization has no lifecycle to
        // judge, and "nothing to judge" is a refusal, not a pass.
        if (args.kind === "ISSUED") {
          const parentApp = await requireOwnedRow(
            ctx,
            args.orgId,
            "financeApplications",
            current.applicationId,
            APPLICATION_NOT_FOUND
          );
          assertDealAcceptsNewCustodyCash(parentApp, "handing more cash to an employee");
        }
        if (args.kind === "REVERSAL") {
          await assertReversalAllowed(ctx, args.orgId, args.custodyId, args.reversesEntryId, args.amountMinor);
        }
        // A return larger than what was handed over is a typo, not a fact —
        // and left alone it drives the balance negative, so the module then
        // instructs somebody to pay a reimbursement that is not owed.
        if (args.kind === "RETURNED") {
          const projected = current.returnedMinor + args.amountMinor;
          if (projected > current.issuedMinor) {
            throw new ConvexError(
              `That would return ${projected} minor units against ${current.issuedMinor} issued. Correct the issuance first, or reverse the movement that is wrong.`
            );
          }
        }

        const now = Date.now();
        const entryId = await ctx.db.insert("financeDealCustodyEntries", {
          orgId: args.orgId,
          custodyId: args.custodyId,
          kind: args.kind,
          ...(args.reversesEntryId ? { reversesEntryId: args.reversesEntryId } : {}),
          amountMinor: args.amountMinor,
          method: args.method,
          reference: args.reference?.trim() || undefined,
          note: args.note?.trim() || undefined,
          occurredAt: args.occurredAt ?? now,
          recordedBy: user._id,
          recordedAt: now,
        });
        await recomputeCustodyTotals(ctx, args.custodyId);
        if (args.kind === "REVERSAL") {
          // The reversal's whole accounting effect is the canonical inverse
          // of its target's journal — dated NOW, into an open period, so a
          // correction after a close never rewrites the closed month.
          const target = await ctx.db.get(args.reversesEntryId!);
          if (target === null || target.kind === "REVERSAL") {
            throw new ConvexError("That movement was not found in this organization.");
          }
          await hookCustodyCashReversed(ctx, {
            orgId: args.orgId,
            entryId: target._id,
            kind: target.kind,
            reversalEntryId: entryId,
            reason: args.note?.trim() || "Custody movement reversed.",
            actorId: user._id,
            reversalDate: now,
          });
          // The split follows the position the reversal left, dated with it
          // — and held behind the reversal itself: a DEFERRED one leaves the
          // leg on the books, and the delta must not move the payable while
          // the clearing account still carries the cash.
          await syncCustodyPayable(ctx, args.custodyId, user._id, now, [
            { must: "OFF_BOOKS", idempotencyKey: custodyEntryPostKey(target._id) },
          ]);
        } else {
          await postCustodyEntry(ctx, args.custodyId, entryId, user._id);
        }
        return args.custodyId;
      }
    );
  },
});

/**
 * Closes a custody record once nothing is outstanding in either direction.
 *
 * Refuses while the employee still holds money OR the dealership still owes
 * them. The second half is the one worth stating: a record where the dealership
 * owes 50 is not "reconciled with a small variance", it is an unpaid debt to a
 * person, and closing it would quietly write that debt off.
 */
export const reconcileDealCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    notes: v.string(),
    /** Closes a genuinely unaccountable difference, recorded as a write-off. */
    writeOffReason: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const owned = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealCustody",
      args.custodyId,
      CUSTODY_NOT_FOUND
    );
    // Authority, outside the wrapper: the holder never closes their own
    // record, and a replay by the holder is refused the same way.
    assertNotCustodian(owned, user._id, "Closing a custody record");
    const notes = args.notes.trim();
    if (!notes) {
      throw new ConvexError("Record what was checked before closing this custody record.");
    }
    const writeOffReason = args.writeOffReason?.trim() || undefined;

    // A closure that writes off posts a journal, and a closure at all is
    // what lets the deal classify — so a lost response must replay the
    // stored outcome rather than refuse on the state it created (final
    // round F). Every mutable-state check is INSIDE the section; the
    // fingerprint is every persisted intent field, normalised as stored.
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.reconcileDealCustody",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          custodyId: args.custodyId,
          notes,
          writeOffReason: writeOffReason ?? null,
        }),
      },
      async () => {
        const custody = await ctx.db.get(args.custodyId);
        if (custody === null) throw new ConvexError(CUSTODY_NOT_FOUND);
        if (custody.status !== "OPEN") {
          throw new ConvexError("This custody record is already closed.");
        }

        const fees = await loadActiveFees(ctx, custody.applicationId);
        const summary = summarizeReadableCustody(custody, fees, "closing this custody record");

        // A write-off is the dealership absorbing a loss. It is NOT a way to stop
        // owing somebody: money the dealership owes an employee, closed unpaid, is
        // just a decision not to pay a person — and the classification gate would
        // then wave the deal through as settled. That direction has to be paid or
        // explicitly reversed.
        if (summary.reimbursementOutstandingMinor > 0) {
          throw new ConvexError(
            `${summary.reimbursementOutstandingMinor} minor units are still owed to this person. Record the reimbursement before closing — a debt owed to an employee cannot be written off here.`
          );
        }
        if (summary.reimbursementOverpaidMinor > 0) {
          throw new ConvexError(
            `This person has been reimbursed ${summary.reimbursementOverpaidMinor} minor units more than they were owed. Reverse the duplicate movement before closing.`
          );
        }
        if (!summary.settled && !writeOffReason) {
          throw new ConvexError(
            `This custody record does not balance. ${summary.employeeOwesDealerMinor} minor units are still unaccounted for — record the receipts or the returned balance. To close it anyway, record a write-off reason.`
          );
        }

        const now = Date.now();
        const writingOff = Boolean(writeOffReason) && !summary.settled;
        if (writingOff) {
          // The only residual a write-off may absorb is cash the employee holds
          // and cannot account for. An over-return is a log that cannot be true,
          // not a shortage, and is corrected rather than expensed.
          if (summary.overReturnedMinor > 0 || summary.employeeOwesDealerMinor <= 0) {
            throw new ConvexError(
              "This record's movements contradict each other (more returned than issued). Reverse the movement that is wrong; there is no shortage to write off."
            );
          }
          assertCustodyOnLedger(custody, "writing off its shortage");
          await assertCustodyAccountingReady(ctx, args.orgId, "writing off a custody shortage");
          const version = nextStoredVersion(custody.writeOffPostingVersion, "This custody record", "writing off a custody shortage");
          await hookCustodyWrittenOff(ctx, {
            orgId: args.orgId,
            custody,
            version,
            amountMinor: summary.employeeOwesDealerMinor,
            reason: writeOffReason!,
            actorId: user._id,
            occurredAt: now,
            // The residual is what these leave; the write-off follows them.
            dependencies: await custodyPositionDependencies(ctx, custody, "writing off a custody shortage"),
          });
          await ctx.db.patch(args.custodyId, {
            writeOffPosted: { version, amountMinor: summary.employeeOwesDealerMinor },
            writeOffPostingVersion: version,
          });
        }
        await ctx.db.patch(args.custodyId, {
          status: writingOff ? "WRITTEN_OFF" : "RECONCILED",
          reconciledAt: now,
          reconciledBy: user._id,
          reconciliationNotes: notes,
          writeOffReason: writingOff ? writeOffReason : undefined,
          updatedAt: now,
        });
        return args.custodyId;
      }
    );
  },
});

/**
 * Posts a custody record from before ledger posting — every cash leg, every
 * reversal, every custody-paid line at its recorded actual and, for a
 * written-off record, the shortage — from the facts already on the record,
 * and only then marks it CANONICAL (final round B).
 *
 * The explicit door `assertCustodyOnLedger` and the family gate point at.
 * Nothing here is inferred: each posting is dated when the record says the
 * money moved (the entry's own date; the line's paid date, or the day it was
 * recorded where no paid date is known; the closure date for a write-off),
 * carries the amount the row carries, and goes through the same hooks the
 * product uses, so a date in a closed month queues exactly as it would have.
 * Where the record contradicts itself — a stored total its own log does not
 * project to, a line that already carries a posting, a write-off with no
 * shortage behind it, a line in another currency or of a treatment custody
 * cannot expense — it is REFUSED with the reason and nothing is posted; the
 * record stays legacy for a person to repair. The one-idempotency-key
 * command replays its stored result; a fresh key against a record already
 * on the ledger is refused, so the family is posted exactly once.
 *
 * Operator authority: confirming disbursements AND managing finance, and
 * never the holder — the same separation every other custody command keeps.
 */
export const migrateLegacyCustodyToLedger = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
      PERMISSIONS.MANAGE_FINANCE,
    ]);
    const owned = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealCustody",
      args.custodyId,
      CUSTODY_NOT_FOUND
    );
    assertNotCustodian(owned, user._id, "Migrating a custody record to the ledger");

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.migrateLegacyCustodyToLedger",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ custodyId: args.custodyId }),
      },
      async () => {
        const custody = await ctx.db.get(args.custodyId);
        if (custody === null) throw new ConvexError(CUSTODY_NOT_FOUND);
        if (custody.ledgerPosting === "CANONICAL") {
          throw new ConvexError("This custody record is already on the ledger; there is nothing to migrate.");
        }
        await assertCustodyAccountingReady(ctx, args.orgId, "migrating this custody record to the ledger");
        // The deal the family is posted against must exist in this org (R6,
        // F3) — proven before the first leg posts, so an orphaned or
        // re-pointed record is refused whole and nothing reaches the books.
        const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", custody.applicationId, APPLICATION_NOT_FOUND);

        // The log, proven in full, must project to exactly the totals the
        // row claims — a disagreement is a record somebody has to look at.
        const entries = await custodyEntriesFor(ctx, args.custodyId, "migrating this custody record");
        const projected = custodyTotalsFromLog(entries, custody);
        if (
          projected.issuedMinor !== custody.issuedMinor ||
          projected.returnedMinor !== custody.returnedMinor ||
          projected.reimbursedMinor !== custody.reimbursedMinor
        ) {
          throw new ConvexError(
            `This custody record's stored totals (issued ${custody.issuedMinor}, returned ${custody.returnedMinor}, reimbursed ${custody.reimbursedMinor}) do not match its own movement log (${projected.issuedMinor}, ${projected.returnedMinor}, ${projected.reimbursedMinor}), so it cannot be migrated as it stands. Correct the record first; nothing has been posted.`
          );
        }
        const fees = await loadActiveFees(ctx, custody.applicationId);
        const linked = fees.filter((fee) => fee.custodyId === custody._id);
        for (const fee of linked) {
          if (fee.custodyPosted !== undefined) {
            throw new ConvexError(
              "A cost charged to this custody record already carries a custody posting, which a record from before ledger posting cannot have. Have the record reviewed; nothing has been posted."
            );
          }
          if (fee.currency !== custody.currency) {
            throw new ConvexError(
              `A cost charged to this custody record is in ${fee.currency} while the record is in ${custody.currency}; it cannot be posted against the record. Correct the line first; nothing has been posted.`
            );
          }
          if (fee.paidBy !== "EMPLOYEE" || fee.deductedFromSettlement) {
            throw new ConvexError(
              "A cost charged to this custody record is not recorded as paid by the employee out of custody (or is deducted from the settlement), so it cannot be posted against the record. Correct the line first; nothing has been posted."
            );
          }
          const expense = custodyFeeExpenseKey(fee.accountingTreatment);
          if (expense.systemKey === null) throw new ConvexError(expense.refusal);
        }
        // Every balance below is read through the same readable-summary
        // contract the writers use; an unreadable amount refuses here.
        const summary = summarizeReadableCustody(custody, fees, "migrating this custody record");
        if (custody.status === "WRITTEN_OFF") {
          if (custody.writeOffPosted !== undefined) {
            throw new ConvexError(
              "This custody record already carries a write-off posting, which a record from before ledger posting cannot have. Have the record reviewed; nothing has been posted."
            );
          }
          if (summary.overReturnedMinor > 0 || summary.employeeOwesDealerMinor <= 0) {
            throw new ConvexError(
              "This custody record is marked written off, but its movements and costs leave no shortage to write off. Have the record reviewed; nothing has been posted."
            );
          }
        }

        // Cash legs first, each dated when the record says the cash moved;
        // then the reversals, each cancelling its target's journal (or its
        // still-queued post) the way the product's own reversal does.
        const byId = new Map(entries.map((entry) => [entry._id, entry]));
        // Every posting the family's payable position is a consequence of;
        // the delta at the end is chained behind all of them, so a leg or a
        // line dated into a closed month holds the payable with it.
        const payableDependencies: CustodyLedgerDependency[] = [];
        const reversedEntryIds = new Set(
          entries.filter((entry) => entry.kind === "REVERSAL").map((entry) => entry.reversesEntryId)
        );
        let cashLegs = 0;
        let reversals = 0;
        for (const entry of entries) {
          if (entry.kind === "REVERSAL") continue;
          await hookCustodyCashMoved(ctx, { orgId: args.orgId, entry, custody, kind: entry.kind, actorId: user._id });
          payableDependencies.push({
            must: reversedEntryIds.has(entry._id) ? "OFF_BOOKS" : "SETTLED",
            idempotencyKey: custodyEntryPostKey(entry._id),
          });
          cashLegs += 1;
        }
        for (const entry of entries) {
          if (entry.kind !== "REVERSAL") continue;
          // Proven by `custodyTotalsFromLog` above: present, on this record, not itself a reversal.
          const target = byId.get(entry.reversesEntryId!)!;
          if (target.kind === "REVERSAL") throw new ConvexError("A reversal on this custody record names another reversal.");
          await hookCustodyCashReversed(ctx, {
            orgId: args.orgId,
            entryId: target._id,
            kind: target.kind,
            reversalEntryId: entry._id,
            reason: entry.note?.trim() || "Custody movement reversed (posted by the custody accounting migration).",
            actorId: user._id,
            reversalDate: entry.occurredAt,
          });
          reversals += 1;
        }

        // The custody-paid lines, at their recorded actuals.
        let feesPosted = 0;
        let latestFact = entries.reduce((latest, entry) => Math.max(latest, entry.occurredAt), 0);
        for (const fee of linked) {
          if (fee.actualAmountMinor === undefined || fee.actualAmountMinor <= 0) continue;
          const version = nextStoredVersion(fee.custodyPostingVersion, "A cost charged to this custody record", "migrating this custody record");
          const occurredAt = fee.paidAt !== undefined && isTimestamp(fee.paidAt) ? fee.paidAt : fee.createdAt;
          latestFact = Math.max(latestFact, occurredAt);
          await hookCustodyFeePaid(ctx, {
            orgId: args.orgId,
            fee,
            custodyId: custody._id,
            vehicleId: app.vehicleId,
            version,
            amountMinor: fee.actualAmountMinor,
            actorId: user._id,
            occurredAt,
          });
          await ctx.db.patch(fee._id, {
            custodyPosted: { version, amountMinor: fee.actualAmountMinor, custodyId: custody._id },
            custodyPostingVersion: version,
            updatedAt: Date.now(),
          });
          payableDependencies.push({ must: "SETTLED", idempotencyKey: custodyFeePostKey(fee._id, version) });
          feesPosted += 1;
        }

        // The shortage a written-off record absorbed, dated at its closure.
        let writeOffPosted = false;
        if (custody.status === "WRITTEN_OFF") {
          const version = nextStoredVersion(custody.writeOffPostingVersion, "This custody record", "migrating this custody record");
          const occurredAt = custody.reconciledAt ?? custody.updatedAt;
          latestFact = Math.max(latestFact, occurredAt);
          await hookCustodyWrittenOff(ctx, {
            orgId: args.orgId,
            custody,
            version,
            amountMinor: summary.employeeOwesDealerMinor,
            reason: custody.writeOffReason?.trim() || "Custody shortage written off (posted by the custody accounting migration).",
            actorId: user._id,
            occurredAt,
            // Every leg and line posted above: the shortage is what they leave.
            dependencies: [...payableDependencies],
          });
          await ctx.db.patch(args.custodyId, {
            writeOffPosted: { version, amountMinor: summary.employeeOwesDealerMinor },
            writeOffPostingVersion: version,
          });
          writeOffPosted = true;
        }

        // The marker LAST, once every fact is on the books or queued — and
        // then the payable position the family leaves, dated at the latest
        // fact it is made of. `syncCustodyPayable` posts only for a CANONICAL
        // record, which is exactly what this record has just become.
        await ctx.db.patch(args.custodyId, { ledgerPosting: "CANONICAL", updatedAt: Date.now() });
        await syncCustodyPayable(ctx, args.custodyId, user._id, latestFact > 0 ? latestFact : Date.now(), payableDependencies);
        return { custodyId: args.custodyId, cashLegs, reversals, feesPosted, writeOffPosted };
      }
    );
  },
});

/**
 * Reopens a closed custody record so it can be corrected.
 *
 * The mutation the closed path always needed. Without it, a late receipt
 * recorded against a reconciled record left it stored as balanced while the
 * arithmetic said the employee was out of pocket — and every route to fixing it
 * refused, with an error naming this function before it existed.
 */
export const reopenDealCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const custody = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealCustody",
      args.custodyId,
      CUSTODY_NOT_FOUND
    );
    if (custody.status === "OPEN") return args.custodyId;
    // Reopening puts the record back where its holder can be reimbursed
    // from it; the holder does not reopen their own (final round E).
    assertNotCustodian(custody, user._id, "Reopening a custody record");
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError("Say why this custody record is being reopened.");
    }
    // The write-off version the row claims is proven a version before the
    // reversal is pinned to it (R7, F4): a NaN pin reverses nothing and
    // reports the loss withdrawn while Cash Over/Short still carries it.
    if (custody.writeOffPosted) {
      assertStoredVersion(custody.writeOffPosted.version, "This custody record's write-off posting", "reopening this custody record");
    }
    // The parent the stored row names is proven this org's BEFORE anything is
    // written (R8, F2): an owned custody row whose `applicationId` was
    // re-pointed at another tenant's deal would otherwise leave an audit row
    // against that deal, reverse a posted write-off and withdraw the OTHER
    // organization's classification. A missing or foreign parent refuses here,
    // with the override, the reversal and the status patch all still unwritten.
    const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", custody.applicationId, APPLICATION_NOT_FOUND);

    // Reopening undoes a reconciliation somebody signed off, so it leaves a row
    // — and it withdraws the deal's classification, which may have been granted
    // on the strength of this record being settled.
    await ctx.db.insert("financeApplicationOverrides", {
      orgId: args.orgId,
      applicationId: custody.applicationId,
      field: "financeDealCustody.status",
      // The whole of what the patch below erases, not just the status. A
      // write-off reason is the business justification for a loss the
      // dealership absorbed; losing it makes that loss unexplainable.
      previousValue: `${custody.status} (write-off: ${custody.writeOffReason ?? "none"}; notes: ${custody.reconciliationNotes ?? "none"})`,
      newValue: "OPEN",
      reason,
      changedBy: user._id,
      changedAt: Date.now(),
    });
    await invalidateClassification(
      ctx, app, user._id,
      "A custody record was reopened after the deal's accounting was classified."
    );

    // A written-off shortage goes back onto the employee's clearing balance:
    // the loss was booked on the strength of a closure that is now withdrawn.
    if (custody.writeOffPosted) {
      await hookCustodyWriteOffReversed(ctx, {
        orgId: args.orgId,
        custodyId: custody._id,
        version: custody.writeOffPosted.version,
        reason: `Custody record reopened: ${reason}`,
        actorId: user._id,
        reversalDate: Date.now(),
      });
    }

    await ctx.db.patch(args.custodyId, {
      status: "OPEN",
      reconciledAt: undefined,
      reconciledBy: undefined,
      reconciliationNotes: undefined,
      writeOffReason: undefined,
      writeOffPosted: undefined,
      updatedAt: Date.now(),
    });
    return args.custodyId;
  },
});

/**
 * Who may be handed this deal's cash: the org's active members, by display
 * name only. Its own read, shaped for the money permission (ACC-10): the
 * general member list needs VIEW_USERS and serves addresses, images and
 * roles, none of which the person handing over cash needs — and a
 * disbursement confirmer without VIEW_USERS would otherwise have a picker
 * with nobody in it. Bounded; a dealership past the cap gets a prefix and
 * the flag, never a refusal on the deal screen.
 *
 * The caller is in the list, MARKED (`isActor`), because the two doors this
 * feeds draw different lines: a plan may name anyone, the actor included
 * (`planCustodyHandler` has no self rule — a plan moves no money), while an
 * issuance is refused to the person issuing it (`openDealCustody`). The
 * issuance picker withholds the marked row so it never offers a choice the
 * server refuses; the plan picker serves the whole list.
 */
export const MAX_CUSTODY_CANDIDATES = 200;
export const listCustodyCandidates = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user: actor } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_CUSTODY_CANDIDATES + 1);
    const candidates: Array<{ userId: Id<"users">; name: string; isActor: boolean }> = [];
    for (const membership of memberships.slice(0, MAX_CUSTODY_CANDIDATES)) {
      // The same rule `requireOrgMember` applies to the recipient: a
      // membership mid-offboarding cannot be handed cash.
      if (membership.offboardingStatus) continue;
      const user = await ctx.db.get(membership.userId);
      if (user === null) continue;
      candidates.push({ userId: membership.userId, name: user.name ?? "", isActor: membership.userId === actor._id });
    }
    return { candidates, truncated: memberships.length > MAX_CUSTODY_CANDIDATES };
  },
});

/**
 * Names who will handle this deal's finalization payments, BEFORE any cash
 * moves — or withdraws that plan. A plan and nothing else: no custody record,
 * no entry, no posting; `openDealCustody` is where money changes hands and it
 * may name somebody else. Refused once an open custody record exists on the
 * deal, because at that point the plan is history and the record is the fact.
 */
export const planCustodyHandler = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /** Omitted clears the plan. */
    userId: v.optional(v.id("users")),
    amountMinor: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    if (app.status === "CLOSED" || app.status === "CANCELLED" || app.status === "REJECTED") {
      throw new ConvexError("This deal is closed or stopped; its handover is not being planned.");
    }
    if (args.amountMinor !== undefined) {
      assertMinorAmount(args.amountMinor, "Planned amount");
      if (args.amountMinor <= 0) throw new ConvexError("The planned amount must be greater than zero.");
    }
    if (args.userId !== undefined) {
      await requireOrgMember(
        ctx,
        args.orgId,
        args.userId,
        AppErrorCode.ASSIGNED_USER_NOT_MEMBER,
        "That person is not a member of this organization."
      );
    }
    const openCustody = (await custodyFor(ctx, args.applicationId, "planning this deal's custody")).find(
      (row) => row.status === "OPEN"
    );
    if (openCustody) {
      throw new ConvexError(
        "Cash is already in an employee's custody on this deal. Settle that record before changing who handles the handover."
      );
    }
    const now = Date.now();
    const previous = app.plannedCustody;
    const next =
      args.userId === undefined
        ? undefined
        : {
            userId: args.userId,
            amountMinor: args.amountMinor,
            note: args.note?.trim() || undefined,
            plannedBy: user._id,
            plannedAt: now,
          };
    if (previous === undefined && next === undefined) return args.applicationId;
    await ctx.db.insert("financeApplicationOverrides", {
      orgId: args.orgId,
      applicationId: args.applicationId,
      field: "plannedCustody",
      previousValue: previous ? `${previous.userId} (${previous.amountMinor ?? "no amount"})` : undefined,
      newValue: next ? `${next.userId} (${next.amountMinor ?? "no amount"})` : "none",
      reason: next ? "Handover custody handler planned." : "Handover custody plan withdrawn.",
      changedBy: user._id,
      changedAt: now,
    });
    await ctx.db.patch(args.applicationId, { plannedCustody: next, updatedAt: now });
    return args.applicationId;
  },
});

// ---------------------------------------------------------------------------
// The legal invoice, and accounting classification
// ---------------------------------------------------------------------------

/**
 * Records the deal's legally documented transaction price.
 *
 * This figure comes off the invoice and the purchase agreement. It is asked for
 * explicitly, and never derived from the dealer's target selling amount or the
 * finance company's approved purchase amount, because on a financed deal those
 * are three different numbers describing three different things — and only this
 * one is what the parties signed.
 */
export const recordLegalInvoice = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    legalInvoiceAmountMinor: v.number(),
    legalInvoiceNumber: v.string(),
    legalInvoiceDate: v.number(),
    issuedTo: v.union(
      v.literal("CUSTOMER"),
      v.literal("FINANCE_COMPANY"),
      v.literal("OTHER")
    ),
    issuedToOther: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    assertMinorAmount(args.legalInvoiceAmountMinor, "Legal invoice amount");
    if (args.legalInvoiceAmountMinor <= 0) {
      throw new ConvexError("The invoice amount must be greater than zero.");
    }
    // THE recognition date. `finalizeDeal` dates the sale — and so the period
    // its revenue, receivable and deductions land in — from this field
    // (`financedSaleRecognitionDate`), so it is validated as a real timestamp
    // and refused when it is in the future: revenue is not recognized in a
    // period that has not happened. No tolerance window (final round C): an
    // invoice date is a calendar date, sent as UTC midnight for a past day
    // and as the current instant for today, so a value past the server's
    // clock is a day that has not occurred, not clock skew. Judged against
    // the one instant this command captures.
    const now = Date.now();
    if (!isTimestamp(args.legalInvoiceDate)) {
      throw new ConvexError(`The invoice date must be a real timestamp (got ${args.legalInvoiceDate}).`);
    }
    assertNotFuture(args.legalInvoiceDate, now, "The invoice date");
    // Once the sale is recognized the invoice is what it was recognized from;
    // replacing it would move revenue or its period behind a posted journal.
    assertDealEconomicsOpen(app, "recording or replacing the legal invoice");
    const invoiceNumber = args.legalInvoiceNumber.trim();
    if (!invoiceNumber) {
      throw new ConvexError("Record the invoice number.");
    }
    const issuedToOther = args.issuedToOther?.trim();
    if (args.issuedTo === "OTHER" && !issuedToOther) {
      throw new ConvexError("Say who the invoice was issued to.");
    }

    // Any change to a recorded invoice is audited, whatever moved — and the
    // comparison has to cover every field the patch below writes, or the claim
    // is false for whichever field it forgot. It forgot two: the date, which
    // decides the period revenue lands in, and the free-text recipient, which
    // is the counterparty's whole identity when issuedTo is OTHER. Both could
    // be moved silently while the amount stood still.
    const nextIssuedToOther = args.issuedTo === "OTHER" ? issuedToOther : undefined;
    const describe = (
      amountMinor: number | undefined,
      number: string | undefined,
      date: number | undefined,
      issuedTo: string | undefined,
      other: string | undefined
    ): string =>
      `${amountMinor ?? "unrecorded"} (invoice ${number || "unrecorded"} dated ${date ?? "unrecorded"} to ${issuedTo ?? "unrecorded"}${other ? ` — ${other}` : ""})`;

    if (
      app.legalInvoiceAmountMinor !== undefined &&
      (app.legalInvoiceAmountMinor !== args.legalInvoiceAmountMinor ||
        (app.legalInvoiceNumber ?? "") !== invoiceNumber ||
        app.legalInvoiceDate !== args.legalInvoiceDate ||
        app.legalInvoiceIssuedTo !== args.issuedTo ||
        (app.legalInvoiceIssuedToOther ?? undefined) !== nextIssuedToOther)
    ) {
      await ctx.db.insert("financeApplicationOverrides", {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "legalInvoiceAmountMinor",
        previousValue: describe(
          app.legalInvoiceAmountMinor, app.legalInvoiceNumber,
          app.legalInvoiceDate, app.legalInvoiceIssuedTo, app.legalInvoiceIssuedToOther
        ),
        newValue: describe(
          args.legalInvoiceAmountMinor, invoiceNumber,
          args.legalInvoiceDate, args.issuedTo, nextIssuedToOther
        ),
        reason: "The recorded legal invoice was replaced.",
        changedBy: user._id,
        changedAt: now,
      });
    }

    await invalidateClassification(
      ctx, app, user._id,
      "The legal invoice was re-recorded after the deal's accounting was classified."
    );

    await ctx.db.patch(args.applicationId, {
      legalInvoiceAmountMinor: args.legalInvoiceAmountMinor,
      legalInvoiceNumber: invoiceNumber,
      legalInvoiceDate: args.legalInvoiceDate,
      legalInvoiceIssuedTo: args.issuedTo,
      legalInvoiceIssuedToOther: nextIssuedToOther,
      legalInvoiceRecordedBy: user._id,
      legalInvoiceRecordedAt: now,
      updatedAt: now,
    });
    return args.applicationId;
  },
});

/**
 * Marks a deal's accounting treatment as established.
 *
 * The gate the user asked for: estimates are fine to work from operationally,
 * but closure requires reconciliation. So this refuses while any cost is
 * unquantified, unrecorded or unchecked, while any custody record is open, or
 * while the legal invoice — the only figure revenue may be posted from — is
 * missing.
 *
 * It sets a flag and nothing else. No journal entry follows from it yet; that
 * design is deliberately unwritten until real documents confirm how a financed
 * sale is legally structured.
 */
export const classifyDealAccounting = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    const notes = args.notes.trim();
    if (!notes) {
      throw new ConvexError("Record how this deal's accounting was established.");
    }

    if (app.legalInvoiceAmountMinor === undefined) {
      throw new ConvexError(
        "Record the deal's legal invoice before classifying its accounting. The invoice amount is the only figure revenue may be posted from."
      );
    }

    const fees = await loadActiveFees(ctx, args.applicationId);
    const summary = summarizeFees(fees);
    // A deal with no live cost lines is the state "nobody itemized anything",
    // which `summarizeFees` deliberately reports as NOT fully reconciled —
    // nothing to have reconciled and everything checking out are different
    // claims. Reading only the awaiting-counts let it through, because both are
    // zero for an empty list, so a financed deal with an invoice and no costs
    // at all classified clean.
    if (summary.lineCount === 0) {
      throw new ConvexError(
        "No costs have been itemized on this deal. Record them, or record a zero-cost line saying the dealership bore none, before classifying its accounting."
      );
    }
    if (summary.linesAwaitingActual > 0) {
      throw new ConvexError(
        `${summary.linesAwaitingActual} cost(s) on this deal have no actual amount recorded. Estimates may be used to run the deal, but not to close it.`
      );
    }
    if (summary.linesAwaitingReconciliation > 0) {
      throw new ConvexError(
        `${summary.linesAwaitingReconciliation} cost(s) on this deal have an amount but nobody has checked it. Reconcile them before closing.`
      );
    }
    // The counts above are blind to WHAT was checked: a reconciled line whose
    // amount is NaN, a fraction, a negative or an unsafe value (the writers
    // refuse them, the rows do not) passes both, and the deal would classify
    // clean on totals that are not figures. The summary's own verdict is the
    // gate — it is false over any unreadable amount as well as over any
    // unchecked line — and it is asked directly rather than reassembled.
    if (summary.amountsUnreadable !== null) {
      throw new ConvexError(
        "A cost amount on this deal is not a readable figure, so its accounting cannot be classified until the line is corrected."
      );
    }
    if (!summary.fullyReconciled) {
      throw new ConvexError(
        "This deal's costs are not fully reconciled, so its accounting cannot be classified."
      );
    }
    // Every fee the finance company's FROZEN policy configures needs an actual
    // on the record too — the counts above cannot see a configured fee nobody
    // recorded. One rule for this door and for finalization's, judged on the
    // rows already read above; see `assertConfiguredFeesRecorded`.
    assertConfiguredFeesRecorded(app.companyRuleSnapshot, fees, "closing");

    // Read the arithmetic, not the stored status. A record can be closed and
    // still be unbalanced — a late receipt against a RECONCILED record is
    // exactly the case — and a gate that trusts the flag it is meant to be
    // guarding is not a gate.
    const custodyRows = await custodyFor(ctx, args.applicationId, "classifying this deal's accounting");
    // The whole custody FAMILY must be on the books before the deal's
    // treatment is established on it: a record from before ledger posting,
    // or a custody-paid line whose posting is missing or stale, is refused
    // whatever its status says. Same predicate finalization asks; settled
    // through `migrateLegacyCustodyToLedger`, never inferred here.
    await assertCustodyLedgerFamilyComplete(ctx, args.orgId, args.applicationId, custodyRows, fees, "classifying this deal's accounting");
    for (const row of custodyRows) {
      if (row.status === "OPEN") {
        throw new ConvexError(
          "A custody record on this deal is still open. Settle what that person holds or is owed before classifying."
        );
      }
      const custodySummary = summarizeReadableCustody(row, fees, "classifying this deal's accounting");
      if (!custodySummary.settled && row.status !== "WRITTEN_OFF") {
        throw new ConvexError(
          "A closed custody record on this deal no longer balances — its costs changed after it was reconciled. Reopen it and settle it before classifying."
        );
      }
    }

    if (app.accountingClassification === "CLASSIFIED") {
      throw new ConvexError(
        "This deal's accounting has already been classified. Change what it was based on to reopen it."
      );
    }

    // Establishing a deal's accounting means establishing the figures that
    // follow from it, not just stamping a flag beside them. Every settlement
    // cost above now has a checked actual, so this is the first moment the
    // expected remittance can be derived from what the company actually
    // withholds — and the last moment before finalization reads it.
    //
    // Ordered after the refusals deliberately: a deal that cannot be classified
    // must not have its stored economics moved on the way to being told so.
    await recomputeEconomicsForApplication(ctx, args.applicationId);

    const now = Date.now();
    await ctx.db.patch(args.applicationId, {
      accountingClassification: "CLASSIFIED",
      accountingClassifiedBy: user._id,
      accountingClassifiedAt: now,
      accountingClassificationNotes: notes,
      updatedAt: now,
    });
    return args.applicationId;
  },
});
