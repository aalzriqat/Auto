/**
 * The finance company's fee templates as the settings dialog edits them.
 *
 * A template is stored with `estimatedAmountMinor`, an integer in the org
 * currency's minor unit (fils for JOD, cents for USD). The operator types a
 * MAJOR amount. The conversion between the two is done on the decimal STRING,
 * never by multiplying a float: `1.005 * 1000` is `1004.9999999999999` and
 * `Math.round` happens to rescue that one, but the class of error is real and
 * the stored integer is what every later deal snapshots as the expected cost.
 * The same string path runs in reverse when a stored company is loaded, so a
 * template that is loaded and saved untouched is byte-identical.
 *
 * Everything here is pure and free of React so it can be tested as arithmetic.
 */
import type { Infer } from "convex/values";
import {
  feeAccountingTreatmentValidator,
  feePartyValidator,
  financeFeeTemplateValidator,
  financeFeeTypeValidator,
} from "@/convex/utils/financingEconomics";

export type FinanceFeeTemplate = Infer<typeof financeFeeTemplateValidator>;
export type FinanceFeeType = Infer<typeof financeFeeTypeValidator>;
export type FeeParty = Infer<typeof feePartyValidator>;
export type FeeAccountingTreatment = Infer<typeof feeAccountingTreatmentValidator>;

/**
 * The option lists are read off the validators rather than restated, so a
 * literal added to the backend union appears in the dialog without a second
 * edit — and one removed cannot linger here as an option the server refuses.
 */
function literalMembers<T extends string>(validator: {
  members: ReadonlyArray<{ value: T }>;
}): readonly T[] {
  return validator.members.map((member) => member.value);
}

export const FINANCE_FEE_TYPES: readonly FinanceFeeType[] = literalMembers(financeFeeTypeValidator);
export const FEE_PARTIES: readonly FeeParty[] = literalMembers(feePartyValidator);
export const FEE_ACCOUNTING_TREATMENTS: readonly FeeAccountingTreatment[] = literalMembers(
  feeAccountingTreatmentValidator
);

/** One template as the form holds it: the amount is the operator's major-unit text. */
export type FeeTemplateFormRow = {
  /** Stable identity for React and for error reporting; never persisted. */
  key: string;
  feeType: FinanceFeeType;
  description: string;
  /** Major units exactly as typed, e.g. "25" or "12.500". */
  estimatedAmount: string;
  paidBy: FeeParty;
  paidTo: FeeParty;
  includedInQuotation: boolean;
  deductedFromSettlement: boolean;
  refundable: boolean;
  accountingTreatment: FeeAccountingTreatment;
};

export type FeeAmountProblem = "EMPTY" | "NOT_A_NUMBER" | "TOO_PRECISE" | "TOO_LARGE";

export type ParsedMinorAmount =
  | { ok: true; minor: number }
  | { ok: false; problem: FeeAmountProblem };

/**
 * Major-unit text → minor-unit integer at `scale` decimal places, exactly.
 *
 * Accepts plain decimal notation only (`12`, `12.5`, `.5`, `12.`), which is
 * what a numeric input yields. Trailing zeros past the scale are tolerated
 * (`1.50000` at scale 3 is `1500`); any other digit past it is refused rather
 * than rounded, because the operator typed a figure the currency cannot hold
 * and silently rounding it would store a number they never saw.
 */
export function parseMajorToMinor(value: string, scale: number): ParsedMinorAmount {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, problem: "EMPTY" };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) {
    return { ok: false, problem: "NOT_A_NUMBER" };
  }
  const whole = match[1] === "" ? "0" : match[1];
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > scale) return { ok: false, problem: "TOO_PRECISE" };
  const digits = whole + fraction.padEnd(scale, "0");
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return { ok: false, problem: "TOO_LARGE" };
  return { ok: true, minor };
}

/**
 * Minor-unit integer → major-unit text at `scale` decimal places, exactly.
 * Trailing fractional zeros are dropped for readability ("25" not "25.000");
 * `parseMajorToMinor` restores them, so the round trip is the identity.
 */
