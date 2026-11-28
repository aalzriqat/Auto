import type { Infer } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { rateLimiter } from "../../rateLimit";
import { AppErrorCode, throwAppError } from "../../utils/errors";
import { calendarDateInTimeZone, getOrgTimeZone } from "../../utils/orgBusinessDay";
import { PERMISSIONS } from "../../utils/permissions";
import { requireTenantAuth } from "../../utils/tenancy";
import { ANTHROPIC_DRAFT_MODEL } from "./anthropicAdapter";
import { isValidProposal, MAX_ASSISTANT_MESSAGE_CHARS } from "./expenseProposal";
import type { expenseProposalViewValidator, StoredExpenseOutcome } from "./expenseProposalValidators";
import { isAiDraftEnabledForOrg } from "./settings";

/** A pending request older than this is dead: the action never reported back. */
export const EXPENSE_PROPOSAL_EXPIRY_MS = 120_000;

type ProposalView = Infer<typeof expenseProposalViewValidator>;

/** The dealership's calendar day, `YYYY-MM-DD`, in its configured time zone. */
export async function dealershipToday(ctx: QueryCtx, orgId: Id<"organizations">, at: number): Promise<string> {
  const { year, month, day } = calendarDateInTimeZone(await getOrgTimeZone(ctx, orgId), at);
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * One staff request. Order: tenant access with create:expenses, the AI gate (platform switch,
 * dealership switch, stored key), the message, the two rate limits, then the row. A refusal
 * stores and schedules nothing. The door schedules the job and its expiry after this returns.
 */
export async function requestExpenseProposalForStaff(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; message: string }
): Promise<{ proposalId: Id<"aiAssistantProposals"> }> {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_EXPENSES]);
  if (!(await isAiDraftEnabledForOrg(ctx, args.orgId))) {
    throwAppError(AppErrorCode.AI_ASSISTANT_NOT_ENABLED, "The assistant is not turned on for this dealership.");
  }
  const message = args.message.trim();
  if (message.length < 1 || message.length > MAX_ASSISTANT_MESSAGE_CHARS) {
    throwAppError(AppErrorCode.VALIDATION_FAILED, "Write a message of 1 to 1000 characters.");
  }
  const userLimit = await rateLimiter.limit(ctx, "aiAssistantRequestUser", { key: `${args.orgId}:${user._id}` });
  const orgLimit = await rateLimiter.limit(ctx, "aiAssistantRequest", { key: args.orgId });
  if (!userLimit.ok || !orgLimit.ok) {
    throwAppError(AppErrorCode.AI_ASSISTANT_RATE_LIMITED, "Too many assistant requests. Please wait and try again.");
  }
  const proposalId = await ctx.db.insert("aiAssistantProposals", {
    orgId: args.orgId,
    requestedBy: user._id,
    requestedAt: Date.now(),
    status: "pending",
    message,
    model: ANTHROPIC_DRAFT_MODEL,
  });
  return { proposalId };
}

/**
 * What the requester may read. A row of another dealership, of another member, or no row at
 * all reads the same way: null.
 */
export async function readExpenseProposalForStaff(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; proposalId: Id<"aiAssistantProposals"> }
): Promise<ProposalView> {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_EXPENSES]);
  const row = await ctx.db.get(args.proposalId);
  if (!row || row.orgId !== args.orgId || row.requestedBy !== user._id) return null;
  const view: NonNullable<ProposalView> = { status: row.status };
  if (row.proposal !== undefined) view.proposal = row.proposal;
  return view;
}

/** The scheduled expiry: a request whose action never reported back fails. */
export async function expirePendingProposal(ctx: MutationCtx, proposalId: Id<"aiAssistantProposals">): Promise<void> {
  const row = await ctx.db.get(proposalId);
  if (row?.status !== "pending") return;
  await ctx.db.patch(proposalId, { status: "failed", failureReason: "timeout", completedAt: Date.now() });
}

/**
 * Stores the outcome only while the row is still pending: a late job writes nothing. A proposal
 * is checked again here against the dealership's day, so a caller of this door cannot store a value
 * the rules refuse.
 */
export async function completePendingProposal(
  ctx: MutationCtx,
  proposalId: Id<"aiAssistantProposals">,
  outcome: StoredExpenseOutcome
): Promise<void> {
  const row = await ctx.db.get(proposalId);
  if (row?.status !== "pending") return;
  const completedAt = Date.now();
  if (outcome.status === "failed") {
    await ctx.db.patch(proposalId, { status: "failed", failureReason: outcome.failureReason, completedAt });
    return;
  }
  const usage = { model: outcome.model, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, completedAt };
  if (outcome.status === "ready") {
    const today = await dealershipToday(ctx, row.orgId, completedAt);
    if (isValidProposal(outcome.proposal, today)) {
      await ctx.db.patch(proposalId, { status: "ready", proposal: outcome.proposal, ...usage });
      return;
    }
    await ctx.db.patch(proposalId, { status: "not_understood", ...usage });
    return;
  }
  await ctx.db.patch(proposalId, { status: outcome.status, ...usage });
}
