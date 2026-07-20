import { v, ConvexError } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth, TenantAuthContext } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import {
  getOrgCurrency,
  hookEmployeeAdvancePaid,
  hookEmployeeAdvanceRecovered,
  hookPayrollAccrued,
  hookPayrollPaid,
  hookCommissionAccrued,
  isPostableNow,
} from "./accounting/workflowHooks";
import { toMinorUnits, fromMinorUnits } from "./utils/money";
import { paymentMethodValidator, normalizePaymentMethod, PaymentMethod } from "./utils/paymentMethods";
import { runWithIdempotency } from "./utils/idempotency";

// ─── Employee compensation (fixed monthly salary) ──────────────────────────────

/**
 * Sets a team member's fixed monthly salary. History is kept: the previous
 * active row (if any) is deactivated and a new active row inserted, so past
 * payroll runs still reflect the salary that applied when they ran.
 */
export const setCompensation = mutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    monthlySalary: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      const authCtx = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const { user } = authCtx;
      assertNotSelfBeneficiary(authCtx, args.userId, "set your own salary");
      if (!(args.monthlySalary >= 0)) {
        throw new ConvexError("Monthly salary must be zero or a positive number.");
      }

      // Verify the target is a member of this org.
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId))
        .unique();
      if (!membership) {
        throw new ConvexError("User is not a member of this organization.");
      }

      const currency = await getOrgCurrency(ctx, args.orgId);
      const now = Date.now();

      const existing = await ctx.db
        .query("employeeCompensation")
        .withIndex("by_org_user_active", (q) =>
          q.eq("orgId", args.orgId).eq("userId", args.userId).eq("active", true)
        )
        .collect();
      for (const row of existing) {
        await ctx.db.patch(row._id, { active: false, updatedAt: now, updatedBy: user._id });
      }

      const id = await ctx.db.insert("employeeCompensation", {
        orgId: args.orgId,
        userId: args.userId,
        monthlySalaryMinor: toMinorUnits(args.monthlySalary, currency),
        currency,
        effectiveFrom: now,
        active: true,
        createdAt: now,
        createdBy: user._id,
        updatedAt: now,
        updatedBy: user._id,
      });
      return id;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("payroll.setCompensation failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/** Lists the active compensation for every member (salary shown in major units). */
export const listCompensation = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_PAYROLL]);
    const rows = await ctx.db
      .query("employeeCompensation")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("active"), true))
      .collect();
    return await Promise.all(
      rows.map(async (r) => {
        const u = await ctx.db.get(r.userId);
        return {
          ...r,
          monthlySalary: fromMinorUnits(r.monthlySalaryMinor, r.currency),
          userName: u?.name ?? u?.email ?? "Unknown",
        };
      })
    );
  },
});

// ─── Employee advances (سلفة) — a recoverable ASSET, not an expense ─────────────

