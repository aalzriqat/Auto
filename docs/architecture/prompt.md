# Build AutoFlow into a Top-Tier Dealership Accounting System

Act as a principal enterprise accounting-software architect, senior Convex/TypeScript engineer, database architect, financial-controls specialist, security engineer, and test engineer.

Your mission is to transform AutoFlow’s current finance, collections, and accounting functionality into a production-grade, double-entry accounting platform suitable for real vehicle dealerships.

The system must preserve AutoFlow’s existing dealership workflows while introducing:

* Proper double-entry accounting
* Chart of accounts
* Accounting periods
* Immutable accounting events
* Balanced journal entries and journal lines
* Receivable and payment subledgers
* Many-to-many payment allocation
* Customer deposit liability accounting
* Finance-company receivables
* Inventory accounting and cost of goods sold
* Cashier sessions and reconciliation
* Full cheque lifecycle
* Refund and reversal workflows
* Strong idempotency
* Segregation of duties
* Ledger-backed financial reporting
* Subledger-to-general-ledger reconciliation
* Multi-organization and branch isolation
* Correct currency and JOD precision
* Rebuildable reporting projections
* Complete auditability

Do not treat this as a cosmetic refactor.

Do not attempt to make the current mutable `transactions` table behave like a general ledger.

Build a proper accounting foundation and migrate existing workflows behind it incrementally.

---

# Required source documents

Before changing production code, read and use these architecture documents:

```text
docs/architecture/finance-accounting-collections-audit.md
docs/architecture/accounting-event-matrix.md
docs/architecture/report-source-matrix.md
docs/architecture/remediation-roadmap.md
```

Treat them as the starting point, not unquestionable truth.

Verify each finding against the current repository before implementation because the code may have changed since the audit.

Where the documentation and current code disagree, document the difference and use current repository evidence.

---

# Primary objective

The final architecture must follow this model:

```text
Business command
→ Validated operational transaction
→ Immutable accounting event
→ Central posting engine
→ Balanced journal entry and journal lines
→ Operational subledger updates
→ Rebuildable projections
→ Financial reports and reconciliation
```

Every real financial event must have:

* One source business event
* One stable source identity
* One idempotency identity
* Zero or one canonical accounting event
* Zero or one balanced journal entry for that event version
* Complete links from source to journal
* Complete links from journal back to source
* A safe reversal path
* An immutable audit trail

No operational module may independently invent debit and credit logic outside the posting engine.

---

# Non-negotiable accounting principles

Implement and enforce all of the following.

## 1. Double-entry accounting

Every posted journal must satisfy:

```text
Total debits = Total credits
```

Journal validation must occur server-side before the journal is committed.

Journal header and journal lines must be created atomically.

Unbalanced journals must never be persisted.

## 2. Immutable posted history

Once an accounting event, journal entry, journal line, confirmed payment, cleared cheque, approved refund, or reconciled cashier session is posted:

* It must not be directly edited.
* It must not be hard deleted.
* Its accounting amounts must not be overwritten.
* Corrections must use reversal and replacement events.
* The original record must remain visible.

Preferred correction flow:

```text
Original event
→ Reversal event
→ Correct replacement event
```

## 3. One centralized posting engine

All financial modules must call one centralized accounting service.

No module may directly insert journal lines.

No module may directly insert into the legacy `transactions` table as an accounting side effect after migration.

The posting engine must control:

* Account mappings
* Debit and credit rules
* Accounting date
* Posting period
* Currency
* Currency scale
* Exchange rate
* Branch and dimensions
* Tax rules
* Approval requirements
* Idempotency
* Journal balancing
* Reversal behavior
* Event versioning

## 4. Operational subledgers remain separate

Do not collapse deposits, receivables, payments, allocations, cheques, cashier sessions, finance applications, inventory movements, commissions, and journals into one generic table.

Each entity has a distinct responsibility.

## 5. General ledger is the financial source of truth

Official financial statements must be based on posted journal lines.

This includes:

* Trial balance
* Profit and loss
* Balance sheet
* Cash and bank balances
* Account activity
* Control-account balances
* Period financial statements

Operational reports may use operational projections, but must reconcile to the general ledger where accounting impact exists.

## 6. No silent truncation

Financial reports must never silently use `.take(500)`, `.take(1000)`, `.take(10000)`, client-side loaded-page totals, or other incomplete reads as authoritative totals.

Use:

* Indexed aggregations
* Rebuildable projection tables
* Pagination with explicit totals
* Export/report jobs
* Period summaries

If a report cannot produce a complete result, fail clearly rather than returning an incomplete total.

## 7. Correct monetary precision

Do not use JavaScript floating-point values as the canonical representation of money.

Store canonical amounts using integer minor units.

Every amount must include or derive:

* Currency code
* Currency scale
* Minor-unit amount

Support at minimum:

* JOD with three decimal places
* Two-decimal currencies
* Zero-decimal currencies

Example:

```ts
type Money = {
  amountMinor: bigint | number;
  currency: string;
  scale: number;
};
```

Use the data type supported safely by the current stack. If Convex constraints prevent native bigint persistence, use validated integer values within safe limits or canonical decimal strings with strict arithmetic utilities.

