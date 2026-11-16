# Use one deal identity before sale completion

The deal is the parent of all vehicles on a quote. Each completed vehicle still has its own sale and journal source. A walk-in draft gets its deal in the same transaction that creates the draft. This implements the first part of the D-3 decision. [SCRUM-455](https://autoflowdealer.atlassian.net/browse/SCRUM-455?focusedCommentId=21736)

## Creation and ownership

Quote creation inserts its deal in the same transaction. An application resolves its deal through its existing quote. Sale completion persists the deal link on the application and sale after verifying the source records. Completion can create the deal for a verified older quote and refuses multiple matches. The existing sale completion preflight validates the quote, customer and vehicle before linking a sale. A draft's existing deal must belong to its organization and represent a walk-in. The full cash quote transaction links every sale line to the same deal.

The existing per-organization deal number is a display value. Multiple older standalone sale rows can carry different display numbers even when they came from the same quote. Leave each historical number and journal source intact. Rows created before this change can have an absent deal reference. Completing an existing unlinked draft or application can establish its deal. Previously completed sales retain their original records.

The quote index is scoped to the organization and the quote. Reading that range before creating a deal allows Convex to retry a concurrent transaction that observed the same empty range. The existing idempotency wrappers remain responsible for command retries. Financial reset processes sale and application children before deals and linked deals before quotes. Full organization deletion sweeps deals in its existing suspended-organization lane. [Convex atomicity and conflict handling](https://docs.convex.dev/database/advanced/occ) · [Convex indexes](https://docs.convex.dev/database/reading-data/indexes)

## Financial work required before activation

Rekey fee, custody, closeout and ledger proof lookups to the new deal while preserving posting IDs. Verify exact-once payment and reversal across a multi-vehicle deal and its individual sale lines. Then enforce the deal-level closeout across the four completion commands and ship the Arabic and English workflow.

The cash full-payment rule currently counts a quote deposit or an eligible named opening deposit. Ordinary deposit creation requires a quote. A real quote-less walk-in therefore needs a verified deal-scoped funding source before it can complete under the same full-payment rule. The ledger and receipt allocation must prove the actual amount before sale completion. Cancellation must use that same funding source and support a verified refund or other existing disposition. [SCRUM-802](https://autoflowdealer.atlassian.net/browse/SCRUM-802)

## Public contract evidence

The initial hosted check identified 68 stale renewal records. Restoring the pinned applications module to the base bytes limited the renewal to 46 existing entries across four registered exports in `adminOrgs` and `quotes`. Those client files match the base bytes. A local comparison found equal native exported argument and return validators for the four exports. The original uncertainty, fingerprint, multiplicity and expiry are preserved. [Initial hosted check](https://github.com/aalzriqat/Auto/actions/runs/43893211512/job/133389664251)
