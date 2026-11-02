# Master Pilot Task List (SCRUM-760, Bloom Cars web-only narrow pilot)

Reference document. One list, maintained in place. Jira SCRUM-760 stays the
authoritative ruling record; this file is the reconciled task hierarchy that the
coordinator keeps synchronized with Jira, GitHub, CI and production evidence.
A `[Claude Update] Master Pilot Task List` comment on SCRUM-760 carries the
current counts and points here, so the list survives a context reset.

Version 1 reconciled 2026-11-02 00:10Z from: SCRUM-760 description and rulings,
the 74 issues linked to SCRUM-760 (newest comments read per issue),
`origin/main` 9139d1647 (fetched that minute), GitHub Actions run history,
the Production environment rules, `AGENTS.md`, `regression/`,
`docs/architecture/scrum486-certification-oracle.md`, `docs/agents/pilot-g8-hunt.md`,
the pilot switches in `convex/utils/` and `lib/pilotCapabilities.ts`, and
`.github/release-waivers.json`. Jira status fields were not trusted; evidence
was read from comments, PRs and runs.

## Rules this list follows

- Status ladder: NOT STARTED → IN PROGRESS → IN REVIEW → MERGED/NOT DEPLOYED →
  DEPLOYED/NOT VERIFIED → CERTIFIED COMPLETE. Side states: BLOCKED,
  EXPLICITLY DEFERRED, OWNER DECISION (a blocker that only the owner can clear).
- Merged is not accepted. Green CI is not production verification. A parent is
  complete only when every mandatory child is CERTIFIED COMPLETE.
- Deployed means the Convex backend SHA was released through Deploy production.
  The last successful release is run 41261906476 at ed0c4e1b (2026-11-01 01:41Z).
  Everything merged after ed0c4e1b is MERGED/NOT DEPLOYED.
- Responsible agent tags: `[Sonnet]` implementer, `[Seats]` Opus Seat 1 and
  Codex Seat 2, `[Coord]` coordinator session, `[OWNER]` owner decision or
  approval, `[CI]` a workflow that must run green at the release SHA.
- Deferred items are listed so they are not silently re-added or silently
  dropped; they are not counted as mandatory.
- Sync points: session start, every PR change, review verdict, merge, CI
  verdict change, blocker found or cleared, Jira ruling, deploy or verification
  change, and before and after each release candidate. Each sync updates the
  rows it touches, the counts, and the SCRUM-760 anchor comment.

## Counts (version 1)

| Measure | Count |
| --- | --- |
| Workstreams | 8 (A to H) |
| Mandatory parent tasks | 90 |
| Mandatory subtasks | 30 |
| Mandatory items in total | 120 |
| CERTIFIED COMPLETE | 2 |
| DEPLOYED/NOT VERIFIED | 23 |
| MERGED/NOT DEPLOYED | 8 (one of them also BLOCKED) |
| IN REVIEW | 13 |
| IN PROGRESS | 28 |
| NOT STARTED | 32 |
| BLOCKED | 4 (plus the blocked merged row) |
| OWNER DECISION | 10 |
| EXPLICITLY DEFERRED (row A8 plus the X table, not counted as mandatory) | 1 + 12 |

The counts are computed from the status column of every row below. Re-count on
every sync with:

```
Select-String -Path docs/pilot/master-pilot-task-list.md -Pattern '^\| [A-H]\d' | ForEach-Object { (($_.Line -split '\|')[4].Trim() -replace '\s*`\[.*$','') } | Group-Object | Sort-Object Name
```

## A. Pilot scope and business rules

| ID | Task and acceptance | Jira / PR | Status | Blocker, evidence, last verified |
| --- | --- | --- | --- | --- |
| A1 | Scope contract recorded: one web dealer (Bloom Cars), CASH and configured FINANCED through delivery, SOURCED routes, mobile excluded; recorded as a ruling digest in the repo. | SCRUM-760 description (2026-10-25, 2026-10-27), `regression/rulings.json` SCRUM-760#description | CERTIFIED COMPLETE `[Coord]` | Ruling text in Jira; digest on main. 2026-11-02. |
| A2 | Pilot capability truth: every enabled and refused door recorded against SCRUM-486, 761 and 810 evidence; UI shows no dead control. | SCRUM-810 | IN PROGRESS `[Sonnet]` | Payment Links dead-control remedy proposed, no merge found; fixed assets disabled by switch. 2026-11-02. |
| A2.1 | Payment Links pilot switch truthful in UI (`PAYMENT_LINKS_PILOT_DISABLED = true`). | SCRUM-810 | IN PROGRESS `[Sonnet]` | Switch on main; remedy PR not found. |
| A3 | Server-side block evidence for every excluded financial mutation (receipt doors, customer-credit payout, manual journals, RT11 doors, supplier settlement doors, fixed assets, partner distribution, cleared-cheque return, legacy refund). | SCRUM-760 decision B, SCRUM-795, SCRUM-869#c23881, SCRUM-760#c23862 | DEPLOYED/NOT VERIFIED `[Seats]` | All switches `true` on main (`customerCreditPayoutContainment.ts`, `pilotSwitches.ts`, `rt11DoorContainment.ts`); RT11-DOORS rows in the 486 oracle; production read-back of each refusal not recorded. 2026-11-02. |
| A3.1 | SCRUM-795 off-switch proof for refund payout and salesperson cash receipts, confirmed deployed. | SCRUM-795 | IN PROGRESS `[Coord]` | Manual journals OFF confirmed on main; the other two not confirmed in Jira. |
| A4 | Cash-sale containment: full payment required, extras refused, trade-in not counted (SCRUM-802). | SCRUM-802, PR #526 | DEPLOYED/NOT VERIFIED `[Seats]` | `cashSalePilotGate.ts` on main; `playwright/tests/pilot-commissions-cash.spec.ts`; no record-driven real-backend run. |
| A5 | Required lifecycle still in scope: completed-sale cancellation, deal unwind, acquisition-cost correction (c23545/c23546/c23548). | SCRUM-760, SCRUM-816 | IN PROGRESS `[Seats]` | Oracle rows U-RET, U-ABANDON, U-SOURCED, CC-CASH, CC-AP, CC-RESTATE, CC-SOURCED exist; SCRUM-816 says they were not replayed as consumer journeys. |
| A6 | G1: SCRUM-613 money findings ruled and fixed; 690, 599, 447, 83 dispositioned. | SCRUM-613, 690, 599, 447, 83 | IN PROGRESS `[OWNER]` | 613 ledger: 8 PILOT-OPEN, 7 owner questions (c23809); the four fixes are deployed, live read-backs owed (rows D9). |
| A7 | Owner decision register (14 open questions) cleared or explicitly parked. | see section "Owner decisions" | OWNER DECISION `[OWNER]` | Listed below; none answered as of 2026-11-02. |
| A8 | Deferred register kept truthful (post-pilot activation gates, mobile, LOW ledger). | SCRUM-813/714/716/722/723/724/571, SCRUM-879, SCRUM-753 | EXPLICITLY DEFERRED | See section "Deferred". |

## B. Suppliers and supplier accounting (G9, G10, R1 to R6)

| ID | Task and acceptance | Jira / PR | Status | Blocker, evidence, last verified |
| --- | --- | --- | --- | --- |
| B1 | G9 SCRUM-868 canonical supplier identity (P1 to P3) on main, deployed, certified on a real backend. | SCRUM-868, PR #711 (P2), #732 (P3, main 9139d164) | MERGED/NOT DEPLOYED `[Coord]` | #732 seats CERTIFY at 0bd0e7f0e; merged 2026-11-01 23:21Z; not in a release. |
| B1.1 | Deploy P3 (first release containing #732); rollout ends "deployed but incomplete" by design. | SCRUM-868#c24336 | NOT STARTED `[Coord]` | Blocked by G6 deploy hold (E3, E4). |
| B1.2 | Link the 17 unlinked SOURCED cars after that release; re-run the rollout to completion. | SCRUM-868#c24336 (owner "بعده") | NOT STARTED `[Coord]` | Depends on B1.1. |
| B1.3 | Residual (b): car with money and a deal-held concession refused HELD_BY_DEAL. | SCRUM-868 | OWNER DECISION `[OWNER]` | Question open. |
| B1.4 | Expense writers on unlinked SOURCED cars: refuse or allow. | SCRUM-868#c24341 item 20 | OWNER DECISION `[OWNER]` | Behaviour change needs a ruling. |
| B1.5 | R3 canonical supplier id across every enabled money path (P3/P4/P5) proven on a disposable backend; AR-RTL and EN operator flows recorded. | SCRUM-760#c24228 R3, R6 | IN PROGRESS `[Seats]` | Oracle sections SCRUM-868/887 exist; real-backend run at the release SHA not done. |
| B2 | G10 SCRUM-869 supplier workspace: statements, settlements, aging, alerts, no implicit netting. | SCRUM-869 | IN PROGRESS `[Sonnet]` | #712 settlement doors and #714 receivables (via #744) deployed at ed0c4e1b; S3/S4 not implemented. |
| B2.1 | Settlement doors (CASH, BANK_TRANSFER; three doors disabled). | PR #712 (8ec6cc1d) | DEPLOYED/NOT VERIFIED `[Seats]` | Switches in `supplierSettlementContainment`; production read-back not recorded. |
| B2.2 | Supplier receivables and AR-1240 reconciliation. | PR #714 via #744 (ed0c4e1b) | DEPLOYED/NOT VERIFIED `[Seats]` | Oracle rows; no production read-back. |
| B2.3 | S3 supplier statement and aging. | SCRUM-869 S3 | NOT STARTED `[Sonnet]` | No PR. |
| B2.4 | S4 due alerts. | SCRUM-869 S4 | NOT STARTED `[Sonnet]` | No PR. |
| B2.5 | Partial and full settlement allocation proven on a real backend, GL and subledgers and screens agree after reload. | SCRUM-869 proof bullet | NOT STARTED `[Seats]` | Needs B2.3 and a real-backend run. |
| B2.6 | R5 supplier workspace certified by two seats at the release SHA. | SCRUM-760#c24228 R5 | NOT STARTED `[Seats]` | Depends on B2.1 to B2.5. |
| B3 | R1 Suppliers management screen (EN/AR RTL, main nav, relationship navigation). | SCRUM-887, PR #750 (a49c5f77), #753 (48e87d20) | MERGED/NOT DEPLOYED `[Coord]` | Slice A merged; rendered EN/AR desktop and mobile check owed. |
| B3.1 | Remaining Suppliers screen slices (relationship navigation beyond slice A). | SCRUM-887 | IN PROGRESS `[Sonnet]` | Scope after slice A not yet written up as a PR. |
| B3.2 | Rendered EN/AR, desktop and mobile, RTL, loading, empty, error states of `/suppliers`. | SCRUM-887 | NOT STARTED `[Coord]` | Owed since #750. |
| B4 | R2 supplier registry initialised in production (all 5 orgs). | SCRUM-888, PR #747 (2464f489) | MERGED/NOT DEPLOYED `[Coord]` | Rollout runs in the deploy job; production read-back after release. |
| B5 | Reconciliation readers check organization ownership of stored references. | SCRUM-889, PR #748 (2ca8b8ab) | MERGED/NOT DEPLOYED `[Coord]` | Seats CERTIFY at c1724040; real-backend metering of the byte budget unproven. |
| B6 | A/P reconciliation compares dated subledger to dated GL (period close warning truthful). | SCRUM-876, PR #739 (9e599280) | MERGED/NOT DEPLOYED `[Coord]` | No Jira comment records the merge; GitHub shows it. |
| B7 | Supplier payment JOD precision. | SCRUM-880, PR #718 (446368ae) | DEPLOYED/NOT VERIFIED `[Seats]` | Merged 2026-10-31, inside ed0c4e1b; read-back not recorded. |
| B8 | Expense payee versus financial cost bearer are distinct parties on every expense path. | SCRUM-868 design doc, SCRUM-869 route invariants | IN PROGRESS `[Seats]` | Covered by design; proof on a real backend pending (B1.5, B2.5). |
| B9 | R4 inactive supplier cannot receive new money paths; existing balances stay reachable. | SCRUM-760#c24228 R4 | IN PROGRESS `[Seats]` | Not separately evidenced. |
| B10 | Consigned payable refuses VAT entry (owner ruling أ). | SCRUM-781, branch `claude/scrum781-consigned-vat-v2` (a0097cf18, 5 commits, 6 untracked scenario records) | IN PROGRESS `[Coord]` | No PR open; not a SCRUM-760 link but a SCRUM-773 ruling; money scenarios written, not pushed. |

## C. Accounting and opening balances

| ID | Task and acceptance | Jira / PR | Status | Blocker, evidence, last verified |
| --- | --- | --- | --- | --- |
| C1 | Opening-balance operational cutover workflow. | SCRUM-858, PR #710 | IN REVIEW `[Seats]` | Round 5 at f7bcee0c; now CONFLICTING with main; no Skill evidence section; both seats must re-certify after remerge. |
| C1.1 | Classification of the 43,013.700 JOD opening difference and an accountant-approved balanced cutover. | SCRUM-858, SCRUM-852 | OWNER DECISION `[OWNER]` | Open since 2026-10-28. |
| C1.2 | Remerge #710 with main, re-run seats, fill Skill evidence, merge. | SCRUM-858 | NOT STARTED `[Coord]` | Train position after #740. |
| C2 | Partner capital openings allocated once without duplicate GL postings. | SCRUM-852 | IN PROGRESS `[Sonnet]` | Owner ruling "allocate once" recorded; WIP uncommitted; no PR. |
| C3 | Late opening balance after business activity is refused. | SCRUM-850, PR #600 | DEPLOYED/NOT VERIFIED `[Seats]` | In production since 5f8e7b0f. |
| C4 | Posted-ledger readiness on real preview (navigation race). | SCRUM-851, PR #601 | DEPLOYED/NOT VERIFIED `[Seats]` | Real-preview run passed; flake disposition open. |
| C5 | Multiple bank accounts: per-account aggregates, rebuild in deploy job. | SCRUM-54 | DEPLOYED/NOT VERIFIED `[Coord]` | Deployed 5f8e7b0f; rebuild passed; EN/AR live check not done. |
| C6 | Forfeited deposit in operational P&L. | SCRUM-815, PR #549/#560 | DEPLOYED/NOT VERIFIED `[Seats]` | 26/26 cloud cases; live read-back not done. |
| C7 | Financed sale GL: v1 accepted for the pilot or v2 required. | SCRUM-411, PR #604 | OWNER DECISION `[OWNER]` | c24175 question open; finance invariants and real-backend certification remain either way. |
| C8 | Narrowed pilot switches proven (manual journals, refund payout, salesperson receipts off) and SCRUM-260 fixed. | SCRUM-795 | IN PROGRESS `[Coord]` | Manual journals OFF on main; SCRUM-260 part of the G1 question list. |
| C9 | Net-shortfall split (commission basis M) correct; cloud rehearsal and EN/AR render. | SCRUM-766, PR #697, #738 via #744 | DEPLOYED/NOT VERIFIED `[Seats]` | Owner approved basis M; Q3 SUPPLIER_CONCESSION_ALLOWS_GROSS_MANUAL and c23841 conditional authorization open. |
| C10 | Deposit OTHER treatment and manual-journal remedy messages while journals are off. | SCRUM-801, PR #525 (a6086d11) | DEPLOYED/NOT VERIFIED `[Seats]` | Deployed; re-enabling OTHER deferred. |
| C11 | Financed cockpit SETTLEMENT label correct before the finance company's transfer. | SCRUM-803, PR #527 (d92ba50b) | DEPLOYED/NOT VERIFIED `[Seats]` | Deployed; no read-back. |
| C12 | GL, subledger and statement reconciliation rows executed on a real backend at the release SHA (AR-1240, A/P, bank). | SCRUM-486, 876, 889 | NOT STARTED `[CI]` | Oracle rows exist; execution at the release SHA pending (H3). |
| C13 | Period close: INCONSISTENT_REFERENCE handling and checklist warnings. | SCRUM-879#c24328 item 5, c24332 | OWNER DECISION `[OWNER]` | LOW ledger item; the owner question on blocking close is open. |
| C14 | Subsequent transactions after openings (deposits, advances, prepaid, cash and banks) agree across GL, subledger and screens. | SCRUM-858, 816 | IN PROGRESS `[Seats]` | Depends on C1 and the 816 replays. |

## D. Sales and Unified Deal

| ID | Task and acceptance | Jira / PR | Status | Blocker, evidence, last verified |
| --- | --- | --- | --- | --- |
| D1 | CASH journey through delivery certified on a real backend. | SCRUM-486, 802, `playwright/tests/pilot-commissions-cash.spec.ts` | DEPLOYED/NOT VERIFIED `[Seats]` | Backend rows green in unit CI; record-driven real-backend run not done. |
| D2 | Configured FINANCED journey through delivery certified. | SCRUM-486, 411, `playwright/tests/financed-deal-economics.spec.ts` | IN PROGRESS `[Seats]` | Blocked on C7 for the GL convention; finance invariants pending. |
| D3 | SOURCED routes (DIRECT_TO_SUPPLIER, THROUGH_DEALERSHIP) with canonical supplier identity. | SCRUM-868 P3, `playwright/scenarios/pilot-sourced.spec.ts` (3 tests) | MERGED/NOT DEPLOYED `[Coord]` | Same gate as B1. |
| D4 | Collections and disbursements inside the enabled scope; receipt doors and customer-credit payout refuse server-side. | SCRUM-760 decision B, A3 | DEPLOYED/NOT VERIFIED `[Seats]` | Same evidence as A3. |
| D5 | Completed-sale cancellation, unwind and acquisition-cost correction replayed to every consumer screen. | SCRUM-816 | IN PROGRESS `[Seats]` | Not replayed (SCRUM-816 c 2026-10-26). |
| D6 | Semantic authorization, tenant-reference ownership and role/UI parity guardrail. | SCRUM-811, PR #660 (merged), #737 (open) | IN REVIEW `[Seats]` | #737 tests only, no defect; seats bound to 354ce996, re-seat needed after remerge; S811 real-backend case unrun. |
| D7 | Commission lines ON for the pilot (`DEAL_COMMISSION_LINES_PILOT_DISABLED = false`), Bloom on MANUAL. | SCRUM-783, 766 | DEPLOYED/NOT VERIFIED `[Seats]` | Cash commissions spec; no live check. |
| D8 | Money defects fixed and read back live: financier receipt (690), finance cash account (599), expected-payment cheque (447), appraisal gap (83). | SCRUM-690, 599, 447, 83 | DEPLOYED/NOT VERIFIED `[Coord]` | All in production via #560/#303; read-backs inconclusive or not done. |
| D9 | Day range uses the organization timezone. | SCRUM-264/265, PR #741 (e71e2400) | MERGED/NOT DEPLOYED `[Coord]` | Jira stale (To Do). |
| D10 | Wizard autosave accepts lead-prefilled and multi-car CASH drafts. | SCRUM-862, PR #673 | IN REVIEW `[Seats]` | Under review since 2026-10-25; no later evidence. |
| D11 | Financed quote lender selection (active 60-month lender hidden under default). | SCRUM-840 (relates) | NOT STARTED `[Sonnet]` | Relates link only; owner has not ruled it a blocker. Treated as mandatory for the FINANCED journey until ruled otherwise. |

## E. Security, permissions, data integrity

| ID | Task and acceptance | Jira / PR | Status | Blocker, evidence, last verified |
| --- | --- | --- | --- | --- |
| E1 | Vehicle cost fields hidden from roles without `view:cost_price`; ACCOUNTANT keeps cost via `view:reports`. | SCRUM-886, PR #746 (fad4751a3, round 11) | IN REVIEW `[seats]` | Round 11 at fad4751a3 pushed 07:16Z (SCRUM-886 c24355): the round-10 finding of both seats (c24354, threshold oracle via refusal precedence) closed by order: new `refuseUnacceptableTradeIn` runs as the first statement of `applySaleCompletionSideEffects`, before the cost-derived deposit refusal and the consigned cost gate, on every door; the consigned-CASH allocation overflow stated at the same point while the pay-first containment is on; texts, grants, writes unchanged; sales.ts/applications.ts/containment/permissions byte-identical. Coordinator red run 12/17 → 17/17; mutants M1–M4 killed (5/2/3/3); 989 named tests; baseline 938/0; 12 scenario records; oracle doc "(8) Round 11" classifies every post-gate refusal (`assertCashSaleInvoiceFullyPaid` recorded as a residual for the seats). CI running (sixth preview-backed run tonight); Seat 2 then Seat 1 armed on fad4751a3 with a fresh Seat 1 id. Rendered EN/AR checks owed (F9). |
| E1.1 | Remaining finance-editor variants without `view:cost_price`. | SCRUM-886#c24247 | OWNER DECISION `[OWNER]` | ACCOUNTANT ruled; other variants open. |
| E2 | Sidebar role visibility (SCRUM-890) deployable only after a green Pilot Role Audit. | SCRUM-890, PR #749 (89ccd15a) | MERGED/NOT DEPLOYED, BLOCKED `[Coord]` | Hold ruling c24239. |
| E3 | Pilot Role Audit green on main (six roles, 136 cells each). | SCRUM-891, PR #751 (5284d625), `pilot-role-audit.yml` | BLOCKED `[Coord]` | Run 41297986256 at 5284d625 FAILED (5/6 roles) after the fixture fix; cause unknown, evidence GPG-encrypted. |
| E3.1 | Diagnose the remaining red roles: decrypt locally (أ) or CI change publishing per-case verdicts (ب). | SCRUM-891 | OWNER DECISION `[OWNER]` | No decrypt without a new go-ahead. |
| E4 | Tenant isolation on every enabled read and write path (org from `ctx.auth`), including reconciliation and role explorer. | SCRUM-889, 616, tenancy scenarios (2 records) | IN PROGRESS `[Seats]` | 889 merged; 616 oracle slice merged (#661), runtime open. |
| E5 | Integration tokens never reach view-settings clients; exposed credentials rotated or revoked. | SCRUM-843 (#579), 841 (#578) | DEPLOYED/NOT VERIFIED `[OWNER]` | Fixes deployed; live read-back and Facebook reconnect unverified; rotation and revocation are owner actions. |
| E6 | Meta data-deletion callback privacy and status page. | SCRUM-842, PR #740 (687df839) | IN REVIEW `[Seats]` | Round 11; CONFLICTING; goes LAST in the train (owner); whether Meta integrations are inside the web-only pilot is an open owner question. |
| E7 | Vercel preview isolation from production Convex verified. | SCRUM-767 | BLOCKED `[OWNER]` | Owner removed preview vars; verification blocked by Vercel 403. |
| E8 | QA browser egress contained on the swarm candidate. | SCRUM-784, PR #563 | DEPLOYED/NOT VERIFIED `[OWNER]` | Symlink follow-up; Opus F4 relay ruling needed. |
| E9 | Dependency advisories patched (node-forge, undici, Next.js, Sentry). | SCRUM-885 (#729 d4f5d1c9), 859 (#670), dependabot #742 | IN REVIEW `[Coord]` | #729 merged not deployed; #670 unmerged; #742 red on unit-and-integration. |
| E10 | Idempotency and concurrency refusals on every enabled money path (duplicate submit, multi-tab). | SCRUM-486, 826, 889 B4 | IN PROGRESS `[Seats]` | Oracle rows; swarm ECON-2 handlers: two executed, nine families without a handler. |
| E11 | Repository-level `CONVEX_DEPLOY_KEY` removed and the workstation production key revoked. | SCRUM-125, `AGENTS.md` "Still outstanding" | NOT STARTED `[OWNER]` | Release-integrity item; state unverified this session. |
| E12 | Playwright traces in public artifacts carry no QA cookies. | SCRUM-820 | NOT STARTED `[Sonnet]` | No fix. |
| E13 | Role audit does not expose protected subscriptions before page guards. | SCRUM-860 | IN PROGRESS `[Seats]` | No visual finding; superseded by the audit red (E3). |

## F. QA and certification (G2 to G8)

| ID | Task and acceptance | Jira / PR | Status | Blocker, evidence, last verified |
| --- | --- | --- | --- | --- |
| F1 | G2 certification matrix is a required release gate and executed at the release SHA. | SCRUM-486, PR #688 (e45ef8f1), `convex/scrum486Certification.test.ts` | IN PROGRESS `[CI]` | Trusted verdict 39/39 at 0d6eafbb; oracle doc says the full matrix is not yet consumed by a required aggregate; new rows (868, 869, 858, 889) not yet executed on a real backend. |
| F2 | G3 release rehearsal executes cloud scenarios (FD1 fixed). | SCRUM-762, 759 (Done) | CERTIFIED COMPLETE `[CI]` | Mechanism done; must run green at the release SHA (H3). |
| F3 | G4 Trusted Browser Attack Swarm runs with attack workers and bounded evidence. | SCRUM-350 (#658), 376, 826, 824, 788 | IN PROGRESS `[CI]` | Runs green at 2ca8b8ab (41356479735); nine attack families have no handler (826). |
| F4 | G5 full authenticated Playwright on PRs before merge. | SCRUM-757, PR #704 (admission) | IN PROGRESS `[Sonnet]` | Admission job merged; `authenticated-pr-e2e` runs main's specs, not the PR's; prevention (pilot specs at PR time) not built. |
| F5 | G6 explorer oracles with measured catch rate. | SCRUM-614, 616, 617, 620, 344 | IN PROGRESS `[Sonnet]` | 344 recall 0/10 FAIL/UNPROVEN; G6 work committed locally, not pushed; first real explorer run pending. |
| F6 | G7 regression library R1 to R4 enforced in CI (PR, nightly, release). | SCRUM-761 | IN PROGRESS `[Sonnet]` | 643 records on main (640 active, 3 retired; 594 backend, 49 browser); only the record validator runs in CI; no workflow runs the library; no nightly; loader flake open. |
| F6.1 | PR-time runner for money and permission scenarios plus impacted-screen replays. | SCRUM-761 R3 | NOT STARTED `[Sonnet]` | `runLocalExecution.mjs` exists, no CI invocation. |
| F6.2 | Nightly full library and fresh hunt appending scenarios. | SCRUM-761 R3 | NOT STARTED `[Sonnet]` | No scheduled workflow. |
| F6.3 | Release run of the full library on a real backend. | SCRUM-761 R3, 762 | NOT STARTED `[CI]` | `regression/README.md` refuses cloud-level records until the cloud runner exists. |
| F7 | G8 bug hunt over Deals, Sales and Accounting. | `docs/agents/pilot-g8-hunt.md`, PR #705 | IN PROGRESS `[Coord]` | "G8 remains open"; RECEPTION runs 40281850794 and 40462525127 FAILED 0/136, classification unresolved; no real-preview run; no independent review. |
| F7.1 | G8-B form explorer on the nightly schedule. | SCRUM-771, PR #532 | IN REVIEW `[Seats]` | Pending since 2026-10-09. |
| F7.2 | G8-C hunt preview deployed and seeded for all roles. | SCRUM-768, PR #501 | IN PROGRESS `[Coord]` | Workflow merged; preview not deployed. |
| F7.3 | SUPER-ADMIN and SUPPORT AGENT hunt identities. | SCRUM-769, 770 | OWNER DECISION `[OWNER]` | Arrangement needed. |
| F8 | Screen audit: roles × EN/AR × phone/desktop green (34 routes per the doc, 35 in `SCREEN_AUDIT_ROUTES`). | `playwright/scenarios/screen-audit.spec.ts`, Pilot Role Audit | BLOCKED `[CI]` | Same red as E3; route count mismatch to reconcile. |
| F9 | Rendered EN/AR desktop and mobile checks owed for #749 sidebar, #741, #737, #746, #740 status page, `/suppliers`. | SCRUM-890, 264, 811, 886, 842, 887 | NOT STARTED `[Coord]` | Owed; not evidence of correctness until recorded. |
| F10 | Backend-to-UI journeys and every dependent consumer certified. | SCRUM-816 | IN PROGRESS `[Seats]` | Coverage map only. |
| F11 | Swarm mission ACC-1 harness error fixed and proven on a real backend. | SCRUM-878, PR #717 | DEPLOYED/NOT VERIFIED `[Seats]` | Real-backend proof pending. |
| F12 | ACC-3 browser oracle for accounting date and closed-period authority. | SCRUM-849, PR #598 | IN REVIEW `[Seats]` | No trusted run. |
| F13 | Visual gate screenshot capture reliable. | SCRUM-861, PR #701 | IN REVIEW `[Seats]` | Retry unproven. |
| F14 | Deal Scenarios E2E green on main. | `deal-scenarios-e2e.yml` | DEPLOYED/NOT VERIFIED `[CI]` | 41298681933 at 5284d625 success; must stay green at the release SHA. |
| F15 | Agentic e2e for the most important flow. | SCRUM-806 | IN REVIEW `[Seats]` | Status from Jira only; not re-verified. |
| F16 | Preview attestation "Server Error" fails the form explorer closed. | SCRUM-799 | IN REVIEW `[Seats]` | Status from Jira only. |

## G. CI, infrastructure, deployment

| ID | Task and acceptance | Jira / PR | Status | Blocker, evidence, last verified |
| --- | --- | --- | --- | --- |
| G1 | Serial merge train completed: #746 → #737 re-seat → #740 last. | SCRUM-886, 811, 842 | IN REVIEW `[Coord]` | #746 at e5b90ddc CI running; #737 and #740 CONFLICTING, re-seat after remerge. |
| G1.1 | #746 seats CERTIFY, body with fenced Red run and /simplify, checker exit 0, three comment surfaces read, merge. | PR #746 | IN REVIEW `[seats]` | Round 11 at fad4751a3: body republished with the fenced round-11 red run, both Seat SHAs at the head, seat lines pending; waiter runs Seat 2 then Seat 1 once CI and Sonar are green; CodeRabbit skipping (no coverage). |
| G1.2 | #737 remerge, fresh seats at the new head, merge. | PR #737 | NOT STARTED `[Coord]` | After #746. |
| G1.3 | #740 remerge, fresh seats, merge (last). | PR #740 | NOT STARTED `[Coord]` | After #737. |
| G2 | Convex preview I/O quota managed (40.45/50 GB on 2026-11-01, about 6 GB/day). | SCRUM-892 (#752 c186c640), 807, 809 | OWNER DECISION `[OWNER]` | Spending limit question open; serial train in force; quota exhaustion stops every preview-backed check. |
| G3 | Contract skew truthful: exit 7 only until deploy; no stranded or stale baseline entries. | SCRUM-711, 866, 873 (#745), 887 (#753), 893 | IN PROGRESS `[Coord]` | Main 41361709901 exit 7, 0 unclassified, no ALSO PRESENT; 938 entries in 145 shards. |
| G3.1 | Baseline expiry cliff: all 938 entries expire 2026-12-01. | SCRUM-711 | NOT STARTED `[Coord]` | 29 days from version 1; a delayed launch crosses it. |
| G3.2 | Prevention for new unproven skew paths reaching main. | SCRUM-893 | NOT STARTED `[Sonnet]` | No work. |
| G4 | Sonar Main reports at the tip within its timeout. | SCRUM-763 (#495), 764 (#736) | DEPLOYED/NOT VERIFIED `[CI]` | 41363941986 at 9139d164 success (2026-11-02 00:07Z, exactly one sonarqubecloud result at the tip). |
| G5 | Exact-SHA rehearsal and trusted release verdict produced at the release tip. | SCRUM-812, `accounting-rehearsal.yml`, `trusted-accounting-rehearsal.yml` | NOT STARTED `[CI]` | Latest trusted verdict 41355867715 at 2ca8b8ab; none at 9139d164; SCRUM-812 has no comments. |
| G6 | Deploy production of the pilot release (authorize, approval, deploy, rollout). | `deploy-production.yml`, SCRUM-890 | BLOCKED `[Coord]` | 11 PRs merged after ed0c4e1b undeployed (#745 #747 #741 #739 #750 #751 #752 #753 #749 #748 #732); hold until E3 green because #749 is on main. |
| G7 | Post-deploy readbacks: backend identity, bank rebuild, Social Inbox, supplier registry (888), 17-car link (868), counts-only reads. | `rolloutRelease.mjs`, SCRUM-888, 868 | NOT STARTED `[Coord]` | After G6. |
| G8 | Certificate carry across update-branches. | SCRUM-874, PR #707 (fa22c987) | DEPLOYED/NOT VERIFIED `[CI]` | On main 2026-10-31. |
| G9 | PR-side Playwright job cancellation (concurrency collision) resolved. | SCRUM-777, PR #583 | DEPLOYED/NOT VERIFIED `[CI]` | Merged; suspicion marked UNPROVEN in Jira. |
| G10 | Promoted frontend SHA recorded separately from the backend SHA. | SCRUM-760 description item 3 | NOT STARTED `[Coord]` | Owner promoted Vercel manually ("اتركه"); the promoted SHA is not recorded in this list yet. |

## H. Final readiness and launch

| ID | Task and acceptance | Jira / PR | Status | Blocker, evidence, last verified |
| --- | --- | --- | --- | --- |
| H1 | Acceptance checklist: every mandatory row in this list CERTIFIED COMPLETE, R1 to R6 and G1 to G10 evidenced. | SCRUM-760 | NOT STARTED `[Coord]` | This list is the checklist. |
| H2 | Release candidate SHA chosen after the train, with no merges while approval waits. | `AGENTS.md` release order | NOT STARTED `[Coord]` | After G1. |
| H3 | Gates green at the release SHA: Trusted Main E2E, Accounting Cloud Rehearsal, trusted verdict, SonarCloud, Pilot Role Audit, Deal Scenarios E2E, Contract skew (exit 7 only). | release-waivers.json (15 required, 0 waivers) | NOT STARTED `[CI]` | Depends on E3, G5. |
| H4 | Deploy production dispatched at the full SHA and approved. | `deploy-production.yml` | NOT STARTED `[OWNER]` | Owner authorized agent approval; environment rules require_reviewers aalzriqat, admins cannot bypass. |
| H5 | Production validation: backend SHA, frontend SHA, function spec, counts-only read-backs recorded separately. | SCRUM-760 item 3 | NOT STARTED `[Coord]` | After H4. |
| H6 | Link the 17 SOURCED cars, re-run the rollout, registry read-back. | SCRUM-868#c24336, 888 | NOT STARTED `[Coord]` | After H5. |
| H7 | Full library and certification matrix executed on a real backend at the release SHA (independent seats, not the implementing session). | SCRUM-761, 486, 762, decision B | NOT STARTED `[Seats]` | Depends on F6.3, F1. |
| H8 | Owner Go/No-Go recorded on SCRUM-760. | SCRUM-760 | NOT STARTED `[OWNER]` | After H1 to H7. |
| H9 | Post-launch verification: live EN/AR checks, read-backs for 690, 599, 447, 83, 54, Facebook reconnect (841). | SCRUM-54, 690, 599, 447, 83, 841 | NOT STARTED `[Coord]` | After H8. |

## Owner decisions open (blocking rows marked OWNER DECISION)

1. SCRUM-891: decrypt failed-role audit evidence locally (أ) or change CI to publish per-case verdicts (ب). Rows E3.1, F8.
2. SCRUM-892 / 807: disable the Convex spending limit (about $2) to allow a parallel train; release-only cleanup cases. Row G2.
3. SCRUM-858 / 852: classification of the 43,013.700 JOD opening difference. Row C1.1.
4. SCRUM-868: car with money and a deal-held concession (residual b); expense writers on unlinked SOURCED cars. Rows B1.3, B1.4.
5. SCRUM-886: finance-editor variants without `view:cost_price`. Row E1.1.
6. SCRUM-411: financed GL v1 accepted for the pilot or v2 required. Row C7.
7. SCRUM-613 G1 questions (c23809): SCRUM-560, 778, 260, 56, 85. Row A6.
8. SCRUM-843 / 841: rotate or revoke the exposed credentials. Row E5.
9. SCRUM-766: c23841 conditional authorization; Q3 SUPPLIER_CONCESSION_ALLOWS_GROSS_MANUAL. Row C9.
10. SCRUM-784: candidate preview relaying data outward (Opus F4). Row E8.
11. SCRUM-769 / 770: SUPER-ADMIN and SUPPORT AGENT hunt arrangement. Row F7.3.
12. SCRUM-767: Vercel preview isolation verification. Row E7.
13. SCRUM-879#c24328 item 5: INCONSISTENT_REFERENCE blocking period close. Row C13.
14. SCRUM-842: whether Meta integrations are inside the web-only pilot. Row E6.

## Deferred (not counted as mandatory)

| ID | Item | Ruling |
| --- | --- | --- |
| X1 | Customer invoice receipt application, unwind refund, operator correction, 30-day lifecycle (SCRUM-813, 714, 716, 722, 723, 724, 571). | `AGENTS.md` decision B: post-pilot activation gates. |
| X2 | Reverse cost correction. | SCRUM-760 2026-10-25 item 2. |
| X3 | Mobile application, builds and distribution. | SCRUM-760 2026-10-25 web-only clarification. |
| X4 | Fixed-asset lifecycle (`FIXED_ASSET_LIFECYCLE_PILOT_DISABLED = true`). | SCRUM-810; SCRUM-560 question under G1. |
| X5 | Partner profit distribution, cleared-cheque return, legacy collection refund, deposit OTHER re-enabling. | Pilot switches on main; SCRUM-801. |
| X6 | Three supplier settlement doors (receipt reversal, payable correction, cost-expense reversal). | SCRUM-869#c23881. |
| X7 | SUPPLIER_IDENTITY_UNRESOLVED text and design note. | SCRUM-868#c24339 (owner "أوافق") → SCRUM-879. |
| X8 | LOW review findings ledger. | SCRUM-879; owner 2026-10-29: LOW never blocks. |
| X9 | SCRUM-753 repository transfer. | After SCRUM-760 Done. |
| X10 | Premium design foundation adoption. | SCRUM-839 (relates). |
| X11 | Convex I/O performance guardrails. | SCRUM-809 (relates). |
| X12 | Tax, fee and warranty on CASH sales; trade-in counted toward pay-first. | SCRUM-802 refusals (`CASH_SALE_EXTRAS_PILOT_REFUSED`, `TRADE_IN_COUNTS_TOWARD_CASH_PAY_FIRST = false`). |

## Critical path (version 1)

1. G1 train: #746 → #737 → #740 (serial, seats at every head; measured 2026-11-01: 12 merges in 24 h with parallel CI, now 4 to 6 h per PR serial).
2. E3 Pilot Role Audit green on main (needs E3.1 owner decision, then a diagnosis round and possibly a fix PR). Nothing containing #749 deploys before this.
3. H2/H3 release candidate: Trusted Main E2E, rehearsal plus trusted verdict (G5), Sonar, Contract skew at the tip (about 3 to 4 h per candidate).
4. G6/H4/H5 first release (ends "deployed but incomplete" by design) → H6 link 17 cars and re-run rollout → B4 registry read-back.
5. B2.3 to B2.6 SCRUM-869 S3/S4 implementation, seats, merge, second release.
6. C1 SCRUM-858 remerge and C1.1 decision, seats, merge, release.
7. F1/F6.3/H7 full library and matrix executed on a real backend at the final SHA; F7 G8 closure; F5 G6 catch rate.
8. H8 Go/No-Go.

## Launch window (measured, not a percentage)

Inputs: serial train throughput 4 to 6 h per PR with two seats; release cycle 3 to 4 h; at least 3 releases (first with #732, one after 869 S3/S4, one after 858); remaining implementation PRs about 10 (#746, #737, #740, #710 remerge, 869 S3, 869 S4, 852, 887 remaining slices, 761 PR-time runner, 891 fix); owner decisions gate E3, C1.1, G2, C7.

| Scenario | Assumption | Window |
| --- | --- | --- |
| Earliest | Owner answers the 14 questions within hours; audit red fixed in one round; I/O quota raised; no new money finding. | 2026-11-07 to 2026-11-09 |
| Realistic | Decisions within a day each; one extra seat round per PR; 869 S3/S4 take two rounds; quota stays serial. | 2026-11-12 to 2026-11-16 |
| Delayed | Audit root cause needs a CI change; 858 cutover needs accountant input; quota exhausted before the limit is raised; new HIGH finding in G8 or the swarm. | 2026-11-23 or later (crosses the 2026-12-01 baseline expiry, add G3.1) |

## Sync log

| When (UTC) | Change |
| --- | --- |
| 2026-11-02 00:10 | Version 1 reconciled; 120 mandatory items (90 parents, 30 subtasks); 2 certified complete; 14 rows wait on the owner or a blocked gate. |
| 2026-11-02 00:30 | Main 9139d164 fully landed (Sonar Main success; Trusted Main E2E, Tests green; Contract skew exit 7 only; no Pilot Role Audit run at this tip). G4 evidence updated; counts unchanged. #746 e5b90ddc Tests still in progress, swarm run 41364984802 started. |
| 2026-11-02 00:55 | #746 round 6 at e5b90ddc: Seat 1 CERTIFY, Seat 2 CHANGES_REQUESTED (two MEDIUM privacy oracles, SCRUM-886 c24346). E1 and G1.1 back to IN PROGRESS (Sonnet round 7). Counts: IN REVIEW 13 → 11, IN PROGRESS 28 → 30. Critical path slips by one fix round (~3-5 h). |
| 2026-11-02 01:40 | #746 round 7 pushed at 7cd0cebf (SCRUM-886 c24347): both oracles closed, baseline 938/0. E1 and G1.1 back to IN REVIEW (13 / 28). CI running, seats armed. |
| 2026-11-02 02:25 | #746 round 7 at 7cd0cebf: CI fully green, Seat 1 CERTIFY, Seat 2 CHANGES_REQUESTED (PURCHASE replay oracle, c24348). Round 8 dispatched. E1 and G1.1 back to IN PROGRESS (11 / 30). Critical path slips a second fix round. |
| 2026-11-02 02:56 | #746 round 8 pushed at a38cdb865 (c24349): mode-and-role gate in importBulk, red run 3/15, typechecks 0, baseline 938/0. Body republished; seat waiter armed with a fresh Seat 1 id. E1 and G1.1 to IN REVIEW (13 / 28). Main 9139d164 unchanged. |
| 2026-11-02 03:47 | #746 round 8 at a38cdb865: CI fully green, Seat 1 CERTIFY, Seat 2 CHANGES_REQUESTED (vehicles.create idempotency replay oracle, c24350). Round 9 dispatched to close the class by mechanism. E1 and G1.1 back to IN PROGRESS (11 / 30). Critical path slips a third fix round; earliest launch window now unlikely. |
| 2026-11-02 04:23 | #746 round 9 at 41d1222c4 pushed 04:02Z: actor-bound idempotency replay (mechanism fix for the round-8 oracle), red run 7/13 coordinator-run, body r9 published, SCRUM-886 c24351, seats armed behind CI; E1 and G1.1 → IN REVIEW. Counts IN REVIEW 13, IN PROGRESS 28. Critical path: #746 round 9 seats → merge → #737 re-seat → #740. |
| 2026-11-02 05:20 | #746 round 9 at 41d1222c4: CI fully green; both seats CHANGES_REQUESTED on the same new door, saleCompletion shortfall refusal prints the stored entitlement to a create:sales non-reader (pre-existing on main; c24352). Round-9 fix confirmed. Round 10 dispatched (coded refusal + class sweep). E1 and G1.1 back to IN PROGRESS; counts IN REVIEW 11, IN PROGRESS 30. |
| 2026-11-02 05:50 | #746 round 10 at c705c9dcf pushed 05:40Z (c24353): role derived server-side from the actor's membership, coded no-amount refusal for non-readers on both consigned sale refusals and the cost-derived deposit refusals, class sweep in the oracle doc, D6 mutant survives (test gap, disclosed). Coordinator red run 10/73, green 73/73, baseline 938/0. Body r10 published, seats armed with a fresh Seat 1 id, CI manager told. E1 and G1.1 to IN REVIEW (13 / 28). |
| 2026-11-02 06:39 | #746 round 10 at c705c9dcf: CI fully green; both seats CHANGES_REQUESTED (Seat 1 6570706851, Seat 2 6570706598) with the same threshold oracle via refusal precedence (cost gate before caller-controlled trade-in refusals; deposit door same). Finding accepted, fix modified to a staged completion with a property test; round 11 dispatched to Sonnet; the refuse-all-SOURCED alternative rejected (ACCOUNTANT finalizeDeal). E1 and G1.1 back to IN PROGRESS (11 / 30). |
| 2026-11-02 07:20 | #746 round 11 at fad4751a3 pushed 07:16Z (c24355): caller-aimed trade-in refusals moved ahead of the deposit refusal and the cost gate as Stage 1 of sale completion on every door; overflow pre-check under the pay-first containment; coordinator red run 12/17, green 17/17; mutants M1–M4 killed; baseline 938/0; 12 scenario records; oracle doc (8) Round 11. Body r11 published, seats armed with a fresh Seat 1 id, CI manager told. E1 and G1.1 to IN REVIEW (13 / 28). |
