import { v, ConvexError } from "convex/values";
import { query, MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth, requireOrgMember, sameOrgOrNull, createOrgUserReader } from "./utils/tenancy";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { validateInput } from "./utils/validation";
import { CreateExpenseSchema, UpdateExpenseSchema } from "./validations/expenses";
import { checkTenantWriteLimit } from "./rateLimit";
import { runWithIdempotency } from "./utils/idempotency";
import { hookExpensePosted, getOrgCurrency, hookPrepaidExpenseAmortizationsReversed } from "./accounting/workflowHooks";
import { reverseAccountingEvent } from "./accounting/reversals";
import { cancelPendingPostByKey } from "./accountingOutbox";
import { requireFeature } from "./subscriptions";
import { toMinorUnits, fromMinorUnits } from "./utils/money";
import { assertSupplierSettlementDoorAllowed } from "./utils/supplierSettlementContainment";
import { costBearerValidator, isShowroomBorne, supplierBearerRefusal, type CostBearer } from "./utils/costBearer";
import {
  openSupplierCostRecovery,
  assertSupplierCostExpenseReversible,
  markSupplierCostRecoveryReversed,
} from "./supplierCostRecoveries";
import { normalizePaymentMethod, paymentMethodValidator } from "./utils/paymentMethods";
import { CAPITALIZABLE_EXPENSE_CATEGORIES } from "./utils/vehicleCost";
import { expenseAccountKeyForCategory } from "./accounting/postingRules";
import { createPrepaidScheduleForExpense, cancelPrepaidScheduleForExpense } from "./prepaidExpenses";
import { yearMonthIndex } from "./utils/expenseAmortization";
import { listEligibleBanks, requireActiveBankInCurrency } from "./utils/bankAccountGuards";
import { assertOpeningVehicleBasis } from "./utils/openingVehicleBasis";
import { expenseCategoryValidator as expenseCategory } from "./utils/expenseCategories";

// ─── Validators ──────────────────────────────────────────────────────────────

/**
 * Validates and normalizes the prepaid trio: a prepaid expense must specify a
 * whole number of amortization months (1–600); a non-prepaid one carries none
 * of the three fields. The PREPAID category and the isPrepaid flag are
 * otherwise two independent signals for the same accounting concept that
 * could silently disagree (e.g. category PREPAID with isPrepaid left false) —
 * for new writes, category always implies the flag rather than the two being
 * allowed to drift apart. `expenseDate` is the effective date of the expense
 * itself (the caller passes args.date on create, args.date ?? expense.date on
 * update) — amortizationStartDate can never predate it: recognition can't
 * begin before the prepaid asset was booked. Comparison is month-level (not
 * day-level) because recognition is month-bucketed — a start date a few days
 * earlier in the same calendar month changes nothing. Returns the cleaned
 * values to persist.
 */
function normalizePrepaidFields(
  category: string,
  isPrepaidArg: boolean | undefined,
  amortizationMonths: number | undefined,
  amortizationStartDate: number | undefined,
  expenseDate: number
): {
  isPrepaid: boolean | undefined;
  amortizationMonths: number | undefined;
  amortizationStartDate: number | undefined;
} {
  const isPrepaid = isPrepaidArg === true || category === "PREPAID";
  if (!isPrepaid) {
    return { isPrepaid: undefined, amortizationMonths: undefined, amortizationStartDate: undefined };
  }
  if (
    amortizationMonths === undefined ||
    !Number.isInteger(amortizationMonths) ||
    amortizationMonths < 1 ||
    amortizationMonths > 600
  ) {
    throw new ConvexError("A prepaid expense must specify a whole number of amortization months between 1 and 600.");
  }
  if (amortizationStartDate !== undefined && yearMonthIndex(amortizationStartDate) < yearMonthIndex(expenseDate)) {
    throw new ConvexError(
      "The amortization start date cannot be earlier than the month the expense was paid — recognition can't begin before the prepaid asset was booked."
    );
  }
  return { isPrepaid: true, amortizationMonths, amortizationStartDate };
}

async function hasExpenseAccountingExposure(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  expenseId: Id<"expenses">
) {
  const postedEvent = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "expenses").eq("sourceId", expenseId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
    .first();
  if (postedEvent) {
    return true;
  }

  const pendingPost = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", `expense_posted_${expenseId}`))
    .first();
  return pendingPost !== null;
}

/**
 * SCRUM-389 — THE gate for a SUPPLIER cost bearer. Throws unless the cost may
 * be borne by the supplier; a SHOWROOM (or absent) bearer always passes.
 *
 * Called at create, at update and — the one that cannot be skipped — inside
 * `recordPaidExpenseSideEffects` before any write, so every route that
 * reaches PAID re-proves it against the vehicle as it is AT PAYMENT. A PENDING
 * supplier cost on a car converted to stock in the meantime is refused there,
 * and because nothing catches the throw the whole mutation — status patch
 * included — rolls back and the expense stays unpaid.
 *
 * The org currency is the only currency an expense can be in (the row carries
 * none), so "org currency" is satisfied by construction; what is checked is
 * that the amount is exactly representable in it, so the recovery's due amount
 * equals the ledger's debit.
 */