Do not mix money representations without explicit conversion utilities.

---

# Phase-based implementation requirement

Implement the system in controlled phases.

At the beginning, create:

```text
docs/architecture/accounting-implementation-progress.md
```

Track:

* Current phase
* Completed work
* Files changed
* Migrations added
* Tests added
* Acceptance gates passed
* Remaining risks
* Decisions made
* Open policy questions
* Rollback information

Do not claim a phase is complete until its acceptance tests pass.

---

# Phase 0 — Immediate financial-safety controls

Complete this phase before implementing the new ledger.

## Required work

### Block destructive financial changes

Identify all financial tables and block normal hard deletion.

At minimum review:

* `transactions`
* `sales`
* `deposits`
* `receivables`
* `collectionPayments`
* `postDatedCheques`
* `cashierReconciliations`
* `expenses`
* `fixedAssets`
* `partnerEquity`
* `claims`
* Finance-company-related records
* Commission records
* Future journal and accounting-event records

Replace destructive deletion with:

* Reversal
* Cancellation event
* Tombstone
* Restricted break-glass process

Super-admin access must not bypass accounting integrity silently.

### Add command idempotency

Add transaction-safe idempotency protection to:

* Sale creation
* Sale finalization
* Deposit creation
* Collection payment recording
* Cheque clearing
* Refund execution
* Finance disbursement confirmation
* Payment-provider callbacks
* Commission payment
* Expense posting

Idempotency must be scoped by organization.

Avoid a non-atomic:

```text
Find existing
→ if none, insert
```

pattern if concurrent execution can still create duplicates.

### Unify sale completion

Normal cash sales, installment sales, and finance-application-finalized sales must route through one canonical sale-completion command.

Do not allow `financeApplications.finalizeDeal` or any equivalent path to bypass:

* Sales validation
* Deposit application
* Receivable generation
* Inventory state update
* Commission creation
* Accounting event generation
* Audit logging

### Enforce organization ownership

Before connecting any two records, validate that they belong to the same organization.

This applies to:

* Payment and receivable
* Sale and vehicle
* Sale and customer
* Deposit and quote
* Deposit and reservation
* Finance application and quote
* Finance company and application
* Journal and source event
* Cheque and receivable
* Refund and original payment
* Cashier session and payment
* Branch and organization

### Enforce approval separation

At minimum prevent configured self-approval for:

* Refunds
* Sale cancellations
* Receivable cancellations
* Installment reschedules
* Write-offs
* Cashier reconciliation
* Cash shortages
* Account-mapping changes
* Period reopening

Small dealerships may grant multiple permissions to one person, but the system must still record and expose that the same user performed multiple stages.

## Phase 0 acceptance gates

* Duplicate submissions do not create duplicate money records.
* Finance-finalized and manually created sales share one completion path.
* Financial hard deletion is blocked.
* Cross-organization financial links are rejected.
* Requester/approver separation works where configured.
* Existing tests continue to pass.
* New regression tests prove all controls.

---

# Phase 1 — Accounting foundation

Create the minimum accounting primitives.

## Chart of accounts

Add a proper `chartOfAccounts` model.

Suggested fields:

```ts
{
  organizationId,
  code,
  name,
  nameAr?,
  type,
  subtype?,
  normalBalance,
  parentAccountId?,
  isControlAccount,
  allowManualPosting,
  currencyRestriction?,
  active,
  systemKey?,
  createdAt,
  createdBy,
  updatedAt,
  updatedBy
}
```

Account types should support at minimum:

* Asset
* Liability
* Equity
* Revenue
* Cost of goods sold
* Expense
* Other income
* Other expense

Support hierarchical accounts.

System-required accounts should be identified by stable system keys, not account names.

Examples:

```text
CASH_ON_HAND
BANK_ACCOUNT
PAYMENT_CLEARING
ACCOUNTS_RECEIVABLE_CUSTOMERS
ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES
UNAPPLIED_CUSTOMER_CASH
CUSTOMER_DEPOSITS_LIABILITY
CHEQUES_IN_HAND
CHEQUES_UNDER_COLLECTION
VEHICLE_INVENTORY
SALES_REVENUE
COST_OF_VEHICLES_SOLD
SALES_TAX_PAYABLE
REFUNDS_PAYABLE
COMMISSION_EXPENSE
COMMISSION_PAYABLE
CASH_OVER_SHORT
RETAINED_EARNINGS
```

Do not hardcode one universal chart for every country.

Provide:

* Default AutoFlow dealership chart
* Organization-specific customization
* Stable system mappings
* Protection for required control accounts

## Accounting periods

Add `accountingPeriods`.

Support statuses:

```text
FUTURE
OPEN
CLOSING
CLOSED
LOCKED
```

Fields should include:

* Organization
* Start date
* End date
* Fiscal year
* Period number
* Status
* Closed by
* Closed at
* Reopened by
* Reopened at
* Reopen reason

Rules:

* Normal posting allowed only into OPEN periods.
* CLOSING may restrict normal operations.
* CLOSED blocks normal posting.
* LOCKED requires a highly restricted process.
* Reopening must be permission-controlled and audited.
* Reversing an old transaction must follow a documented closed-period policy.

## Accounting dimensions

Journal lines must support useful dealership dimensions:

