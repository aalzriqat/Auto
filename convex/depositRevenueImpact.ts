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

    const currencyScale = (c: string) =>
      ["JOD", "KWD", "BHD", "OMR"].includes(c) ? 1000 : 100;
    const fromMinor = (minor: number, scale: number) => minor / scale;
    const round2 = (n: number) => Math.round(n * 1000) / 1000;

    const monthOf = (ts: number) => {
      const d = new Date(ts);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };

    const perOrg = [];
    let totalCrossPeriodMinor = 0;
    let totalSamePeriodMinor = 0;
    let totalUnresolved = 0;
    let totalUnresolvedAmount = 0;
    let totalRefunded = 0;
    let totalForfeited = 0;
    let totalReversed = 0;
    let totalPartial = 0;
    let totalOrphan = 0;
    let totalOrphanAmount = 0;
    let totalHeld = 0;
    let totalApplied = 0;
    let totalLegacyRows = 0;
    let totalLegacyAmount = 0;
    let anyTruncated = false;
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
      let unresolvedMinor = 0;
      let refunded = 0;
      let forfeited = 0;
      let reversedApplications = 0;
      let partialOrMultiSale = 0;
      let orphanReceipts = 0;
      let orphanAmount = 0;
      let held = 0;
      let applied = 0;
      const periods = new Set<string>();
      const rows = [];

      for (const tx of legacyDepositRows) {
        const depositId = tx.depositId;
        const deposit = depositId ? await ctx.db.get(depositId) : null;
        const depositMonth = monthOf(tx.date);
        const scale = currencyScale(deposit?.currency ?? "JOD");

        // Attributed by SLICE, never by receipt.
        //
        // One عربون can be split across several cars, and an earlier version of
        // this counted the whole receipt once per sale — a 500 deposit split
        // 300/150 with 50 unresolved reported 1,000 of impact instead of 450,
        // and the number a migration decision rests on was inflated by every
        // extra line on the quote. `depositApplications.amountMinor` is the
        // authoritative share; REVERSED applications are cancelled sales and
        // their money went back to the deposit, so they are not attributed.
        const applications = depositId
          ? await ctx.db
              .query("depositApplications")
              .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
              .collect()
          : [];
        const live = applications.filter((a) => a.status !== "REVERSED");
        const reversedCount = applications.length - live.length;

        let appliedTotal = 0;
        for (const app of live) {
          const sale = await ctx.db.get(app.saleId);
          if (!sale || sale.orgId !== org._id) continue;
          const slice = fromMinor(app.amountMinor, scale);
          appliedTotal += slice;
          const saleMonth = monthOf(sale.saleDate);
          const crossPeriod = saleMonth !== depositMonth;
          if (crossPeriod) {
            crossPeriodMinor += slice;
            periods.add(depositMonth);
            periods.add(saleMonth);
          } else {
            samePeriodMinor += slice;
          }
          rows.push({
            depositId,
            depositMonth,
            receiptAmount: tx.amount,
            /** THIS car's share, not the whole receipt. */
            amount: slice,
            saleMonth,
            state: deposit?.status ?? "UNKNOWN",
            crossPeriod,
            note: crossPeriod
              ? "Revenue reported in the deposit's month, missing from the sale's month."
              : "Nets out inside one period; total and period both already correct.",
          });
        }

        if (reversedCount > 0) reversedApplications += reversedCount;
        if (live.length > 1) partialOrMultiSale += 1;

        // What is left of the receipt after every live slice — and only the
        // part still genuinely HELD counts as unresolved. A refund or a
        // forfeiture is a decision that was made; the money is not waiting on
        // anything, so counting it as unresolved would overstate the work a
        // migration has left to do.
        const remainder = Math.max(0, round2(tx.amount - appliedTotal));
        const state = deposit?.status ?? "UNKNOWN";

        // No deposits row behind it at all. Production has nine of these,
        // sharing a single import timestamp, with no status and no resolution
        // history — real deposits, applied, refunded and opening balances are
        // indistinguishable from one another at this point. They are reported
        // as their own class rather than folded into `unresolved`, because a
        // migration can act on an unresolved deposit and cannot act on one of
        // these without first being told what it is.
        if (!deposit) {
          orphanReceipts += 1;
          orphanAmount += tx.amount;
          rows.push({
            depositId: null,
            depositMonth,
            receiptAmount: tx.amount,
            amount: tx.amount,
            saleMonth: null,
            state: "REQUIRES_RECONCILIATION",
            crossPeriod: false,
            note: "UNATTRIBUTABLE_LEGACY_RECEIPT — no deposits row; not inferred, not corrected.",
          });
          continue;
        }

        if (state === "APPLIED" && live.length > 0) applied += 1;
        if (state === "HELD") held += 1;
        if (state === "REFUNDED") {
          refunded += 1;
        } else if (state === "FORFEITED") {
          forfeited += 1;
        } else if (remainder > 0 && state !== "VOIDED") {
          unresolvedMinor += remainder;
          unresolved += 1;
          periods.add(depositMonth);
          rows.push({
            depositId,
            depositMonth,
            receiptAmount: tx.amount,
            amount: remainder,
            saleMonth: null,
            state,
            crossPeriod: false,
            note: "Still held, still counted as revenue, with no sale behind it.",
          });
        }
      }

      totalCrossPeriodMinor += crossPeriodMinor;
      totalSamePeriodMinor += samePeriodMinor;
      totalUnresolved += unresolved;
      totalUnresolvedAmount += unresolvedMinor;
      totalRefunded += refunded;
      totalForfeited += forfeited;
      totalReversed += reversedApplications;
      totalPartial += partialOrMultiSale;
      totalOrphan += orphanReceipts;
      totalOrphanAmount += orphanAmount;
      totalHeld += held;
      totalApplied += applied;
      totalLegacyRows += legacyDepositRows.length;
      totalLegacyAmount += legacyDepositRows.reduce((sum, r) => sum + r.amount, 0);
      if (receipts.length === (args.limit ?? 2000)) anyTruncated = true;
      for (const p of periods) allPeriods.add(`${org._id}:${p}`);

      if (legacyDepositRows.length > 0) {
        perOrg.push({
          orgId: org._id,
          orgName: org.name,
          legacyDepositRows: legacyDepositRows.length,
          crossPeriodAmount: crossPeriodMinor,
          samePeriodAmount: samePeriodMinor,
          unresolvedLegacyDeposits: unresolved,
          unresolvedAmount: round2(unresolvedMinor),
          refundedLegacyDeposits: refunded,
          forfeitedLegacyDeposits: forfeited,
          reversedApplications,
          partialOrMultiSaleDeposits: partialOrMultiSale,
          attributableLegacyDeposits: legacyDepositRows.length - orphanReceipts,
          orphanReceipts,
          orphanAmount: round2(orphanAmount),
          heldLegacyDeposits: held,
          appliedLegacyDeposits: applied,
          legacyDepositAmount: round2(
            legacyDepositRows.reduce((sum, r) => sum + r.amount, 0)
          ),
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
      crossPeriodAmount: round2(totalCrossPeriodMinor),
      /** Reported so it is not mistaken for damage — these already net out. */
      samePeriodAmount: round2(totalSamePeriodMinor),
      /** Pre-change deposits still held; each is a future crossover. */
      unresolvedLegacyDeposits: totalUnresolved,
      unresolvedAmount: round2(totalUnresolvedAmount),
      legacyDepositRows: totalLegacyRows,
      legacyDepositAmount: round2(totalLegacyAmount),
      refundedLegacyDeposits: totalRefunded,
      forfeitedLegacyDeposits: totalForfeited,
      /** Applications belonging to a cancelled/reversed sale. */
      reversedApplications: totalReversed,
      /** Deposits split across more than one sale — the inflation case. */
      partialOrMultiSaleDeposits: totalPartial,
      /** Real deposits row behind the receipt — the correctable population. */
      attributableLegacyDeposits: totalLegacyRows - totalOrphan,
      /** No deposits row. Reported, never inferred, never corrected here. */
      orphanReceipts: totalOrphan,
      orphanAmount: round2(totalOrphanAmount),
      heldLegacyDeposits: totalHeld,
      appliedLegacyDeposits: totalApplied,
      periodsAffected: allPeriods.size,
      truncated: anyTruncated,
      perOrg,
    };
  },
});
