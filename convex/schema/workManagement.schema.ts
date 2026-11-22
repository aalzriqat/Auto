import { defineTable } from "convex/server";
import { v } from "convex/values";

export const workManagementTables = {
  tasks: defineTable({
    orgId: v.id("organizations"),
    assignedTo: v.id("users"), // The salesperson or employee responsible
    title: v.string(),
    description: v.optional(v.string()),
    dueDate: v.number(), // Timestamp for the deadline/schedule
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED"), v.literal("CANCELLED")),
    priority: v.optional(v.union(v.literal("HIGH"), v.literal("MEDIUM"), v.literal("LOW"))),
    statusNote: v.optional(v.string()), // Notes when cancelled or rescheduled
    communicationMethod: v.optional(v.union(v.literal("PHONE"), v.literal("EMAIL"), v.literal("FAX"))),
    alarmTriggered: v.optional(v.boolean()), // Track if the cron has sent the notification
    // Optional associations
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_assignedTo", ["orgId", "assignedTo"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_status_alarm", ["status", "alarmTriggered"])
    // SCRUM-807 — lets the alarm sweep read only the tasks that are due. Added
    // alongside by_status_alarm; the older index is kept (indexes are never
    // removed here).
    .index("by_status_alarm_due", ["status", "alarmTriggered", "dueDate"])
    .index("by_org_customer", ["orgId", "customerId"]),

  // SCRUM-807 — durable progress of ONE task alarm's manager notifications.
  // Written in the same transaction that flags the task. Completed/cancelled
  // deliveries retain their history and are excluded from the ACTIVE sweep.
  // `cursor` is the memberships pagination cursor (null = not
  // started); each page commits its notifications together with the cursor that
  // says they were sent. `lastProgressAt` lets the alarm cron find a delivery whose
  // continuation was lost; `attempts` counts those re-kicks since the last
  // progress, because a page that throws rolls back and cannot count itself.
  // A delivery that exhausts them is parked as FAILED. All delivery history,
  // including the task title and assignee name, survives organization deletion
  // by explicit owner policy; this table is not only in-flight work.
  taskAlarmDeliveries: defineTable({
    orgId: v.id("organizations"),
    taskId: v.id("tasks"),
    taskTitle: v.string(),
    assigneeName: v.string(),
    cursor: v.union(v.string(), v.null()),
    lastProgressAt: v.number(),
    status: v.union(v.literal("ACTIVE"), v.literal("FAILED"), v.literal("COMPLETED"), v.literal("CANCELLED")),
    completedAt: v.optional(v.number()),
    attempts: v.number(),
  })
    .index("by_org", ["orgId"])
    // Status leads so terminal rows, which are never re-read by the sweep,
    // cannot fill its batch ahead of live stalled ones.
    .index("by_status_lastProgressAt", ["status", "lastProgressAt"]),

  taskHistory: defineTable({
    orgId: v.id("organizations"),
    taskId: v.id("tasks"),
    userId: v.id("users"),
    action: v.union(
      v.literal("CREATE"),
      v.literal("UPDATE"),
      v.literal("RESCHEDULE"),
      v.literal("CANCEL"),
      // Additive, mirroring leadActivity's own DELETED literal. CANCEL already
      // means something different and user-visible (the task stayed, its status
      // changed), so reusing it would make the trail lie about what happened.
      // The row outlives the task deliberately: getHistory hides a deleted
      // task, but the entry is what makes the deletion answerable for later.
      v.literal("DELETE"),
      v.literal("STATUS_CHANGE")
    ),
    details: v.string(),
    note: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_task", ["taskId"]),
};
