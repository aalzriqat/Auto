/**
 * SCRUM-712 S5 — backfill a PENDING disposition for cancelled-sale deposit shares
 * that predate the `depositCancellationPendings` table, plus the audited exit for
 * the shares it cannot classify.
 *
 * Run order (deploy → backfill → verify): deploy the additive table, run this per
 * organization (dryRun first), then re-run dryRun and confirm `created = 0` and
 * `quarantined = 0` (everything already recorded). Every QUARANTINED row must then
 * be reviewed by a human and resolved with `resolveQuarantinedPending`. Nothing is
 * dropped silently: a share that cannot be classified is written QUARANTINED, which
 * blocks the car exactly like PENDING and is never cleared by a payout.
 *
 * ⚠️ One paginated query (applications by org); everything else by index. Do not
 * add a second `.paginate()` — convex-test does not enforce that limit.
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { releaseRootIfNoLiveBasis } from "./commitments";
import { internalMutation } from "./functions";
import { forgetOrgMemo, recordPendingDisposition } from "./utils/depositCancellationPending";
import { syncVehicleHoldStatus } from "./utils/depositHelpers";
import { PERMISSIONS } from "./utils/permissions";
import { requireActorPermission } from "./utils/tenancy";

const BATCH_SIZE = 25;

type Report = {
  dryRun: boolean;
  scanned: number;
  /** Application whose sale is not cancelled: nothing to decide. */
  notApplicable: number;
  alreadyRecorded: number;
  /** Money provably refunded / forfeited: no pending share is owed. */
  decided: number;
  /** Whole-row share whose deposit was applied again later: the money moved on. */
  superseded: number;
  created: number;
  /** Ambiguous: written QUARANTINED for a human. Reported, never dropped. */
  quarantined: number;
};

const EMPTY_REPORT: Report = {
  dryRun: false,
  scanned: 0,
  notApplicable: 0,
  alreadyRecorded: 0,
  decided: 0,
  superseded: 0,
  created: 0,
  quarantined: 0,
};

const reportValidator = v.object({
  dryRun: v.boolean(),
  scanned: v.number(),
  notApplicable: v.number(),
  alreadyRecorded: v.number(),
  decided: v.number(),
  superseded: v.number(),
  created: v.number(),
  quarantined: v.number(),
});

export const backfillDepositCancellationPendings = internalMutation({
  args: {
    orgId: v.id("organizations"),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    report: v.optional(reportValidator),
  },
  handler: async (ctx, args): Promise<Report & { status: "SCHEDULED" | "COMPLETE" }> => {
    const dryRun = args.dryRun ?? false;
    const report: Report = { ...EMPTY_REPORT, ...args.report, dryRun };
    const now = Date.now();

    const page = await ctx.db
      .query("depositApplications")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    for (const application of page.page) {
      report.scanned += 1;
      if (application.status === "APPLIED") {
        report.notApplicable += 1;
        continue;
      }
      const sale = await ctx.db.get(application.saleId);
      if (!sale || sale.orgId !== args.orgId || sale.status !== "CANCELLED") {
        report.notApplicable += 1;
        continue;
      }
      const existing = await ctx.db
        .query("depositCancellationPendings")
        .withIndex("by_org_application", (q) =>
          q.eq("orgId", args.orgId).eq("applicationId", application._id)
        )
        .first();
      if (existing) {
        report.alreadyRecorded += 1;
        continue;
      }

      const deposit = await ctx.db.get(application.depositId);
      const hold = application.holdId ? await ctx.db.get(application.holdId) : null;
      const vehicle = await ctx.db.get(application.vehicleId);

      // A whole-row share is superseded when the same deposit was applied again
      // later: the money moved on to the newer application, which carries its own
      // share. Two undecided shares on one unit of money can never both clear.
      if (!application.holdId) {
        // Exact, not a bounded page: the NEWEST application of the deposit (creation
        // order, so ties resolve deterministically) is the only one that owns the
        // money. Anything older whole-row is superseded (Codex: take(50) missed #51).
        const newest = await ctx.db
          .query("depositApplications")
          .withIndex("by_deposit", (q) => q.eq("depositId", application.depositId))
          .order("desc")
          .first();
        if (newest && newest._id !== application._id) {
          report.superseded += 1;
          continue;
        }
      }

      // Decided ONLY by a proven refund or forfeiture of this share's money. A
      // generic terminal state is not proof: a slice resolved as OTHER / RETURN /
      // REALLOCATE paid nothing out, and a VOIDED row never refunded anyone.
      const decided = application.holdId
        ? hold?.allocationStatus === "RESOLVED" &&
          (hold.resolutionTreatment === "REFUND_TO_CUSTOMER" || hold.resolutionTreatment === "FORFEITED")
        : deposit?.status === "REFUNDED" || deposit?.status === "FORFEITED";
      if (decided) {
        report.decided += 1;
        continue;
      }

      // Anything we cannot attribute is quarantined, not guessed: a missing
      // deposit/slice/car, a terminal state that is not a refund or forfeiture, a
      // row already partly paid out (which share did that pay?), or a car that has
      // since been sold on to someone else.
      const ambiguous =
        !deposit ||
        deposit.orgId !== args.orgId ||
        (application.holdId !== undefined && !hold) ||
        (hold !== null && hold.allocationStatus === "RESOLVED") ||
        (!application.holdId && deposit.status !== "HELD") ||
        !vehicle ||
        (!application.holdId && (deposit.releasedAmountMinor ?? 0) > 0) ||
        vehicle.status === "SOLD" ||
        (vehicle.soldBySaleId !== undefined && vehicle.soldBySaleId !== application.saleId);

      if (ambiguous) report.quarantined += 1;
      else report.created += 1;
      if (dryRun) continue;

      await recordPendingDisposition(ctx, {
        orgId: args.orgId,
        applicationId: application._id,
        actorId: application.reversedBy ?? application.appliedBy,
        now,
        status: ambiguous ? "QUARANTINED" : "PENDING",
      });
      // Lock a car that is still on the lot; a SOLD car keeps its sold status.
      if (vehicle && vehicle.status !== "SOLD") await syncVehicleHoldStatus(ctx, vehicle._id);
    }

    if (page.isDone) {
      // The continuation pages report only to the scheduler, so the final tally is
      // logged — it is the only place the "re-run shows created=0" check can read.
      console.log(`backfillDepositCancellationPendings COMPLETE ${JSON.stringify({ orgId: args.orgId, ...report })}`);
      return { ...report, status: "COMPLETE" };
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrateDepositCancellationPendings.backfillDepositCancellationPendings,
      { orgId: args.orgId, dryRun, cursor: page.continueCursor, report }
    );
    return { ...report, status: "SCHEDULED" };
  },
});

