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

/** The most eligible banks a picker reads before it reports truncation instead of guessing. */
export const BANK_OPTIONS_LIMIT = 100;

/**
 * SCRUM-54: the banks a picker may offer - this org's, live, active and in `currency`
 * (the same test `requireActiveBankInCurrency` applies). Read through the currency index,
 * so other currencies never consume the limit. More than the limit is reported as
 * `truncated` with no banks, never as a silently incomplete list. Only id, name and
 * currency leave, never IBAN or account numbers.
 */
export async function listEligibleBanks(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  currency: string
): Promise<{ banks: Array<{ _id: Id<"bankAccounts">; name: string; currency: string }>; truncated: boolean }> {
  const page = await ctx.db
    .query("bankAccounts")
    .withIndex("by_org_active_currency", (q) => q.eq("orgId", orgId).eq("isActive", true).eq("currency", currency))
    .take(BANK_OPTIONS_LIMIT + 1);
  if (page.length > BANK_OPTIONS_LIMIT) return { banks: [], truncated: true };
  return {
    banks: page.filter((bank) => !bank.isDeleted).map((bank) => ({ _id: bank._id, name: bank.name, currency: bank.currency })),
    truncated: false,
  };
}

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
