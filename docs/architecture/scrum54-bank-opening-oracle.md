# SCRUM-54 bank opening balance oracle

These are independent expected values in minor units. They define the bank display and opening proof for a fresh JOD organization; a passing `convex-test` run is harness evidence only. Platform and production proof remain separate gates.

| Case | Posted ledger facts | Required book result |
| --- | --- | --- |
| B54-OB1 | Opening Dr BANK_ACCOUNT 700,000 JOD tagged Bank A; Dr BANK_ACCOUNT 300,000 JOD tagged Bank B; Cr capital 1,000,000 JOD. | Bank A 700,000; Bank B 300,000; bank control 1,000,000. Neither reference opening field contributes. Posted opening details retain both bank names and all three amounts. |
| B54-OB2 | B54-OB1 plus a posted BANK_ACCOUNT debit 50,000 JOD without `bankAccountId`. | Both JOD bank balances unavailable. The bank control total exceeds identified bank lines by 50,000; no amount is assigned by inference. |
| B54-FX1 | Bank J holds attributed 700,000 JOD; Bank U holds attributed 30,000 USD minor units; a further posted USD bank-control debit of 5,000 has no bank identity. | Bank J remains 700,000 JOD and OK; Bank U is unavailable with USD unmatched 5,000. USD never contaminates JOD. |
| B54-SNAP1 | Prior elapsed period snapshots and lines contain Bank J 700,000 JOD and Bank U 30,000 USD. Current-period attributed lines add 100,000 JOD and 5,000 USD. | Bank J 800,000 JOD; Bank U 35,000 USD. Elapsed-period control totals come from snapshots, while physical-bank attribution comes from posted lines. |
| B54-CLOSE1 | Bank U has an attributed 30,000 USD balance and is then deactivated. | A read-only historical row continues to show Bank U and 30,000 USD. A deleted bank at a verified zero balance may be omitted. |

An incomplete read budget, mismatched journal/line date or period, or missing bank identity must withhold the affected displayed balance. This table does not certify producer coverage, closed-period platform behavior, Convex read cost, deployment order, or Bloom Cars' actual balances.