async function assertCostBearerAllowed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    bearer: CostBearer | undefined;
    vehicleId: Id<"vehicles"> | undefined;
    category: string;
    isPrepaid: boolean | undefined;
    taxAmount: number | undefined;
    amount: number;
  }
): Promise<Doc<"vehicles"> | null> {
  if (args.bearer !== "SUPPLIER") return null;
  const vehicle = args.vehicleId ? await ctx.db.get(args.vehicleId) : null;
  const currency = await getOrgCurrency(ctx, args.orgId);
  const refusal = supplierBearerRefusal({
    orgId: args.orgId,
    vehicle,
    category: args.category,
    isPrepaid: args.isPrepaid,
    taxAmount: args.taxAmount,
    amountRepresentable:
      Number.isFinite(args.amount) &&
      args.amount > 0 &&
      fromMinorUnits(toMinorUnits(args.amount, currency), currency) === args.amount,
  });
  if (refusal) throw new ConvexError(refusal);
  return vehicle;
}

/**
 * SCRUM-811. Proves a vehicle id is a live car of `orgId`: it exists, belongs to
 * this org and is not deleted. The ONE definition of that refusal, used where a
 * vehicle id is accepted as an argument (create, update) and again at the
 * payment boundary, where the id comes from the STORED expense row instead.
 * Object-level authorization per OWASP API1:2023 (BOLA) and Convex's guidance to
 * check ownership inside every function that takes a document id.
 */
async function assertLiveOrgVehicle(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.isDeleted || vehicle.orgId !== orgId) {
    throw new ConvexError("Vehicle not found in this organization.");
  }
}

/**
 * SCRUM-811. A payer must be an ACTIVE member of the org AND still exist as a
 * user. `requireOrgMember` proves only the membership row, so a membership that
 * outlived its user would otherwise be accepted and later hydrate as a payer.
 * Kept local to expenses on purpose: the shared helper has many callers and is
 * not changed here.
 */
async function requireExistingOrgPayer(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  payerId: Id<"users">
): Promise<void> {
  await requireOrgMember(
    ctx,
    orgId,
    payerId,
    AppErrorCode.ASSIGNED_USER_NOT_MEMBER,
    "The selected payer is not a member of this organization."
  );
  if (!(await ctx.db.get(payerId))) {
    throwAppError(AppErrorCode.ASSIGNED_USER_NOT_MEMBER, "The selected payer is not a member of this organization.");
  }
}

