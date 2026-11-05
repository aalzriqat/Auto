# Every deal has a per-organization deal number; the Convex id stays its identity

Status: accepted (implementer decision on the coordinator's recommended design; open to owner review). Implements SCRUM-808.

## Context

Staff identify a deal by its Convex document id, which the deal screen shows in full and abbreviates in its title as the
last four characters (`#k7x2`). Neither can be said aloud or typed back. The owner asked for a short, shareable number,
with the existing id kept as the key so that the system can later be split across databases.

A deal is stored in one of two tables. A CASH deal is a `sales` row. A FINANCED deal is a `financeApplications` row until
`applications.finalizeDeal` creates its `sales` row, which carries `applicationId` and is the same deal (the Deals list drops
it in favour of the application). There are exactly two production insert sites: `insertSaleRecord`
(`convex/utils/saleCompletion.ts`, reached by `sales.create`, `sales.completeFromQuote`, `sales.createDraft` and
`applications.finalizeDeal`) and `applications.createFromQuote`. No import, seed or dynamic-table insert writes either table,
and the admin data browser refuses both (they are financial tables).

## Options

| Option | Example | For | Against |
| --- | --- | --- | --- |
| **A. Six-digit sequential with a short prefix** | `D-000123` | Fixed width reads and sorts well in lists and on paper; the prefix says "deal" when the number stands alone in a message; survives a showroom rename; trivially typed back as `123`. | Leading zeros are noise for a small dealer. |
| B. Plain integer | `123` | Shortest. | Ambiguous out of context (a price? a stock number?); varying width in lists. |
| C. Showroom name plus digits | `BLM-0123` | Says whose deal it is. | Needs a code per organization and a rule for renames; the code changes or the history lies. Solves a problem a single-tenant view does not have. |

## Decision

Option A. The stored value is a positive integer, `dealNumber`, on `sales` and `financeApplications`. It is shown as
`D-` plus the number zero-padded to six digits (`formatDealNumber`, `convex/utils/dealNumberFormat.ts`). Past 999999 it
grows a seventh digit; it never wraps. Search accepts `D-000123`, `D123`, `#123`, `123` and Arabic-Indic digits. An org code
in the prefix (option C as display only) can be added later without touching storage.

### Allocation

- One `dealNumberCounters` row per organization holds the last number handed out. `allocateDealNumber`
  (`convex/utils/dealNumber.ts`) reads it, adds one and writes it back in the same mutation that inserts the deal.
- Convex mutations are serializable transactions under optimistic concurrency control: a transaction whose read set was
  written by a concurrent commit is re-run ([Convex: OCC and Atomicity](https://docs.convex.dev/database/advanced/occ)).
  Two creations for one organization both read the counter (or, for the first deal, the empty index range where it would
  be), so they cannot both commit with the same number. No lock, no read-max-plus-one, no count, no scan.
- The counter is a separate table, not a field on `organizations`. Almost every mutation reads the organization row;
  writing it on each deal would put all of them in conflict with every deal creation. Convex's guidance is to avoid many
  writes to one hot document ([Convex: Errors and Warnings, write conflicts](https://docs.convex.dev/error)); a showroom
  creates a handful of deals an hour, so one row per organization is far below the contention that would need a sharded
  counter (which also could not give a sequence).
- A sale finalized from an application copies the application's number (`dealNumberForNewSale`): one number per deal,
  however many sale rows a multi-car application produces.
- Not gapless, by design: a cancelled or deleted deal keeps its number, and a creation that rolls back releases nothing
  because the counter write rolls back with it. Shopify's order `number` makes the same trade, documented as not
  guaranteed consecutive ([Shopify Admin API: Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order)).
- Defence in depth: allocation refuses if the next number is already held by a deal in that organization (a counter
  restored or edited by hand), instead of issuing a duplicate. Lookups use `by_org_dealNumber`.
- Immutable: no public mutation accepts `dealNumber`, both tables are refused by the admin data browser, and the counter
  table is not in its table list.

### Scale and future databases

The number is scoped to its organization, the same shape as Stripe's account-level invoice sequence, where each merchant
of record keeps its own sequence ([Stripe: invoice numbering](https://docs.stripe.com/invoicing/customize#invoice-numbering-schemes)).
The global identity stays the Convex `_id`: routes, references and relationships are unchanged. If AutoFlow is ever
sharded by organization, each organization's counter lives with its deals in one shard, so allocation stays a
single-shard transaction and two shards can never collide, because the pair `(orgId, dealNumber)` is the unique key, not
the number alone. A design that moved one organization across shards would move its counter with it.

### Existing deals

`dealNumberBackfill:runPage` (internal) numbers rows created before this release. It reads only rows whose number is
unset (`by_dealNumber`), both tables merged in creation order, at most `numItems` rows of each table per call, and allocates
from the same counter. A numbered row leaves that index range, so each page starts at the earliest row still unnumbered
and the cursor only counts pages. A page numbers rows up to the last creation time of the earlier full read, so it always
advances. So it is bounded, resumable and idempotent, and a re-run on a later deploy reads nothing. It runs as
phase 2f of the Deploy production rollout (`runDealNumberBackfillPhase`, `scripts/releaseGuard.ts`), after the ACCOUNTANT
cost-price phase and before the Social Inbox verification, under the shared deadline, with the same failure semantics
("Production is DEPLOYED, but ...") and a counts-only public summary.

The two `by_dealNumber` indexes exist only for this walk. Once a production rollout reports the walk done, a follow-up
release can drop them; `by_org_dealNumber` stays for lookups.

Disclosed ordering limit: a deal created after the deploy and before the walk reaches older rows takes the next number at
creation, so it can be numbered below an older deal. Uniqueness never depends on order. The walk runs minutes after the
deploy, so the window is short. A deal shown before the walk reaches it has no number yet; the screens fall back to the
id reference for it.

## Where staff see and type it

- Deal screen: the title shows `D-001042` (the id tail only for a deal the backfill has not reached), and the identity
  strip shows the number with a copy control above the full id.
- Deals list: the number leads each row's vehicle line; the search box finds a deal by its exact number, typed as
  `123`, `D-000123`, `#123` or in Arabic-Indic digits. It filters the loaded rows only.
- Global search (Ctrl+K): a deal-number query returns that deal and opens its screen, including a deal not loaded in
  the list. One-digit numbers search too.
- Numbers render left to right (`dir="ltr"`) inside Arabic text.

## Evidence boundary

`convex/dealNumber.scrum808.test.ts` drives the real doors and the backfill in convex-test, which runs mutations one at a
time. It proves the number is allocated in the creating transaction and nowhere else; it cannot race two transactions,
so the concurrency property rests on Convex's documented serializability, cited above.

## Not changed

- No route, permission, accounting, finance or relationship logic. The deal number is projected as an open field to every
  role that already sees the deal (`view:sales`).
- `apps/mobile` does not show the number yet (the pilot is web-only); its global search response gains the additive
  `deals` field and ignores it.
