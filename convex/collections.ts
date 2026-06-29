import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  QueryCtx,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getActorName, notifyManagers, notifyUser } from "./utils/notifications";
import { runWithIdempotency } from "./utils/idempotency";
import { assertDifferentActors } from "./utils/financialGuards";
import { hookCollectionPayment, getOrgCurrency } from "./accounting/workflowHooks";
import { reverseAccountingEvent } from "./accounting/reversals";
import { toMinorUnits } from "./utils/money";

const receivableStatusValidator = v.union(
  v.literal("OPEN"),
  v.literal("PARTIALLY_PAID"),
  v.literal("PAID"),
  v.literal("OVERDUE"),
  v.literal("RESCHEDULED"),
  v.literal("CANCELLED"),
  v.literal("REFUNDED")
);

const receivableSourceValidator = v.union(
  v.literal("CUSTOMER_DEPOSIT"),
  v.literal("RESERVATION_PAYMENT"),
  v.literal("INTERNAL_INSTALLMENT"),
  v.literal("BANK_FINANCED_BALANCE"),
  v.literal("BANK_TRANSFER"),
  v.literal("PAYMENT_LINK"),
  v.literal("CHEQUE"),
  v.literal("OTHER")
);

const paymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("BANK_TRANSFER"),
  v.literal("CHEQUE"),
  v.literal("PAYMENT_LINK"),
  v.literal("CARD"),
  v.literal("DEPOSIT_APPLIED"),
  v.literal("REFUND"),
  v.literal("OTHER")
);

const chequeStatusValidator = v.union(
  v.literal("HELD"),
  v.literal("DEPOSITED"),
  v.literal("CLEARED"),
  v.literal("RETURNED"),
  v.literal("REPLACED"),
  v.literal("CANCELLED")
);

const approvalRequestTypeValidator = v.union(
  v.literal("REFUND"),
  v.literal("RESCHEDULE"),
  v.literal("CANCEL_RECEIVABLE")
);

type ReceivableStatus = Doc<"receivables">["status"];
type ReceivablePatch = Partial<Pick<Doc<"receivables">, "outstandingAmount" | "status" | "lastPaymentAt" | "updatedAt" | "dueDate" | "notes">>;
type ReminderMessageType = Doc<"collectionReminders">["messageType"];
type ReminderChannel = Doc<"collectionReminders">["channel"];

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_COOLDOWN_MS = 20 * 60 * 60 * 1000;

function assertPositiveAmount(amount: number, label = "Amount") {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ConvexError(`${label} must be greater than 0.`);
  }
}

function roundMoney(amount: number) {
  return Math.round(amount * 100) / 100;
}

function dayRange(timestamp: number) {
  const start = new Date(timestamp);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start: start.getTime(), end: end.getTime() };
}

