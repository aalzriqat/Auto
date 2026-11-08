# AutoFlow

AutoFlow runs a car dealership. It sells vehicles for cash or through financing and keeps the dealership's books. It also tracks the money that customers, suppliers and staff owe and are owed. This glossary holds the business terms and the architecture vocabulary that code, tickets and reviews use. The architecture vocabulary follows the `codebase-design` skill. Decisions live in `docs/adr/`. Owner rulings in Jira take precedence over both.

## Domains

The nine business domains. The decision in `docs/adr/2026-11-08-domain-modules-and-golden-rules.md` plans one folder and one interface for each. A folder exists only once a step moves real code into it.

- **Deal**: quotes, finance applications, sales and handover.
- **Inventory**: vehicles and consignment intake.
- **Accounting**: the ledger, postings, periods and the accounting outbox.
- **Collections**: receipts, payments and cheques.
- **Suppliers**
- **Expenses**
- **Commissions and payroll**
- **Customers**
- **Organization and access**

## Deal

**Deal**:
The whole process of selling one or more vehicles to a customer, cash or financed, from agreement to settlement. Code and tickets sometimes call it the Unified Deal, a label users never see.
_Avoid_: Unified Deal (in user-facing text), order, transaction (for a deal)

**Sale**:
The completed result of a Deal for one vehicle. A deal with several vehicles has several sales but stays one deal.

**Cash deal**:
A deal in which the customer pays the dealership directly and nobody finances it.

**Financed deal**:
A deal paid for through financing. Either an outside finance company pays for the vehicle, or the dealership finances the customer itself on instalments.

**Finance application**:
The request that carries the financing of a deal, prepared by the dealership. It names only the finance part, never the whole deal.
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
The difference between the submitted quotation and the approved purchase amount, together with the agreement on who covers it. The customer, the dealership, the supplier or a split can cover it.
_Avoid_: gap, appraisal gap

**Delivery actions**:
The deal stage in which the documents the finance company requires are completed.
_Avoid_: delivery (as a synonym for handover)

**Handover**:
Handing the vehicle over to the customer.
_Avoid_: delivery

**Settlement**:
The deal stage that is complete when every money obligation on the deal is finished. The obligations are the customer's, the finance company's and the supplier's, and one that never existed counts as finished.
_Avoid_: settlement (for the supplier settlement route)

**Expected payment**:
The method and date on which the payment for a financed deal is expected. The dealership registers it after the vehicle handover.

**Disbursement**:
The payment an outside finance company makes for a financed deal, either to the dealership or directly to the supplier. The dealership confirms it after the deal is closed.

**Completion**:
The step that turns an agreed deal into completed sales. For a financed deal the UI calls it closing the deal.
_Avoid_: finalize (in user-facing text)

**Cancellation**:
Voiding a deal. Cancelling a completed sale makes the vehicle available for sale again.

**Unwind**:
Undoing a deal after the finance company has already paid.
_Avoid_: cancellation (for this case)

**Next action**:
The command the server says the current user can take next on a deal, whether it is enabled, and the first reason it is refused.
_Avoid_: next step (wizard label only)

**Deal number**:
The human-readable number a dealership gives each deal. It is unique within that dealership and never reused.

## Inventory

**Vehicle**:
A car the dealership offers for sale, whether it owns it or holds it on consignment.

**Stock vehicle**:
A vehicle the dealership owns.
_Avoid_: owned stock, inventory car

**Sourced vehicle**:
A vehicle held on consignment. The dealership sells it as the supplier's agent and does not own it, so its profit is never the sale price minus a cost.
_Avoid_: special order, drop-ship, consigned stock

**Cost basis**:
What a stock vehicle cost the dealership before the deal, made of the purchase price, landed costs and capitalized costs. A sourced vehicle has no cost basis, because the supplier entitlement takes its place.
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
What a supplier owes the dealership, such as its margin on a sale paid directly to the supplier or a vehicle cost the supplier bears. It is separate from a Receivable.

**Supplier settlement route**:
Where the money for a sourced vehicle goes. It goes either through the dealership, which then owes the supplier its entitlement, or directly to the supplier, who then owes the dealership its margin.

