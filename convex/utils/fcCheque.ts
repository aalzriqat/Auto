import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { assertSupportedDenomination, scaleForCurrency } from "./money";

/**
 * SCRUM-447 — finance-company cheque lineage.
 *
 * INVARIANT: a cheque with finance-company lineage names its real drawer or says
 * UNVERIFIED; it reaches CLEARED only through `applications.confirmDisbursement`
 * with a face exactly equal to the receipt; it never outlives its deal; it is
 * never presented to, chased from, cleared against or replaced for the customer.
 * LINEAGE IS PERMANENT: no writer removes it. "Active" is a status question.
 *
 * One shared module so the predicate cannot drift between the writers
 * (collections.ts), the disbursement door (applications.ts) and the audit.
 */

type ChequeLineageShape = Pick<
  Doc<"postDatedCheques">,
  "applicationId" | "originApplicationId" | "drawerType"
>;

/** A cheque that is, or ever was, a finance-company instrument. */
export function isFcLineage(row: ChequeLineageShape): boolean {
  return (
    row.applicationId !== undefined ||
    row.originApplicationId !== undefined ||
    row.drawerType === "FINANCE_COMPANY"
  );
}

/** FC lineage AND still an open instrument (HELD / DEPOSITED) AND not deleted. */
export function isLiveFcCheque(
  row: ChequeLineageShape & Pick<Doc<"postDatedCheques">, "status" | "isDeleted">
): boolean {
  return (
    isFcLineage(row) &&
    row.isDeleted !== true &&
    (row.status === "HELD" || row.status === "DEPOSITED")
  );
}

/** Every non-deleted cheque linked to the application, any status. */
export async function chequesForApplication(
  ctx: QueryCtx,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"postDatedCheques">>> {
  const rows = await ctx.db
    .query("postDatedCheques")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .collect();
  return rows.filter((row) => row.isDeleted !== true);
}

/**
 * SCRUM-447 N1: a linked cheque reached CLEARED. On an undisbursed deal that is
 * an accounting-review state (the cheque cleared outside the disbursement door),
 * whatever else is linked beside it. The ONE predicate behind the cockpit's
 * `chequeNeedsAccountingReview` and `confirmDisbursement`'s refusal, so the
 * screen withholds exactly what the server refuses.
 */
export function hasClearedLinkedCheque(rows: ReadonlyArray<Pick<Doc<"postDatedCheques">, "status">>): boolean {
  return rows.some((row) => row.status === "CLEARED");
}
/** The application's LIVE finance-company cheques. Never `.unique()`. */
export async function liveChequesForApplication(
  ctx: QueryCtx,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"postDatedCheques">>> {
  return (await chequesForApplication(ctx, applicationId)).filter(isLiveFcCheque);
}

/**
 * SCRUM-239: the coded refusals of returning a cleared finance-company cheque.
 * The English text is the server's own `message`; `lib/i18n/domains/sales.ts`
 * carries the same sentence and its Arabic under `ServerError_<code>`, and a
 * test holds the two together. Static on purpose: no placeholders, and no
 * amounts or ids.
 */
export const FC_RETURN_MESSAGES = {
  FINANCE_RETURN_NOT_DISBURSED:
    "This deal has no confirmed finance-company disbursement, so there is no cleared cheque to return. Nothing has been changed.",
  FINANCE_RETURN_CHEQUE_NOT_CLEARED:
    "Only a cleared finance-company cheque can be returned from the deal, and this cheque is not cleared. Nothing has been changed.",
  FINANCE_RETURN_CHAIN_MISMATCH:
    "This cheque does not match the deal's recorded disbursement (the cheque, amount, currency or payment). Nothing has been changed. An accountant reviews the deal.",
  FINANCE_RETURN_ALLOCATION_SHAPE:
    "The disbursement payment is not allocated exactly to this deal's finance-company receivable, so it cannot be reversed safely. Nothing has been changed. An accountant reviews the deal.",
  FINANCE_RETURN_REVERSAL_UNPROVEN:
    "The finance company's receipt could not be confirmed as reversed on the books, so the return was not recorded. Nothing has been changed. An accountant reviews the deal.",
  FINANCE_CHEQUE_RETURN_FROM_DEAL:
    "This is a finance-company cheque. Its return is recorded from the deal screen with the \"Cheque returned by bank\" action, not from customer collections. Nothing has been changed.",
} as const;
/** SCRUM-447 B4: longest operator note kept with a face attestation. */
export const ATTESTATION_NOTE_MAX_LENGTH = 500;

/** The operator-facing next step for every customer-collection refusal. */
export const FC_CHEQUE_DEAL_NEXT_STEP =
  "This is a finance-company cheque. It is handled from the deal, never from customer collections.";

/**
 * A decimal string parsed at the deal currency's scale — no floats, no rounding.
 *
 * More fractional digits than the scale, non-numeric, zero, negative, signed,
 * exponent notation or above Number.MAX_SAFE_INTEGER minor units are refused.
 */
export function parseFaceAmountMinor(faceAmount: string | undefined, currency: string): number {
  if (typeof faceAmount !== "string" || faceAmount.trim() === "") {
    throw new ConvexError("Record the cheque's face amount exactly as printed on the instrument.");
  }
  const scale = scaleForCurrency(currency);
  const text = faceAmount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new ConvexError(
      "The cheque's face amount must be a plain decimal number such as 20000 or 20000.500."
    );
  }
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (fraction.length > scale) {
    throw new ConvexError(
      `The cheque's face amount has more decimal places than ${currency} allows (${scale}). Record it exactly as printed.`
    );
  }
  const minor = BigInt(whole) * BigInt(10) ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
  if (minor <= BigInt(0)) {
    throw new ConvexError("The cheque's face amount must be greater than zero.");
  }
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConvexError("The cheque's face amount is too large to record.");
  }
  return Number(minor);
}

/**
 * The denomination a deal's cheque face is recorded in: the deal's frozen
 * `economicsCurrency`, else the finance-company receivable's currency, else the
 * organization's. Always a supported denomination or a refusal.
 */
export async function dealChequeCurrency(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  orgCurrency: string
): Promise<string> {
  let currency: string | undefined = app.economicsCurrency;
  if (currency === undefined) {
    const receivable = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", app.orgId).eq("sourceType", "finance_application").eq("sourceId", app._id)
      )
      .unique();
    currency = receivable?.currency ?? orgCurrency;
  }
  assertSupportedDenomination(currency, "recording a cheque face");
  return currency;
}
