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
    table: "depositApplications" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("depositApplications")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
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
  {
    table: "paymentVouchers" as const,
    find: (ctx: QueryCtx, _orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("paymentVouchers")
        .withIndex("by_customer", (q) => q.eq("customerId", customerId))
        .collect(),
  },
];

/**
 * Tables carrying a `customerId` that the merge must NOT rewrite, because the
 * column is derived rather than a foreign key the row owns.
 *
 * `socialConversations` is materialised from `instagramEvents` and
 * `facebookEvents`, both of which the registry above does repoint. Its
 * `conversationKey` *embeds* the customer id, so blind-patching `customerId`
 * would leave the key naming the loser: the row would no longer be found by the
 * survivor's key, and the next inbound message would materialise a second
 * thread beside the orphan. Letting the events move and the trigger rebuild is
 * what keeps the two in step — the thread follows the survivor and the loser's
 * row is deleted, because it now has no events.
 *
 * Kept as an explicit list rather than an exception in the test so the
 * exhaustiveness check stays exhaustive: every table with a `customerId` must
 * appear in exactly one of these two lists, and adding a column without
 * deciding which is a build failure.
 */
export const CUSTOMER_DERIVED_TABLES = ["socialConversations"] as const;