* Organization
* Branch
* Vehicle
* Customer
* Vendor
* Finance company
* Salesperson
* Cashier
* Cost center, if configured
* Payment method
* Source document

Not every dimension is required on every journal line, but organization is mandatory.

## Phase 1 acceptance gates

* A chart of accounts can be initialized for a new organization.
* Required system accounts are mapped safely.
* Periods can be opened, closed, locked, and audited.
* Posting utilities reject closed periods.
* JOD three-decimal precision passes tests.
* Financial arithmetic does not use unsafe floating-point calculations.

---

# Phase 2 — Accounting-event registry and posting engine

## Accounting events

Add an immutable `accountingEvents` registry.

Suggested fields:

```ts
{
  organizationId,
  branchId?,
  eventType,
  sourceType,
  sourceId,
  eventVersion,
  idempotencyKey,
  occurredAt,
  accountingDate,
  currency,
  payload,
  payloadHash,
  status,
  createdBy,
  createdAt,
  reversedByEventId?,
  reversalOfEventId?,
  journalEntryId?
}
```

Enforce uniqueness using a stable equivalent of:

```text
organizationId
+ eventType
+ sourceType
+ sourceId
+ eventVersion
```

Also support provider-specific idempotency keys.

An accounting event must not be modified after posting except for narrowly controlled status/link fields that do not alter its original financial meaning.

## Journal entries

Add `journalEntries`.

Suggested fields:

```ts
{
  organizationId,
  branchId?,
  accountingEventId,
  journalNumber,
  accountingDate,
  periodId,
  sourceType,
  sourceId,
  category,
  memo,
  status,
  currency?,
  reversalOfJournalEntryId?,
  reversedByJournalEntryId?,
  postedBy,
  postedAt,
  createdAt
}
```

Statuses may include:

```text
DRAFT
VALIDATED
POSTED
REVERSED
```

System-generated journals should normally be created and posted atomically.

## Journal lines

Add `journalLines`.

Suggested fields:

```ts
{
  organizationId,
  journalEntryId,
  lineNumber,
  accountId,
  debitMinor,
  creditMinor,
  currency,
  scale,
  exchangeRate?,
  reportingDebitMinor?,
  reportingCreditMinor?,
  branchId?,
  vehicleId?,
  customerId?,
  financeCompanyId?,
  salespersonId?,
  cashierId?,
  description?
}
```

Rules:

* A line cannot contain both a debit and credit amount.
* A line cannot contain neither.
* Negative debit/credit values are prohibited.
* Total debits must equal total credits by journal currency and reporting currency where applicable.
* Journal line organization must match journal organization.
* Account organization must match journal organization.
* Journal lines become immutable once posted.

## Posting engine

Create a centralized server-side accounting service.

Suggested architecture:

```text
convex/accounting/
  events.ts
  postingEngine.ts
  postingRules.ts
  journals.ts
  periods.ts
  money.ts
  reversals.ts
  reconciliation.ts
  accountMappings.ts
```

Adapt to existing repository conventions where appropriate.

The engine should accept a typed command similar to:

```ts
postAccountingEvent({
  organizationId,
  branchId,
  eventType,
  sourceType,
  sourceId,
  eventVersion,
  accountingDate,
  occurredAt,
  currency,
  idempotencyKey,
  payload,
});
```

The engine must:

1. Validate authorization.
2. Validate organization and branch.
3. Validate source record.
4. Validate accounting period.
5. Validate idempotency.
6. Resolve versioned posting rules.
7. Resolve configured accounts.
8. Generate journal lines.
9. Validate money precision.
10. Validate dimensions.
11. Confirm total debit equals total credit.
12. Create accounting event, journal, and lines atomically.
13. Return the existing result safely on duplicate idempotency.
14. Create audit records.
15. Never directly depend on UI-provided account IDs for system events unless the event explicitly permits account selection.

## Versioned posting rules

Posting rules must be explicit and testable.

Do not scatter them across mutations.

A rule should define:

* Event type
* Required payload
* Debit account mapping
* Credit account mapping
* Dimensions
* Date policy
* Reversal behavior
* Optional tax behavior
* Posting-rule version

Past journals must retain the posting-rule version used at the time.

## Reversal engine

Create a canonical reversal service.

It must:

* Reject reversal of an already fully reversed event unless explicitly supported.
* Create a new accounting event.
* Create a linked journal with debits and credits inverted.
* Preserve the original event and journal.
* Record reversal reason.
* Record actor and approval.
* Handle closed periods using configured policy.
* Trigger subledger reversal behavior safely.
* Prevent silent source-record mutation.

## Phase 2 acceptance gates

* Every journal is balanced.
* Duplicate event submission produces one journal.
* Journal creation is atomic.
* Posted journals cannot be edited.
* Reversal creates a linked inverse journal.
* Source-to-journal and journal-to-source drill-down works.
* Posting into a closed period is rejected.
* Posting rules have full automated test coverage.

---

# Phase 3 — Receivables, payments, and allocations

## Receivable documents

Do not use a single mutable `outstandingAmount` as the only source of truth.

Create or evolve a receivable document model supporting:

