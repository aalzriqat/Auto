import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query, MutationCtx } from "./_generated/server";
import { Doc, Id, TableNames } from "./_generated/dataModel";
import { requireSuperAdmin } from "./utils/tenancy";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { logAdminAction } from "./adminAudit";
import { notifyManagers } from "./utils/notifications";

const ORG_DELETION_BATCH_SIZE = 50;

const deletionRequestStatusValidator = v.union(
  v.literal("PENDING_REVIEW"),
  v.literal("REJECTED"),
  v.literal("APPROVED"),
  v.literal("RUNNING"),
  v.literal("COMPLETED"),
  v.literal("FAILED")
);

type DeletionRequestStatus = Doc<"organizationDeletionRequests">["status"];
type DeletedCounts = Record<string, number>;
type OrgScopedDeletionStep = { kind: "orgRows"; table: TableNames; index: string };
type StorageDeletionStep =
  | { kind: "vehiclesWithStorage" }
  | { kind: "vehicleEditsWithStorage" }
  | { kind: "applicationDocumentsWithStorage" }
  | { kind: "orgSettingsWithStorage" }
  | { kind: "socialPostsWithStorage" };
type SpecialDeletionStep = StorageDeletionStep | { kind: "dmConversations" } | { kind: "liveChatThreads" };
type DeletionStep = OrgScopedDeletionStep | SpecialDeletionStep;

const ACTIVE_DELETION_STATUSES: DeletionRequestStatus[] = ["PENDING_REVIEW", "APPROVED", "RUNNING"];

