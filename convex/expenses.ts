import { v, ConvexError } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { validateInput } from "./utils/validation";
import { CreateExpenseSchema, UpdateExpenseSchema } from "./validations/expenses";
import { checkTenantWriteLimit } from "./rateLimit";
import { runWithIdempotency } from "./utils/idempotency";
import { hookExpensePosted, getOrgCurrency } from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";

// ─── Validators ──────────────────────────────────────────────────────────────

const expenseCategory = v.union(
  v.literal("REPAIR"),
  v.literal("MAINTENANCE"),
  v.literal("DETAILING"),
  v.literal("TRANSPORT"),
  v.literal("MARKETING"),
  v.literal("OFFICE"),
  v.literal("SALARIES"),
  v.literal("RENT"),
  v.literal("UTILITIES"),
  v.literal("FEES"),
  v.literal("PREPAID"),
  v.literal("OTHER")
);

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

async function recordPaidExpenseSideEffects(
  ctx: MutationCtx,
  args: {
    expense: Doc<"expenses">;
    actorId: Id<"users">;
    idempotencyKey?: string;
  }
) {
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
    });
  }

  const currency = await getOrgCurrency(ctx, args.expense.orgId);
  await hookExpensePosted(ctx, {
    orgId: args.expense.orgId,
    expenseId: args.expense._id,
    amountMinor: toMinorUnits(args.expense.amount, currency),
    currency,
    category: args.expense.category,
    actorId: args.actorId,
    occurredAt: args.expense.date,
  });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

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

    // Hydrate vehicle info
    const page = await Promise.all(
      pageResult.page.map(async (exp) => {
        let vehicle = null;
        if (exp.vehicleId) {
          vehicle = await ctx.db.get(exp.vehicleId);
        }
        let payerName = null;
        if (exp.payerId) {
          const payer = await ctx.db.get(exp.payerId);
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

    return expenses.reduce((sum, e) => sum + e.amount, 0);
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a new expense record.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")),
    title: v.string(),
    amount: v.number(),
    date: v.number(),
    category: expenseCategory,
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"))),
    vendor: v.optional(v.string()),
    payerId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_EXPENSES]);
    const status = args.status ?? "PAID";

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "expenses.create",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          vehicleId: args.vehicleId ?? null,
          title: args.title,
          amount: args.amount,
          date: args.date,
          category: args.category,
          status,
          vendor: args.vendor ?? null,
          payerId: args.payerId ?? null,
          notes: args.notes ?? null,
        }),
      },
      async () => {
        validateInput(CreateExpenseSchema, args);

        if (args.vehicleId) {
          const vehicle = await ctx.db.get(args.vehicleId);
          if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
            throw new ConvexError("Vehicle not found in this organization.");
          }
        }

        const id = await ctx.db.insert("expenses", {
          orgId: args.orgId,
          vehicleId: args.vehicleId,
          title: args.title,
          amount: args.amount,
          date: args.date,
          category: args.category,
          status,
          idempotencyKey: args.idempotencyKey,
          vendor: args.vendor,
          payerId: args.payerId,
          notes: args.notes,
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
    date: v.optional(v.number()),
    category: v.optional(expenseCategory),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"))),
    vendor: v.optional(v.string()),
    payerId: v.optional(v.union(v.id("users"), v.null())),
    notes: v.optional(v.string()),
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

    validateInput(UpdateExpenseSchema, argsToValidate);

    const expense = await ctx.db.get(args.expenseId);
    if (!expense || expense.isDeleted || expense.orgId !== args.orgId) {
      throw new ConvexError("Expense not found.");
    }

    const currentStatus = expense.status ?? "PAID";
    const nextStatus = args.status ?? currentStatus;
    const willMarkPaid = currentStatus === "PENDING" && nextStatus === "PAID";
    const hasAccountingExposure = await hasExpenseAccountingExposure(ctx, args.orgId, args.expenseId);
    const hasMaterialAccountingChange =
      (args.vehicleId !== undefined && args.vehicleId !== (expense.vehicleId ?? null)) ||
      (args.title !== undefined && args.title !== expense.title) ||
      (args.amount !== undefined && args.amount !== expense.amount) ||
      (args.date !== undefined && args.date !== expense.date) ||
      (args.category !== undefined && args.category !== expense.category) ||
      (args.status !== undefined && args.status !== currentStatus);
    if (hasAccountingExposure && hasMaterialAccountingChange) {
      throw new ConvexError(
        "Posted expenses are locked. Use a correction or reversal workflow before changing accounting fields."
      );
    }

    const patch: Record<string, unknown> = {};

    if (args.vehicleId !== undefined) {
      if (args.vehicleId !== null) {
        const vehicle = await ctx.db.get(args.vehicleId);
        if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
          throw new ConvexError("Vehicle not found in this organization.");
        }
      }
      patch.vehicleId = args.vehicleId === null ? undefined : args.vehicleId;
    }

    if (args.title !== undefined) patch.title = args.title;
    if (args.amount !== undefined) patch.amount = args.amount;
    if (args.date !== undefined) patch.date = args.date;
    if (args.category !== undefined) patch.category = args.category;
    if (args.status !== undefined) patch.status = args.status;
    if (args.vendor !== undefined) patch.vendor = args.vendor;
    if (args.payerId !== undefined) {
      patch.payerId = args.payerId === null ? undefined : args.payerId;
    }
    if (args.notes !== undefined) patch.notes = args.notes;

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
 * Deletes an expense.
 */
// TODO: Add admin recovery endpoint if needed
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

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    const now = Date.now();
    await ctx.db.patch(args.expenseId, {
      isDeleted: true,
      deletedAt: now,
      deletedBy: identity.subject
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
        deletedAt: now,
        deletedBy: identity.subject,
      });
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "expense.deleted",
      { actorName, expenseTitle: expense.title }
    );
  },
});
