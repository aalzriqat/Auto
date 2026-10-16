/**
 * SCRUM-54: the one validation of a physical bank a money-moving mutation may
 * name. Call it BEFORE the first write so a refused bank leaves nothing behind.
 * Never defaults, infers or falls back to "the only bank".
 */
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireOwnedRow } from "./tenancy";

const BANK_NOT_FOUND_MESSAGE = "The selected bank account was not found in this organization.";

export async function requireActiveBankInCurrency(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    bankAccountId: Id<"bankAccounts"> | undefined;
    currency: string;
    /** Shown when no bank was named. */
    missingMessage: string;
    /** Completes "...but this <subject> is in JOD." */
    currencySubject: string;
  }
): Promise<Id<"bankAccounts">> {
  if (!args.bankAccountId) throw new ConvexError(args.missingMessage);
  const bank = await requireOwnedRow(ctx, args.orgId, "bankAccounts", args.bankAccountId, BANK_NOT_FOUND_MESSAGE);
  if (bank.isDeleted) throw new ConvexError(BANK_NOT_FOUND_MESSAGE);
  if (!bank.isActive) {
    throw new ConvexError("The selected bank account is inactive.");
  }
  if (bank.currency !== args.currency) {
    throw new ConvexError(
      `The selected bank account is denominated in ${bank.currency}, but this ${args.currencySubject} is in ${args.currency}.`
    );
  }
  return args.bankAccountId;
}
