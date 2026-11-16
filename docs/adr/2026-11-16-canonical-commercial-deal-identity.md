# Use one deal identity before sale completion

The deal is the parent of all vehicles on a quote. Each completed vehicle still has its own sale and journal source. A walk-in draft gets its deal in the same transaction that creates the draft. This implements the first part of the D-3 decision. [SCRUM-455](https://autoflowdealer.atlassian.net/browse/SCRUM-455?focusedCommentId=21736)

## Creation and ownership

Quote creation inserts its deal in the same transaction. Creating an application saves its deal link in the same transaction, including when the quote predates this change. Sale completion can link existing unlinked applications and refuses multiple matches. Both explicit quotes and the fallback from an existing application must match the tenant, customer and exact vehicle record before the sale links to the deal. A conflicting persisted draft link is refused before the completion command claim. A completed command still uses the existing exact replay checks. The full cash quote transaction links every sale line to the same deal.

The canonical document ID is the stored deal link. A linked walk-in draft must match its deal's organization and original organization-unique sale number. Rows created before this change can have an absent deal reference. Completing an existing unlinked draft or application can establish its deal. An unnumbered walk-in draft receives a number in the same transaction. Existing numbers and journal sources are preserved. [Convex table variants](https://docs.convex.dev/database/schemas#unions)

The quote index is scoped to the organization and the quote. Reading that range before creating a deal allows Convex to retry a concurrent transaction that observed the same empty range. The existing idempotency wrappers remain responsible for command retries. Financial reset processes sale and application children before deals and linked deals before quotes. Full organization deletion converts each affected quoted deal to the detached variant in bounded batches before deleting the quote. Its existing cursor holds at the quote until every link has been cleared. A later step removes the deals after their linked sales and applications. [Convex index ranges in transaction read sets](https://stack.convex.dev/how-convex-works) · [Convex indexes](https://docs.convex.dev/database/reading-data/indexes)

## Financial work required before activation

Rekey fee, custody, closeout and ledger proof lookups to the new deal while preserving posting IDs. Verify exact-once payment and reversal across a multi-vehicle deal and its individual sale lines. Then enforce the deal-level closeout across the four completion commands and ship the Arabic and English workflow.

The cash full-payment rule currently counts a quote deposit or an eligible named opening deposit. Ordinary deposit creation requires a quote. A real quote-less walk-in therefore needs a verified deal-scoped funding source before it can complete under the same full-payment rule. The ledger and receipt allocation must prove the actual amount before sale completion. Cancellation must use that same funding source and support a verified refund or other existing disposition. [SCRUM-802](https://autoflowdealer.atlassian.net/browse/SCRUM-802)

## Public contract evidence

The renewal covers 106 existing entries across 22 registered exports in `adminOrgs`, `applications`, `quotes` and `sales`. The client files match the base bytes. The local Convex registration exports the same argument and return validators as the base for each function. Each entry keeps its original uncertainty, fingerprint, multiplicity, expiry and complete prior renewal text. A new statement describes what changed in each defining module and records its exact current blob. [Initial hosted check](https://github.com/aalzriqat/Auto/actions/runs/43893211512/job/133389664251)

Application creation changes four lines in the protected module. Its source pin is renewed against the new normalized bytes. The pin still checks both byte count and SHA-256. The independent review of this revision is pending.
