/**
 * SCRUM-571 ruling 10 (owner ruling c23812 on SCRUM-760): an uncollectable financed-customer gap invoice is not
 * acceptable. Until the invoice receipt resolver exists (SCRUM-722/723/724) no certified door applies a customer's
 * payment to a sale invoice, so a financed deal whose customer still owes the dealership a gap would open a customer
 * invoice that nobody can collect. While this switch is on, `applications.finalizeDeal` (the only door that completes a
 * FINANCED sale) refuses such a deal before its first write. The rule lives in `financedGapPilotGate.ts`. It enables no
 * receipt or application door.
 *
 * A post-pilot activation gate. Turning it off needs the receipt and application doors (SCRUM-722/723/724), a new
 * certification round and the owner's approval: a code change reviewed on its own, never an env var.
 *
 * Deliberately a module of its own, and deliberately NOT in `saleDebtContainment.ts`:
 * - not there, so a fixture-only suite can opt out of this switch without touching the cash switches that the SCRUM-802
 *   census counts;
 * - not in the gate module, because a module-level `vi.mock` replaces the exports another module imports, not the binding
 *   a function reads from its own file. The gate must import the switch for an opt-out to reach it.
 * `scripts/scrum571FinancedGapOptOutCensus.test.ts` pins the list of suites that opt out.
 */
export const FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED = true as const;