export const recordAdvance = mutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    amount: v.number(),
    date: v.optional(v.number()),
    method: v.optional(paymentMethodValidator),
    note: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const authCtx = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const { user } = authCtx;
      assertNotSelfBeneficiary(authCtx, args.userId, "issue yourself an advance");
      if (!(args.amount > 0)) {
        throw new ConvexError("Advance amount must be a positive number.");
      }
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId))
        .unique();
      if (!membership) {
        throw new ConvexError("User is not a member of this organization.");
      }

      // Idempotent: a double-click or network retry with the same key returns
      // the first advance instead of issuing (and disbursing) a second one.
      return await runWithIdempotency(
        ctx,
        {
          orgId: args.orgId,
          operation: "payroll.recordAdvance",
          idempotencyKey: args.idempotencyKey,
          actorId: user._id,
          fingerprint: JSON.stringify({ userId: args.userId, amount: args.amount, date: args.date ?? null }),
        },
        async () => {
          const currency = await getOrgCurrency(ctx, args.orgId);
          const now = Date.now();
          const date = args.date ?? now;
          const method = normalizePaymentMethod(args.method);

          const advanceId = await ctx.db.insert("employeeAdvances", {
            orgId: args.orgId,
            userId: args.userId,
            amountMinor: toMinorUnits(args.amount, currency),
            recoveredMinor: 0,
            currency,
            date,
            method,
            status: "OUTSTANDING",
            note: args.note,
            createdBy: user._id,
            createdAt: now,
            updatedAt: now,
          });

          // GL: Dr Employee Advances (asset) / Cr cash — NOT an expense.
          await hookEmployeeAdvancePaid(ctx, {
            orgId: args.orgId,
            advanceId,
            userId: args.userId,
            amountMinor: toMinorUnits(args.amount, currency),
            currency,
            paymentMethod: method,
            actorId: user._id,
            occurredAt: date,
          });

          return advanceId;
        }
      );
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("payroll.recordAdvance failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Records a direct repayment of an outstanding advance. Recovers the full
 * remaining balance by default, or a specific `amount` for a partial repayment
 * (the advance stays OUTSTANDING until fully recovered).
 */
export const recoverAdvance = mutation({
  args: {
    orgId: v.id("organizations"),
    advanceId: v.id("employeeAdvances"),
    method: v.optional(paymentMethodValidator),
    amount: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const authCtx = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const { user } = authCtx;
      const advance = await ctx.db.get(args.advanceId);
      if (!advance || advance.isDeleted || advance.orgId !== args.orgId) {
        throw new ConvexError("Advance not found.");
      }
      // Separation of duties: a non-owner payroll admin must not clear the record
      // of their OWN debt — an independent actor has to record the repayment.
      assertNotSelfBeneficiary(authCtx, advance.userId, "record repayment of your own advance");
      if (advance.status !== "OUTSTANDING") {
        throw new ConvexError("Only an outstanding advance can be recovered.");
      }
      const outstandingMinor = advance.amountMinor - advance.recoveredMinor;
      if (outstandingMinor <= 0) {
        throw new ConvexError("This advance has nothing left to recover.");
      }

      // Full remaining balance unless a (positive, not-over) partial is given.
      let recoverMinor = outstandingMinor;
      if (args.amount !== undefined) {
        if (!(args.amount > 0)) {
          throw new ConvexError("Repayment amount must be a positive number.");
        }
        recoverMinor = toMinorUnits(args.amount, advance.currency);
        if (recoverMinor > outstandingMinor) {
          throw new ConvexError("Repayment amount exceeds the outstanding balance.");
        }
      }

      // Don't credit Employee Advances before the issuance that debited it has
      // actually posted — otherwise the asset goes negative (issuance queued in
      // a closed period, recovery posts now). Only enforced when the recovery
      // would post now; if it too would queue, it drains after the issuance.
      if (await isPostableNow(ctx, args.orgId, Date.now())) {
        await assertAdvanceIssuancePosted(ctx, args.orgId, args.advanceId);
      }

      const method = normalizePaymentMethod(args.method);

      // Idempotent: a double-click or network retry with the same key returns the
      // first recovery instead of booking a second partial repayment (a duplicate
      // full repayment self-guards via the RECOVERED status above, but a duplicate
      // PARTIAL would otherwise succeed twice against the re-read balance).
      return await runWithIdempotency(
        ctx,
        {
          orgId: args.orgId,
          operation: "payroll.recoverAdvance",
          idempotencyKey: args.idempotencyKey,
          actorId: user._id,
          fingerprint: JSON.stringify({ advanceId: args.advanceId, recoverMinor, method }),
        },
        async () => {
          const now = Date.now();
          const newRecovered = advance.recoveredMinor + recoverMinor;
          await ctx.db.patch(args.advanceId, {
            recoveredMinor: newRecovered,
            status: newRecovered >= advance.amountMinor ? "RECOVERED" : "OUTSTANDING",
            updatedAt: now,
          });

          // One immutable recovery row per repayment → its own GL identity, so
          // partial repayments each post a distinct EMPLOYEE_ADVANCE_RECOVERED.
          const recoveryId = await ctx.db.insert("employeeAdvanceRecoveries", {
            orgId: args.orgId,
            advanceId: args.advanceId,
            userId: advance.userId,
            amountMinor: recoverMinor,
            currency: advance.currency,
            method,
            source: "DIRECT",
            recoveredAt: now,
            recoveredBy: user._id,
            idempotencyKey: args.idempotencyKey,
          });

          // GL: Dr cash / Cr Employee Advances — the asset is settled.
          await hookEmployeeAdvanceRecovered(ctx, {
            orgId: args.orgId,
            advanceId: args.advanceId,
            recoveryId,
            userId: advance.userId,
            amountMinor: recoverMinor,
            currency: advance.currency,
            paymentMethod: method,
            actorId: user._id,
            occurredAt: now,
          });

          return recoveryId;
        }
      );
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("payroll.recoverAdvance failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/** Lists advances (optionally only outstanding), amounts shown in major units. */
export const listAdvances = query({
  args: {
    orgId: v.id("organizations"),
    onlyOutstanding: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_PAYROLL]);
    const rows = await ctx.db
      .query("employeeAdvances")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .collect();
    const filtered = args.onlyOutstanding ? rows.filter((r) => r.status === "OUTSTANDING") : rows;
    return await Promise.all(
      filtered.map(async (r) => {
        const u = await ctx.db.get(r.userId);
        return {
          ...r,
          amount: fromMinorUnits(r.amountMinor, r.currency),
          recovered: fromMinorUnits(r.recoveredMinor, r.currency),
          outstanding: fromMinorUnits(r.amountMinor - r.recoveredMinor, r.currency),
          userName: u?.name ?? u?.email ?? "Unknown",
        };
      })
    );
  },
});

/**
 * Total outstanding advance (minor units) for one employee — used by the
 * payroll run engine. When a run currency is given, every outstanding advance
 * must be in it (payroll performs no conversion); a mismatch throws rather than
 * summing incomparable amounts.
 */
export async function outstandingAdvanceMinor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  runCurrency?: string
): Promise<number> {
  const rows = await ctx.db
    .query("employeeAdvances")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .filter((q) => q.and(q.eq(q.field("status"), "OUTSTANDING"), q.neq(q.field("isDeleted"), true)))
    .collect();
  let sum = 0;
  for (const r of rows) {
    if (runCurrency !== undefined) assertSameCurrency(r.currency, runCurrency, "an employee advance");
    sum += r.amountMinor - r.recoveredMinor;
  }
  return sum;
}

// ─── Monthly payroll run (Option A: commissions paid through payroll) ───────────

/**
 * Salary (minor units) applicable to a period, per active member. Picks the
 * latest compensation row that took effect on or before the period's end. There
 * is NO fallback to a later row: an employee first paid in July has no June
 * salary, and silently back-paying today's rate for months never worked would
 * fabricate wages. All amounts must already be in the run currency.
 */
async function resolveSalariesForPeriod(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  periodEndMs: number,
  currency: string,
  activeMemberIds: Set<string>
): Promise<Map<string, number>> {
  const comps = await ctx.db
    .query("employeeCompensation")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const byUser = new Map<string, typeof comps>();
  for (const c of comps) {
    if (!activeMemberIds.has(c.userId)) continue;
    const list = byUser.get(c.userId) ?? [];
    list.push(c);
    byUser.set(c.userId, list);
  }
  const salaryByUser = new Map<string, number>();
  for (const [uid, rows] of byUser) {
    const applicable = rows
      .filter((r) => r.effectiveFrom <= periodEndMs)
      .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
    if (!applicable) continue; // no salary in force for this period → not paid
    assertSameCurrency(applicable.currency, currency, "a salary");
    salaryByUser.set(uid, applicable.monthlySalaryMinor);
  }
  return salaryByUser;
}

/**
 * Completed, unpaid, positive commissions grouped by salesperson (active members
 * only). A run may sweep OLDER outstanding commissions forward, but never one
 * earned AFTER the period — otherwise a retroactive run would recognize a
 * commission expense before the sale happened. `saleDate <= periodEndMs` is the
 * cutoff.
 */
async function collectUnpaidCommissions(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  currency: string,
  activeMemberIds: Set<string>,
  periodEndMs: number
): Promise<Map<string, { minor: number; saleIds: Id<"sales">[] }>> {
  const sales = await ctx.db
    .query("sales")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) =>
      q.and(
        q.neq(q.field("isDeleted"), true),
        q.eq(q.field("status"), "COMPLETED"),
        q.eq(q.field("commissionPaidAt"), undefined)
      )
    )
    .collect();
  const byUser = new Map<string, { minor: number; saleIds: Id<"sales">[] }>();
  for (const s of sales) {
    if (!s.commissionAmount || s.commissionAmount <= 0) continue;
    if (!activeMemberIds.has(s.salespersonId)) continue;
    if (s.saleDate > periodEndMs) continue; // earned after this period
    const entry = byUser.get(s.salespersonId) ?? { minor: 0, saleIds: [] };
    entry.minor += toMinorUnits(s.commissionAmount, currency);
    entry.saleIds.push(s._id);
    byUser.set(s.salespersonId, entry);
  }
  return byUser;
}