function addMonths(timestamp: number, months: number) {
  const date = new Date(timestamp);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

function nextStatus(outstandingAmount: number, dueDate: number, now = Date.now()): ReceivableStatus {
  if (outstandingAmount <= 0) return "PAID";
  if (dueDate < now) return "OVERDUE";
  return "PARTIALLY_PAID";
}

function customerName(customer: Doc<"customers"> | null) {
  if (!customer) return "Unknown customer";
  return `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Unknown customer";
}

function vehicleLabel(vehicle: Doc<"vehicles"> | null | undefined) {
  if (!vehicle) return undefined;
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim();
}

async function getOptionalVehicle(ctx: QueryCtx | MutationCtx, vehicleId?: Id<"vehicles">) {
  return vehicleId ? await ctx.db.get(vehicleId) : null;
}

async function validateOrgCustomer(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, customerId: Id<"customers">) {
  const customer = await ctx.db.get(customerId);
  if (!customer || customer.orgId !== orgId) {
    throw new ConvexError("Customer not found in this organization.");
  }
  return customer;
}

async function validateOptionalLinks(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  links: {
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    quoteId?: Id<"quotes">;
    applicationId?: Id<"financeApplications">;
    assignedTo?: Id<"users">;
  }
) {
  if (links.vehicleId) {
    const vehicle = await ctx.db.get(links.vehicleId);
    if (!vehicle || vehicle.orgId !== orgId) throw new ConvexError("Vehicle not found in this organization.");
  }
  if (links.saleId) {
    const sale = await ctx.db.get(links.saleId);
    if (!sale || sale.orgId !== orgId) throw new ConvexError("Sale not found in this organization.");
  }
  if (links.quoteId) {
    const quote = await ctx.db.get(links.quoteId);
    if (!quote || quote.orgId !== orgId) throw new ConvexError("Quote not found in this organization.");
  }
  if (links.applicationId) {
    const app = await ctx.db.get(links.applicationId);
    if (!app || app.orgId !== orgId) throw new ConvexError("Finance application not found in this organization.");
  }
  if (links.assignedTo) {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", links.assignedTo!))
      .unique();
    if (!membership) throw new ConvexError("Assigned user is not a member of this organization.");
  }
}

async function hydrateReceivable(ctx: QueryCtx, receivable: Doc<"receivables">) {
  const [customer, vehicle] = await Promise.all([
    ctx.db.get(receivable.customerId),
    getOptionalVehicle(ctx, receivable.vehicleId),
  ]);
  return {
    ...receivable,
    customerName: customerName(customer),
    vehicleLabel: vehicleLabel(vehicle),
  };
}

async function hydrateCheque(ctx: QueryCtx, cheque: Doc<"postDatedCheques">) {
  const [customer, vehicle, receivable] = await Promise.all([
    ctx.db.get(cheque.customerId),
    getOptionalVehicle(ctx, cheque.vehicleId),
    cheque.receivableId ? ctx.db.get(cheque.receivableId) : null,
  ]);
  return {
    ...cheque,
    customerName: customerName(customer),
    vehicleLabel: vehicleLabel(vehicle),
    receivableTitle: receivable?.title,
  };
}

async function hydratePayment(ctx: QueryCtx, payment: Doc<"collectionPayments">) {
  const [customer, vehicle, receivable] = await Promise.all([
    ctx.db.get(payment.customerId),
    getOptionalVehicle(ctx, payment.vehicleId),
    payment.receivableId ? ctx.db.get(payment.receivableId) : null,
  ]);
  return {
    ...payment,
    customerName: customerName(customer),
    vehicleLabel: vehicleLabel(vehicle),
    receivableTitle: receivable?.title,
  };
}

async function applyPostedPayment(
  ctx: MutationCtx,
  receivable: Doc<"receivables">,
  amount: number,
  paymentDate: number
) {
  const outstandingAmount = roundMoney(Math.max(0, receivable.outstandingAmount - amount));
  const patch: ReceivablePatch = {
    outstandingAmount,
    status: nextStatus(outstandingAmount, receivable.dueDate),
    lastPaymentAt: paymentDate,
    updatedAt: Date.now(),
  };
  await ctx.db.patch(receivable._id, patch);
}

async function insertLedgerTransaction(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    direction: "IN" | "OUT";
    amount: number;
    date: number;
    description: string;
    vehicleId?: Id<"vehicles">;
    userId?: Id<"users">;
    category: "COLLECTION_PAYMENT" | "REFUND";
    idempotencyKey?: string;
  }
) {
  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: args.direction,
    amount: args.amount,
    date: args.date,
    category: args.category,
    description: args.description,
    vehicleId: args.vehicleId,
    userId: args.userId,
    idempotencyKey: args.idempotencyKey,
  });
}

export const summary = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const now = Date.now();
    const today = dayRange(now);
    const openStatuses: ReceivableStatus[] = ["OPEN", "PARTIALLY_PAID", "OVERDUE", "RESCHEDULED"];
    let totalOutstanding = 0;
    let overdueOutstanding = 0;
    let dueToday = 0;

    for (const status of openStatuses) {
      const rows = await ctx.db
        .query("receivables")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .take(500);
      for (const row of rows) {
        totalOutstanding += row.outstandingAmount;
        if (row.dueDate < now || row.status === "OVERDUE") overdueOutstanding += row.outstandingAmount;
        if (row.dueDate >= today.start && row.dueDate <= today.end) dueToday += row.outstandingAmount;
      }
    }

    const todaysPayments = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_paymentDate", (q) => q.eq("orgId", args.orgId).gte("paymentDate", today.start))
      .take(500);
    const collectedToday = todaysPayments
      .filter((payment) => payment.paymentDate <= today.end && payment.status === "POSTED")
      .reduce((sum, payment) => sum + (payment.direction === "IN" ? payment.amount : -payment.amount), 0);

    const upcomingCheques = await ctx.db
      .query("postDatedCheques")
      .withIndex("by_org_chequeDate", (q) => q.eq("orgId", args.orgId).gte("chequeDate", now))
      .take(200);
    const upcomingChequesThisWeek = upcomingCheques
      .filter((cheque) => cheque.chequeDate <= now + 7 * DAY_MS && (cheque.status === "HELD" || cheque.status === "DEPOSITED"));
    const upcomingChequeTotal = upcomingChequesThisWeek.reduce((sum, cheque) => sum + cheque.amount, 0);

    return {
      totalOutstanding: roundMoney(totalOutstanding),
      overdueOutstanding: roundMoney(overdueOutstanding),
      dueToday: roundMoney(dueToday),
      collectedToday: roundMoney(collectedToday),
      upcomingChequeTotal: roundMoney(upcomingChequeTotal),
      upcomingChequeCount: upcomingChequesThisWeek.length,
    };
  },
});

export const listReceivables = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    status: v.optional(receivableStatusValidator),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const result = args.status
      ? await ctx.db
          .query("receivables")
          .withIndex("by_org_status_and_dueDate", (q) =>
            q.eq("orgId", args.orgId).eq("status", args.status!)
          )
          .order("asc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("receivables")
          .withIndex("by_org_dueDate", (q) => q.eq("orgId", args.orgId))
          .order("asc")
          .paginate(args.paginationOpts);

    return {
      ...result,
      page: await Promise.all(result.page.map((row) => hydrateReceivable(ctx, row))),
    };
  },
});

export const listCheques = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    status: v.optional(chequeStatusValidator),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const result = args.status
      ? await ctx.db
          .query("postDatedCheques")
          .withIndex("by_org_status_and_chequeDate", (q) =>
            q.eq("orgId", args.orgId).eq("status", args.status!)
          )
          .order("asc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("postDatedCheques")
          .withIndex("by_org_chequeDate", (q) => q.eq("orgId", args.orgId))
          .order("asc")
          .paginate(args.paginationOpts);

    return {
      ...result,
      page: await Promise.all(result.page.map((row) => hydrateCheque(ctx, row))),
    };
  },
});

export const listPayments = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const result = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_paymentDate", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: await Promise.all(result.page.map((row) => hydratePayment(ctx, row))),
    };
  },
});

export const createReceivable = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    quoteId: v.optional(v.id("quotes")),
    applicationId: v.optional(v.id("financeApplications")),
    assignedTo: v.optional(v.id("users")),
    sourceType: receivableSourceValidator,
    title: v.string(),
    amount: v.number(),
    dueDate: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    assertPositiveAmount(args.amount);
    if (!args.title.trim()) throw new ConvexError("Receivable title is required.");

    await validateOrgCustomer(ctx, args.orgId, args.customerId);
    await validateOptionalLinks(ctx, args.orgId, args);

    const now = Date.now();
    const receivableId = await ctx.db.insert("receivables", {
      orgId: args.orgId,
      branchId: membership.branchId,
      customerId: args.customerId,
      vehicleId: args.vehicleId,
      saleId: args.saleId,
      quoteId: args.quoteId,
      applicationId: args.applicationId,
      assignedTo: args.assignedTo,
      sourceType: args.sourceType,
      title: args.title.trim(),
      originalAmount: roundMoney(args.amount),
      outstandingAmount: roundMoney(args.amount),
      dueDate: args.dueDate,
      status: args.dueDate < now ? "OVERDUE" : "OPEN",
      notes: args.notes,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "collection.receivable_created", {
      actorName,
      amount: String(roundMoney(args.amount)),
    }, { link: `/${args.orgId}/accounting` });

    return receivableId;
  },
});

export const createInstallmentPlan = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    quoteId: v.optional(v.id("quotes")),
    applicationId: v.optional(v.id("financeApplications")),
    assignedTo: v.optional(v.id("users")),
    title: v.string(),
    totalAmount: v.number(),
    installmentCount: v.number(),
    firstDueDate: v.number(),
    intervalMonths: v.optional(v.number()),
    sourceType: v.optional(receivableSourceValidator),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    assertPositiveAmount(args.totalAmount, "Total amount");
    if (!Number.isInteger(args.installmentCount) || args.installmentCount < 1 || args.installmentCount > 120) {
      throw new ConvexError("Installment count must be between 1 and 120.");
    }
    const intervalMonths = args.intervalMonths ?? 1;
    if (!Number.isInteger(intervalMonths) || intervalMonths < 1 || intervalMonths > 12) {
      throw new ConvexError("Installment interval must be between 1 and 12 months.");
    }
    if (!args.title.trim()) throw new ConvexError("Payment plan title is required.");

    await validateOrgCustomer(ctx, args.orgId, args.customerId);
    await validateOptionalLinks(ctx, args.orgId, args);

    const now = Date.now();
    const baseAmount = roundMoney(args.totalAmount / args.installmentCount);
    let allocated = 0;
    const ids: Id<"receivables">[] = [];

    for (let i = 1; i <= args.installmentCount; i++) {
      const amount = i === args.installmentCount
        ? roundMoney(args.totalAmount - allocated)
        : baseAmount;
      allocated = roundMoney(allocated + amount);
      const dueDate = addMonths(args.firstDueDate, (i - 1) * intervalMonths);
      const id = await ctx.db.insert("receivables", {
        orgId: args.orgId,
        branchId: membership.branchId,
        customerId: args.customerId,
        vehicleId: args.vehicleId,
        saleId: args.saleId,
        quoteId: args.quoteId,
        applicationId: args.applicationId,
        assignedTo: args.assignedTo,
        sourceType: args.sourceType ?? "INTERNAL_INSTALLMENT",
        title: `${args.title.trim()} #${i}`,
        originalAmount: amount,
        outstandingAmount: amount,
        dueDate,
        status: dueDate < now ? "OVERDUE" : "OPEN",
        installmentNumber: i,
        totalInstallments: args.installmentCount,
        paymentPlanLabel: args.title.trim(),
        notes: args.notes,
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      });
      ids.push(id);
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "collection.plan_created", {
      actorName,
      amount: String(roundMoney(args.totalAmount)),
    }, { link: `/${args.orgId}/accounting` });

    return ids;
  },
});

