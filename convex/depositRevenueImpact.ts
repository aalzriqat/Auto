import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

/**
 * What correcting the back-book would move, measured and never touched.
 *
 * A عربون used to be recognized as revenue the day it arrived: `getProfitAndLoss`
 * counted DEPOSIT rows as revenue, and the eventual sale was written net of what
 * had already been collected to keep the total honest. That only reconciles when
 * the deposit and its sale land in ONE period. Across a month boundary the
 * earlier period reports revenue for a car nobody had sold, and the later one is
 * short by the same amount.
 *
 * New rows no longer behave that way. Existing ones were deliberately left
 * alone: rewriting the back-book is a separate, reviewed migration, and this
 * report is what that decision should be made on. It is an `internalQuery` and
 * writes nothing.
 *
 * The numbers to read:
 *
 * - `crossPeriodMinor` is the part that actually misstates a period — a deposit
 *   whose sale completed in a DIFFERENT calendar month. Same-month deposits net
 *   out inside the period and are reported separately so they are not mistaken
 *   for damage.
 * - `unresolvedLegacyDeposits` are pre-change deposits still held. Each one is a
 *   future crossover if its sale lands in a later month, and each is deducted
 *   once at completion (see `alreadyRecognizedFor` in utils/saleCompletion) so
 *   the transition cannot double count.
 * - `periodsAffected` is what a reviewer actually cares about: how many distinct
 *   accounting months would change if the back-book were corrected.
 */
export const depositRevenueImpact = internalQuery({
  args: {
    /** Omit to sweep every organization. */
    orgId: v.optional(v.id("organizations")),
    /** Cap on deposit receipts examined per org, newest first. */
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const orgs = args.orgId
      ? [await ctx.db.get(args.orgId)].filter((o): o is Doc<"organizations"> => o !== null)
      : await ctx.db.query("organizations").collect();

    const monthOf = (ts: number) => {
      const d = new Date(ts);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };

    const perOrg = [];
    let totalCrossPeriodMinor = 0;
    let totalSamePeriodMinor = 0;
    let totalUnresolved = 0;
    const allPeriods = new Set<string>();

    for (const org of orgs) {
      const receipts = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .order("desc")
        .take(args.limit ?? 2000);

      // Only deposit CASH IN, and only rows written before the change. A
      // flagged row was never counted as revenue, so it has nothing to correct.
      const legacyDepositRows = receipts.filter(
        (tx) =>
          tx.category === "DEPOSIT" &&
          tx.type === "IN" &&
          tx.isDeleted !== true &&
          tx.excludedFromRevenue !== true
      );

      let crossPeriodMinor = 0;
      let samePeriodMinor = 0;
      let unresolved = 0;
      const periods = new Set<string>();
      const rows = [];

      for (const tx of legacyDepositRows) {
        const depositId = tx.depositId;
        const deposit = depositId ? await ctx.db.get(depositId) : null;
        const depositMonth = monthOf(tx.date);

        // The sale that consumed it, if any. A deposit with no completed sale
        // is still sitting in revenue with nothing to offset it at all.
        const applications = depositId
          ? await ctx.db
              .query("depositApplications")
              .withIndex("by_org_deposit", (q) => q.eq("orgId", org._id).eq("depositId", depositId))
              .collect()
          : [];
        const saleIds = Array.from(
          new Set(applications.map((a) => a.saleId).filter((s): s is NonNullable<typeof s> => !!s))
        );

        if (saleIds.length === 0) {
          unresolved += 1;
          periods.add(depositMonth);
          rows.push({
            depositId,
            depositMonth,
            amount: tx.amount,
            saleMonth: null,
            state: deposit?.status ?? "UNKNOWN",
            crossPeriod: false,
            note: "Counted as revenue with no completed sale behind it yet.",
          });
          continue;
        }

        for (const saleId of saleIds) {
          const sale = await ctx.db.get(saleId);
          if (!sale || sale.orgId !== org._id) continue;
          const saleMonth = monthOf(sale.saleDate);
          const crossPeriod = saleMonth !== depositMonth;
          if (crossPeriod) {
            crossPeriodMinor += tx.amount;
            periods.add(depositMonth);
            periods.add(saleMonth);
          } else {
            samePeriodMinor += tx.amount;
          }
          rows.push({
            depositId,
            depositMonth,
            amount: tx.amount,
            saleMonth,
            state: deposit?.status ?? "UNKNOWN",
            crossPeriod,
            note: crossPeriod
              ? "Revenue reported in the deposit's month, missing from the sale's month."
              : "Nets out inside one period; total and period both already correct.",
          });
        }
      }

      totalCrossPeriodMinor += crossPeriodMinor;
      totalSamePeriodMinor += samePeriodMinor;
      totalUnresolved += unresolved;
      for (const p of periods) allPeriods.add(`${org._id}:${p}`);

      if (legacyDepositRows.length > 0) {
        perOrg.push({
          orgId: org._id,
          orgName: org.name,
          legacyDepositRows: legacyDepositRows.length,
          crossPeriodAmount: crossPeriodMinor,
          samePeriodAmount: samePeriodMinor,
          unresolvedLegacyDeposits: unresolved,
          periodsAffected: periods.size,
          rows,
          truncated: receipts.length === (args.limit ?? 2000),
        });
      }
    }

    return {
      orgsScanned: orgs.length,
      orgsAffected: perOrg.length,
      /** The only figure that represents a genuinely misstated period. */
      crossPeriodAmount: totalCrossPeriodMinor,
      /** Reported so it is not mistaken for damage — these already net out. */
      samePeriodAmount: totalSamePeriodMinor,
      /** Pre-change deposits still held; each is a future crossover. */
      unresolvedLegacyDeposits: totalUnresolved,
      periodsAffected: allPeriods.size,
      perOrg,
    };
  },
});
