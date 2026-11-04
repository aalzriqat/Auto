# ADR: per-supplier payments reconciliation to GL 2400

Date: 2026-11-04
Status: proposed, implemented on branch claude/scrum869-gl-reconciliation (stacked on claude/scrum869-settled-history; not merged). Jira: SCRUM-869 feature (statements, settlements), design gap 4. ADR required before a money PR by SCRUM-760 c24361.

## Context

The statement (slice 1) and settled history (slice 4) read the supplier subledger: `vehicleSupplierPayables`, `vehicleSupplierReceivables` and `supplierCostRecoveries`. The organization-wide reconciliations (`supplierPayablesReconciliation` for GL 2400, `supplierReceivablesReconciliation` for GL 1240) compare the sum of those rows with the control account. When the organization-wide figure differs, nothing says which supplier is the cause.

A per-supplier comparison needs a supplier dimension on the ledger, and the ledger has none. `journalLines` carry an account, an amount and a currency. The entry carries `sourceType` and `sourceId`. Checked in `convex/accounting/workflowHooks.ts` and `postingRules.ts`:

- The credit to 2400 is posted by `SALE_COMPLETED` (`sourceType: "sales"`) and `VEHICLE_ACQUIRED` (`sourceType: "vehicles"`). One sale entry can credit 2400 for several suppliers (`consignedAgentSaleLines`). No field on the line or entry names a supplier.
- The debit to 2400 for a payment is posted by `SUPPLIER_PAYMENT_SETTLED` with `sourceType: "vehicleSupplierPayables"` and `sourceId` equal to the payable id, for exactly `amountMinor` (`ruleSupplierPaymentSettled`). A reversal entry copies the original's `sourceType` and `sourceId` with inverted lines (`accounting/reversals.ts`).
- 1240 is posted by sale, deposit, receivable-collected and cost-recovery events, with mixed source types.

## Decision

Reconcile only what the ledger lets us attribute. `api.supplierStatement.paymentsReconciliation` compares, per currency, the cash the subledger says was paid to this supplier with the net debit to 2400 posted against this supplier's payables. The credit side (what was owed) is not attributable and is reported as such, never as a number. The 1240 side is out of scope for the same reason.

- Subledger paid: `toMinorUnits(settlementView(row).amountPaid, currency)` over the supplier's payables, native rows only.
- GL paid: for each payable, the entries from `journalEntries.by_org_source` (`"vehicleSupplierPayables"`, payable id), their lines on the 2400 account, `debitMinor - creditMinor`. Reversals net out because they carry the same source and inverted lines.
- Opening-basis payables (`origin === "OPENING"`) settle against opening accounts, not 2400. They are excluded from both sides and counted in `excludedOpeningRows`, so the figure says what it covers.
- Read-only. No posting path, no write, no schema or index change, the organization comes from `ctx.auth`. Gate: VIEW_FINANCE, the accounting feature, supplier through `requireOwnedRow`. No net field, no A/R figure.

## Invariants

- R1. A figure marked reconciled means subledger paid equals GL paid for every currency, over a complete read, with nothing in flight. Anything the read cannot prove makes the result UNAVAILABLE, never reconciled (the rule `computeSupplierPayablesReconciliation` already follows).
- R2. Currencies are never blended (W7). Payments and obligations are never netted (W1).
- R3. Bounded reads: past the bound the result is UNAVAILABLE `OVER_LIMIT`, never a partial sum (W14).
- R4. A difference names the payables that carry it, so the accountant can act.

## Impact map

- New: `paymentsReconciliation` query in `convex/supplierStatement.ts`, a reader in `convex/utils/supplierObligationDue.ts` (or a sibling util), a UI block and `SuppliersStmtRecon*` keys.
- Reused unchanged: `hasPendingAffectingPosting` and `AP_AFFECTING_EVENT_TYPES` (exported from `convex/accountingReports.ts`, no behaviour change).
- Not touched: posting rules, hooks, `customerCreditPayoutContainment.ts`, schema.

## Five ways this could be wrong, and the answer to each

1. A payment queued in the outbox but not posted makes the subledger lead the GL. Answer: any queued or failed AP-affecting outbox event makes the result UNAVAILABLE `PENDING_POSTINGS`. Test.
2. A reversed payment: the subledger is decremented, the GL has the reversal entry. Answer: net over all entries of the source, so both sides agree. By construction (`accounting/reversals.ts` copies `sourceType` and `sourceId`); no test drives it, because no public door reverses a supplier payment in the pilot.
3. A line that carries another organization's id, or a line in another currency than its payable. Answer: entries come from an organization-scoped index; a line with a foreign `orgId` or a different currency makes the result UNAVAILABLE `INCONSISTENT_REFERENCE`. Not driven by a test (the harness cannot write such a line through a door); the cross-organization read of the supplier itself is tested.
4. More payables than the bound, or more journal entries than the entry budget (1,000, two index ranges each, against Convex's 4,096-range limit). Answer: UNAVAILABLE `OVER_LIMIT`. The payable bound is tested.
5. A legacy PAID row with no `amountPaid` (read by `settlementView` as fully paid) whose payment predates the posting hook would show a difference that is a data fact. Answer: it is reported as a difference on that payable, not hidden; the ADR does not claim reconciliation for history the ledger never saw.

## Additional decisions from review

- A reversal entry copies the original's source and the original is patched to status `REVERSED` (`accounting/reversals.ts`). The reader therefore counts entries in status POSTED and REVERSED. Counting POSTED only would drop the original and keep the reversal, and a reversed payment would show a false difference. A test seeds that shape and asserts both sides net to zero.
- A queued or failed `JOURNAL_REVERSAL` outbox event makes the result UNAVAILABLE `PENDING_POSTINGS`. `AP_AFFECTING_EVENT_TYPES` classifies it as not AP-affecting, and unknown must not read as safe.
- With no 2400 control account, a supplier with a nonzero subledger paid amount is UNAVAILABLE `NO_CONTROL_ACCOUNT`. A supplier with nothing paid reconciles at zero.
- The outbox read is capped at 400 per status for the whole organization, not per supplier. Past the cap the result is UNAVAILABLE `OVER_LIMIT`, which is coarse but never wrong.
- A line count above 50 on one entry is UNAVAILABLE `OVER_LIMIT`; a supplier payment entry has a handful of lines.

## Not covered, stated

- The obligation (credit) side per supplier and the 1240 side: no supplier dimension on the ledger. Reconciliation of those stays organization-wide.
- Cutoff dates: the query reads the present state only. Post-cutoff logic stays in the organization-wide report.
- Not proven against a live Convex backend (convex-test only, no runtime read limits).