export const recordPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.optional(v.id("customers")),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    amount: v.number(),
    method: paymentMethodValidator,
    paymentDate: v.number(),
    reference: v.optional(v.string()),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.recordPayment",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        assertPositiveAmount(args.amount);
        if (args.method === "REFUND") throw new ConvexError("Refunds require manager approval.");

        let receivable: Doc<"receivables"> | null = null;
        if (args.receivableId) {
          receivable = await ctx.db.get(args.receivableId);
          if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
          if (["PAID", "CANCELLED", "REFUNDED"].includes(receivable.status)) {
            throw new ConvexError("This receivable can no longer accept payments.");
          }
          if (args.amount > receivable.outstandingAmount) {
            throw new ConvexError("Payment amount cannot exceed the outstanding receivable amount.");
          }
        }

        const customerId = receivable?.customerId ?? args.customerId;
        if (!customerId) throw new ConvexError("Customer is required when no receivable is selected.");
        await validateOrgCustomer(ctx, args.orgId, customerId);

        const vehicleId = receivable?.vehicleId ?? args.vehicleId;
        const saleId = receivable?.saleId ?? args.saleId;
        await validateOptionalLinks(ctx, args.orgId, { vehicleId, saleId });

        const now = Date.now();
        const paymentId = await ctx.db.insert("collectionPayments", {
          orgId: args.orgId,
          branchId: membership.branchId,
          receivableId: receivable?._id,
          customerId,
          vehicleId,
          saleId,
          direction: "IN",
          method: args.method,
          amount: roundMoney(args.amount),
          paymentDate: args.paymentDate,
          status: "POSTED",
          idempotencyKey: args.idempotencyKey,
          reference: args.reference,
          cashierId: user._id,
          notes: args.notes,
          createdAt: now,
        });

        if (receivable) {
          await applyPostedPayment(ctx, receivable, args.amount, args.paymentDate);
        }

        await insertLedgerTransaction(ctx, {
          orgId: args.orgId,
          direction: "IN",
          amount: roundMoney(args.amount),
          date: args.paymentDate,
          description: `Collection payment${receivable ? ` for ${receivable.title}` : ""}`,
          vehicleId,
          userId: user._id,
          category: "COLLECTION_PAYMENT",
          idempotencyKey: args.idempotencyKey,
        });

        const currency = await getOrgCurrency(ctx, args.orgId);
        await hookCollectionPayment(ctx, {
          orgId: args.orgId,
          paymentId,
          customerId,
          amountMinor: toMinorUnits(roundMoney(args.amount), currency),
          currency,
          paymentMethod: args.method,
          actorId: user._id,
          occurredAt: args.paymentDate,
        });

        const actorName = await getActorName(ctx);
        await notifyManagers(ctx, args.orgId, "collection.payment_recorded", {
          actorName,
          amount: String(roundMoney(args.amount)),
        }, { link: `/${args.orgId}/accounting` });

        return paymentId;
      }
    );
  },
});

