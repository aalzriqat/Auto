# Vehicles, Customers, and Leads UI delivery notes

This branch intentionally contains UI-only work. It does not change Convex functions, schemas, permissions, accounting code, or other domain models.

## Delivered in this branch

### Vehicles

- Saved views, active filter chips, loaded/result counts, sorting, table/card preference, row selection, CSV export, and bulk status changes.
- Richer table and card layouts with thumbnails, VIN, model, status, price, inventory age, mileage, and missing-data warnings.
- Full-row and full-card navigation into vehicle details.
- Five detail groups: Overview, Sales Activity, Operations, Financials, and Marketing. The prior detail areas now appear as sections within those groups.
- A five-step Add Vehicle flow: VIN, vehicle details, acquisition and cost, photos, and availability.
- Archive is isolated from normal Edit actions and presented as a recoverable destructive action.

### Customers

- Contact-channel segmentation, active filters, and loaded/result counts.
- Existing server-backed duplicate detection remains visible before submission.
- Customer details now use Activity, Deals, and Financials. Activity combines leads, sales, quotes, and tasks chronologically.
- Visible Call, WhatsApp, Email, New Lead, and New Quote actions.
- Merge preview now explains the surviving record, archived record, relationship reassignment, chosen field values, audit trail, and recoverability before confirmation.

### Leads

- Persistent List/Board preference, stage and source filtering, results count, and selection.
- Actionable board stage movement using the existing lead update mutation.
- Cards and rows show age, last activity, vehicle interest, owner, suggested next action, and stale state.
- Bulk assignment and bulk stage movement through existing per-lead mutations, with partial-failure feedback.
- A dedicated lead workspace with timeline and stage history, customer and vehicle context, messages, linked tasks, linked quotes, and overdue-task indicators.

## Deliberately held backend/domain work

These requirements must not be implemented as client-side-only filtering or invented placeholder data.

### Lead visibility authorization

Non-manager users must only receive leads they created or leads assigned to them. This must be enforced server-side for:

- list, pagination, search, counts, and board data;
- direct `get` access and deep links;
- related activity, messages, tasks, quotes, and stage history;
- update, delete, bulk assignment, and bulk stage operations;
- notifications and any exports that resolve lead data.

The server should resolve the manager role/permission from the authenticated organization membership, then apply `createdBy === currentUserId OR assignedUserId === currentUserId` for non-managers. Tests should cover list leakage, direct-ID access, pagination, reassignment, unassigned leads, and cross-organization access.

### Missing list data

- Vehicles need a durable stock number and a branch display name included by the authorized vehicle list query. The schema currently has `branchId`, but the available branch-name query requires settings permission and therefore cannot safely be called by every inventory viewer.
- Customers need persisted tags/segments plus list-safe summaries for recent activity, outstanding balance, last contact, and assigned salesperson.
- Leads need a persisted intent field (and an agreed intent taxonomy) before intent can be shown accurately on list and board cards.
- Lead list cards need a server-provided next incomplete follow-up and due state. The current UI labels its stage-based guidance as a suggested next action; real overdue task state is shown only where linked task data is already available in the lead workspace.

### Bulk operations

The current bulk controls call existing single-record mutations and report partial failures. Purpose-built server mutations should later make bulk stage movement and assignment atomic, authorize every target, cap batch size, and write one auditable operation summary.
