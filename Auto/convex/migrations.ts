import { mutation } from "./_generated/server";
import { PERMISSIONS } from "./utils/permissions";

export const grantTaskPermissionsToAll = mutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    
    let count = 0;
    for (const role of roles) {
      const currentPerms = role.permissions || [];
      const newPerms = new Set(currentPerms);
      
      // Give everyone view and create tasks
      newPerms.add(PERMISSIONS.VIEW_TASKS);
      newPerms.add(PERMISSIONS.CREATE_TASKS);

      await ctx.db.patch(role._id, {
        permissions: Array.from(newPerms),
      });
      count++;
    }
    
    return `Granted task permissions to ${count} roles.`;
  },
});
