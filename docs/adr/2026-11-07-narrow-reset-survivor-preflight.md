# Narrow financial reset with survivor preflight

Date: 2026-11-07. Issue: SCRUM-565. Risk: CRITICAL, irreversible deletion.
Status: implementation design, outside the pilot train. No deployment or production execution authorized.

## Invariant and decision

A fresh reset of a suspended organization requires complete, bounded evidence that no excluded reference-bearing state survives. Each committed batch removes owned children before their parents, preserves identity and configuration, and creates no opening entries. Continuations retain the existing generation and refusal rules.

The owner approved this narrow design in SCRUM-565 c24729, following c24726. It supersedes D-19's blanket refusal and narrows D-9 to refuse when a survivor exists. It also supersedes the broader wipe scope in c24724. D-13 remains binding: partial evidence is UNAVAILABLE. D-11 and the SCRUM-559 PENDING-intent refusal remain. This does not implement S2-S4, recovery, reader, cron or webhook changes, or pilot certification.

Design A, chosen: retain the existing reset graph, add the five observed survivor tables and vehicle dependents, and refuse any excluded survivor. A shared reference registry supplies both runtime preflight tables and the schema coverage test. Coverage still rejects missing and stale references. Complete absence, rather than a financial calculation, is the admission evidence.

Design B, rejected: delete every survivor table. This would erase provider evidence, pending messages, approval history and unresolved financial obligations, require wider lifecycle and recovery work, and exceed the owner's narrow approval.

## Impact map

| Area | Disposition |
| --- | --- |
| Writers | `orgFinancialReset.resetOrgFinancialData`, internal mutation, fixed table scope, per-org indexes |
| Readers | Its dry-run and completion response; `orgResetPreflight.countOrgsWithResetInProgress`; release-script attestation |
| Historical data | Inspect rows irrespective of soft-delete status; refuse excluded survivors even if terminal |
| Transitions | Fresh generation, partial batches, completion; missing org and deletion ownership refuse |
| Reversal | No undo, cancellation or refund introduced; owner performs the destructive operation |
| Idempotency | SCRUM-563 generation increments once; continuations resume from remaining rows |
| Authorization | Internal only, suspended org, existing deletion and authority protections |
| Tenant | Index prefix is orgId; tests snapshot a second org |
| Ledger | Existing accounting deletion; chart of accounts behavior unchanged; no openings |
| Audit | Counts and table names, no row ids or amounts in refusals; owner retains run output |
| UI | No UI changes; CRM and Social Inbox records retained with repaired vehicle links |
| E2E | Real-document convex-test through the registered entrypoint, batchSize 1; no cloud or OCC claim |
| Release | Manual backend release remains separate; no deployment in this lane |

## Scope and reference dispositions

Schema enumeration covers every typed `v.id("vehicles")` and references to each newly deleted table. Vehicle photos are `vehicles.imageIds`, not a separate table; edit photos are `vehicleEdits.payload.imageIds`. There is no separate typed vehicle-document table in this schema. Existing finance appraisal and ownership-conversion documents use `documentStorageIds`.

New deletion candidates from that enumeration: vehicleCommitmentClaims, commitmentRoots, depositApplications, financeCompanyForwards, financeCompanyForwardSlices, vehicles, vehicleLandedCosts, vehicleCostCorrections, consignedSaleCorrections, vehicleSupplierReceivables, vehicleSupplierPayables, vehiclePriceHistory, vehicleOwnershipConversions, vehicleReservations, vehicleStatusRequests, vehicleEdits, test_drives, workOrders, vehicleValuations, depositRequests, depositVehicleHolds, socialPosts, profitApprovalRequests. Existing expenses, journal lines, sales, quotes, applications, appraisals, payments and deposit cancellation rows already belong to the reset graph.

