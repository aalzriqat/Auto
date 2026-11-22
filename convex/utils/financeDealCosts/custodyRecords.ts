import type { Doc, Id } from "../../_generated/dataModel";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requireOwnedRow } from "../tenancy";
import { loadCustodyEntries } from "../custodySourceLedger";
import { assertFeeCustodyCurrency, loadCustodyRecords } from "../settlementDeductions";
import type { DealCostAccounting } from "./dealCostAccounting";
import { CUSTODY_NOT_FOUND } from "./dealCostGuards";
import { custodyFeeExpenseKey } from "../dealCustodyPosting";
import { assertCustodyAccountingReady } from "./dealCostAccounting";
import { requireActiveBankInCurrency } from "../bankAccountGuards";

/**
 * The person HOLDING the cash never records its movements or closes its
 * record: the same separation `openDealCustody` enforces on the issuer. A
 * custodian issuing to, reimbursing or reconciling themselves is an
 * uncontrolled loop around the one control this table provides.
 */
export function assertNotCustodian(
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
export async function assertActorNotCustodianOf(
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
export async function requireLinkedCustody(
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
 * Refuses to change anything a closed custody record was balanced against.
 *
 * Closing is a claim that the money is accounted for. Nothing froze the fee
 * lines that determine that, so a late receipt recorded afterwards left the
 * record stored as RECONCILED while the arithmetic said the employee was out of
 * pocket — and `recordCustodyMovement` then refused the reimbursement, its
 * error naming a `reopenDealCustody` mutation that did not exist. Reopen it
 * deliberately instead.
 */
export function assertCustodyOpen(custody: Doc<"financeDealCustody">): void {
  if (custody.status !== "OPEN") {
    throw new ConvexError(
      "This custody record is closed. Reopen it before changing the costs it was balanced against."
    );
  }
}

/**
 * A custody record opened BEFORE custody posted to the ledger carries
 * movements with no journal behind them (Codex AF-CUST-07). Posting a new
 * movement against it would put one leg of the record on the books and leave
 * the rest off — a partial ledger that reads like a whole one. Such a record
 * is refused every money command and reported as legacy; it is settled
 * through an explicit migration, never through the product's own doors.
 */
export function assertCustodyOnLedger(custody: Doc<"financeDealCustody">, action: string): void {
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
export const custodyEntriesFor = loadCustodyEntries;

/**
 * Every custody record of a deal, or a refusal — the WRITERS' read, never a
 * prefix. The ONE bounded loader (`loadCustodyRecords`, beside
 * `loadActiveFees`) serves the one-open-per-person rule, the classification
 * gate and the denomination proof alike; see `MAX_DEAL_CUSTODY_DECISION_RECORDS`.
 */
export async function custodyFor(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">,
  action: string
): Promise<Array<Doc<"financeDealCustody">>> {
  return await loadCustodyRecords(ctx, applicationId, action);
}

/** The screen's bounded read: one row past the cap, so truncation is detectable. */
export async function custodyPageFor(
  ctx: QueryCtx,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"financeDealCustody">>> {
  return await ctx.db
    .query("financeDealCustody")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .take(MAX_DEAL_CUSTODY_RECORDS + 1);
}

/**
 * Resolves the custody record a fee line may be charged against.
 *
 * Shared by `recordDealFee` and `recordActualFeeAmount`, which had the same
 * four checks written out twice — and a divergence between two copies of a
 * money guard is the kind that survives review because both copies look right
 * on their own.
 */
export async function resolveFeeCustody(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">,
  custodyId: Id<"financeDealCustody">,
  line: Pick<Doc<"financeDealFees">, "paidBy" | "deductedFromSettlement" | "accountingTreatment" | "currency">,
  actorId: Id<"users">,
  accounting: DealCostAccounting
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
  await assertCustodyAccountingReady(ctx, orgId, "charging a cost to an employee's custody", accounting);
  return custody._id;
}

// ---------------------------------------------------------------------------
// Employee custody
// ---------------------------------------------------------------------------

/**
 * SCRUM-469 — a custody movement that moves cash must say which instrument it
 * went through. The method picks the ledger account (`disbursementAccountKey`
 * / `cashAccountKey`), and an omitted one used to fall through to CASH_ON_HAND
 * — a bank transfer booked as drawer cash. Refused, with the next step, before
 * anything is written. The validator stays optional so an older client gets this
 * message rather than an argument-validation error.
 *
 * A REVERSAL is the one kind exempt: its whole accounting effect is the inverse
 * of its target's journal, so it never reads a method of its own.
 */
export function requireCustodyMethod<M extends string>(
  method: M | undefined,
  action: string
): M {
  if (method === undefined) {
    throw new ConvexError(
      `Choose how the money moved (cash, bank transfer, cheque or card) before ${action}. If this screen does not offer a method, update the app. Nothing has been recorded.`
    );
  }
  return method;
}

/** True only for one of the four instruments a custody movement can name. */
export function isRecordedCustodyMethod(method: string | undefined | null): boolean {
  return method === "CASH" || method === "BANK_TRANSFER" || method === "CHEQUE" || method === "CARD";
}

export async function requireCustodyBank(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  kind: "ISSUED" | "RETURNED" | "REIMBURSED",
  method: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD" | undefined,
  bankAccountId: Id<"bankAccounts"> | undefined,
  currency: string
): Promise<Id<"bankAccounts"> | undefined> {
  if (method === "CASH" || (kind === "RETURNED" && method === "CHEQUE")) {
    if (bankAccountId) throw new ConvexError("This custody movement does not post to a bank account; remove the bank selection.");
    return undefined;
  }
  return await requireActiveBankInCurrency(ctx, {
    orgId,
    bankAccountId,
    currency,
    missingMessage: "Choose the physical bank account for this custody movement. Nothing has been recorded.",
    currencySubject: "custody movement",
  });
}
