import { internalMutation } from "./_generated/server";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";

export const fixExistingRoles = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;

    for (const role of roles) {
      // Find the corresponding template
      const template = DEFAULT_ROLE_TEMPLATES.find((t) => t.name === role.name);
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
      // already exempts role.name === "OWNER" from permission checks, but this
      // keeps the stored permission list accurate for UI display.
      if (role.name === "OWNER") {
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

      const missing = [...toAdd].filter((p) => !has(p));
      if (missing.length > 0) {
        await ctx.db.patch(role._id, {
          permissions: [...role.permissions, ...missing],
        });
        updatedCount++;
        updates.push(`${role.name} (${role.orgId}): +${missing.join(", ")}`);
      }
    }

    return { updatedCount, updates };
  },
});
