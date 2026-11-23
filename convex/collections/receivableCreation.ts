import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReceivableCreditKey } from "../accounting/postingRules";
import { getOrgCurrency, hookReceivableCreated } from "../accounting/workflowHooks";
import { runWithIdempotency } from "../utils/idempotency";
import { toMinorUnits } from "../utils/money";
import { getActorName, notifyManagers } from "../utils/notifications";
import { PERMISSIONS } from "../utils/permissions";
import { assertNoSaleIdOnNewReceivable } from "../utils/saleDebtContainment";
import { requireTenantAuth } from "../utils/tenancy";
import { assertPositiveAmount, roundMoney } from "./amounts";
import { ensureCanonicalReceivableForLegacy } from "./canonicalReceivables";
import { validateOptionalLinks, validateOrgCustomer } from "./collectionLinks";
import { addMonths, resolveReceivableCreditKey } from "./receivableState";
import type { receivableCreditKeyValidator } from "./validators";

export async function createReceivableHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    quoteId?: Id<"quotes">;
    applicationId?: Id<"financeApplications">;
    assignedTo?: Id<"users">;
    sourceType: Doc<"receivables">["sourceType"];
    title: string;
    amount: number;
    dueDate: number;
    notes?: string;
    creditSystemKey?: Infer<typeof receivableCreditKeyValidator>;
    idempotencyKey: string;
  },
) {
  const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  assertPositiveAmount(args.amount);
  if (!args.title.trim()) throw new ConvexError("Receivable title is required.");
  const creditSystemKey = args.saleId
    ? undefined
    : resolveReceivableCreditKey(args.sourceType, args.creditSystemKey);

  await validateOrgCustomer(ctx, args.orgId, args.customerId);
  await validateOptionalLinks(ctx, args.orgId, args);
  // SCRUM-571 W1 (D-20): a sale's customer debt is its sale invoice, never a
  // second legacy receivable. After the existence/org check so "Sale not
  // found" keeps precedence, and BEFORE `runWithIdempotency` so a replay of a
  // command stored before this guard existed is refused too instead of being
  // handed its stored result.
  assertNoSaleIdOnNewReceivable(args.saleId);

  const currency = await getOrgCurrency(ctx, args.orgId);
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "collections.createReceivable",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // Everything that changes what is OWED and how it is recognised.
      // `dueDate` is included because it decides OPEN vs OVERDUE at birth,
      // and `saleId` because it decides whether AR is recognised here at all.
      // The remaining persisted inputs — the vehicle, quote, application and
      // assignee links and the notes — are included too (SCRUM-318): a retry
      // that changed which car or deal a debt belongs to is not the same
      // intent, and acknowledging it with the original id would record one
      // thing while the caller believes another. Each is fingerprinted the
      // way the row stores it: ids as strings, absence as null, notes
      // untrimmed because they are persisted untrimmed.
      fingerprint: JSON.stringify({
        customerId: args.customerId.toString(),
        sourceType: args.sourceType,
        amount: args.amount,
        dueDate: args.dueDate,
        saleId: args.saleId?.toString() ?? null,
        creditSystemKey: args.creditSystemKey ?? null,
        title: args.title.trim(),
        vehicleId: args.vehicleId?.toString() ?? null,
        quoteId: args.quoteId?.toString() ?? null,
        applicationId: args.applicationId?.toString() ?? null,
        assignedTo: args.assignedTo?.toString() ?? null,
        notes: args.notes ?? null,
      }),
    },
    async () => await createReceivableCore(ctx, args, { user, membership, creditSystemKey, currency })
  );
}

/**
 * The body of `createReceivable`, extracted so the mutation above is a thin
 * identity boundary around it. Nothing here changed in this slice; it is the
 * same sequence, moved.
 */
