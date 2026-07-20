import { internalMutation, MutationCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import {
  DEFAULT_ROLE_TEMPLATES,
  PERMISSIONS,
  SYSTEM_OWNER_ROLE_NAME,
  isSystemOwnerRole,
  normalizeRoleName,
} from "./utils/permissions";

export const fixExistingRoles = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;

    for (const role of roles) {
      // Find the corresponding template
      const template = DEFAULT_ROLE_TEMPLATES.find((t) => normalizeRoleName(t.name) === normalizeRoleName(role.name));
      if (template) {
        // We only want to ensure VIEW_USERS is present for these specific roles
        // Or we can just sync the permissions entirely if they haven't been customized,
        // but for safety, let's just add VIEW_USERS if it's in the template but missing from the DB.

        if (template.permissions.includes("view:users") && !role.permissions.includes("view:users")) {
          await ctx.db.patch(role._id, {
            permissions: [...role.permissions, "view:users"],
          });
          updatedCount++;
        }
      }
    }

    return `Fixed ${updatedCount} roles by adding view:users permission.`;
  },
});

/**
 * Shared by the capability-matching backfills below: patches a role with
 * whichever permissions from `toAdd` it's missing, and — for any OWNER-named
 * row — explicitly sets `isSystemOwnerRole: true` if unset. That flag matters
 * beyond just the permissions array: `isSystemOwnerRole()`'s fallback check
 * (see utils/permissions.ts) requires the stored `permissions` array to
 * contain literally every currently-defined permission, so any row missing
 * the explicit flag fails closed on every future permission addition, not
 * just the one this particular backfill is fixing.
 */
async function patchRoleIfNeeded(
  ctx: MutationCtx,
  role: Doc<"roles">,
  toAdd: Set<string>,
  updates: string[]
): Promise<boolean> {
  const missing = [...toAdd].filter((p) => !role.permissions.includes(p));
  const isStaleOwnerRow = normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME && !role.isSystemOwnerRole;
  if (missing.length === 0 && !isStaleOwnerRow) return false;

  await ctx.db.patch(role._id, {
    permissions: [...role.permissions, ...missing],
    ...(normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME ? { isSystemOwnerRole: true } : {}),
  });
  updates.push(`${role.name} (${role.orgId}): +${missing.join(", ")}`);
  return true;
}

/**
 * One-time backfill for the new finance-application permissions (Phase 9 / PR #2).
 * Matches by existing capability rather than role name, since orgs can rename
 * roles (e.g. a "SALES" role renamed to "المبيعات" still has create:sales).
 */
export const backfillFinanceApplicationPermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      const has = (p: string) => role.permissions.includes(p);
      const toAdd = new Set<string>();

      // Finance/accounting-capable roles get visibility + disbursement confirmation.
      if (has("manage:finance") || has("view:finance")) {
        toAdd.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
        toAdd.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
        toAdd.add(PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);
      }
      // Roles that already approve other requests get approval + finalization authority.
      if (has("approve:requests")) {
        toAdd.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
        toAdd.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
        toAdd.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
      }
      // Sales-capable roles can view/create applications for deals they work.
      if (has("create:sales")) {
        toAdd.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
        toAdd.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
      }
      // Owners always get full finance-application authority. requireTenantAuth
      // exempts only the immutable system owner role from permission checks; this
      // keeps the stored permission list accurate for UI display.
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        [
          PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
          PERMISSIONS.CREATE_FINANCE_APPLICATION,
          PERMISSIONS.REVIEW_FINANCE_APPLICATION,
          PERMISSIONS.APPROVE_FINANCE_APPLICATION,
          PERMISSIONS.FINALIZE_FINANCED_DEAL,
          PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
          PERMISSIONS.VERIFY_FINANCE_DOCUMENTS,
        ].forEach((p) => toAdd.add(p));
      }

      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

/**
 * One-time backfill for the new REOPEN_PERIODS permission (accounting
 * autonomy remediation, Phase 7). Deliberately narrower than every backfill
 * above: this permission is NOT granted to any capability-matched role, only
 * to OWNER rows — the whole point is that an org grants it to a controller
 * role explicitly, not automatically to whoever already holds MANAGE_FINANCE
 * (the default ACCOUNTANT template shouldn't gain the ability to reopen a
 * closed period just because this migration ran). Still needed for every
 * OWNER row regardless: any legacy OWNER row missing the explicit
 * isSystemOwnerRole flag fails the isSystemOwnerRole() fallback check the
 * instant ANY new permission is added to the PERMISSIONS registry, not just
 * this one — see patchRoleIfNeeded's own comment.
 */
export const backfillReopenPeriodsPermission = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      if (!(isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME)) continue;

      const toAdd = new Set<string>([PERMISSIONS.REOPEN_PERIODS]);
      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

/**
 * One-time backfill for the new Dealer Network Marketplace permissions
 * (Phase 56/57, PR #52). Same capability-matching approach as
 * backfillFinanceApplicationPermissions above: any org whose OWNER role
 * predates this PR still has `isSystemOwnerRole` unset, which makes the
 * `isSystemOwnerRole()` fallback check in utils/permissions.ts fail closed
 * against *every* newly-added permission (not just these three) until the
 * row is explicitly flagged — see that function's own comment. This also
 * fixes that root cause going forward for the affected org, not just this
 * one permission set.
 */
