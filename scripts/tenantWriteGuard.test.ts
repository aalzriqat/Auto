/**
 * Contract test for the cross-tenant write shape (audit roadmap item 6).
 *
 * Two Criticals shipped because three of five structurally identical `org*`
 * modules bridged the gap between "the caller may act in org X" and "this row
 * belongs to org X", and two did not — and nothing in the toolchain could tell
 * them apart. Fixing the two instances does not stop the sixth module. This
 * does.
 *
 * The self-tests below come first on purpose: a guard nobody has watched fail is
 * not a guard. They pin that the analyzer flags the exact pre-fix source of
 * `orgPipelineStages.update` and clears the post-fix source, so a future edit
 * that neuters the analyzer fails here rather than silently passing everything.
 */
import { describe, expect, test } from "vitest";
import path from "node:path";
import { auditConvexBackend, findUnguardedTenantWrites, summarizeCoverage } from "./tenantWriteGuard";

const CONVEX_ROOT = path.resolve(__dirname, "..", "convex");

/** Verbatim shape of `orgPipelineStages.update` as it shipped, pre-fix. */
const VULNERABLE = `
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    stageId: v.id("orgPipelineStages"),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    const { stageId, orgId, ...fields } = args;
    await ctx.db.patch(stageId, fields);
  },
});
`;

/** The same handler with the ownership check restored. */
const GUARDED = `
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    stageId: v.id("orgPipelineStages"),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    await requireOwnedRow(ctx, args.orgId, "orgPipelineStages", args.stageId);
    const { stageId, orgId, ...fields } = args;
    await ctx.db.patch(stageId, fields);
  },
});
`;

/** The hand-written form the three correct siblings used. */
const GUARDED_BY_HAND = `
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    sourceId: v.id("orgLeadSources"),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== args.orgId) {
      throw new ConvexError("Lead source not found.");
    }
    await ctx.db.delete(args.sourceId);
  },
});
`;

describe("tenantWriteGuard analyzer", () => {
  test("flags the shape that shipped as a Critical", () => {
    const found = findUnguardedTenantWrites(VULNERABLE, "orgPipelineStages.ts");
    expect(found).toHaveLength(1);
    expect(found[0].functionName).toBe("update");
    expect(found[0].writes).toEqual(["patch(stageId)"]);
  });

  test("clears the same handler once requireOwnedRow is added", () => {
    expect(findUnguardedTenantWrites(GUARDED, "orgPipelineStages.ts")).toEqual([]);
  });

  test("clears the hand-written get + orgId check the correct siblings used", () => {
    expect(findUnguardedTenantWrites(GUARDED_BY_HAND, "orgLeadSources.ts")).toEqual([]);
  });

  test("follows an id through a loop over an id array", () => {
    const source = `
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
`;
    const found = findUnguardedTenantWrites(source, "orgPipelineStages.ts");
    expect(found).toHaveLength(1);
    expect(found[0].writes).toEqual(["patch(args.orderedIds[i])"]);
  });

  test("ignores writes to ids the handler looked up itself", () => {
    // `row` is not caller-supplied, so there is nothing to tie back to the org.
    const source = `
export const touch = mutation({
  args: {
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);
    const row = await ctx.db
      .query("notes")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (row) await ctx.db.patch(row._id, { seen: true });
  },
});
`;
    expect(findUnguardedTenantWrites(source, "notes.ts")).toEqual([]);
  });

  test("ignores handlers that take no orgId", () => {
    const source = `
export const adminTouch = mutation({
  args: {
    leadId: v.id("leads"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.leadId, { seen: true });
  },
});
`;
    expect(findUnguardedTenantWrites(source, "adminLeads.ts")).toEqual([]);
  });
});

