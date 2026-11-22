import { defineTable } from "convex/server";
import { v } from "convex/values";

export const customerPipelineTables = {
  customers: defineTable({
    orgId: v.id("organizations"),
    firstName: v.string(),
    lastName: v.string(),
    phone: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    instagramUserId: v.optional(v.string()),
    facebookUserId: v.optional(v.string()),
    email: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    address: v.optional(v.string()),
    employment: v.optional(
      v.object({
        employer: v.string(),
        title: v.optional(v.string()),
        salary: v.number(),
        hireDate: v.optional(v.number()),
      })
    ),
    financials: v.optional(
      v.object({
        totalMonthlyDebt: v.number(),
        dbr: v.optional(v.number()), // Debt Burden Ratio
      })
    ),
    createdAt: v.optional(v.number()),
    createdBy: v.optional(v.id("users")),
    source: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_email", ["orgId", "email"])
    .index("by_org_phone", ["orgId", "phone"])
    .index("by_org_whatsapp", ["orgId", "whatsapp"])
    .index("by_org_nationalId", ["orgId", "nationalId"])
    .searchIndex("search_firstName", { searchField: "firstName", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_lastName", { searchField: "lastName", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_phone", { searchField: "phone", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_email", { searchField: "email", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_nationalId", { searchField: "nationalId", filterFields: ["orgId", "isDeleted"] }),

  leads: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    customerId: v.id("customers"),
    assignedUserId: v.optional(v.id("users")),
    vehicleId: v.optional(v.id("vehicles")),
    source: v.string(),
    // Structured attribution alongside the free-text `source` above — see
    // docs/dealer_network_marketplace_master_plan.md Phase 58. Only
    // "marketplace" is a defined value today; kept a loose string (not a
    // union) so future sources (e.g. the Social Command Center spine) don't
    // require a schema migration to add a literal.
    sourceChannel: v.optional(v.string()),
    marketplaceRequestId: v.optional(v.id("marketplaceRequests")),
    stage: v.union(
      v.literal("NEW"),
      v.literal("CONTACTED"),
      v.literal("INTERESTED"),
      v.literal("TEST_DRIVE"),
      v.literal("NEGOTIATION"),
      v.literal("RESERVED"),
      v.literal("WON"),
      v.literal("LOST")
    ),
    notes: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    updatedAt: v.optional(v.number()),
    updatedBy: v.optional(v.id("users")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_stage", ["orgId", "stage"])
    .index("by_org_assigned", ["orgId", "assignedUserId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  // Append-only audit trail for leads. Rows are never patched or deleted —
  // not even when the lead itself is soft-deleted — so the timeline stays
  // truthful across a delete/restore cycle. Every writer funnels through
  // convex/utils/leadActivity.ts; one row per changed field, so a single
  // `leads.update` that moves stage and salesperson emits two rows.
  leadActivities: defineTable({
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
    // Absent for automation writes with no signed-in caller: social webhooks,
    // marketplace conversions, and stage advances triggered by a test drive
    // or a completed sale. `actorLabel` names the source in that case.
    actorUserId: v.optional(v.id("users")),
    actorLabel: v.optional(v.string()),
    action: v.union(
      v.literal("CREATED"),
      v.literal("STAGE_CHANGED"),
      v.literal("ASSIGNED"),
      v.literal("UNASSIGNED"),
      v.literal("UPDATED"),
      v.literal("DELETED"),
      v.literal("RESTORED"),
      // A salesperson's own progress update. The only action a user can author
      // directly, and still append-only: each update is its own row rather
      // than an overwrite of the lead's single `notes` field, so the history
      // of what was tried survives instead of being replaced.
      v.literal("NOTE")
    ),
    // The lead column that moved. Values are stored as rendered strings, not
    // raw ids, so the timeline still reads correctly after the referenced
    // customer/vehicle/user row is renamed or removed.
    field: v.optional(v.string()),
    fromValue: v.optional(v.string()),
    toValue: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org_lead", ["orgId", "leadId", "createdAt"])
    .index("by_org_created", ["orgId", "createdAt"]),

  leadAssignmentCursors: defineTable({
    orgId: v.id("organizations"),
    lastAssignedUserId: v.optional(v.id("users")),
    updatedAt: v.number(),
  }).index("by_org", ["orgId"]),
};
