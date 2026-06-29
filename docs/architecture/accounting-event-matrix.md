# Accounting Event Matrix

Date: 2026-06-28

This matrix traces major business events to current code behavior and the target accounting behavior required for a reliable finance system.

| Event | Current write path | Current accounting effect | Gap | Target accounting behavior |
| --- | --- | --- | --- | --- |
| Quote created | `convex/quotes.ts` | No posting | OK as non-accounting event, but linked IDs need full org validation | No journal; validate linked customer, vehicle, finance company, lead. |
| Vehicle reservation created | Reservation functions and `vehicleReservations` | No payment, deposit, receivable, or transaction | Reservation deposit amount can be disconnected from cash collection | Create reservation hold event; if money is received, post deposit receipt separately. |
| Deposit received by cash/card/transfer/link | `convex/deposits.ts` | Inserts `deposits`, `collectionPayments`, and IN `transactions` | No liability account, no idempotency, no provider/settlement state | Debit cash/bank/clearing, credit customer deposits liability; create payment and deposit subledger rows. |
| Deposit received by cheque | `convex/deposits.ts` | Posted immediately as collection payment and IN transaction | Inconsistent with cheque clearance model | Record cheque received; no cash posting until cleared unless accounting policy uses cheques-in-hand account. |
| Deposit applied to sale | `resolveDepositsForQuote`, `sales.create` | Marks deposit APPLIED; sale transaction subtracts deposit amount | No liability reclassification | Debit customer deposits liability, credit AR/customer invoice or sale settlement account. |
| Deposit refunded | `deposits.release` | OUT collection payment and OUT transaction | No reversal of deposit liability; no payment verification/settlement | Debit customer deposits liability, credit cash/bank/settlement; link to approval and payment. |
| Deposit forfeited | `deposits.release` | Status FORFEITED; no accounting posting found | Forfeiture revenue missing | Debit customer deposits liability, credit forfeited deposit income. |
| Cash sale created | `sales.create`, `createSaleTransaction` | One IN `transactions` row for sale amount less applied deposits | No AR/cash split, revenue, tax, COGS, inventory relief, or deposit liability reclass | Post balanced sale journal, inventory relief, COGS, tax, deposit application, and cash/AR settlement. |
| Bank-financed sale finalized | `applications.finalizeDeal` | Inserts sale, marks vehicle sold, applies deposits; no sale transaction | Critical posting bypass | Use same sale posting command as all sales; create customer invoice and finance-company receivable/disbursement workflow. |
| Sale status cancelled | `sales.update` | Restores vehicle AVAILABLE; no accounting reversal | Posted transaction remains | Post reversal entries; reopen/void related receivables; reverse inventory relief and commission accrual. |
| Sale amount/date updated | `sales.update` | Patches sale fields; no transaction update/reversal | Operational and pseudo-ledger values diverge | Lock posted sale fields; corrections use reversal and repost with audit reason. |
| Commission calculated | `sales.create` | Calculates commission amount on sale row | No commission accrual/payable | Debit commission expense, credit commission payable when earned. |
| Commission marked paid | `markCommissionPaid` | Patches sale paid metadata | No payment or payable clearing | Debit commission payable, credit cash/bank/payroll clearing. |
| Internal installment plan created | `createInstallmentPlan` | Inserts receivable rows | No invoice/journal, no schedule table | Create customer invoice/installment schedule; debit AR, credit revenue/tax/finance income as policy requires. |
| Payment recorded against receivable | `collections.recordPayment` | Inserts payment, reduces one receivable, inserts IN transaction | No allocation table, one receivable only, no settlement state | Create payment, allocate to one or many receivables, post debit cash/clearing and credit AR/unapplied cash. |
| Payment recorded without receivable | `collections.recordPayment` | Inserts payment and IN transaction | Unapplied cash not formally modeled | Post to unapplied cash/customer credit until allocated. |
| Payment voided | Not found as complete workflow | Collection payment has `VOIDED` status fields in schema | No full void/reversal command found | Reverse allocation and journal lines; retain original and void event. |
| Bank transfer received | `collections.recordPayment` | Posted immediately as IN transaction | No pending verification/bank reconciliation | Record pending transfer; post to cash only after verification or settlement. |
| Payment link created | Not found | Method enum only | No intent or provider lifecycle | Create payment intent with external id, status, expiry, amount, currency. |
| Payment link callback | Not found in `convex/http.ts` | No provider event handling | Duplicate/failed callbacks cannot be controlled | Verify signature, store provider event with idempotency key, update payment/settlement, post once. |
| Cheque received | `registerCheque` | Inserts HELD cheque | No accounting unless policy uses cheques-in-hand | Record instrument; optionally debit cheques-in-hand and credit AR depending on policy. |
| Cheque deposited | `depositCheque` | Patches status DEPOSITED | No accounting | Move from cheques-in-hand to cheques deposited/clearing if used. |
| Cheque cleared | `clearCheque` | Patches CLEARED, inserts payment, reduces receivable, inserts IN transaction | No settlement account, no return-after-clear | Debit bank/cash, credit AR or clearing; retain return reversal path. |
| Cheque returned before clearing | `returnCheque` | Patches RETURNED and may mark receivable OVERDUE | No bank fee, no accounting if cheques-in-hand used | Reverse cheque-in-hand/clearing entry; add return fee if applicable. |
| Cheque returned after clearing | Not supported | Cleared cheques cannot be returned | Returned bank item cannot reopen AR | Post debit AR and fees, credit bank; mark cheque returned after clear. |
| Cheque replaced | `replaceCheque` | Inserts new cheque and patches old REPLACED | No duplicate guard for replacement and no accounting | Link replacement instrument; no cash posting until cleared. |
| Receivable rescheduled | `respondToApproval` | Patches due date/status | Destroys schedule history | Create reschedule event with old/new terms; preserve original schedule and audit. |
| Receivable cancelled | `respondToApproval` | Sets outstanding to 0 and status CANCELLED | No credit memo/reversal | Post credit memo or reversal journal; allocations remain auditable. |
| Approved refund | `respondToApproval` | Inserts OUT payment, increases receivable balance, inserts OUT transaction | No reversal of original allocation/journal | Reverse allocation and post refund journal tied to original receipt. |
| Cashier reconciliation submitted | `submitCashierReconciliation` | Inserts reconciliation and patches selected cash payments | No session lifecycle or bank deposit | Close cashier session, count cash, post cash over/short and bank deposit when approved. |
| Cashier reconciliation approved | `reviewCashierReconciliation` | Patches status | No accounting or SOD enforcement | Enforce approver != cashier; post variance and lock session. |
| Expense created | `expenses.create` | Inserts expense and OUT transaction | Posts even if pending; no accounts | Post only when approved/postable; debit expense/asset/COGS, credit AP/cash. |
| Expense updated | `expenses.update` | Patches expense | Prior transaction not adjusted | Lock posted expense; reversal/repost required. |
| Expense removed | `expenses.remove` | Soft deletes expense | Prior transaction remains | Reverse posted expense and retain audit trail. |
| Work order completed | `workOrders.ts` | Inserts/updates expense directly | Bypasses expense posting | Route through expense/work-order posting command. |
| Fixed asset purchased | `fixedAssets.add` | Inserts asset row | No capitalization posting | Debit fixed asset, credit cash/AP; start depreciation schedule. |
| Depreciation run | Not found | No posting | Asset values do not depreciate | Debit depreciation expense, credit accumulated depreciation. |
| Fixed asset disposed | Not found | No posting | Gain/loss cannot be tracked | Remove asset cost/depreciation and post gain/loss. |
| Partner capital contribution | `partnerEquity.add/update` | Direct balance changes | No equity journal | Debit cash/asset, credit partner capital. |
| Partner draw | `transactions.add` can create category | Direct manual transaction possible | Not linked to partner equity reliably | Debit partner draw/equity, credit cash, update partner subledger. |
| Claim created | `claims.add` | Inserts claim row | No receivable/payable | Post claim receivable/payable if policy requires. |
| Claim paid | `claims.update` can set status | No payment posting found | Settlement missing | Debit cash/bank or expense, credit claim receivable/payable as applicable. |
| Manual transaction | `transactions.add` | Inserts IN/OUT pseudo-ledger row | Can bypass accounting model | Replace with controlled journal entry workflow and approvals. |
| Admin arbitrary edit | `adminData.adminUpdateRecord` | Patches financial rows | Bypasses domain controls | Prohibit financial table mutation except audited break-glass metadata edits. |
| Admin hard delete | `adminData.adminHardDelete` | Deletes financial rows | Destroys evidence | Disable hard delete for financial data; use immutable tombstones. |

