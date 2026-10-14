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

const MANAGERS: Audience = { kind: "managers", excludeActor: false };

export const ACTION_EXPECTATIONS: ActionExpectation[] = [
  {
    action: "lead.create",
    source: "convex/leads.ts:371",
    effects: [{ type: "lead.created", audience: MANAGERS }],
  },
  {
    action: "lead.create+assign",
    source: "convex/leads.ts:371,380",
    effects: [
      { type: "lead.created", audience: MANAGERS },
      { type: "lead.assigned", audience: { kind: "assignee" } },
    ],
  },
  {
    action: "lead.update",
    source: "convex/leads.ts:473",
    effects: [{ type: "lead.updated", audience: MANAGERS }],
  },
  {
    action: "lead.reassign",
    source: "convex/leads.ts:473,483",
    effects: [
      { type: "lead.updated", audience: MANAGERS },
      { type: "lead.assigned", audience: { kind: "assignee" } },
    ],
  },
  {
    action: "lead.delete",
    source: "convex/leads.ts:585",
    effects: [{ type: "lead.deleted", audience: MANAGERS }],
  },
];

/**
 * Every registered notification type (lib/notifications/types.ts) that this
 * table does NOT yet model. dispatch() only accepts registry keys, so the
 * registry is the complete set of in-app types: no regex over call sites to go
 * blind (it missed notifyFinanceManagers, camelCase types and types passed in a
 * variable). The list may only shrink: a new registry key fails the ratchet
 * until it gets an ACTION_EXPECTATIONS row or is added here on purpose. Entries
 * include types nothing currently dispatches; being listed means "not modelled",
 * not "dispatched".
 */
export const UNMODELLED_TYPES: string[] = [
  "accounting.prepaidAmortizationFailed",
  "accounting.prepaidCorrectionDecided",
  "accounting.prepaidCorrectionRequested",
  "admin.org_deleted",
  "admin.org_suspended",
  "admin.org_unsuspended",
  "admin.user_disabled",
  "admin.user_enabled",
  "admin.user_role_changed",
  "application.cancelled",
  "application.created",
  "application.payment_on_cancelled_deal",
  "application.settlement_advice_discrepancy",
  "approval.requested",
  "approval.responded",
  "branch.changed",
  "claim.updated",
  "collection.approval_requested",
  "collection.approval_responded",
  "collection.cheque_returned",
  "collection.cheque_returned_customer",
  "collection.cheque_upcoming",
  "collection.payment_recorded",
  "collection.plan_created",
  "collection.receivable_created",
  "collection.receivable_due_soon",
  "collection.receivable_overdue",
  "collection.reconciliation_submitted",
  "customer.created",
  "customer.deleted",
  "customer.updated",
  "deposit.created",
  "deposit.expired",
  "deposit.released",
  "depositRequest.confirmed",
  "depositRequest.created",
  "depositRequest.rejected",
  "document.status_changed",
  "expense.created",
  "expense.deleted",
  "expense.updated",
  "feedback.replied",
  "feedback.resolved",
  "fixedAsset.changed",
  "guarantor.added",
  "marketplace.request_matched",
  "marketplace.tradein_submitted",
  "membership.added",
  "membership.commission_rate_changed",
  "membership.left",
  "membership.role_changed",
  "message.received",
  "organization.settings_changed",
  "partnerEquity.changed",
  "quote.accepted",
  "quote.declined",
  "role.changed",
  "sale.created",
  "sale.deleted",
  "sale.updated",
  "social.lead_created",
  "social.possible_complaint",
  "social.post_failed",
  "social.post_succeeded",
  "support.message_received",
  "support.thread_status_changed",
  "system.announcement",
  "task.assigned",
  "task.due_soon",
  "task.overdue_warning",
  "test_drive.completed",
  "test_drive.scheduled",
  "transaction.recorded",
  "transaction.removed",
  "transaction.updated",
  "vehicle.cost_corrected",
  "vehicle.create_requested",
  "vehicle.created",
  "vehicle.deleted",
  "vehicle.status_request_created",
  "vehicle.status_request_resolved",
  "vehicle.update_requested",
  "vehicle.updated",
  "whatsapp.lead_created",
  "workOrder.completed",
  "workOrder.created",
];