async function createReceivableCore(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    quoteId?: Id<"quotes">;
    applicationId?: Id<"financeApplications">;
    assignedTo?: Id<"users">;
    sourceType: Doc<"receivables">["sourceType"];
    title: string;
    amount: number;
    dueDate: number;
    notes?: string;
  },
  deps: {
    user: Doc<"users">;
    membership: Doc<"memberships">;
    creditSystemKey: ReceivableCreditKey | undefined;
    currency: string;
  }
): Promise<Id<"receivables">> {
  const { user, membership, creditSystemKey, currency } = deps;
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
      originalAmount: roundMoney(args.amount, currency),
      outstandingAmount: roundMoney(args.amount, currency),
      dueDate: args.dueDate,
      status: args.dueDate < now ? "OVERDUE" : "OPEN",
      notes: args.notes,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });

    const receivable = await ctx.db.get(receivableId);
    if (receivable) {
      await ensureCanonicalReceivableForLegacy(ctx, receivable, user._id, currency);
    }

    // A sale-linked receivable's AR was already recognized by SALE_COMPLETED
    // at sale completion — posting a second origin entry here would double-book
    // it. Every other manual receivable (damage claims, ad-hoc charges, etc.)
    // has no prior GL recognition, so it needs its own DR AR / CR Other Income.
    if (creditSystemKey) {
      await hookReceivableCreated(ctx, {
        orgId: args.orgId,
        receivableId,
        customerId: args.customerId,
        amountMinor: toMinorUnits(roundMoney(args.amount, currency), currency),
        currency,
        actorId: user._id,
        occurredAt: now,
        creditSystemKey,
      });
    }

  const actorName = await getActorName(ctx);
  await notifyManagers(ctx, args.orgId, "collection.receivable_created", {
    actorName,
    amount: String(roundMoney(args.amount, currency)),
  }, { link: `/${args.orgId}/accounting` });

  return receivableId;
}

export async function createInstallmentPlanHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    quoteId?: Id<"quotes">;
    applicationId?: Id<"financeApplications">;
    assignedTo?: Id<"users">;
    title: string;
    totalAmount: number;
    installmentCount: number;
    firstDueDate: number;
    intervalMonths?: number;
    sourceType?: Doc<"receivables">["sourceType"];
    notes?: string;
    creditSystemKey?: Infer<typeof receivableCreditKeyValidator>;
    idempotencyKey: string;
  },
) {
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
  const creditSystemKey = args.saleId
    ? undefined
    : resolveReceivableCreditKey(args.sourceType ?? "INTERNAL_INSTALLMENT", args.creditSystemKey);

  await validateOrgCustomer(ctx, args.orgId, args.customerId);
  await validateOptionalLinks(ctx, args.orgId, args);
  // SCRUM-571 W1 (D-20): see createReceivable. Refused before the wrapper.
  assertNoSaleIdOnNewReceivable(args.saleId);

  const currency = await getOrgCurrency(ctx, args.orgId);
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "collections.createInstallmentPlan",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // The whole plan's shape. Every field here changes how many debts exist,
      // for how much, or when they fall due — so replaying one identity
      // against a different schedule is a contradiction, not a retry. The
      // links and notes every instalment carries are part of that shape for
      // the reason given on createReceivable (SCRUM-318), fingerprinted as
      // persisted: ids as strings, absence as null, notes untrimmed.
      fingerprint: JSON.stringify({
        customerId: args.customerId.toString(),
        totalAmount: args.totalAmount,
        installmentCount: args.installmentCount,
        firstDueDate: args.firstDueDate,
        intervalMonths,
        sourceType: args.sourceType ?? null,
        saleId: args.saleId?.toString() ?? null,
        creditSystemKey: args.creditSystemKey ?? null,
        title: args.title.trim(),
        vehicleId: args.vehicleId?.toString() ?? null,
        quoteId: args.quoteId?.toString() ?? null,
        applicationId: args.applicationId?.toString() ?? null,
        assignedTo: args.assignedTo?.toString() ?? null,
        notes: args.notes ?? null,
      }),
    },
    async () => {
  const now = Date.now();
  const baseAmount = roundMoney(args.totalAmount / args.installmentCount, currency);
  let allocated = 0;
  const ids: Id<"receivables">[] = [];

  for (let i = 1; i <= args.installmentCount; i++) {
    const amount = i === args.installmentCount
      ? roundMoney(args.totalAmount - allocated, currency)
      : baseAmount;
    allocated = roundMoney(allocated + amount, currency);
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
    const receivable = await ctx.db.get(id);
    if (receivable) {
      await ensureCanonicalReceivableForLegacy(ctx, receivable, user._id, currency);
    }

    // Same reasoning as createReceivable: skip when sale-linked, since that
    // AR was already recognized by SALE_COMPLETED.
    if (creditSystemKey) {
      await hookReceivableCreated(ctx, {
        orgId: args.orgId,
        receivableId: id,
        customerId: args.customerId,
        amountMinor: toMinorUnits(amount, currency),
        currency,
        actorId: user._id,
        occurredAt: now,
        creditSystemKey,
      });
    }

    ids.push(id);
  }

  const actorName = await getActorName(ctx);
  await notifyManagers(ctx, args.orgId, "collection.plan_created", {
    actorName,
    amount: String(roundMoney(args.totalAmount, currency)),
  }, { link: `/${args.orgId}/accounting` });

      return ids;
    }
  );
}