## Accounting

**Journal entry**:
A balanced record of debits and credits for one business event.

**Posting**:
Turning a business event into its journal entry, exactly once.

**Posting rule**:
The definition of which accounts a given kind of business event debits and credits.

**Reversal**:
A new journal entry that cancels an earlier one. It takes a date in an open period, so reversing an entry in a closed period uses a date in the current period.

**General ledger**:
The set of all posted journal entries, by account.
_Avoid_: cashbook, transactions (for journal entries)

**Chart of accounts**:
The dealership's list of accounts, each with a type such as asset, liability, revenue or expense.

**Accounting period**:
A span of dates that the books are kept in. A period is future, open, closing, closed or locked.

**Closed period**:
An accounting period that the dealership has closed. Its balances stay fixed unless the dealership reopens it.

**Locked period**:
An accounting period that has been locked. The normal reopen action refuses it, and only the break-glass process can reopen it.

**Snapshot**:
The stored running debit and credit totals of one account for one accounting period. They let reports avoid adding up every journal line.

**Opening balance**:
A starting balance entered when a dealership begins using AutoFlow.

**Opening suspense**:
The account that holds the difference when the entered opening balances do not balance, until it is cleared.

**Pending posting event**:
A business event that has not yet posted. AutoFlow holds it for retry or review.

## Collections

**Receipt**:
Money the dealership receives from a customer, a supplier or a finance company.
_Avoid_: payment (without a direction)

**Refund**:
Money paid back to a customer.

**Customer deposit**:
Money a customer pays to reserve a vehicle or as security. The dealership holds it as owed to the customer until it applies, refunds or forfeits it.
_Avoid_: deposit (alone)

**Bank deposit**:
Paying cash or a cheque into the dealership's bank account.

**Cheque**:
A cheque that the dealership receives from a customer or a finance company and tracks until it clears, returns, is replaced or is cancelled. A cheque the dealership issues to pay an expense is not this term.

**Receivable**:
An amount that a customer or a finance company owes the dealership. A supplier receivable is a separate term.

**Sale invoice**:
The invoice that records what the customer owes for a sale. A sale invoice is a receivable document.

## Expenses

**Expense**:
A business cost the dealership incurs.

**Payee**:
The garage or service provider the dealership pays an expense to.
_Avoid_: vendor (when the payee is meant)

**Cost bearer**:
Who ultimately bears an expense, either the dealership or the supplier of a sourced vehicle. The cost bearer is decided separately from the payee.

**Period expense**:
An expense the dealership charges to the period it falls in, instead of adding it to a vehicle's value.

## Commissions and payroll

**Commission**:
An employee's pay earned on a deal, for selling, buying or executing it.

**Commission mode**:
The dealership's setting for how sale commissions are decided. They are decided automatically by dealership tiers, automatically per member, or manually by a manager for each sale.

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
An amount as a whole number of the currency's smallest unit, together with its currency. For example, 1 Jordanian dinar is 1,000 fils.
_Avoid_: decimal amount

**Management net profit**:
A deal's headline profit after dealership-borne vehicle expenses and commissions. It is a management figure, not a posted one.
_Avoid_: net profit (in reports, where it may mean something else)

**Accounting margin**:
A deal's margin as the general ledger records it.

## Architecture vocabulary

Terms from the `codebase-design` skill. The ADR sets how to use them.

**Module**:
Anything with an interface and an implementation, at any scale: a function, a file or a whole domain.
_Avoid_: unit, component, service

**Interface**:
Everything a caller must know to use a module correctly, including its types, invariants, ordering, error modes and costs.
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
What callers gain from depth. They get more capability for less interface learned.

**Locality**:
What maintainers gain from depth. Changes, bugs and knowledge sit in one place.

**Domain**:
One of the nine business areas in the Domains section.

**Door**:
A public backend function whose path and contract the apps call.
_Avoid_: endpoint, handler

**Deletion test**:
Imagining a module deleted. If nothing is lost except a pass-through, the module was not worth having.
