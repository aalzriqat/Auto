import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/**
 * The tables whose `customerId` a merge REWRITES to the survivor, as a single
 * explicit list (mirroring `ORG_SCOPED_TABLES` in adminOrgs.ts) rather than a
 * dynamic reflection-based scan — merges are rare, audited, destructive
 * operations where an explicit list is safer than "discover tables
 * automatically."
 *
 * This is NOT every table carrying a `customerId`. Two other classifications
 * exist and are enforced by `customerMergeRegistry.test.ts`:
 * `CUSTOMER_DERIVED_TABLES` and `CUSTOMER_NON_REASSIGNABLE_TABLES` below.
 */
export const CUSTOMER_REFERENCING_TABLES = [
  {
    // SCRUM-195: a commitment root records WHOSE deal holds a car. Merging two
    // customer records must carry the surviving customer's deals with it —
    // otherwise the merged-away customer keeps holding vehicles that the
    // authority can still see and refuse on, and nobody can find the deal to
    // release it.
    //
    // Claims are deliberately NOT listed: they carry no customerId. A claim's
    // customer is its root's, which is exactly the single-source-of-truth this
    // authority exists to have.
    table: "commitmentRoots" as const,
    find: (ctx: QueryCtx, orgId: Id<"organizations">, customerId: Id<"customers">) =>
      ctx.db
        .query("commitmentRoots")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .collect(),
  },
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
 * appear in exactly one of the three lists in this file, and adding a column
 * without deciding which is a build failure.
 */
export const CUSTOMER_DERIVED_TABLES = ["socialConversations"] as const;

/**
 * Sealed financial authority: tables whose `customerId` the merge must NOT
 * rewrite, because it is part of the row's economic provenance rather than a
 * pointer the row happens to hold.
 *
 * A receipt movement, its retained position and each application record WHOSE
 * money a posted receipt represents. Patching `customerId` here would move a
 * retained credit onto a different customer with no persisted movement
 * explaining it — a restatement of settled money.
 *
 * ⚠️ THE REST OF THE RECEIPT'S LINEAGE IS *NOT* SEALED, AND SAYING OTHERWISE
 * WOULD BE FALSE. `canonicalPayments` — the very row a movement points at via
 * `canonicalPaymentId` — is in the rewriting registry above, as are
 * `journalLines` and `receivableDocuments`. A merge DOES repoint all three.
 *
 * `paymentAllocations` and `accountingEvents` declare no TOP-LEVEL `customerId`
 * field, which is all their absence from these three lists proves. It does NOT
 * mean they carry no customer identity: `accountingEvents.payload` is `v.any()`
 * and the receipt hooks put `customerId` inside it (`workflowHooks.ts`), where
 * `postingRules.ts` reads it into journal-line dimensions. A merge does not
 * rewrite that payload, so whether a journal line's customer dimension follows
 * the survivor depends on whether the event had already POSTED when the merge
 * ran. That timing question is real and belongs to SCRUM-250, not here.
 *
 * So after a merge the movement names the loser while its own canonical payment
 * names the survivor. That divergence is deliberate, and it has one concrete
 * consequence worth stating rather than leaving to be discovered:
 * `applyRetainedCredit` refuses when `receivable.customerId !==
 * movement.customerId` (collections.ts), and a merge repoints `receivables`.
 * **A merged-away customer's retained credit therefore becomes permanently
 * UNAPPLIABLE, not merely hard to find.** It fails CLOSED — no money moves to
 * the wrong party and the 2110 liability stays correctly on the books — which
 * is the safe direction, but it is a freeze, and SCRUM-250 must design for it.
 *
 * ⚠️ THIS LIST ONLY REMOVES THE GENERIC WRITE PATH. IT IS NOT A RUNTIME FENCE.
 * `customers.mergeCustomers` does not refuse a losing customer who holds live
 * retained credit; it merges, and the credit is left addressed to the
 * merged-away record. That gap is SCRUM-250, which owns the pre-write refusal
 * (or a specified authority-transfer operation) together with its own evidence
 * floor. It is deliberately NOT implemented here: SCRUM-218-C's obligation is
 * that no generic loop can raw-reassign this authority, and 250's is deciding
 * what a merge should do instead.
 *
 * ⚠️ DO NOT INFER "NOT DEPLOYED" FROM "NOT ON `origin/main`". These tables are
 * absent from `origin/main` (verified), which proves the branch is UNMERGED —
 * nothing more. `AGENTS.md` records that a production deploy key still exists on
 * a developer workstation where `npx convex deploy` reaches production
 * directly, so Git state cannot establish deployment state. Production
 * reachability here is NOT ESTABLISHED, in either direction, and would need
 * deployment evidence rather than a repository check.
 */
export const CUSTOMER_NON_REASSIGNABLE_TABLES = [
  "receiptMovements",
  "receiptRetainedPositions",
  "receiptApplications",
] as const;
