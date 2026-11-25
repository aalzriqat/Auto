/**
 * SCRUM-613: the approval now REQUIRES an entered approved financing amount.
 * Suites written before it drove the percentage basis; this supplies the amount
 * that basis funded (approved x LTV, half-up) so their expectations stay valid.
 * It is the old formula on purpose, not a new authority: tests that exercise the
 * entered amount itself pass their own figure.
 */
export function legacyFinancingMinor(approvedAmountMinor: number, ltvPercent = 85): number {
  return Math.round((approvedAmountMinor * ltvPercent) / 100);
}
