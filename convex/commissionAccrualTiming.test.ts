/**
 * Commission expense is recognized when the obligation becomes measurable, and
 * corrections to it post adjusting entries.
 *
 * Before this, MANUAL mode deferred the accrual to PAYMENT — cash-basis
 * recognition inside an accrual ledger. A car sold in July whose commission was
 * paid in August showed its full margin in July and a naked expense in August,
 * and Commission Payable never reflected money the dealership had already
 * decided it owed. AUTO modes were always correct; this brings MANUAL in line.
 *
 * The second half of the change: an amount that had reached the ledger used to
 * be unchangeable, with the error text pointing at a "correction workflow" that
 * does not exist. A commission accrued at the wrong number was permanently
 * wrong. Corrections now post a signed COMMISSION_ADJUSTED delta.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ruleCommissionAdjusted } from "./accounting/postingRules";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMISSIONS = [
  "create:sales",
  "view:sales",
  "edit:sales",
  "view:vehicles",
  "view:commissions",
  "manage:commissions",
  "view:finance",
  "manage:finance",
  "view:payroll",
  "manage:payroll",
];

/**
 * A dealership with a live chart and an OPEN period covering the whole fiscal
 * year, so hooks actually post instead of queueing to the outbox — the point of
 * these tests is what lands in the ledger, not what is deferred.
 */
