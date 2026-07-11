import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { PERMISSIONS } from "./permissions";

const SALES_ROLE_NAME = "SALES";
const MAX_MEMBERS_TO_SCAN = 200;

function canReceiveGeneratedLeads(role: Doc<"roles"> | null): boolean {
  if (!role || role.isDeleted) return false;
  if (role.name.trim().toUpperCase() === SALES_ROLE_NAME) return true;

  return (
    !role.permissions.includes(PERMISSIONS.MANAGE_USERS) &&
    role.permissions.includes(PERMISSIONS.VIEW_LEADS) &&
    role.permissions.includes(PERMISSIONS.CREATE_LEADS) &&
    role.permissions.includes(PERMISSIONS.EDIT_LEADS)
  );
}

async function isActiveOrgMember(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">
) {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .unique();
  if (!membership) return false;

  const user = await ctx.db.get(userId);
  return Boolean(user && !user.disabled);
}

async function eligibleSalesUsers(ctx: MutationCtx, orgId: Id<"organizations">) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_MEMBERS_TO_SCAN);

  const eligible: Array<Id<"users">> = [];
  for (const membership of memberships) {
    const role = await ctx.db.get(membership.roleId);
    if (!canReceiveGeneratedLeads(role)) continue;

    const user = await ctx.db.get(membership.userId);
    if (!user || user.disabled) continue;
    eligible.push(membership.userId);
  }

  return eligible;
}

export async function nextGeneratedLeadAssignee(
  ctx: MutationCtx,
  orgId: Id<"organizations">
): Promise<Id<"users"> | undefined> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (settings?.generatedLeadAutoAssignmentEnabled !== true) return undefined;

  const eligible = await eligibleSalesUsers(ctx, orgId);
  if (eligible.length === 0) return undefined;

  const cursor = await ctx.db
    .query("leadAssignmentCursors")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();

  const lastIndex = cursor?.lastAssignedUserId
    ? eligible.findIndex((userId) => userId === cursor.lastAssignedUserId)
    : -1;
  const nextIndex = lastIndex >= 0 ? (lastIndex + 1) % eligible.length : 0;
  const nextUserId = eligible[nextIndex];

  const updatedAt = Date.now();
  if (cursor) {
    await ctx.db.patch(cursor._id, { lastAssignedUserId: nextUserId, updatedAt });
  } else {
    await ctx.db.insert("leadAssignmentCursors", {
      orgId,
      lastAssignedUserId: nextUserId,
      updatedAt,
    });
  }

  return nextUserId;
}

export async function resolveGeneratedLeadAssignee(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  explicitUserId?: Id<"users">
): Promise<Id<"users"> | undefined> {
  if (explicitUserId && await isActiveOrgMember(ctx, orgId, explicitUserId)) {
    return explicitUserId;
  }

  return await nextGeneratedLeadAssignee(ctx, orgId);
}

/** Finds or creates the buyer's customer record for a marketplace conversion (trade-in acceptance, request response). Shared so the two call sites don't drift on the "Marketplace Buyer" placeholder lastName. */
export async function getOrCreateMarketplaceBuyerCustomer(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  phone: string,
  firstName: string,
  whatsapp?: string
): Promise<Id<"customers">> {
  const existing = await ctx.db
    .query("customers")
    .withIndex("by_org_phone", (q) => q.eq("orgId", orgId).eq("phone", phone))
    .first();
  if (existing) return existing._id;

  return await ctx.db.insert("customers", { orgId, firstName, lastName: "Marketplace Buyer", phone, whatsapp });
}
