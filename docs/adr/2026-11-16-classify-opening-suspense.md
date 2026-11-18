# Classify an untouched opening suspense balance with independent approval

Account 1900 stores a dealer's opening imbalance until finance identifies the correct account. For an opening whose suspense and destination accounts remain untouched, a finance user can propose transferring the full suspense balance to a named ledger-only account. A different finance user approves that exact request. The adjustment is dated in the original open period and leaves the original opening journal posted. [SCRUM-961](https://autoflowdealer.atlassian.net/browse/SCRUM-961) · [Opening correction policy](./2026-11-08-opening-balance-edit-void-correct.md)

## Preconditions and posting

Request and approval prove the original journal against the posted draft. Both query the source and destination by account and creation time. This detects a posting written later even when its accounting date predates the opening. The query includes the opening timestamp and excludes only verified rows from the original journal. A new row on either account or an unavailable opening period refuses the write. The destination must be active, support direct posting and represent a ledger-only account with no bank, cash or native subledger semantics.

Approval checks the request version, the distinct finance user, the amount and the original journal again. It posts two opposite lines, increments snapshots, records the approved journal and writes audit metadata in one Convex transaction. A replay verifies the linked adjustment and its exact lines. The trial-balance test reads the same consumer used by finance. [Convex atomicity and conflict handling](https://docs.convex.dev/database/advanced/occ) · [Convex indexes](https://docs.convex.dev/database/reading-data/indexes)

The financial reset retains opening drafts. Its existing preflight refuses a fresh reset when it finds one, preserving the classification and both journals and accounts. Full organization deletion already drains opening drafts before removing ledger records.

## Remaining acceptance

The setup card exposes the request, exact version approval and dismissal in Arabic and English. Dismissing a pending version does not post and allows a new request. The three commands remain unclassified in the pilot inventory pending release review.

This slice covers full classification of one opening difference. Prepaid correction must verify the original allocation and any adjustment chain separately from its mutable schedule. It also needs proof of no recognized or queued activity, exact amortization after correction, and a governed reversal.