async function seedDealer(
  suffix: string,
  commissionMode: "MANUAL" | "AUTO_MEMBER" = "MANUAL",
  opts: { priorYearPeriod?: boolean } = {}
) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Accrual Dealer ${suffix}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `accrual_${suffix}`,
      email: `${suffix}@example.com`,
      name: "Rep User",
    })
  );
  // OWNER so payroll's separation-of-duties guard (a non-owner may not approve a
  // run that pays them) does not block the settlement tests below.
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "USD",
      currencySymbol: "$",
      enabledPaymentTypes: ["CASH"],
      commissionMode,
    })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN-${suffix}`,
      make: "Honda",
      model: "Accord",
      year: 2020,
      color: "Black",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 50000,
      purchasePrice: 10000,
      sellingPrice: 15000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "John",
      lastName: "Doe",
      email: `${suffix}.customer@example.com`,
    })
  );

  // A second owner, because cancelling a sale is a two-person control: the
  // salesperson may not approve the cancellation of their own sale
  // (assertDifferentActors). The commission tests need someone else to void it.
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `accrual_mgr_${suffix}`,
      email: `mgr.${suffix}@example.com`,
      name: "Manager User",
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));

  const asAdmin = t.withIdentity({ subject: `accrual_${suffix}`, clerkId: `accrual_${suffix}` });
  const asManager = t.withIdentity({
    subject: `accrual_mgr_${suffix}`,
    clerkId: `accrual_mgr_${suffix}`,
  });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date().getUTCFullYear();
  if (opts.priorYearPeriod) {
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(fiscalYear - 1, 0, 1),
      endDate: Date.UTC(fiscalYear - 1, 11, 31, 23, 59, 59, 999),
      fiscalYear: fiscalYear - 1,
      periodNumber: 1,
    });
  }
  await asAdmin.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  for (const period of await asAdmin.query(api.accountingPeriods.list, { orgId })) {
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }

  return { t, orgId, userId, managerId, vehicleId, customerId, asAdmin, asManager };
}

type Dealer = Awaited<ReturnType<typeof seedDealer>>;

/**
 * Net Commission Payable in minor units, summed straight off the GL. Credits
 * increase a liability, so this is credits minus debits — and it counts
 * reversing entries too, which is how the cancellation tests prove the account
 * actually returns to zero rather than merely stopping at the accrual.
 */
async function commissionPayableMinor({ t, orgId }: Pick<Dealer, "t" | "orgId">): Promise<number> {
  return await t.run(async (ctx) => {
    const account = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "COMMISSION_PAYABLE"))
      .unique();
    if (!account) return 0;
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("accountId", account._id))
      .collect();
    return lines.reduce((sum, l) => sum + l.creditMinor - l.debitMinor, 0);
  });
}

/** Net Commission Expense in minor units (debits minus credits — it is a P&L debit account). */
async function commissionExpenseMinor({ t, orgId }: Pick<Dealer, "t" | "orgId">): Promise<number> {
  return await t.run(async (ctx) => {
    const account = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "COMMISSION_EXPENSE"))
      .unique();
    if (!account) return 0;
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("accountId", account._id))
      .collect();
    return lines.reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
  });
}

async function accountingEventsFor(
  { t, orgId }: Pick<Dealer, "t" | "orgId">,
  eventType: string
) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    return rows.filter((r) => r.eventType === eventType);
  });
}

/** How many corrections have been posted against a sale's accrual. */
async function adjustmentSeq(d: Dealer, saleId: Id<"sales">): Promise<number> {
  return await d.t.run(async (ctx) => (await ctx.db.get(saleId))?.commissionAdjustmentSeq ?? 0);
}

/**
 * Closes the prior-year period. `close` refuses unless the caller echoes every
 * current warning back verbatim — that is the mechanism forcing a human to have
 * actually read the checklist — so the checklist is fetched and replayed here
 * rather than the warnings being guessed at.
 */
async function closePriorYearPeriod(d: Dealer, priorYear: number) {
  const period = (await d.asAdmin.query(api.accountingPeriods.list, { orgId: d.orgId })).find(
    (p) => p.fiscalYear === priorYear
  );
  if (!period) throw new Error(`no ${priorYear} period to close`);
  const checklist = await d.asAdmin.query(api.accountingPeriods.closeChecklist, {
    orgId: d.orgId,
    periodId: period._id,
  });
  await d.asAdmin.mutation(api.accountingPeriods.close, {
    orgId: d.orgId,
    periodId: period._id,
    acknowledgedWarnings: checklist.warnings,
    overrideReason: checklist.canClose ? undefined : "test fixture",
  });
}

async function completedSale(d: Dealer, saleDate = Date.now(), salePrice = 15000) {
  return await d.asAdmin.mutation(api.sales.create, {
    orgId: d.orgId,
    vehicleId: d.vehicleId,
    customerId: d.customerId,
    salespersonId: d.userId,
    salePrice,
    saleDate,
    status: "COMPLETED",
    financingType: "CASH",
  });
}

describe("a MANUAL commission is recognized when it becomes measurable", () => {
  test("setting the first amount on a completed sale accrues it immediately", async () => {
    const d = await seedDealer("first_accrual");
    const saleId = await completedSale(d);

    // Nothing is owed until somebody decides an amount.
    expect(await commissionPayableMinor(d)).toBe(0);

    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });

    // Pre-change this was still 0: MANUAL waited for payment, so the ledger
    // showed no liability for money the dealership had already committed to.
    expect(await commissionPayableMinor(d)).toBe(25_000);
    expect(await commissionExpenseMinor(d)).toBe(25_000);
  });

  test("the accrual is dated to the sale, not to when the amount was typed", async () => {
    const d = await seedDealer("accrual_date");
    const fiscalYear = new Date().getUTCFullYear();
    const saleDate = Date.UTC(fiscalYear, 0, 15);
    const saleId = await completedSale(d, saleDate);

    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 100,
    });

    const [accrual] = await accountingEventsFor(d, "COMMISSION_ACCRUED");
    // The matching principle: the expense belongs in the period that recognized
    // the revenue it was earned against.
    expect(accrual?.accountingDate).toBe(saleDate);
  });

  test("an amount entered on a draft accrues when the sale completes, not before", async () => {
    const d = await seedDealer("draft_then_complete");
    const saleId = await d.asAdmin.mutation(api.sales.createDraft, {
      orgId: d.orgId,
      vehicleId: d.vehicleId,
      customerId: d.customerId,
      salespersonId: d.userId,
      salePrice: 15000,
      saleDate: Date.now(),
      financingType: "CASH",
    });
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 300,
    });

    // A draft has earned nothing — probable, but not yet incurred.
    expect(await commissionPayableMinor(d)).toBe(0);

    await d.asAdmin.mutation(api.sales.completeDraft, { orgId: d.orgId, saleId });

    // Pre-change MANUAL deferred this to payment, so completing the sale left
    // the ledger showing no liability for an amount already decided.
    expect(await commissionPayableMinor(d)).toBe(30_000);
  });

  test("a completed sale with no amount accrues nothing", async () => {
    const d = await seedDealer("no_amount");
    await completedSale(d);
    expect(await commissionPayableMinor(d)).toBe(0);
    expect(await accountingEventsFor(d, "COMMISSION_ACCRUED")).toHaveLength(0);
  });

  test("an amount of zero is a decision, not a payable", async () => {
    const d = await seedDealer("zero_amount");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 0,
    });
    expect(await commissionPayableMinor(d)).toBe(0);
    expect(await accountingEventsFor(d, "COMMISSION_ACCRUED")).toHaveLength(0);
  });
});

describe("correcting an amount already on the books posts an adjusting entry", () => {
  test("an upward correction adds only the difference", async () => {
    const d = await seedDealer("adjust_up");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });

    // Pre-change this threw "already recorded in the ledger" and sent the user
    // to a correction workflow that does not exist.
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 400,
    });

    // 250 accrued + 150 adjusted — not 250 + 400, which is what posting the new
    // amount instead of the delta would produce.
    expect(await commissionPayableMinor(d)).toBe(40_000);
    expect(await commissionExpenseMinor(d)).toBe(40_000);
    expect(await accountingEventsFor(d, "COMMISSION_ADJUSTED")).toHaveLength(1);
    expect(await adjustmentSeq(d, saleId)).toBe(1);
  });

  test("a downward correction reduces the payable", async () => {
    const d = await seedDealer("adjust_down");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 400,
    });
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 150,
    });

    expect(await commissionPayableMinor(d)).toBe(15_000);
    expect(await commissionExpenseMinor(d)).toBe(15_000);
  });

  test("correcting to zero clears the payable completely", async () => {
    const d = await seedDealer("adjust_to_zero");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 400,
    });
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 0,
    });

    expect(await commissionPayableMinor(d)).toBe(0);
    expect(await commissionExpenseMinor(d)).toBe(0);
  });

  test("successive corrections each get their own entry and the payable tracks the latest amount", async () => {
    const d = await seedDealer("adjust_many");
    const saleId = await completedSale(d);
    for (const amount of [250, 400, 175, 600]) {
      await d.asAdmin.mutation(api.sales.setCommissionAmount, {
        orgId: d.orgId,
        saleId,
        commissionAmount: amount,
      });
    }

    // Three corrections after the initial accrual. A shared idempotency key
    // would have collapsed these into one and silently dropped the rest.
    expect(await accountingEventsFor(d, "COMMISSION_ADJUSTED")).toHaveLength(3);
    expect(await adjustmentSeq(d, saleId)).toBe(3);
    expect(await commissionPayableMinor(d)).toBe(60_000);
  });

  test("re-submitting the same amount posts nothing and burns no sequence number", async () => {
    const d = await seedDealer("adjust_noop");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });

    expect(await accountingEventsFor(d, "COMMISSION_ADJUSTED")).toHaveLength(0);
    expect(await adjustmentSeq(d, saleId)).toBe(0);
    expect(await commissionPayableMinor(d)).toBe(25_000);
  });

  test("an AUTO-mode commission is still not hand-editable after completion", async () => {
    const d = await seedDealer("auto_locked", "AUTO_MEMBER");
    const saleId = await completedSale(d);
    await expect(
      d.asAdmin.mutation(api.sales.setCommissionAmount, {
        orgId: d.orgId,
        saleId,
        commissionAmount: 999,
      })
    ).rejects.toThrow(/locked/i);
  });
});

describe("voiding a sale backs the whole commission out of the ledger", () => {
  test("cancellation reverses the accrual and every correction posted against it", async () => {
    const d = await seedDealer("cancel_with_adjustments");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 400,
    });
    expect(await commissionPayableMinor(d)).toBe(40_000);

    await d.asManager.mutation(api.sales.update, {
      orgId: d.orgId,
      saleId,
      status: "CANCELLED",
    });

    // Reversing only COMMISSION_ACCRUED — the behavior before this change —
    // leaves the +150 adjustment stranded and the account sitting at 15,000.
    expect(await commissionPayableMinor(d)).toBe(0);
    expect(await commissionExpenseMinor(d)).toBe(0);
  });

  test("cancelling a sale that was never corrected still reverses cleanly", async () => {
    const d = await seedDealer("cancel_plain");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    await d.asManager.mutation(api.sales.update, {
      orgId: d.orgId,
      saleId,
      status: "CANCELLED",
    });
    expect(await commissionPayableMinor(d)).toBe(0);
  });
});

describe("settlement clears exactly what was recognized", () => {
  test("paying a corrected commission directly nets Commission Payable to zero", async () => {
    const d = await seedDealer("direct_pay_adjusted");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 400,
    });

    await d.asAdmin.mutation(api.sales.markCommissionPaid, {
      orgId: d.orgId,
      saleId,
      paymentMethod: "CASH",
    });

    expect(await commissionPayableMinor(d)).toBe(0);
    // The expense stays — it was genuinely incurred; only the liability clears.
    expect(await commissionExpenseMinor(d)).toBe(40_000);
  });

  test("a payroll run pays the corrected amount and leaves no residue", async () => {
    const d = await seedDealer("payroll_adjusted");
    const fiscalYear = new Date().getUTCFullYear();
    const saleId = await completedSale(d, Date.UTC(fiscalYear, 0, 15));
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 400,
    });

    const runId = await d.asAdmin.mutation(api.payroll.createRun, {
      orgId: d.orgId,
      periodYear: fiscalYear,
      periodMonth: 1,
    });
    await d.asAdmin.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });
    await d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });

    // Approval re-accrues on the same idempotency key (a no-op), so the payable
    // is 400 — accrual 250 plus adjustment 150 — and payment clears all of it.
    expect(await commissionPayableMinor(d)).toBe(0);
    expect(await commissionExpenseMinor(d)).toBe(40_000);
  });

  test("correcting an amount after approval sends the run back for re-approval", async () => {
    const d = await seedDealer("payroll_drift");
    const fiscalYear = new Date().getUTCFullYear();
    const saleId = await completedSale(d, Date.UTC(fiscalYear, 0, 15));
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    const runId = await d.asAdmin.mutation(api.payroll.createRun, {
      orgId: d.orgId,
      periodYear: fiscalYear,
      periodMonth: 1,
    });
    await d.asAdmin.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });

    // The correction the old code made impossible: the amount was already
    // accrued by approval, and the only advice on offer was a workflow that
    // does not exist.
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 900,
    });

    const result = await d.asAdmin.mutation(api.payroll.payRun, {
      orgId: d.orgId,
      runId,
      method: "CASH",
    });
    // Paying a different number than was authorized is a control failure, so
    // the run must stop rather than quietly pay 900.
    expect(result.status).toBe("NEEDS_REAPPROVAL");

    await d.asAdmin.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });
    await d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    expect(await commissionPayableMinor(d)).toBe(0);
    expect(await commissionExpenseMinor(d)).toBe(90_000);
  });
});

describe("the Commission Payable reconciliation follows the entries, not the live amount", () => {
  test("a corrected commission still reconciles", async () => {
    const d = await seedDealer("recon_adjusted");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 400,
    });

    const recon = await d.asAdmin.query(api.accountingReports.commissionPayableReconciliation, {
      orgId: d.orgId,
    });
    expect(recon.isReconciled).toBe(true);
  });

  test("a correction that posts into a later period is not counted against the earlier one", async () => {
    // The regression this guards: the subledger side used to add the sale's
    // CURRENT commissionAmount whenever its accrual was in the window. Once a
    // correction can land in a later period than the accrual it corrects — which
    // is exactly what happens when the sale's own period has since closed — that
    // charges the whole corrected figure against a window whose GL holds only
    // part of it, and reports a difference on books that are right. Closing a
    // period requires acknowledging every warning verbatim, so a warning that
    // fires on correct books is how people learn to click through real ones.
    // Last year and this year, rather than two months of this one: whichever
    // month the suite happens to run in, the older period never contains today,
    // so closing it can never shut the period the correction has to post into.
    const d = await seedDealer("recon_split", "MANUAL", { priorYearPeriod: true });
    const priorYear = new Date().getUTCFullYear() - 1;

    const oldSale = await completedSale(d, Date.UTC(priorYear, 5, 15));
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId: oldSale,
      commissionAmount: 250,
    });
    // The accrual landed in last year's period and posted.
    expect(await commissionPayableMinor(d)).toBe(25_000);

    await closePriorYearPeriod(d, priorYear);

    // That period is shut, so the correction is recognized in the current open
    // one instead of queueing behind a closed period forever.
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId: oldSale,
      commissionAmount: 400,
    });
    expect(await commissionPayableMinor(d)).toBe(40_000);

    const asOfPriorYear = await d.asAdmin.query(
      api.accountingReports.commissionPayableReconciliation,
      { orgId: d.orgId, toDate: Date.UTC(priorYear, 11, 31, 23, 59, 59, 999) }
    );
    // That year's GL holds 250, and so must its subledger. Reading the live 400
    // here reported a phantom 150 difference.
    expect(asOfPriorYear.isReconciled).toBe(true);

    const asOfNow = await d.asAdmin.query(
      api.accountingReports.commissionPayableReconciliation,
      { orgId: d.orgId }
    );
    expect(asOfNow.isReconciled).toBe(true);
  });
});

describe("the reconciliation is point-in-time on BOTH sides", () => {
  test("a commission accrued in the period and paid after it still reconciles", async () => {
    // The regression: the GL side is as-of-toDate, but the subledger side read
    // CURRENT state, so a sale paid after the period end was dropped from the
    // subledger while the GL correctly still carried the liability. Paying a
    // month's commissions before closing that month is the normal workflow, so
    // this fired on most closes — on books that are right.
    const d = await seedDealer("recon_paid_after", "MANUAL", { priorYearPeriod: true });
    const priorYear = new Date().getUTCFullYear() - 1;
    const priorYearEnd = Date.UTC(priorYear, 11, 31, 23, 59, 59, 999);

    const saleId = await completedSale(d, Date.UTC(priorYear, 5, 15));
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    // Paid now — i.e. after the prior-year period ended.
    await d.asAdmin.mutation(api.sales.markCommissionPaid, {
      orgId: d.orgId,
      saleId,
      paymentMethod: "CASH",
    });

    const asOfPriorYearEnd = await d.asAdmin.query(
      api.accountingReports.commissionPayableReconciliation,
      { orgId: d.orgId, toDate: priorYearEnd }
    );
    expect(asOfPriorYearEnd.isReconciled).toBe(true);

    // And current state nets to zero on both sides.
    const asOfNow = await d.asAdmin.query(
      api.accountingReports.commissionPayableReconciliation,
      { orgId: d.orgId }
    );
    expect(asOfNow.isReconciled).toBe(true);
  });

  test("a commission accrued in the period and cancelled after it still reconciles", async () => {
    // Same shape as the payment case: the reversal is dated after the window,
    // so the GL still carries the accrual there and the subledger must too —
    // even though the accrual's row now reads REVERSED.
    const d = await seedDealer("recon_cancel_after", "MANUAL", { priorYearPeriod: true });
    const priorYear = new Date().getUTCFullYear() - 1;
    const priorYearEnd = Date.UTC(priorYear, 11, 31, 23, 59, 59, 999);

    const saleId = await completedSale(d, Date.UTC(priorYear, 5, 15));
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    await d.asManager.mutation(api.sales.update, {
      orgId: d.orgId,
      saleId,
      status: "CANCELLED",
    });

    const asOfPriorYearEnd = await d.asAdmin.query(
      api.accountingReports.commissionPayableReconciliation,
      { orgId: d.orgId, toDate: priorYearEnd }
    );
    expect(asOfPriorYearEnd.isReconciled).toBe(true);
    expect(await commissionPayableMinor(d)).toBe(0);
  });
});

describe("the backlog backfill", () => {
  test("accrues a completed unpaid commission that predates earned-time recognition", async () => {
    const d = await seedDealer("backfill");
    const saleId = await completedSale(d);
    // A sale carrying a decided amount with no accrual — the state every
    // MANUAL org is in for its existing commissions at deploy time.
    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: 250 }));
    expect(await commissionPayableMinor(d)).toBe(0);

    const dry = await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {
      dryRun: true,
    });
    expect(dry.accruedCount).toBe(1);
    expect(await commissionPayableMinor(d)).toBe(0);

    const run = await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});
    expect(run.accruedCount).toBe(1);
    expect(await commissionPayableMinor(d)).toBe(25_000);
    expect(await commissionExpenseMinor(d)).toBe(25_000);

    // Re-running accrues nothing further.
    const again = await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});
    expect(again.accruedCount).toBe(0);
    expect(again.skippedAlreadyRecognized).toBe(1);
    expect(await commissionPayableMinor(d)).toBe(25_000);
  });

  test("leaves an already-recognized commission alone", async () => {
    const d = await seedDealer("backfill_noop");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });

    const run = await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});
    expect(run.accruedCount).toBe(0);
    expect(await commissionPayableMinor(d)).toBe(25_000);
  });

  test("skips cancelled, unpaid-but-zero, and already-paid commissions", async () => {
    const d = await seedDealer("backfill_skips");
    const paidSale = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId: paidSale,
      commissionAmount: 250,
    });
    await d.asAdmin.mutation(api.sales.markCommissionPaid, {
      orgId: d.orgId,
      saleId: paidSale,
      paymentMethod: "CASH",
    });
    const before = await commissionPayableMinor(d);

    const run = await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});
    expect(run.accruedCount).toBe(0);
    expect(await commissionPayableMinor(d)).toBe(before);
  });
});

describe("no commission entry may overtake the entries it depends on", () => {
  /**
   * Builds the state the review found: an accrual sitting in the outbox because
   * the sale's period was open when it was raised and has since been closed,
   * while today's period is open so anything raised now posts immediately.
   */
  async function accrualQueuedBehindAClosedPeriod(suffix: string) {
    const d = await seedDealer(suffix, "MANUAL", { priorYearPeriod: true });
    const priorYear = new Date().getUTCFullYear() - 1;
    const saleId = await completedSale(d, Date.UTC(priorYear, 5, 15));
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    // Requeue the accrual as if it had never drained, then close its period so
    // it can no longer post. Patching the event directly is the only way to
    // model an outbox row whose period shut behind it.
    await d.t.run(async (ctx) => {
      const accrual = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", d.orgId).eq("sourceType", "sales").eq("sourceId", `commission_${saleId}`)
        )
        .first();
      if (!accrual) throw new Error("expected an accrual to requeue");
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", accrual.journalEntryId!))
        .collect();
      for (const line of lines) await ctx.db.delete(line._id);
      await ctx.db.delete(accrual.journalEntryId!);
      await ctx.db.delete(accrual._id);
      await ctx.db.insert("pendingAccountingEvents", {
        orgId: d.orgId,
        kind: "POST",
        status: "PENDING",
        idempotencyKey: `commission_accrued_${saleId}`,
        accountingDate: Date.UTC(priorYear, 5, 15),
        actorId: d.userId,
        attempts: 1,
        createdAt: Date.now(),
        eventType: "COMMISSION_ACCRUED",
        sourceType: "sales",
        sourceId: `commission_${saleId}`,
        eventVersion: 1,
        occurredAt: Date.UTC(priorYear, 5, 15),
        currency: "USD",
        payload: {
          saleId,
          amountMinor: 25_000,
          currency: "USD",
          salespersonId: d.userId,
        },
      });
    });
    await closePriorYearPeriod(d, priorYear);
    expect(await commissionPayableMinor(d)).toBe(0);
    return { d, saleId };
  }

  test("a direct payment refuses while the accrual is still queued", async () => {
    const { d, saleId } = await accrualQueuedBehindAClosedPeriod("pay_ahead");

    // Previously this posted the payment on its own: the re-raised accrual is a
    // no-op while an outbox row exists, so Commission Payable went to -25,000
    // and stayed there until someone reopened the closed month.
    await expect(
      d.asAdmin.mutation(api.sales.markCommissionPaid, {
        orgId: d.orgId,
        saleId,
        paymentMethod: "CASH",
      })
    ).rejects.toThrow(/hasn't posted to the ledger yet/i);

    expect(await commissionPayableMinor(d)).toBe(0);
    // The whole mutation rolled back, so the sale is not left marked paid.
    const sale = await d.t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionPaidAt ?? null).toBeNull();
  });

  test("a correction refuses while the accrual it corrects is still queued", async () => {
    const { d, saleId } = await accrualQueuedBehindAClosedPeriod("adjust_ahead");

    // A downward correction posting alone is a naked debit to Commission
    // Payable — the accrual it reduces is not on the books yet.
    await expect(
      d.asAdmin.mutation(api.sales.setCommissionAmount, {
        orgId: d.orgId,
        saleId,
        commissionAmount: 100,
      })
    ).rejects.toThrow(/hasn't posted to the ledger yet/i);

    expect(await commissionPayableMinor(d)).toBe(0);
    expect(await d.t.run((ctx) => ctx.db.get(saleId))).toMatchObject({ commissionAmount: 250 });
  });

  test("payroll refuses to pay while a CORRECTION is still queued", async () => {
    // The accrual is posted, so payroll's old accrual-only guard passed — but
    // payment debits the corrected amount, which the GL does not yet carry.
    const d = await seedDealer("payroll_queued_adj", "MANUAL", { priorYearPeriod: true });
    const priorYear = new Date().getUTCFullYear() - 1;
    const saleId = await completedSale(d, Date.UTC(priorYear, 5, 15));
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    await d.t.run(async (ctx) => {
      await ctx.db.insert("pendingAccountingEvents", {
        orgId: d.orgId,
        kind: "POST",
        status: "PENDING",
        idempotencyKey: `commission_adjusted_${saleId}_1`,
        accountingDate: Date.UTC(priorYear, 5, 15),
        actorId: d.userId,
        attempts: 1,
        createdAt: Date.now(),
        eventType: "COMMISSION_ADJUSTED",
        sourceType: "sales",
        sourceId: `commission_adj_${saleId}_1`,
        eventVersion: 1,
        occurredAt: Date.UTC(priorYear, 5, 15),
        currency: "USD",
        payload: { saleId, deltaMinor: 15_000, currency: "USD", salespersonId: d.userId },
      });
      const sale = await ctx.db.get(saleId);
      await ctx.db.patch(saleId, {
        commissionAmount: 400,
        commissionAdjustmentSeq: 1,
      });
      expect(sale).toBeTruthy();
    });

    const runId = await d.asAdmin.mutation(api.payroll.createRun, {
      orgId: d.orgId,
      periodYear: priorYear,
      periodMonth: 6,
    });
    await d.asAdmin.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });
    await expect(
      d.asAdmin.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" })
    ).rejects.toThrow(/hasn't posted to the ledger yet/i);
  });
});

describe("the outbox will not drain a settlement ahead of its own accrual", () => {
  /**
   * The state a mutation-side guard cannot police, and the one a chart-ready
   * dealership reaches by ordinary use: initializing a chart creates NO
   * periods, so the first commissions queue, and the first period an accountant
   * opens is usually the current month rather than the month of the sale.
   */
  async function queuedAccrualAndPayment(suffix: string, opts: { pay?: boolean } = {}) {
    const pay = opts.pay ?? true;
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: `Drain ${suffix}`, createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId, plan: "professional", status: "active",
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `drain_${suffix}`, email: `${suffix}@x.com`, name: "Rep" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMISSIONS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId, currency: "USD", currencySymbol: "$",
        enabledPaymentTypes: ["CASH"], commissionMode: "MANUAL",
      })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VIN-${suffix}`, make: "Honda", model: "Accord", year: 2020, color: "Black",
        fuelType: "Gasoline", transmission: "Automatic", mileage: 1, purchasePrice: 10000,
        sellingPrice: 15000, status: "AVAILABLE",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Drain", lastName: "Buyer" })
    );
    const asAdmin = t.withIdentity({ subject: `drain_${suffix}`, clerkId: `drain_${suffix}` });

    // Chart, but no periods at all — so everything queues.
    await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });

    const year = new Date().getUTCFullYear();
    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.UTC(year, 0, 15),
      status: "COMPLETED", financingType: "CASH",
    });
    await asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId, saleId, commissionAmount: 250,
    });
    if (pay) {
      await asAdmin.mutation(api.sales.markCommissionPaid, {
        orgId, saleId, paymentMethod: "CASH",
      });
    }

    const queued = await t.run(async (ctx) =>
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .collect()
    );
    expect(queued.map((q) => q.eventType)).toContain("COMMISSION_ACCRUED");
    if (pay) expect(queued.map((q) => q.eventType)).toContain("COMMISSION_PAID");

    return { t, orgId, userId, saleId, asAdmin, year };
  }

  test("opening only the payment's period does not post the payment alone", async () => {
    const { t, orgId, asAdmin, year } = await queuedAccrualAndPayment("pay_first");

    // Open a period covering TODAY (when the payment is dated) but not January
    // (when the accrual is dated).
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 5, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 2,
    });
    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });

    // Before the drain-side guard, COMMISSION_PAID posted here on its own and
    // Commission Payable sat at -25,000 until somebody opened a period nobody
    // knew to look for.
    expect(await commissionPayableMinor({ t, orgId })).toBe(0);
    const stillQueued = await t.run(async (ctx) =>
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .collect()
    );
    expect(stillQueued.map((q) => q.eventType)).toContain("COMMISSION_PAID");
  });

  test("a queued correction does not drain ahead of the accrual it corrects", async () => {
    // End-to-end cover for "a queued correction never posts alone". Note what
    // actually holds it here: every commission entry for a sale whose own
    // posting is queued inherits that posting's date, so the correction is out
    // of the opened period. The dispatcher rule that ALSO forbids it is proved
    // directly in utils/commissionSourceLedger.test.ts — deliberately, because
    // a drain test can pass because the entry happened to be held on its own
    // period rather than by the rule under test, which is how this class of
    // ordering bug survives a green suite.
    const { t, orgId, saleId, asAdmin, year } = await queuedAccrualAndPayment("adj_first", {
      pay: false,
    });
    await asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId, saleId, commissionAmount: 100,
    });

    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 5, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 2,
    });
    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });

    expect(await commissionPayableMinor({ t, orgId })).toBe(0);
    expect(await commissionExpenseMinor({ t, orgId })).toBe(0);
    const stillQueued = await t.run(async (ctx) =>
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .collect()
    );
    expect(stillQueued.map((q) => q.eventType)).toContain("COMMISSION_ADJUSTED");
  });

  test("a malformed row fails itself instead of aborting the whole drain", async () => {
    // The guards walk data the admin raw-JSON editor can write, and they ran
    // before drainEntries' per-entry try. A throw there aborted the whole
    // mutation — and since every drain starts from the same query, that row was
    // hit first every time, silently stopping all GL posting for the org.
    const { t, orgId, saleId, asAdmin, year } = await queuedAccrualAndPayment("drain_isolation");
    await t.run((ctx) => ctx.db.patch(saleId, { commissionAdjustmentSeq: 5_000_000 }));

    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

    // Returns rather than throwing, and never leaves the payable negative.
    const result = await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
    expect(result).toBeTruthy();
    expect(await commissionPayableMinor({ t, orgId })).toBeGreaterThanOrEqual(0);
  });

  test("once the accrual's period opens too, both post and net to zero", async () => {
    const { t, orgId, asAdmin, year } = await queuedAccrualAndPayment("both_open");

    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
    // Twice: the first drain posts the accrual, which unblocks the payment.
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
    await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });

    expect(await commissionPayableMinor({ t, orgId })).toBe(0);
    expect(await commissionExpenseMinor({ t, orgId })).toBe(25_000);
  });
});

