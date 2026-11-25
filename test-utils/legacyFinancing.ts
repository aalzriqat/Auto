/**
 * SCRUM-613: the approval now REQUIRES an entered approved financing amount.
 * Suites written before it drove the percentage basis; this supplies the amount
 * that basis funded so their expectations stay valid:
 *   min(approved x LTV (half-up), approved - customer first payment applied).
 * It is the old formula on purpose, not a new authority: tests that exercise the
 * entered amount itself pass their own figure. `ltvPercent` is the LTV the
 * approval resolved to (the argument, else the quotation's frozen LTV, which for
 * a test company is its `defaultLtvPercent`); `firstPaymentMinor` is the
 * customer first payment recorded on the quotation.
 */
export function legacyFinancingMinor(
  approvedAmountMinor: number,
  ltvPercent: number,
  firstPaymentMinor = 0
): number {
  const byLtv = Math.min(Math.round((approvedAmountMinor * ltvPercent) / 100), approvedAmountMinor);
  const applied = Math.min(firstPaymentMinor, approvedAmountMinor);
  return Math.min(byLtv, approvedAmountMinor - applied);
}