* Customer receivable
* Finance-company receivable
* Invoice
* Installment
* Debit adjustment
* Credit adjustment
* Refund payable where appropriate
* Write-off
* Cancellation/reversal

Suggested fields:

```ts
{
  organizationId,
  branchId?,
  documentType,
  documentNumber,
  payerType,
  customerId?,
  financeCompanyId?,
  sourceType,
  sourceId,
  originalAmountMinor,
  currency,
  scale,
  issueDate,
  dueDate,
  status,
  accountingEventId?,
  reversedDocumentId?,
  createdAt,
  createdBy
}
```

Outstanding balances should be derived from:

```text
Original document amount
+ debit adjustments
− credit adjustments
− active payment allocations
− write-offs
+ reversed allocations
```

Cached balances may be used for performance only if:

* They are non-editable projections.
* They can be rebuilt.
* Reconciliation detects drift.

## Payments

Create a canonical payment model distinct from collections display rows.

Support:

* Incoming and outgoing direction
* Cash
* Bank transfer
* Card
* Payment link
* Cheque
* Internal transfer
* Other configured methods

Suggested states:

```text
DRAFT
PENDING_VERIFICATION
VERIFIED
PENDING_SETTLEMENT
SETTLED
FAILED
RETURNED
REVERSED
REFUNDED
VOIDED
```

Suggested fields:

```ts
{
  organizationId,
  branchId?,
  direction,
  payerType,
  customerId?,
  financeCompanyId?,
  method,
  amountMinor,
  currency,
  scale,
  receivedAt?,
  verifiedAt?,
  settledAt?,
  status,
  externalReference?,
  provider?,
  providerTransactionId?,
  idempotencyKey,
  cashierSessionId?,
  originalPaymentId?,
  reversalPaymentId?,
  accountingEventId?,
  createdBy,
  createdAt
}
```

## Payment allocations

Add a many-to-many `paymentAllocations` table.

Suggested fields:

```ts
{
  organizationId,
  paymentId,
  receivableDocumentId,
  amountMinor,
  currency,
  scale,
  allocationDate,
  status,
  reversalOfAllocationId?,
  reversedByAllocationId?,
  createdBy,
  createdAt
}
```

Required rules:

* Payment and receivable belong to the same organization.
* Currency must match unless explicit foreign-currency settlement logic exists.
* Allocated amount cannot exceed available payment amount.
* Allocated amount cannot exceed receivable outstanding amount.
* Allocations become immutable after posting.
* Allocation correction uses reversal.
* One payment can settle multiple receivables.
* One receivable can be settled by multiple payments.
* Unapplied payment balances are supported.

## Unapplied cash

If money is received before its purpose is known:

```text
Debit: Cash/Bank/Clearing
Credit: Unapplied Customer Cash
```

When allocated:

```text
Debit: Unapplied Customer Cash
Credit: Accounts Receivable
```

Do not force an incorrect receivable link merely to record the payment.

## Refunds

Refunds must be explicit outbound payments.

A refund workflow must identify:

* Original payment
* Original allocations
* Refund reason
* Refundable amount
* Approval
* Destination account
* Outbound payment
* Allocation reversal or customer-credit treatment
* Accounting event
* Journal
* Reconciliation state

Do not represent refunds only as negative incoming payments.

## Phase 3 acceptance gates

* Partial payments work.
* One payment can settle several receivables.
* Several payments can settle one receivable.
* Over-allocation is impossible.
* Unapplied cash works.
* Refunds reverse the appropriate allocations.
* Aging can be rebuilt from documents and allocations.
* Customer statements can trace every obligation, allocation, reversal, and refund.

---

# Phase 4 — Migrate dealership workflows

Migrate workflows one at a time.

For each migrated workflow:

1. Define commands.
2. Define accounting events.
3. Define posting rules.
4. Define reversal events.
5. Add idempotency.
6. Add authorization.
7. Add organization validation.
8. Add audit records.
9. Add tests.
10. Stop direct legacy `transactions` posting for that workflow.

## Customer deposits

Support:

* Deposit requested
* Deposit received
* Deposit applied
* Deposit refunded
* Deposit forfeited
* Deposit transferred to another deal, if allowed
* Deposit reversed

Recommended accounting:

### Deposit received

```text
Debit: Cash / Bank / Payment Clearing / Cheques in Hand
Credit: Customer Deposits Liability
```

### Deposit applied to sale

```text
Debit: Customer Deposits Liability
Credit: Accounts Receivable — Customers
```

Applying a deposit must not create a second cash receipt.

### Deposit refunded

```text
Debit: Customer Deposits Liability
Credit: Cash / Bank / Refund Clearing
```

### Deposit forfeited

```text
Debit: Customer Deposits Liability
Credit: Deposit Forfeiture Income
```

## Vehicle sales

All sale types must use one canonical completion service:

* Cash sale
* Bank-financed sale
* Internal installment sale
* Mixed payment sale
* Deposit-applied sale

A completed sale must handle:

* Customer invoice/receivable
* Revenue
* Tax where applicable
* Deposit application
* Customer immediate payment
* Finance-company receivable
* Inventory relief
* Cost of vehicle sold
* Commissions
* Vehicle status
* Sale status
* Audit
* Reversal path

Example accrual-style sale:

```text
Debit: Accounts Receivable — Customers
Debit: Accounts Receivable — Finance Companies
Credit: Vehicle Sales Revenue
Credit: Sales Tax Payable
```

Inventory relief:

```text
Debit: Cost of Vehicles Sold
Credit: Vehicle Inventory
```

Actual entries must be produced from configurable policies and account mappings.

## Sale cancellation

Cancellation after posting must:

* Require permission and approval.
* Create cancellation/reversal accounting event.
* Reverse revenue and tax where appropriate.
* Reverse inventory relief and COGS.
* Reverse deposit application where appropriate.
* Reverse receivables.
* Reverse or claw back commission.
* Restore vehicle status only if operationally valid.
* Preserve the original sale.
* Preserve all original journals.

## Finance-company receivables

Add a dedicated finance-company subledger.

Support:

* Finance application
* Approved amount
* Customer contribution
* Financed amount
* Expected disbursement
* Actual disbursement
* Fees deducted
* Shortfall
* Excess
* Rejected or cancelled finance
* Settlement
* Aging

The finance company must be modeled as the payer for its share.

Do not combine customer and finance-company balances into one ambiguous receivable.

Finance approval must not itself be treated as cash received.

## Internal installment sales

Support:

* Installment agreement
* Principal
* Finance charge where applicable
* Installment schedule
* Individual due dates
* Grace period
* Partial payments
* Rescheduling
* Late fees if configured
* Write-off
* Cancellation
* Customer statement
* Aging

Rescheduling must preserve old schedule history.

Do not overwrite due dates destructively.

## Cheques

Support complete lifecycle:

```text
HELD
DEPOSITED
CLEARED
RETURNED
REPLACED
CANCELLED
```

Also support return after clearance.

Track:

* Drawer
* Bank
* Cheque number
* Amount
* Currency
* Received date
* Due date
* Deposit date
* Clearance date
* Return date
* Return reason
* Bank fee
* Replacement cheque
* Related payment
* Related receivable
* Related accounting events

Cheque accounting policy must be organization-configurable.

Possible policy A:

* No GL posting until cheque clears.

Possible policy B:

```text
On receipt:
Debit: Cheques in Hand
Credit: Accounts Receivable

On deposit:
Debit: Cheques Under Collection
Credit: Cheques in Hand

On clear:
Debit: Bank
Credit: Cheques Under Collection
```

Returned-after-clear must support:

```text
Debit: Accounts Receivable
Debit: Bank Charges Expense
Credit: Bank
```

according to configured policy.

## Bank transfers

A bank transfer must not automatically become settled cash based only on employee entry.

Support:

```text
PENDING_VERIFICATION
VERIFIED
SETTLED
REJECTED
REVERSED
```

Track:

* Bank account
* Transfer reference
* Transfer date
* Proof document
* Verified by
* Verified at
* Bank reconciliation reference
* Duplicate reference detection

## Payment links

Support:

* Payment intent
* Provider
* External intent ID
* Requested amount
* Currency
* Expiry
* Customer
* Deal
* Provider callback
* Callback signature verification
* Provider event storage
* Idempotency
* Authorized/failed/captured/refunded/disputed status
* Settlement
* Provider fee
* Net settlement
* Reconciliation

Store provider webhook events before processing where practical.

Never trust browser return URLs as proof of payment.

## Cashier sessions

Create a full cashier-session model.

Support:

* Branch
* Cashier
* Opening float
* Opened at
* Payments collected
* Refunds paid
* Cash movements
* Expected cash
* Counted cash
* Variance
* Variance explanation
* Submitted by
* Approved by
* Closed at
* Bank deposit/bag reference
* Session status

Suggested lifecycle:

```text
OPEN
SUBMITTED
APPROVED
REJECTED
CLOSED
```

The cashier should not approve their own reconciliation when separation is configured.

Reconciliation must not create duplicate collection entries.

It verifies and settles existing activity.

## Expenses

Expense workflow must support:

* Draft
* Submitted
* Approved
* Posted
* Paid
* Reversed
* Cancelled

Do not post a pending expense automatically.

Once posted:

* Amount, date, account, and currency become immutable.
* Correction requires reversal/repost.
* Work-order expenses must use the same expense posting service.
* Expense payment and expense recognition should remain separable when accrual accounting is used.

## Inventory accounting

Create an inventory movement subledger.

Support:

* Vehicle acquisition
* Landed cost capitalization
* Preparation cost
* Direct repair capitalization
* Non-capital expense
* Cost adjustment
* Write-down
* Inter-branch transfer
* Sale relief
* Sale reversal
* Vehicle return
* Consignment vehicle exclusion

Inventory costing policy must be documented.

A vehicle’s cost after sale must not silently change historical COGS.

Post-sale adjustments require explicit accounting events.

Consignment vehicles must not be included in owned vehicle inventory.

## Commissions

Create commission accrual and payment records.

Support:

* Commission rule
* Accrual
* Approval
* Payable
* Payment
* Partial payment
* Clawback
* Sale cancellation reversal
* Split commission
* Broker commission

Typical posting:

```text
Commission earned:
Debit: Commission Expense
Credit: Commission Payable

Commission paid:
Debit: Commission Payable
Credit: Cash / Bank
```