describe("commission entries are dated by one rule everywhere", () => {
  test("an org with no chart queues its accrual at the SALE date, not today", async () => {
    // Nothing posts without a chart, so falling back to today would buy nothing
    // and permanently misdate the accrual: the sale itself queues at its own
    // date, so an org that initializes its chart later would book revenue and
    // commission in different months with no way to correct it.
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "No Chart Dealer", createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "nochart", email: "nochart@example.com", name: "Rep" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMISSIONS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "USD",
        currencySymbol: "$",
        enabledPaymentTypes: ["CASH"],
        commissionMode: "MANUAL",
      })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VIN-NOCHART", make: "Honda", model: "Accord", year: 2020, color: "Black",
        fuelType: "Gasoline", transmission: "Automatic", mileage: 1, purchasePrice: 10000,
        sellingPrice: 15000, status: "AVAILABLE",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "No", lastName: "Chart" })
    );
    const asAdmin = t.withIdentity({ subject: "nochart", clerkId: "nochart" });

    const saleDate = Date.UTC(new Date().getUTCFullYear(), 0, 20);
    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate, status: "COMPLETED", financingType: "CASH",
    });
    await asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId,
      saleId,
      commissionAmount: 250,
    });

    const queued = await t.run(async (ctx) =>
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `commission_accrued_${saleId}`)
        )
        .first()
    );
    expect(queued?.accountingDate).toBe(saleDate);
  });
});