// Every direct orgId table that carries tenant data, plus special parent-child
// cleanup steps for org-scoped conversations whose child rows are keyed by the
// conversation/thread id rather than orgId. adminAuditLog is intentionally
// retained as the platform deletion trail.
const ORGANIZATION_DELETION_STEPS: DeletionStep[] = [
  { kind: "orgRows", table: "commandIdempotency", index: "by_org_createdAt" },
  { kind: "orgRows", table: "chartOfAccounts", index: "by_org" },
  { kind: "orgRows", table: "accountingPeriods", index: "by_org" },
  { kind: "orgRows", table: "accountingEvents", index: "by_org" },
  { kind: "orgRows", table: "pendingAccountingEvents", index: "by_org_status" },
  { kind: "orgRows", table: "journalLines", index: "by_org" },
  { kind: "orgRows", table: "journalEntries", index: "by_org" },
  { kind: "orgRows", table: "paymentAllocations", index: "by_org" },
  { kind: "orgRows", table: "canonicalPayments", index: "by_org" },
  { kind: "orgRows", table: "receivableDocuments", index: "by_org" },
  { kind: "orgRows", table: "financialAuditLog", index: "by_org" },
  { kind: "orgRows", table: "vehicleLandedCosts", index: "by_org_vehicle" },
  { kind: "orgRows", table: "vehicleSupplierPayables", index: "by_org" },
  { kind: "orgRows", table: "vehiclePriceHistory", index: "by_org_vehicle" },
  { kind: "orgRows", table: "vehicleReservations", index: "by_org_vehicle" },
  { kind: "orgRows", table: "vehicleStatusRequests", index: "by_org" },
  { kind: "vehicleEditsWithStorage" },
  { kind: "vehiclesWithStorage" },
  { kind: "orgRows", table: "customerMerges", index: "by_org" },
  { kind: "orgRows", table: "leads", index: "by_org" },
  { kind: "orgRows", table: "sales", index: "by_org" },
  { kind: "orgRows", table: "expenses", index: "by_org" },
  { kind: "orgRows", table: "tasks", index: "by_org" },
  { kind: "orgRows", table: "taskHistory", index: "by_org" },
  { kind: "orgRows", table: "notifications", index: "by_org_user" },
  { kind: "orgRows", table: "notificationPreferences", index: "by_org_user_category" },
  { kind: "orgRows", table: "notificationBroadcasts", index: "by_org" },
  { kind: "orgRows", table: "test_drives", index: "by_org" },
  { kind: "orgRows", table: "workOrders", index: "by_org" },
  { kind: "orgRows", table: "financeCompanies", index: "by_org" },
  { kind: "orgRows", table: "vehicleValuations", index: "by_org" },
  { kind: "orgRows", table: "guarantors", index: "by_org" },
  { kind: "orgRows", table: "quotes", index: "by_org" },
  { kind: "orgRows", table: "applicationStatusLog", index: "by_org" },
  { kind: "orgRows", table: "financeApplications", index: "by_org" },
  { kind: "orgRows", table: "deposits", index: "by_org" },
  { kind: "orgRows", table: "receivables", index: "by_org" },
  { kind: "orgRows", table: "collectionPayments", index: "by_org" },
  { kind: "orgRows", table: "postDatedCheques", index: "by_org" },
  { kind: "orgRows", table: "cashierReconciliations", index: "by_org" },
  { kind: "orgRows", table: "collectionApprovalRequests", index: "by_org" },
  { kind: "orgRows", table: "collectionReminders", index: "by_org" },
  { kind: "orgRows", table: "companyDocumentRules", index: "by_org" },
  { kind: "applicationDocumentsWithStorage" },
  { kind: "orgRows", table: "branches", index: "by_org" },
  { kind: "orgRows", table: "transactions", index: "by_org" },
  { kind: "orgRows", table: "fixedAssets", index: "by_org" },
  { kind: "orgRows", table: "partnerEquity", index: "by_org" },
  { kind: "orgRows", table: "claims", index: "by_org" },
  { kind: "orgRows", table: "wizardDrafts", index: "by_org_user" },
  { kind: "orgSettingsWithStorage" },
  { kind: "orgRows", table: "leadAssignmentCursors", index: "by_org" },
  { kind: "orgRows", table: "websiteSettings", index: "by_org" },
  { kind: "orgRows", table: "websiteDomains", index: "by_org" },
  { kind: "orgRows", table: "websitePublishedSections", index: "by_org" },
  { kind: "orgRows", table: "websiteLeadRouting", index: "by_org_settings_form" },
  { kind: "orgRows", table: "websitePublishSnapshots", index: "by_org" },
  { kind: "orgRows", table: "siteVisitorEvents", index: "by_org_createdAt" },
  { kind: "orgRows", table: "siteVisitors", index: "by_org_firstSeenAt" },
  { kind: "orgRows", table: "domainSearchLogs", index: "by_org" },
  { kind: "orgRows", table: "oauthStates", index: "by_org" },
  { kind: "orgRows", table: "instagramEvents", index: "by_org" },
  { kind: "orgRows", table: "facebookEvents", index: "by_org" },
  { kind: "orgRows", table: "facebookMessages", index: "by_org" },
  { kind: "socialPostsWithStorage" },
  { kind: "orgRows", table: "orgCustomFields", index: "by_org" },
  { kind: "orgRows", table: "orgCustomFieldValues", index: "by_org" },
  { kind: "orgRows", table: "orgLeadSources", index: "by_org" },
  { kind: "orgRows", table: "orgValuationCompanies", index: "by_org" },
  { kind: "orgRows", table: "orgPipelineStages", index: "by_org" },
  { kind: "orgRows", table: "orgImportMappings", index: "by_org_entity" },
  { kind: "orgRows", table: "orgCustomerStatuses", index: "by_org" },
  { kind: "orgRows", table: "profitApprovalRequests", index: "by_org" },
  { kind: "orgRows", table: "feedback", index: "by_org" },
  { kind: "orgRows", table: "customers", index: "by_org" },
  { kind: "orgRows", table: "supportOrgAccessGrants", index: "by_orgId" },
  { kind: "liveChatThreads" },
  { kind: "dmConversations" },
  { kind: "orgRows", table: "impersonationGrants", index: "by_orgId" },
  { kind: "orgRows", table: "paymentIntents", index: "by_org" },
  { kind: "orgRows", table: "subscriptions", index: "by_org" },
  { kind: "orgRows", table: "invitations", index: "by_org" },
  { kind: "orgRows", table: "memberships", index: "by_org" },
  { kind: "orgRows", table: "roles", index: "by_org" },
];

