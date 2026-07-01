import { v, ConvexError } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { runWithIdempotency } from "./utils/idempotency";
import { Doc, Id } from "./_generated/dataModel";

type LedgerTransaction = Doc<"transactions">;
type DepositByTransactionId = Map<Id<"transactions">, Doc<"deposits"> | null>;

function vehicleLabel(vehicle: Doc<"vehicles">): string {
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim();
}

function customerName(customer: Doc<"customers">): string {
  return `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
}

function depositEventTime(deposit: Doc<"deposits">, transactionType: "IN" | "OUT"): number {
  return transactionType === "OUT" ? deposit.resolvedAt ?? deposit.createdAt : deposit.createdAt;
}

function matchingDeposit(
  transaction: LedgerTransaction,
  deposits: Array<Doc<"deposits">>
): Doc<"deposits"> | null {
  const candidates = deposits.filter((deposit) => {
    const sameAmount = deposit.amount === transaction.amount;
    const sameDirection = transaction.type === "IN" || deposit.status === "REFUNDED";
    const sameVehicle = !transaction.vehicleId || deposit.vehicleId === transaction.vehicleId;
    const quoteInDescription = transaction.description.includes(deposit.quoteId.toString());
    return sameAmount && sameDirection && (sameVehicle || quoteInDescription);
  });
  return candidates.sort((a, b) =>
    Math.abs(transaction.date - depositEventTime(a, transaction.type)) -
    Math.abs(transaction.date - depositEventTime(b, transaction.type))
  )[0] ?? null;
}

function matchDepositsToTransactions(
  transactions: LedgerTransaction[],
  deposits: Array<Doc<"deposits">>
): DepositByTransactionId {
  return new Map(
    transactions.map((transaction) => [
      transaction._id,
      matchingDeposit(transaction, deposits),
    ] as const)
  );
}

function vehicleIdsForLedgerRows(
  transactions: LedgerTransaction[],
  depositByTransactionId: DepositByTransactionId
): Array<Id<"vehicles">> {
  const vehicleIds = transactions.flatMap((transaction) =>
    transaction.vehicleId ? [transaction.vehicleId] : []
  );
  for (const deposit of depositByTransactionId.values()) {
    if (deposit) vehicleIds.push(deposit.vehicleId);
  }
  return vehicleIds;
}

function customerIdsForDeposits(
  depositByTransactionId: DepositByTransactionId
): Array<Id<"customers">> {
  return Array.from(depositByTransactionId.values())
    .flatMap((deposit) => deposit ? [deposit.customerId] : []);
}

function enrichLedgerTransaction(
  transaction: LedgerTransaction,
  deposit: Doc<"deposits"> | null,
  vehicles: Map<Id<"vehicles">, Doc<"vehicles">>,
  customers: Map<Id<"customers">, Doc<"customers">>
) {
  const vehicleId = transaction.vehicleId ?? deposit?.vehicleId;
  const vehicle = vehicleId ? vehicles.get(vehicleId) : null;
  const customer = deposit ? customers.get(deposit.customerId) : null;
  return {
    ...transaction,
    ...(vehicle ? { vehicleLabel: vehicleLabel(vehicle) } : {}),
    ...(customer ? { customerName: customerName(customer) } : {}),
    ...(deposit ? { quoteReference: deposit.quoteId.toString() } : {}),
  };
}

async function getRowsById<TTable extends "vehicles" | "customers">(
  ctx: QueryCtx,
  ids: Array<Id<TTable>>
): Promise<Map<Id<TTable>, Doc<TTable>>> {
  const uniqueIds = Array.from(new Set(ids));
  const docs = await Promise.all(uniqueIds.map((id) => ctx.db.get(id)));
  const pairs = docs.flatMap((doc) => doc ? [[doc._id, doc] as const] : []);
  return new Map(pairs);
}

async function enrichLedgerTransactions(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  rows: LedgerTransaction[]
) {
  const depositRows = rows.filter((row) => row.category === "DEPOSIT");
  const deposits = depositRows.length > 0
    ? await ctx.db.query("deposits").withIndex("by_org", (q) => q.eq("orgId", orgId)).order("desc").take(1000)
    : [];
  const depositByTransactionId = matchDepositsToTransactions(depositRows, deposits);
  const vehicleIds = vehicleIdsForLedgerRows(rows, depositByTransactionId);
  const customerIds = customerIdsForDeposits(depositByTransactionId);

  const [vehicles, customers] = await Promise.all([
    getRowsById(ctx, vehicleIds),
    getRowsById(ctx, customerIds),
  ]);

  return rows.map((row) => {
    const deposit = depositByTransactionId.get(row._id) ?? null;
    return enrichLedgerTransaction(row, deposit, vehicles, customers);
  });
}

export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const q = ctx.db
      .query("transactions")
      .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId))
      .order("desc");
    const pageResult = await q
      .filter((q) => {
        const notDeleted = q.neq(q.field("isDeleted"), true);
        if (args.startDate && args.endDate) {
          return q.and(
            notDeleted,
            q.gte(q.field("date"), args.startDate),
            q.lte(q.field("date"), args.endDate)
          );
        }
        return notDeleted;
      })
      .paginate(args.paginationOpts);

    const page = await enrichLedgerTransactions(ctx, args.orgId, pageResult.page);
    return { ...pageResult, page };
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    type: v.union(v.literal("IN"), v.literal("OUT")),
    amount: v.number(),
    date: v.number(),
    category: v.union(
      v.literal("VEHICLE_SALE"), v.literal("VEHICLE_PURCHASE"),
      v.literal("EXPENSE"), v.literal("DEPOSIT"),
      v.literal("COLLECTION_PAYMENT"), v.literal("REFUND"),
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    ),
    description: v.string(),
    vehicleId: v.optional(v.id("vehicles")),
    userId: v.optional(v.id("users")),
    expenseId: v.optional(v.id("expenses")),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "transactions.add",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        if (args.vehicleId) {
          const vehicle = await ctx.db.get(args.vehicleId);
          if (!vehicle || vehicle.orgId !== args.orgId) {
            throw new ConvexError("Vehicle not found in this organization.");
          }
        }
        if (args.expenseId) {
          const expense = await ctx.db.get(args.expenseId);
          if (!expense || expense.orgId !== args.orgId) {
            throw new ConvexError("Expense not found in this organization.");
          }
        }

        const transactionId = await ctx.db.insert("transactions", {
          orgId: args.orgId,
          type: args.type,
          amount: args.amount,
          date: args.date,
          category: args.category,
          description: args.description,
          vehicleId: args.vehicleId,
          userId: args.userId,
          expenseId: args.expenseId,
          idempotencyKey: args.idempotencyKey,
        });

        const actorName = await getActorName(ctx);
        await notifyManagers(
          ctx,
          args.orgId,
          "transaction.recorded",
          { actorName, amount: String(args.amount) },
          { link: `/${args.orgId}/accounting` }
        );

        return transactionId;
      }
    );
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    transactionId: v.id("transactions"),
    type: v.optional(v.union(v.literal("IN"), v.literal("OUT"))),
    amount: v.optional(v.number()),
    date: v.optional(v.number()),
    category: v.optional(v.union(
      v.literal("VEHICLE_SALE"), v.literal("VEHICLE_PURCHASE"),
      v.literal("EXPENSE"), v.literal("DEPOSIT"),
      v.literal("COLLECTION_PAYMENT"), v.literal("REFUND"),
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    )),
    description: v.optional(v.string()),
    vehicleId: v.optional(v.id("vehicles")),
    userId: v.optional(v.id("users")),
    expenseId: v.optional(v.id("expenses")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, transactionId, ...updates } = args;

    // Verify the transaction belongs to this org
    const transaction = await ctx.db.get(transactionId);
    if (!transaction || transaction.orgId !== orgId) {
      throw new ConvexError("Transaction not found in this organization.");
    }

    if (updates.vehicleId) {
      const vehicle = await ctx.db.get(updates.vehicleId);
      if (!vehicle || vehicle.orgId !== orgId) {
        throw new ConvexError("Vehicle not found in this organization.");
      }
    }
    if (updates.expenseId) {
      const expense = await ctx.db.get(updates.expenseId);
      if (!expense || expense.orgId !== orgId) {
        throw new ConvexError("Expense not found in this organization.");
      }
    }

    // Clean up undefined optional values
    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    await ctx.db.patch(transactionId, cleanedUpdates);

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      orgId,
      "transaction.updated",
      { actorName },
      { link: `/${orgId}/accounting` }
    );
  },
});

// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    transactionId: v.id("transactions"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const transaction = await ctx.db.get(args.transactionId);
    if (!transaction || transaction.orgId !== args.orgId) {
      throw new ConvexError("Transaction not found in this organization.");
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.transactionId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "transaction.removed",
      { actorName },
      { link: `/${args.orgId}/accounting` }
    );
  },
});
