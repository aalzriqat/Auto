# Financed vehicle sale — target workflow

Status: implementation in progress. Baseline `origin/main` @ `4f1c5578`.

The dealership does not sell the vehicle to the customer on a financed deal. The
**financing company buys the vehicle from the dealership**, then resells it to
the customer on installments. Every number below follows from that fact, and the
existing model does not represent it.

## The worked example the dealer confirmed

```
Vehicle purchase cost                     9,500
Dealer target selling amount             10,500
Customer available first payment            500
Submitted quotation                      12,500
Applied LTV                                 85%

Financing-company funded portion         10,625      12,500 × 85%
Unfinanced portion                        1,875      12,500 × 15%
  ├─ Customer first payment                 500
  └─ Dealer contribution                  1,375      1,875 − 500
                                        ───────
Approved purchase amount                 12,500
```

The dealer contribution is **1,375**, not 1,350. It is the residue of the
unfinanced slice after the customer's first payment, not a percentage of
anything.

### What links 10,500 to 12,500 is NOT confirmed

The dealership supplied the inputs and the 12,500 quotation, but not the
relationship between them. Structurally the deal nets 11,125 before expenses
(12,500 less the 1,375 contribution), which is 625 above the 10,500 target.

That 625 is an **unreconciled residual**, nothing more. It could be closing
expenses, negotiation headroom, a company commission, or simply what falls out
of a negotiated round number. The system reports it — see
`describeQuotationResidual` — and deliberately refuses to classify it.

**625 is not a default anywhere.** It appears only as a named example fixture in
tests. `computeSubmittedQuotation` takes expenses and buffer as explicit inputs
that default to zero, and quotes lower when nothing has been itemized rather
than inventing an allowance.

## The quotation solver is optional

Three modes are supported, and the dealership is never forced through the
calculator:

1. **SYSTEM_CALCULATED** — the solver's figure, sent as-is.
2. **MANUAL_ENTRY** — a negotiated figure. No solver involved, no reason needed.
3. **CALCULATED_WITH_OVERRIDE** — the solver ran and a person departed from it.
   Requires a reason.

The solver's inputs are separate on purpose: target net proceeds, itemized
estimated **dealer-borne expenses**, an optional **quotation buffer**, the
customer first payment, the applicable LTV, and the company's rounding rules.
Expenses are a cost; a buffer is headroom the dealership keeps. They behave
identically in the arithmetic and mean entirely different things, and merging
them is how a buffer silently becomes money the books believe was spent.

```
Suggested quotation =
  (target net proceeds
   + estimated dealer-borne expenses
   + optional quotation buffer
   − applicable customer contribution)
  ÷ LTV
```

This applies **only** when the selected company's rules confirm the customer
first payment offsets the unfinanced share
(`customerFirstPaymentOffsetsUnfinancedShare`). Unset or false, the solver
declines and the user enters the figure they negotiated. Mode, inputs, solver
result, rule version and override are all snapshotted onto the application.

## The concepts that must stay distinct

`quotes.totalFinancedAmount` is the customer's Murabaha principal
(`(vehiclePrice + desiredProfit) − downPayment + commission + adminFees`). It is
currently also read as the amount the finance company owes the dealer, the
expected bank receipt and the cheque face value. Those are four different
numbers. Splitting them is the point of this work.

| Concept | Meaning |
|---|---|
| `vehiclePurchaseCost` | what the dealer paid for the car |
| `targetSellingAmount` | the dealer's normal asking amount |
| `submittedQuotation` | what the dealer quoted the finance company |
| `dealerEstimate` | the dealer's own estimate, if recorded |
| `independentAppraisal` | what the appraiser valued it at |
| `approvedDealerPurchaseAmount` | what the finance company will actually buy at |
| `appliedLtvPercent` | the LTV rule actually applied |
| `financeCompanyFundedPortion` | approved × LTV |
| `customerContributionToFinanceCompany` | customer money that never touches the dealer |
| `dealerContribution` | dealer money completing the unfinanced slice |
| `expectedDealerRemittance` | what the finance company owes the dealer |
| `actualDealerReceiptTotal` | what actually arrived |
| `rawAppraisalGap` | submitted quotation − approved purchase amount |
| `customerGapShare` / `dealerGapShare` | negotiated split of the raw gap |

## Five orthogonal dimensions, not one status

`financeApplications.status` currently mixes all of these. The UI may derive one
friendly stage; internally they stay separate.

- **creditDecision** — DRAFT · SUBMITTED · UNDER_REVIEW · APPROVED · REJECTED · CANCELLED
- **appraisalStatus** — NOT_REQUESTED · PENDING · COMPLETED · REAPPRAISAL_REQUESTED · FINALIZED
- **gapResolution** — NOT_REQUIRED · PENDING_NEGOTIATION · CUSTOMER_ABSORBS · DEALER_ABSORBS · SPLIT · FAILED
- **settlementStatus** — NOT_READY · EXPECTED · PARTIALLY_SETTLED · FULLY_SETTLED · RECONCILED
- **handoverStatus** — BLOCKED · READY · HANDED_OVER

## The gap rule

The gap negotiated is the **raw** gap against the submitted quotation, not the
change in the funded portion.

```
Submitted quotation      12,500
Approved purchase        11,500
Raw appraisal gap         1,000      ← what is negotiated

Funded portion before    10,625      12,500 × 85%
Funded portion after      9,775      11,500 × 85%
Funding change              850      ← displayed, never negotiated
```

