import type { Audience } from "./sideEffectOracle";

/**
 * Action → expected in-app notifications (SCRUM-620). Every row names the code
 * that makes the promise, so a reviewer can check the table against the source
 * instead of trusting it. Rows describe what the code does TODAY; none of them
 * is an owner ruling about what it SHOULD do, and a row that disagrees with a
 * ruling is fixed in the same change as the ruling (SCRUM-760 R3).
 *
 * `assignee` is resolved by the spec to the user the action assigns the lead to.
 */
export type AudienceTemplate = Audience | { kind: "assignee" };

export type ActionExpectation = {
  action: string;
  source: string; // file:line of the notifyX call the promise comes from
  effects: { type: string; audience: AudienceTemplate }[];
};

export const ACTION_EXPECTATIONS: ActionExpectation[] = [
  {
    action: "lead.create",
    source: "convex/leads.ts:371",
    effects: [{ type: "lead.created", audience: { kind: "managers", excludeActor: false } }],
  },
  {
    action: "lead.create+assign",
    source: "convex/leads.ts:371,380",
    effects: [
      { type: "lead.created", audience: { kind: "managers", excludeActor: false } },
      { type: "lead.assigned", audience: { kind: "assignee" } },
    ],
  },
  {
    action: "lead.update",
    source: "convex/leads.ts:473",
    effects: [{ type: "lead.updated", audience: { kind: "managers", excludeActor: false } }],
  },
  {
    action: "lead.reassign",
    source: "convex/leads.ts:473,483",
    effects: [
      { type: "lead.updated", audience: { kind: "managers", excludeActor: false } },
      { type: "lead.assigned", audience: { kind: "assignee" } },
    ],
  },
  {
    action: "lead.delete",
    source: "convex/leads.ts:585",
    effects: [{ type: "lead.deleted", audience: { kind: "managers", excludeActor: false } }],
  },
];

/**
 * Notification types the code dispatches (found by tool, see the ratchet test)
 * that this table does NOT yet model. The list may only shrink: a new dispatched
 * type must either get an ACTION_EXPECTATIONS row or be added here on purpose.
 */
export const UNMODELLED_TYPES: string[] = [
  "admin.org_deleted",
  "admin.org_suspended",
  "admin.org_unsuspended",
  "admin.user_role_changed",
  "application.cancelled",
  "application.created",
  "application.payment_on_cancelled_deal",
  "application.settlement_advice_discrepancy",
  "approval.requested",
  "approval.responded",
  "branch.changed",
  "collection.approval_requested",
  "collection.approval_responded",
  "collection.cheque_returned",
  "collection.payment_recorded",
  "collection.plan_created",
  "collection.receivable_created",
  "collection.reconciliation_submitted",
  "customer.created",
  "customer.deleted",
  "customer.updated",
  "deposit.created",
  "deposit.expired",
  "deposit.released",
  "document.status_changed",
  "expense.created",
  "expense.deleted",
  "expense.updated",
  "feedback.replied",
  "feedback.resolved",
  "guarantor.added",
  "marketplace.request_matched",
  "marketplace.tradein_submitted",
  "membership.added",
  "membership.commission_rate_changed",
  "membership.left",
  "membership.role_changed",
  "message.received",
  "organization.settings_changed",
  "quote.accepted",
  "role.changed",
  "sale.created",
  "sale.deleted",
  "sale.updated",
  "social.lead_created",
  "social.possible_complaint",
  "social.post_failed",
  "social.post_succeeded",
  "system.announcement",
  "task.assigned",
  "task.due_soon",
  "task.overdue_warning",
  "vehicle.cost_corrected",
  "vehicle.create_requested",
  "vehicle.created",
  "vehicle.deleted",
  "vehicle.status_request_created",
  "vehicle.status_request_resolved",
  "vehicle.update_requested",
  "vehicle.updated",
  "whatsapp.lead_created",
];