describe("the analyzer's coverage does not shrink silently", () => {
  // A guard that quietly stops looking is worse than no guard: green then means
  // "nothing examined". These numbers make a shape the parser cannot read — args
  // hoisted into a shared validator const, say — fail here instead of passing.
  // If a real change moves them, update them in the same commit, deliberately.
  // Moved from 417/276 by #154, which added `leads.addNote` (guarded with
  // requireOwnedRow) and `memberships.setLeadAutoAssignmentExcluded` (guarded
  // with an explicit `membership.orgId !== args.orgId`). Both were checked by
  // hand before this pin was raised — the point of the pin is that raising it is
  // a decision someone made, not something a test run did on its own.
  //
  // Then 419→420 by #156's `adminBroadcasts.fanOutToAllOrgs`, which lands in
  // `skippedNoOrgId` rather than `analysed`. That is correct, not a hole: it
  // takes a `broadcastId` and no `orgId`, so there is no "the org you named"
  // for a write to escape from. It is an internalMutation reachable only from
  // `create`, which is requireSuperAdmin-gated, and its cross-org writes are
  // the entire point of a platform-wide broadcast.
  //
  // Then 420→421 by `adminSystem.pruneOperationalLogs`, which also lands in
  // `skippedNoOrgId` rather than `analysed`. Correct, not a hole: it takes no
  // args at all, and the two tables it deletes from (cronHeartbeats,
  // webhookLogs) are deployment-global diagnostics with no orgId column — there
  // is no tenant boundary for a write to cross. It is an internalMutation
  // reachable only from the `prune-operational-logs` cron.
  //
  // Then 421→422 by `migrations.backfillVehicleAggregate`, which seeds the
  // vehicle aggregate from existing rows. Also `skippedNoOrgId`, and also
  // correct: it takes a pagination cursor and no orgId, walks every org's
  // vehicles by design, and writes only to the aggregate component — it never
  // patches a caller-supplied row, so there is no tenant boundary to cross.
  //
  // Then 422→426 by the customer/lead/membership backfills and
  // `migrations.rebuildVehicleAggregates`, which extend that same pattern to
  // the four aggregates the dashboard counts now come from. Every one of them
  // is an internalMutation that takes no orgId, walks or clears every org by
  // design, and writes only to aggregate components — none patches a
  // caller-supplied row.
  //
  // `skippedNoArgsBlock` moved 5→9 in the same change, and that shift is worth
  // reading carefully because it looks like coverage loss. The four backfills
  // declare `args: BACKFILL_ARGS` — a shared const rather than an inline object
  // literal — and the analyzer only recognises a literal. So they are skipped
  // for *lack of a parsable args block* instead of for *having no orgId*. Both
  // are skip categories, so no mutation moved out of `analysed`: that count is
  // unchanged at 278, which is the number this pin exists to protect. The one
  // pre-existing function affected is `backfillVehicleAggregate`, which moved
  // between the two skip buckets when it adopted the shared args — hence
  // `skippedNoOrgId` staying at 139 rather than rising.
  test("the analysed surface matches the pinned counts", () => {
    expect(summarizeCoverage(CONVEX_ROOT)).toEqual({
      totalMutations: 426,
      analysed: 278,
      skippedNoArgsBlock: 9,
      skippedNoOrgId: 139,
    });
  });
});

describe("convex backend has no unguarded cross-tenant writes", () => {
  test("every mutation that takes an orgId proves ownership before writing a caller-supplied id", () => {
    const found = auditConvexBackend(CONVEX_ROOT);

    // Intentionally no allowlist. If this fails, the fix is to add the
    // ownership check — `requireOwnedRow(ctx, args.orgId, "<table>", <id>)` —
    // not to widen the analyzer. If a site is genuinely cross-tenant by design,
    // it belongs behind `requireSuperAdmin`, which the analyzer already accepts.
    const report = found
      .map((f) => `  ${f.file} · ${f.kind} ${f.functionName} → ${f.writes.join(", ")}`)
      .join("\n");
    expect(found, `Unguarded cross-tenant writes:\n${report}`).toEqual([]);
  });
});