/**
 * Every stored minor-unit amount is meaningful only in its own currency, and
 * payroll performs no conversion — mixing currencies would silently misvalue
 * pay. Reject rather than guess.
 */
function assertSameCurrency(recordCurrency: string, runCurrency: string, what: string): void {
  if (recordCurrency !== runCurrency) {
    throw new ConvexError(
      `Cannot process ${what} in ${recordCurrency} on a ${runCurrency} payroll run. Currencies must match.`
    );
  }
}

/**
 * Separation of duties: a non-owner with manage:payroll must not be the
 * beneficiary of their own payroll action (set their own salary, advance
 * themselves, or approve/pay a run that includes their own payslip). The owner
 * is the ultimate authority and is exempt so a one-person dealership still
 * works. Owner self-payment stays possible but is the explicit, audited actor.
 */
function assertNotSelfBeneficiary(authCtx: TenantAuthContext, beneficiaryUserId: Id<"users">, action: string): void {
  if (isSystemOwnerRole(authCtx.role)) return;
  if (authCtx.user._id === beneficiaryUserId) {
    throw new ConvexError(
      `Only the organization owner can ${action}. Ask an owner to perform or approve this.`
    );
  }
}

/** True while a payroll accrual for this key is still queued (not yet posted). */
async function accrualStillQueued(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  const pending = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .filter((q) => q.neq(q.field("status"), "POSTED"))
    .first();
  return pending !== null;
}

