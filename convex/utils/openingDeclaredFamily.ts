/**
 * The one rule for "a declared opening control holds one allocation family" (SCRUM-944).
 *
 * The posting validator (`validateDeclaredOpeningControl`) and the reconciliation reader both refuse a control whose
 * rows mix families, and the entry screen must not let an operator submit a state the server always refuses. All
 * three read this module, so there is no second copy of the rule in `components/`.
 *
 * LEAF MODULE (SCRUM-302): no imports, so the client bundle can import it (like `./money`) without pulling in any
 * server module. `openingAccountPolicy.ts` re-exports it, so its existing callers are untouched.
 */

export type RemainingOpeningKind =
  | "SUPPLIER_RECOVERABLE"
  | "SUPPLIER_PAYABLE"
  | "OTHER_PAYABLE"
  | "EMPLOYEE_COMMISSION"
  | "UNALLOCATED_LIABILITY"
  | "CUSTOMER_DEPOSIT";

const REMAINING_OPENING_KINDS: readonly string[] = [
  "SUPPLIER_RECOVERABLE",
  "SUPPLIER_PAYABLE",
  "OTHER_PAYABLE",
  "EMPLOYEE_COMMISSION",
  "UNALLOCATED_LIABILITY",
  "CUSTOMER_DEPOSIT",
];

export function isRemainingOpeningKind(kind: string): kind is RemainingOpeningKind {
  return REMAINING_OPENING_KINDS.includes(kind);
}

/** What the rule reads from an allocation row: stored rows, payload rows and screen drafts all fit. */
export type OpeningFamilyRow = { readonly kind: string; readonly purpose?: string };

export type OpeningFamilyConflict = "NO_FAMILY" | "MIXED_KIND" | "MIXED_PURPOSE";

export const OPENING_FAMILY_REFUSAL_MESSAGES: Readonly<Record<OpeningFamilyConflict, string>> = {
  NO_FAMILY: "Every opening control needs one explicitly declared allocation family.",
  MIXED_KIND: "Every opening control needs one explicitly declared allocation family.",
  MIXED_PURPOSE: "Unidentified opening pools need separate declared controls.",
};

/** The rows of ONE declared control account. A control cannot combine operational families or unidentified pools. */
export function openingDeclaredFamilyConflict(
  rows: readonly OpeningFamilyRow[],
): OpeningFamilyConflict | null {
  if (rows.length === 0) return "NO_FAMILY";
  if (new Set(rows.map((row) => row.kind)).size !== 1) return "MIXED_KIND";
  if (rows[0].kind === "UNALLOCATED_LIABILITY" && new Set(rows.map((row) => row.purpose)).size !== 1)
    return "MIXED_PURPOSE";
  return null;
}

/** Shared by posting validation and reconciliation so stored declarations cannot invent a writer state. */
export function openingDeclaredFamilyRefusal(rows: readonly OpeningFamilyRow[]): string | null {
  const conflict = openingDeclaredFamilyConflict(rows);
  return conflict === null ? null : OPENING_FAMILY_REFUSAL_MESSAGES[conflict];
}