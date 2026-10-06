/**
 * SCRUM-712 S5 — backfill a PENDING disposition for cancelled-sale deposit shares
 * that predate the `depositCancellationPendings` table.
 *
 * Run order (deploy → backfill → verify): deploy the additive table, run this per
 * organization (dryRun first), then re-run dryRun and confirm `created = 0` and
 * `quarantined = 0` (everything already recorded) and that every QUARANTINED row
 * has been reviewed by a human. Nothing is dropped silently: a share that cannot
 * be classified is written QUARANTINED, which blocks the car exactly like PENDING
 * and is never cleared by a payout.
 *
 * ⚠️ One paginated query (applications by org); everything else by index. Do not
 * add a second `.paginate()` — convex-test does not enforce that limit.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./functions";
import { recordPendingDisposition } from "./utils/depositCancellationPending";
import { syncVehicleHoldStatus } from "./utils/depositHelpers";

const BATCH_SIZE = 25;

type Report = {
  dryRun: boolean;
  scanned: number;
  /** Application whose sale is not cancelled: nothing to decide. */
  notApplicable: number;
  alreadyRecorded: number;
  /** Money already refunded / forfeited / voided: no pending share is owed. */
  decided: number;
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
  created: 0,
  quarantined: 0,
};

const reportValidator = v.object({
  dryRun: v.boolean(),
  scanned: v.number(),
  notApplicable: v.number(),
  alreadyRecorded: v.number(),
  decided: v.number(),
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

      // Decided: the share's money already left (slice resolved / row no longer HELD).
      const decided = application.holdId
        ? hold?.allocationStatus === "RESOLVED"
        : !!deposit && deposit.status !== "HELD";
      if (decided) {
        report.decided += 1;
        continue;
      }

      // Anything we cannot attribute is quarantined, not guessed: a missing
      // deposit/slice/car, a row already partly paid out (which share did that
      // pay?), or a car that has since been sold on to someone else.
      const ambiguous =
        !deposit ||
        deposit.orgId !== args.orgId ||
        (application.holdId !== undefined && !hold) ||
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

    if (page.isDone) return { ...report, status: "COMPLETE" };
    await ctx.scheduler.runAfter(
      0,
      internal.migrateDepositCancellationPendings.backfillDepositCancellationPendings,
      { orgId: args.orgId, dryRun, cursor: page.continueCursor, report }
    );
    return { ...report, status: "SCHEDULED" };
  },
});
