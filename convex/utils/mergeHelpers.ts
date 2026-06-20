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
];