async function recordPaidExpenseSideEffects(
  ctx: MutationCtx,
  args: {
    expense: Doc<"expenses">;
    actorId: Id<"users">;
    idempotencyKey?: string;
  }
) {
  // SCRUM-811: the payment boundary. Every route that creates a NEW payment effect
  // (create as PAID, PENDING to PAID) lands here and posts against the vehicle
  // STORED on the expense, which no argument check has seen. Prove it is a live
  // car of this org before any write. Only a new payment reaches this function:
  // replaying, editing or reversing an already-paid expense never does, so a car
  // deleted after the payment cannot block that history from being corrected.
  if (args.expense.vehicleId) {
    await assertLiveOrgVehicle(ctx, args.expense.orgId, args.expense.vehicleId);
  }

  // Before ANY write — see assertCostBearerAllowed.
  const supplierVehicle = await assertCostBearerAllowed(ctx, {
    orgId: args.expense.orgId,
    bearer: args.expense.costBearer,
    vehicleId: args.expense.vehicleId,
    category: args.expense.category,
    isPrepaid: args.expense.isPrepaid,
    taxAmount: args.expense.taxAmount,
    amount: args.expense.amount,
  });

  // A paid recon cost may debit Vehicle Inventory. A tracked imported car has
  // no acquisition event: its opening journal is the sole original cost basis.
  // Refuse the recon before its transaction, treatment, or GL posting until
  // that basis is posted. Later legitimate recon expense/reversal changes the
  // live inventory cost, not the immutable imported purchase price.
  const mayCapitalize = args.expense.vehicleId &&
    (args.expense.accountingTreatment === "CAPITALIZED_INVENTORY" ||
      (args.expense.accountingTreatment === undefined &&
        CAPITALIZABLE_EXPENSE_CATEGORIES.has(args.expense.category) &&
        !(args.expense.isPrepaid === true && (args.expense.amortizationMonths ?? 0) > 0)));
  if (mayCapitalize && args.expense.vehicleId) {
    await assertOpeningVehicleBasis(ctx, args.expense.orgId, args.expense.vehicleId, args.expense.date);
  }

  const existingTx = await ctx.db
    .query("transactions")
    .withIndex("by_org", (q) => q.eq("orgId", args.expense.orgId))
    .filter((q) => q.eq(q.field("expenseId"), args.expense._id))
    .first();

  if (!existingTx) {
    await ctx.db.insert("transactions", {
      orgId: args.expense.orgId,
      type: "OUT",
      amount: args.expense.amount,
      date: args.expense.date,
      category: "EXPENSE",
      description: `Expense: ${args.expense.title} (${args.expense.category})`,
      vehicleId: args.expense.vehicleId,
      expenseId: args.expense._id,
      idempotencyKey: args.idempotencyKey,
      // The P&L reads this row, not the expense — without the bearer here a
      // supplier-borne cost would be counted as COGS.
      costBearer: args.expense.costBearer,
    });
  }

  // Reconditioning costs (repair/maintenance/detailing/transport-in) on a
  // vehicle still in stock capitalize into Vehicle Inventory instead of
  // hitting the P&L immediately — see computeVehicleCapitalizedCost, the
  // single cost basis this must stay consistent with. Sourced vehicles never
  // sit in physical inventory, and a vehicle already SOLD has had its
  // inventory relieved, so both fall back to a normal period expense.
  //
  // Recorded once, permanently, at this exact moment — computeVehicleCapitalizedCost
  // reads this instead of re-deriving it later, so this decision (and the net
  // amount actually capitalized, excluding VAT) can never drift from what the
  // GL actually posted. See the schema comment on expenses.accountingTreatment.
  // A retry (e.g. after the vehicle sells) must NOT re-derive: the GL event
  // below is idempotent and won't re-post, so flipping the treatment here
  // would desync the expense's cost basis from what's already in the ledger.
  // A prepaid expense is a balance-sheet asset amortized over its term — it is
  // never simultaneously capitalized into a vehicle's inventory cost, so prepaid
  // wins and inventory capitalization is skipped for it.
  const isPrepaid = args.expense.isPrepaid === true && (args.expense.amortizationMonths ?? 0) > 0;

  let capitalizeToInventory = args.expense.accountingTreatment === "CAPITALIZED_INVENTORY";
  if (args.expense.accountingTreatment === undefined) {
    if (!isPrepaid && args.expense.vehicleId && CAPITALIZABLE_EXPENSE_CATEGORIES.has(args.expense.category)) {
      const vehicle = await ctx.db.get(args.expense.vehicleId);
      capitalizeToInventory = !!vehicle && vehicle.sourceType !== "SOURCED" && vehicle.status !== "SOLD";
    }

    const netAmount = args.expense.amount - (args.expense.taxAmount ?? 0);
    await ctx.db.patch(args.expense._id, {
      accountingTreatment: capitalizeToInventory ? "CAPITALIZED_INVENTORY" : "PERIOD_EXPENSE",
      capitalizedAmount: capitalizeToInventory ? netAmount : undefined,
    });
  }

  const currency = await getOrgCurrency(ctx, args.expense.orgId);
  await hookExpensePosted(ctx, {
    orgId: args.expense.orgId,
    expenseId: args.expense._id,
    amountMinor: toMinorUnits(args.expense.amount, currency),
    taxMinor: args.expense.taxAmount ? toMinorUnits(args.expense.taxAmount, currency) : undefined,
    currency,
    category: args.expense.category,
    paymentMethod: normalizePaymentMethod(args.expense.paymentMethod),
    bankAccountId: args.expense.bankAccountId,
    actorId: args.actorId,
    occurredAt: args.expense.date,
    vehicleId: args.expense.vehicleId,
    capitalizeToInventory,
    isPrepaid,
    costBearer: args.expense.costBearer,
  });

  // SCRUM-389: the receivable the posting above just debited, as a subledger
  // row the supplier's receipts can be recorded against. Same transaction, so
  // the two cannot exist without each other.
  if (supplierVehicle) {
    await openSupplierCostRecovery(ctx, {
      expense: args.expense,
      vehicle: supplierVehicle,
      currency,
      actorId: args.actorId,
    });
  }

  // Set up the amortization schedule so the Prepaid Expenses asset booked above
  // is released to its expense account ratably (prepaidExpenses.ts). The NET
  // (ex-VAT) minor amount is what was debited to the asset, so that's what
  // amortizes — computed the same way ruleExpensePosted derives its net line.
  if (isPrepaid && capitalizeToInventory === false) {
    const amountMinor = toMinorUnits(args.expense.amount, currency);
    const taxMinor = args.expense.taxAmount ? toMinorUnits(args.expense.taxAmount, currency) : 0;
    const netMinor = amountMinor - taxMinor;
    await createPrepaidScheduleForExpense(ctx, {
      orgId: args.expense.orgId,
      expenseId: args.expense._id,
      currency,
      totalMinor: netMinor,
      termMonths: args.expense.amortizationMonths!,
      expenseSystemKey: expenseAccountKeyForCategory(args.expense.category),
      startDate: args.expense.amortizationStartDate ?? args.expense.date,
    });
  }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Bank names offered to expense editors; mutation validation remains authoritative. */
export const listPaymentBankOptions = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_EXPENSES]);
    return await listEligibleBanks(ctx, args.orgId, await getOrgCurrency(ctx, args.orgId));
  },
});

/**
 * Lists all expenses for an organization, optionally filtering by vehicle.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_EXPENSES]);

    let pageResult;

    if (args.vehicleId) {
      pageResult = await ctx.db
        .query("expenses")
        .withIndex("by_org_vehicle", (q) =>
          q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId!)
        )
        .filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);
    } else {
      pageResult = await ctx.db
        .query("expenses")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);
    }

    // Hydrate vehicle info. SCRUM-811: the vehicle and payer ids are STORED on the row, so each
    // joined document must be proven to belong to this org before any field of it is returned.
    const readOrgUser = createOrgUserReader(ctx, args.orgId);
    const page = await Promise.all(
      pageResult.page.map(async (exp) => {
        let vehicle = null;
        if (exp.vehicleId) {
          vehicle = sameOrgOrNull(await ctx.db.get(exp.vehicleId), args.orgId);
        }
        let payerName = null;
        if (exp.payerId) {
          const payer = await readOrgUser(exp.payerId);
          if (payer && "name" in payer) {
            payerName = payer.name;
          }
        }
        return {
          ...exp,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model} - ${vehicle.vin}` : null,
          payerName,
          status: exp.status || "PAID", // Default old records to PAID
        };
      })
    );
    
    return { ...pageResult, page };
  },
});

/**
 * Returns total expenses for a single vehicle — lightweight, no pagination.
 * Used by the sales wizard to show cost breakdown to the salesperson.
 */
