# Report Source Matrix

Date: 2026-06-28

This matrix identifies what current reports read, what those sources mean, and what the target authoritative source should be.

| Report or UI | Current source | Tables read | Current semantic risk | Target source |
| --- | --- | --- | --- | --- |
| Accounting ledger tab | `api.transactions.list` through `components/accounting/GeneralLedgerTab.tsx` | `transactions` | `transactions` is a mutable single-line activity log, not a GL. UI totals are calculated on loaded rows only. | `journalEntries`, `journalLines`, and ledger projections. |
| Accounting summary totals | Client-side totals in accounting UI | Loaded `transactions` page | Paginated totals can understate totals. | Aggregated ledger projection by account/period. |
| Collections summary | `collections.summary` | `receivables`, `collectionPayments`, `postDatedCheques` | Uses capped reads and operational balances. | Receivable/payment projections rebuilt from allocation events. |
| Receivables list | `collections.listReceivables` | `receivables` | Outstanding amount is mutable state. | Receivable projection from invoices, credits, allocations, reversals. |
| Payments list | `collections.listPayments` | `collectionPayments` | Payment status is not tied to provider settlement or allocation history. | Payment ledger plus allocation and settlement projections. |
| Cheques list | `collections.listCheques` | `postDatedCheques` | Instrument state exists, but accounting state is incomplete. | Cheque instrument subledger with accounting event links. |
| Daily collection list | `collections.dailyCollectionList` | `collectionPayments` | `.take(500)` cap can silently omit payments; direction signs are presentation logic. | Daily cash/collections projection by branch, cashier, method, settlement state. |
| Upcoming cheques report | `collections.upcomingChequeReport` | `postDatedCheques` | Capped read; no bank deposit/settlement projection. | Cheque maturity projection with deposit/clearing/return state. |
| Aging report | `collections.agingReport` | `receivables` | Reads mutable outstanding balances; caps by status. | Customer aging projection from receivable documents and allocations. |
| Cashier reconciliations list | `collections.listReconciliations` | `cashierReconciliations` | No cash session or bank deposit model. | Cashier session and cash-over-short projection. |
| Sales and profit report | `reports.getSalesAndProfitReport` | `sales`, `vehicles`, `expenses` | Calculates operational margin directly; no ledger revenue/COGS/tax; status/delete filtering risk. | Sales margin projection tied to journal lines and inventory movements. |
| Inventory report | `reports.getInventoryReport` | `vehicles`, `expenses` | Inventory value is operational cost estimate, not GL inventory. | Inventory subledger and GL inventory account reconciliation. |
| Expenses report | `reports.getExpensesReport` | `expenses` | Expense rows can diverge from posted `transactions`; delete/status filtering risk. | Expense journal lines and AP/cash settlement projection. |
| Salesperson performance | `reports.getSalespersonPerformance` | `sales`, `vehicles`, `expenses`, users | Profit and commission are operational calculations, not accrual-backed. | Sales margin and commission accrual projections. |
| Lead conversion | `reports.getLeadConversionReport` | `leads` | Non-financial; uses broad scan cap. | CRM projection or indexed analytics table. |
| Profit and loss | `reports.getProfitAndLoss` | `transactions` | Treats single-line categories as revenue/expense; can count deposits or collections incorrectly. | Trial balance and P&L projection from journal lines mapped to account types. |
| Commission list | `sales.listCommissions` | `sales` | Paid marker and amount live on sale row; no payable/payment record. | Commission accrual and payable subledger. |
| Deposit visibility | `deposits.listByVehicle` and UI usage | `deposits` | Deposit state is not reconciled to liability account or payment settlement. | Customer deposit subledger and ledger account reconciliation. |
| Finance application status | `applications.list` and UI usage | `financeApplications`, documents | Status workflow is not tied to financed receivable or bank disbursement. | Finance application plus finance-company receivable/disbursement projection. |
| Admin data browser | `adminData` | Many tables | Can patch/hard delete data used by reports. | Read-only financial admin views with controlled correction workflows. |

## Report Design Rules For Remediation

- Official financial reports must read from journal-line projections, not operational workflow rows.
- Operational reports may read operational tables, but must clearly separate "workflow status" from "accounting posted amount".
- Every report must state whether it is as-of-date, period-based, cash-basis, accrual-basis, or operational.
- Reports must fail loudly or paginate/export when data exceeds a limit; they must not silently truncate financial totals.
- Projections must be rebuildable from immutable events and journal lines.
- Reconciliation reports must compare subledger balances to control accounts.

