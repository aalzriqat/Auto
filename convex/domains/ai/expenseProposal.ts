/**
 * What the model may say about an expense, and how its answer becomes a proposal.
 *
 * The model reads one message and answers with fields. This module is the only place its
 * text becomes anything: it parses strictly, then checks every value in code. Any violation
 * is "not understood" with no partial proposal. A proposal is not an expense: it is a set
 * of suggested form values that a staff member checks and saves through the normal form.
 *
 * `date` is a calendar day (`YYYY-MM-DD`, ASCII digits) with no zone. The window is
 * [today - 366 days, today], where `today` is the dealership's day, passed in by the caller.
 */
import type { Infer } from "convex/values";
import { NON_PREPAID_EXPENSE_CATEGORIES } from "@autoflow/shared";
import type { expenseProposalValidator } from "../../schema/ai.schema";
import type { PaymentMethod } from "../../utils/paymentMethods";

export type ExpenseProposal = Infer<typeof expenseProposalValidator>;

export type ExpenseDecision =
  | { kind: "proposal"; proposal: ExpenseProposal }
  | { kind: "not_expense" }
  | { kind: "not_understood" };

export const MAX_ASSISTANT_MESSAGE_CHARS = 1000;
export const MAX_TITLE_CHARS = 100;
export const MAX_NOTES_CHARS = 1000;
export const MAX_VENDOR_CHARS = 100;
/** How far back an expense may be dated, in days. */
export const MAX_DAYS_BACK = 366;

/**
 * Categories the assistant may propose. PREPAID is left out: a prepaid expense needs
 * amortization months and a start date, which one message does not carry.
 */
export const ASSISTANT_EXPENSE_CATEGORIES: readonly string[] = NON_PREPAID_EXPENSE_CATEGORIES;

// A record keyed by the contract's type, so a method added to the contract fails to compile here.
const PAYMENT_METHOD_TABLE: Record<PaymentMethod, true> = { CASH: true, BANK_TRANSFER: true, CHEQUE: true, CARD: true };
export const PAYMENT_METHODS: readonly string[] = Object.keys(PAYMENT_METHOD_TABLE);

const MODEL_KEYS: readonly string[] = [
  "outcome",
  "amount",
  "taxAmount",
  "category",
  "date",
  "title",
  "notes",
  "vendorName",
  "paymentMethod",
];

const NOT_UNDERSTOOD: ExpenseDecision = { kind: "not_understood" };
const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a real calendar day written `YYYY-MM-DD`, or null. */
export function calendarDayNumber(text: string): number | null {
  const match = DAY_PATTERN.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  // A date that does not exist (30 February) rolls over; the round trip catches it.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return ms / DAY_MS;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A proposal that breaks no rule. `today` is the dealership's day, `YYYY-MM-DD`. */
export function isValidProposal(proposal: ExpenseProposal, today: string): boolean {
  const { amount, taxAmount, category, date, title, notes, vendorName, paymentMethod } = proposal;
  // NaN passes the argument validator, so the value is checked here.
  if (!isFiniteNumber(amount) || !(amount > 0)) return false;
  if (taxAmount !== undefined && (!isFiniteNumber(taxAmount) || taxAmount < 0 || taxAmount > amount)) return false;
  if (!ASSISTANT_EXPENSE_CATEGORIES.includes(category)) return false;
  const day = calendarDayNumber(date);
  const todayNumber = calendarDayNumber(today);
  if (day === null || todayNumber === null) return false;
  if (day > todayNumber || todayNumber - day > MAX_DAYS_BACK) return false;
  if (title.trim().length < 1 || title.length > MAX_TITLE_CHARS) return false;
  if (notes !== undefined && notes.length > MAX_NOTES_CHARS) return false;
  if (vendorName !== undefined && vendorName.length > MAX_VENDOR_CHARS) return false;
  if (paymentMethod !== undefined && !PAYMENT_METHODS.includes(paymentMethod)) return false;
  return true;
}

/** A text field the model may leave null: null or blank is absent, any other type is a violation. */
function optionalText(value: unknown): { ok: true; text: string | undefined } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, text: undefined };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  return { ok: true, text: trimmed === "" ? undefined : trimmed };
}

/**
 * The model's answer as a value (already parsed JSON). Accepts exactly the nine keys of the
 * output schema or fewer; any other key is a violation.
 */
export function decideExpenseOutput(output: unknown, today: string): ExpenseDecision {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return NOT_UNDERSTOOD;
  const record = output as Record<string, unknown>;
  if (Object.keys(record).some((key) => !MODEL_KEYS.includes(key))) return NOT_UNDERSTOOD;
  if (record.outcome === "not_expense") return { kind: "not_expense" };
  if (record.outcome !== "expense") return NOT_UNDERSTOOD;

  const { amount, taxAmount, category, date, title } = record;
  if (typeof amount !== "number" || typeof category !== "string" || typeof date !== "string" || typeof title !== "string") {
    return NOT_UNDERSTOOD;
  }
  if (taxAmount !== null && taxAmount !== undefined && typeof taxAmount !== "number") return NOT_UNDERSTOOD;
  const notes = optionalText(record.notes);
  const vendorName = optionalText(record.vendorName);
  const method = optionalText(record.paymentMethod);
  if (!notes.ok || !vendorName.ok || !method.ok) return NOT_UNDERSTOOD;

  const proposal: ExpenseProposal = {
    amount,
    category: category as ExpenseProposal["category"],
    date,
    title: title.trim(),
  };
  if (typeof taxAmount === "number") proposal.taxAmount = taxAmount;
  if (notes.text !== undefined) proposal.notes = notes.text;
  if (vendorName.text !== undefined) proposal.vendorName = vendorName.text;
  if (method.text !== undefined) proposal.paymentMethod = method.text as PaymentMethod;
  return isValidProposal(proposal, today) ? { kind: "proposal", proposal } : NOT_UNDERSTOOD;
}

/** The model's answer as text. Text that is not a JSON object is not understood. */
export function decideExpenseProposal(text: string, today: string): ExpenseDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NOT_UNDERSTOOD;
  }
  return decideExpenseOutput(parsed, today);
}