/** Blocks recovery until the advance's issuance debit is actually on the books. */
async function assertAdvanceIssuancePosted(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  advanceId: Id<"employeeAdvances">
): Promise<void> {
  if (await accrualStillQueued(ctx, orgId, `employee_advance_paid_${advanceId}`)) {
    throw new ConvexError(
      "This advance's issuance hasn't posted to the ledger yet (its accounting period may be closed). Open the period so the issuance posts, then record the repayment."
    );
  }
}

/**
 * Payment-path counterpart of assertAccrualsPosted for advance recovery: every
 * outstanding advance the run could recover must have its issuance POSTED before
 * a payment that posts now credits Employee Advances — otherwise the asset is
 * credited below a debit that is still queued (issuance dated to a closed
 * period), driving it negative. Checked against the same outstanding-advance
 * population recoverItemAdvances will draw from.
 */
async function assertAdvanceIssuancesPosted(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  items: { userId: Id<"users">; currency: string }[]
): Promise<void> {
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.userId}:${item.currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const advances = await ctx.db
      .query("employeeAdvances")
      .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", item.userId))
      .filter((q) => q.and(q.eq(q.field("status"), "OUTSTANDING"), q.neq(q.field("isDeleted"), true)))
      .collect();
    for (const adv of advances) {
      if (adv.currency !== item.currency) continue;
      await assertAdvanceIssuancePosted(ctx, orgId, adv._id);
    }
  }
}

/**
 * Guards payment: every salary and still-settleable commission accrual for the
 * run must already be POSTED before the payment (which will post now) clears the
 * corresponding payable. A queued accrual (e.g. dated to a closed period) means
 * the payable does not yet exist in the GL — paying would drive it negative.
 */
async function assertAccrualsPosted(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  items: { _id: Id<"payrollItems">; baseSalaryMinor: number; commissionSaleIds: Id<"sales">[] }[]
): Promise<void> {
  for (const item of items) {
    if (item.baseSalaryMinor > 0 && (await accrualStillQueued(ctx, orgId, `payroll_accrued_${item._id}`))) {
      throw new ConvexError(
        "This run's salary accrual hasn't posted to the ledger yet (its accounting period may be closed). Open the period so the accrual posts, then pay."
      );
    }
    for (const saleId of item.commissionSaleIds) {
      const sale = await ctx.db.get(saleId);
      if (!sale || sale.commissionPaidAt != null || !sale.commissionAmount || sale.commissionAmount <= 0) continue;
      if (await accrualStillQueued(ctx, orgId, `commission_accrued_${saleId}`)) {
        throw new ConvexError(
          "A commission accrual for this run hasn't posted to the ledger yet (its accounting period may be closed). Open the period so the accrual posts, then pay."
        );
      }
    }
  }
}

/**
 * Re-derives the commission actually payable for a payslip from CURRENT sale
 * state, not the draft snapshot: a sale paid by another period's run, cancelled,
 * or deleted since drafting is skipped, so a commission is never paid twice and
 * a dead sale never clears a payable that no longer exists.
 */
async function settleItemCommissions(
  ctx: MutationCtx,
  item: Doc<"payrollItems">
): Promise<{ commissionMinor: number; saleIdsToSettle: Id<"sales">[] }> {
  let commissionMinor = 0;
  const saleIdsToSettle: Id<"sales">[] = [];
  for (const saleId of item.commissionSaleIds) {
    const sale = await ctx.db.get(saleId);
    if (
      !sale ||
      sale.isDeleted ||
      sale.status !== "COMPLETED" ||
      sale.commissionPaidAt != null ||
      !sale.commissionAmount ||
      sale.commissionAmount <= 0
    ) {
      continue;
    }
    commissionMinor += toMinorUnits(sale.commissionAmount, item.currency);
    saleIdsToSettle.push(saleId);
  }
  return { commissionMinor, saleIdsToSettle };
}

/**
 * Recovers outstanding advances oldest-first, up to `cap`, from CURRENT advance
 * balances (one may have been repaid or soft-deleted since drafting). Returns
 * the amount ACTUALLY recovered so the GL credit to Employee Advances can never
 * exceed reality.
 */