## Fixed assets

Support:

* Asset acquisition
* Capitalization
* Useful life
* Depreciation method
* Depreciation schedule
* Accumulated depreciation
* Disposal
* Gain/loss
* Impairment
* Reversal

## Partner equity

Replace directly editable balances with events:

* Capital contribution
* Partner draw
* Profit allocation
* Loss allocation
* Adjustment
* Reversal

Partner balance must be derivable from immutable movements.

## Claims

Support claim receivable/payable lifecycle where applicable:

* Claim created
* Claim approved
* Claim rejected
* Claim settled
* Partial settlement
* Expense or receivable recognition
* Reversal

## Phase 4 acceptance gates

* No migrated module inserts directly into the legacy accounting table.
* Every migrated event has a posting rule.
* Every posted event has a reversal path.
* Sales, deposits, refunds, cheques, and finance-company settlements reconcile.
* Inventory and COGS reconcile by vehicle.
* Operational status changes cannot bypass accounting requirements.

---

# Phase 5 — Ledger-backed reporting

Replace pseudo-accounting reports with authoritative reports.

## Required accounting reports

Implement:

* Chart of accounts
* Account activity
* Journal register
* General ledger
* Trial balance
* Profit and loss
* Balance sheet
* Cash flow statement or cash-flow movement report
* Customer receivables aging
* Finance-company receivables aging
* Customer deposit liability report
* Cheques in hand and under collection
* Bank and cash balances
* Commission payable report
* Tax summary where configured
* Inventory account reconciliation
* Subledger-to-GL reconciliation
* Period close checklist

## Operational reports

Operational reports may continue to use operational projections:

* Daily collections
* Upcoming cheques
* Cashier performance
* Sales pipeline
* Finance application status
* Vehicle profitability
* Salesperson performance
* Reservation status

But they must:

* State their basis clearly.
* Exclude reversed/cancelled activity correctly.
* Distinguish collected, verified, settled, allocated, posted, and reconciled states.
* Reconcile to relevant GL control accounts where financial impact exists.

## Report date semantics

Every report must clearly define which date it uses:

* Transaction date
* Accounting date
* Due date
* Settlement date
* Clearance date
* Posting date
* Period date

Do not use one ambiguous `date` field everywhere.

## Historical reproducibility

A report for a closed historical period must remain reproducible after later activity.

Do not recalculate past financial reports from current mutable operational state.

## Required reconciliations

Implement reports proving:

```text
Customer receivables subledger
=
Accounts Receivable — Customers control account
```

```text
Finance-company receivables subledger
=
Accounts Receivable — Finance Companies control account
```

```text
Unapplied customer deposits
=
Customer Deposits Liability control account
```

```text
Uncleared cheque balances
=
Cheque control accounts
```

```text
Vehicle inventory subledger
=
Vehicle Inventory control account
```

```text
Commission payables subledger
=
Commission Payable control account
```

```text
Cashier expected cash
=
Cash account movements assigned to the session
```

Differences must appear as explicit reconciliation exceptions.

## Projection requirements

Reporting projections must:

* Be rebuildable from immutable events and journals.
* Include last rebuilt timestamp.
* Detect drift.
* Support organization and branch scoping.
* Avoid silent row caps.
* Be tested against source journals.
* Never become an independent editable source of financial truth.

## Phase 5 acceptance gates

* Trial balance balances.
* P&L is derived from account types and posted journal lines.
* Balance sheet balances.
* Aging reconciles to AR.
* Customer deposits reconcile to liability account.
* Inventory reconciles to inventory GL.
* Report totals remain complete at high record counts.
* Closed-period reports are reproducible.

---

# Phase 6 — Migration and backfill

Do not destroy existing financial history.

Use a widen-and-migrate strategy.

## Migration rules

1. Preserve all legacy records.
2. Add new structures beside legacy structures.
3. Make legacy financial tables read-only where possible.
4. Snapshot existing data before backfill.
5. Backfill only what can be reconstructed reliably.
6. Use approved opening-balance or migration-adjustment journals for uncertain history.
7. Record source legacy IDs on migration events.
8. Make migration idempotent.
9. Support dry-run.
10. Produce reconciliation output.
11. Support rollback before final cutover.
12. Do not rewrite historical records merely to make totals match.

## Historical classification

Classify legacy records into:

* Fully reconstructable
* Partially reconstructable
* Opening-balance only
* Requires manual finance review
* Invalid or duplicate candidate
* Cannot determine

## Duplicate detection

Create tooling to detect:

* Duplicate sale transactions
* Duplicate collection payments
* Duplicate deposits
* Duplicate webhook-like external references
* Sale paths with missing accounting rows
* Expenses whose transaction no longer matches
* Cancelled sales with unreversed transaction activity
* Receivables whose balances do not match payments
* Applied deposits counted as new sale cash
* Cheques posted both at receipt and clearance

Do not automatically delete suspected duplicates.

Produce reviewable remediation candidates.

## Parallel run

During transition:

* Keep legacy reports available and clearly labeled.
* Run new ledger reports in parallel.
* Compare by period, branch, account, customer, vehicle, payment method, and source module.
* Explain differences.
* Obtain explicit migration signoff before making the new ledger authoritative.