Invariant: `customerGapShare + dealerGapShare = rawAppraisalGap`.

### The allocation is never adjusted to flatten the outcome

A customer absorbing the whole 1,000 can leave the dealership **better off than
the original target** — 10,650 against 10,500 — because its own contribution
falls from 1,375 to 1,225 at the same time. That is an arithmetic consequence
of the confirmed rule, not a defect, and the shares must **not** be quietly
rebalanced to remove it.

Instead `computeGapOutcome` returns every component separately, and flags the
variance for a person to look at:

```
Raw appraisal gap                        1,000
Reduction in funded portion                850
Original dealer contribution             1,375
Recalculated dealer contribution         1,225
Customer gap payment to dealer           1,000
Dealer gap share                             0
Final projected dealer net proceeds     10,650
Variance from target net proceeds         +150   ← warned, never redistributed
Final projected profit                   1,150
```

The customer's share has a destination. Only the portion owed to the dealership
creates dealer-side AR:

```
customerGapCashToDealer + customerGapInstallmentToDealer + customerGapToFinanceCompany
  = customerGapShare
```

If the two sides cannot agree, the deal fails: no sale, no handover, the vehicle
returns to its pre-sale state.

## Appraisal basis

The approved dealer purchase amount is **stored explicitly**, never inferred
from the appraisal. Companies differ:

- equal to the appraisal (`APPRAISAL`)
- equal to the submitted quotation under a tolerance rule (`QUOTATION_EXCEPTION`)
- some other manually approved figure (`MANUAL`)

The exception is auditable: which rule version allowed it, the tolerance, who
approved, when.

## Appraisal fee responsibility

Driven by the **failure reason**, never by the status alone.

- `APPRAISAL_TOO_LOW` / `GAP_NEGOTIATION_FAILED` → dealer bears the fee
- `CUSTOMER_WITHDREW` → customer bears it (dealer may seek reimbursement)
- everything else → recorded explicitly, not defaulted

## Accounting shape at handover

```
DR Accounts Receivable — Financing Company    expectedDealerRemittance
DR Cash / Bank                                amounts already received directly
DR Accounts Receivable — Customer             only what the customer owes the DEALER
    CR Vehicle Sales Revenue                  final documented dealer price

DR Cost of Vehicles Sold
    CR Vehicle Inventory
```

A customer payment made to the **finance company** must not create dealer-side
customer AR. A dealer-absorbed amount is **not** automatically a sales discount —
its treatment is mapped per component and configurable.

## Employee closing-expense custody

```
advanceIssued + employeePersonalPayment
  = actualExpenses + employeeReturned + remainingEmployeeBalance
```

An advance that does not reconcile cannot be closed.

## Money

Integer minor units everywhere new. `convex/utils/money.ts` already scales JOD/
KWD/BHD/OMR at 3 and the rest at 2 — do not hardcode ×1000.

## Migration runbook

`backfillFinancingEconomics` is an `internalMutation` with no cron — it must be
run by hand, once per deployment, **immediately after the deploy**:

```bash
npx convex run --prod migrateFinancingEconomics:backfillFinancingEconomics '{}'
```

It self-schedules: companies first (so every one has a rule version to point
at), then applications, 50 rows a page. A direct call returns
`status: "SCHEDULED"` with more pages queued; only the final page reports
`"COMPLETE"`. Re-running is safe — applications are keyed on a dedicated
`financingBackfilledAt` marker that no live mutation writes, and companies on
their version row existing.

Until it runs, existing finance companies have no `financeCompanyRuleVersions`
row, so `applications.createFromQuote` leaves `companyRuleVersionId` undefined
on new applications. The inline `companyRuleSnapshot` still carries the terms,
so nothing is lost, but the audit link back to the immutable version is missing.

Afterwards, work the queue:

Read it through `financingEconomics.listNeedingReconciliation`, which is what
the index is for. Every flagged row needs its approved purchase amount, applied
LTV and actual receipt re-entered by someone who knows the deal; clearing the
flag goes through `resolveFinancingReconciliation`, which requires a note
saying what was checked. It is never cleared automatically.

## Merge gate: PR 1 is behaviorally dormant

`finalizeDeal` still opens the finance-company receivable from
`quote.totalFinancedAmount` — the customer's financing principal, which is not
what the company owes the dealership. **PR 2 replaces that posting.**

Until it does, PR 1 changes nothing on the money path:

- No posting rule, receivable or settlement behaviour is modified.
- Nothing raises a reconciliation flag on a **new** deal. Flagging every
  financed sale as knowingly wrong would make that a normal operating state,
  and a queue nobody can act on is worse than a defect nobody has been told
  about twice.
- The economics mutations are inert until a caller uses them, and no UI does
  until PR 3.
- The migration still flags **legacy** rows. That is diagnosis of state that
  already exists, not a new deal created wrong.

Consequently PR 1 must either merge together with PR 2's accounting
correction, or merge in this dormant state — never in between.

## PR breakdown

1. **Domain model and calculations** — shared pure calc module, rule versioning
   and snapshots, application-specific appraisal history, the economics fields,
   server-side invariants, classify-and-flag migration, tests.
2. **Gap resolution, settlement, accounting, employee advances** — gap outcomes,
   customer direct installments, settlement lines, expected vs actual remittance,
   postings, custody reconciliation, appraisal-fee responsibility, tests.
3. **UI, permissions, reporting, regression** — wizard economics panel, appraisal
   and negotiation UI, handover readiness, permission backfills, reports, E2E.
