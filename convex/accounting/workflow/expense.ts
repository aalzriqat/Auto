import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { classifyExpensePosting, expensePostedKey } from "../postingRules";
import { ensureVatReceivableAccountIfChartReady } from "./vatAccounts";
import { isChartInitialized } from "../chartAccountsRead";
import {
  ensureConsignmentAccounts,
  ensureExpenseCategoryAccounts,
  ensurePrepaidExpensesAccount,
} from "../chartAccountsProvision";
import { postDomainEvent } from "./posting";
import { SYSTEM_KEYS } from "../../utils/defaultChart";

export async function hookExpensePosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    expenseId: Id<"expenses">;
    amountMinor: number;
    taxMinor?: number;
    currency: string;
    category?: string;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
    vehicleId?: Id<"vehicles">;
    capitalizeToInventory?: boolean;
    isPrepaid?: boolean;
    /** SCRUM-389. Absent means SHOWROOM; see ExpensePostedPayload.costBearer. */
    costBearer?: "SHOWROOM" | "SUPPLIER";
  }
) {
  const { capitalize, prepaid } = classifyExpensePosting(args);
  if (args.taxMinor && args.taxMinor > 0) {
    await ensureVatReceivableAccountIfChartReady(ctx, args.orgId, args.actorId);
  }
  const supplierBorne = args.costBearer === "SUPPLIER";
  if (supplierBorne) {
    // A supplier-borne cost debits Receivable from Suppliers, which older
    // charts lack. Self-healed here, and ALSO named as a required key below so
    // that an org whose chart cannot take it queues the post instead of
    // throwing inside the caller's transaction.
    if (await isChartInitialized(ctx, args.orgId)) {
      await ensureConsignmentAccounts(ctx, args.orgId, args.actorId);
    }
  } else if (!capitalize && await isChartInitialized(ctx, args.orgId)) {
    // A prepaid expense debits the Prepaid Expenses asset now and releases it
    // to a per-category expense account later, so both must exist. A normal
    // expense resolves expenseAccountKeyForCategory, which can point at a
    // dedicated per-category account instead of always GENERAL_EXPENSE — either
    // way, self-heal the category accounts for charts initialized before those
    // additions.
    await ensureExpenseCategoryAccounts(ctx, args.orgId, args.actorId);
    if (prepaid) {
      await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
    }
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "EXPENSE_POSTED",
    sourceType: "expenses",
    sourceId: args.expenseId.toString(),
    idempotencyKey: expensePostedKey(args.expenseId),
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      expenseId: args.expenseId.toString(),
      amountMinor: args.amountMinor,
      taxMinor: args.taxMinor,
      currency: args.currency,
      category: args.category,
      paymentMethod: args.paymentMethod,
      ...(args.bankAccountId ? { bankAccountId: args.bankAccountId.toString() } : {}),
      vehicleId: args.vehicleId?.toString(),
      capitalizeToInventory: args.capitalizeToInventory,
      isPrepaid: prepaid,
      // A showroom-borne payload carries no bearer at all, exactly as before
      // SCRUM-389, so its replay fingerprint is unchanged.
      ...(supplierBorne ? { costBearer: "SUPPLIER" as const } : {}),
    },
    ...(supplierBorne ? { requiredSystemKeys: [SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] } : {}),
  });
}