Keep customers, leads, Social Inbox conversations and events, finance companies, suppliers and aliases, memberships, roles, settings, branches, bank definitions and valuation companies. Clear kept optional vehicle links on leads, tasks, instagramEvents, facebookEvents, marketplaceRequestMatches and marketplaceResponses. Set socialConversations.vehicleIds to [] and vehicleCount to 0 together. Clear vehicle custom-field values while preserving other custom-field values and field definitions. Inventory-dependent required references are deleted, rather than made nullable. Exact runtime table sets and ordering are checked against the schema.

Storage choice: retain blobs referenced by vehicle, edit, ownership-conversion and social-post rows. A blob id has no tenant ownership metadata and may be shared with kept rows or another organization; deleting it without a complete ownership/reference proof risks another tenant's data. This operation removes metadata, not a certified physical erasure of media. Existing finance-appraisal blob handling remains as before. This is a deliberate residual, not a claim that files were erased.

The preflight must finish before generation changes or cleanup writes. Excluded tables use bounded org-index reads. State-family scans and kept-reference scans have explicit bounds. Any read-bound overflow returns UNAVAILABLE. Runtime read errors abort without writes. Dry runs report the verdict, bounded counts and count scope. Continuations do not reacquire a fresh-start survivor certificate against partially deleted data.

## Five predicted failures

1. An excluded table is omitted or a newly added reference bypasses admission. Parameterized survivor tests and schema coverage must detect this.
2. A full prefix is mistaken for complete evidence. Over-bound terminal cheques or kept references must produce UNAVAILABLE and preserve both orgs.
3. A partial child batch deletes a parent too early. BatchSize 1 graph tests must inspect committed intermediate states, stop and retry to completion.
4. Vehicle deletion leaves a kept reader pointing at a deleted row or changes another tenant. Kept-reference repair tests and whole-schema two-org snapshots must prove the disposition.
5. Fresh-start admission bypasses suspension, deletion ownership or generation handling. Refusal snapshots, generation assertions and continuation tests must prove these rails.

## Official guidance and engineering basis

Checked 2026-11-07 against the installed Convex 1.41 guidelines and current official documentation:

- [Transaction limits](https://docs.convex.dev/production/state/limits): read and write budgets are per execution. Retain bounded batches and abort on incomplete evidence.
- [Pagination](https://docs.convex.dev/database/pagination): one paginated query per function and explicit completion. The survivor guard uses bounded indexed probes; it does not combine paginations or interpret a prefix as the whole table.
- [Scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions): scheduled work is durable; scheduling a deletion does not establish completion. Preserve the existing operator-driven batch machinery and refuse surviving active families.
- [Deleting files](https://docs.convex.dev/file-storage/delete-files): database row removal does not remove stored files. Blob deletion requires a separate ownership decision; retained files are disclosed above.

Documentation supports the design, not platform execution or concurrency. Those remain unverified in this local-only lane.

## Owner runbook

After independent review, merge and the normal backend release, the owner performs these steps. An agent must not execute them against a deployment.

1. Suspend the selected org using `adminOrgs.setSuspended` with `{ orgId: <selected org>, suspended: true }`, authenticated as a super admin. Confirm suspension.
2. Invoke `orgFinancialReset:resetOrgFinancialData` with `{ "orgId": "<selected org>", "dryRun": true, "batchSize": 100 }`. Read `preflight`, its table counts and `perTable`. Counts are bounded batch counts, not a full inventory.
3. Stop on REFUSED or UNAVAILABLE, authority state, pending intents, held provider capture, cash state, or deletion ownership. Resolve through separately approved workflows. Do not delete survivor rows manually or clear generation fields.
4. Invoke the same function with `{ "orgId": "<selected org>", "dryRun": false, "batchSize": 100 }`. Repeat the exact arguments while `remaining > 0`. An interrupted run resumes with these arguments. Never unsuspend during a partial reset.
5. Read the completion result with `remaining === 0`. Confirm the generation completion stamp and use a final dry run to check counts. No opening entries are created. Retained media blobs are not erased.
6. Unsuspend using the same suspension function with `suspended: false` after completion. Existing incomplete-reset protection remains binding.

## Evidence

Red and green runs, final table lists, release-attestation disposition and unverified checks are recorded here before the implementation commit.
