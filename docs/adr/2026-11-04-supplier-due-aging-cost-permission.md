# Supplier due-aging list needs view:cost_price

Status: accepted and implemented. ADR required before a permission PR by SCRUM-760 c24361. Jira: SCRUM-901 (related SCRUM-886, SCRUM-869).

## Context

`api.supplierDueAging.list` (`convex/supplierDueAging.ts`) returns one row per supplier obligation with `outstandingMinor` and
`disputedMinor`, plus per-currency totals. It authorized on `view:finance` alone. For a SOURCED (consigned) car the supplier's
entitlement equals the acquisition cost, so every amount on this list is cost-derived. The supplier statement (#763) already
requires `view:cost_price` as well (`STATEMENT_PERMISSIONS`). Seat 1 found the gap on #763 as a pre-existing finding on main.

Default roles are not affected: OWNER, ACCOUNTANT and SENIOR_ACCOUNTANT hold both grants (`convex/utils/permissions.ts`). A custom
role with `view:finance` and without `view:cost_price` can read the amounts today.

## Decision

`list` calls `requireTenantAuth(ctx, orgId, STATEMENT_PERMISSIONS)`, the constant exported by `convex/supplierStatement.ts`, so the
two supplier-amount readers share one definition and cannot drift. The check covers all three families (PAYABLE, RECEIVABLE,
RECOVERY): margin receivables and cost recoveries are derived from the same supplier entitlement, and a per-kind exception would
leave a family readable by a role that is refused on the statement. A refusal names the missing permission and returns nothing,
rows and totals alike (OWASP API3:2023, property level authorization).

Rejected alternative: redact the amounts and keep the rows. A due date and bucket beside a hidden amount still reveals which
obligations exist, and a zero would read as "nothing owed". Absent beats zeroed, as in `vehicleCostVisibility.ts`.

## Consequences

- Permission: `view:finance` and `view:cost_price` both required, owner passes via `requireTenantAuth`.
- No screen calls this query today (searched `app/`, `components/`, `apps/mobile`, `lib/`), so there is no refusal state to
  design and no EN/AR copy to add. A future screen must ask for the pair first and show the gated note, as the statement does.
- The alert worker reads the same rows through `readObligationPage` (`convex/supplierDueAlerts.ts`), not through this query, and
  notifies `view:finance` or `manage:finance` holders. Whether alert text carries amounts is a separate question for the alerts
  slice (held branch), recorded in the PR body.
- Other supplier-amount readers behind `view:finance` alone are listed in the PR body sweep table. They have screen consumers and
  are not changed here.