async function findActiveDeletionRequest(ctx: MutationCtx, orgId: Id<"organizations">) {
  for (const status of ACTIVE_DELETION_STATUSES) {
    const request = await ctx.db
      .query("organizationDeletionRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
      .first();
    if (request) {
      return request;
    }
  }
  return null;
}

function countDeletedRows(counts: DeletedCounts) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function mergeDeletedCounts(existing: DeletedCounts | undefined, batch: DeletedCounts) {
  const next: DeletedCounts = { ...(existing ?? {}) };
  for (const [table, count] of Object.entries(batch)) {
    next[table] = (next[table] ?? 0) + count;
  }
  return next;
}

function scheduleDeletionBatch(ctx: MutationCtx, requestId: Id<"organizationDeletionRequests">) {
  return ctx.scheduler.runAfter(0, internal.adminOrgs.runDeletionRequestBatch, { requestId });
}

async function deleteRowsByOrgBatch(
  ctx: MutationCtx,
  table: TableNames,
  index: string,
  orgId: Id<"organizations">
) {
  const rows: Array<{ _id: Id<TableNames> }> = await (ctx.db.query(table) as any)
    .withIndex(index, (q: any) => q.eq("orgId", orgId))
    .take(ORG_DELETION_BATCH_SIZE);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length > 0 ? { [table]: rows.length } : {};
}

async function deleteStorageIds(ctx: MutationCtx, storageIds: Id<"_storage">[]) {
  let deletedCount = 0;
  const uniqueIds = Array.from(new Set(storageIds.map((id) => id.toString())));
  for (const storageIdString of uniqueIds) {
    const storageId = storageIdString as Id<"_storage">;
    const metadata = await ctx.db.system.get("_storage", storageId);
    if (!metadata) {
      continue;
    }
    await ctx.storage.delete(storageId);
    deletedCount += 1;
  }
  return deletedCount;
}

function addStorageCount(counts: DeletedCounts, deletedStorageCount: number) {
  if (deletedStorageCount > 0) {
    counts._storage = (counts._storage ?? 0) + deletedStorageCount;
  }
}

async function deleteVehiclesWithStorageBatch(ctx: MutationCtx, orgId: Id<"organizations">) {
  const vehicles = await ctx.db
    .query("vehicles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(ORG_DELETION_BATCH_SIZE);
  const counts: DeletedCounts = {};
  for (const vehicle of vehicles) {
    addStorageCount(counts, await deleteStorageIds(ctx, vehicle.imageIds ?? []));
    await ctx.db.delete(vehicle._id);
  }
  if (vehicles.length > 0) {
    counts.vehicles = vehicles.length;
  }
  return counts;
}

async function deleteVehicleEditsWithStorageBatch(ctx: MutationCtx, orgId: Id<"organizations">) {
  const edits = await ctx.db
    .query("vehicleEdits")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(ORG_DELETION_BATCH_SIZE);
  const counts: DeletedCounts = {};
  for (const edit of edits) {
    addStorageCount(counts, await deleteStorageIds(ctx, edit.payload.imageIds ?? []));
    await ctx.db.delete(edit._id);
  }
  if (edits.length > 0) {
    counts.vehicleEdits = edits.length;
  }
  return counts;
}

async function deleteApplicationDocumentsWithStorageBatch(ctx: MutationCtx, orgId: Id<"organizations">) {
  const documents = await ctx.db
    .query("applicationDocuments")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(ORG_DELETION_BATCH_SIZE);
  const counts: DeletedCounts = {};
  for (const document of documents) {
    addStorageCount(counts, await deleteStorageIds(ctx, document.fileId ? [document.fileId] : []));
    await ctx.db.delete(document._id);
  }
  if (documents.length > 0) {
    counts.applicationDocuments = documents.length;
  }
  return counts;
}

async function deleteOrgSettingsWithStorageBatch(ctx: MutationCtx, orgId: Id<"organizations">) {
  const settingsRows = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(ORG_DELETION_BATCH_SIZE);
  const counts: DeletedCounts = {};
  for (const settings of settingsRows) {
    addStorageCount(counts, await deleteStorageIds(ctx, settings.logoStorageId ? [settings.logoStorageId] : []));
    await ctx.db.delete(settings._id);
  }
  if (settingsRows.length > 0) {
    counts.orgSettings = settingsRows.length;
  }
  return counts;
}

async function deleteSocialPostsWithStorageBatch(ctx: MutationCtx, orgId: Id<"organizations">) {
  const posts = await ctx.db
    .query("socialPosts")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(ORG_DELETION_BATCH_SIZE);
  const counts: DeletedCounts = {};
  for (const post of posts) {
    addStorageCount(counts, await deleteStorageIds(ctx, post.imageStorageIds));
    await ctx.db.delete(post._id);
  }
  if (posts.length > 0) {
    counts.socialPosts = posts.length;
  }
  return counts;
}

async function deleteDmConversationBatch(ctx: MutationCtx, orgId: Id<"organizations">) {
  const conversation = await ctx.db
    .query("dmConversations")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .first();
  if (!conversation) {
    return {};
  }

  const counts: DeletedCounts = {};
  let remaining = ORG_DELETION_BATCH_SIZE;

  const messages = await ctx.db
    .query("dmMessages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
    .take(remaining);
  for (const message of messages) {
    await ctx.db.delete(message._id);
  }
  if (messages.length > 0) {
    counts.dmMessages = messages.length;
    remaining -= messages.length;
  }

  if (remaining > 0) {
    const participantStates = await ctx.db
      .query("dmParticipantState")
      .withIndex("by_conversation_user", (q) => q.eq("conversationId", conversation._id))
      .take(remaining);
    for (const state of participantStates) {
      await ctx.db.delete(state._id);
    }
    if (participantStates.length > 0) {
      counts.dmParticipantState = participantStates.length;
    }
  }

  if (countDeletedRows(counts) > 0) {
    return counts;
  }

  await ctx.db.delete(conversation._id);
  return { dmConversations: 1 };
}

async function deleteLiveChatThreadBatch(ctx: MutationCtx, orgId: Id<"organizations">) {
  const thread = await ctx.db
    .query("liveChatThreads")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .first();
  if (!thread) {
    return {};
  }

  const counts: DeletedCounts = {};
  let remaining = ORG_DELETION_BATCH_SIZE;

  const messages = await ctx.db
    .query("liveChatMessages")
    .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
    .take(remaining);
  for (const message of messages) {
    await ctx.db.delete(message._id);
  }
  if (messages.length > 0) {
    counts.liveChatMessages = messages.length;
    remaining -= messages.length;
  }

  if (remaining > 0) {
    const presenceRows = await ctx.db
      .query("liveChatPresence")
      .withIndex("by_thread_side", (q) => q.eq("threadId", thread._id))
      .take(remaining);
    for (const presence of presenceRows) {
      await ctx.db.delete(presence._id);
    }
    if (presenceRows.length > 0) {
      counts.liveChatPresence = presenceRows.length;
    }
  }

  if (countDeletedRows(counts) > 0) {
    return counts;
  }

  await ctx.db.delete(thread._id);
  return { liveChatThreads: 1 };
}

async function runDeletionStep(ctx: MutationCtx, step: DeletionStep, orgId: Id<"organizations">) {
  if (step.kind === "dmConversations") {
    return await deleteDmConversationBatch(ctx, orgId);
  }
  if (step.kind === "liveChatThreads") {
    return await deleteLiveChatThreadBatch(ctx, orgId);
  }
  if (step.kind === "vehiclesWithStorage") {
    return await deleteVehiclesWithStorageBatch(ctx, orgId);
  }
  if (step.kind === "vehicleEditsWithStorage") {
    return await deleteVehicleEditsWithStorageBatch(ctx, orgId);
  }
  if (step.kind === "applicationDocumentsWithStorage") {
    return await deleteApplicationDocumentsWithStorageBatch(ctx, orgId);
  }
  if (step.kind === "orgSettingsWithStorage") {
    return await deleteOrgSettingsWithStorageBatch(ctx, orgId);
  }
  if (step.kind === "socialPostsWithStorage") {
    return await deleteSocialPostsWithStorageBatch(ctx, orgId);
  }
  return await deleteRowsByOrgBatch(ctx, step.table, step.index, orgId);
}

export const listOrgs = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const page = await ctx.db.query("organizations").order("desc").paginate(args.paginationOpts);
    const items = await Promise.all(
      page.page.map(async (org) => {
        const memberCount = (
          await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", org._id)).collect()
        ).length;
        return { ...org, memberCount };
      })
    );
    return { ...page, page: items };
  },
});