export const totalByVehicle = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_EXPENSES]);

    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_org_vehicle", (q) =>
        q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId)
      )
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .collect();

    // Shown to the salesperson as the vehicle's cost: a supplier-borne cost is
    // owed back by the supplier and is not the showroom's (SCRUM-389).
    return expenses.filter(isShowroomBorne).reduce((sum, e) => sum + e.amount, 0);
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Salary double-booking guard: once the org uses payroll (any active
 * compensation row), salaries must flow through a payroll run — which already
 * books Salaries Expense. A SALARIES expense recorded here too would
 * double-count it. Applied on create AND on any update whose EFFECTIVE category
 * is SALARIES (so a PENDING/OTHER expense can't be flipped to SALARIES+PAID to
 * bypass the create guard). Non-payroll orgs are unaffected.
 */
async function assertSalaryExpenseAllowed(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  effectiveCategory: string
): Promise<void> {
  if (effectiveCategory !== "SALARIES") return;
  const hasPayroll = await ctx.db
    .query("employeeCompensation")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) => q.eq(q.field("active"), true))
    .first();
  if (hasPayroll) {
    throw new ConvexError(
      "This organization uses the Payroll module — record salaries through a payroll run, not as an expense, to avoid double-counting the salary expense."
    );
  }
}

/**
 * Creates a new expense record.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")),
    title: v.string(),
    amount: v.number(),
    taxAmount: v.optional(v.number()),
    date: v.number(),
    category: expenseCategory,
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"))),
    vendor: v.optional(v.string()),
    payerId: v.optional(v.id("users")),
    paymentMethod: v.optional(paymentMethodValidator),
    bankAccountId: v.optional(v.id("bankAccounts")),
    notes: v.optional(v.string()),
    isPrepaid: v.optional(v.boolean()),
    amortizationMonths: v.optional(v.number()),
    amortizationStartDate: v.optional(v.number()),
    /**
     * SCRUM-389 — who bears this cost. Absent means SHOWROOM. SUPPLIER is
     * allowed only on an owned SOURCED vehicle, non-prepaid, untaxed.
     */
    costBearer: v.optional(costBearerValidator),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_EXPENSES]);
    await assertSalaryExpenseAllowed(ctx, args.orgId, args.category);
    // A caller-supplied users id, stored and later hydrated into `payer.name` by
    // the expense list — so an unvalidated one discloses a foreign user's
    // identity inside the caller's own org.
    if (args.payerId) {
      await requireExistingOrgPayer(ctx, args.orgId, args.payerId);
    }
    const status = args.status ?? "PAID";
    const paymentMethod = status === "PAID" ? normalizePaymentMethod(args.paymentMethod) : args.paymentMethod;
    if (args.taxAmount !== undefined && args.taxAmount > args.amount) {
      throw new ConvexError("VAT amount cannot exceed the expense amount.");
    }
    const { isPrepaid, amortizationMonths, amortizationStartDate } = normalizePrepaidFields(
      args.category,
      args.isPrepaid,
      args.amortizationMonths,
      args.amortizationStartDate,
      args.date
    );

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "expenses.create",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          vehicleId: args.vehicleId ?? null,
          title: args.title,
          amount: args.amount,
          taxAmount: args.taxAmount ?? null,
          date: args.date,
          category: args.category,
          status,
          vendor: args.vendor ?? null,
          payerId: args.payerId ?? null,
          paymentMethod: paymentMethod ?? null,
          ...(args.bankAccountId ? { bankAccountId: args.bankAccountId } : {}),
          notes: args.notes ?? null,
          isPrepaid: isPrepaid ?? null,
          amortizationMonths: amortizationMonths ?? null,
          amortizationStartDate: amortizationStartDate ?? null,
          // SCRUM-389. Hashed only when SUPPLIER: absent and SHOWROOM mean the
          // same thing, and `undefined` is dropped by JSON.stringify, so every
          // fingerprint stored before the bearer existed still matches its own
          // replay while a changed bearer under a reused key is refused.
          costBearer: args.costBearer === "SUPPLIER" ? "SUPPLIER" : undefined,
        }),
      },
      async () => {
        validateInput(CreateExpenseSchema, args);
        if (status !== "PAID" && args.bankAccountId) {
          throwAppError(AppErrorCode.EXPENSE_BANK_INVALID, "Choose a bank account when marking the expense paid.");
        }
        if (status === "PAID" && paymentMethod !== "CASH") {
          await requireActiveBankInCurrency(ctx, {
            orgId: args.orgId,
            bankAccountId: args.bankAccountId,
            currency: await getOrgCurrency(ctx, args.orgId),
            missingMessage: "Select the physical bank account used to pay this expense.",
            currencySubject: "expense payment",
            errorCode: AppErrorCode.EXPENSE_BANK_INVALID,
          });
        } else if (args.bankAccountId) {
          throwAppError(AppErrorCode.EXPENSE_BANK_INVALID, "A cash expense cannot name a bank account.");
        }

        if (args.vehicleId) {
          await assertLiveOrgVehicle(ctx, args.orgId, args.vehicleId);
        }
        // Refused before the insert, so a PENDING supplier cost that could
        // never be paid as one is never recorded. A PAID one is re-proved
        // inside recordPaidExpenseSideEffects.
        await assertCostBearerAllowed(ctx, {
          orgId: args.orgId,
          bearer: args.costBearer,
          vehicleId: args.vehicleId,
          category: args.category,
          isPrepaid,
          taxAmount: args.taxAmount,
          amount: args.amount,
        });

        const id = await ctx.db.insert("expenses", {
          orgId: args.orgId,
          vehicleId: args.vehicleId,
          title: args.title,
          amount: args.amount,
          taxAmount: args.taxAmount,
          date: args.date,
          category: args.category,
          status,
          idempotencyKey: args.idempotencyKey,
          paymentMethod,
          bankAccountId: args.bankAccountId,
          vendor: args.vendor,
          payerId: args.payerId,
          notes: args.notes,
          isPrepaid,
          amortizationMonths,
          amortizationStartDate,
          costBearer: args.costBearer,
        });

        if (status === "PAID") {
          const expense = await ctx.db.get(id);
          if (!expense) throw new ConvexError("Expense could not be created.");
          await recordPaidExpenseSideEffects(ctx, {
            expense,
            actorId: user._id,
            idempotencyKey: args.idempotencyKey,
          });
        }

        const actorName = await getActorName(ctx);
        await notifyManagers(
          ctx,
          args.orgId,
          "expense.created",
          { actorName, expenseTitle: args.title, amount: `$${args.amount}` },
          { link: `/${args.orgId}/expenses?highlightId=${id}` }
        );

        return id;
      }
    );
  },
});

