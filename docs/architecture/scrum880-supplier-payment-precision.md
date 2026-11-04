# SCRUM-880 supplier payment precision

Invariant: the dialog displays the server's integer settlement amount, and a
successful confirmation posts that exact amount. Original supplier entitlements
must be representable at the currency's scale before conversion. Stored excess
precision refuses completion and payment. Unchanged legacy costs do not block
unrelated vehicle edits.

## Design and impact map

The server's `supplierSettlementAmountMinor` validates both stored amounts and
subtracts the validated integers, `dueMinor - paidMinor`. Subtracting major-unit
Numbers first can lose one minor unit near the safe-integer limit.
`list` returns that integer, or null for an invalid row, with an explicit return
validator derived from the existing native/opening schema union. `markPaid`
uses the same helper. Its optional expected integer lets the web dialog refuse
a changed balance atomically. Other existing callers keep their argument shape.
The new projection is additive. No database schema or stored row is migrated.

The dialog formats the supplied integer with BigInt division and remainder,
using Intl only to group the whole part. Converting a large integer through a
major-unit Number loses minor units. Existing shared formatters keep their behavior.

Refusal was chosen over silent rounding because a purchase price is an agreed
amount. Strict roundtrip validation also refuses legacy cumulative floating-point
residue. New instalments store cumulative paid amounts from integer minor units,
so three payments of 1.480 produce 4.440 rather than 4.4399999999999995.

| Area | Boundary |
| --- | --- |
| Writers | `vehicles.create`, `update`, `createSourced`, `importBulk`, `correctAcquisitionCost`; `vehicleEdits.requestCreate`, `requestUpdate`, `resolve` CREATE/UPDATE; `postVehicleAcquisitionIfOwned`; trade-in purchase-price write in `utils/saleCompletion` |
| Payable amount writers | Acquisition helper and cost correction validate before writing. Sale preparation validates the original SOURCED sourceCost before concession or commission calculations convert it. Opening allocations write from integer minor units. |
| Readers | Sourcing list and web dialog consume the new projection. Existing fields remain for mobile, settlement readers, sales and reports. Page totals belong to SCRUM-884. |
| Historical data | No rewrite. Invalid rows remain visible with a null projection and localized refusal. The live count was not measured; production showroom rows were not read. Zero affected live rows is not claimed. Every existing payable is potentially subject to the refusal until audited. |
| State transitions | Valid PENDING and PARTIALLY_PAID rows settle. PAID, CANCELLED and DISPUTED refusals remain. |
| Reversal | No new spending route. Existing bounce, return, void, refund, cancel, reversal, merge and reset obligations are unchanged; this change cannot enable a deferred door. |
| Idempotency | Refusals throw inside the transaction. The payment command and state changes roll back together. Existing replay behavior remains. |
| Authorization | Existing finance permission checks remain. Settlement still loads caller-supplied ids with `requireOwnedRow`. |
| Tenancy | No new cross-organization query or writer. Existing joins keep their org checks. |
| Ledger | The validated integer remainder goes directly to the supplier payment accounting hook and opening-payment row, including at the safe-integer boundary. |
| Audit | Existing actor, time, payment sequence, command and accounting event references remain. |
| UI | Latin digits, ISO suffix, LTR amount inside RTL Arabic. Null disables confirmation and shows a localized refusal. |
| E2E | Public-function harness tests verify list, mutation and cash journal together. Backend-connected browser rendering remains a separate evidence gap. |
| Runtime/release | No deploy, migration or production certification. Contract baseline coordinates and evidence must match the final source. Both seats must review the changed head. |

The writer enumeration used graft for source discovery and call edges, then
`git grep` over tracked non-test Convex source for `purchasePrice`, payable
inserts, `amountDue`, dynamic edit payloads and their enclosing preconditions.
`saleCancellation` only clears a trade-in purchase price. No current-source
enumeration establishes what historical versions wrote into live storage.

## Design checks and evidence

Five predicted failures were checked: bypass writers, partial balances displaying
the total, cumulative residue, invalid legacy rows blanking the list, and shared
helper drift. Advisory design review additionally found the stale-dialog race.
Advisory spec review found the large-integer formatting loss. Both were reproduced
or tested, then fixed. These advisory checks are not certification seats.

Failing-first evidence at b85f66e6: public create/list/markPaid for 128.0005 JOD
displayed 128.001 but credited cash 128000 fils. New precision tests resolved
instead of rejecting; projection tests received undefined. The large-display
regression received `9,007,199,254,740.988 JOD` where the supplied integer requires
`9,007,199,254,740.989 JOD`. Exact formatting passes it.

