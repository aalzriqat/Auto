# AutoFlow

AutoFlow runs a car dealership. It sells vehicles for cash or through financing and keeps the dealership's books. It also tracks the money that customers, suppliers and staff owe and are owed. This glossary holds the business terms and the architecture vocabulary that code, tickets and reviews use. The architecture vocabulary follows the `codebase-design` skill. Decisions live in `docs/adr/`. Owner rulings in Jira take precedence over both.

## Domains

The nine business domains. The decision in `docs/adr/2026-11-08-domain-modules-and-golden-rules.md` plans one folder and one interface for each. A folder exists only once a step moves real code into it.

- **Deal**: quotes, financing, sales and handover.
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
The completed result of a deal for one vehicle, made by the completion step, which the UI calls closing the deal for a financed deal. A deal with several vehicles has several sales.
_Avoid_: finalize (in user-facing text)

**Cash deal**:
A deal that no finance company pays for. The customer pays the dealership or, for a sourced vehicle sold on the direct route, the supplier.

**Financed deal**:
A deal in which an outside finance company pays for the vehicle. Lease and in-house instalment deals are retired.

**Quote**:
The offer made to a customer for a vehicle and payment method, from which a deal can be created.

**Submitted quotation**:
The amount the dealership asks the finance company to pay for the vehicle.
_Avoid_: quote (that is the customer offer)

**Appraisal**:
A valuation of the vehicle, from the finance company or an independent appraiser.

**Credit decision**:
The finance company's decision to approve or reject the financing, recorded on the deal.

**Approved purchase amount**:
The amount the finance company agrees to pay for the vehicle.

**Shortfall**:
The amount a financed deal comes up short against its quotation once the finance company has approved its price and terms. It is the net amount under the approved terms, not the gross price difference, except for a finance company without configured terms, where it is the gross difference. Who covers it (the customer, the dealership, a split, or the supplier of a sourced vehicle) is a separate agreement recorded on the deal.
_Avoid_: gap, appraisal gap

**Delivery actions**:
The deal stage in which the documents the finance company requires are completed.
_Avoid_: delivery (as a synonym for handover)

**Handover**:
Handing the vehicle over to the customer.
_Avoid_: delivery

**Settlement**:
The deal stage that is complete when every money obligation on the deal is finished. The obligations are the customer's, the finance company's and the supplier's, and one that never existed counts as finished.

**Expected payment**:
The method and date on which the payment for a deal is expected.

**Disbursement**:
The payment an outside finance company makes for a financed deal, either to the dealership or directly to the supplier.

**Cancellation**:
Voiding a deal. Cancelling a completed sale makes the vehicle available for sale again.

**Unwind**:
Undoing a deal after the finance company has already paid.
_Avoid_: cancellation (for this case)

**Next action**:
The command the server names as the current user's next move on a deal, with whether it is enabled and the first reason it is refused. The deal read model will carry it after migration step 5.
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
A vehicle the dealership sells as the supplier's agent without owning it. The dealership earns a margin over what the supplier is entitled to, and the vehicle has no cost basis.
_Avoid_: special order, drop-ship, consigned stock

**Cost basis**:
What a stock vehicle cost the dealership, including the reconditioning costs it capitalizes.
_Avoid_: cost price (for a sourced vehicle)

**Capitalized cost**:
A paid reconditioning cost on an unsold stock vehicle that the dealership adds to the vehicle's value instead of expensing.

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
_Avoid_: settlement (alone, because Settlement is a deal stage)

## Accounting

**Journal entry**:
A balanced record of debits and credits for one business event.

**Posting**:
Turning a business event into its journal entry, exactly once.

**Posting rule**:
The definition of which accounts a given kind of business event debits and credits.

**Reversal**:
A new journal entry that cancels an earlier one. It takes a date in a period that still accepts postings.

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
An accounting period that has been locked. AutoFlow cannot reopen it.

**Snapshot**:
The stored running debit and credit totals of one account in one currency for one accounting period.

**Opening balance**:
A starting balance entered when a dealership begins using AutoFlow.

**Opening suspense**:
The account that holds the difference when the entered opening balances do not balance, until it is cleared.

## Collections

**Receipt**:
Money the dealership receives from a customer, a supplier or a finance company.
_Avoid_: payment (without a direction)

**Refund**:
Money paid back to the customer or the finance company that paid it.

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
The invoice that records what the customer owes the dealership for a sale. A sale invoice is a receivable document.

## Expenses

**Expense**:
A cost that the dealership pays or owes to a payee. Who ultimately bears it is the cost bearer.

**Payee**:
The garage or service provider the dealership pays an expense to.
_Avoid_: vendor (when the payee is meant)

**Cost bearer**:
Who ultimately bears an expense, either the dealership or the supplier of a sourced vehicle. The cost bearer is decided separately from the payee.

## Commissions and payroll

**Commission**:
An employee's pay earned on a deal, for selling, buying or executing it.

**Commission mode**:
The dealership's setting for how sale commissions are decided. They are decided automatically by dealership tiers, automatically per member, or manually for each sale.

**Payroll**:
The monthly run that pays staff their salaries and unpaid commissions, less any outstanding salary advances.

**Salary advance**:
Money paid to an employee ahead of pay. Payroll deducts what is outstanding from later pay, unless the employee repays it directly or the dealership writes it off.

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

**Door**:
A public backend function whose path and contract the apps call.
_Avoid_: endpoint, handler, entry-point module

**Deletion test**:
Imagining a module deleted. If nothing is lost except a pass-through, the module was not worth having.
