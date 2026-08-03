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
  //
  // Then 426→428 by `migrations.rebuildCustomerAggregate` and
  // `facebookEngagement.saveCustomerDisplayName`, both `skippedNoOrgId`.
  // The rebuild takes only a batch size and clears every org's tree by design.
  // `saveCustomerDisplayName` does take a caller-supplied `customerId` with no
  // orgId beside it, which is the shape this analyzer exists to catch — but it
  // is an internalMutation whose only caller is the enrichment action, handing
  // back a customerId the webhook handler just resolved for that org, and it
  // is the exact mirror of `instagramEngagement.saveCustomerDisplayName` that
  // this pin already covers. `analysed` is unchanged at 278.
  //
  // Then 428→429 by `notifications.continueMarkAllAsRead`, and this one moves
  // `analysed` 278→279 rather than a skip bucket — the first addition in a
  // while that the analyzer actually inspects. It takes an `orgId` and a
  // `userId`, so it has the shape the guard cares about, and it clears: the
  // rows it patches come from its own `by_org_user_read` index lookup scoped to
  // that org, never from a caller-supplied document id. Coverage going up is
  // the good direction; if a later edit made it write a caller-supplied id, the
  // guard would fail rather than this pin.
  //
  // Then 429→430 by `orgFinancialReset.resetOrgFinancialData`, also raising
  // `analysed` 279→280. It takes an `orgId` and deletes rows, which is exactly
  // the shape this analyzer exists for — and it clears, because every row it
  // deletes comes from its own `q.eq("orgId", args.orgId)` filter rather than a
  // caller-supplied document id. Of everything pinned here this is the one
  // where that guarantee matters most, so it is also covered directly by a
  // cross-tenant test in `orgFinancialReset.test.ts`.
  //
  // Then 430→431 by `accountingCutover.postOpeningBalanceDirect`, raising
  // `analysed` 280→281. It takes an `orgId` and writes, so the analyzer
  // inspects it, and it clears: the only caller-supplied ids it touches are
  // `accountId`s, each re-fetched and checked against the org inside the
  // shared poster before anything is written.
  // Then 431→432 by `migrateRoles.backfillVehicleValuationPermissions`, raising
  // `skippedNoOrgId` 141→142 while leaving `analysed` at 281. It is an
  // `internalMutation` with an empty args block, so it takes no `orgId` for the
  // analyzer to check — it is a one-time backfill that sweeps every org's roles
  // deliberately, and being internal it is unreachable from a client.
  //
  // Then 432→433 by `migrations.reconcileVehicleHolds`, raising `analysed`
  // 281→282. It takes an `orgId` and patches vehicles, so the analyzer
  // inspects it, and it clears: every vehicle it touches comes from its own
  // `by_org` index read, never from a caller-supplied id.
  //
  // Then 433→435 by `websites.addLeadBlocklistEntry` and
  // `websites.removeLeadBlocklistEntry` — the write path the public-lead
  // blocklist never had. Both land in `analysed` (282→284), and both skip
  // buckets are unchanged at 9 and 142, so this is coverage going up rather
  // than anything moving out of inspection.
  //
  // `addLeadBlocklistEntry` takes an `orgId` and writes, so the analyzer looks
  // at it, and it clears: the only row it patches is one its own
  // `by_org_kind_valueHash` lookup returned — that index pins `orgId` as an
  // equality term, so the row cannot be another tenant's. It takes no
  // caller-supplied document id at all.
  //
  // `removeLeadBlocklistEntry` is the one that matters here. It takes an
  // `orgId` *and* a caller-supplied `entryId` and deletes by it, which is
  // exactly the shape the two shipped Criticals had, so it goes through
  // `requireOwnedRow(ctx, args.orgId, "websiteLeadBlocklist", args.entryId)`
  // before the delete. `websites.test.ts` covers that directly with a member of
  // org A naming org A honestly and passing org B's entry id — the case
  // `requireTenantAuth` alone waves through.
  //
  // Then 435→436 by `tasks.softDelete`, the delete path the tasks table's
  // soft-delete columns were declared for but never given. It lands in
  // `analysed` (284→285) and both skip buckets are unchanged at 9 and 142, so
  // this is coverage going up rather than anything dropping out of inspection.
  //
  // It is squarely the shape this analyzer exists for: it takes an `orgId` and
  // a caller-supplied `taskId` and patches by that id, exactly how the two
  // shipped Criticals were written. So it goes through
  // `requireOwnedRow(ctx, args.orgId, "tasks", args.taskId)` before the patch.
  // That guard is not decorative here — it was verified by writing the handler
  // with only `requireTenantAuth` plus an `isDeleted` check first and watching
  // `tasks.test.ts`'s cross-tenant case fail with the delete *succeeding*
  // (org B's member removed org A's task). Adding the line is what turns it
  // green, so the test discriminates between the real fix and the plausible
  // near-miss rather than merely passing.
  // Then 436→437 by `socialInboxBackfill.collapseDuplicatedName`, which drops
  // the repeated surname from contacts the old name splitter wrote into both
  // name fields. It lands in `skippedNoOrgId` (142→143) rather than `analysed`,
  // because it takes no `orgId` — so it is worth saying why that is not a hole.
  // It is an `internalMutation`, unreachable from any client, and its only
  // caller is `resyncContactNames`, which authenticates the manager against the
  // org first and then passes ids that came from `getUnresolvedSocialCustomers`
  // for that same org. The id is therefore never caller-supplied in the sense
  // this analyzer guards against; adding an `orgId` argument would let a caller
  // name a pairing rather than prevent one. `analysed` is unchanged at 285, so
  // nothing dropped out of inspection.
  test("the analysed surface matches the pinned counts", () => {
    expect(summarizeCoverage(CONVEX_ROOT)).toEqual({
      totalMutations: 437,
      analysed: 285,
      skippedNoArgsBlock: 9,
      skippedNoOrgId: 143,
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