/**
 * Updates an expense.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    expenseId: v.id("expenses"),
    vehicleId: v.optional(v.union(v.id("vehicles"), v.null())),
    title: v.optional(v.string()),
    amount: v.optional(v.number()),
    taxAmount: v.optional(v.number()),
    date: v.optional(v.number()),
    category: v.optional(expenseCategory),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"))),
    vendor: v.optional(v.string()),
    payerId: v.optional(v.union(v.id("users"), v.null())),
    paymentMethod: v.optional(paymentMethodValidator),
    bankAccountId: v.optional(v.union(v.id("bankAccounts"), v.null())),
    notes: v.optional(v.string()),
    isPrepaid: v.optional(v.boolean()),
    amortizationMonths: v.optional(v.number()),
    // null (distinct from omitted/undefined) explicitly clears a previously-set
    // start date back to "recognition begins the month the expense was paid" —
    // same null-means-clear convention as vehicleId/payerId below.
    amortizationStartDate: v.optional(v.union(v.number(), v.null())),
    /** SCRUM-389. Changeable only while PENDING; immutable once PAID. */
    costBearer: v.optional(costBearerValidator),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_EXPENSES]);

    const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    // Note: Zod schema might not expect `null` for vehicleId or payerId directly if not configured,
    // but the schema is typed using .optional(). We may need to filter out nulls or the schema might pass.
    // The UpdateExpenseSchema defines them as optional string, not nullable.
    // We can pre-process args before validation if necessary, or just validate.
    // The UpdateExpenseSchema is `.partial()`, so `undefined` is allowed. `null` from Convex might fail Zod string check.
    // Let's strip nulls before validation just for Zod.
    const argsToValidate = { ...args };
    if (argsToValidate.vehicleId === null) delete argsToValidate.vehicleId;
    if (argsToValidate.payerId === null) delete argsToValidate.payerId;
    if (argsToValidate.amortizationStartDate === null) delete argsToValidate.amortizationStartDate;
    if (argsToValidate.bankAccountId === null) delete argsToValidate.bankAccountId;

    validateInput(UpdateExpenseSchema, argsToValidate);

    const expense = await ctx.db.get(args.expenseId);
    if (!expense || expense.isDeleted || expense.orgId !== args.orgId) {
      throw new ConvexError("Expense not found.");
    }

    // Same salary double-booking guard as create, against the EFFECTIVE category:
    // blocks flipping a non-salary expense to SALARIES (which would then post
    // Salaries Expense outside payroll on the PENDING→PAID transition).
    await assertSalaryExpenseAllowed(ctx, args.orgId, args.category ?? expense.category);

    const effectiveAmount = args.amount ?? expense.amount;
    const effectiveTaxAmount = args.taxAmount ?? expense.taxAmount;
    if (effectiveTaxAmount !== undefined && effectiveTaxAmount > effectiveAmount) {
      throw new ConvexError("VAT amount cannot exceed the expense amount.");
    }

    const currentStatus = expense.status ?? "PAID";
    const nextStatus = args.status ?? currentStatus;
    const willMarkPaid = currentStatus === "PENDING" && nextStatus === "PAID";
    const effectiveMethod = normalizePaymentMethod(args.paymentMethod ?? expense.paymentMethod);
    const effectiveBankAccountId = args.bankAccountId === null ? undefined : (args.bankAccountId ?? expense.bankAccountId);
    const bankChoiceChanged = args.bankAccountId !== undefined && effectiveBankAccountId !== expense.bankAccountId;
    const methodChanged = args.paymentMethod !== undefined && effectiveMethod !== normalizePaymentMethod(expense.paymentMethod);
    if (nextStatus === "PAID" && effectiveMethod !== "CASH") {
      // A newly paid bank expense must carry its physical bank before any write.
      // An unchanged PAID replay need not revalidate a bank that may have been
      // deactivated after the original payment was accepted.
      if (willMarkPaid || methodChanged || bankChoiceChanged) {
        await requireActiveBankInCurrency(ctx, {
          orgId: args.orgId,
          bankAccountId: effectiveBankAccountId,
          currency: await getOrgCurrency(ctx, args.orgId),
          missingMessage: "Select the physical bank account used to pay this expense.",
          currencySubject: "expense payment",
          errorCode: AppErrorCode.EXPENSE_BANK_INVALID,
        });
      }
    } else if (effectiveBankAccountId) {
      throwAppError(AppErrorCode.EXPENSE_BANK_INVALID, "A cash or pending expense cannot name a bank account.");
    }
    // SCRUM-389: the bearer decided which account the payment was debited to
    // and whether a recovery was opened. Once PAID it is history, whatever the
    // posting state — a queued post has already frozen it in its payload.
    const currentBearer: CostBearer = expense.costBearer ?? "SHOWROOM";
    const bearerChanges = args.costBearer !== undefined && args.costBearer !== currentBearer;
    if (bearerChanges && currentStatus === "PAID") {
      throw new ConvexError(
        "Who bears a paid expense cannot be changed once it is paid."
      );
    }
    const hasAccountingExposure = await hasExpenseAccountingExposure(ctx, args.orgId, args.expenseId);
    const hasMaterialAccountingChange =
      (args.vehicleId !== undefined && args.vehicleId !== (expense.vehicleId ?? null)) ||
      (args.title !== undefined && args.title !== expense.title) ||
      (args.amount !== undefined && args.amount !== expense.amount) ||
      (args.taxAmount !== undefined && (args.taxAmount || 0) !== (expense.taxAmount || 0)) ||
      (args.date !== undefined && args.date !== expense.date) ||
      (args.category !== undefined && args.category !== expense.category) ||
      (args.status !== undefined && args.status !== currentStatus) ||
      (args.paymentMethod !== undefined && args.paymentMethod !== expense.paymentMethod) ||
      bankChoiceChanged ||
      (args.isPrepaid !== undefined && (args.isPrepaid || false) !== (expense.isPrepaid || false)) ||
      (args.amortizationMonths !== undefined && args.amortizationMonths !== expense.amortizationMonths) ||
      (args.amortizationStartDate !== undefined && args.amortizationStartDate !== (expense.amortizationStartDate ?? null)) ||
      bearerChanges;
    if (hasAccountingExposure && hasMaterialAccountingChange) {
      throw new ConvexError(
        "Posted expenses are locked. Use a correction or reversal workflow before changing accounting fields."
      );
    }

    // Re-validate the prepaid trio against the post-update effective values so a
    // partial edit (e.g. flipping isPrepaid on without months) can't persist an
    // inconsistent schedule basis. `date` also re-triggers this even though
    // it isn't one of the trio's own fields: moving the expense's date can by
    // itself make an unchanged, already-stored amortizationStartDate invalid
    // (now earlier than the new effective date).
    let normalizedPrepaid: {
      isPrepaid: boolean | undefined;
      amortizationMonths: number | undefined;
      amortizationStartDate: number | undefined;
    } | null = null;
    if (
      args.isPrepaid !== undefined ||
      args.amortizationMonths !== undefined ||
      args.amortizationStartDate !== undefined ||
      args.category !== undefined ||
      args.date !== undefined
    ) {
      normalizedPrepaid = normalizePrepaidFields(
        args.category ?? expense.category,
        args.isPrepaid ?? expense.isPrepaid,
        args.amortizationMonths ?? expense.amortizationMonths,
        args.amortizationStartDate === null ? undefined : (args.amortizationStartDate ?? expense.amortizationStartDate),
        args.date ?? expense.date
      );
    }

    // The bearer gate against the EFFECTIVE post-update values, so moving a
    // PENDING supplier cost to a stock car, adding VAT or making it prepaid is
    // refused here rather than only when it is finally paid.
    await assertCostBearerAllowed(ctx, {
      orgId: args.orgId,
      bearer: args.costBearer ?? expense.costBearer,
      vehicleId: args.vehicleId === null ? undefined : (args.vehicleId ?? expense.vehicleId),
      category: args.category ?? expense.category,
      isPrepaid: normalizedPrepaid ? normalizedPrepaid.isPrepaid : expense.isPrepaid,
      taxAmount: effectiveTaxAmount,
      amount: effectiveAmount,
    });

    // SCRUM-811: a PENDING to PAID transition posts against the EFFECTIVE vehicle, which is
    // the stored one when this call does not name another. Refuse a foreign, missing or
    // deleted car here, before the first patch, as the argument check below does for a
    // named car. recordPaidExpenseSideEffects proves it again as the boundary of last
    // resort. An update that is not a new payment is deliberately not re-validated.
    if (willMarkPaid) {
      const payingVehicleId = args.vehicleId === null ? undefined : (args.vehicleId ?? expense.vehicleId);
      if (payingVehicleId) await assertLiveOrgVehicle(ctx, args.orgId, payingVehicleId);
    }

    const patch: Record<string, unknown> = {};
    if (args.costBearer !== undefined) patch.costBearer = args.costBearer;

    if (args.vehicleId !== undefined) {
      if (args.vehicleId !== null) {
        await assertLiveOrgVehicle(ctx, args.orgId, args.vehicleId);
      }
      patch.vehicleId = args.vehicleId === null ? undefined : args.vehicleId;
    }

    if (args.title !== undefined) patch.title = args.title;
    if (args.amount !== undefined) patch.amount = args.amount;
    if (args.taxAmount !== undefined) patch.taxAmount = args.taxAmount;
    if (args.date !== undefined) patch.date = args.date;
    if (args.category !== undefined) patch.category = args.category;
    if (args.status !== undefined) patch.status = args.status;
    if (args.vendor !== undefined) patch.vendor = args.vendor;
    if (args.paymentMethod !== undefined) patch.paymentMethod = args.paymentMethod;
    if (args.bankAccountId !== undefined) patch.bankAccountId = effectiveBankAccountId;
    if (args.payerId !== undefined) {
      if (args.payerId !== null) {
        await requireExistingOrgPayer(ctx, args.orgId, args.payerId);
      }
      patch.payerId = args.payerId === null ? undefined : args.payerId;
    }
    if (args.notes !== undefined) patch.notes = args.notes;
    if (normalizedPrepaid) {
      patch.isPrepaid = normalizedPrepaid.isPrepaid;
      patch.amortizationMonths = normalizedPrepaid.amortizationMonths;
      patch.amortizationStartDate = normalizedPrepaid.amortizationStartDate;
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.expenseId, patch);

      // Sync amount/date on the linked legacy transaction row when they change
      if (patch.amount !== undefined || patch.date !== undefined) {
        const linkedTx = await ctx.db
          .query("transactions")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .filter((q) => q.eq(q.field("expenseId"), args.expenseId))
          .first();
        if (linkedTx) {
          const txPatch: Record<string, unknown> = {};
          if (patch.amount !== undefined) txPatch.amount = patch.amount;
          if (patch.date !== undefined) txPatch.date = patch.date;
          await ctx.db.patch(linkedTx._id, txPatch);
        }
      }

      if (willMarkPaid) {
        const updatedExpense = await ctx.db.get(args.expenseId);
        if (!updatedExpense) throw new ConvexError("Expense not found.");
        await recordPaidExpenseSideEffects(ctx, {
          expense: updatedExpense,
          actorId: user._id,
        });
      }

      const actorName = await getActorName(ctx);
      await notifyManagers(
        ctx,
        args.orgId,
        "expense.updated",
        { actorName },
        { link: `/${args.orgId}/expenses?highlightId=${args.expenseId}` }
      );
    }
  },
});

