# Supplier stored-id readers require live organization-owned targets

SCRUM-942. Invariant: a supplier reader uses a document reached through a stored id only when it belongs to the caller's organization and is not soft-deleted. Otherwise it behaves as if the target were absent. Existing finance and cost permissions remain unchanged.

Lift the ownership and deletion predicate from supplierNavigation.owned into a small shared pure helper. Navigation keeps its cache and byte budget. A thin direct-read adapter and the existing receivable vehicle projection live beside the predicate to fit the unchanged formatted-line ceilings. Each join still performs one get in its caller's transaction. requireOwnedRow throws instead of returning null and does not check deletion; sameOrgOrNull deliberately retains deleted history. Changing either global helper would change unrelated policy.

| Edge | Foreign or deleted target |
| --- | --- |
| vehicleSupplierReceivables.vehicleId to vehicles in list | vehicleLabel is "Vehicle"; vin is absent |
| supplierCostRecoveries.vehicleId to vehicles in list | vehicleLabel is null |
| supplierCostRecoveries.expenseId to expenses in list | expenseTitle is null |
| supplierCostRecoveries.vehicleId to vehicles in reverseReceipt | Refuse with the existing "This car is no longer a sourced vehicle, so its supplier cost recoveries are closed and cannot be reversed." message, before ledger writes. This reveals no fact about a foreign document. |
| Legacy supplier obligation or concession vehicleId to vehicles in evaluateVehicleLink | Deleted vehicles produce the existing NO_VEHICLE verdict. Preserve the existing internal foreign-organization reason. No new repair or backfill is introduced or executed. |
| memberships.roleId to roles in eligibleRecipients | The member is ineligible for supplier alerts. |

The reversal pilot switch remains closed. Historical mechanics tests use the existing test-only switch mock. The repair and alert workers have no public entry, so their additional regressions invoke their internal registered functions. The sale/application facts used for aging remain report-only pending business policy.

This follows [Convex access-control guidance](https://docs.convex.dev/understanding/best-practices/#use-some-form-of-access-control-for-all-public-functions), [Convex authentication in functions](https://docs.convex.dev/auth/functions-auth), and [OWASP API1:2023 object-level authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/): authorization must cover the referenced object, not just the containing row. The helper is a shared check, not a second authorization system. Public-function harness regressions and selective mutants supply implementation evidence, not cloud or production certification.
