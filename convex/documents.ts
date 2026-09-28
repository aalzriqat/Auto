import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { mutation } from "./functions";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { checkTenantWriteLimit } from "./rateLimit";
import { notifyUser } from "./utils/notifications";
import {
  assertStoredFileAllowed,
  FINANCE_DOCUMENT_CONTENT_TYPES,
} from "./utils/storageValidation";

function hasAnyPermission(role: { permissions: string[]; isSystemOwnerRole?: boolean; name: string }, permissions: string[]) {
  return isSystemOwnerRole(role) || permissions.some((permission) => role.permissions.includes(permission));
}

/**
 * Whether a document rule applies to a deal: an org-wide rule, or one for the
 * deal's own finance company. The SAME predicate `createFromQuote` uses to
 * materialize rows and `assertRequiredApplicationDocumentsComplete` uses to
 * refuse approval — a checklist that counted a different set would name rows
 * the gate ignores, or hide rows the gate demands.
 */
function ruleAppliesToQuote(
  rule: Pick<Doc<"companyDocumentRules">, "companyId">,
  quote: Pick<Doc<"quotes">, "companyId"> | null
) {
  return !rule.companyId || rule.companyId === quote?.companyId;
}

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
      !role.permissions.includes(PERMISSIONS.VIEW_FINANCE_APPLICATIONS) &&
      !isSystemOwnerRole(role)
    ) {
      throw new ConvexError("Forbidden: Missing required permissions: view:settings or view:finance_applications");
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
    await requireOwner(ctx, args.orgId);

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
    await requireOwner(ctx, args.orgId);

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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);

    const docs = await ctx.db
      .query("applicationDocuments")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .collect();

    const materialized = await Promise.all(
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

    /**
     * SCRUM-421: a rule added AFTER the application was created has no row —
     * `createFromQuote` materializes rows only at creation — yet the approval
     * gate reads live rules and counts it MISSING. It is listed here, row-less
     * (`_id: null`), so the checklist can offer its upload; the row itself is
     * created on first use by `ensureApplicationDocument`.
     */
    const application = await ctx.db.get(args.applicationId);
    if (!application || application.orgId !== args.orgId) return materialized;
    const quote = await ctx.db.get(application.quoteId);
    const dealQuote = quote && quote.orgId === args.orgId ? quote : null;
    const rules = await ctx.db
      .query("companyDocumentRules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const materializedRuleIds = new Set(docs.map((doc) => doc.ruleId));
    const unmaterialized = rules
      .filter((rule) => ruleAppliesToQuote(rule, dealQuote) && !materializedRuleIds.has(rule._id))
      .map((rule) => ({
        _id: null,
        ruleId: rule._id,
        status: "MISSING" as const,
        ruleName: rule.documentName,
        isRequired: rule.isRequired,
        fileUrl: null,
      }));

    return [...materialized, ...unmaterialized];
  },
});

/**
 * The per-deal row for a rule, created on first use (SCRUM-421).
 *
 * Returns the existing row when there is one — so a retry, a double click or
 * two operators at once converge on ONE row (two concurrent calls both read the
 * `by_application` range, so Convex's OCC serializes them and the second sees
 * the first's insert). Otherwise inserts exactly the row `createFromQuote`
 * inserts at creation. Authorized like an upload, because it exists only to
 * make an upload or a waiver possible: tenant membership plus create or verify.
 */
export const ensureApplicationDocument = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    ruleId: v.id("companyDocumentRules"),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId);
    if (!hasAnyPermission(role, [PERMISSIONS.CREATE_FINANCE_APPLICATION, PERMISSIONS.VERIFY_FINANCE_DOCUMENTS])) {
      throw new ConvexError("Forbidden: Missing required finance document permissions.");
    }

    const application = await ctx.db.get(args.applicationId);
    if (!application || application.orgId !== args.orgId) throw new ConvexError("Application not found");
    const rule = await ctx.db.get(args.ruleId);
    if (!rule || rule.orgId !== args.orgId) throw new ConvexError("Rule not found.");
    const quote = await ctx.db.get(application.quoteId);
    if (!quote || quote.orgId !== args.orgId) throw new ConvexError("Application quote not found.");
    if (!ruleAppliesToQuote(rule, quote)) {
      throw new ConvexError("This document rule does not apply to this deal's finance company.");
    }

    const rows = await ctx.db
      .query("applicationDocuments")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .collect();
    const existing = rows.find((row) => row.ruleId === args.ruleId && row.orgId === args.orgId);
    if (existing) return existing._id;

    return await ctx.db.insert("applicationDocuments", {
      orgId: args.orgId,
      applicationId: args.applicationId,
      ruleId: args.ruleId,
      status: "MISSING",
    });
  },
});

