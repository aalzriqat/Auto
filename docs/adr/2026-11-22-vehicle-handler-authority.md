# Vehicle authority stays with the registered handlers

Status: proposed in [SCRUM-963](https://autoflowdealer.atlassian.net/browse/SCRUM-963).

## Context

Web and mobile callers use the registered `api.vehicles` functions. The permission matrix and tenant write guard inspect the registered source to detect changes in authority and document ownership. The inline implementation had grown to 4,836 physical lines.

## Decision

Keep the existing registrations, validators, tenant and role checks, and caller-supplied document ownership checks in `convex/vehicles.ts`. Move inventory reads and vehicle operations into typed helpers that receive the calling function's Convex context. Acquisition, cost correction, import retry evidence and reservation holds use that context for their reads and writes within the original mutation transaction. [Convex helper guidance](https://docs.convex.dev/understanding/best-practices#use-helper-functions-to-write-shared-code) · [Convex mutation transactions](https://docs.convex.dev/functions/mutation-functions)

Callers need the existing operation-specific vehicle permission. An update needs `EDIT_VEHICLES`. A consignment buyout also needs `MANAGE_FINANCE`, checked at the buyout step. The acquisition correction command and its context query require `MANAGE_FINANCE` and `VIEW_COST_PRICE`. Sourced intake checks `VIEW_VEHICLES` and then applies its existing role checks to the submitted fields. Bulk import checks `CREATE_VEHICLES` and applies the existing cost access checks before writes. Inventory reads apply cost visibility to the authenticated role.

## Verification

Compare the ordered registrations, validators and permission matrix against the base. Exercise ownership refusals, cost visibility, posting and reversal paths, and import retries through the registered handlers. The permission matrix regression covers the sourced intake, import and buyout permissions that went missing from the census in the first extraction.
