# Classify an untouched opening suspense balance with independent approval

Account 1900 stores a dealer's opening imbalance until finance identifies the correct account. For an opening whose suspense and destination accounts remain untouched, a finance user can propose transferring the full suspense balance to a named ledger-only account. A different finance user approves that exact request. The adjustment is dated in the original open period and leaves the original opening journal posted. [SCRUM-961](https://autoflowdealer.atlassian.net/browse/SCRUM-961) · [Opening correction policy](./2026-11-08-opening-balance-edit-void-correct.md)

## Preconditions and posting

Request and approval prove the original journal against the posted draft. Both query the source and destination by account and creation time. This detects a posting written later even when its accounting date predates the opening. The query includes the opening timestamp and excludes only verified rows from the original journal. A new row on either account or an unavailable opening period refuses the write. The destination must be active, support direct posting and represent a ledger-only account with no bank, cash or native subledger semantics.

Approval checks the request version, the distinct finance user, the amount and the original journal again. It posts two opposite lines, increments snapshots, records the approved journal and writes audit metadata in one Convex transaction. A replay verifies the linked adjustment and its exact lines. The trial-balance test reads the same consumer used by finance. [Convex atomicity and conflict handling](https://docs.convex.dev/database/advanced/occ) · [Convex indexes](https://docs.convex.dev/database/reading-data/indexes)

The financial reset retains opening drafts. Its existing preflight refuses a fresh reset when it finds one, preserving the classification and both journals and accounts. Full organization deletion already drains opening drafts before removing ledger records.

## Remaining acceptance

The setup card exposes the request, exact version approval and dismissal in Arabic and English. Dismissing a pending version does not post and allows a new request. The three commands remain unclassified in the pilot inventory pending release review.

## Native prepaid amount correction

The prepaid schedule carries a separate approval history. Finance can propose a new minor-unit amount for an untouched opening asset using a qualifying equity account from the original journal. A different finance user approves the exact version. The original opening and its allocation remain intact. The adjustment and account snapshots are posted in the original open period in the same transaction that establishes the corrected schedule basis.

The schedule reader verifies the original allocation and the exact journal pair before amortization. A separately requested and approved reversal posts the opposite delta and restores the original schedule amount if neither account has later activity and the schedule has no recognition. A serial backend fixture verifies native amortization after the correction and after the reversal. Arabic and English finance screens expose requests and approvals.

The existing full organization purge does not cover prepaid schedules or their child tables. Their financial reset survivor check protects a fresh reset. Full deletion coverage and authenticated browser verification remain release requirements.
