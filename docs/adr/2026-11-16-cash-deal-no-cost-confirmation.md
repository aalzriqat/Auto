# Independent confirmation of cash deal costs

Accepted for SCRUM-455 D-2. The owner decided on 2026-11-16 that a confirmer must hold the existing `approve:requests` permission. The responsible salesperson declares no costs. The salesperson and every custodian assigned to or recorded on the deal are ineligible to confirm, and impersonation cannot supply either signature. [Owner decision](https://autoflowdealer.atlassian.net/browse/SCRUM-455?focusedCommentId=25291)

For a cash or mode-less application settled through the dealership outside financed recognition, the same server evaluator governs readiness and finalization. Itemized dealership costs require finance reconciliation and the existing payment and custody ledger proofs. A deal with no live dealer- or employee-borne costs needs independent confirmation of the current declaration version. Reconciled third-party fees can coexist with that declaration. A zero-amount dealer or employee placeholder cannot satisfy this obligation.

Writes to fees, their payments, custody records and custody movements invalidate the text and confirmation in the same transaction as the economic change. Re-declaration starts a higher version, so recording then voiding a cost cannot revive an earlier confirmation. Confirmation pins the version it reviewed. The command and finalization read and write through Convex transactions. [Convex OCC and atomicity](https://docs.convex.dev/database/advanced/occ)

The declaration makes no posting. It records the two actions in the audit log. The ordinary application projection withholds the stored evidence, and the workflow exposes a limited action state to eligible viewers. Applying the same invariant to standalone cash sales requires the canonical deal identity in D-3.

An eligible member with only `approve:requests` discovers pending confirmations on the existing Approvals page.
Its cursor-paginated query exposes only the application ID, the existing readable deal reference, and the current
confirmation version. The list and individual action query share eligibility checks. The command rechecks the
version, cost state, tenancy and independence inside its transaction. General deal, finance and readiness reads
keep their existing permissions. Cockpit readers can declare or confirm through the narrow action control even
when they cannot read financial readiness. The retained-credit approval queue supplies the access and pagination
precedent; its payment amounts, payout controls and request state do not belong to this action.

Cash closeout refuses a positive dealership or employee cost that falls outside the supported handover payment types. Reconciliation confirms the amount. The existing custody or direct payment checks establish the posting separately. SCRUM-569 owns the fee classification decision for the broader financed flow. The cash check introduces no new fee-to-ledger mapping. [SCRUM-569](https://autoflowdealer.atlassian.net/browse/SCRUM-569)
