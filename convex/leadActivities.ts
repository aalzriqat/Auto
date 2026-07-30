import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

/**
 * Read side of the lead audit trail. Writes go through
 * `convex/utils/leadActivity.ts`, called from every mutation that touches a
 * lead — there is deliberately no mutation here, so the trail cannot be
 * authored or edited from the client.
 */

/** A dialog timeline doesn't need infinite scroll; cap the fan-out instead. */
const MAX_TIMELINE_ROWS = 200;

/**
 * Full timeline for one lead, newest first.
 *
 * Deleted leads still return their history — the trail is how you find out
 * what happened to a lead that vanished, so gating it on `isDeleted` would
 * hide exactly the case it exists for.
 */
export const listForLead = query({
  args: {
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    // The caller supplies both an orgId and a row id, so membership in the
    // named org proves nothing about this lead — bridge the gap on the row.
    await requireOwnedRow(ctx, args.orgId, "leads", args.leadId, "Lead not found in this organization.");

    const rows = await ctx.db
      .query("leadActivities")
      .withIndex("by_org_lead", (q) => q.eq("orgId", args.orgId).eq("leadId", args.leadId))
      .order("desc")
      .take(MAX_TIMELINE_ROWS);

    // Actor names are resolved at read time (unlike field values, which are
    // frozen at write time) so a renamed teammate reads correctly everywhere.
    const actorNames = new Map<string, string>();
    for (const row of rows) {
      if (!row.actorUserId || actorNames.has(row.actorUserId)) continue;
      const actor = await ctx.db.get(row.actorUserId);
      actorNames.set(row.actorUserId, actor?.name || actor?.email || "Unknown user");
    }

    return rows.map((row) => ({
      ...row,
      actorName: row.actorUserId
        ? actorNames.get(row.actorUserId) ?? "Unknown user"
        : row.actorLabel || "System",
      isSystemActor: !row.actorUserId,
    }));
  },
});
