import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

export const DEFAULT_STAGES = [
  { stageKey: "NEW", label: "New", color: "#6b7280", order: 0 },
  { stageKey: "CONTACTED", label: "Contacted", color: "#3b82f6", order: 1 },
  { stageKey: "INTERESTED", label: "Interested", color: "#8b5cf6", order: 2 },
  { stageKey: "TEST_DRIVE", label: "Test Drive", color: "#f59e0b", order: 3 },
  { stageKey: "NEGOTIATION", label: "Negotiation", color: "#f97316", order: 4 },
  { stageKey: "RESERVED", label: "Reserved", color: "#06b6d4", order: 5 },
  { stageKey: "WON", label: "Won", color: "#22c55e", order: 6 },
  { stageKey: "LOST", label: "Lost", color: "#ef4444", order: 7 },
];

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);
    const stages = await ctx.db
      .query("orgPipelineStages")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    if (stages.length === 0) return [];
    return stages.sort((a, b) => a.order - b.order);
  },
});

export const seed = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    const existing = await ctx.db
      .query("orgPipelineStages")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const existingKeys = new Set(existing.map((s) => s.stageKey));
    for (const stage of DEFAULT_STAGES) {
      if (!existingKeys.has(stage.stageKey)) {
        await ctx.db.insert("orgPipelineStages", {
          orgId: args.orgId,
          ...stage,
          isActive: true,
        });
      }
    }
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    stageId: v.id("orgPipelineStages"),
    label: v.optional(v.string()),
    color: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    const { stageId, orgId, ...fields } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) patch[key] = value;
    }
    await ctx.db.patch(stageId, patch);
  },
});

export const reorder = mutation({
  args: {
    orgId: v.id("organizations"),
    orderedIds: v.array(v.id("orgPipelineStages")),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    for (let i = 0; i < args.orderedIds.length; i++) {
      await ctx.db.patch(args.orderedIds[i], { order: i });
    }
  },
});
