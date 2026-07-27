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