export const listDeletionRequests = query({
  args: {
    status: v.optional(deletionRequestStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    if (args.status) {
      const status = args.status;
      return await ctx.db
        .query("organizationDeletionRequests")
        .withIndex("by_status_and_requestedAt", (q) => q.eq("status", status))
        .order("desc")
        .paginate(args.paginationOpts);
    }
    return await ctx.db.query("organizationDeletionRequests").order("desc").paginate(args.paginationOpts);
  },
});

export const getOrgDetail = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    const counts: Record<string, number> = {};
    for (const entity of ["vehicles", "customers", "leads", "sales", "expenses", "tasks"] as const) {
      counts[entity] = (
        await ctx.db.query(entity).withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect()
      ).length;
    }

    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    return { org, settings, counts, subscription };
  },
});

export const suspendOrg = mutation({
  args: { orgId: v.id("organizations"), reason: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    await ctx.db.patch(args.orgId, {
      suspended: true,
      suspendedAt: Date.now(),
      suspendedReason: args.reason,
    });

    await notifyManagers(ctx, args.orgId, "admin.org_suspended", { reason: args.reason });

    await logAdminAction(ctx, admin, {
      action: "suspendOrg",
      targetTable: "organizations",
      targetId: args.orgId,
      orgId: args.orgId,
      before: { suspended: org.suspended ?? false },
      after: { suspended: true, reason: args.reason },
    });
  },
});