export const registerCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    bank: v.string(),
    chequeNumber: v.string(),
    chequeDate: v.number(),
    amount: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    assertPositiveAmount(args.amount);
    if (!args.bank.trim() || !args.chequeNumber.trim()) {
      throw new ConvexError("Bank and cheque number are required.");
    }

    await validateOrgCustomer(ctx, args.orgId, args.customerId);
    await validateOptionalLinks(ctx, args.orgId, { vehicleId: args.vehicleId, saleId: args.saleId });

    let receivable: Doc<"receivables"> | null = null;
    if (args.receivableId) {
      receivable = await ctx.db.get(args.receivableId);
      if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
      if (receivable.customerId !== args.customerId) throw new ConvexError("Cheque customer must match receivable customer.");
    }

    const duplicate = await ctx.db
      .query("postDatedCheques")
      .withIndex("by_org_bank_and_chequeNumber", (q) =>
        q.eq("orgId", args.orgId).eq("bank", args.bank.trim()).eq("chequeNumber", args.chequeNumber.trim())
      )
      .first();
    if (duplicate && !duplicate.isDeleted && duplicate.status !== "CANCELLED") {
      throw new ConvexError("A cheque with this bank and number already exists.");
    }

    const now = Date.now();
    return await ctx.db.insert("postDatedCheques", {
      orgId: args.orgId,
      branchId: membership.branchId,
      receivableId: receivable?._id,
      customerId: args.customerId,
      vehicleId: receivable?.vehicleId ?? args.vehicleId,
      saleId: receivable?.saleId ?? args.saleId,
      bank: args.bank.trim(),
      chequeNumber: args.chequeNumber.trim(),
      chequeDate: args.chequeDate,
      amount: roundMoney(args.amount),
      status: "HELD",
      notes: args.notes,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const depositCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    depositedDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const cheque = await ctx.db.get(args.chequeId);
    if (!cheque || cheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
    if (cheque.status !== "HELD") throw new ConvexError("Only held cheques can be deposited.");
    await ctx.db.patch(args.chequeId, {
      status: "DEPOSITED",
      depositedDate: args.depositedDate ?? Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const clearCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    clearedAt: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.clearCheque",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        const cheque = await ctx.db.get(args.chequeId);
        if (!cheque || cheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
        if (cheque.status !== "HELD" && cheque.status !== "DEPOSITED") {
          throw new ConvexError("Only held or deposited cheques can be cleared.");
        }

        const clearedAt = args.clearedAt ?? Date.now();
        await ctx.db.patch(args.chequeId, {
          status: "CLEARED",
          clearedAt,
          depositedDate: cheque.depositedDate ?? clearedAt,
          idempotencyKey: args.idempotencyKey,
          updatedAt: Date.now(),
        });

        let receivable: Doc<"receivables"> | null = null;
        if (cheque.receivableId) {
          receivable = await ctx.db.get(cheque.receivableId);
          if (receivable && cheque.amount > receivable.outstandingAmount) {
            throw new ConvexError("Cheque amount cannot exceed the outstanding receivable amount.");
          }
        }

        const paymentId = await ctx.db.insert("collectionPayments", {
          orgId: args.orgId,
          branchId: membership.branchId,
          receivableId: cheque.receivableId,
          customerId: cheque.customerId,
          vehicleId: cheque.vehicleId,
          saleId: cheque.saleId,
          chequeId: args.chequeId,
          direction: "IN",
          method: "CHEQUE",
          amount: cheque.amount,
          paymentDate: clearedAt,
          status: "POSTED",
          idempotencyKey: args.idempotencyKey,
          reference: `${cheque.bank} #${cheque.chequeNumber}`,
          cashierId: user._id,
          createdAt: Date.now(),
        });

        if (receivable) {
          await applyPostedPayment(ctx, receivable, cheque.amount, clearedAt);
        }

        await insertLedgerTransaction(ctx, {
          orgId: args.orgId,
          direction: "IN",
          amount: cheque.amount,
          date: clearedAt,
          description: `Cleared cheque ${cheque.bank} #${cheque.chequeNumber}`,
          vehicleId: cheque.vehicleId,
          userId: user._id,
          category: "COLLECTION_PAYMENT",
          idempotencyKey: args.idempotencyKey,
        });

        return paymentId;
      }
    );
  },
});

export const returnCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    returnedAt: v.optional(v.number()),
    returnReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const cheque = await ctx.db.get(args.chequeId);
    if (!cheque || cheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
    if (cheque.status === "CLEARED" || cheque.status === "REPLACED" || cheque.status === "CANCELLED") {
      throw new ConvexError("This cheque can no longer be returned.");
    }

    await ctx.db.patch(args.chequeId, {
      status: "RETURNED",
      returnedAt: args.returnedAt ?? Date.now(),
      returnReason: args.returnReason,
      updatedAt: Date.now(),
    });

    if (cheque.receivableId) {
      const receivable = await ctx.db.get(cheque.receivableId);
      if (receivable && receivable.status !== "PAID") {
        await ctx.db.patch(receivable._id, { status: "OVERDUE", updatedAt: Date.now() });
        await queueCustomerReminder(ctx, {
          orgId: args.orgId,
          customerId: cheque.customerId,
          receivableId: receivable._id,
          chequeId: cheque._id,
          messageType: "CHEQUE_RETURNED",
        });
      }
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "collection.cheque_returned", {
      actorName,
      amount: String(cheque.amount),
    }, { link: `/${args.orgId}/accounting` });
  },
});

