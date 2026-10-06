/**
 * SCRUM-717 (D-45): the ONE client-side reading of "is this ownership decision
 * complete?", shared by the vehicle dialog and the approval chooser. Pure. The
 * server is the authority and re-validates; this only names the first unanswered
 * question so the dealer is spared a round trip.
 */

export type OwnershipGapField =
  | "sourceType"
  | "sourcedFromName"
  | "sourceCost"
  | "purchasePrice"
  | "purchasePaymentMethod"
  | "purchaseSupplierName";

export type OwnershipGapReason =
  | "CHOICE_REQUIRED"
  | "SUPPLIER_REQUIRED"
  | "COST_REQUIRED"
  | "BUYOUT_TERMS"
  | "PAYMENT_METHOD"
  | "CREDITOR_REQUIRED";

export interface OwnershipGap {
  field: OwnershipGapField;
  reason: OwnershipGapReason;
}

export interface OwnershipGapDraft {
  sourceType?: string | null;
  sourcedFromName?: string | null;
  /** A number from a form value, or the raw text of an input. */
  sourceCost?: number | string | null;
  purchasePrice?: number | string | null;
  purchasePaymentMethod?: string | null;
  purchaseSupplierName?: string | null;
}

export interface OwnershipGapOptions {
  /** An unchosen type is itself a gap (creating a vehicle); otherwise it is left alone. */
  typeRequired: boolean;
  /** The consignment cost must be positive (false once a posted car's cost is locked). */
  costRequired: boolean;
  /**
   * Owned-car settlement: "required" = a positive price AND a method (a buy-out,
   * or an approval), "ifPriced" = a method only when a price is entered (a new
   * owned car), "none" = not asked (an ordinary edit).
   */
  purchaseTerms: "required" | "ifPriced" | "none";
}

const toNumber = (value: number | string | null | undefined): number =>
  typeof value === "string" ? Number(value) : (value ?? 0);
const isPositive = (value: number | string | null | undefined): boolean => {
  const n = toNumber(value);
  return Number.isFinite(n) && n > 0;
};

/** The first unanswered ownership question, or null when the decision is complete. */
export function ownershipGaps(draft: OwnershipGapDraft, options: OwnershipGapOptions): OwnershipGap | null {
  if (draft.sourceType === "SOURCED") {
    if (!draft.sourcedFromName?.trim()) return { field: "sourcedFromName", reason: "SUPPLIER_REQUIRED" };
    if (options.costRequired && !isPositive(draft.sourceCost)) return { field: "sourceCost", reason: "COST_REQUIRED" };
    return null;
  }
  if (draft.sourceType !== "STOCK") {
    return options.typeRequired ? { field: "sourceType", reason: "CHOICE_REQUIRED" } : null;
  }
  if (options.purchaseTerms === "none") return null;

  const priced = isPositive(draft.purchasePrice);
  if (options.purchaseTerms === "required" && (!priced || !draft.purchasePaymentMethod)) {
    return { field: "purchasePrice", reason: "BUYOUT_TERMS" };
  }
  if (priced && !draft.purchasePaymentMethod) return { field: "purchasePaymentMethod", reason: "PAYMENT_METHOD" };
  if (draft.purchasePaymentMethod === "ON_ACCOUNT" && !draft.purchaseSupplierName?.trim()) {
    return { field: "purchaseSupplierName", reason: "CREDITOR_REQUIRED" };
  }
  return null;
}
