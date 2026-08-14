import { ConvexError } from "convex/values";

export type CurrencyScale = 0 | 2 | 3;

const CURRENCY_SCALES: Record<string, CurrencyScale> = {
  JOD: 3,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SAR: 2,
  AED: 2,
  QAR: 2,
  EGP: 2,
  JPY: 0,
};

/**
 * The scale AutoFlow can actually vouch for, or null when it cannot.
 *
 * `scaleForCurrency` below answers 2 for anything unrecognised, which is the
 * right behaviour for display and arithmetic that must not crash — but it is a
 * GUESS, and a guess is unacceptable where a wrong scale changes a figure by an
 * order of magnitude. `economicsCurrency` is a free string in the schema, so a
 * typo or a raw-edited value like "JD" reaches this code: JOD is scale 3, the
 * fallback would call it 2, and 11,500,000 fils would render as 115,000 on the
 * screen that seals a deal permanently.
 *
 * Callers that seal or display money irreversibly use THIS one and fail closed
 * on null.
 */
export function supportedCurrencyScale(currency: string): CurrencyScale | null {
  const scale = CURRENCY_SCALES[currency.toUpperCase()];
  return scale === undefined ? null : scale;
}

/**
 * The deal's denomination, or null when AutoFlow cannot vouch for it.
 *
 * ABSENT is unknowable: `orgSettings` does not lock currency for
 * `financeApplications`, so an org can record economics in JOD and later switch
 * to USD — the current org currency is a known-wrong fallback, not a
 * conservative one. UNSUPPORTED is unknowable too: the field is a free string,
 * so a legacy row or a raw edit can carry "JD", and `scaleForCurrency` answers
 * 2 for it rather than admitting it does not know.
 */
export function denominationOf(
  currency: string | undefined
): { code: string; scale: CurrencyScale } | null {
  if (!currency) return null;
  const code = currency.toUpperCase();
  const scale = supportedCurrencyScale(code);
  return scale === null ? null : { code, scale };
}

/**
 * Refuses a write that would carry an UNSUPPORTED denomination forward.
 *
 * Absent is deliberately allowed: every economics writer fills it from the
 * organization's currency, which `orgSettings.upsert` validates. A present but
 * unrecognised code is the dangerous one, because each writer preserves it
 * (`app.economicsCurrency ?? getOrgCurrency(...)`) rather than replacing it —
 * so one bad value survives every subsequent write and ends up scaled by a
 * guess when a sale is created.
 *
 * Applied at EVERY writer that can put money on a deal, not only at the one
 * that happens to run first. A guard scoped to "economics already exist" was
 * bypassable by ordering: hand over a legacy row with no economics, then record
 * them afterwards, and the deal reached sale creation with an unverifiable
 * currency and no mutation left that would refuse it.
 */
export function assertSupportedDenomination(
  currency: string | undefined,
  action: string
): void {
  if (currency && supportedCurrencyScale(currency) === null) {
    throw new ConvexError(
      `This deal's economics are recorded in "${currency}", which AutoFlow does not recognise, so ${action} would scale the amount by a guess. Restate the deal in a supported currency first.`
    );
  }
}

export function scaleForCurrency(currency: string): CurrencyScale {
  const scale = CURRENCY_SCALES[currency.toUpperCase()];
  if (scale === undefined) return 2;
  return scale;
}

export function toMinorUnits(amount: number, currency: string): number {
  const scale = scaleForCurrency(currency);
  const factor = Math.pow(10, scale);
  const result = Math.round(amount * factor);
  if (!Number.isSafeInteger(result)) {
    throw new ConvexError(`Amount ${amount} ${currency} overflows safe integer when converted to minor units.`);
  }
  return result;
}

export function fromMinorUnits(amountMinor: number, currency: string): number {
  const scale = scaleForCurrency(currency);
  const factor = Math.pow(10, scale);
  return amountMinor / factor;
}

