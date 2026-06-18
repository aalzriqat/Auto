import { query } from "./_generated/server";
import { requireSupportAgent } from "./utils/tenancy";

/**
 * Non-throwing check used by the /support layout (and the dashboard entry
 * page's onboarding redirect) to decide where a signed-in user belongs.
 * Real authorization for every live-chat agent query/mutation still goes
 * through requireSupportAgent directly.
 */
export const isSupportAgent = query({
  args: {},
  handler: async (ctx) => {
    try {
      await requireSupportAgent(ctx);
      return true;
    } catch {
      return false;
    }
  },
});