async function recoverItemAdvances(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  currency: string,
  cap: number,
  itemId: Id<"payrollItems">,
  actorId: Id<"users">,
  now: number
): Promise<number> {
  let toRecover = Math.min(await outstandingAdvanceMinor(ctx, orgId, userId, currency), cap);
  if (toRecover <= 0) return 0;
  const advances = (
    await ctx.db
      .query("employeeAdvances")
      .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
      .filter((q) => q.and(q.eq(q.field("status"), "OUTSTANDING"), q.neq(q.field("isDeleted"), true)))
      .collect()
  ).sort((a, b) => a.date - b.date);
  let recovered = 0;
  for (const adv of advances) {
    if (toRecover <= 0) break;
    const remaining = adv.amountMinor - adv.recoveredMinor;
    const take = Math.min(remaining, toRecover);
    const newRecovered = adv.recoveredMinor + take;
    await ctx.db.patch(adv._id, {
      recoveredMinor: newRecovered,
      status: newRecovered >= adv.amountMinor ? "RECOVERED" : "OUTSTANDING",
      updatedAt: now,
    });
    // Allocation audit row (the GL credit itself rides on the single PAYROLL_PAID
    // event, so this posts no separate accounting event).
    await ctx.db.insert("employeeAdvanceRecoveries", {
      orgId,
      advanceId: adv._id,
      userId,
      amountMinor: take,
      currency,
      source: "PAYROLL",
      payrollItemId: itemId,
      recoveredAt: now,
      recoveredBy: actorId,
    });
    recovered += take;
    toRecover -= take;
  }
  return recovered;
}

/**
 * Pays one payslip: settles its still-valid commissions, recovers advances,
 * posts the GL payment (skipping an all-zero payslip), marks the commissions
 * paid, and rewrites the item to what was ACTUALLY paid. Returns the paid gross
 * and net for the run totals.
 */
async function payItem(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  item: Doc<"payrollItems">,
  method: PaymentMethod,
  actorId: Id<"users">,
  now: number
): Promise<{ grossMinor: number; netMinor: number }> {
  const { commissionMinor, saleIdsToSettle } = await settleItemCommissions(ctx, item);
  const salaryMinor = item.baseSalaryMinor;
  const grossMinor = salaryMinor + commissionMinor;
  const advanceRecoveredMinor = await recoverItemAdvances(ctx, orgId, item.userId, item.currency, grossMinor, item._id, actorId, now);
  const netMinor = grossMinor - advanceRecoveredMinor;

  // Nothing left to pay (e.g. the only commission was settled by another run and
  // there's no salary) → skip the GL post (an all-zero entry) but still zero the
  // item below so reports don't show a phantom.
  if (grossMinor > 0) {
    await hookPayrollPaid(ctx, {
      orgId,
      itemId: item._id,
      userId: item.userId,
      salaryMinor,
      commissionMinor,
      advanceRecoveredMinor,
      netMinor,
      currency: item.currency,
      paymentMethod: method,
      actorId,
      occurredAt: now,
    });
  }

  for (const saleId of saleIdsToSettle) {
    await ctx.db.patch(saleId, {
      commissionPaidAt: now,
      commissionPaidBy: actorId,
      commissionPaymentMethod: method,
    });
  }

  await ctx.db.patch(item._id, {
    commissionMinor,
    advanceDeductionMinor: advanceRecoveredMinor,
    grossMinor,
    netMinor,
    commissionSaleIds: saleIdsToSettle,
  });
  return { grossMinor, netMinor };
}

/**
 * Builds a DRAFT payroll run for a period: one payslip item per active employee
 * who has a salary and/or unpaid commissions. Advances are deducted up to gross.
 * Nothing posts to the GL yet — that happens on approve (accrue) and pay.
 */
