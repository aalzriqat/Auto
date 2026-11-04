import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { resolveDealNumber } from "./utils/dealNumber";
import { parseDealNumberQuery } from "./utils/dealNumberFormat";

/**
 * SCRUM-808: find a deal by the number people say and share (`D-000123`, `123`, Arabic-Indic digits too), within the
 * caller's organization. No screen calls it yet: the web app's global search (`search.globalSearch`) uses the same
 * resolver. It is the direct lookup for clients that only need the deal (the mobile app, links). Same permission as
 * the Deals list and both deal screens.
 */
export const find = query({
  args: { orgId: v.id("organizations"), query: v.string() },
  returns: v.union(
    v.null(),
    v.object({ kind: v.literal("application"), id: v.id("financeApplications"), dealNumber: v.number() }),
    v.object({ kind: v.literal("sale"), id: v.id("sales"), dealNumber: v.number() }),
  ),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const dealNumber = parseDealNumberQuery(args.query);
    if (dealNumber === null) return null;
    return await resolveDealNumber(ctx, args.orgId, dealNumber);
  },
});
