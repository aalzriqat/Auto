import { v, ConvexError } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation } from "./functions";
import { requireTenantAuth, requireOwner, requireOwnedRow } from "./utils/tenancy";
import { IN_FLIGHT_FINANCE_STATUSES, SETTLED_FINANCE_STATUSES } from "./utils/financeStatuses";
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

/**
 * The rows the deal-document reads split: the application (null when missing
 * or foreign), the rules that currently apply to it, and every stored row.
 *
 * SCRUM-421: "applies" is EXACTLY the set
 * `assertRequiredApplicationDocumentsComplete` refuses approval on and
 * `dealCockpit` counts — live rules, through `ruleAppliesToQuote`. The active
 * checklist (`getForApplication`) and the history (`getHistoryForApplication`)
 * split the stored rows under this one predicate, so no row is in both.
 */
async function loadApplicationDocumentScope(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">
) {
  const application = await ctx.db.get(applicationId);
  if (!application || application.orgId !== orgId) return null;
  const { rulesById, applicableRules, applicableById } = await loadApplicableRules(ctx, orgId, application);

  const docs = await ctx.db
    .query("applicationDocuments")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .filter((q) => q.eq(q.field("orgId"), orgId))
    .collect();

  return { application, rulesById, applicableRules, applicableById, docs };
}

/**
 * The org's rules, and the subset that currently applies to this (already
 * tenant-checked) application's deal — through `ruleAppliesToQuote`. The one
 * applicability computation behind the active list, the history split and the
 * active-document command guard below: a row is "active" exactly when its rule
 * is in `applicableById`.
 */
async function loadApplicableRules(
  ctx: Pick<QueryCtx, "db">,
  orgId: Id<"organizations">,
  application: Doc<"financeApplications">
) {
  const quote = await ctx.db.get(application.quoteId);
  const dealQuote = quote && quote.orgId === orgId ? quote : null;

  const rules = await ctx.db
    .query("companyDocumentRules")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const rulesById = new Map(rules.map((rule) => [rule._id, rule]));
  const applicableRules = rules.filter((rule) => ruleAppliesToQuote(rule, dealQuote));
  const applicableById = new Map(applicableRules.map((rule) => [rule._id, rule]));
  return { rulesById, applicableRules, applicableById };
}

/**
 * SCRUM-422: a CLOSED or CANCELLED deal is settled record (owner ruling), so no
 * document command may change its rows, files or notifications. Checked right
 * after the tenant checks, before anything else can write.
 */
function assertApplicationDocumentsOpen(application: Doc<"financeApplications">) {
  if (SETTLED_FINANCE_STATUSES.includes(application.status)) {
    throw new ConvexError("This deal is closed or cancelled, so its documents can no longer be changed.");
  }
}

/**
 * SCRUM-417 round 4 (Codex S417-R4-1): stored evidence for a rule that no
 * longer applies to the deal — removed, or scoped to another finance company —
 * is history, shown view-only by `getHistoryForApplication`. It is immutable
 * through the active-document commands: only a row on the live applicable
 * list may be uploaded, replaced, verified, rejected or waived. Called after
 * the tenant/row checks and before any storage delete, patch or notification,
 * so a refusal changes nothing. Also stops an upload whose URL was issued
 * before the rule was removed from landing after it.
 */
async function assertDocumentRowIsActive(
  ctx: Pick<QueryCtx, "db">,
  orgId: Id<"organizations">,
  application: Doc<"financeApplications">,
  doc: Doc<"applicationDocuments">
) {
  const { applicableById } = await loadApplicableRules(ctx, orgId, application);
  if (!applicableById.has(doc.ruleId)) {
    throw new ConvexError("This document is no longer required for this deal, so it can't be changed.");
  }
}

