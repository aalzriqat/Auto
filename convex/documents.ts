import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { rateLimiter } from "./rateLimit";

// --- Rules ---

export const listRules = query({
  args: {
    orgId: v.id("organizations"),
    companyId: v.optional(v.id("financeCompanies")), // If not provided, returns global rules + company rules? Let's just return all for the org.
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId);
    if (
      !role.permissions.includes(PERMISSIONS.VIEW_SETTINGS) &&
      !role.permissions.includes(PERMISSIONS.VIEW_SALES)
    ) {
      throw new ConvexError("Forbidden: Missing required permissions: view:settings or view:sales");
    }

    return await ctx.db
      .query("companyDocumentRules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
  },
});

export const addRule = mutation({
  args: {
    orgId: v.id("organizations"),
    companyId: v.optional(v.id("financeCompanies")),
    documentName: v.string(),
    isRequired: v.boolean(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_SETTINGS]);

    await ctx.db.insert("companyDocumentRules", {
      orgId: args.orgId,
      companyId: args.companyId,
      documentName: args.documentName.trim(),
      isRequired: args.isRequired,
      description: args.description?.trim(),
    });
  },
});

export const removeRule = mutation({
  args: {
    orgId: v.id("organizations"),
    ruleId: v.id("companyDocumentRules"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_SETTINGS]);

    const rule = await ctx.db.get(args.ruleId);
    if (!rule || rule.orgId !== args.orgId) throw new ConvexError("Rule not found.");

    await ctx.db.delete(args.ruleId);
  },
});

// --- Application Documents ---

export const getForApplication = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const docs = await ctx.db
      .query("applicationDocuments")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .collect();

    return await Promise.all(
      docs.map(async (doc) => {
        const rule = await ctx.db.get(doc.ruleId);
        let fileUrl = null;
        if (doc.fileId) {
          fileUrl = await ctx.storage.getUrl(doc.fileId);
        }
        return {
          ...doc,
          ruleName: rule?.documentName || "Unknown Document",
          isRequired: rule?.isRequired || false,
          fileUrl,
        };
      })
    );
  },
});

export const generateUploadUrl = mutation({
  args: {
    orgId: v.id("organizations"),
    mimeType: v.string(),
    sizeInBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const statusLimit = await rateLimiter.limit(ctx, "upload");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    // Any user who can view sales can upload documents for applications
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    // 10MB limit for documents
    if (args.sizeInBytes > 10 * 1024 * 1024) {
      throw new ConvexError("File size exceeds 10MB limit.");
    }

    const validMimeTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!validMimeTypes.includes(args.mimeType)) {
      throw new ConvexError("Invalid file type. Only PDF and images are allowed.");
    }

    return await ctx.storage.generateUploadUrl();
  },
});

export const saveDocumentFile = mutation({
  args: {
    orgId: v.id("organizations"),
    documentId: v.id("applicationDocuments"),
    fileId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    // Any user who can view sales can attach documents to applications
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.orgId !== args.orgId) throw new ConvexError("Document not found");

    // Remove old file if exists
    if (doc.fileId) {
      await ctx.storage.delete(doc.fileId);
    }

    await ctx.db.patch(args.documentId, {
      fileId: args.fileId,
      status: "UPLOADED",
      uploadedAt: Date.now(),
      rejectionReason: undefined,
    });
  },
});

export const updateDocumentStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    documentId: v.id("applicationDocuments"),
    status: v.union(v.literal("VERIFIED"), v.literal("REJECTED"), v.literal("MISSING")),
    rejectionReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_SETTINGS]);

    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.orgId !== args.orgId) throw new ConvexError("Document not found");

    await ctx.db.patch(args.documentId, {
      status: args.status,
      rejectionReason: args.status === "REJECTED" ? args.rejectionReason : undefined,
      verifiedBy: args.status === "VERIFIED" ? auth.user._id : undefined,
    });
  },
});
