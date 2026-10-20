# Pilot path: coverage map and gaps (SCRUM-761, owner ruling SCRUM-760 c22474)

Narrowed pilot: ONE dealer, cash sale + financed sale through delivery. This file is what the pilot go/no-go reads for the regression library. Evidence boundary: static search of `origin/main` test files at c971e6343 plus the library validator; **no test in this list was executed here as a record-driven run** (the S3 runner census is the binding proof). "Absent" means "not found by search", not proven missing.

## Recorded as library records (active, bound to existing backend tests)

| Record | Bound test | Ruling |
| --- | --- | --- |
| cash-taxed-owned-sale-gl-subledger-invoice-agree | convex/ownedSaleTaxEndToEnd.test.ts | SCRUM-760#c22465 (R-CONSISTENCY) |
| financed-v2-finalize-freezes-forward-due-and-full-receivable | convex/financeCompanyForward.test.ts | SCRUM-407#c21031 |
| financed-v2-sale-journal-ap-finance-carries-deposit-plus-contribution | convex/financeCompanyForward.test.ts | SCRUM-407#c21031 |
| financed-v2-forward-clears-payable-then-transfer-settles-full-approved | convex/financeCompanyForward.test.ts | SCRUM-407#c21031 |
| financed-v2-commission-base-is-approved-less-contribution | convex/commissionMarginBase.test.ts | SCRUM-407#c21031 |
| financed-appraisal-gap-is-net-shortfall-and-blocks-the-rail | convex/financingEconomics.test.ts | SCRUM-407#c21031 |

Plus, from earlier PRs: three `saleEconomics` rule records and the financed-finalize permission record (refusal half only).

## Gaps (pilot-path steps with no backend test asserting the outcome)

1. **No end-to-end cash flow**: quote -> `sales.create` -> real `collections.recordPayment` on the sale's own receivable -> GL cash/AR -> COMPLETED. Payment is either a generic receivable or the `payInvoice` fixture (scrum571s2*). PAYMENT_LINK is shut, so this is the live receipt route.
2. **No owned cash sale pins the whole journal by account** (cash/AR, revenue, COGS, inventory) with literal numbers. Tax, COGS and the consigned entry are pinned separately.
3. **Cash delivery has no discrete mutation**; HANDOVER is a rail state tied to COMPLETED, so only reader state is tested.
4. **No single financed test chains** quote -> approval -> handover -> finalize -> forward -> `confirmDisbursement` -> reports. Pieces are spread over four files.
5. **Financed revenue/margin on the P&L report (not the commission base) for an owned car is pinned only by v1 pure tests and cockpit readers**; no v2 P&L parity test. The v1 posting-plan tests pin a superseded rule (stale-risk).
6. **Configured-company route with a customer gap through `finalizeDeal` plus the customer's real `recordPayment` on the gap invoice**: untested (gap-in-cash journal pinned on the manual route only).
7. **`confirmDisbursement` ledger outcome** on a real v2 deal is pinned via financeCompanyForward / SCRUM-241, but accountingPhase8's own test is seeded and asserts no ledger.
8. **Cash-sale permission denial is thin**: no test of `sales.create` refused for a role without the permission.
9. **Cash cancel**: covered only by the SCRUM-704 matrix (`describe.each`, so not bindable one record per case yet) and accountingPhase8; no cash-payment refund.
10. **Cash P&L parity beyond revenue 15,000 -> 0** (margin, COGS) not asserted.
11. **Weak existing tests**: accountingPhase2 (4-line count only), accountingPhase0 idempotency (row counts only), sales.test ledger-transaction test (legacy row only). Not recorded; strengthening them is its own `convex/` PR.

## Waiting on others

- SCRUM-795 off-switches (refund payout, salesperson cash receipt): each refusal gets a permission record once it lands, with its failing-first test. The manual journal off-switch is recorded below.
- SCRUM-413b refusal list: needs a SCRUM-413#description digest; deferred behind this.
- Parameterized tests (SCRUM-704 matrix, SCRUM-27 `describe.each`) need per-case titles or the S3 census.

## SCRUM-795 item 3 (no salesperson cash receipts)

