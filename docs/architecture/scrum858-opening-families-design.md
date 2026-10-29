# SCRUM-858 — Native opening balances for the Bloom Cars new showroom (design)

Status: DESIGN ONLY. No code, test, schema or migration is changed by this document.
Base: `origin/main` 315bcd831. Branch `claude/scrum858-opening-design`.
Binding ruling: owner, 2026-10-29 (recorded on SCRUM-858). Cutoff date: 18/10/2026.
Scope boundary: SCRUM-760 narrow pilot (one dealer, CASH and FINANCED to delivery). Nothing here opens a
refund, payout or correction door, and `convex/utils/customerCreditPayoutContainment.ts` is not touched.
Out of scope (separate lane `claude/scrum858-closure-readers`): reconciliation readers for advances,
supplier recoverables and partner capital; the opening-journal reversal attack test; prepaid rounding.
Supplier-keyed families wait for SCRUM-868 (canonical `supplierId`); this document only fixes the hook point.

Real dealer figures are private. This document contains none and asks for none. Every test below uses
synthetic fixtures.

## 0. Evidence labels and sources not checked

Labels: VERIFIED (read in this tree at 315bcd831), INSPECTED (read, not executed), UNAVAILABLE (not
checked; stated so).

No test, install or build was run (machine thermal cap). Everything about behaviour is therefore INSPECTED,
never VERIFIED-by-execution.

Standards (owner rule 2026-10-17). The attempt to fetch IAS/IFRS text from iasplus returned stubs, so the
following are UNAVAILABLE as fetched sources and are cited from recall only; an accountant must confirm
them before they are relied on:

- IAS 1 (presentation: current/non-current liabilities, offsetting rules, IAS 1.32-35 and 1.69).
- IAS 32 (a refundable deposit is a financial liability; an obligation to deliver cash is not equity).
- IFRS 15 (customer deposits that are not yet earned are contract liabilities; IFRS 15.105-109).
- IAS 2 (inventory at the lower of cost and net realisable value; consigned stock is not the holder's inventory).
- IAS 8 (an opening-balance difference is not silently adjusted into equity; it is an error or an unexplained difference to be disclosed).
- Cutover practice: a conversion balance is the trial balance at the cutoff supported by a subledger listing
  that agrees to each control account; differences are reported, never plugged. This is general
  implementation practice (ERP data-migration guidance), not a quoted standard.
- Subledger-to-control reconciliation: the control account balance must equal the sum of its subledger
  at the same date, for every control account that has a subledger.

None of this overrides the owner ruling. The design leans on the standards only where the ruling is silent
(for example presenting a net-debit partner as a debit, not a negative credit).

## 1. Invariant (one sentence)

Every opening balance Bloom Cars brings across at 18/10/2026 exists exactly once as a native operational
record that a certified route can later move, its sum equals the GL control line posted in the single
OPENING_BALANCE journal, and any difference that nobody has explained stays reported and unposted.

Supporting invariants (each is testable):

- OB-1 Exactly-once. One opening journal per org; each native record carries `openingSource {draftId,rowKey}`
  and is produced by one row; replaying a row never produces a second record or a second GL line.
- OB-2 Control equals subledger. For each family: GL control balance at 18/10/2026 equals the sum of its native
  records, read the way the consumer reads it (snapshots for closed periods, ACC-2).
- OB-3 Native, not decorative. A subsequent movement (collect, pay, apply, amortise) goes through the same
  certified route as a post-cutoff record and reduces the same native record and the same control account.
- OB-4 No premature obligation. No record with a date after 18/10/2026 is created by the opening, and no future
  instalment, accrual or schedule beyond what is already due/held at the cutoff.
- OB-5 No history duplicated. The opening records do not create historical sales, receipts, expenses or payments.
  They carry opening provenance and are excluded from period activity for dates before the cutoff.
- OB-6 No plug. The posting engine never creates a balancing line. The reported difference is the label
  "Unexplained opening-balance reconciliation difference / فرق أرصدة افتتاحية غير مفسر قيد المطابقة".
  It never touches partner capital, retained earnings or any other account.
- OB-7 Refusal before write. Missing identity, mismatched total, duplicate row key, cross-org id, wrong currency,
  or a date other than the cutoff refuse before the first insert (ACC-5 at the mutation boundary, TEN-1).
- OB-8 Approval gate. Posting actual dealer figures needs recorded accountant approval; the code path is
  exercised only with synthetic data until then.

## 2. Impact map (condensed, 13 areas)

| Area | Answer |
|---|---|
| Writers | `accountingCutover.draftOpeningBalance` and `postOpeningBalanceDraft` -> `openingAllocations.prepareOpeningAllocations` / `materializeOpeningAllocations` (INSPECTED). `vehicles.importBulk` OPENING_STOCK for stock. Partner `add`. Bank identity via `assertOpeningBankIdentities`. |
| Readers | `accountingReports.computeCustomerDepositsReconciliation`, `readOpeningUnallocatedLiabilities`, `sourcingPayables.markPaid/recordPartialPayment`, `openingBalanceStatus`, `postedOpeningAllocationReadback`, `compareLegacyToGL`, `partnerEquity.list`, `bankAccounts.getBookBalance`. |
| Historical data | Prod data is the pilot; the org opens fresh. `assertNoExistingOpeningSources` already refuses an opening on top of legacy receivables, advances, supplier rows or prepaid schedules. |
| State transitions | Draft -> approved -> posted; late opening refused after any POSTED/REVERSED journal. Per-family native transitions are the existing ones (deposit HELD->APPLIED, payable open->paid, etc.). |
| Reversal | ACC-3: the new native record kinds add un-happen paths (void deposit, refund, release, delete vehicle, convert ownership). Each is enumerated per family below and either refused for opening-origin rows or proven. The reversal attack test of the opening journal itself is the closure-readers lane. |
| Idempotency | Row key `rowKey` + `draftId` is the identity of every opening record; the post is one transaction; approve repeats `prepare` read-only. |
| Authorization | Existing finance permissions on cutover; no new permission. Accountant approval is a recorded sign-off (`signOffCutover`), not a role. |
| Tenant isolation | `requireOwnedRow` on every caller-supplied id (customer, vehicle, bank account, partner, account). |
| Ledger impact | One balanced OPENING_BALANCE journal; the only offset is the explicit opening lines the operator listed. |
| Audit trail | Draft keeps allocations and `allocationResults`; every native record carries `openingBalanceDraftId`. |
| UI consistency | OpeningAllocationEditor families and native screens must read the same record; EN/AR strings per family. |
| E2E flow | Case H (section 9). |
| Release/runtime | Compile-time containment switches unchanged; a new pilot-block for refunding an opening-origin deposit is server-side. |

## 3. Cross-family design rules

1. Reuse the existing framework (draft -> prepare -> materialize -> single journal). Do not build a second
   opening mechanism (owner rule: prefer proven native patterns over parallel infrastructure).
2. One new allocation `kind` per family that needs a native record; a family that is correctly ledger-only
   (retained earnings, cash) stays LEDGER_ONLY and gets a subledger-equivalent proof instead.
3. The control account for a family is resolved by system key through `requireOpeningSettlementBasis`
   (postingEngine.ts) and never named by the operator, so a row cannot post to a different account than the
   native record's consumers read.
4. Every row refuses before write on: missing/foreign identity, non-positive or non-integer minor amount,
   duplicate `rowKey`, per-key total mismatch with the control line, wrong currency, and a draft date that is
   not the cutoff.
5. Reset / closed period: the opening requires an open accounting period containing the cutoff and the org's
   reset generation to match; a financial reset invalidates opening evidence (the existing
   `orgResetState` check) and a closed period is read from snapshots (ACC-2). No family writes into a closed
   period after the opening is posted.
6. The 100-row ceilings already in the code (`take(101)`) are treated as a design input, not a convenience:
   each family states its own bound, and a bound is a refusal with a message, never a silent truncation.

## 4. Family B — refundable security deposits and held reservation deposits

### 4.1 Current state (INSPECTED)
- `CUSTOMER_DEPOSITS_LIABILITY` opens as `UNALLOCATED_LIABILITY` with purpose CUSTOMER_DEPOSIT. It materialises
  no native record; it is only a pool read back by `readOpeningUnallocatedLiabilities` into the deposits
  reconciliation.
- The native `deposits` row is bound to a quote/vehicle/commitment, and `recordHeldDeposit` posts cash GL and
  payment rows. It cannot be reused as is for money already received before the cutoff.
- Application goes through `recordDepositApplication` (stored identity) invoked by `saleCompletion`
  treatments. Release/refund is `deposits.release` -> `releaseHeldDeposit`.

### 4.2 Invariants
- B-1 A deposit liability opened at 18/10/2026 is named: customer, amount, kind (VEHICLE_RESERVATION or
  SECURITY) and, for a vehicle reservation, the VIN it holds.
- B-2 Sum of opening-origin deposits not yet applied or released equals the CUSTOMER_DEPOSITS_LIABILITY control
  balance contributed by the opening.
- B-3 It can be APPLIED against a later sale by the existing `recordDepositApplication` route, exactly once.
- B-4 It cannot be refunded or forfeited: release/refund of an opening-origin deposit is refused server-side
  while the pilot containment holds (refund switches stay as they are).
- B-5 No cash movement and no GL line is created when the record is materialised (the cash is already in the
  bank/cash opening lines), so there is no duplicate receipt.

### 4.3 Two candidates
Candidate 1 — opening-origin `deposits` rows. Add `origin: "OPENING"`, `openingBalanceDraftId`, `openingRowKey`
to the existing deposits table (optional fields, so existing rows are untouched). Materialisation inserts a
HELD deposit with the customer, optional vehicle, `amountMinor`, `paymentMethod` omitted, and no
transaction/payment/voucher rows. The application route and the quote-keyed resolver read it unchanged.

Candidate 2 — a new `openingDepositCredits` table consumed by a new application path.

Pick Candidate 1. Reasons: the application route, the commitment claim model and the reconciliation already
read `deposits`; a second table forces every reader (`resolveDepositsForQuote`, `outstandingDepositMinor`,
vehicle-hold logic) to learn a second shape, and that is exactly the "parallel infrastructure" the owner rule
warns against and the source of ACC-6 errors. The cost of Candidate 1 is that every writer of `deposits` must
now treat `origin: OPENING` specially. That cost is bounded and enumerable (section 4.6), and fields are
optional so the schema change is additive and reversible by simply not setting them.

One-way-door check: the optional fields are additive; removal later is possible only if no opening row exists,
which is the correct property for an audit marker.

### 4.4 Native record, control, reconciliation
- New allocation kind `CUSTOMER_DEPOSIT` (customerId, amountMinor, depositKind, optional vehicleId, rowKey).
- Control: `CUSTOMER_DEPOSITS_LIABILITY` (credit). `openingFamilySystemKey` maps the kind to it, replacing the
  UNALLOCATED purpose route for new drafts.
- Reconciliation: `computeCustomerDepositsReconciliation` already compares the control to deposits; extend its
  source set to include opening-origin rows and keep the unnamed pool as a legacy-only bucket that must be zero
  for any draft that uses the new kind.
- Exact-once proof for the consuming route: `depositApplications` stored identity keyed by deposit id; the
  proof test applies an opening deposit twice and asserts one application, one liability reduction.

### 4.5 Refusals before write
Missing customer; customer in another org (TEN-1); vehicle in another org or SOURCED where the deposit is a
reservation (the vehicle must be a car the dealer can hold, assertAcquirable semantics); duplicate row key;
duplicate (customer, vehicle) reservation; amount not a positive safe integer; sum of rows != control credit;
cutoff date mismatch; a draft that also carries an unnamed CUSTOMER_DEPOSIT pool row.

### 4.6 Writers that must learn `origin: OPENING` (ACC-3 enumeration; confirm with `graft callers` at implementation)
`deposits.release`/`releaseHeldDeposit` (refuse), `deposits.voidDeposit` (refuse for opening-origin; a void
would reverse a receipt that never existed), `allocateToVehicles` / `releaseVehicleAllocation` (allow re-hold
for reservation kind only through the existing commitment checks), `recordHeldDeposit` (never creates opening
rows), `saleCompletion` treatments (read as ordinary HELD deposit), reconciliation readers.

### 4.7 What the operator sees on a refund request
The release/refund control for an opening-origin deposit is disabled in the UI with the text "This opening
deposit cannot be refunded in the pilot. Apply it to the customer's sale." / "لا يمكن استرداد هذا العربون
الافتتاحي في المرحلة التجريبية. يُطبَّق على صفقة العميل." and the backend returns the same refusal with a stable
code. The UI disabling is a convenience; the block is the server-side refusal in `deposits.release` and
`releaseHeldDeposit` (SCRUM-760 evidence: excluded mutation is blocked server-side). The containment switches
in `customerCreditPayoutContainment.ts` are not edited.

### 4.8 Reset / closed period
Opening-origin deposits are invalidated by a financial reset like any opening evidence (reset generation check).
Applying one after the cutoff posts in the current open period only.

### 4.9 UI touch points (EN/AR)
OpeningAllocationEditor: new "Customer deposits (named)" family with customer picker, kind, vehicle (VIN)
picker, amount; summary line and error strings in both locales. Deposits screen: an "Opening" badge and the
disabled refund text above. RTL: amount and VIN fields stay LTR inside RTL layout (existing pattern; confirm
in the rendered check).

### 4.10 Failing-first tests
1. Opening a named deposit materialises one HELD deposit, no cash/payment/transaction/voucher rows, no extra
   GL line beyond the opening journal.
2. Applying it twice yields one application (stored identity).
3. `deposits.release` and `voidDeposit` on an opening-origin row throw the pilot refusal; with the switch
   constants unchanged (assert the constants).
4. Customer from another org, duplicate row key, sum mismatch each refuse before any insert (count tables
   unchanged).
5. Reconciliation: control equals sum of opening rows; an unnamed pool row on the same draft is refused.

### 4.11 SCRUM-486 matrix rows (proposed ids)
OB-B1 named deposit create, OB-B2 apply once, OB-B3 apply retry, OB-B4 refund refused (server), OB-B5 void
refused, OB-B6 tenant, OB-B7 reconciliation, OB-B8 reset.

### 4.12 Cloud rehearsal case
OB-H-B: open one named reservation deposit, create a sale for that customer and vehicle, complete it, assert
the deposit is APPLIED and the liability is zero; assert the refund door refuses.

## 5. Family C — owned vehicle inventory per VIN at cost

### 5.1 Current state (INSPECTED)
Mostly implemented: `vehicles.importBulk` OPENING_STOCK writes `commandIdempotency` evidence (sourceType
"STOCK"); `prepareOpeningInventoryControls` costs owned cars only (`costedOwnedCars` excludes SOURCED);
`assertOpeningVehicleBasis` binds sale/edit to the posted allocation and the basis date.

### 5.2 Gaps found
- G-C1: `prepareOpeningInventoryControls` reads up to 101 vehicles over ALL the org's vehicles and throws above
  100. SOURCED and sold vehicles count towards the cap, so a showroom with 60 owned and 45 consignment cars
  cannot open at all. The cap must apply to owned costed rows, not to the whole table.
- G-C2: SOURCED vehicles are inserted by `importBulk` without opening evidence. The refusal "a SOURCED vehicle
  is never recognised as owned inventory" is enforced by exclusion in the costing set but I did not find a
  mutation-boundary refusal that rejects a draft allocation row that names a SOURCED VIN (INSPECTED; absence
  claim limited to the files read: openingAllocations.ts, openingVehicleBasis.ts, vehicles.ts importBulk).
  A hand-built VEHICLE_INVENTORY row naming a SOURCED vehicle must be refused at `validateOpeningInventoryRow`.
- G-C3: a post-opening change of `sourceType` (STOCK -> SOURCED or the reverse) would change what the
  inventory control means. `assertOpeningVehicleBasis` refuses `sourceType !== "STOCK"` at sale/edit time but
  the flip itself (ownership conversion / vehicle edit) needs its own refusal for vehicles with opening basis.
  UNAVAILABLE: `vehicleOwnershipConversions` and the vehicle edit mutation were not read.

### 5.3 Invariants
- C-1 Inventory control (debit) equals the sum of cost over owned STOCK vehicles with opening evidence, each
  with one allocation row and one `VEHICLE_INVENTORY` result.
- C-2 A SOURCED vehicle never has opening evidence, an allocation row, an `openingBalanceDraftId`, or a share
  of the inventory control (ACC-1).
- C-3 Cost per VIN is the amount in evidence; it agrees with `vehicles.purchasePrice` in the org currency.
- C-4 Selling an opening vehicle uses the opening cost as COGS basis, once, and only on or after the cutoff.

### 5.4 Candidates (no new one-way door)
Candidate 1 (chosen): keep the current design and fix the three gaps. Candidate 2: replace the import-evidence
binding with an allocation-only binding (drop `commandIdempotency` evidence). Rejected: the command rows are
what survive a financial reset and a vehicle-marker removal; removing them weakens proof, and the existing
design is a reviewed one.

### 5.5 Refusals and proofs
- `validateOpeningInventoryRow` refuses a SOURCED vehicle, a vehicle without STOCK import evidence, a vehicle
  already carrying `openingBalanceDraftId` from another draft, a cost not equal to evidence, a duplicate VIN
  or vehicle id, a cross-org vehicle, a deleted vehicle.
- Cap: replace the "101 vehicles over everything" read with an indexed read of owned STOCK vehicles with
  evidence, bounded at 100 with an explicit refusal; SOURCED and sold rows are not read for the cap.
- A guard in the ownership-conversion and vehicle-edit mutations refuses changing `sourceType` on a vehicle
  with opening basis (post-flip proof test).

### 5.6 Reset / closed period
Evidence from before a reset is refused ("predates a financial reset"); an opening vehicle sold before the
cutoff date is refused (already in `assertOpeningVehicleBasis`).

### 5.7 UI touch points
OpeningAllocationEditor inventory family lists owned vehicles only, shows VIN and cost, and a note "Consignment
vehicles are not inventory / السيارات الموردة بالأمانة ليست مخزونًا" with the SOURCED list shown read-only.
Inventory screen: vehicle shows an "Opening cost" badge.

### 5.8 Failing-first tests
1. 60 owned + 45 SOURCED vehicles: opening succeeds (currently throws: failing first).
2. Draft naming a SOURCED VIN refuses before write.
3. `sourceType` flip on an opening vehicle refuses.
4. Control equals the sum of per-VIN cost; a single-VIN cost edit afterwards is refused (existing check,
   regression row).
5. Sell an opening vehicle after the cutoff: COGS equals opening cost; before the cutoff refuses.

### 5.9 Matrix rows
OB-C1 per-VIN create, OB-C2 SOURCED refused, OB-C3 cap, OB-C4 flip refused, OB-C5 sale COGS basis, OB-C6 tenant,
OB-C7 reset.

### 5.10 Cloud rehearsal case
OB-H-C: open one owned car, sell it after the cutoff, assert inventory control falls by the opening cost and
COGS equals it; attempt to open a SOURCED VIN and assert refusal.

## 6. Family D — vendor liabilities, accrued expenses, salaries / payroll payable (where applicable)

### 6.1 Current state (INSPECTED)
- `SUPPLIER_PAYABLE` and `OTHER_PAYABLE` openings materialise `vehicleSupplierPayables` with origin OPENING and
  settle through `sourcingPayables.markPaid` / `recordPartialPayment` with `openingPayableBasis` and the
  `openingPayablePayments` ledger (exact-once). This is mature.
- `OTHER_PAYABLE` maps to no system key, so it is custom accounts only (cannot target the salaries account).
- `SALARIES_PAYABLE`, `EMPLOYEE_REIMBURSEMENTS_PAYABLE`, `PARTNER_DRAWINGS` are UNSUPPORTED in
  `openingAccountPolicy`.
- `expenses` carry a vendor string and PENDING/PAID; the supplier identity is not canonical (SCRUM-868).
- Opening commissions have a payslip-level pattern (`openingCommissionLiabilities`,
  `assertOpeningCommissionPosting`) settled through payroll.

### 6.2 Invariants
- D-1 Each vendor liability and accrued expense is a native payable with a counterparty label and an amount;
  the sum equals the payable control (or the custom accrued account) contribution of the opening.
- D-2 Payment goes through the existing payable payment route; partial payment and full payment reduce the same
  native record; overpayment is refused; a retry produces one payment.
- D-3 A salary payable, if it exists at the cutoff, is per employee and per period, settled through payroll,
  never as a lump on a generic account; no new payout door.
- D-4 No accrual beyond the cutoff (OB-4).

### 6.3 Two candidates
Candidate 1 (pilot default): vendor liabilities and accrued expenses open as `OTHER_PAYABLE` (and
`SUPPLIER_PAYABLE` only after SCRUM-868) on a named custom opening account; salaries payable stays
UNSUPPORTED and refuses with a clear message unless the accountant says salaries are owed at the cutoff.
Candidate 2: add a payslip-level `SALARY_PAYABLE` opening kind modelled on opening commissions: one native row
per employee and pay period, control `SALARIES_PAYABLE`, settled by `payroll` payment with an
`openingSalaryPayments` ledger.

Pick Candidate 1 for the pilot, with Candidate 2 as a gated slice. Reasons: the pilot needs only what Bloom
actually owes at the cutoff, which is unknown until the accountant answers question Q3; Candidate 2 touches the
payroll run and payslip model (money formula, one-way door) and should not be built speculatively. If Q3 says
salaries are owed, Candidate 2 is the only one that satisfies "settled through certified payroll routes", and
Candidate 1 is then insufficient (a generic payable cannot be paid by payroll).

### 6.4 Native record, control, reconciliation
Candidate 1: `vehicleSupplierPayables` origin OPENING with openingKind OTHER_PAYABLE; the control line is the
operator-chosen custom account (system-key-free). Reconciliation: Σ open opening payables on that account ==
account balance contribution; the closure-readers lane owns the generic reader, this lane supplies the
per-family test.
Hook for SCRUM-868: the payable row gains `supplierId` (optional now, required once SCRUM-868 lands); the
allocation `SUPPLIER_PAYABLE` accepts `supplierId` and refuses a free-text vendor for that kind. Until
SCRUM-868, vendor liabilities use OTHER_PAYABLE with a label only. Do not guess a supplier match.

### 6.5 Refusals before write
Unlabelled counterparty; a custom account that is a system control account (would bypass the control family);
duplicate (counterparty, reference); amount not positive; salary row when the kind is unsupported (explicit
message, not a silent drop); payable dated after the cutoff; cross-org account.

### 6.6 Reset / closed period
Payments after the opening post into the current open period; the opening payable's settlement reads the
opening basis only for the opening amount. A reset invalidates the opening payable basis (existing check).

### 6.7 UI touch points
OpeningAllocationEditor "Vendor liabilities / accrued expenses" family: label, reference, amount, account.
Payables screen shows "Opening" origin and the remaining balance. A "Salaries payable" row shows the refusal
text "Salaries owed at the cutoff must be entered per employee in payroll opening / الرواتب المستحقة يجب إدخالها
لكل موظف" only when Candidate 2 is not built.

### 6.8 Failing-first tests
1. Open an OTHER_PAYABLE, pay part, pay the rest, retry the last payment: remaining zero, one payment each.
2. Overpay refused; payment on another org's payable refused.
3. Salary row refuses today (regression), and under Candidate 2: opens per employee, payroll settles it
   once, partial settlement reduces the same row.
4. A free-text vendor on SUPPLIER_PAYABLE refuses (hook) once SCRUM-868 is in.

### 6.9 Matrix rows
OB-D1 payable create, OB-D2 partial pay, OB-D3 full pay, OB-D4 retry, OB-D5 overpay refused, OB-D6 tenant,
OB-D7 salary (gated), OB-D8 reset.

### 6.10 Cloud rehearsal case
OB-H-D: open one accrued expense payable, pay half through the payable route, assert remaining and the bank
control; and, if Candidate 2 is built, one payslip settlement.

## 7. Family E — retained earnings, prior distributions, partner balances

### 7.1 Current state (INSPECTED)
- `RETAINED_EARNINGS` opens LEDGER_ONLY (a credit line, no native record).
- Partner capital: `validateOpeningPartners` and `openingPartnerBasis` require every partner row to have
  `amountMinor > 0`, credit-only lines, and the sum equal to the control credit. The partner's
  `openingBalanceMinor` is then the base for `Σ transactions` (CONTRIBUTION +, DRAW -, PROFIT_DISTRIBUTION +,
  in `derivePartnerBalanceMinor`).
- `PARTNER_DRAWINGS` is UNSUPPORTED. A net-debit partner is not representable.

### 7.2 Invariants
- E-1 Retained earnings opens as one explicit credit (or debit if accumulated losses) line owned by the
  accountant's statement, never computed by the system from the other lines.
- E-2 Each partner's opening balance is signed: a credit (capital) or a debit (net drawings exceeding capital),
  and the partner list sums to the partner capital control line.
- E-3 Prior profit distributions and prior drawings are not recreated as transactions; they are already inside
  the opening balances. No payout, draw or distribution record is created by the opening.
- E-4 An unexplained difference is reported and never absorbed by a partner or by retained earnings (OB-6).

### 7.3 Two candidates
Candidate 1: signed partner basis. Allow `amountMinor` to be negative for a partner in the partner opening
allocation and let `openingPartnerBasis` accept a signed total; the control posts a debit line for a net-debit
partner (partner current account in debit) and credits for the others. Minimal new surface, but it changes the
meaning of "positive-only" that several readers rely on (`openingPartnerBasis` INVALID on amount <= 0;
`derivePartnerBalanceMinor` presents `balanceMinor` as an equity credit). Every reader of
`partnerEquity.balance` then has to render a negative as a debit.

Candidate 2: an opening-only partner drawings form. A separate allocation kind `PARTNER_OPENING_DRAWINGS`
(partnerId, amountMinor > 0, debit to the partner current/drawings account) posts a debit, and the partner's
net opening is `capitalCredit - drawingsDebit`, shown as two lines so it is explainable. No new
`partnerEquityTransactions` DRAW row is created, no payout is possible, and `PARTNER_DRAWINGS` stays out of the
payout paths.

Pick Candidate 2. Reasons: (a) positive-only amounts remain the invariant every reader depends on, so the
change is additive; (b) the accountant sees capital and prior drawings as two statements, matching how partner
accounts are kept (capital, current account) and IAS 1 presentation of equity components by nature from recall;
(c) it makes "net debit" a derived display, not a stored negative that a reader may drop; (d) it can never be a
new payout door because it only materialises a ledger-backed opening row with no cash. The cost is one more
allocation kind and a derived-balance rule; the ruling asked whether an opening-only drawings form is required:
it is, if any partner's drawings exceed capital at the cutoff, because the existing form cannot express that.
If no partner is net-debit at the cutoff, Candidate 2 is unnecessary and E reduces to labelling (see Q4).

### 7.4 Partner reporting
`partnerEquity.list` shows per partner: opening capital (credit), opening prior drawings (debit, if any),
movements since the cutoff, and the derived net. A negative net is presented as "Partner owes the business /
الشريك مدين للمنشأة". The reported difference line is separate and never merged into a partner row.

### 7.5 Retained earnings and prior distributions
Retained earnings stays LEDGER_ONLY, but gets a subledger-equivalent proof: a signed statement row set that
sums to the control line (prior-year profit, prior distributions as a negative component, if the accountant
provides them), stored on the draft as read-only explanation. If the accountant cannot explain a component, it
stays in the reported difference (OB-6), not in retained earnings or partner capital.

### 7.6 Refusals before write
Partner missing / deleted / cross-org / duplicated; amount not a positive safe integer; drawings for a partner
without a capital row is allowed only if the net is represented as a debit (explicit); partner totals not
equal to control; a draft that tries to post an equity line to absorb a difference (refuse any line whose
purpose is `PLUG`/unlabelled equity); PARTNER_DRAWINGS used outside the opening kind.

### 7.7 Reset / closed period
`openingPartnerBasis` already invalidates partner basis after reset or any header ambiguity; the same checks
apply to the drawings kind. Movements dated before the cutoff are INVALID (existing check).

### 7.8 UI touch points
Partner opening editor: capital and prior drawings columns, computed net, and the unexplained-difference
panel. Labels EN/AR including the fixed unexplained-difference string. Partner screen: net debit shown with the
"owes the business" label.

### 7.9 Failing-first tests
1. Partner with drawings greater than capital opens as debit; `partnerEquity.list` shows the correct net and
   status VERIFIED.
2. No `partnerEquityTransactions` rows and no payout/draw event are created by the opening.
3. An attempt to post a balancing equity line is refused; the difference appears only in the report.
4. Partner list sum != control refuses before write; duplicate partner refuses.
5. A later DRAW or CONTRIBUTION moves the net from the opening base exactly once (retry safe).

### 7.10 Matrix rows
OB-E1 capital create, OB-E2 drawings create, OB-E3 net-debit read, OB-E4 no plug, OB-E5 no payout row,
OB-E6 later movement, OB-E7 tenant, OB-E8 reset.

### 7.11 Cloud rehearsal case
OB-H-E: open two partners, one net-debit; record a later CONTRIBUTION through the certified partner route and
assert the derived balance; assert the opening created no DRAW/PROFIT_DISTRIBUTION row.

## 8. Family G — cash and per-bank-account openings reconciling to the bank control

### 8.1 Current state (INSPECTED, PR state UNAVAILABLE)
Bank identity is enforced at the opening (`assertOpeningBankIdentities`: each `BANK_ACCOUNT` line names a
same-org physical bank). `bankAccounts.getBookBalance` derives the balance from the control line aggregate
by `bankAccountId`, never from `openingBalanceMinor` (metadata). `CASH_ON_HAND` is LEDGER_ONLY. Whether PRs
#611-613 are still open was not checked; this design assumes the merged SCRUM-54 ledger (#614, #602) only and
does not depend on the open ones.

### 8.2 Invariants
- G-1 Σ per-bank opening lines == the BANK_ACCOUNT control opening debit; each bank shows its own opening in
  `getBookBalance` with status OK.
- G-2 Cash on hand opens as one explicit line per cash location if the org tracks drawers; otherwise one line.
- G-3 `bankAccounts.openingBalanceMinor` metadata is never added to the GL balance (existing rule) and the
  opening screen shows a mismatch between that metadata and the posted line as a warning, not a post.
- G-4 A bank statement difference stays a reported difference (OB-6).

### 8.3 Candidates
This family has no schema one-way door. Candidate 1 (chosen): keep the identity-on-line design and add a
reconciliation read: opening lines by bank vs `getBookBalance` at the cutoff. Candidate 2: create a native
`bankOpeningBalances` table. Rejected: the GL line already is the record; a second record would be the parallel
infrastructure the rule warns against and a new thing to keep equal.

### 8.4 Refusals
Missing/foreign/deleted bank on a line; currency mismatch; two lines for the same bank in one draft; a bank
account in another org; a cash line without an account in the cash control.

### 8.5 Subsequent movement
A bank receipt/payment through certified routes moves the same bank's `getBookBalance`; a failed aggregate
backfill withholds the balance (existing `BALANCE_HISTORY_INCOMPLETE`), which is a correct refusal rather than
a wrong number.

### 8.6 Reset / closed period
The bank aggregate readiness check requires the reset generation to be complete; a closed period balance is
read from snapshots (ACC-2). Cutover rehearsals on a disposable backend must run the bank aggregate backfill
before reading.

### 8.7 UI touch points
Opening screen bank section with one row per physical bank; banks screen shows the book balance and any
mismatch warning (EN/AR).

### 8.8 Failing-first tests
1. Two banks open with distinct amounts; each `getBookBalance` equals its line; total equals control.
2. Missing bank identity refuses before write (regression of existing).
3. Metadata `openingBalanceMinor` differing from the posted line shows the warning and does not change the
   balance.
4. A later receipt on bank A changes only A.

### 8.9 Matrix rows
OB-G1 per-bank create, OB-G2 identity refusal, OB-G3 metadata ignored, OB-G4 later movement, OB-G5 aggregate
not ready withholds, OB-G6 tenant, OB-G7 reset.

### 8.10 Cloud rehearsal case
OB-H-G: open two banks, post one receipt on one, assert `getBookBalance` per bank and the control.

## 9. Family H — one end-to-end 18/10/2026 operational rehearsal case

A single case added to `scripts/accountingOpeningRehearsal.mjs` (which exposes `recordCase`) so it runs through
`accounting-rehearsal.yml` and the trusted release rehearsal on a disposable backend (it is "cannot-run = FAIL,
never skip"). It uses synthetic data only and a draft dated 2026-10-18.

Steps (one subsequent movement per family):
1. Draft and post an opening with: one named reservation deposit (B), one owned car and one SOURCED car (C),
   one accrued payable (D), two partners with one net-debit (E), two banks plus cash (G). Include a deliberate
   unexplained difference on a second draft and assert it is reported and not posted.
2. B: apply the deposit to a sale of the reserved car (completes the sale); assert deposit APPLIED, liability 0;
   `deposits.release` on another opening deposit refuses.
3. C: the same sale draws opening cost into COGS; the SOURCED car cannot be opened.
4. D: pay half of the payable via the payable route; assert remaining = half, retry safe.
5. E: record a CONTRIBUTION for a partner; assert derived net; no DRAW row from the opening.
6. G: assert per-bank `getBookBalance`.
7. Reconcile each family subledger to its control; assert all differences zero and the reported-difference
   case matches the fixed label.
8. Cleanup: the preview is deleted by the controller (existing).

## 10. Closure matrix (summary; every cell needs evidence at implementation)

| Row | B | C | D | E | G |
|---|---|---|---|---|---|
| create | OB-B1 | OB-C1 | OB-D1 | OB-E1/E2 | OB-G1 |
| post | one journal, no cash | one journal | one journal | one journal | one journal |
| approve | accountant sign-off, recorded | same | same | same | same |
| retry | OB-B3 | evidence key | OB-D4 | OB-E6 | idempotent post |
| partial | n/a (apply whole) | n/a | OB-D2 | n/a | n/a |
| cancel/void | refused (OB-B5) | n/a | refused | n/a | n/a |
| reverse | closure-readers lane | same | same | same | same |
| historical | none (fresh org) | assertNoExisting | assertNoExisting | clean partners | identity refusal |
| report | reconciliation | inventory control | payable aging | partner list | getBookBalance |
| UI | EN/AR | EN/AR | EN/AR | EN/AR | EN/AR |
| permissions | existing finance | existing | existing | existing | existing |
| tenant | OB-B6 | OB-C6 | OB-D6 | OB-E7 | OB-G6 |
| E2E | OB-H-B | OB-H-C | OB-H-D | OB-H-E | OB-H-G |
| production | exact-SHA rehearsal | same | same | same | same |

## 11. Implementation slices (ordered; one reviewable PR each; fewer, cohesive)

Money PRs follow AGENTS.md: two-seat review, skill-evidence section, no push from this lane.

| # | Slice | File scope (indicative) | Depends on |
|---|---|---|---|
| S1 | Named opening deposits (B) | `schema.ts` (optional deposit fields), `openingAllocations.ts`, `openingAccountPolicy.ts`, `deposits.ts`, `utils/depositHelpers.ts`, `accountingReports.ts`, editor + i18n, tests | none |
| S2 | Inventory cap and SOURCED refusal (C) | `openingAllocations.ts`, `openingVehicleBasis.ts`, ownership conversion / vehicle edit guard, tests | none (can run parallel with S1) |
| S3 | Vendor/accrued payables hardening and SCRUM-868 hook (D, Candidate 1) | `openingAllocations.ts`, `sourcingPayables.ts` tests, editor | SCRUM-868 for the supplier-keyed part only |
| S4 | Partner opening drawings and net-debit read (E, Candidate 2) | `openingPartnerAllocations.ts`, `openingPartnerBasis.ts`, `partnerEquity.ts`, policy, editor | none |
| S5 | Per-bank opening reconciliation read (G) | `accountingCutover.ts` status, `bankAccounts.ts` read, editor | SCRUM-54 merged ledger (#614, #602); PRs #611-613 state UNAVAILABLE |
| S6 | Case H rehearsal + matrix rows | `scripts/accountingOpeningRehearsal.mjs`, `docs/architecture/scrum486-certification-oracle.md` rows | S1-S5 |
| S7 (gated) | Salary payable (D, Candidate 2) | payroll opening kind, `openingSalaryPayments` | Q3 answered yes; separate owner approval |

Suggested PR grouping to minimise review loops: S1 alone (largest money surface), S2+S5 together (small, no new
money formula), S3 alone, S4 alone, then S6. S7 only on Q3.

## 12. Dependencies

- SCRUM-868 (canonical supplierId): blocks only the supplier-keyed part of S3; S3 can ship with OTHER_PAYABLE.
- SCRUM-54 bank ledger: merged (#602, #614 per the task); #611-613 not checked, S5 must re-verify at start.
- Closure-readers lane: owns the generic reconciliation readers and the opening-journal reversal test; S1-S5
  add family tests only.
- SCRUM-760 pilot containment: unchanged. S1 adds a server-side refusal that is within the containment, not a
  change to the switches.

## 13. Five predicted ways this design could be wrong

1. Opening-origin deposits leak into a refund door. A writer of `deposits` that I did not enumerate (a cron,
   an import, `depositRequests`) treats the row as an ordinary HELD deposit and refunds or voids it. Detection:
   `graft callers` over every `deposits` writer plus a test per door; the blocker is a server-side refusal, not
   a UI disable.
2. The unnamed pool and the named rows double-count in `computeCustomerDepositsReconciliation`, so the
   control reads high or low by exactly the opening deposits. Detection: a reconciliation test with both
   present.
3. The inventory cap fix reads the wrong set (all STOCK vehicles instead of those with opening evidence),
   so a vehicle bought after the cutoff joins the opening cost. Detection: a post-cutoff purchase test.
4. A signed or two-line partner presentation leaves one reader (`derivePartnerBalanceMinor` consumers,
   dashboards) assuming credit-only, so a net-debit partner shows a positive equity. Detection: enumerate
   readers of `partnerEquity.balanceMinor` and render each.
5. The accountant's statement contains a family I treated as ledger-only (retained earnings, prior distributions)
   whose components must be explained to be correct, and the reported difference becomes a standing red item
   for the pilot. Mitigation: the difference is a first-class report, not a failure; the owner/accountant
   confirm what stays unexplained (Q4).

## 14. Owner / accountant questions (only where a money classification is not already ruled)

- Q1 (accountant) Non-vehicle security deposits: do any exist at 18/10/2026, and are they refundable
  liabilities (IAS 32 from recall) or non-refundable fees? This sets whether `depositKind SECURITY` is needed
  in S1 or only VEHICLE_RESERVATION.
- Q2 (accountant) For held reservation deposits, which exact reserved VIN does each belong to, and should a
  deposit with no VIN stay a customer credit that can only be applied?
- Q3 (accountant) Are any salaries, bonuses, commissions or other payroll amounts owed at 18/10/2026 for
  periods already worked? If yes, S7 (payslip-level) becomes required; if no, salary stays refused.
- Q4 (accountant / owner) Does any partner's prior drawings exceed their capital at the cutoff (net debit)?
  And are prior distributions explained component by component, or do some stay in the reported unexplained
  difference?
- Q5 (accountant) Do accrued expenses and vendor liabilities exist without a supplier master record, and may
  they be entered as labelled other payables until SCRUM-868?

No other classification is asked: the ruling already fixes the cutoff, native-screen requirement, no plug,
SOURCED never inventory, refund doors contained, and accountant approval before posting.

## 15. Evidence summary

VERIFIED by reading: openingAllocations.ts framework, openingAccountPolicy.ts policies, openingPartnerBasis.ts,
openingVehicleBasis.ts, quoteDepositPosting.ts, partnerEquity.ts balance derivation, bankAccounts.ts book
balance, containment switches present and true.
INSPECTED only: deposits release/void behaviour, sourcingPayables settlement, saleCompletion treatments.
UNAVAILABLE: IAS/IFRS text fetch; PR #611-613 state; vehicleOwnershipConversions and vehicle edit mutation;
OpeningAllocationEditor and i18n key inventory; SCRUM-486 matrix row id format (rows above use proposed ids
OB-*, to be renamed to the oracle format at S6); no code executed.