export const replaceCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    bank: v.string(),
    chequeNumber: v.string(),
    chequeDate: v.number(),
    amount: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    assertPositiveAmount(args.amount);
    const oldCheque = await ctx.db.get(args.chequeId);
    if (!oldCheque || oldCheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
    if (oldCheque.status === "CLEARED" || oldCheque.status === "CANCELLED") {
      throw new ConvexError("Cleared or cancelled cheques cannot be replaced.");
    }

    const now = Date.now();
    const newChequeId = await ctx.db.insert("postDatedCheques", {
      orgId: args.orgId,
      branchId: membership.branchId,
      receivableId: oldCheque.receivableId,
      customerId: oldCheque.customerId,
      vehicleId: oldCheque.vehicleId,
      saleId: oldCheque.saleId,
      bank: args.bank.trim(),
      chequeNumber: args.chequeNumber.trim(),
      chequeDate: args.chequeDate,
      amount: roundMoney(args.amount),
      status: "HELD",
      notes: args.notes,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(args.chequeId, {
      status: "REPLACED",
      replacementChequeId: newChequeId,
      updatedAt: now,
    });

    return newChequeId;
  },
});

/**
 * Returns a cheque that has already been CLEARED by the bank.
 * Reverses the original clearing accounting event, reopens the receivable
 * balance, and optionally records a bank return fee.
 */
export const returnClearedCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    returnReason: v.optional(v.string()),
    bankFeeMinor: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.returnClearedCheque",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        const cheque = await ctx.db.get(args.chequeId);
        if (!cheque || cheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
        if (cheque.status !== "CLEARED") {
          throw new ConvexError("Only cleared cheques can be returned after clearing.");
        }

        const now = Date.now();

        // Find the collection payment created when this cheque cleared
        const clearedPayment = await ctx.db
          .query("collectionPayments")
          .withIndex("by_cheque", (q) => q.eq("chequeId", args.chequeId))
          .filter((q) => q.eq(q.field("status"), "POSTED"))
          .first();

        // Find and reverse the accounting event for the clearing
        if (clearedPayment) {
          const clearingEvent = await ctx.db
            .query("accountingEvents")
            .withIndex("by_org_source", (q) =>
              q.eq("orgId", args.orgId)
                .eq("sourceType", "collectionPayments")
                .eq("sourceId", clearedPayment._id.toString())
            )
            .filter((q) => q.eq(q.field("status"), "POSTED"))
            .first();

          if (clearingEvent) {
            await reverseAccountingEvent(ctx, {
              orgId: args.orgId,
              originalEventId: clearingEvent._id,
              reversalDate: now,
              reason: args.returnReason ?? "Cheque returned after clearing",
              actorId: user._id,
              idempotencyKey: `cheque_return_after_clear_${args.chequeId}`,
            });
          }

          // Mark the payment as voided
          await ctx.db.patch(clearedPayment._id, { status: "VOIDED" });
        }

        // Reopen the linked legacy receivable
        if (cheque.receivableId) {
          const receivable = await ctx.db.get(cheque.receivableId);
          if (receivable) {
            await ctx.db.patch(receivable._id, {
              outstandingAmount: (receivable.outstandingAmount ?? 0) + cheque.amount,
              status: "OVERDUE",
              updatedAt: now,
            });
          }
        }

        // Post bank fee as expense if provided
        if (args.bankFeeMinor && args.bankFeeMinor > 0) {
          const currency = await getOrgCurrency(ctx, args.orgId);
          const feeAmount = args.bankFeeMinor / Math.pow(10, currency === "JOD" ? 3 : 2);
          const feeExpenseId = await ctx.db.insert("expenses", {
            orgId: args.orgId,
            title: `Bank return fee — cheque ${cheque.bank} #${cheque.chequeNumber}`,
            amount: feeAmount,
            date: now,
            category: "FEES",
            status: "PAID",
          });
          await ctx.db.insert("transactions", {
            orgId: args.orgId,
            type: "OUT",
            amount: feeAmount,
            date: now,
            category: "EXPENSE",
            description: `Bank return fee — cheque ${cheque.bank} #${cheque.chequeNumber}`,
            expenseId: feeExpenseId,
          });
        }

        // Mark cheque as RETURNED (after clearing)
        await ctx.db.patch(args.chequeId, {
          status: "RETURNED",
          returnedAt: now,
          returnReason: args.returnReason,
          returnedAfterClearing: true,
          bankFeeMinor: args.bankFeeMinor,
          updatedAt: now,
        });

        const actorName = await getActorName(ctx);
        await notifyManagers(ctx, args.orgId, "collection.cheque_returned_after_clearing", {
          actorName,
          amount: String(cheque.amount),
          bank: cheque.bank,
          chequeNumber: cheque.chequeNumber,
        }, { link: `/${args.orgId}/accounting` });
      }
    );
  },
});

