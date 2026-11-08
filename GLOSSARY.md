# AutoFlow

AutoFlow runs a car dealership: it sells vehicles for cash or through a finance company, keeps the dealership's books, and tracks the money owed to and by customers, suppliers and staff. This glossary holds the business terms and the architecture vocabulary that code, tickets and reviews use. The architecture vocabulary follows the `codebase-design` skill. Decisions live in `docs/adr/`. Owner rulings in Jira take precedence over both.

## Domains

The nine business domains. The decision in `docs/adr/2026-11-08-domain-modules-and-golden-rules.md` plans one folder and one interface for each. A folder exists only once a step moves real code into it.

- **Deal**: quotes, finance applications, sales and handover.
- **Inventory**: vehicles and consignment intake.
- **Accounting**: the ledger, postings, periods and the accounting outbox.
- **Collections**: receipts, refunds and cheques.
- **Suppliers**
- **Expenses**
- **Commissions and payroll**
- **Customers**
- **Organization and access**

## Deal

**Deal**:
The whole process of selling one or more vehicles to a customer, cash or financed, from agreement to settlement. Code and tickets sometimes call it the Unified Deal. That label is internal and users never see it.
_Avoid_: Unified Deal (in user-facing text), order, transaction (for a deal)

**Sale**:
The completed result of a Deal for one vehicle. A deal with several vehicles has several sales but stays one deal. A deal that has not completed is not yet a sale.

**Cash deal**:
A deal with no finance company. The customer pays the dealership directly.

**Financed deal**:
A deal in which a finance company buys the vehicle from the dealership and sells it to the customer on instalments.

**Finance application**:
The finance part of a financed deal: the request the dealership prepares and sends to the finance company. It names only that part, never the whole deal.
_Avoid_: application (alone, when the deal is meant), financing request

**Quote**:
The offer made to a customer for a vehicle and payment method, from which a deal can be created.

**Submitted quotation**:
The amount the dealership asks the finance company to pay for the vehicle.
_Avoid_: quote (that is the customer offer)

**Appraisal**:
A valuation of the vehicle, from the finance company or an independent appraiser. It is a deal stage between the credit decision and the approved purchase amount.

**Credit decision**:
The finance company's decision to approve or reject the finance application, recorded on the deal.

**Approved purchase amount**:
The amount the finance company agrees to pay for the vehicle.

**Shortfall**:
The difference between the submitted quotation and the approved purchase amount, and the agreement on who covers it (customer, dealership, supplier, or a split).
_Avoid_: gap, appraisal gap

**Delivery actions**:
The deal stage in which the documents the finance company requires are completed.
_Avoid_: delivery (as a synonym for handover)

**Handover**:
Handing the vehicle over to the customer.
_Avoid_: delivery

**Settlement**:
The deal stage in which the dealership registers the expected payment, the settlement route where one is required and the handover costs, and then closes the deal. The stage shows as complete only after the finance company pays. "Settlement" always means this stage. The money route for a sourced vehicle is the supplier settlement route.

**Expected payment**:
How and when the dealership expects the money for a deal to arrive, registered during settlement. For a financed deal it names the finance company as the payer.

**Disbursement**:
The finance company's payment to the dealership for a financed deal. The dealership confirms it after the vehicle is handed over and the deal is closed. It is the last deal stage.

**Completion**:
The step that turns an agreed deal into completed sales. For a financed deal the UI calls it closing the deal.
_Avoid_: finalize (in user-facing text)

**Cancellation**:
Voiding a deal. Cancelling a completed sale returns the vehicle to stock.

**Unwind**:
Undoing a deal after the finance company has already paid.
_Avoid_: cancellation (for this case)

**Next action**:
The command the server says the current user can take next on a deal, whether it is enabled, and the first reason it is refused.
_Avoid_: next step (wizard label only)

**Deal number**:
The human-readable number a dealership gives each deal, unique within that dealership and never reused.

## Inventory

**Vehicle**:
A car the dealership offers for sale, whether it owns it or holds it on consignment.

**Stock vehicle**:
A vehicle the dealership owns.
_Avoid_: owned stock, inventory car

**Sourced vehicle**:
A vehicle held on consignment: the dealership sells it as the supplier's agent and does not own it. Its profit is never the sale price minus a cost.
_Avoid_: special order, drop-ship, consigned stock

**Cost basis**:
What a stock vehicle cost the dealership before the deal: purchase price, landed costs and capitalized costs. A sourced vehicle has no cost basis of its own. The supplier entitlement takes its place.
_Avoid_: cost price (for a sourced vehicle)

**Capitalized cost**:
A paid reconditioning cost on a stock vehicle that the dealership adds to the vehicle's value instead of expensing in the period.

## Suppliers

**Supplier**:
A party in the dealership's supplier registry. It includes vehicle suppliers, consignors and the service providers that expenses are paid to.

**Supplier entitlement**:
What the supplier of a sourced vehicle is owed from its sale, less any concession the supplier agreed.

**Supplier payable**:
What the dealership owes a supplier.

**Supplier receivable**:
What a supplier owes the dealership.

**Supplier settlement route**:
Where the buyer's money for a sourced vehicle goes: through the dealership, which then owes the supplier its entitlement, or directly to the supplier, who then owes the dealership its margin.

## Accounting