export function formatMinorAsMajor(minor: number, scale: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) return "";
  if (scale === 0) return String(minor);
  const padded = String(minor).padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * The counterparty and ledger treatment a fee type is usually configured with.
 * Pre-selected when a row is added or its type changed, and shown, so a
 * different answer is a deliberate choice rather than a hidden default.
 */
export function defaultsForFeeType(
  feeType: FinanceFeeType
): { paidTo: FeeParty; accountingTreatment: FeeAccountingTreatment } {
  switch (feeType) {
    case "OWNERSHIP_TRANSFER":
    case "LIEN_REGISTRATION":
    case "LIEN_RELEASE":
      return { paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" };
    case "STAMPS":
    case "LICENSING":
      return { paidTo: "GOVERNMENT", accountingTreatment: "SELLING_EXPENSE" };
    case "INSURANCE":
      return { paidTo: "INSURER", accountingTreatment: "INSURANCE_EXPENSE" };
    case "APPRAISAL_FEE":
      return { paidTo: "APPRAISER", accountingTreatment: "APPRAISAL_EXPENSE" };
    case "COMMISSION":
      return { paidTo: "FINANCE_COMPANY", accountingTreatment: "FINANCE_COMPANY_COMMISSION" };
    case "FINANCE_COMPANY_FEE":
    case "ADMINISTRATIVE_FEE":
      return { paidTo: "FINANCE_COMPANY", accountingTreatment: "SELLING_EXPENSE" };
    case "INSPECTION":
    case "OTHER_CLOSING_EXPENSE":
      return { paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE" };
  }
}

/** A blank row: the most common handover cost, paid by the dealership, nothing ticked. */
export function newFeeTemplateFormRow(key: string): FeeTemplateFormRow {
  const feeType: FinanceFeeType = "OWNERSHIP_TRANSFER";
  return {
    key,
    feeType,
    description: "",
    estimatedAmount: "",
    paidBy: "DEALER",
    ...defaultsForFeeType(feeType),
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
  };
}

/** A stored template → the row that edits it. Every field is carried; nothing is defaulted. */
export function feeTemplateToFormRow(
  template: FinanceFeeTemplate,
  scale: number,
  key: string
): FeeTemplateFormRow {
  return {
    key,
    feeType: template.feeType,
    description: template.description ?? "",
    estimatedAmount: formatMinorAsMajor(template.estimatedAmountMinor, scale),
    paidBy: template.paidBy,
    paidTo: template.paidTo,
    includedInQuotation: template.includedInQuotation,
    deductedFromSettlement: template.deductedFromSettlement,
    refundable: template.refundable,
    accountingTreatment: template.accountingTreatment,
  };
}

export type FeeRowsConversion = {
  /** Every row that converted, in order — complete only when `problems` is empty. */
  templates: FinanceFeeTemplate[];
  /** Amount problems by row key. */
  problems: Record<string, FeeAmountProblem>;
};

/**
 * Rows → the `feeTemplates` argument the company mutations take.
 *
 * A blank description is OMITTED rather than sent as "", matching how the
 * validator marks it optional. Partial success is not offered as a payload:
 * the caller must refuse to submit while `problems` is non-empty, otherwise
 * a row the operator filled in would vanish from the company's policy.
 */
export function feeFormRowsToTemplates(rows: readonly FeeTemplateFormRow[], scale: number): FeeRowsConversion {
  const templates: FinanceFeeTemplate[] = [];
  const problems: Record<string, FeeAmountProblem> = {};
  for (const row of rows) {
    const parsed = parseMajorToMinor(row.estimatedAmount, scale);
    if (!parsed.ok) {
      problems[row.key] = parsed.problem;
      continue;
    }
    const description = row.description.trim();
    templates.push({
      feeType: row.feeType,
      ...(description === "" ? {} : { description }),
      estimatedAmountMinor: parsed.minor,
      paidBy: row.paidBy,
      paidTo: row.paidTo,
      includedInQuotation: row.includedInQuotation,
      deductedFromSettlement: row.deductedFromSettlement,
      refundable: row.refundable,
      accountingTreatment: row.accountingTreatment,
    });
  }
  return { templates, problems };
}