## Phase 6 acceptance gates

* Migration can run safely more than once.
* Opening balances are approved.
* Legacy-to-new differences are documented.
* No historical record is silently lost.
* New and legacy reports run in parallel.
* Cutover has a tested rollback plan.

---

# Phase 7 — Security, controls, and governance

## Permission model

Create granular permissions for:

* View accounting
* View account balances
* View sensitive cost/profit
* Create payment
* Verify transfer
* Clear cheque
* Return cheque
* Create refund
* Approve refund
* Execute refund
* Allocate payment
* Reverse payment
* Create journal
* Approve journal
* Post journal
* Reverse journal
* Close cashier session
* Approve cashier reconciliation
* Manage chart of accounts
* Open/close accounting period
* Reopen period
* Write off receivable
* Adjust vehicle cost
* Approve sale cancellation
* Run migration
* View audit records

## Segregation of duties

Support configurable incompatibility rules.

Examples:

* Payment creator should not verify the same payment.
* Refund requester should not approve the same refund.
* Refund approver should not execute the same refund where strict mode is enabled.
* Cashier should not approve their own reconciliation.
* Journal creator should not approve/post their own manual journal in strict mode.
* User changing bank details should not approve the related payout.
* User changing account mappings should not approve a posting using those changes immediately without audit.

## Audit log

Create an immutable financial audit trail recording:

* Organization
* Branch
* Actor
* Action
* Entity type
* Entity ID
* Previous value
* New value
* Reason
* Approval
* Timestamp
* Request/session metadata where available
* Related accounting event
* Related journal
* Related reversal
* Impersonation or super-admin state

Admin impersonation must be prominently visible in finance audit records.

## Manual journals

If manual journals are supported:

* Require specific permission.
* Require balanced lines.
* Require description and supporting reference.
* Require approval based on configuration.
* Require an open period.
* Prevent unauthorized use of control accounts.
* Preserve full audit history.
* Use reversal rather than editing after posting.

## Phase 7 acceptance gates

* Permission tests cover every sensitive command.
* Cross-organization access tests pass.
* Self-approval restrictions pass.
* Admin tools cannot bypass financial immutability.
* Financial audit log cannot be modified by ordinary application flows.
* Manual journals cannot bypass period, balance, or control-account rules.

---

# Testing requirements

Build a serious accounting test suite.

Use unit, integration, and end-to-end tests where appropriate.

## Posting invariants

Test:

* Every journal balances.
* Empty journals are rejected.
* Lines with both debit and credit are rejected.
* Negative debit/credit values are rejected.
* Cross-organization accounts are rejected.
* Closed-period posting is rejected.
* Duplicate accounting events post once.
* Reversal exactly offsets original journal.
* Reversing twice is rejected or follows explicit policy.

## Payment tests

Test:

* Duplicate payment submission.
* Duplicate provider callback.
* Partial allocation.
* Multi-receivable allocation.
* Multi-payment receivable.
* Over-allocation.
* Unapplied cash.
* Allocation reversal.
* Refund.
* Partial refund.
* Failed payment.
* Returned payment.
* Provider fee and net settlement.

## Deposit tests

Test:

* Deposit receipt creates liability, not revenue.
* Deposit application does not create new cash.
* Deposit refund clears liability.
* Deposit forfeiture creates configured income.
* Sale cancellation restores deposit treatment correctly.

## Sale tests

Test:

* Cash sale.
* Mixed-payment sale.
* Finance-company sale.
* Internal installment sale.
* Deposit-applied sale.
* Sale cancellation.
* Inventory relief.
* COGS.
* Tax.
* Commission accrual.
* Commission clawback.
* Duplicate completion.
* Finance-finalization path uses canonical completion.

## Cheque tests

Test:

* Cheque receipt.
* Future-dated cheque.
* Deposit.
* Clearance.
* Return before clearance.
* Return after clearance.
* Replacement.
* Bank fee.
* Receivable reopening.
* Duplicate clearing attempt.

## Expense tests

Test:

* Draft expense does not post.
* Approved expense posts once.
* Posted expense cannot be edited.
* Reversal/repost works.
* Work-order expense uses canonical path.

## Period tests

Test:

* Open period.
* Closing period policy.
* Closed period.
* Locked period.
* Reopening permission.
* Reversal when original period is closed.
* Historical report reproducibility.

## Precision tests

Test:

* JOD 0.001 precision.
* Two-decimal currency.
* Zero-decimal currency.
* Allocation rounding.
* Tax rounding.
* Installment rounding.
* Exchange-rate rounding.
* Large safe values.

## Reconciliation tests

Test:

* Customer AR equals control account.
* Finance-company AR equals control account.
* Deposits equal liability account.
* Inventory equals inventory account.
* Commissions equal payable account.
* Cheque subledger equals cheque control accounts.
* Trial balance balances.
* Balance sheet balances.

## Security tests

Test:

* Cross-organization source linking.
* Cross-organization journal linking.
* Cashier self-approval.
* Refund self-approval.
* Unauthorized account mapping.
* Unauthorized period reopening.
* Admin hard-delete attempt.
* Direct posted-record edit.
* Unauthorized manual journal.

---

# Performance requirements