Mutation evidence: adding one minor unit in the shared settlement helper failed
the JOD, USD and partial literal controls. Restoring the helper passed all three.
These assertions compare both literal expected amounts and the actual cash
journal credit, so equality cannot pass merely because both consumers drift.

Static Chromium captures on 2026-10-30 used the real rendered dialog markup,
compiled `app/globals.css`, synthetic values and fallback fonts, with animation
disabled for capture. EN/AR JOD, USD and refusal states were captured at 390 and
1280 px, plus the large-integer control. Fourteen captures reported no document
horizontal overflow. Inspected EN desktop and AR phone captures show the exact
Latin-digit amount, LTR isolation, RTL content and disabled localized refusal.
This is static visual evidence, not an authenticated backend-connected render.
No dev server or watcher was started. Artifacts remain outside the repository in
the task scratchpad's `scrum880-render` directory.

## SCRUM-486 matrix rows

Unless named otherwise, rows below bind tests in `convex/sourcingPayables.test.ts`. They are harness
evidence, not cloud, concurrency or production certification.

| Matrix row | Test |
| --- | --- |
| SCRUM-486-SUPPLIER-DISPLAY-POSTING | SCRUM-880: display and cash posting agree for JOD USD and partial balances |
| SCRUM-486-SUPPLIER-LEGACY-PRECISION | SCRUM-880: legacy JOD and USD excess precision refuses payment atomically |
| SCRUM-486-SUPPLIER-PURCHASE-PRECISION | SCRUM-880: new JOD and USD purchases refuse excess precision before acquisition |
| SCRUM-486-SUPPLIER-WRITER-PRECISION | SCRUM-880: purchase cost writers refuse excess precision |
| SCRUM-486-SUPPLIER-STALE-CONFIRM | stale displayed settlement is refused before money moves |
| SCRUM-486-SUPPLIER-LEGACY-PAID | legacy excess precision in amountPaid is refused, including accumulated residue |
| SCRUM-486-SUPPLIER-INSTALMENTS | new fractional instalments stay canonical before the final payment |
| SCRUM-486-SUPPLIER-ORIGINAL-ENTITLEMENT | SCRUM-880: finalization preserves original supplier entitlement %s, in financedConsignedSettlement.test.ts |
| SCRUM-486-SUPPLIER-LEGACY-COST-EDIT | unchanged legacy costs allow unrelated direct and requested vehicle edits |
| SCRUM-486-SUPPLIER-CASH-DIRECT-PRECISION | the supplier receivable equals the journal's margin, to the minor unit, in consignedReporting.test.ts |
| SCRUM-486-SUPPLIER-CASH-THROUGH-PRECISION | the supplier payable is stored at the currency's scale, in consignedReporting.test.ts |

## Existing settlement regression coverage

### Preserve the existing invalid-cost refusals

The next CI run exposed two validation-order regressions. The precision guard
refused NaN in `createSourced` before the existing finite "supplier cost" check,
and refused a negative purchase import before its "cannot cost less than nothing"
check. Both failures reproduced in the full named test files with one worker.
The inputs were still refused, but callers received the wrong refusal.

`createSourced` now checks finite values and the consignment shape before
precision. Bulk import validates finite values, then the existing negative-cost
rule for PURCHASE batches, then precision for every row. These checks remain
before writes. Neither existing error assertion changed. The tests additionally
check that no payable or accounting event survives. The negative import also
checks inventory balance, command evidence, and finance-company creation.

The invariant and writer map above are unchanged. The regression checks cover
NaN, negative costs, positive excess precision, valid JOD/USD settlement, and
batch refusal without financial effects. Convex's documented Float64 support
includes NaN and Infinity, so a number validator alone cannot enforce this
domain contract. No error is caught and converted to success.

CI slice 2 also logged a missing `usePaginatedQuery` mock export while rendering
`ProfitApprovalGate`. Its failing-test summary named the NaN test, not that
component test. The component file passes its six tests locally and its source
matches `origin/main`; no component or mock was changed for that stderr.

CI exposed two existing assertions in `financedConsignedSettlement.test.ts`:
one required historical floating-point residue to persist, and one required the
old prose error. Both failures were reproduced locally. The revised test
requires canonical `4.44`, retains the PAID/timestamp/cockpit checks, and requires
the specific precision error code plus an unchanged payable after refusal.
All 242 tests in that named file pass with one worker; its ESLint check has no
errors or warnings. No production logic changed in this follow-up.

## Seat remediation on 2026-10-31

