# Opening deposit refunds use cash during the pilot

Date: 2026-11-16
Status: Accepted for implementation under SCRUM-956 comment 25206; certification pending.

## Invariant and authority

Under the pilot configuration no opening-deposit refund leaves through a bank account, and none can be reserved for one. Cash refund reservation, payout and unpaid cancellation remain in pilot scope. Custody recovery remains owner only, without impersonation. [SCRUM-956 comment 25298](https://autoflowdealer.atlassian.net/browse/SCRUM-956?focusedCommentId=25298) allows the opening drafter and opening approver to act on cash refunds with current refund authority and the same reservation controls. A future role setting can govern this eligibility.

## Decision

Reuse the reviewed compile-time switch mechanism in `convex/utils/pilotSwitches.ts`, existing `throwAppError` codes and EN/AR `ServerError_...` translations. Register the switch and guards in the pilot capability manifest. Authentication and tenant ownership checks remain in place. Refuse before idempotency or other writes, and let the error escape the mutation transaction.

Two designs were considered:

1. Refuse bank reservations only. This prevents new reservations but lets a historical bank reservation reach payout, so it violates the invariant.
2. Refuse new bank reservations, every bank payout and bank returns. Choose this design because each public economic door enforces the shipped policy independently of historical stored data or a stale client.

## Entry points and readers

| Entry | Control under the pilot |
| --- | --- |
| `openingDepositRefunds.reserveOpeningRefund` | Refuse BANK_TRANSFER before idempotency; retain CASH validation and posting authority. |
| `openingDepositRefunds.recordOpeningRefund` | Refuse a stored BANK_TRANSFER reservation before idempotency; retain CASH posting and exact replay. |
| `openingRefundReturns.recordBankReturn` | Refuse the whole door after authentication, before statement reads or writes. |
| `openingDepositRefunds.cancelOpeningRefundReservation` | Keep both stored methods cancellable with existing custodian/key and confirmed-nonpayment checks. |
| `openingRefundCustody.recoverOpeningRefundCustody` | Genuine Owner authority and proof of transferred control are required. Either opening-entry actor can recover cash custody if qualified as Owner. Recovery preserves the method and amounts. |
| `openingRefundCustody.openingRefundReservation` | Existing tenant/approver/custodian control returns historical method and owned bankAccountName; it does not pay. |
| `openingRefundReturns.archivedRefundRecovery` | Reads previously matched returns only, under existing authority; subsequent refund reservation is cash only. |
| `OpeningDepositRefundDialog` | Shared switch offers cash only and explains bank refusal. Historical bank reservation remains visible and cancellable, with payout unavailable. Server is authoritative. |
| Reports, receipts and bank reconciliation | Read historical payments, events and journals; no new bank refund artifacts can be created through the guarded doors. Historical records remain readable. Bank-return dialog may still submit, but the server refuses it. |

A BANK_TRANSFER reservation that already exists stays HELD and cancellable. Custody recovery can preserve its method so an eligible owner can cancel it. It cannot pay out. No migration, production query or production data change is part of this decision. Historical completed bank payouts cannot be returned through the pilot bank-return door, as explicitly ruled by the owner.

## Evidence and limits

Public-mutation `convex-test` cases must prove the shipped configuration, literal refusal codes, literal monetary amounts, zero additional artifact counts on rejection, historical cancellation and the custody role matrix. Existing bank lifecycle tests remain post-pilot tests with an explicit NON-PILOT-CERTIFYING configuration. Removing each new entry-point check must fail a behavior test. Harness results do not prove native Convex execution or OCC. Browser rendering and independent seats remain required before activation certification.

This follows [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors) and [atomic mutations](https://docs.convex.dev/database/advanced/occ), and [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) to enforce policy on each server request. Documentation supports the design; the tests must establish its implementation.