export const generateUploadUrl = mutation({
  args: {
    orgId: v.id("organizations"),
    mimeType: v.string(),
    sizeInBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId);
    if (!hasAnyPermission(role, [PERMISSIONS.CREATE_FINANCE_APPLICATION, PERMISSIONS.VERIFY_FINANCE_DOCUMENTS])) {
      throw new ConvexError("Forbidden: Missing required finance document permissions.");
    }

    const statusLimit = await checkTenantWriteLimit(ctx, "upload", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    // 10MB limit for documents
    if (args.sizeInBytes > 10 * 1024 * 1024) {
      throw new ConvexError("File size exceeds 10MB limit.");
    }

    if (!FINANCE_DOCUMENT_CONTENT_TYPES.includes(args.mimeType.toLowerCase() as typeof FINANCE_DOCUMENT_CONTENT_TYPES[number])) {
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
    const { role } = await requireTenantAuth(ctx, args.orgId);
    if (!hasAnyPermission(role, [PERMISSIONS.CREATE_FINANCE_APPLICATION, PERMISSIONS.VERIFY_FINANCE_DOCUMENTS])) {
      throw new ConvexError("Forbidden: Missing required finance document permissions.");
    }

    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.orgId !== args.orgId) throw new ConvexError("Document not found");
    const application = await ctx.db.get(doc.applicationId);
    if (!application || application.orgId !== args.orgId) throw new ConvexError("Application not found");
    await assertStoredFileAllowed(ctx, {
      storageId: args.fileId,
      allowedContentTypes: FINANCE_DOCUMENT_CONTENT_TYPES,
      maxSizeBytes: 10 * 1024 * 1024,
      label: "Finance document",
    });

    // Remove old file if exists
    if (doc.fileId) {
      await ctx.storage.delete(doc.fileId);
    }

    await ctx.db.patch(args.documentId, {
      fileId: args.fileId,
      status: "UPLOADED",
      uploadedAt: Date.now(),
      rejectionReason: undefined,
      waiverReason: undefined,
      waivedBy: undefined,
      waivedAt: undefined,
    });
  },
});

export const updateDocumentStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    documentId: v.id("applicationDocuments"),
    status: v.union(v.literal("VERIFIED"), v.literal("REJECTED"), v.literal("MISSING"), v.literal("WAIVED")),
    rejectionReason: v.optional(v.string()),
    waiverReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VERIFY_FINANCE_DOCUMENTS]);

    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.orgId !== args.orgId) throw new ConvexError("Document not found");
    const application = await ctx.db.get(doc.applicationId);
    if (!application || application.orgId !== args.orgId) throw new ConvexError("Application not found");

    if (args.status === "VERIFIED" && !doc.fileId) {
      throw new ConvexError("A document file must be uploaded before it can be verified.");
    }
    if (args.status === "REJECTED" && !args.rejectionReason?.trim()) {
      throw new ConvexError("A rejection reason is required.");
    }
    if (args.status === "WAIVED" && !args.waiverReason?.trim()) {
      throw new ConvexError("A waiver reason is required.");
    }

    await ctx.db.patch(args.documentId, {
      status: args.status,
      rejectionReason: args.status === "REJECTED" ? args.rejectionReason?.trim() : undefined,
      waiverReason: args.status === "WAIVED" ? args.waiverReason?.trim() : undefined,
      verifiedBy: args.status === "VERIFIED" ? auth.user._id : undefined,
      waivedBy: args.status === "WAIVED" ? auth.user._id : undefined,
      waivedAt: args.status === "WAIVED" ? Date.now() : undefined,
    });

    const rule = await ctx.db.get(doc.ruleId);
    if (application) {
      await notifyUser(
        ctx,
        args.orgId,
        application.salespersonId,
        "document.status_changed",
        { documentLabel: rule?.documentName ?? "Document", status: args.status.toLowerCase() },
        { link: `/${args.orgId}/applications` }
      );
    }
  },
});