Both seat findings were reproduced before source fixes. With 128.0005 JOD in a
legacy SOURCED vehicle, finalization returned a sale id instead of refusing.
The 128.001 control completed and paid 128001 fils. Preparation now validates
sourceCost immediately after resolving currency, before supplier concessions
or commission calculations convert it. STOCK capitalized costs keep their
existing calculation. Refusal leaves vehicle, application, sale, payable,
accounting event, journal, journal line and command state unchanged in the harness.

The original settlement test and backend library scenario incorrectly required
9007199254740988 fils for 9007199254740.990 JOD due less 0.001 paid. The truthful
remainder is 9007199254740989. The test failed with the old helper. Returning
the validated integer difference fixes list and cash posting together. Both
library scenarios now agree with the exact display integer. Capping the range
would also avoid this example, but would unnecessarily reject safe integers.

The advisory legacy-edit finding was also reproduced: purchasePrice
100.0000000001 plus an unrelated colour change refused. The precision helper
now compares supplied costs with the stored row for vehicles.update and both
request-update doors. Creates still validate every supplied cost. Approval
compares against its current row, so a stale request cannot restore an invalid
cost that has since changed. A legacy approval request with an unchanged cost
and a colour change remains editable. Existing acquisition, source-shape and
posted-cost restrictions still apply independently.

The design attack moved validation earlier than the reported payable write and
identified the request and approval siblings. It is advisory, not a seat.
Five predicted failures guided the checks: rounding before admission, changing
owned capitalized-cost handling, losing one fils on partial settlement,
blocking unchanged legacy edits or accepting changed invalid ones, and dropping
a payable schema variant. A schema test pins both ordered variants and their
optional NATIVE and required OPENING origins, matching list's destructuring.

Initial local validation passed 543 tests across the seven PR test files plus
moneyDisplay.test.ts and scenarioRecord.test.ts, with one worker. The backend
and root TypeScript projects passed separately. Root excludes Convex, test-utils,
apps, packages and dealer-worker. The backend project covers Convex and test-utils
and excludes generated roots. Changed-file ESLint has zero errors and two
pre-existing explicit-any warnings in vehicleEdits.ts.

Eight temporary source mutations each failed their targeted assertion: restoring
float remainder conversion, converting instead of validating the original
entitlement, dropping the stored-row argument at each of the three edit doors,
inverting either cost-change comparison, and adding a third payable schema
variant. Each source file was restored from its exact pre-mutation bytes before
the final passing run. These are implementer checks, not independent seats.

The first pushed head, 428840638, then failed CI slice 1 in two older
consignedReporting.test.ts cases. Both seeded sourceCost 9500.5002 JOD and
required completion to round it. Local reproduction gave two failures and 55
passes. That contract conflicts with the new original-entitlement refusal.
Both invalid inputs are retained as exact coded refusals, with unchanged
vehicle, sales, supplier subledgers, events, pending events, journals, lines and
commands. The same key then completes after the fixture cost is made valid.
The original 3000.201 receivable assertion is retained and strengthened with
an actual 3000201-fils journal debit. A 9500.501 valid payable control retains
all three decimal places. No production guard or original refusal assertion
was weakened. Removing the guard makes both updated tests fail. These two
cash routes also have permanent scenario records and matrix rows.

The correct skill was invoked for the repeated test-contract drift, following
the earlier financed-settlement assertions and these two reporting cases.
The prevention is in executable refusal and valid-control checks at both cash
routes. Broader CI or agent-policy changes are outside this task.

The final expanded run passed 600 tests with zero pending tests in ten named
files, adding consignedReporting.test.ts to the earlier nine-file manifest.
The reporting-file ESLint check has zero warnings or errors. The additional
guard-removal mutation fails both cash-route assertions. Production source is
byte-identical to 428840638 throughout this test-contract follow-up.

Scope remains the requested fixes. Other LOW findings belong to SCRUM-879.
No production row count, backend-connected dialog verification, OCC proof,
migration, deployment or fresh two-seat certification is claimed here.

## Round 5: cumulative storage and trade-in regression closure

Invariant: cumulative paid minor units equal the sum of posted payments, and
cash credited cannot exceed the payable entitlement. A trade-in's stored
purchase price must equal its inventory debit and receivable credit.

The accumulation finding was independently reproduced through public mutations:
after paying 9007199254740.988 JOD against 9007199254740.990, a further 0.001
resolved with the old amountPaid and a 0.001 return remainder. That new integer
total cannot survive the existing major-unit Number storage. The new boundary
requires a safe, nonnegative integer, converts using the existing money helper,
and checks conversion back against the original integer before patching or
posting. It refuses with the existing SUPPLIER_AMOUNT_PRECISION EN/AR error.
The same boundary supplies markPaid's stored total. Its pre-existing validated
amountDue already makes that particular guard redundant; removing only the
markPaid call is an equivalent mutant, not a claimed defect caught by a test.
No schema migration, new spending route or deferred operation is enabled.