/**
 * The human exit for a QUARANTINED share. Without it "review the quarantined rows"
 * could only be done by editing the database. The reviewer decides what happened
 * to the money outside the system:
 *  - RELEASED / FORFEITED: it was already refunded / written off — the share is
 *    closed and the car is released if nothing else holds it;
 *  - PENDING: it was not decided — the share becomes an ordinary pending one and
 *    leaves through the normal refund/forfeit doors.
 * Needs approval permission and a reason, and records who and why.
 */
export const resolveQuarantinedPending = internalMutation({
  args: {
    orgId: v.id("organizations"),
    pendingId: v.id("depositCancellationPendings"),
    resolution: v.union(v.literal("RELEASED"), v.literal("FORFEITED"), v.literal("PENDING")),
    reason: v.string(),
    actorId: v.id("users"),
  },
  handler: async (ctx, args): Promise<{ status: string }> => {
    await requireActorPermission(
      ctx,
      args.orgId,
      args.actorId,
      PERMISSIONS.APPROVE_REQUESTS,
      "Resolving a quarantined deposit share requires approval permission."
    );
    const reason = args.reason.trim();
    if (reason.length === 0) throw new ConvexError("A reason is required to resolve a quarantined deposit share.");
    const row = await ctx.db.get(args.pendingId);
    if (!row || row.orgId !== args.orgId) throw new ConvexError("Deposit share not found in this organization.");
    if (row.status !== "QUARANTINED") throw new ConvexError("Only a quarantined deposit share can be resolved here.");

    if (args.resolution === "PENDING") {
      // Back to PENDING only if a normal exit still exists for it; otherwise the car
      // would be locked with no door that can ever clear it.
      const deposit = await ctx.db.get(row.depositId);
      const hold = row.holdId ? await ctx.db.get(row.holdId) : null;
      const exitReachable = row.holdId
        ? hold?.allocationStatus === "RELEASED_AWAITING_DECISION"
        : deposit?.status === "HELD";
      if (!exitReachable) {
        throw new ConvexError(
          "No refund or forfeiture door is open for this share, so it cannot be returned to pending. Resolve it as released or forfeited instead."
        );
      }
    } else {
      // A terminal resolution frees the car, so the share's own journal reversal must
      // be PROVED posted — the same gate a payout has. A REVERSING application is an
      // unposted reversal and keeps blocking.
      const application = await ctx.db.get(row.applicationId);
      if (!application || application.orgId !== args.orgId || application.status !== "REVERSED") {
        throw new ConvexError(
          "This share's sale reversal has not posted yet, so it cannot be closed. Wait for the reversal to post."
        );
      }
    }

    await ctx.db.patch(row._id, {
      status: args.resolution,
      resolvedAt: Date.now(),
      resolvedBy: args.actorId,
      resolutionReference: `quarantine review: ${reason}`,
    });
    forgetOrgMemo(ctx, args.orgId);
    const vehicle = await ctx.db.get(row.vehicleId);
    if (vehicle && vehicle.orgId === args.orgId && vehicle.status !== "SOLD") {
      // A terminal resolution is a decision door like refund/forfeit: the commitment
      // root held open by this share's QUARANTINED row must be re-evaluated, or the
      // car is advertised AVAILABLE while the stale root refuses every other buyer.
      if (args.resolution !== "PENDING") {
        await releaseRootIfNoLiveBasis(ctx, {
          orgId: args.orgId,
          vehicleId: row.vehicleId,
          reason: "quarantined deposit share resolved",
          decisionNow: Date.now(),
        });
      }
      await syncVehicleHoldStatus(ctx, vehicle._id);
    }
    return { status: args.resolution };
  },
});