The system must remain safe at scale.

Review and optimize:

* Indexes
* Organization filtering
* Branch filtering
* Period filtering
* Account/date queries
* Customer aging
* Finance-company aging
* Payment allocation queries
* Journal drill-down
* Projection rebuilds
* Reconciliation reports
* Export jobs
* Large webhook bursts
* Concurrent payment submissions

Do not optimize by sacrificing correctness.

Do not store independently editable totals merely for speed.

Use rebuildable projections and explicit reconciliation.

---

# User-interface requirements

Build clear accounting interfaces without exposing unnecessary complexity to sales users.

## Accounting workspace

Provide:

* Overview
* Chart of accounts
* Journal entries
* General ledger
* Trial balance
* Profit and loss
* Balance sheet
* Accounting periods
* Reconciliation
* Audit trail
* Manual journals, if enabled
* Account mappings
* Migration status during rollout

## Collections workspace

Keep operational collections accessible to relevant users:

* Receivables
* Payments
* Allocations
* Installments
* Cheques
* Refunds
* Cashier sessions
* Upcoming collections
* Aging
* Approvals
* Reconciliation status

Collections may be visible as a top-level workspace and summarized inside Accounting.

## Clear status language

Distinguish:

* Received
* Verified
* Settled
* Allocated
* Posted
* Reconciled
* Reversed
* Refunded
* Returned
* Cancelled

Do not label all of these simply as “Paid.”

## Drill-down

Users must be able to navigate:

```text
Journal
→ Accounting event
→ Payment/sale/deposit/expense
→ Customer/vehicle/deal
```

And:

```text
Payment/sale/deposit/expense
→ Accounting event
→ Journal entry
→ Journal lines
```

---

# Documentation requirements

Create and maintain:

```text
docs/accounting/architecture.md
docs/accounting/chart-of-accounts.md
docs/accounting/posting-rules.md
docs/accounting/money-and-rounding.md
docs/accounting/period-close.md
docs/accounting/payments-and-allocations.md
docs/accounting/deposits.md
docs/accounting/sales.md
docs/accounting/cheques.md
docs/accounting/refunds-and-reversals.md
docs/accounting/inventory-accounting.md
docs/accounting/reconciliation.md
docs/accounting/permissions-and-controls.md
docs/accounting/migration-runbook.md
docs/accounting/production-runbook.md
```

Document accounting intent, not only code structure.

Every posting rule must include:

* Business event
* Trigger
* Debit
* Credit
* Date policy
* Dimensions
* Reversal rule
* Idempotency rule
* Examples
* Tests

---

# Required implementation output after each phase

After every implementation phase, report:

1. Summary of what was implemented.
2. Files created.
3. Files modified.
4. Schema changes.
5. Migrations.
6. Posting rules added.
7. Tests added.
8. Commands run.
9. Test results.
10. Acceptance gates passed.
11. Acceptance gates not passed.
12. Known risks.
13. Backward-compatibility impact.
14. Rollback strategy.
15. Recommended next phase.

Do not mark incomplete work as complete.

---

# Final production-readiness gates

Do not classify AutoFlow as a top-tier accounting system until all of these are true:

* Double-entry journals exist.
* All posted journals balance.
* Journal creation is atomic.
* Posted journals are immutable.
* Corrections use reversals.
* Accounting periods are enforced.
* Money precision is currency-safe.
* JOD supports three decimal places.
* Idempotency is transaction-safe.
* Payment allocations are many-to-many.
* Customer balances are reconstructable.
* Finance-company balances are separate and reconstructable.
* Deposits are treated as liabilities until applied or forfeited.
* Cheques support full lifecycle, including return after clearance.
* Cashier sessions reconcile to cash accounts.
* Sale cancellation reverses all financial effects.
* Inventory and COGS are posted and reconciled.
* Commission accruals and payments are accounted for.
* Official reports use journal-backed projections.
* Trial balance balances.
* Balance sheet balances.
* P&L ties to the ledger.
* Subledgers reconcile to control accounts.
* Historical reports are reproducible.
* Cross-organization isolation is tested.
* Segregation-of-duties controls are tested.
* Financial hard deletion is blocked.
* Migration differences are reconciled.
* Production rollback and recovery procedures exist.
* Critical accounting tests pass.

---

# Execution instructions

Start by:

1. Reading the four existing audit documents.
2. Verifying findings against current code.
3. Inspecting current tests and schema.
4. Creating the implementation progress document.
5. Producing a dependency-aware implementation plan.
6. Implementing Phase 0.
7. Running all relevant tests.
8. Fixing Phase 0 regressions.
9. Implementing Phase 1 only after Phase 0 gates pass.
10. Continuing phase by phase with acceptance-gate verification.

Do not rewrite the entire application.

Do not build a disconnected parallel finance product.

Do not preserve unsafe behavior merely for backward compatibility.

Use adapters and feature flags where necessary.

Prefer:

```text
Widen
→ Dual write through one controlled service
→ Reconcile
→ Switch reads
→ Lock legacy writes
→ Retire legacy paths
```

over a destructive one-step migration.

Maintain usability for current dealership operations throughout the transition.

The final result must be a coherent dealership accounting platform—not a set of loosely connected finance features.