Writer enumeration: tracked non-test Convex TypeScript, including nested paths,
was searched for amountPaid writes. The two actual nonzero patches are markPaid
and recordPartialPayment in sourcingPayables; the latter's returned amountPaid
is not a third writer. Opening allocations initialize zero. Schema, settlement
views and vehicle correction responses are declarations/read projections. The
existing reader, authorization, history, audit and reversal map above remains
applicable: refusal throws inside idempotency and rolls back the command too.

Five predicted failures shaped verification: an intermediate total loses one
fils; the last partial payment bypasses validation; full settlement bypasses
the same boundary; trade-in conversion silently rounds; and localized text
names the wrong field. The advisory design attack agreed with bounded refusal
and identified the existing cash-containment test opt-out as an evidence limit.

Before production edits, the new accumulation assertion failed because the
payment resolved instead of refusing; both trade-in completion assertions failed
because the error was SUPPLIER_AMOUNT_PRECISION with supplier-payment wording.
The dedicated TRADE_IN_VALUE_PRECISION code now names the trade-in value in EN
and AR; it shares exactMinor with supplier validation, without changing supplier
wording. Both public doors, sales.create and sales.completeDraft, assert full
table equality on refusal, then retry the same completion key with 128.001 and
assert purchasePrice 128.001 and actual 128001-fils inventory/receivable lines.
These tests use accountingVehicleInventory's existing cash-containment opt-out;
they do not certify a reachable pilot trade-in workflow or enable one.

Source mutation checks: replacing the cumulative storage boundary with
fromMinorUnits fails the lost-fils assertion. Replacing the trade-in guard with
toMinorUnits makes both completion assertions fail because completion succeeds.
Each source was restored from a byte copy, with matching SHA-256 hashes. The
restored targeted run passes all four new checks. Supplier positive controls
settle through both final partial payment and markPaid and assert literal total
cash credits of 9007199254740990 fils. Refusal checks include command, payable,
event and journal state via all-table snapshots; they cover removals too.

| SCRUM-486 row | Permanent executable check |
| --- | --- |
| SCRUM-486-SUPPLIER-CUMULATIVE-ROUNDTRIP | sourcingPayables: cumulative supplier payments refuse a lost fils before posting |
| SCRUM-486-TRADE-IN-PRECISION-CREATE | accountingVehicleInventory: create refuses fractional trade-in value atomically with field-specific EN/AR text |
| SCRUM-486-TRADE-IN-PRECISION-DRAFT | accountingVehicleInventory: draft refuses fractional trade-in value atomically with field-specific EN/AR text |

LOW advisories remain SCRUM-879. No production row count, backend-connected UI,
platform/OCC proof, independent final-head certification or deployment is claimed.
Current Convex mutation docs, Adyen minor-unit guidance and Fowler Money were
re-fetched on 2026-10-31. Bounded refusal preserves the current storage contract;
lossless integer storage would require a separately reviewed schema migration.

Final local validation: 685 tests passed in eleven named files with one worker;
both TypeScript projects passed. Root typechecking excludes Convex, test-utils,
apps, packages and dealer-worker entry roots; the Convex project covers Convex
and test-utils with generated entry roots excluded. Changed-file ESLint has
zero errors and two pre-existing explicit-any warnings in the inventory suite.
The library initially refused malformed new records; corrected fingerprints
and separate literal executable titles pass its existing checks unchanged.

## Sources

[Convex mutations](https://docs.convex.dev/functions/mutation-functions) support
atomic validation and writes; [return validation](https://docs.convex.dev/functions/validation)
checks the query's runtime contract. [Convex data types](https://docs.convex.dev/database/types)
document Float64 support for NaN and Infinity. [ECMA-402 CurrencyDigits](https://tc39.es/ecma402/#sec-currencydigits)
defines currency precision. SIX's [ISO 4217 List One](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml)
was retrieved on 2026-10-30 with PowerShell after the browser rejected its XML
content type: JOD 3, USD 2. [Faithful representation](https://standards.aasb.gov.au/node/336)
supports showing the amount actually recorded. The 2026-10-31 remediation also
checked [Adyen currency and minor-unit guidance](https://docs.adyen.com/development-resources/currency-codes/)
and [Fowler's Money pattern](https://martinfowler.com/eaaCatalog/money.html).
Currency-aware integer arithmetic avoids losing minor units through rounding.
These sources support refusal of unrepresentable entitlements and subtraction
of validated integers. Documentation supports the design;
it does not establish live implementation or data parity.
