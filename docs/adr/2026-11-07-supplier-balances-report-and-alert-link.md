# Supplier balances report and actionable due alerts

Date: 2026-11-07 · SCRUM-929 / SCRUM-869 · Status: accepted for implementation

## Invariant and impact

For each supplier and currency, the report must equal the outstanding statement to the minor unit. Payables and receivables remain separate; the net is informational and authorizes no settlement or offset. Incomplete evidence withholds figures. This is a read-only feature: no GL, settlement, due-date, opening allocation or financial containment changes.

Readers affected: the new Suppliers balances page, supplier statement presentation, and notification renderer. The only writer changed is `supplierDueAlerts.processOrgSupplierDueAlerts`, which inserts in-app notifications. Its operation, idempotency key, occurrence, recipient and continuation rules remain unchanged. Existing notification rows retain their stored links; there is no migration (c23871).

## Two designs

A. A server query pages the supplier registry and calls `readSupplierOutstanding` sequentially for each supplier. It uses the existing supplier/status indexes, `STATEMENT_FAMILY_LIMIT` and shared transaction headroom. Each supplier's complete sections supply the exact same totals as the statement. This repeats some statement reads, but bounds them and avoids a second financial truth or write-maintained aggregate.

B. The browser pages all three `supplierDueAging.list` families, resolves supplier links, and aggregates them. Those rows currently lack supplier identity; adding it would broaden that public contract. Pages span snapshots, read settled history too, and a browser interruption could produce misleading prefix totals. Moving completeness, money and attribution logic into the client also violates the backend-only owner rule.

Choose A. One native supplier page per invocation, at most five suppliers, with sequential shared-budget reads. No cross-currency sum or book-wide total is returned. A supplier with an incomplete side has no currency figures at all. `complete` describes the entire bounded report: false for multiple supplier pages, continuation pages, or any incomplete supplier; `isDone` describes navigation only. Complete supplier rows on a partial report remain usable. The UI explicitly calls the report partial and offers page navigation; it never accumulates page sums.

`supplierBalances.get` exposes the identical projection for a single owned supplier's summary tiles. It uses `requireOwnedRow` and the same permission/feature gates. The existing `supplierStatement` response is unchanged, including its explicit no-net contract. Detail summary reads duplicate the bounded outstanding read; they introduce no stored aggregate and no additional financial writer.

The report includes active and inactive registry suppliers, including zero-balance suppliers. Like the statement it includes only obligations linked by stored `supplierId`, and excludes unallocated openings and id-less legacy rows. The screen states that scope; it makes no claim to equal the entire GL. Disputed amounts remain in gross and overdue, with disputed payable/receivable amounts also shown separately. Positive net means the supplier owes the showroom; negative means the showroom owes the supplier. Oldest due date is the earliest known due date among open obligations in that currency, including disputed rows. Missing due dates stay unknown.

## Permissions, clock and errors

The report requires `STATEMENT_PERMISSIONS` (`view:finance` and `view:cost_price`) and the accounting feature, enforced server-side through authenticated tenant membership. It accepts no supplier id. Foreign organization requests refuse. A report read failure logs technical detail server-side and returns a generic Convex error; existing permission/plan refusals retain their established shape.

`nowMs` is an explicit, finite, safe integer within the JavaScript date range; the query never reads `Date.now()`. It is an aging reference, not a historical ledger snapshot. The client refreshes the argument hourly, like the statement. No monetary authority depends on that clock.

Alert attribution uses only the obligation's stored supplier id, exactly the statement's attribution; it never guesses from legal/display names or a vehicle. Verify the linked supplier's tenant. Rename-safe links target `/<org>/suppliers/<supplierId>`; an absent, deleted or foreign supplier targets `/<org>/suppliers/balances`. The current supplier display name is included only for recipients allowed to read the amount. Treating the name as cost-derived is deliberately conservative: the alert reveals a financial relationship. Other recipients receive directional, unnamed, amount-free copy. Unresolved suppliers get localized generic wording without invented identity. Existing notification types and legacy generic translation keys retain their meaning; new directional variants are selected only for recognized kinds.

## Screens and editing

Add a balances report page linked from the Suppliers list, with a back link and statement links on each row; no new top-level navigation. Reuse `formatExactMinorAmount` / `moneyDisplayLabel` from the statement (JOD three decimals). CSV is deferred: exporting a paged/incomplete report needs explicit scope and is not a trivial reuse of a complete-report export.

Part 3 is committed separately after the behavior. Use the app's Tailwind v4 `app/globals.css` tokens, shadcn Card/Tabs/Table/Dialog/Skeleton/Badge, cockpit semantic money colors and dashboard spacing. There is no Tailwind config file in this checkout. Use `money-out` for showroom obligations and `profit-positive` for supplier obligations, with text direction as well. Keep logical alignment and `<bdi>` for RTL. Desktop tables have headers and hover rows; phone rows stack as cards. Detail opens as a read-only header/profile card. Summary tiles use the server report projection of that same outstanding result, never client money calculations. Outstanding, Settled and Payments occupy tabs.

Editing follows the existing `CustomerDialog` / `SupplierCreateDialog` Radix dialog pattern. Move the existing supplier form without changing fields, validation, revision token or mutation arguments. `manage:finance` controls the Edit button, as before. Save closes; Cancel, Escape and outside dismissal confirm dirty changes. Creating uses the same existing SupplierFields in a dialog, with dirty-discard confirmation too. No permission is widened.

## Design attacks and proof plan

1. Renamed supplier / conflicting legal name: stored id wins; public alert and report read use current display name.
2. Missing or foreign supplier link: generic alert falls back to report; no foreign name escapes.
3. Recovery settled that day / cancelled receivable: closed rows disappear from the outstanding report exactly as the statement does.
4. Disputed payable and simultaneous A/R: gross, overdue and disputed remain separate; no automatic offset.
5. Two currencies / Amman midnight / oversized book: literal per-currency minor units, explicit day-boundary aging, and unavailable totals when bounded evidence is incomplete.

Tests run through registered Convex functions with real documents and literal money expectations, plus EN/AR component tests. Harness success proves harness behavior, not Convex cloud limits, concurrency, rendered UI or pilot certification. Coordinator performs independent seats and rendered EN/AR desktop/phone verification.

## Sources checked

- [Convex best practices](https://docs.convex.dev/understanding/best-practices): bounded/indexed reads and explicit time arguments for reactive aging.
- [Convex pagination](https://docs.convex.dev/database/pagination) and [transaction headroom](https://docs.convex.dev/database/writing-data): one bounded page, byte-aware reads, no silent prefix totals.
- [Oracle Receivables reports](https://docs.oracle.com/en/cloud/saas/financials/26b/faofc/oracle-receivables-predefined-reports.html): outstanding open-item aging by date/currency. This feature reports current obligations aged at the reference date; it does not claim historical reconstruction or GL certification.
- [WAI tables](https://www.w3.org/WAI/tutorials/tables/), [WCAG 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html), and [ARIA modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): native table semantics, text alongside color, labelled modal focus behavior.