export const requestApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.id("receivables"),
    requestType: approvalRequestTypeValidator,
    requestedAmount: v.optional(v.number()),
    requestedDueDate: v.optional(v.number()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const receivable = await ctx.db.get(args.receivableId);
    if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
    if (!args.reason.trim()) throw new ConvexError("Reason is required.");
    if (args.requestType === "REFUND") assertPositiveAmount(args.requestedAmount ?? 0, "Refund amount");
    if (args.requestType === "RESCHEDULE" && !args.requestedDueDate) {
      throw new ConvexError("New due date is required for reschedule requests.");
    }

    const existing = await ctx.db
      .query("collectionApprovalRequests")
      .withIndex("by_receivable", (q) => q.eq("receivableId", args.receivableId))
      .collect();
    if (existing.some((request) => request.status === "PENDING" && request.requestType === args.requestType)) {
      throw new ConvexError("A pending request of this type already exists.");
    }

    const now = Date.now();
    const requestId = await ctx.db.insert("collectionApprovalRequests", {
      orgId: args.orgId,
      receivableId: args.receivableId,
      customerId: receivable.customerId,
      requestedBy: user._id,
      requestType: args.requestType,
      status: "PENDING",
      requestedAmount: args.requestedAmount ? roundMoney(args.requestedAmount) : undefined,
      requestedDueDate: args.requestedDueDate,
      reason: args.reason.trim(),
      createdAt: now,
      updatedAt: now,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "collection.approval_requested", {
      actorName,
      amount: String(args.requestedAmount ?? receivable.outstandingAmount),
    }, { link: `/${args.orgId}/accounting` });

    return requestId;
  },
});

export const listApprovals = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED"))),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const status = args.status ?? "PENDING";
    const requests = await ctx.db
      .query("collectionApprovalRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
      .order("desc")
      .take(100);

    return await Promise.all(requests.map(async (request) => {
      const [receivable, customer, requester] = await Promise.all([
        ctx.db.get(request.receivableId),
        ctx.db.get(request.customerId),
        ctx.db.get(request.requestedBy),
      ]);
      return {
        ...request,
        receivableTitle: receivable?.title ?? "Receivable",
        customerName: customerName(customer),
        requestedByName: requester?.name ?? requester?.email ?? "Unknown",
      };
    }));
  },
});

export const respondToApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("collectionApprovalRequests"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
    decisionNotes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.respondToApproval",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        const request = await ctx.db.get(args.requestId);
        if (!request || request.orgId !== args.orgId) throw new ConvexError("Approval request not found.");
        if (request.status !== "PENDING") throw new ConvexError("This request has already been resolved.");
        assertDifferentActors(
          user._id,
          request.requestedBy,
          "Requester cannot approve or reject their own collection approval request."
        );

        const receivable = await ctx.db.get(request.receivableId);
        if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");

        const now = Date.now();
        await ctx.db.patch(args.requestId, {
          status: args.status,
          decisionNotes: args.decisionNotes,
          decidedBy: user._id,
          decidedAt: now,
          responseIdempotencyKey: args.idempotencyKey,
          updatedAt: now,
        });

        if (args.status === "APPROVED") {
          if (request.requestType === "RESCHEDULE") {
            if (!request.requestedDueDate) throw new ConvexError("Requested due date is missing.");
            await ctx.db.patch(receivable._id, {
              dueDate: request.requestedDueDate,
              status: request.requestedDueDate < now ? "OVERDUE" : "RESCHEDULED",
              updatedAt: now,
            });
          } else if (request.requestType === "CANCEL_RECEIVABLE") {
            await ctx.db.patch(receivable._id, {
              outstandingAmount: 0,
              status: "CANCELLED",
              updatedAt: now,
            });
          } else if (request.requestType === "REFUND") {
            const refundAmount = roundMoney(request.requestedAmount ?? 0);
            assertPositiveAmount(refundAmount, "Refund amount");
            const paidAmount = roundMoney(receivable.originalAmount - receivable.outstandingAmount);
            if (refundAmount > paidAmount) throw new ConvexError("Refund amount cannot exceed collected amount.");

            await ctx.db.insert("collectionPayments", {
              orgId: args.orgId,
              branchId: membership.branchId,
              receivableId: receivable._id,
              customerId: receivable.customerId,
              vehicleId: receivable.vehicleId,
              saleId: receivable.saleId,
              direction: "OUT",
              method: "REFUND",
              amount: refundAmount,
              paymentDate: now,
              status: "POSTED",
              idempotencyKey: args.idempotencyKey,
              reference: `Refund approval ${args.requestId}`,
              cashierId: user._id,
              notes: args.decisionNotes,
              createdAt: now,
            });

            const newOutstanding = roundMoney(receivable.outstandingAmount + refundAmount);
            await ctx.db.patch(receivable._id, {
              outstandingAmount: newOutstanding,
              status: refundAmount >= paidAmount ? "REFUNDED" : nextStatus(newOutstanding, receivable.dueDate),
              updatedAt: now,
            });

            await insertLedgerTransaction(ctx, {
              orgId: args.orgId,
              direction: "OUT",
              amount: refundAmount,
              date: now,
              description: `Refund for ${receivable.title}`,
              vehicleId: receivable.vehicleId,
              userId: user._id,
              category: "REFUND",
              idempotencyKey: args.idempotencyKey,
            });
          }
        }

        await notifyUser(ctx, args.orgId, request.requestedBy, "collection.approval_responded", {
          status: args.status,
          amount: String(request.requestedAmount ?? receivable.outstandingAmount),
        }, { link: `/${args.orgId}/accounting` });

        return args.requestId;
      }
    );
  },
});

export const getReconciliationDraft = query({
  args: {
    orgId: v.id("organizations"),
    businessDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { start, end } = dayRange(args.businessDate);
    const payments = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_cashier", (q) => q.eq("orgId", args.orgId).eq("cashierId", user._id))
      .take(500);
    const cashPayments = payments.filter(
      (payment) =>
        !payment.reconciliationId &&
        payment.status === "POSTED" &&
        payment.paymentDate >= start &&
        payment.paymentDate <= end &&
        (payment.method === "CASH" || payment.method === "REFUND")
    );
    const expectedCash = cashPayments.reduce(
      (sum, payment) => sum + (payment.direction === "IN" ? payment.amount : -payment.amount),
      0
    );
    return {
      businessDate: start,
      expectedCash: roundMoney(expectedCash),
      paymentCount: cashPayments.length,
    };
  },
});

