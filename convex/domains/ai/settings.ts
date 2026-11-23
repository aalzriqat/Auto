import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { AppErrorCode, throwAppError } from "../../utils/errors";
import { writeAuditLog as logAdminAction } from "../../utils/auditLog";
import { getValidatedEnv } from "../../utils/env";
import { isEncryptionConfigured } from "./keyCrypto";
import { isProviderKeySet, readProviderStatuses } from "./keyStore";

const ENABLED_ORGS_LIMIT = 100;

async function readMasterSwitch(ctx: QueryCtx): Promise<boolean> {
  const row = await ctx.db.query("aiSettings").first();
  return row?.draftsEnabled ?? false;
}

async function readOrgSwitch(ctx: QueryCtx, orgId: Id<"organizations">): Promise<boolean> {
  const row = await ctx.db
    .query("aiOrgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  return row?.draftsEnabled ?? false;
}

export async function readOrgAiSettings(ctx: QueryCtx, orgId: Id<"organizations">) {
  return { draftsEnabled: await readOrgSwitch(ctx, orgId) };
}

/** Everything the /admin AI page shows. No secret material. */
export async function readAiControlState(ctx: QueryCtx) {
  const enabledRows = await ctx.db
    .query("aiOrgSettings")
    .withIndex("by_draftsEnabled", (q) => q.eq("draftsEnabled", true))
    .take(ENABLED_ORGS_LIMIT);
  const enabledOrgs: { orgId: Id<"organizations">; name: string }[] = [];
  for (const row of enabledRows) {
    const org = await ctx.db.get(row.orgId);
    if (org) enabledOrgs.push({ orgId: org._id, name: org.name });
  }
  return {
    encryptionConfigured: isEncryptionConfigured(getValidatedEnv().AI_KEY_ENCRYPTION_KEY),
    draftsEnabled: await readMasterSwitch(ctx),
    providers: await readProviderStatuses(ctx),
    enabledOrgs,
  };
}

export async function setMasterSwitch(ctx: MutationCtx, actor: Doc<"users">, enabled: boolean): Promise<void> {
  const row = await ctx.db.query("aiSettings").first();
  const before = row?.draftsEnabled ?? false;
  if (row && before === enabled) return;
  if (!row && !enabled) return;
  const fields = { draftsEnabled: enabled, updatedAt: Date.now(), updatedBy: actor._id };
  const rowId = row ? row._id : await ctx.db.insert("aiSettings", fields);
  if (row) await ctx.db.patch(row._id, fields);
  await logAdminAction(ctx, actor, {
    action: "ai_drafts.master_switch",
    targetTable: "aiSettings",
    targetId: rowId,
    before: { draftsEnabled: before },
    after: { draftsEnabled: enabled },
  });
}

export async function setOrgSwitch(
  ctx: MutationCtx,
  actor: Doc<"users">,
  orgId: Id<"organizations">,
  enabled: boolean
): Promise<void> {
  const org = await ctx.db.get(orgId);
  if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");
  // A deletion in progress must not gain a row the purge may already have passed.
  if (org.deletionRequestedAt !== undefined || org.destructivePurgeStartedAt !== undefined) {
    throwAppError(AppErrorCode.VALIDATION_FAILED, "This organization is being deleted.");
  }
  const row = await ctx.db
    .query("aiOrgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  const before = row?.draftsEnabled ?? false;
  if (row && before === enabled) return;
  if (!row && !enabled) return;
  const fields = { draftsEnabled: enabled, updatedAt: Date.now(), updatedBy: actor._id };
  const rowId = row ? row._id : await ctx.db.insert("aiOrgSettings", { orgId, ...fields });
  if (row) await ctx.db.patch(row._id, fields);
  await logAdminAction(ctx, actor, {
    action: "ai_drafts.org_switch",
    targetTable: "aiOrgSettings",
    targetId: rowId,
    orgId,
    before: { draftsEnabled: before },
    after: { draftsEnabled: enabled },
  });
}

/**
 * The one gate for AI drafts: platform switch on AND dealership switch on AND
 * an Anthropic key stored. A missing row at any step reads as off.
 */
export async function isAiDraftEnabledForOrg(ctx: QueryCtx, orgId: Id<"organizations">): Promise<boolean> {
  if (!(await readMasterSwitch(ctx))) return false;
  if (!(await readOrgSwitch(ctx, orgId))) return false;
  return await isProviderKeySet(ctx, "anthropic");
}
