import { ConvexError } from "convex/values";
import type { PostCommand } from "../accounting/postingEngine";
import type { MutationCtx } from "../_generated/server";

export const OPENING_DEPOSIT_REFUND_SOURCE = "openingDepositRefund";
export const OPENING_DEPOSIT_REFUND_JOURNAL_KEY = "opening_deposit_refunded_";
export const OPENING_DEPOSIT_RETURN_JOURNAL_KEY = "opening_deposit_bank_return_";
export function openingRefundTransferPaymentKey(bankAccountId: string, reference: string) {
  return `opening_deposit_refund_transfer_${bankAccountId}_${reference.trim().toUpperCase()}`;
}

const authorizedCommands = new WeakSet<PostCommand>();

export function authorizeOpeningDepositRefund(command: PostCommand): PostCommand {
  authorizedCommands.add(command);
  return command;
}

export async function assertOpeningDepositRefundPosting(ctx: MutationCtx, command: PostCommand) {
  if (command.sourceType === OPENING_DEPOSIT_REFUND_SOURCE ||
      command.idempotencyKey.startsWith(OPENING_DEPOSIT_REFUND_JOURNAL_KEY) ||
      command.idempotencyKey.startsWith(OPENING_DEPOSIT_RETURN_JOURNAL_KEY) ||
      command.eventType === "DEPOSIT_REFUND_RETURNED") {
    if (!authorizedCommands.has(command) ||
        (command.eventType !== "DEPOSIT_REFUNDED" && command.eventType !== "DEPOSIT_REFUND_RETURNED") ||
        command.sourceType !== OPENING_DEPOSIT_REFUND_SOURCE) {
      throw new ConvexError("Opening deposit refunds must use the customer refund workflow.");
    }
    return;
  }
  if (command.eventType !== "DEPOSIT_REFUNDED" && command.eventType !== "DEPOSIT_FORFEITED") return;

  const { depositId } = command.payload;
  const candidates = new Set([command.sourceId, typeof depositId === "string" ? depositId : null]);
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const id = ctx.db.normalizeId("deposits", candidate);
    const deposit = id ? await ctx.db.get(id) : null;
    if (deposit?.orgId === command.orgId && deposit.origin === "OPENING") {
      throw new ConvexError("Opening deposit payouts must use the customer refund workflow.");
    }
  }
}