**Journal entry**:
A balanced record of debits and credits for one business event.

**Posting**:
Turning a business event into its journal entry, exactly once.

**Posting rule**:
The definition of which accounts a given kind of business event debits and credits.

**Reversal**:
A new journal entry that cancels an earlier one. A reversal takes a date in an open period, so a reversal of an entry in a closed period takes a date in the current period.

**General ledger**:
The set of all posted journal entries, by account.
_Avoid_: cashbook, transactions (for journal entries)

**Chart of accounts**:
The dealership's list of accounts, each with a type such as asset, liability, revenue or expense.

**Accounting period**:
A span of dates that the books are kept in. The dealership opens each period, then closes it, and finally locks it.

**Closed period**:
An accounting period that the dealership has closed. Its balances stay fixed unless the dealership reopens the period. While the period is closed, the dealership dates corrections in a later period.

**Locked period**:
An accounting period that the dealership has locked. Nobody can reopen it.

**Snapshot**:
The stored running totals of each account for a period. AutoFlow reads a closed period's balances from its snapshots, except for older periods that have no snapshot certificate. Those periods read from journal lines.

**Opening balance**:
A starting balance entered when a dealership begins using AutoFlow.

**Opening suspense**:
The account that holds the difference when the entered opening balances do not balance, until it is cleared.

**Pending posting event**:
A business event that has not yet posted. AutoFlow holds it for retry or review.

## Collections

**Receipt**:
Money received from a customer, a supplier or a finance company.
_Avoid_: payment (without a direction)

**Refund**:
Money paid back to a customer.

**Customer deposit**:
Money a customer pays to reserve a vehicle or as security, which the dealership holds as owed to the customer until it applies, refunds or forfeits it.
_Avoid_: deposit (alone)

**Bank deposit**:
Paying cash or a cheque into the dealership's bank account.

**Cheque**:
A post-dated cheque that a customer or a finance company draws to the dealership, tracked until it clears, returns or is replaced.

**Receivable**:
An amount that a customer or a finance company owes the dealership.

**Sale invoice**:
The invoice that records what the customer owes for a sale. A sale invoice is a receivable document.

## Expenses

**Expense**:
A business cost the dealership incurs.

**Payee**:
The garage or service provider the dealership pays an expense to.
_Avoid_: vendor (when the payee is meant)

**Cost bearer**:
Who ultimately bears an expense: the dealership, or the supplier of a sourced vehicle. It is never the payee.

**Period expense**:
An expense the dealership charges to the period it falls in, instead of adding it to a vehicle's value.

## Commissions and payroll

**Commission**:
An employee's pay earned on a deal, for selling, buying or executing it.

**Commission mode**:
The dealership's setting for how sale commissions are decided: automatically by dealership tiers, automatically per member, or manually by a manager for each sale.

**Payroll**:
The monthly payment of salaries, commissions and salary advances to staff.

**Salary advance**:
Part of an employee's salary paid before payday and recovered from later pay.

## Customers

**Customer**:
A person or company that buys from the dealership.

**Lead**:
A prospective customer who has not bought yet.
_Avoid_: customer (before a deal)

## Organization and access

**Dealership**:
One business using AutoFlow, with its own data, staff and books.
_Avoid_: organization (except in admin and engineering text), showroom (as a separate concept)

**Tenant**:
A dealership seen as the owner of its own data, separate from every other dealership's.

**Role**:
A named set of permissions given to staff, such as owner, manager, sales, reception, accountant and senior accountant. Dealerships may add their own.

**Permission**:
The right to perform one action on one kind of record, such as viewing vehicle cost prices.

## Money

**Minor units**:
An amount as a whole number of the currency's smallest unit, together with its currency (for example 1 Jordanian dinar is 1,000 fils).
_Avoid_: decimal amount

**Management net profit**:
A deal's headline profit after dealership-borne vehicle expenses and commissions. It is a management figure, not a posted one.
_Avoid_: net profit (in reports, where it may mean something else)

**Accounting margin**:
A deal's margin as the general ledger records it.

## Architecture vocabulary

Use these terms exactly. Do not substitute "component", "service" or "API". Do not call a seam a "boundary".

**Module**:
Anything with an interface and an implementation, at any scale: a function, a file or a whole domain.
_Avoid_: unit, component, service

**Interface**:
Everything a caller must know to use a module correctly: its types, invariants, ordering, error modes and costs.
_Avoid_: API, signature

**Implementation**:
What is inside a module.

**Depth**:
How much behaviour a caller gets per unit of interface it has to learn. A deep module hides a lot behind a small interface. A shallow module does not.

**Seam**:
The place where a module's interface lives, where behaviour can change without editing in that place.
_Avoid_: boundary (for a module seam)

**Adapter**:
A concrete thing that fills an interface at a seam. A seam with one adapter is hypothetical. A seam with two adapters is real.

**Leverage**:
What callers gain from depth: more capability for less interface learned.

**Locality**:
What maintainers gain from depth: changes, bugs and knowledge sit in one place.

**Domain**:
One of the nine business areas listed in the Domains section. The decision plans one folder and one interface for each.

**Door**:
A public backend function whose path and contract the apps call. The decision sets what a door may do.
_Avoid_: endpoint, handler

**Deletion test**:
Before keeping a module, imagine deleting it: if nothing is lost except a pass-through, it should not exist.