/**
 * A subledger row's major-unit amount in the query's currency, or `undefined`.
 *
 * `undefined` is the single way a bad amount leaves this function, and every
 * caller must treat it as UNKNOWN rather than as zero. Three separate things
 * produce it: a row denominated in another currency (a balance nobody here can
 * state), a non-finite amount, and one that would overflow a safe integer.
 *
 * The overflow check is deliberately performed BEFORE delegating to
 * `toMinorUnits`, which throws on an unsafe result — inspecting its return value
 * would be too late to avoid the throw, and one corrupt row must not blank a
 * whole screen. `NaN` is the case that does real damage: Convex accepts it under
 * a `v.number()` validator, so it arrives from the raw-JSON editor looking valid.
 *
 * Extracted from `applications.ts` for SCRUM-29 so the cash deal path resolves
 * party balances through the same conversion the financed path already used.
 * Two implementations of "what does this row owe" is precisely how one screen
 * comes to contradict another about the same deal.
 */
export function toMinorSameCurrencyOrUndefined(
  amount: number,
  rowCurrency: string,
  queryCurrency: string
): number | undefined {
  if (rowCurrency !== queryCurrency) return undefined;
  if (!Number.isFinite(amount)) return undefined;
  const candidate = Math.round(amount * Math.pow(10, scaleForCurrency(rowCurrency)));
  if (!Number.isSafeInteger(candidate)) return undefined;
  return toMinorUnits(amount, rowCurrency);
}

/**
 * What is LEFT on a subledger row, in minor units — never what it started at.
 *
 * Floored at zero: an overpayment is not a negative debt on a party row.
 * `undefined` propagates from either side under the rule above, because a
 * difference computed against an unknown is not a smaller difference, it is not
 * a difference.
 */
export function outstandingMinorFromMajor(
  dueMajor: number,
  settledMajor: number,
  rowCurrency: string,
  currency: string
): number | undefined {
  const due = toMinorSameCurrencyOrUndefined(dueMajor, rowCurrency, currency);
  const settled = toMinorSameCurrencyOrUndefined(settledMajor, rowCurrency, currency);
  return due === undefined || settled === undefined ? undefined : Math.max(0, due - settled);
}

export function addMinor(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new ConvexError("Minor-unit addition overflows safe integer.");
  }
  return result;
}

export function subtractMinor(a: number, b: number): number {
  return a - b;
}

export function isValidMinorAmount(amount: number): boolean {
  return Number.isInteger(amount) && amount >= 0 && Number.isSafeInteger(amount);
}

export function assertValidMinorAmount(amount: number, label = "amount"): void {
  if (!isValidMinorAmount(amount)) {
    throw new ConvexError(`Invalid minor-unit ${label}: ${amount}. Must be a non-negative safe integer.`);
  }
}

/**
 * Rejects NaN and ±Infinity for a caller-supplied number that is validated by
 * range comparisons rather than by minor-unit rules (a decimal price, a term, a
 * rate). Convex accepts both as legitimate v.number() values, and EVERY
 * comparison against NaN is false — so `x < 0`, `x > max` and `x === 0` all pass
 * it, and the value flows on into arithmetic that silently yields NaN and gets
 * stored. Call this before comparison-based validation, not after.
 */
export function assertFiniteNumber(value: number, label = "value"): void {
  if (!Number.isFinite(value)) {
    throw new ConvexError(`Invalid ${label}: ${value}. Must be a finite number.`);
  }
}

export function assertSameCurrency(a: string, b: string, context = ""): void {
  if (a.toUpperCase() !== b.toUpperCase()) {
    throw new ConvexError(
      `Currency mismatch${context ? ` in ${context}` : ""}: ${a} vs ${b}.`
    );
  }
}

export type MoneyMinor = {
  amountMinor: number;
  currency: string;
  scale: CurrencyScale;
};

export function makeMoney(amountMinor: number, currency: string): MoneyMinor {
  assertValidMinorAmount(amountMinor, "amountMinor");
  return { amountMinor, currency: currency.toUpperCase(), scale: scaleForCurrency(currency) };
}

export function moneyFromDecimal(amount: number, currency: string): MoneyMinor {
  const amountMinor = toMinorUnits(amount, currency);
  return makeMoney(amountMinor, currency);
}
