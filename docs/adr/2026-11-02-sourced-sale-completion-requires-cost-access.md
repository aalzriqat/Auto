# Completing a SOURCED sale requires view:cost_price

Status: accepted. ADR required by SCRUM-760 c24361.

## Context

A caller who held `create:sales` or `confirm:finance_disbursement` without `view:cost_price` could still learn the hidden
supplier entitlement. The backend used the vehicle cost to decide, so the outcome of a completion leaked it through refusal
text, stored-value comparisons, replay fingerprints and the order in which refusals fired. Seven sibling leaks were closed
one by one over PR #746 rounds 6 to 12, and each fix left a new sibling behind.

## Decision

Owner ruling SCRUM-886 c24358, 2026-11-02: completing or finalizing a SOURCED sale requires `view:cost_price` on every door
(`sales.create`, `sales.completeDraft`, `sales.completeFromQuote`, `applications.finalizeDeal`). The server refuses it with
`CONSIGNED_SALE_NEEDS_COST_ACCESS` as the first decision of the door, before any cost read, keyed on `sourceType` and the
actor's permission only. These are completion doors: `sales.create` accepts only COMPLETED. Saving a PENDING draft
(`sales.createDraft`) is not gated, because the draft path makes no decision that depends on a cost value; the refusal comes
when the draft is completed through `sales.completeDraft`. The default ACCOUNTANT template gains `view:cost_price`. Saving a custom role (`roles.create`,
`roles.update`) with either completing permission and no `view:cost_price` is refused with a coded EN/AR message. Stored
custom roles are not migrated; one that already holds the combination is refused at the door and reported.

## Role policy

After the change, the default roles that may complete a SOURCED sale are OWNER (system owner), MANAGER, ACCOUNTANT and
SENIOR_ACCOUNTANT. SALES holds neither completing permission and cannot complete a sale. RECEPTION holds neither. A custom
role may hold a completing permission only together with `view:cost_price`.

As a consequence of the template grant, the default ACCOUNTANT also passes the `vehicles.correctAcquisitionCost` gate, which requires `manage:finance` and `view:cost_price` together, and may post acquisition-cost corrections. Before this change only SENIOR_ACCOUNTANT and the system owner could: the default MANAGER template holds `view:cost_price` but not `manage:finance`, so MANAGER is refused at that door, and a test pins it. The owner allowed this (SCRUM-886 c24368, option A, 2026-11-02) and it is proved by a test that runs the correction as the default ACCOUNTANT. A legacy stored per-org ACCOUNTANT role that still lacks `view:cost_price` remains refused at that door until the backfill (c24365, owner decision still open) runs.

## Consequences

The round 10 to 12 ordering fixes stay as defence in depth; a non-reader no longer reaches them through a door. Existing
per-org ACCOUNTANT roles do not receive the template change on their own: a bounded, idempotent internal mutation in
`convex/migrateRoles.ts` adds the permission, is run by hand, and is not wired into any workflow. Owner approval is required
before it runs against any deployment (SCRUM-886 c24358).
