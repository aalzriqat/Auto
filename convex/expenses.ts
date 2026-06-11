import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { validateInput } from "./utils/validation";
import { CreateExpenseSchema, UpdateExpenseSchema } from "./validations/expenses";

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
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_EXPENSES]);

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
      status: args.status || "PAID",
      vendor: args.vendor,
      payerId: args.payerId,
      notes: args.notes,
    });

    // Log the transaction in the General Ledger
    await ctx.db.insert("transactions", {
      orgId: args.orgId,
      type: "OUT",
      amount: args.amount,
      date: args.date,
      category: "EXPENSE",
      description: `Expense: ${args.title} (${args.category})`,
      vehicleId: args.vehicleId,
      expenseId: id,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "New Expense Added",
      `${actorName} added a new expense: ${args.title} ($${args.amount})`,
      `/expenses?highlightId=${id}`
    );

    return id;
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
    const statusLimit = await rateLimiter.limit(ctx, "standardApi");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_EXPENSES]);

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

    const patch: Record<string, any> = {};

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

      const actorName = await getActorName(ctx);
      await notifyManagers(
        ctx,
        args.orgId,
        "Expense Updated",
        `${actorName} updated an expense record.`,
        `/expenses?highlightId=${args.expenseId}`
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
    const statusLimit = await rateLimiter.limit(ctx, "standardApi");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_EXPENSES]);

    const expense = await ctx.db.get(args.expenseId);
    if (!expense || expense.isDeleted || expense.orgId !== args.orgId) {
      throw new ConvexError("Expense not found.");
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    await ctx.db.patch(args.expenseId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "Expense Deleted",
      `${actorName} deleted expense: ${expense.title}`
    );
  },
});