export const createRun = mutation({
  args: {
    orgId: v.id("organizations"),
    periodYear: v.number(),
    periodMonth: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      // Integer + range validation: NaN/fractional values slip past a bare
      // `< 1 || > 12` (NaN comparisons are false) and would then poison
      // Date.UTC below and persist a run under a different period than it
      // computed its cutoff for.
      if (!Number.isInteger(args.periodMonth) || args.periodMonth < 1 || args.periodMonth > 12) {
        throw new ConvexError("Month must be a whole number between 1 and 12.");
      }
      if (!Number.isInteger(args.periodYear) || args.periodYear < 2000 || args.periodYear > 2200) {
        throw new ConvexError("Year must be a valid whole number.");
      }
      // Reject a period that lies entirely in the future: salary is earned by
      // working the month, so a run cannot be drafted before the month has begun
      // (there is no advance-payroll workflow). The current, in-progress month is
      // allowed (dealerships commonly run payroll before month-end).
      if (Date.UTC(args.periodYear, args.periodMonth - 1, 1) > Date.now()) {
        throw new ConvexError("Cannot create a payroll run for a future period.");
      }

      const clash = await ctx.db
        .query("payrollRuns")
        .withIndex("by_org_period", (q) =>
          q.eq("orgId", args.orgId).eq("periodYear", args.periodYear).eq("periodMonth", args.periodMonth)
        )
        .filter((q) => q.neq(q.field("status"), "CANCELLED"))
        .first();
      if (clash) {
        throw new ConvexError("A payroll run already exists for this period.");
      }

      const currency = await getOrgCurrency(ctx, args.orgId);
      const now = Date.now();
      // Last millisecond of the payroll month (UTC): both the salary cutoff and
      // the accrual accounting date, so a retroactive run recognizes its expense
      // in the period worked, not the month it happens to be approved in.
      const periodEndMs = Date.UTC(args.periodYear, args.periodMonth, 1) - 1;

      // Only members with a still-active membership are on payroll — a deleted
      // or offboarding membership must NOT keep drawing salary. A former
      // employee's final settlement for a period they worked is a separate
      // manual adjustment, not an automatic monthly sweep.
      const activeMemberIds = new Set(
        (
          await ctx.db
            .query("memberships")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .collect()
        )
          .filter((m) => !m.offboardingStatus)
          .map((m) => m.userId)
      );

      const salaryByUser = await resolveSalariesForPeriod(ctx, args.orgId, periodEndMs, currency, activeMemberIds);
      const commissionByUser = await collectUnpaidCommissions(ctx, args.orgId, currency, activeMemberIds, periodEndMs);

      const userIds = new Set<string>([...salaryByUser.keys(), ...commissionByUser.keys()]);

      // Build every payslip BEFORE inserting the run, so an empty period (no
      // salaries, no commissions) is rejected instead of leaving a zero-item
      // draft that blocks the period until someone cancels it.
      let totalGross = 0;
      let totalNet = 0;
      const itemPayloads: {
        userId: Id<"users">;
        baseSalaryMinor: number;
        commissionMinor: number;
        advanceDeductionMinor: number;
        grossMinor: number;
        netMinor: number;
        commissionSaleIds: Id<"sales">[];
      }[] = [];
      for (const uid of userIds) {
        const userId = uid as Id<"users">;
        const baseSalaryMinor = salaryByUser.get(uid) ?? 0;
        const commission = commissionByUser.get(uid) ?? { minor: 0, saleIds: [] };
        const grossMinor = baseSalaryMinor + commission.minor;
        if (grossMinor <= 0) continue;

        const outstanding = await outstandingAdvanceMinor(ctx, args.orgId, userId, currency);
        const advanceDeductionMinor = Math.min(outstanding, grossMinor);
        const netMinor = grossMinor - advanceDeductionMinor;
        itemPayloads.push({
          userId,
          baseSalaryMinor,
          commissionMinor: commission.minor,
          advanceDeductionMinor,
          grossMinor,
          netMinor,
          commissionSaleIds: commission.saleIds,
        });
        totalGross += grossMinor;
        totalNet += netMinor;
      }
      if (itemPayloads.length === 0) {
        throw new ConvexError(
          "Nothing to pay for this period: no member has a salary or an unpaid commission."
        );
      }

      const runId = await ctx.db.insert("payrollRuns", {
        orgId: args.orgId,
        periodYear: args.periodYear,
        periodMonth: args.periodMonth,
        currency,
        status: "DRAFT",
        totalGrossMinor: totalGross,
        totalNetMinor: totalNet,
        accountingDate: periodEndMs,
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      });
      for (const p of itemPayloads) {
        await ctx.db.insert("payrollItems", {
          orgId: args.orgId,
          runId,
          userId: p.userId,
          baseSalaryMinor: p.baseSalaryMinor,
          commissionMinor: p.commissionMinor,
          otherEarningsMinor: 0,
          advanceDeductionMinor: p.advanceDeductionMinor,
          otherDeductionMinor: 0,
          grossMinor: p.grossMinor,
          netMinor: p.netMinor,
          currency,
          commissionSaleIds: p.commissionSaleIds,
          createdAt: now,
        });
      }
      return runId;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("payroll.createRun failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Cancels a DRAFT run. Only drafts: nothing has posted to the GL yet, so
 * cancellation is purely operational and frees the period for a fresh run
 * (the createRun clash check ignores CANCELLED runs). Reversing an APPROVED
 * or PAID run requires offsetting journal entries and is deliberately NOT
 * offered here — that's a manual accounting correction until a dedicated
 * reversal flow ships.
 */
export const cancelRun = mutation({
  args: { orgId: v.id("organizations"), runId: v.id("payrollRuns") },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const run = await ctx.db.get(args.runId);
      if (!run || run.orgId !== args.orgId) throw new ConvexError("Payroll run not found.");
      if (run.status !== "DRAFT") {
        throw new ConvexError(
          "Only a draft payroll run can be cancelled. Approved or paid runs need an accounting reversal."
        );
      }
      const now = Date.now();
      await ctx.db.patch(args.runId, {
        status: "CANCELLED",
        cancelledBy: user._id,
        cancelledAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("payroll.cancelRun failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Approves a DRAFT run: accrues each payslip's salary (Dr Salaries Expense /
 * Cr Salaries Payable) and ensures each consumed commission is accrued (Dr
 * Commission Expense / Cr Commission Payable — idempotent for AUTO, first-time
 * for MANUAL), so the payable exists before the payment clears it.
 */
export const approveRun = mutation({
  args: { orgId: v.id("organizations"), runId: v.id("payrollRuns") },
  handler: async (ctx, args) => {
    try {
      const authCtx = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const { user } = authCtx;
      const run = await ctx.db.get(args.runId);
      if (!run || run.orgId !== args.orgId) throw new ConvexError("Payroll run not found.");
      if (run.status !== "DRAFT") throw new ConvexError("Only a draft payroll run can be approved.");

      const now = Date.now();
      // Recognize the accrual in the period worked, not the approval month.
      const accrualDate = run.accountingDate ?? now;
      const items = await ctx.db
        .query("payrollItems")
        .withIndex("by_run", (q) => q.eq("runId", args.runId))
        .collect();

      // Separation of duties: a non-owner cannot approve a run that pays them.
      for (const item of items) assertNotSelfBeneficiary(authCtx, item.userId, "approve a payroll run that pays you");

      // A draft is NOT a frozen authorization. Revalidate membership and
      // re-derive salary from live compensation at approval time:
      //  - an employee offboarded/removed after drafting must not be accrued or
      //    paid (their period settlement is a separate manual adjustment), and
      //  - a salary corrected (up, down, or to zero) between draft and approval
      //    must be the amount that actually accrues and is approved — the draft's
      //    baseSalaryMinor snapshot is not trusted.
      const activeMemberIds = new Set(
        (
          await ctx.db
            .query("memberships")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .collect()
        )
          .filter((m) => !m.offboardingStatus)
          .map((m) => m.userId)
      );
      for (const item of items) {
        if (!activeMemberIds.has(item.userId)) {
          throw new ConvexError(
            "An employee on this draft is no longer an active member. Cancel this draft and create a fresh run for the period."
          );
        }
      }
      const salaryByUser = await resolveSalariesForPeriod(
        ctx,
        args.orgId,
        accrualDate,
        run.currency,
        activeMemberIds
      );

      // Approval RE-DERIVES each item from live state and freezes it, so the
      // amount accrued to the GL, the amount stored on the payslip, and the
      // approved run total can never disagree — e.g. a MANUAL commission edited
      // between draft and approval accrues, and is approved, at its live value.
      let approvedGross = 0;
      let approvedNet = 0;
      for (const item of items) {
        const baseSalaryMinor = salaryByUser.get(item.userId) ?? 0;
        if (baseSalaryMinor > 0) {
          await hookPayrollAccrued(ctx, {
            orgId: args.orgId,
            itemId: item._id,
            runId: args.runId,
            userId: item.userId,
            amountMinor: baseSalaryMinor,
            currency: item.currency,
            actorId: user._id,
            occurredAt: accrualDate,
          });
        }
        let commissionMinor = 0;
        const liveSaleIds: Id<"sales">[] = [];
        for (const saleId of item.commissionSaleIds) {
          const sale = await ctx.db.get(saleId);
          // A sale can leave the payable population between draft and approval:
          // cancelled/voided sales get their accrual REVERSED by the void hook,
          // so accruing (or later paying) them here would corrupt the payable.
          if (
            !sale ||
            sale.isDeleted ||
            sale.status !== "COMPLETED" ||
            sale.commissionPaidAt != null ||
            !sale.commissionAmount ||
            sale.commissionAmount <= 0
          ) {
            continue;
          }
          await hookCommissionAccrued(ctx, {
            orgId: args.orgId,
            saleId,
            salespersonId: sale.salespersonId,
            amountMinor: toMinorUnits(sale.commissionAmount, item.currency),
            currency: item.currency,
            actorId: user._id,
            occurredAt: accrualDate,
          });
          commissionMinor += toMinorUnits(sale.commissionAmount, item.currency);
          liveSaleIds.push(saleId);
        }

        const grossMinor = baseSalaryMinor + commissionMinor;
        const advanceDeductionMinor = Math.min(
          await outstandingAdvanceMinor(ctx, args.orgId, item.userId, item.currency),
          grossMinor
        );
        const netMinor = grossMinor - advanceDeductionMinor;
        await ctx.db.patch(item._id, {
          baseSalaryMinor,
          commissionMinor,
          commissionSaleIds: liveSaleIds,
          advanceDeductionMinor,
          grossMinor,
          netMinor,
        });
        approvedGross += grossMinor;
        approvedNet += netMinor;
      }

      await ctx.db.patch(args.runId, {
        status: "APPROVED",
        approvedBy: user._id,
        approvedAt: now,
        // Freeze the re-derived totals: approved == accrued == item snapshots.
        totalGrossMinor: approvedGross,
        totalNetMinor: approvedNet,
        approvedGrossMinor: approvedGross,
        approvedNetMinor: approvedNet,
        updatedAt: now,
      });
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("payroll.approveRun failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Pays an APPROVED run: for each payslip, recovers advances (oldest first),
 * posts the payslip payment (clears salary + commission payables, credits
 * Employee Advances, pays net cash), and marks the consumed commissions paid.
 * The commission payable is cleared by the payroll payment itself, so
 * hookCommissionPaid is NOT called (that would double-clear it).
 */
export const payRun = mutation({
  args: {
    orgId: v.id("organizations"),
    runId: v.id("payrollRuns"),
    method: v.optional(paymentMethodValidator),
  },
  handler: async (ctx, args) => {
    try {
      const authCtx = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
      const { user } = authCtx;
      const run = await ctx.db.get(args.runId);
      if (!run || run.orgId !== args.orgId) throw new ConvexError("Payroll run not found.");
      if (run.status !== "APPROVED") throw new ConvexError("Only an approved payroll run can be paid.");

      const now = Date.now();
      const method = normalizePaymentMethod(args.method);
      const items = await ctx.db
        .query("payrollItems")
        .withIndex("by_run", (q) => q.eq("runId", args.runId))
        .collect();

      // Separation of duties: a non-owner cannot pay a run that pays them.
      for (const item of items) assertNotSelfBeneficiary(authCtx, item.userId, "pay a payroll run that pays you");

      // Accrual-before-payment: if the payment itself will hit the ledger now,
      // every prerequisite accrual must already be POSTED — otherwise the
      // payment debits a payable that is still queued (e.g. the accrual is dated
      // to a closed period), driving Salaries/Commission Payable negative until
      // the old period is opened. When the payment would itself queue (no open
      // period now), it drains after the accrual, so no guard is needed.
      if (await isPostableNow(ctx, args.orgId, now)) {
        await assertAccrualsPosted(ctx, args.orgId, items);
        await assertAdvanceIssuancesPosted(ctx, args.orgId, items);
      }

      let paidGrossMinor = 0;
      let paidNetMinor = 0;
      for (const item of items) {
        const paid = await payItem(ctx, args.orgId, item, method, user._id, now);
        paidGrossMinor += paid.grossMinor;
        paidNetMinor += paid.netMinor;
      }

      await ctx.db.patch(args.runId, {
        status: "PAID",
        paidBy: user._id,
        paidAt: now,
        paidMethod: method,
        totalGrossMinor: paidGrossMinor,
        totalNetMinor: paidNetMinor,
        updatedAt: now,
      });
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("payroll.payRun failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/** Lists payroll runs (newest first) with their item counts. */
export const listRuns = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_PAYROLL]);
    const runs = await ctx.db
      .query("payrollRuns")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();
    return runs.map((r) => ({
      ...r,
      totalGross: fromMinorUnits(r.totalGrossMinor, r.currency),
      totalNet: fromMinorUnits(r.totalNetMinor, r.currency),
    }));
  },
});

/** Lists the payslip items of one run (amounts in major units). */
export const listRunItems = query({
  args: { orgId: v.id("organizations"), runId: v.id("payrollRuns") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_PAYROLL]);
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== args.orgId) throw new ConvexError("Payroll run not found.");
    const items = await ctx.db
      .query("payrollItems")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    return await Promise.all(
      items.map(async (i) => {
        const u = await ctx.db.get(i.userId);
        return {
          ...i,
          userName: u?.name ?? u?.email ?? "Unknown",
          baseSalary: fromMinorUnits(i.baseSalaryMinor, i.currency),
          commission: fromMinorUnits(i.commissionMinor, i.currency),
          advanceDeduction: fromMinorUnits(i.advanceDeductionMinor, i.currency),
          gross: fromMinorUnits(i.grossMinor, i.currency),
          net: fromMinorUnits(i.netMinor, i.currency),
        };
      })
    );
  },
});