- Record sales-member-cannot-post-a-deposit is bound to convex/depositRequests.test.ts (failing-first under #364). It claims ONLY deposits.create: that test does not assert deposits.allocateToVehicles, releaseVehicleAllocation, depositRequests.confirm or vehicles.createReservation, so those doors have no record yet (gap).
- It cites SCRUM-760#c22465 (R-PERMISSION); SCRUM-760 c22474 is not in the snapshot, so it is not cited as a ruling id.
- AF-98's template pin (PR #518, convex/utils/permissions.test.ts) is not bound yet; bind it once merged.
- Items 1 (manual journals) and 2 (refund payout) await their PRs.

- Added (AF-98 verified, I re-read both bodies): sales-member-cannot-confirm-a-deposit-request (depositRequests.confirm; refusal + no money rows) and sales-member-cannot-allocate-or-release-a-deposit-hold (the test calls allocateToVehicles, releaseVehicleAllocation and resolveReleasedAllocation x2; the record's single step names allocateToVehicles as the representative and claims only that the hold row is unchanged, NOT the money tables).
- vehicles.createReservation with a deposit stays a GAP: its test (DA-01) uses a custom-permission editor, not the SALES template, so it proves 'lacking confirm:finance_disbursement is refused', not 'SALES is refused'. The SALES half needs PR #518's template pin.

## SCRUM-795 item 1 (manual journals off)

- Five records bind exact titles in convex/manualJournalsPilotOff.scrum795.test.ts and cite SCRUM-760#c22474 (digest added to rulings.json): create refused, approve refused with the legacy draft left pending, the legacy draft still rejectable (permission domain, matrix row label `SCRUM-50-manual-journal-off`), and both opening-balance paths still posting (money domain, label `SCRUM-50-opening-balance-paths`). The matrix labels are descriptive, not joined SCRUM-486 row ids.
- Gaps, stated: the create record claims the refusal and unchanged database as the bound test asserts them; it does not claim the refusal precedes every read, which the test does not observe separately. The real-backend approve refusal runs only in trusted-main E2E (the legacy draft is seeded there only); the swarm lane never seeds that draft (the seed scope is pinned and not widened), so the swarm mission ACCOUNTING_DATE_BOUNDARY claims the create door only and does not claim the approve door. The approve door is covered by convex/manualJournalsPilotOff.scrum795.test.ts and the trusted-main E2E (playwright/tests/accounting.spec.ts, proveLegacyApproveRefused), not by the swarm. For what the swarm mission still claims (create refused with the pilot code, unchanged journals and drafts), a door or read that cannot run is a FAIL. The declared-date and closed-period posting rules are proven against the enabled code with the switch mocked off, and the GL register replay (posted row date, period and debit/credit totals, `accounting.spec.ts`) writes to the books, so it runs only when the backend itself attests, through `e2eBootstrap.replayAttestation`, a disposable preview (preview class and marker, which survive promotion to production), an org the trusted seed created, AND a per-run binding the lane set on the fresh preview (`E2E_REPLAY_RUN_NONCE`, at least 128 bits; `E2E_REPLAY_RUN_ID`, 1 to 64 of A-Z a-z 0-9 _ -; `E2E_REPLAY_RUN_EXPIRES_AT`, epoch ms). The test does not send the nonce: it sends the run id and an HMAC-SHA256 proof keyed by the nonce over `${orgId}:${runId}`, and the server recomputes the proof from its own environment and compares in constant time, so a proof is good for one org and one run only. The nonce is not returned by the query, not printed by the test and not on any command line the test runs; it does sit in the Playwright process environment and in the preview's environment, so the claim is 'not sent in clear', not 'secret from the lane'. The server refuses an expiry in the past or more than 2 hours ahead (lane default 1 hour). Promotion: a preview promoted to production keeps its deployment class, marker and seed org (the install exposes no deployment-type signal to functions, only the cloud and site URLs), so those cannot tell it apart. Two things bound it. First, on every run that reaches cleanup the lane runs `convex env remove` for all three variables and then deletes the preview (#635). Second, the expiry is the bound when a run does not reach cleanup (a hard runner death or a failed removal): the lane sets a 1 hour expiry, and the server refuses any expiry more than 2 hours ahead whatever the lane sets. A promotion that happens before the lane's cleanup or the expiry, with the variables still set, is not detectable by the server and is the stated residual. The marker's deployment name must equal the one in the current `CONVEX_CLOUD_URL` (tested, `MARKER_NOT_THIS_DEPLOYMENT`). These variables must never be set on a production deployment. The lane must also declare the org dedicated (`E2E_REPLAY_DEDICATED_ORG=1`). Production names are refused (`playwright/fixtures/replayIsolation.ts`, unit-tested with bypass attempts). No lane sets these today, so in every lane the replay is SKIPPED, which the report shows as skipped and not as passed (a lane that requires it sets `E2E_REPLAY_REQUIRED=1`, which turns the skip into a failure). A skip is unavailable evidence, not certification: the backend tests (`manualJournalAccountingDate.test.ts`, `accountingPhase10.test.ts`, switch mocked off) are the evidence until a lane provides a dedicated disposable org with the nonce (a separate job with its own preview, seed and `accounting.spec.ts` only; tracked under SCRUM-800, workflow change in #635).
