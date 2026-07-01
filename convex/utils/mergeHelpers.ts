import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/**
 * Every table with a `customerId` foreign key, scoped to a single explicit
 * list (mirroring `ORG_SCOPED_TABLES` in adminOrgs.ts) rather than a dynamic
 * reflection-based scan — merges are rare, audited, destructive operations
 * where an explicit list is safer than "discover tables automatically."
 */
export const CUSTOMER_REFERENCING_TABLES = [
  {
    table: "journalLines" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("journalLines")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "receivableDocuments" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("receivableDocuments")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "canonicalPayments" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("canonicalPayments")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "vehicleReservations" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("vehicleReservations")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "leads" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("leads")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "sales" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("sales")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "tasks" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("tasks")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "test_drives" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("test_drives")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "guarantors" as const,
    find: (ctx: QueryCtx, _orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("guarantors")
        .withIndex("by_customer", (q) => q.eq("customerId", customerId))
        .collect(),
  },
  {
    table: "quotes" as const,
    find: (ctx: QueryCtx, _orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("quotes")
        .withIndex("by_customer", (q) => q.eq("customerId", customerId))
        .collect(),
  },
  {
    table: "financeApplications" as const,
    find: (ctx: QueryCtx, _orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("financeApplications")
        .withIndex("by_customer", (q) => q.eq("customerId", customerId))
        .collect(),
  },
  {
    table: "deposits" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("deposits")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "receivables" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("receivables")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "collectionPayments" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("collectionPayments")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "postDatedCheques" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("postDatedCheques")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "collectionApprovalRequests" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("collectionApprovalRequests")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "collectionReminders" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("collectionReminders")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "transactions" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("transactions")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "instagramEvents" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("instagramEvents")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "facebookEvents" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("facebookEvents")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "facebookMessages" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("facebookMessages")
        .withIndex("by_org_customer_ts", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
  {
    table: "paymentIntents" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("paymentIntents")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
];