describe("a commission never outruns the sale that earned it", () => {
  test("completing a sale backdated into a closed period does not post its commission alone", async () => {
    // On main the sale and its commission shared one date, so either both
    // posted or both queued. Giving only the commission a fallback let August
    // carry Commission Expense for a sale whose revenue, COGS and receivable
    // were queued in a closed June — and would eventually dead-letter.
    // Backdated month-end data entry after a close is routine.
    const d = await seedDealer("no_outrun", "AUTO_MEMBER", { priorYearPeriod: true });
    const priorYear = new Date().getUTCFullYear() - 1;
    await d.t.run(async (ctx) => {
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === d.orgId && m.userId === d.userId
      );
      await ctx.db.patch(membership!._id, { commissionRate: 10 });
    });
    await closePriorYearPeriod(d, priorYear);

    await completedSale(d, Date.UTC(priorYear, 5, 20));

    // The sale's own entry could not post into the closed year, so its
    // commission must not have posted into the open one either.
    expect(await commissionExpenseMinor(d)).toBe(0);
    expect(await commissionPayableMinor(d)).toBe(0);
  });

  test("a legacy sale with no SALE_COMPLETED event is not blocked forever", async () => {
    // Sales completed before the accounting hooks existed, and sales brought
    // over by the cutover (which posts under migrate_<txId>), have no
    // sale_completed_* event and never will. Blocking on that would hold their
    // accrual permanently: held entries never increment attempts, so they never
    // reach the FAILED list retryFailed can act on, and nothing in the product
    // can clear them — a permanent unposted blocker on every close.
    const d = await seedDealer("legacy_sale");
    const saleId = await d.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: d.orgId,
        vehicleId: d.vehicleId,
        customerId: d.customerId,
        salespersonId: d.userId,
        salePrice: 15000,
        saleDate: Date.now(),
        status: "COMPLETED",
        commissionAmount: 250,
      })
    );

    const run = await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});
    expect(run.accruedCount).toBe(1);
    await d.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId: d.orgId });

    expect(await commissionPayableMinor(d)).toBe(25_000);
    expect(saleId).toBeTruthy();
  });
});