export const submitCashierReconciliation = mutation({
  args: {
    orgId: v.id("organizations"),
    businessDate: v.number(),
    countedCash: v.number(),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.submitCashierReconciliation",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        if (!Number.isFinite(args.countedCash) || args.countedCash < 0) {
          throw new ConvexError("Counted cash must be zero or greater.");
        }
        const { start, end } = dayRange(args.businessDate);
        const payments = await ctx.db
          .query("collectionPayments")
          .withIndex("by_org_cashier", (q) => q.eq("orgId", args.orgId).eq("cashierId", user._id))
          .take(500);
        const cashPayments = payments.filter(
          (payment) =>
            !payment.reconciliationId &&
            payment.status === "POSTED" &&
            payment.paymentDate >= start &&
            payment.paymentDate <= end &&
            (payment.method === "CASH" || payment.method === "REFUND")
        );
        const expectedCash = roundMoney(cashPayments.reduce(
          (sum, payment) => sum + (payment.direction === "IN" ? payment.amount : -payment.amount),
          0
        ));
        const countedCash = roundMoney(args.countedCash);
        const now = Date.now();
        const reconciliationId = await ctx.db.insert("cashierReconciliations", {
          orgId: args.orgId,
          branchId: membership.branchId,
          cashierId: user._id,
          businessDate: start,
          expectedCash,
          countedCash,
          difference: roundMoney(countedCash - expectedCash),
          status: "SUBMITTED",
          idempotencyKey: args.idempotencyKey,
          notes: args.notes,
          createdAt: now,
          updatedAt: now,
        });

        for (const payment of cashPayments) {
          await ctx.db.patch(payment._id, { reconciliationId });
        }

        const actorName = await getActorName(ctx);
        await notifyManagers(ctx, args.orgId, "collection.reconciliation_submitted", {
          actorName,
          amount: String(countedCash),
        }, { link: `/${args.orgId}/accounting` });

        return reconciliationId;
      }
    );
  },
});

export const listReconciliations = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const rows = await ctx.db
      .query("cashierReconciliations")
      .withIndex("by_org_businessDate", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(50);
    return await Promise.all(rows.map(async (row) => {
      const cashier = await ctx.db.get(row.cashierId);
      return {
        ...row,
        cashierName: cashier?.name ?? cashier?.email ?? "Unknown",
      };
    }));
  },
});

export const reviewCashierReconciliation = mutation({
  args: {
    orgId: v.id("organizations"),
    reconciliationId: v.id("cashierReconciliations"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const reconciliation = await ctx.db.get(args.reconciliationId);
    if (!reconciliation || reconciliation.orgId !== args.orgId) throw new ConvexError("Reconciliation not found.");
    if (reconciliation.status !== "SUBMITTED") throw new ConvexError("Only submitted reconciliations can be reviewed.");
    assertDifferentActors(
      user._id,
      reconciliation.cashierId,
      "Cashier cannot approve or reject their own reconciliation."
    );
    await ctx.db.patch(args.reconciliationId, {
      status: args.status,
      notes: args.notes ?? reconciliation.notes,
      reviewedBy: user._id,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const dailyCollectionList = query({
  args: {
    orgId: v.id("organizations"),
    businessDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const { start, end } = dayRange(args.businessDate);
    const payments = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_paymentDate", (q) => q.eq("orgId", args.orgId).gte("paymentDate", start))
      .take(500);
    const rows = payments.filter((payment) => payment.paymentDate <= end && payment.status === "POSTED");
    const totalsByMethod: Record<string, number> = {};
    for (const payment of rows) {
      totalsByMethod[payment.method] = roundMoney(
        (totalsByMethod[payment.method] ?? 0) + (payment.direction === "IN" ? payment.amount : -payment.amount)
      );
    }
    return {
      totalsByMethod,
      total: roundMoney(Object.values(totalsByMethod).reduce((sum, amount) => sum + amount, 0)),
      rows: await Promise.all(rows.map((payment) => hydratePayment(ctx, payment))),
    };
  },
});

export const upcomingChequeReport = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const cheques = await ctx.db
      .query("postDatedCheques")
      .withIndex("by_org_chequeDate", (q) => q.eq("orgId", args.orgId).gte("chequeDate", args.startDate))
      .take(500);
    const rows = cheques.filter(
      (cheque) =>
        cheque.chequeDate <= args.endDate &&
        (cheque.status === "HELD" || cheque.status === "DEPOSITED")
    );
    return {
      total: roundMoney(rows.reduce((sum, cheque) => sum + cheque.amount, 0)),
      rows: await Promise.all(rows.map((cheque) => hydrateCheque(ctx, cheque))),
    };
  },
});

export const agingReport = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const now = Date.now();
    const statuses: ReceivableStatus[] = ["OPEN", "PARTIALLY_PAID", "OVERDUE", "RESCHEDULED"];
    const buckets = {
      current: { count: 0, amount: 0 },
      days1To30: { count: 0, amount: 0 },
      days31To60: { count: 0, amount: 0 },
      days61To90: { count: 0, amount: 0 },
      over90: { count: 0, amount: 0 },
    };

    for (const status of statuses) {
      const rows = await ctx.db
        .query("receivables")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .take(500);
      for (const row of rows) {
        const ageDays = Math.floor((now - row.dueDate) / DAY_MS);
        const bucket = ageDays <= 0
          ? buckets.current
          : ageDays <= 30
            ? buckets.days1To30
            : ageDays <= 60
              ? buckets.days31To60
              : ageDays <= 90
                ? buckets.days61To90
                : buckets.over90;
        bucket.count += 1;
        bucket.amount = roundMoney(bucket.amount + row.outstandingAmount);
      }
    }

    return buckets;
  },
});

