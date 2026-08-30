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
  // Then 436→437 by `socialInboxBackfill.collapseArtificialSurname`, which
  // drops a surname the contact never had — the first name repeated, or the
  // placeholder's "Contact" left beside a real name by the old splitter. It lands in `skippedNoOrgId` (142→143) rather than `analysed`,
  // because it takes no `orgId` — so it is worth saying why that is not a hole.
  // It is an `internalMutation`, unreachable from any client, and its only
  // caller is `resyncContactNames`, which authenticates the manager against the
  // org first and then passes ids that came from `getUnresolvedSocialCustomers`
  // for that same org. The id is therefore never caller-supplied in the sense
  // this analyzer guards against; adding an `orgId` argument would let a caller
  // name a pairing rather than prevent one. `analysed` is unchanged at 285, so
  // nothing dropped out of inspection.
  // Then 437→439 / 285→287 by two mutations landing in the same release, each
  // adding one to both counts:
  //
  // `vehicles.markSourcedVehicleArrived` (#199) records that a special-order
  // car reached the dealership. It takes an `orgId` and a caller-supplied
  // `vehicleId`, so it lands in `analysed` and is held to the
  // `requireOwnedRow` rule — which it satisfies: the handler resolves the
  // vehicle through `requireOwnedRow(ctx, args.orgId, "vehicles",
  // args.vehicleId)` before touching it, so naming another org's vehicle id
  // cannot reach the patch.
  //
  // `migrations.cleanupDanglingAcceptedStatuses` (#200) strips finance-company
  // references to deleted customer statuses. It takes an `orgId` so it lands in
  // `analysed`, and it needs no `requireOwnedRow`: every row it touches is
  // reached by walking `financeCompanies.by_org` from that same `orgId`, so no
  // document id is caller-supplied and there is nothing for a caller to point
  // elsewhere.
  // Then 439→443 by the four mutations that model the dealer side of a
  // financed sale:
  //
  // `financingEconomics.recordSubmittedQuotation`, `.recordAppraisal` and
  // `.approveDealerPurchaseAmount` each take an `orgId` and a caller-supplied
  // `applicationId`, so all three land in `analysed` (287→290) and are held to
  // the `requireOwnedRow` rule. Each satisfies it inline — the ownership check
  // is written out in the handler rather than behind a shared loader, since
  // this analyzer only accepts proof it can see and "the check is somewhere
  // else" is the shape that shipped two Criticals.
  //
  // `migrateFinancingEconomics.backfillFinancingEconomics` takes no `orgId` at
  // all — it paginates `financeCompanies` and then `financeApplications`
  // directly — so it lands in `skippedNoOrgId` (143→144) with no
  // caller-supplied id to point anywhere.
  //
  // Then 443→444 / 290→291 by `financingEconomics.reopenApproval`, which
  // withdraws an approved purchase amount so a deal can be re-quoted. It takes
  // an `orgId` and a caller-supplied `applicationId`, so it is held to the
  // `requireOwnedRow` rule and satisfies it inline like its three siblings.
  // Then 444→445 / 291→292 by `financingEconomics.resolveFinancingReconciliation`,
  // which clears the flag marking a deal's financing figures as needing review.
  // It takes an `orgId` and a caller-supplied `applicationId`, so it is held to
  // the `requireOwnedRow` rule and satisfies it inline like its siblings.
  // Then 445→446 / skippedNoOrgId 144→145 by one mutation from main, with
  // `analysed` deliberately unchanged:
  //
  // `migrateCommissionAccruals.backfillCommissionAccruals` accrues the
  // commission backlog left by the move to earned-time recognition. It is an
  // internalMutation that walks every organization by pagination and takes no
  // `orgId` at all — there is no caller and no caller-supplied id — so it is
  // correctly outside the analysed surface rather than exempted from it.
  //
  // Both sides of that merge moved skippedNoOrgId 143→144 independently — the
  // base branch via backfillFinancingEconomics, main via
  // backfillCommissionAccruals — so the merged figure is 145, not the 144
  // either side carried alone. Taking either verbatim would have silently
  // un-pinned one migration from the guard.
  //
  // Then 446→455 / 292→301 by the nine mutations in `financeDealCosts`, which
  // records what a financed deal actually cost and who is holding the money:
  // `recordDealFee`, `recordActualFeeAmount`, `reconcileDealFee`,
  // `voidDealFee`, `openDealCustody`, `recordCustodyMovement`,
  // `reconcileDealCustody`, `recordLegalInvoice` and `classifyDealAccounting`.
  //
  // Every one takes an `orgId` alongside a caller-supplied id — an
  // `applicationId`, a `feeId` or a `custodyId` — so all of them land in
  // `analysed` and are held to the `requireOwnedRow` rule, satisfied inline.
  //
  // Three take a second caller-supplied id. Two of those (`recordDealFee` and
  // `recordActualFeeAmount`, via `custodyId`) are second ROW ids and get their
  // own `requireOwnedRow`, plus an explicit check that the row belongs to this
  // DEAL — a custody record in the right organization can still belong to a
  // different application. `openDealCustody`'s second id is a `userId`, which
  // is proved by a `memberships` lookup instead, closing the same hole by a
  // different route. `recordCustodyMovement`'s reversal path adds a fourth
  // second-row-id check on `financeDealCustodyEntries`.
  //
  // Then 455→456 / 301→302 by `financeDealCosts.reopenDealCustody`, which
  // undoes a reconciliation so a closed custody record can be corrected. Same
  // shape as its siblings.
  //
  // `analysed` moving up by exactly the number of new mutations is the signal
  // to check for — going up by less would mean one slipped into a skipped
  // bucket, which is the direction that hides an unguarded write.
  //
  // Then 456→458 / 302→304 by two mutations in `sourcingPayables` that record
  // what a supplier has actually been paid on a consigned vehicle:
  // `recordPartialPayment` and `setDisputed`. Both take an `orgId` and a
  // caller-supplied `payableId`, so both land in `analysed` and are held to the
  // ownership rule. Both satisfy it the same way their sibling `markPaid`
  // always has — loading the row and refusing it when `payable.orgId` is not
  // the named org — which is what `requireOwnedRow` does, written out where the
  // analyzer can see it.
  // Then 458→459 / 304→305 by `migrateConsignedSaleBasis`, which restates
  // historical consigned sales from principal to agent basis. It takes an
  // optional `orgId` so a dealership can be migrated on its own, which is what
  // puts it in `analysed`. It writes no caller-supplied document id — the only
  // other argument is an opaque pagination cursor — and every row it touches is
  // reached by walking from that org, so the ownership rule is satisfied by
  // construction rather than by a check.
  //
  // RECOMPUTE these, never resolve a conflict by taking one side. Two branches
  // have already each moved the same counter independently, and picking either
  // number silently under-reports the merged surface.
  // Then 440→445 / 287→288 / skippedNoArgsBlock 9→13 by the five Social Inbox
  // aggregate migrations, which seed and repair the trees behind
  // `socialInbox.platformStats`:
  //
  // `backfillInstagramEventAggregate`, `backfillFacebookEventAggregate`,
  // `backfillInstagramSocialContacts` and `backfillFacebookSocialContacts` take
  // the shared `BACKFILL_ARGS` constant rather than a literal `args: {` block,
  // so they land in `skippedNoArgsBlock` (9→13). Each walks one table by
  // pagination and takes no `orgId` and no document id — there is nothing for a
  // caller to point elsewhere.
  //
  // `migrations.repairSocialContacts` rebuilds `socialContacts` from the event
  // tables. It has a literal args block carrying an optional `orgId`, so it is
  // the one of the five that lands in `analysed` (287→288). It needs no
  // `requireOwnedRow`: it is an internalMutation with no caller-supplied
  // document id, and every row it touches is reached by walking either the
  // whole table or that same `orgId`'s `by_org` index.
  // RECOMPUTE these, never resolve a conflict by taking one side. Both sides of
  // this merge moved the same counters independently — this branch by
  // `migrateConsignedSaleBasis`, main by the five Social Inbox aggregate
  // migrations — so the merged figures are the sum of both movements, not the
  // number either side carried alone. Taking either verbatim would silently
  // un-pin the other side's mutations from the guard.
  // Then 464→466 / 306→308 by the two mutations in `supplierReceivables`, which
  // collect the dealership's agency margin from a supplier the buyer paid
  // directly: `recordReceipt` and `setDisputed`. Both take an `orgId` and a
  // caller-supplied `receivableId`, so both land in `analysed` and are held to
  // the ownership rule.
  //
  // Both satisfy it with the load-and-compare written out inline. It began life
  // behind a `loadOwnedReceivable` helper, which read better and this analyzer
  // could not see through — it flagged `recordReceipt` immediately, which is
  // the guard doing precisely its job.
  // Then 470→472 / 312→314 by the two mutations in `applications` that carry a
  // financed consigned deal's settlement: `setSupplierSettlementRoute`, which
  // records whether the finance company pays the dealership or the supplier,
  // and `confirmSupplierDisbursement`, which records that it paid the supplier.
  // Both take an `orgId` and a caller-supplied `applicationId`, so both land in
  // `analysed` and are held to the ownership rule.
  //
  // Both satisfy it with the load-and-compare written out inline, matching every
  // other handler in that module. `settlesDirectToSupplier` reads the vehicle
  // behind the application, but only after the application itself has been
  // proved to belong to the named org — so the vehicle is reached through an
  // owned row rather than from a caller-supplied id.
  // SCRUM-30 adds a third: `amendSupplierDisbursementAdvice`, which corrects a
  // mistyped settlement advice. Same shape as the two above — `orgId` plus a
  // caller-supplied `applicationId` — so it lands in `analysed` too, and it
  // satisfies the rule the same inline way.
  // Then 473→475 / skippedNoArgsBlock 13→15, `analysed` unchanged at 315, by
  // the two Social Inbox conversation backfills:
  //
  // `backfillInstagramConversations` and `backfillFacebookConversations`
  // materialise `socialConversations` for events that predate the trigger. Both
  // take the shared `CONVERSATION_BACKFILL_ARGS` constant rather than a literal
  // args block, so they land in `skippedNoArgsBlock` — that, and only that, is
  // why they are not analysed.
  //
  // They DO take an `orgId`, and every row they touch is reached through that
  // org's `by_org` index, so the writes are org-derived rather than
  // caller-directed. There is no caller-supplied document id to own-check.
  // Then 475→476 / skippedNoOrgId 145→146, `analysed` unchanged at 315, by
  // `startSocialConversationBackfills`:
  //
  // It is the operator fan-out that starts the two backfills above for every
  // organization, so it deliberately takes no `orgId` — it *enumerates* orgs by
  // paginating the `organizations` table and passes each id to the per-org
  // backfills. There is no caller-supplied org or document id for the guard to
  // own-check, and it is an `internalMutation` with no public entry point.
  //
  // Then 476→477 / skippedNoOrgId 146→147, `analysed` unchanged at 315, by
  // `subscriptions.reconcileExpiredSubscriptions` (SCRUM-145):
  //
  // It is a cross-org sweep that moves subscriptions past their paid period to
  // `expired`, so it deliberately takes no `orgId` — it selects rows by the
  // `by_status_plan_period_end` index rather than from caller input, and
  // patches only rows that range returned. There is no caller-supplied org or document
  // id for the guard to own-check, and it is an `internalMutation` reachable
  // only from the cron, with no public entry point.
  //
  // `accountingOutbox.beginAuthorityWork` and
  // `accountingOutbox.performAuthoritySettlement` (SCRUM-208 c15814):
  //
  // Both take ONLY a `workId`. That is deliberate and is stronger than taking
  // an `orgId`: the tenant is read from the stored `commitmentAuthorityWork`
  // row and every subsequent read is scoped by it, so there is no
  // caller-supplied organization for a caller to get wrong or to forge. They
  // are `internalMutation`s reachable only from the scheduler — the accounting
  // drain that recorded the work, or the sweep that re-offers it — with no
  // public entry point. `sweepAuthorityWork` DOES take an `orgId` and is
  // analysed normally.
  //
  // ⚠️ `analysed` rises to 316 and must never drop silently — a new mutation
  // landing in a skip bucket is only acceptable when the reason is one of the
  // three above, stated per mutation.
  test("the analysed surface matches the pinned counts", () => {
    expect(summarizeCoverage(CONVEX_ROOT)).toEqual({
      totalMutations: 480,
      analysed: 316,
      skippedNoArgsBlock: 15,
      skippedNoOrgId: 149,
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