export const backfillMarketplacePermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      const has = (p: string) => role.permissions.includes(p);
      const toAdd = new Set<string>();

      // Manager-capable roles (website management is a reliable MANAGER-only
      // signal in the default templates, unlike name which orgs can rename).
      if (has(PERMISSIONS.WEBSITE_MANAGE)) {
        toAdd.add(PERMISSIONS.MARKETPLACE_SETTINGS);
        toAdd.add(PERMISSIONS.MARKETPLACE_RESPOND);
        toAdd.add(PERMISSIONS.MARKETPLACE_ANALYTICS);
      }
      // Sales-capable roles only get the day-to-day action, matching the
      // SALES default template (not settings/analytics).
      if (has(PERMISSIONS.CREATE_SALES_REQUEST)) {
        toAdd.add(PERMISSIONS.MARKETPLACE_RESPOND);
      }
      // Owners always get full marketplace authority, same reasoning as the
      // finance-application backfill above.
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        toAdd.add(PERMISSIONS.MARKETPLACE_SETTINGS);
        toAdd.add(PERMISSIONS.MARKETPLACE_RESPOND);
        toAdd.add(PERMISSIONS.MARKETPLACE_ANALYTICS);
      }

      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

/**
 * One-time backfill for the new expense permissions added to the ACCOUNTANT
 * default template (accounting-pilot readiness review). `manage:finance` is
 * a reliable ACCOUNTANT-only signal among the default templates — MANAGER
 * doesn't hold it — same capability-matching approach as the two backfills
 * above, so a renamed ACCOUNTANT role (or a custom role built with the same
 * capability) still gets picked up.
 */
export const backfillAccountantExpensePermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      const has = (p: string) => role.permissions.includes(p);
      const toAdd = new Set<string>();

      if (has(PERMISSIONS.MANAGE_FINANCE)) {
        toAdd.add(PERMISSIONS.CREATE_EXPENSES);
        toAdd.add(PERMISSIONS.EDIT_EXPENSES);
      }
      // Owners always get every permission, same reasoning as the backfills above.
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        toAdd.add(PERMISSIONS.CREATE_EXPENSES);
        toAdd.add(PERMISSIONS.EDIT_EXPENSES);
      }

      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

/**
 * One-time backfill for the new SENIOR_ACCOUNTANT role template (founder-
 * independence readiness review). Unlike the backfills above, this doesn't
 * patch an existing role's permissions — it INSERTS the new role for every
 * org that already runs finance day-to-day (has an ACCOUNTANT-capable role,
 * i.e. one holding manage:finance) but has no SENIOR_ACCOUNTANT row yet, so
 * the role is selectable in Team settings without waiting for the org to
 * create it manually. Idempotent: an org that already has a role named
 * SENIOR_ACCOUNTANT (however its permissions were customized) is skipped
 * rather than getting a duplicate. Assigning any member to the new role is
 * left to the org — this only makes the role available.
 */
/**
 * Grant the new payroll permissions to roles that should have them: every
 * OWNER (so isSystemOwnerRole keeps holding — a new PERMISSIONS entry otherwise
 * breaks it for legacy owner rows), plus any role that already manages finance
 * or commissions. Run once after deploying the payroll feature.
 */
export const backfillPayrollPermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      const has = (p: string) => role.permissions.includes(p);
      const toAdd = new Set<string>();

      // Payroll is a FINANCE capability, not a commissions one: salaries and
      // advances are sensitive, so a role that only manages commissions must
      // NOT silently become a payroll administrator. Finance-managing roles
      // get both; roles still named after a default template whose template
      // now carries payroll permissions get exactly what the template grants
      // (mirrors what a fresh org would create). Renamed custom roles beyond
      // that are a deliberate manual grant by the org owner.
      if (has(PERMISSIONS.MANAGE_FINANCE)) {
        toAdd.add(PERMISSIONS.VIEW_PAYROLL);
        toAdd.add(PERMISSIONS.MANAGE_PAYROLL);
      }
      const template = DEFAULT_ROLE_TEMPLATES.find(
        (t) => normalizeRoleName(t.name) === normalizeRoleName(role.name)
      );
      if (template) {
        if (template.permissions.includes(PERMISSIONS.VIEW_PAYROLL)) toAdd.add(PERMISSIONS.VIEW_PAYROLL);
        if (template.permissions.includes(PERMISSIONS.MANAGE_PAYROLL)) toAdd.add(PERMISSIONS.MANAGE_PAYROLL);
      }
      // Owners always get every permission.
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        toAdd.add(PERMISSIONS.VIEW_PAYROLL);
        toAdd.add(PERMISSIONS.MANAGE_PAYROLL);
      }

      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

export const backfillSeniorAccountantRole = internalMutation({
  args: {},
  handler: async (ctx) => {
    const allRoles = await ctx.db.query("roles").collect();
    const rolesByOrg = new Map<string, Doc<"roles">[]>();
    for (const role of allRoles) {
      if (role.isDeleted) continue;
      const key = role.orgId.toString();
      const list = rolesByOrg.get(key);
      if (list) list.push(role);
      else rolesByOrg.set(key, [role]);
    }

    const template = DEFAULT_ROLE_TEMPLATES.find((t) => t.name === "SENIOR_ACCOUNTANT");
    if (!template) throw new Error("SENIOR_ACCOUNTANT template not found in DEFAULT_ROLE_TEMPLATES.");

    let createdCount = 0;
    const created: string[] = [];

    for (const [orgId, orgRoles] of rolesByOrg) {
      const hasAccountantCapability = orgRoles.some((r) => r.permissions.includes(PERMISSIONS.MANAGE_FINANCE));
      const hasSeniorAccountantAlready = orgRoles.some(
        (r) => normalizeRoleName(r.name) === normalizeRoleName("SENIOR_ACCOUNTANT")
      );
      if (!hasAccountantCapability || hasSeniorAccountantAlready) continue;

      await ctx.db.insert("roles", {
        orgId: orgRoles[0].orgId,
        name: template.name,
        permissions: [...template.permissions],
      });
      createdCount++;
      created.push(orgId);
    }

    return { createdCount, created };
  },
});