async function hasRecentReminder(
  ctx: MutationCtx,
  args: {
    receivableId?: Id<"receivables">;
    chequeId?: Id<"postDatedCheques">;
    messageType: ReminderMessageType;
    since: number;
  }
) {
  const rows = args.receivableId
    ? await ctx.db
        .query("collectionReminders")
        .withIndex("by_receivable", (q) => q.eq("receivableId", args.receivableId))
        .collect()
    : args.chequeId
      ? await ctx.db
          .query("collectionReminders")
          .withIndex("by_cheque", (q) => q.eq("chequeId", args.chequeId))
          .collect()
      : [];
  return rows.some(
    (row) =>
      row.messageType === args.messageType &&
      row.createdAt >= args.since &&
      (row.status === "PENDING" || row.status === "SENT" || row.status === "SKIPPED")
  );
}

async function queueCustomerReminder(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    receivableId?: Id<"receivables">;
    chequeId?: Id<"postDatedCheques">;
    messageType: ReminderMessageType;
  }
) {
  const customer = await ctx.db.get(args.customerId);
  const channel: ReminderChannel = customer?.whatsapp ? "WHATSAPP" : customer?.phone ? "SMS" : "MANUAL";
  const now = Date.now();
  if (await hasRecentReminder(ctx, { ...args, since: now - REMINDER_COOLDOWN_MS })) {
    return null;
  }
  const reminderId = await ctx.db.insert("collectionReminders", {
    orgId: args.orgId,
    customerId: args.customerId,
    receivableId: args.receivableId,
    chequeId: args.chequeId,
    channel,
    messageType: args.messageType,
    status: channel === "MANUAL" ? "SKIPPED" : "PENDING",
    scheduledAt: now,
    error: channel === "MANUAL" ? "No customer phone or WhatsApp number on file." : undefined,
    createdAt: now,
  });
  if (channel !== "MANUAL") {
    await ctx.scheduler.runAfter(0, internal.collectionReminderActions.sendCollectionReminder, { reminderId });
  }
  return reminderId;
}

export const processDailyCollectionReminders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const dueSoonLimit = now + 2 * DAY_MS;
    const chequeLimit = now + 3 * DAY_MS;
    const organizations = await ctx.db.query("organizations").take(200);
    let queued = 0;
    let markedOverdue = 0;

    for (const org of organizations) {
      const activeStatuses: ReceivableStatus[] = ["OPEN", "PARTIALLY_PAID", "RESCHEDULED"];
      for (const status of activeStatuses) {
        const overdue = await ctx.db
          .query("receivables")
          .withIndex("by_org_status_and_dueDate", (q) =>
            q.eq("orgId", org._id).eq("status", status).lte("dueDate", now)
          )
          .take(100);
        for (const receivable of overdue) {
          await ctx.db.patch(receivable._id, { status: "OVERDUE", updatedAt: now });
          const reminderId = await queueCustomerReminder(ctx, {
            orgId: org._id,
            customerId: receivable.customerId,
            receivableId: receivable._id,
            messageType: "OVERDUE",
          });
          if (reminderId) queued++;
          markedOverdue++;
        }

        const dueSoon = await ctx.db
          .query("receivables")
          .withIndex("by_org_status_and_dueDate", (q) =>
            q.eq("orgId", org._id).eq("status", status).gte("dueDate", now)
          )
          .take(100);
        for (const receivable of dueSoon.filter((row) => row.dueDate <= dueSoonLimit)) {
          const reminderId = await queueCustomerReminder(ctx, {
            orgId: org._id,
            customerId: receivable.customerId,
            receivableId: receivable._id,
            messageType: "DUE_SOON",
          });
          if (reminderId) queued++;
        }
      }

      const cheques = await ctx.db
        .query("postDatedCheques")
        .withIndex("by_org_status_and_chequeDate", (q) =>
          q.eq("orgId", org._id).eq("status", "HELD").gte("chequeDate", now)
        )
        .take(100);
      for (const cheque of cheques.filter((row) => row.chequeDate <= chequeLimit)) {
        const reminderId = await queueCustomerReminder(ctx, {
          orgId: org._id,
          customerId: cheque.customerId,
          chequeId: cheque._id,
          receivableId: cheque.receivableId,
          messageType: "CHEQUE_UPCOMING",
        });
        if (reminderId) queued++;
      }
    }

    return { queued, markedOverdue };
  },
});

export const getReminderPayload = internalQuery({
  args: { reminderId: v.id("collectionReminders") },
  handler: async (ctx, args) => {
    const reminder = await ctx.db.get(args.reminderId);
    if (!reminder) return null;
    const [customer, receivable, cheque] = await Promise.all([
      ctx.db.get(reminder.customerId),
      reminder.receivableId ? ctx.db.get(reminder.receivableId) : null,
      reminder.chequeId ? ctx.db.get(reminder.chequeId) : null,
    ]);
    return { reminder, customer, receivable, cheque };
  },
});

export const markReminderResult = internalMutation({
  args: {
    reminderId: v.id("collectionReminders"),
    status: v.union(v.literal("SENT"), v.literal("FAILED"), v.literal("SKIPPED")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Partial<Pick<Doc<"collectionReminders">, "status" | "error" | "sentAt">> = {
      status: args.status,
      error: args.error,
    };
    if (args.status === "SENT") patch.sentAt = Date.now();
    await ctx.db.patch(args.reminderId, patch);
  },
});