export const getForApplication = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);

    const scope = await loadApplicationDocumentScope(ctx, args.orgId, args.applicationId);
    if (!scope) return [];
    const { application, applicableRules, applicableById, docs } = scope;

    /**
     * SCRUM-421: the panel lists EXACTLY the rules that currently apply to this
     * deal. A stored row whose rule was removed (or no longer applies) is left
     * in storage untouched but is not listed here: an Upload or Verify control
     * on it would act on a requirement the guard no longer enforces (SCRUM-417
     * round 2, S421-R2-3/R2-4). Its file stays reachable, view-only, through
     * `getHistoryForApplication` (round 3, Codex S417-R3-1).
     */
    const activeDocs = docs.filter((doc) => applicableById.has(doc.ruleId));

    const materialized = await Promise.all(
      activeDocs.map(async (doc) => {
        const rule = applicableById.get(doc.ruleId);
        const fileUrl = doc.fileId ? await ctx.storage.getUrl(doc.fileId) : null;
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
     *
     * Only while the deal is still in the finance pipeline: that mutation
     * refuses anything else (S417-R2-1), so a row-less line on a cancelled,
     * closed or rejected deal would be a control guaranteed to fail.
     */
    if (!IN_FLIGHT_FINANCE_STATUSES.includes(application.status)) return materialized;
    const materializedRuleIds = new Set(docs.map((doc) => doc.ruleId));
    const unmaterialized = applicableRules
      .filter((rule) => !materializedRuleIds.has(rule._id))
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
 * Stored rows that are no longer on the active checklist and still carry a
 * file — the evidence of a requirement removed (or no longer applying) after
 * the upload (SCRUM-417 round 3, Codex S417-R3-1).
 *
 * Read-only history: nothing here is actionable, and nothing here counts
 * toward approval — the checklist and the approval guard still read live
 * applicable rules only. A row with no file is omitted: there is nothing to
 * view. `ruleName` is null when the rule itself was deleted; the screen labels
 * that line. A separate query rather than a new field on `getForApplication`,
 * which returns an array: a client built against that shape keeps working
 * unchanged. Same permission and tenancy as `getForApplication`.
 */
export const getHistoryForApplication = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);

    const scope = await loadApplicationDocumentScope(ctx, args.orgId, args.applicationId);
    if (!scope) return [];
    const { rulesById, applicableById, docs } = scope;

    const history = await Promise.all(
      docs
        .filter((doc) => !applicableById.has(doc.ruleId) && doc.fileId !== undefined)
        .map(async (doc) => ({
          _id: doc._id,
          ruleId: doc.ruleId,
          status: doc.status,
          ruleName: rulesById.get(doc.ruleId)?.documentName ?? null,
          uploadedAt: doc.uploadedAt ?? null,
          fileUrl: doc.fileId ? await ctx.storage.getUrl(doc.fileId) : null,
        }))
    );
    // A storage object that is gone has nothing to show.
    return history.filter((row) => row.fileUrl !== null);
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
 *
 * Only for a deal still in the finance pipeline (`IN_FLIGHT_FINANCE_STATUSES`,
 * the one shared definition): a late rule applies to in-flight deals, and a
 * cancelled, closed or rejected application is not one. (The transition map
 * lists REJECTED → PENDING_DOCS, but `updateStatus` refuses that re-entry
 * today; if it opens, late rows are materialized then.) Refused before any write.
 * Ownership of the application, the rule and the deal's quote goes through
 * `requireOwnedRow` (TEN-1), with the messages the callers already surface.
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

    const application = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      "Application not found"
    );
    if (!IN_FLIGHT_FINANCE_STATUSES.includes(application.status)) {
      throw new ConvexError(
        "This deal is no longer in progress, so a new document requirement cannot be added to it."
      );
    }
    const rule = await requireOwnedRow(ctx, args.orgId, "companyDocumentRules", args.ruleId, "Rule not found.");
    const quote = await requireOwnedRow(
      ctx,
      args.orgId,
      "quotes",
      application.quoteId,
      "Application quote not found."
    );
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
    /**
     * SCRUM-422: the document the URL is for. Optional only for release skew
     * (the frontend deploys before the backend); when named, a settled deal
     * gets no URL. The record itself is guarded by `saveDocumentFile` either way.
     */
    documentId: v.optional(v.id("applicationDocuments")),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId);
    if (!hasAnyPermission(role, [PERMISSIONS.CREATE_FINANCE_APPLICATION, PERMISSIONS.VERIFY_FINANCE_DOCUMENTS])) {
      throw new ConvexError("Forbidden: Missing required finance document permissions.");
    }

    if (args.documentId !== undefined) {
      const doc = await ctx.db.get(args.documentId);
      if (!doc || doc.orgId !== args.orgId) throw new ConvexError("Document not found");
      const application = await ctx.db.get(doc.applicationId);
      if (!application || application.orgId !== args.orgId) throw new ConvexError("Application not found");
      assertApplicationDocumentsOpen(application);
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
    assertApplicationDocumentsOpen(application);
    await assertDocumentRowIsActive(ctx, args.orgId, application, doc);
    await assertStoredFileAllowed(ctx, {
      storageId: args.fileId,
      allowedContentTypes: FINANCE_DOCUMENT_CONTENT_TYPES,
      maxSizeBytes: 10 * 1024 * 1024,
      label: "Finance document",
    });

    // A stored file belongs to one document row. Deleting a replaced file must
    // never pull evidence out from under another row, least of all a settled
    // deal's (SCRUM-422), so a file another row holds is refused here, and a
    // replaced file some other row still references (a legacy alias) is kept.
    if (doc.fileId === args.fileId) return;
    const holders = await ctx.db
      .query("applicationDocuments")
      .withIndex("by_file", (q) => q.eq("fileId", args.fileId))
      .take(1);
    if (holders.length > 0) {
      throw new ConvexError("This file is already attached to another document. Upload it again for this document.");
    }

    if (doc.fileId) {
      const oldFileId = doc.fileId;
      const otherHolders = await ctx.db
        .query("applicationDocuments")
        .withIndex("by_file", (q) => q.eq("fileId", oldFileId))
        .take(2);
      if (!otherHolders.some((row) => row._id !== doc._id)) {
        await ctx.storage.delete(oldFileId);
      }
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
    assertApplicationDocumentsOpen(application);
    await assertDocumentRowIsActive(ctx, args.orgId, application, doc);

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