/**
 * Soft-deletes the expense row and its linked legacy transaction, then
 * notifies managers. Shared by remove() (never-posted expenses) and
 * reverseExpense() (posted expenses, called only after their accounting
 * effect has been reversed) — from the user's perspective both end the same
 * way: the expense disappears from the active list.
 */
async function softDeleteExpenseRecord(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; expenseId: Id<"expenses">; expense: Doc<"expenses">; deletedBy: string; now: number }
) {
  await ctx.db.patch(args.expenseId, {
    isDeleted: true,
    deletedAt: args.now,
    deletedBy: args.deletedBy,
  });

  // Also soft-delete the linked legacy transaction row so reports stay consistent
  const linkedTx = await ctx.db
    .query("transactions")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .filter((q) => q.eq(q.field("expenseId"), args.expenseId))
    .first();
  if (linkedTx && !linkedTx.isDeleted) {
    await ctx.db.patch(linkedTx._id, {
      isDeleted: true,
      deletedAt: args.now,
      deletedBy: args.deletedBy,
    });
  }

  const actorName = await getActorName(ctx);
  await notifyManagers(
    ctx,
    args.orgId,
    "expense.deleted",
    { actorName, expenseTitle: args.expense.title }
  );
}

/**
 * Deletes an expense.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    expenseId: v.id("expenses"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_EXPENSES]);

    const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const expense = await ctx.db.get(args.expenseId);
    if (!expense || expense.isDeleted || expense.orgId !== args.orgId) {
      throw new ConvexError("Expense not found.");
    }
    if (await hasExpenseAccountingExposure(ctx, args.orgId, args.expenseId)) {
      throw new ConvexError("Posted expenses cannot be deleted. Use a reversal workflow instead.");
    }
    // SCRUM-389, defence in depth: a live supplier-cost recovery means the
    // expense was paid as a supplier cost. Deleting it would orphan the
    // receivable, whatever the exposure probe above concluded.
    const recovery = await ctx.db
      .query("supplierCostRecoveries")
      .withIndex("by_org_expense", (q) => q.eq("orgId", args.orgId).eq("expenseId", args.expenseId))
      .first();
    if (recovery && recovery.status !== "REVERSED") {
      throw new ConvexError("Posted expenses cannot be deleted. Use a reversal workflow instead.");
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");

    // Defensive: a posted prepaid expense has accounting exposure and is blocked
    // above (reverseExpense handles it), so this only ever matches an
    // unposted/never-scheduled expense (no-op). Kept so a deleted expense can
    // never leave an ACTIVE schedule behind to keep amortizing.
    await cancelPrepaidScheduleForExpense(ctx, args.orgId, args.expenseId);

    await softDeleteExpenseRecord(ctx, {
      orgId: args.orgId,
      expenseId: args.expenseId,
      expense,
      deletedBy: identity.subject,
      now: Date.now(),
    });
  },
});

/**
 * Reverses a posted expense's accounting effect (a new offsetting journal
 * entry — the original stays in the ledger, marked REVERSED, for audit
 * purposes) and then soft-deletes the expense the same way remove() does.
 * This is the "reversal workflow" remove() points users at once an expense
 * has been posted to accounting and can no longer be deleted directly.
 */
