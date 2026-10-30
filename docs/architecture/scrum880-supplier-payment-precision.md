# SCRUM-880 supplier payment precision

Invariant: the dialog displays the server's integer settlement amount, and a
successful confirmation posts that exact amount. New purchase costs must be
representable at the currency's scale. Stored excess precision refuses payment.

## Design and impact map

The server's `supplierSettlementAmountMinor` validates both stored amounts and
uses the existing `toMinorUnits(amountDue - amountPaid, currency)` conversion.
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
| Payable amount writers | Acquisition helper and cost correction validate before writing. Sale completion and opening allocations already write from integer minor units. |
| Readers | Sourcing list and web dialog consume the new projection. Existing fields remain for mobile, settlement readers, sales and reports. Page totals belong to SCRUM-884. |
| Historical data | No rewrite. Invalid rows remain visible with a null projection and localized refusal. The live count was not measured; production showroom rows were not read. Zero affected live rows is not claimed. Every existing payable is potentially subject to the refusal until audited. |
| State transitions | Valid PENDING and PARTIALLY_PAID rows settle. PAID, CANCELLED and DISPUTED refusals remain. |
| Reversal | No new spending route. Existing bounce, return, void, refund, cancel, reversal, merge and reset obligations are unchanged; this change cannot enable a deferred door. |
| Idempotency | Refusals throw inside the transaction. The payment command and state changes roll back together. Existing replay behavior remains. |
| Authorization | Existing finance permission checks remain. Settlement still loads caller-supplied ids with `requireOwnedRow`. |
| Tenancy | No new cross-organization query or writer. Existing joins keep their org checks. |
| Ledger | Valid settlement conversion remains unchanged. The projected integer goes directly to the supplier payment accounting hook and opening-payment row. |
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

All rows below bind tests in `convex/sourcingPayables.test.ts`. They are harness
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

## Sources

[Convex mutations](https://docs.convex.dev/functions/mutation-functions) support
atomic validation and writes; [return validation](https://docs.convex.dev/functions/validation)
checks the query's runtime contract. [ECMA-402 CurrencyDigits](https://tc39.es/ecma402/#sec-currencydigits)
defines currency precision. SIX's [ISO 4217 List One](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml)
was retrieved on 2026-10-30 with PowerShell after the browser rejected its XML
content type: JOD 3, USD 2. [Faithful representation](https://standards.aasb.gov.au/node/336)
supports showing the amount actually recorded. Documentation supports the design;
it does not establish live implementation or data parity.
