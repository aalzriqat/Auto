import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  }).index("by_clerkId", ["clerkId"]),

  organizations: defineTable({
    name: v.string(),
    createdAt: v.number(),
  }),

  roles: defineTable({
    orgId: v.id("organizations"), // Roles are scoped to orgs allowing custom roles
    name: v.string(), // "OWNER", "SALES", etc.
    permissions: v.array(v.string()),
  }).index("by_org", ["orgId"]),

  memberships: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    roleId: v.id("roles"),
  })
    .index("by_user", ["userId"])
    .index("by_org", ["orgId"])
    .index("by_org_user", ["orgId", "userId"]),

  vehicles: defineTable({
    orgId: v.id("organizations"),
    vin: v.string(),
    make: v.string(),
    model: v.string(),
    year: v.number(),
    trim: v.optional(v.string()),
    mileage: v.number(),
    color: v.string(),
    fuelType: v.string(),
    transmission: v.string(),
    purchasePrice: v.optional(v.number()), // Might be hidden from salespeople
    sellingPrice: v.number(),
    status: v.union(
      v.literal("AVAILABLE"),
      v.literal("RESERVED"),
      v.literal("SOLD"),
      v.literal("IN_INSPECTION"),
      v.literal("IN_REPAIR"),
      v.literal("ARCHIVED")
    ),
    notes: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_vin", ["orgId", "vin"]),

  customers: defineTable({
    orgId: v.id("organizations"),
    firstName: v.string(),
    lastName: v.string(),
    phone: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    email: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    address: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_email", ["orgId", "email"]),

  leads: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    assignedUserId: v.optional(v.id("users")),
    vehicleId: v.optional(v.id("vehicles")),
    source: v.string(),
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
  })
    .index("by_org", ["orgId"])
    .index("by_org_stage", ["orgId", "stage"])
    .index("by_org_assigned", ["orgId", "assignedUserId"]),

  sales: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    salePrice: v.number(),
    saleDate: v.number(), // timestamp
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED"), v.literal("CANCELLED")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_salesperson", ["orgId", "salespersonId"]),

  expenses: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")), // Optional because there might be general expenses
    title: v.string(), // e.g., "Brake replacement", "Detailing", "Office supplies"
    amount: v.number(),
    date: v.number(),
    category: v.union(
      v.literal("REPAIR"),
      v.literal("MAINTENANCE"),
      v.literal("DETAILING"),
      v.literal("TRANSPORT"),
      v.literal("MARKETING"),
      v.literal("OFFICE"),
      v.literal("OTHER")
    ),
    notes: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"]),

  tasks: defineTable({
    orgId: v.id("organizations"),
    assignedTo: v.id("users"), // The salesperson or employee responsible
    title: v.string(),
    description: v.optional(v.string()),
    dueDate: v.number(), // Timestamp for the deadline/schedule
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED")),
    // Optional associations
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_assignedTo", ["orgId", "assignedTo"])
    .index("by_org_status", ["orgId", "status"]),
});
