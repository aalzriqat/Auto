import { mutation } from "./_generated/server";
import { ALL_PERMISSIONS } from "./utils/permissions";

/**
 * Migration to add missing permissions to all OWNER roles.
 */
export const updateOwnerPermissions = mutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").filter(q => q.eq(q.field("name"), "OWNER")).collect();
    
    let count = 0;
    for (const role of roles) {
      // Just reset the OWNER role to have ALL_PERMISSIONS from the current codebase
      await ctx.db.patch(role._id, {
        permissions: [...ALL_PERMISSIONS],
      });
      count++;
    }
    
    return `Updated ${count} OWNER roles.`;
  },
});