export const reverseExpense = mutation({
  args: {
    orgId: v.id("organizations"),
    expenseId: v.id("expenses"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    // SCRUM-869#c23881: an expense the supplier owes the dealership for cannot be reversed during the pilot,
    // because that would cancel the supplier obligation. Read-only, tenant-scoped by the index, and before the
    // rate limiter and every write. Expenses with no live supplier recovery are unaffected.
    const liveRecovery = await ctx.db
      .query("supplierCostRecoveries")
      .withIndex("by_org_expense", (q) => q.eq("orgId", args.orgId).eq("expenseId", args.expenseId))
      .first();
    if (liveRecovery && liveRecovery.status !== "REVERSED") {
      assertSupplierSettlementDoorAllowed("SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED");
    }

    const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("A reason is required to reverse a posted expense.");

    const expense = await ctx.db.get(args.expenseId);
    if (!expense || expense.isDeleted || expense.orgId !== args.orgId) {
      throw new ConvexError("Expense not found.");
    }

    // SCRUM-389: a supplier-borne cost can be reversed only once nothing has
    // been recovered on it. Re-read here, inside this transaction; the recovery
    // row is patched below, so a concurrent receipt conflicts and serializes.
    const supplierRecovery = await assertSupplierCostExpenseReversible(ctx, args.orgId, args.expenseId);

    const now = Date.now();
    const postedEvent = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", args.orgId).eq("sourceType", "expenses").eq("sourceId", args.expenseId.toString())
      )
      .filter((q) => q.eq(q.field("eventType"), "EXPENSE_POSTED"))
      .first();

    // Whether this reversal unwound anything that had actually reached the
    // ledger. Only then does the expense keep a place in the operational P&L
    // (see the reversedAt patch below) — a reversal that cancelled nothing but
    // queued posts has no GL footprint to mirror.
    let reversedPostedGl = false;

    if (postedEvent) {
      // Actually posted to the ledger — create a real offsetting journal entry.
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: postedEvent._id,
        reversalDate: now,
        reason,
        actorId: user._id,
        idempotencyKey: `expense_reversed_${args.expenseId}`,
      });
      reversedPostedGl = true;
    } else {
      // No chart of accounts / open period existed when this expense was
      // marked paid, so it never actually posted — it's just queued. Nothing
      // was posted, so there's nothing to reverse; drop the queued post.
      const cancelled = await cancelPendingPostByKey(ctx, args.orgId, `expense_posted_${args.expenseId}`);
      if (!cancelled) {
        throw new ConvexError("This expense hasn't been posted to accounting — delete it directly instead.");
      }
    }

    // Prepaid expense: unwind the amortization half of the lifecycle too. This
    // reverses every asset→expense release already posted (and drops any queued
    // month) and stops future recognition, so together with the EXPENSE_POSTED
    // reversal above the whole schedule nets back to zero — no orphaned Prepaid
    // Expenses balance, no expense recognized for a reversed prepayment.
    const schedule = await cancelPrepaidScheduleForExpense(ctx, args.orgId, args.expenseId);
    if (schedule) {
      // A prepaid can have posted GL events even when EXPENSE_POSTED never
      // posted: an accelerated write-off posts as soon as its own date falls in
      // an open period, regardless of whether the expense behind it ever landed
      // (only amortization waits for that). Anything reversed here is ledger
      // history this expense still has to account for.
      const reversedAmortizations = await hookPrepaidExpenseAmortizationsReversed(ctx, {
        orgId: args.orgId,
        scheduleId: schedule,
        reason,
        actorId: user._id,
        reversalDate: now,
      });
      if (reversedAmortizations > 0) reversedPostedGl = true;
    }

    if (supplierRecovery) {
      await markSupplierCostRecoveryReversed(ctx, supplierRecovery, user._id, now);
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");

    // Stamp the reversal's accounting date before the soft delete: the same
    // `now` handed to reverseAccountingEvent above, so the operational P&L
    // credits this back in exactly the month the ledger's reversing entry
    // lands in. Deriving it from deletedAt instead would drift whenever the
    // two straddle a month boundary.
    //
    // Only when something actually posted. reversedAt is what keeps a
    // soft-deleted expense visible to the operational P&L (reports.ts), so
    // stamping it after merely cancelling a queued post would invent an
    // expense in the original month and a reversing credit in this one for a
    // ledger that holds neither — the report's own precondition is that an
    // expense which never posted carries no reversedAt. Left unstamped, the
    // soft delete takes it out of the report entirely, matching the GL's zero.
    if (reversedPostedGl) {
      await ctx.db.patch(args.expenseId, { reversedAt: now });
    }

    await softDeleteExpenseRecord(ctx, {
      orgId: args.orgId,
      expenseId: args.expenseId,
      expense,
      deletedBy: identity.subject,
      now,
    });
  },
});