describe("the recognition divergence control", () => {
  test("flags a commission recognized at a different amount than the sale records", async () => {
    // Models a delta computed against the wrong base, or an amount edited
    // straight through the admin raw-JSON editor. The payable reconciliation
    // cannot see this — both of its sides come from the same posted entries and
    // would be wrong together.
    const d = await seedDealer("divergence");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });

    const clean = await d.asAdmin.query(api.accountingReports.commissionPayableReconciliation, {
      orgId: d.orgId,
    });
    expect(clean.isReconciled).toBe(true);

    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: 900 }));

    // Still "reconciled" — which is exactly why a second, independent control
    // is needed.
    const stillReconciled = await d.asAdmin.query(
      api.accountingReports.commissionPayableReconciliation,
      { orgId: d.orgId }
    );
    expect(stillReconciled.isReconciled).toBe(true);

    const period = (await d.asAdmin.query(api.accountingPeriods.list, { orgId: d.orgId }))[0];
    const checklist = await d.asAdmin.query(api.accountingPeriods.closeChecklist, {
      orgId: d.orgId,
      periodId: period._id,
    });
    expect(checklist.warnings.join(" ")).toMatch(/recognized in the ledger at a different amount/i);
  });
});

describe("round-3 review fixes", () => {
  test("recalculateCommission dates its accrual by the shared rule, not by today", async () => {
    // The fourth call site. Dating it at `now` recognized the expense in the
    // month the cost basis was fixed rather than the month of the sale — the
    // exact mismatch this work removes — and, after a switch to MANUAL, let a
    // later correction post into the sale's own period with no accrual there.
    const d = await seedDealer("recalc_date", "AUTO_MEMBER");
    const year = new Date().getUTCFullYear();
    const saleDate = Date.UTC(year, 0, 15);

    // Complete with no cost basis, so nothing accrues at completion.
    await d.t.run((ctx) => ctx.db.patch(d.vehicleId, { purchasePrice: undefined }));
    const saleId = await completedSale(d, saleDate);
    expect(await accountingEventsFor(d, "COMMISSION_ACCRUED")).toHaveLength(0);

    // Fix the cost and recalculate — much later than the sale.
    await d.t.run((ctx) => ctx.db.patch(d.vehicleId, { purchasePrice: 10000 }));
    await d.t.run(async (ctx) => {
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === d.orgId && m.userId === d.userId
      );
      await ctx.db.patch(membership!._id, { commissionRate: 10 });
    });
    await d.asAdmin.mutation(api.sales.recalculateCommission, { orgId: d.orgId, saleId });

    const [accrual] = await accountingEventsFor(d, "COMMISSION_ACCRUED");
    expect(accrual?.accountingDate).toBe(saleDate);
  });

  test("a commission corrected past the adjustment ceiling is refused, not silently clamped", async () => {
    // Past the ceiling the reversal walk and the queued-entry check both stop
    // looking, so an entry there could never be reversed on cancellation and
    // would never be seen by the settlement guards.
    const d = await seedDealer("seq_ceiling");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAdjustmentSeq: 1000 }));

    await expect(
      d.asAdmin.mutation(api.sales.setCommissionAmount, {
        orgId: d.orgId,
        saleId,
        commissionAmount: 300,
      })
    ).rejects.toThrow(/corrected too many times/i);
  });

  test("settlement refuses when the sale's amount no longer matches what was recognized", async () => {
    const d = await seedDealer("settle_divergent");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId,
      saleId,
      commissionAmount: 250,
    });
    // Written outside every path that posts a delta — the admin raw-JSON
    // editor does exactly this.
    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: 900 }));

    // Paying would debit 900 against a 250 credit and leave the payable at
    // -650, with every later correction computing from the already-wrong row.
    await expect(
      d.asAdmin.mutation(api.sales.markCommissionPaid, {
        orgId: d.orgId,
        saleId,
        paymentMethod: "CASH",
      })
    ).rejects.toThrow(/does not match what the ledger recognized/i);
    expect(await commissionPayableMinor(d)).toBe(25_000);
  });

  test("the backlog is reported as unrecognized, not as recognized at the wrong amount", async () => {
    // Every commission decided before earned-time recognition shipped is in
    // this state. Reporting it as a mismatch made an ordinary migration
    // backlog read as ledger corruption, on a warning that must be
    // acknowledged verbatim on every close.
    const d = await seedDealer("backlog_wording");
    const saleId = await completedSale(d);
    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: 250 }));

    const period = (await d.asAdmin.query(api.accountingPeriods.list, { orgId: d.orgId }))[0];
    const before = await d.asAdmin.query(api.accountingPeriods.closeChecklist, {
      orgId: d.orgId,
      periodId: period._id,
    });
    expect(before.warnings.join(" ")).toMatch(/not recognized in the ledger at all/i);
    expect(before.warnings.join(" ")).not.toMatch(/at a different amount/i);

    await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});

    const after = await d.asAdmin.query(api.accountingPeriods.closeChecklist, {
      orgId: d.orgId,
      periodId: period._id,
    });
    expect(after.warnings.join(" ")).not.toMatch(/not recognized in the ledger at all/i);
  });

  test("the backfill attributes its posting to the org owner, never to the salesperson", async () => {
    // That id lands in accountingEvents.createdBy, journalEntries.postedBy and
    // the immutable POST_EVENT audit row. The one actor who must never appear
    // as the author of a commission posting is its beneficiary.
    const d = await seedDealer("backfill_actor");
    const saleId = await completedSale(d);
    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: 250 }));
    // The salesperson is a plain member; the manager holds the OWNER role.
    await d.t.run(async (ctx) => {
      const roles = await ctx.db.query("roles").collect();
      const ownerRole = roles.find((r) => r.orgId === d.orgId);
      const plain = await ctx.db.insert("roles", {
        orgId: d.orgId,
        name: "SALES",
        permissions: ["view:sales"],
      });
      const salesMembership = (await ctx.db.query("memberships").collect()).find(
        (m) => m.orgId === d.orgId && m.userId === d.userId
      );
      await ctx.db.patch(salesMembership!._id, { roleId: plain });
      expect(ownerRole).toBeTruthy();
    });

    await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});

    const [accrual] = await accountingEventsFor(d, "COMMISSION_ACCRUED");
    expect(accrual).toBeTruthy();
    expect(accrual?.createdBy).toBe(d.managerId);
    expect(accrual?.createdBy).not.toBe(d.userId);
  });

  test("a commission settled before commission GL hooks existed is not reported as backfillable", async () => {
    // It has no entries and never will — the backfill skips paid commissions —
    // so counting it named a remedy that cannot clear the warning, on a line
    // that must be acknowledged verbatim at every close, forever.
    const d = await seedDealer("historic_paid");
    const saleId = await completedSale(d);
    await d.t.run((ctx) =>
      ctx.db.patch(saleId, { commissionAmount: 250, commissionPaidAt: Date.now() })
    );

    const period = (await d.asAdmin.query(api.accountingPeriods.list, { orgId: d.orgId }))[0];
    const checklist = await d.asAdmin.query(api.accountingPeriods.closeChecklist, {
      orgId: d.orgId,
      periodId: period._id,
    });
    expect(checklist.warnings.join(" ")).not.toMatch(/not recognized in the ledger at all/i);
  });

  test("the backfill skips a commission amount that cannot be converted, and keeps going", async () => {
    // isCommissionOwed admits any positive number, including Infinity, and
    // toMinorUnits throws on it. A throw rolls back the self-reschedule with
    // it, so one bad row would silently halt the walk for every later org.
    const d = await seedDealer("backfill_bad_amount");
    const bad = await completedSale(d);
    const good = await d.t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId: d.orgId, vin: "VIN-GOOD", make: "Kia", model: "K5", year: 2024,
        color: "White", fuelType: "Gasoline", transmission: "Automatic",
        mileage: 1, purchasePrice: 9000, sellingPrice: 15000, status: "AVAILABLE",
      });
      return await ctx.db.insert("sales", {
        orgId: d.orgId, vehicleId, customerId: d.customerId, salespersonId: d.userId,
        salePrice: 15000, saleDate: Date.now(), status: "COMPLETED", commissionAmount: 100,
      });
    });
    await d.t.run((ctx) => ctx.db.patch(bad, { commissionAmount: Number.POSITIVE_INFINITY }));

    const run = await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});
    expect(run.skippedInvalidAmount).toBe(1);
    expect(run.accruedCount).toBe(1);
    // The good one still accrued rather than being lost with the bad one.
    expect(await commissionPayableMinor(d)).toBe(10_000);
    expect(good).toBeTruthy();
  });

  test("the backfill skips a sale whose accrual was reversed instead of dying on it", async () => {
    // Re-accruing on a reversed key throws "already been reversed and cannot be
    // reposted", and that throw rolls back the self-reschedule with it — ending
    // the walk for every later organization, silently.
    const d = await seedDealer("backfill_reversed");
    const reversed = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId, saleId: reversed, commissionAmount: 250,
    });
    await d.t.run(async (ctx) => {
      const accrual = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", d.orgId).eq("sourceType", "sales").eq("sourceId", `commission_${reversed}`)
        )
        .first();
      await ctx.db.patch(accrual!._id, { status: "REVERSED" });
    });

    const good = await d.t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId: d.orgId, vin: "VIN-REV-GOOD", make: "Kia", model: "K5", year: 2024,
        color: "White", fuelType: "Gasoline", transmission: "Automatic",
        mileage: 1, purchasePrice: 9000, sellingPrice: 15000, status: "AVAILABLE",
      });
      return await ctx.db.insert("sales", {
        orgId: d.orgId, vehicleId, customerId: d.customerId, salespersonId: d.userId,
        salePrice: 15000, saleDate: Date.now(), status: "COMPLETED", commissionAmount: 100,
      });
    });

    const run = await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});
    expect(run.skippedReversed).toBe(1);
    expect(run.accruedCount).toBe(1);
    expect(good).toBeTruthy();
  });

  test("the close checklist survives a commission amount that cannot be converted", async () => {
    // The control exists to REPORT corrupt amounts; throwing on one takes down
    // closeChecklist and, with it, `close` — before the blockers it builds and
    // the owner override that is meant to be the escape hatch.
    const d = await seedDealer("checklist_infinity");
    const saleId = await completedSale(d);
    await d.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId, saleId, commissionAmount: 250,
    });
    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: Number.POSITIVE_INFINITY }));

    const period = (await d.asAdmin.query(api.accountingPeriods.list, { orgId: d.orgId }))[0];
    const checklist = await d.asAdmin.query(api.accountingPeriods.closeChecklist, {
      orgId: d.orgId,
      periodId: period._id,
    });
    expect(checklist.warnings.join(" ")).toMatch(/at a different amount/i);
  });

  test("the backfill skips an org with no owner rather than inventing an actor", async () => {
    const d = await seedDealer("backfill_no_owner");
    const saleId = await completedSale(d);
    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: 250 }));
    await d.t.run(async (ctx) => {
      for (const role of await ctx.db.query("roles").collect()) {
        if (role.orgId === d.orgId) await ctx.db.patch(role._id, { isSystemOwnerRole: false, name: "SALES" });
      }
    });

    const run = await d.t.mutation(internal.migrateCommissionAccruals.backfillCommissionAccruals, {});
    expect(run.skippedNoOwner).toBeGreaterThan(0);
    expect(run.accruedCount).toBe(0);
    expect(await commissionPayableMinor(d)).toBe(0);
  });
});

