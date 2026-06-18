import { query } from "./_generated/server";
import { requireSuperAdmin } from "./utils/tenancy";

/**
 * Non-throwing check used by the /admin layout to decide whether to render
 * the dashboard or redirect. Real authorization for every admin query/mutation
 * still goes through requireSuperAdmin directly.
 */
export const isSuperAdmin = query({
  args: {},
  handler: async (ctx) => {
    try {
      await requireSuperAdmin(ctx);
      return true;
    } catch {
      return false;
    }
  },
});
