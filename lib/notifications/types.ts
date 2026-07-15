export type NotificationCategory =
  | "sales"
  | "inventory"
  | "finance"
  | "operations"
  | "team"
  | "social"
  | "system";

export type NotificationPriority = "urgent" | "normal" | "low";

export interface NotificationTypeDef {
  category: NotificationCategory;
  priority: NotificationPriority;
  /**
   * Email default for a user who hasn't touched their preferences:
   * true = opt-out (email sent unless the user disables it) for things
   * that need the recipient's action or affect their account/role;
   * false = opt-in (no email until the user enables it for this category).
   * WhatsApp is always opt-in regardless of this flag.
   */
  criticalDefault: boolean;
}

/**
 * Central catalog of every notification type the system can dispatch.
 * Each key is rendered bilingually via lib/notifications/render.ts using
 * the matching entry in lib/i18n/domains/notifications.ts.
 *
 * "system.announcement" is the one exception — admin-authored broadcast
 * text is stored directly on the notification row (title/message) rather
 * than templated, since a super admin types free-form content.
 */
export const NOTIFICATION_TYPES = {
  // ─── Sales / CRM ───────────────────────────────────────────────────────
  "customer.created": { category: "sales", priority: "normal", criticalDefault: false },
  "customer.updated": { category: "sales", priority: "low", criticalDefault: false },
  "customer.deleted": { category: "sales", priority: "normal", criticalDefault: false },
  "customer.merged": { category: "sales", priority: "normal", criticalDefault: false },
  "lead.created": { category: "sales", priority: "normal", criticalDefault: false },
  "lead.assigned": { category: "sales", priority: "normal", criticalDefault: false },
  "lead.updated": { category: "sales", priority: "low", criticalDefault: false },
  "lead.deleted": { category: "sales", priority: "low", criticalDefault: false },
  "sale.created": { category: "sales", priority: "normal", criticalDefault: false },
  "sale.updated": { category: "sales", priority: "low", criticalDefault: false },
  "sale.deleted": { category: "sales", priority: "normal", criticalDefault: false },
  "application.created": { category: "sales", priority: "normal", criticalDefault: false },
  "application.cancelled": { category: "sales", priority: "normal", criticalDefault: false },
  "guarantor.added": { category: "sales", priority: "normal", criticalDefault: false },
  "quote.accepted": { category: "sales", priority: "normal", criticalDefault: false },
  "quote.declined": { category: "sales", priority: "normal", criticalDefault: false },

  // ─── Inventory ─────────────────────────────────────────────────────────
  "vehicle.created": { category: "inventory", priority: "normal", criticalDefault: false },
  "vehicle.updated": { category: "inventory", priority: "low", criticalDefault: false },
  "vehicle.deleted": { category: "inventory", priority: "normal", criticalDefault: false },
  "vehicle.create_requested": { category: "inventory", priority: "normal", criticalDefault: false },
  "vehicle.update_requested": { category: "inventory", priority: "normal", criticalDefault: false },
  "vehicle.status_request_created": { category: "inventory", priority: "urgent", criticalDefault: true },
  "vehicle.status_request_resolved": { category: "inventory", priority: "urgent", criticalDefault: true },
  "test_drive.scheduled": { category: "inventory", priority: "normal", criticalDefault: false },
  "test_drive.completed": { category: "inventory", priority: "low", criticalDefault: false },
  "document.status_changed": { category: "inventory", priority: "normal", criticalDefault: false },

  // ─── Finance / accounting ──────────────────────────────────────────────
  "expense.created": { category: "finance", priority: "normal", criticalDefault: false },
  "expense.updated": { category: "finance", priority: "low", criticalDefault: false },
  "expense.deleted": { category: "finance", priority: "normal", criticalDefault: false },
  "transaction.recorded": { category: "finance", priority: "normal", criticalDefault: false },
  "transaction.updated": { category: "finance", priority: "low", criticalDefault: false },
  "transaction.removed": { category: "finance", priority: "normal", criticalDefault: false },
  "deposit.created": { category: "finance", priority: "normal", criticalDefault: false },
  "deposit.released": { category: "finance", priority: "normal", criticalDefault: false },
  "deposit.expired": { category: "finance", priority: "urgent", criticalDefault: true },
  "claim.updated": { category: "finance", priority: "normal", criticalDefault: false },
  "fixedAsset.changed": { category: "finance", priority: "normal", criticalDefault: false },
  "vehicle.cost_corrected": { category: "finance", priority: "urgent", criticalDefault: true },
  "accounting.prepaidAmortizationFailed": { category: "finance", priority: "urgent", criticalDefault: true },
  "partnerEquity.changed": { category: "finance", priority: "normal", criticalDefault: false },
  "approval.requested": { category: "finance", priority: "urgent", criticalDefault: true },
  "approval.responded": { category: "finance", priority: "urgent", criticalDefault: true },
  "collection.receivable_created": { category: "finance", priority: "normal", criticalDefault: false },
  "collection.plan_created": { category: "finance", priority: "normal", criticalDefault: false },
  "collection.payment_recorded": { category: "finance", priority: "normal", criticalDefault: false },
  "collection.cheque_returned": { category: "finance", priority: "urgent", criticalDefault: true },
  "collection.approval_requested": { category: "finance", priority: "urgent", criticalDefault: true },
  "collection.approval_responded": { category: "finance", priority: "urgent", criticalDefault: true },
  "collection.reconciliation_submitted": { category: "finance", priority: "normal", criticalDefault: false },
  "collection.receivable_due_soon": { category: "finance", priority: "normal", criticalDefault: false },
  "collection.receivable_overdue": { category: "finance", priority: "urgent", criticalDefault: true },
  "collection.cheque_upcoming": { category: "finance", priority: "normal", criticalDefault: false },
  "collection.cheque_returned_customer": { category: "finance", priority: "urgent", criticalDefault: true },

  // ─── Operations ────────────────────────────────────────────────────────
  "workOrder.created": { category: "operations", priority: "normal", criticalDefault: false },
  "workOrder.completed": { category: "operations", priority: "normal", criticalDefault: false },
  "task.assigned": { category: "operations", priority: "normal", criticalDefault: false },
  // criticalDefault is false here (despite being urgent) because crons.ts already
  // sends a dedicated ICS-attached reminder email unconditionally via
  // internal.email.sendTaskAlarm — leaving this opt-in avoids a duplicate
  // generic email on top of that existing one for the default case.
  "task.due_soon": { category: "operations", priority: "urgent", criticalDefault: false },
  "task.overdue_warning": { category: "operations", priority: "normal", criticalDefault: false },

  // ─── Team / org admin ──────────────────────────────────────────────────
  "membership.added": { category: "team", priority: "urgent", criticalDefault: true },
  "membership.role_changed": { category: "team", priority: "urgent", criticalDefault: true },
  "membership.left": { category: "team", priority: "normal", criticalDefault: false },
  "membership.commission_rate_changed": { category: "team", priority: "urgent", criticalDefault: true },
  "role.changed": { category: "team", priority: "urgent", criticalDefault: true },
  "branch.changed": { category: "team", priority: "normal", criticalDefault: false },
  "organization.settings_changed": { category: "team", priority: "normal", criticalDefault: false },
  "support.message_received": { category: "team", priority: "normal", criticalDefault: false },
  "support.thread_status_changed": { category: "team", priority: "normal", criticalDefault: false },
  "message.received": { category: "team", priority: "normal", criticalDefault: false },

  // ─── Social inbox / integrations ───────────────────────────────────────
  "social.lead_created": { category: "social", priority: "normal", criticalDefault: false },
  "social.possible_complaint": { category: "social", priority: "urgent", criticalDefault: true },
  "social.post_succeeded": { category: "social", priority: "low", criticalDefault: false },
  "social.post_failed": { category: "social", priority: "normal", criticalDefault: false },
  "whatsapp.lead_created": { category: "social", priority: "normal", criticalDefault: false },

  // ─── Dealer Network Marketplace ────────────────────────────────────────
  "marketplace.request_matched": { category: "sales", priority: "urgent", criticalDefault: true },
  "marketplace.tradein_submitted": { category: "sales", priority: "urgent", criticalDefault: true },

  // ─── Feedback ─────────────────────────────────────────────────────────
  "feedback.replied": { category: "system", priority: "normal", criticalDefault: true },
  "feedback.resolved": { category: "system", priority: "normal", criticalDefault: true },

  // ─── System / cross-tenant admin ───────────────────────────────────────
  "system.announcement": { category: "system", priority: "urgent", criticalDefault: true },
  "admin.org_suspended": { category: "system", priority: "urgent", criticalDefault: true },
  "admin.org_unsuspended": { category: "system", priority: "urgent", criticalDefault: true },
  "admin.org_deleted": { category: "system", priority: "urgent", criticalDefault: true },
  "admin.user_disabled": { category: "system", priority: "urgent", criticalDefault: true },
  "admin.user_enabled": { category: "system", priority: "urgent", criticalDefault: true },
  "admin.user_role_changed": { category: "system", priority: "urgent", criticalDefault: true },
} as const satisfies Record<string, NotificationTypeDef>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  "sales",
  "inventory",
  "finance",
  "operations",
  "team",
  "social",
  "system",
];

export function isNotificationType(value: string): value is NotificationType {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPES, value);
}

/**
 * Preferences are stored per-category (one toggle per category in the UI),
 * but criticalDefault is defined per-type. A category's shown default is
 * "on" if it contains at least one opt-out-by-default type — signals to the
 * user that leaving it untouched may still surface an urgent email from
 * that category, which is the same outcome dispatch() actually produces.
 */
export function categoryDefaultEmail(category: NotificationCategory): boolean {
  return Object.values(NOTIFICATION_TYPES).some(
    (def) => def.category === category && def.criticalDefault
  );
}