export const unsuspendOrg = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    const activeDeletionRequest = await findActiveDeletionRequest(ctx, args.orgId);
    if (activeDeletionRequest) {
      throwAppError(
        AppErrorCode.VALIDATION_FAILED,
        "This organization has an active deletion request and cannot be unsuspended."
      );
    }

    await ctx.db.patch(args.orgId, {
      suspended: false,
      suspendedAt: undefined,
      suspendedReason: undefined,
    });

    await notifyManagers(ctx, args.orgId, "admin.org_unsuspended", {});

    await logAdminAction(ctx, admin, {
      action: "unsuspendOrg",
      targetTable: "organizations",
      targetId: args.orgId,
      orgId: args.orgId,
      before: { suspended: true },
      after: { suspended: false },
    });
  },
});

export const approveDeletionRequest = mutation({
  args: {
    requestId: v.id("organizationDeletionRequests"),
    reviewNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const request = await ctx.db.get(args.requestId);
    if (!request) throwAppError(AppErrorCode.REQUEST_NOT_FOUND, "Deletion request not found.");
    if (request.status !== "PENDING_REVIEW") {
      throwAppError(AppErrorCode.VALIDATION_FAILED, "Only pending deletion requests can be approved.");
    }

    const org = await ctx.db.get(request.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    const now = Date.now();
    await ctx.db.patch(request.orgId, {
      suspended: true,
      suspendedAt: org.suspendedAt ?? now,
      suspendedReason: "Organization deletion approved by platform administration.",
      deletionRequestedAt: org.deletionRequestedAt ?? request.requestedAt,
      deletionRequestId: args.requestId,
    });
    await ctx.db.patch(args.requestId, {
      status: "RUNNING",
      reviewedBy: admin._id,
      reviewedAt: now,
      reviewNotes: args.reviewNotes,
      startedAt: now,
      currentStepIndex: 0,
      deletedCounts: {},
      lastProcessedAt: now,
    });

    await notifyManagers(ctx, request.orgId, "admin.org_deleted", {});
    await logAdminAction(ctx, admin, {
      action: "approveOrgDeletionRequest",
      targetTable: "organizationDeletionRequests",
      targetId: args.requestId,
      orgId: request.orgId,
      before: { status: request.status },
      after: { status: "RUNNING", reviewNotes: args.reviewNotes },
    });
    await scheduleDeletionBatch(ctx, args.requestId);

    return { requestId: args.requestId, status: "RUNNING" as const };
  },
});

export const rejectDeletionRequest = mutation({
  args: {
    requestId: v.id("organizationDeletionRequests"),
    reviewNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const request = await ctx.db.get(args.requestId);
    if (!request) throwAppError(AppErrorCode.REQUEST_NOT_FOUND, "Deletion request not found.");
    if (request.status !== "PENDING_REVIEW") {
      throwAppError(AppErrorCode.VALIDATION_FAILED, "Only pending deletion requests can be rejected.");
    }

    const org = await ctx.db.get(request.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    const now = Date.now();
    await ctx.db.patch(args.requestId, {
      status: "REJECTED",
      reviewedBy: admin._id,
      reviewedAt: now,
      reviewNotes: args.reviewNotes,
      lastProcessedAt: now,
    });
    await ctx.db.patch(request.orgId, {
      suspended: false,
      suspendedAt: undefined,
      suspendedReason: undefined,
      deletionRequestedAt: undefined,
      deletionRequestId: undefined,
    });

    await logAdminAction(ctx, admin, {
      action: "rejectOrgDeletionRequest",
      targetTable: "organizationDeletionRequests",
      targetId: args.requestId,
      orgId: request.orgId,
      before: { status: request.status },
      after: { status: "REJECTED", reviewNotes: args.reviewNotes },
    });

    return { requestId: args.requestId, status: "REJECTED" as const };
  },
});

export const hardDeleteOrg = mutation({
  args: { orgId: v.id("organizations"), confirmName: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    if (args.confirmName !== org.name) {
      throwAppError(AppErrorCode.VALIDATION_FAILED, "Confirmation text does not match the organization name.");
    }

    const existingRequest = await findActiveDeletionRequest(ctx, args.orgId);
    if (existingRequest) {
      throwAppError(AppErrorCode.PENDING_REQUEST_EXISTS, "This organization already has an active deletion request.");
    }

    const now = Date.now();
    const requestId = await ctx.db.insert("organizationDeletionRequests", {
      orgId: args.orgId,
      orgName: org.name,
      requestedBy: admin._id,
      requestedAt: now,
      reason: "Super-admin hard delete.",
      status: "RUNNING",
      reviewedBy: admin._id,
      reviewedAt: now,
      reviewNotes: "Approved by super-admin hard delete.",
      startedAt: now,
      currentStepIndex: 0,
      deletedCounts: {},
      lastProcessedAt: now,
    });

    await ctx.db.patch(args.orgId, {
      suspended: true,
      suspendedAt: org.suspendedAt ?? now,
      suspendedReason: "Organization deletion approved by platform administration.",
      deletionRequestedAt: now,
      deletionRequestId: requestId,
    });

    await notifyManagers(ctx, args.orgId, "admin.org_deleted", {});
    await logAdminAction(ctx, admin, {
      action: "hardDeleteOrg",
      targetTable: "organizations",
      targetId: args.orgId,
      orgId: args.orgId,
      before: { name: org.name },
      after: { requestId, status: "RUNNING" },
    });
    await scheduleDeletionBatch(ctx, requestId);

    return { requestId, status: "RUNNING" as const };
  },
});

export const runDeletionRequestBatch = internalMutation({
  args: { requestId: v.id("organizationDeletionRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) {
      return null;
    }
    if (request.status !== "RUNNING") {
      return { status: request.status };
    }

    try {
      const now = Date.now();
      const currentStepIndex = request.currentStepIndex ?? 0;

      if (currentStepIndex >= ORGANIZATION_DELETION_STEPS.length) {
        const org = await ctx.db.get(request.orgId);
        if (org) {
          await ctx.db.delete(request.orgId);
        }
        await ctx.db.patch(args.requestId, {
          status: "COMPLETED",
          completedAt: now,
          currentStepIndex,
          lastProcessedAt: now,
        });
        return { status: "COMPLETED" as const };
      }

      const step = ORGANIZATION_DELETION_STEPS[currentStepIndex];
      const batchCounts = await runDeletionStep(ctx, step, request.orgId);
      const deletedInBatch = countDeletedRows(batchCounts);

      if (deletedInBatch > 0) {
        await ctx.db.patch(args.requestId, {
          deletedCounts: mergeDeletedCounts(request.deletedCounts, batchCounts),
          lastProcessedAt: now,
        });
        await scheduleDeletionBatch(ctx, args.requestId);
        return { status: "RUNNING" as const, currentStepIndex, deletedInBatch };
      }

      await ctx.db.patch(args.requestId, {
        currentStepIndex: currentStepIndex + 1,
        lastProcessedAt: now,
      });
      await scheduleDeletionBatch(ctx, args.requestId);
      return { status: "RUNNING" as const, currentStepIndex: currentStepIndex + 1, deletedInBatch: 0 };
    } catch (error) {
      console.error("Organization deletion batch failed", {
        requestId: args.requestId,
        error,
      });
      await ctx.db.patch(args.requestId, {
        status: "FAILED",
        failedAt: Date.now(),
        error: "An unexpected error occurred while deleting the organization.",
        lastProcessedAt: Date.now(),
      });
      return { status: "FAILED" as const };
    }
  },
});