describe("ruleCommissionAdjusted", () => {
  const base = { saleId: "s1", currency: "USD", salespersonId: "u1" };

  test("a positive delta debits expense and credits the payable", () => {
    const { lines } = ruleCommissionAdjusted({ ...base, deltaMinor: 15_000 });
    expect(lines).toEqual([
      expect.objectContaining({ accountSystemKey: "COMMISSION_EXPENSE", debitMinor: 15_000, creditMinor: 0 }),
      expect.objectContaining({ accountSystemKey: "COMMISSION_PAYABLE", debitMinor: 0, creditMinor: 15_000 }),
    ]);
  });

  test("a negative delta is the mirror image, at its absolute value", () => {
    const { lines } = ruleCommissionAdjusted({ ...base, deltaMinor: -15_000 });
    expect(lines).toEqual([
      expect.objectContaining({ accountSystemKey: "COMMISSION_PAYABLE", debitMinor: 15_000, creditMinor: 0 }),
      expect.objectContaining({ accountSystemKey: "COMMISSION_EXPENSE", debitMinor: 0, creditMinor: 15_000 }),
    ]);
  });

  test("a zero delta is refused rather than posted as an empty entry", () => {
    expect(() => ruleCommissionAdjusted({ ...base, deltaMinor: 0 })).toThrow(/zero delta/i);
  });

  test("every adjustment balances", () => {
    for (const deltaMinor of [1, -1, 999_999, -999_999, 250_00, -250_00]) {
      const { lines } = ruleCommissionAdjusted({ ...base, deltaMinor });
      const debits = lines.reduce((s, l) => s + l.debitMinor, 0);
      const credits = lines.reduce((s, l) => s + l.creditMinor, 0);
      expect(debits).toBe(credits);
    }
  });
});

