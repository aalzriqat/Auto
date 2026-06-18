import { internalMutation } from "./_generated/server";
import { ALL_PERMISSIONS } from "./utils/permissions";

export const backfillPermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all roles
    const roles = await ctx.db.query("roles").collect();

    for (const role of roles) {
      if (role.name === "OWNER") {
        // Owner gets all permissions
        await ctx.db.patch(role._id, {
          permissions: ALL_PERMISSIONS,
        });
      } else if (role.name === "MANAGER") {
        // Add new settings/approval permissions to MANAGER if not present.
        // manage:settings is intentionally NOT granted — settings administration
        // is restricted to OWNER only; approvals use the dedicated approve:requests permission.
        const permissions = new Set(role.permissions);
        permissions.add("view:settings");
        permissions.add("approve:requests");
        permissions.delete("manage:settings");

        await ctx.db.patch(role._id, {
          permissions: Array.from(permissions),
        });
      } else {
        // Other roles might need view:settings if we want them to see finance companies
        // but we'll fix listCompanies to use a less restrictive permission instead.
      }
    }

    return "Permissions backfilled successfully";
  },
});
