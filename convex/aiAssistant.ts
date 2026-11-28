import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { PERMISSIONS } from "./utils/permissions";
import { requireTenantAuth } from "./utils/tenancy";
import {
  completePendingProposal,
  EXPENSE_PROPOSAL_EXPIRY_MS,
  expenseJobValidator,
  expenseOutcomeValidator,
  expenseProposalViewValidator,
  expirePendingProposal,
  isAiDraftEnabledForOrg,
  loadExpenseJobData,
  readExpenseProposalForStaff,
  requestExpenseProposalForStaff,
  runGenerateExpenseProposal,
} from "./domains/ai";

/**
 * Doors for the dealership assistant, slice 1: staff describe an expense in a message and get a
 * PROPOSAL (suggested form values). Logic lives in `convex/domains/ai`. No function here records an
 * expense or touches the ledger: the web app opens the normal expense form with the proposal, and
 * the staff member checks and saves it there.
 */

export const getAvailability = query({
  args: { orgId: v.id("organizations") },
  returns: v.object({ enabled: v.boolean() }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_EXPENSES]);
    return { enabled: await isAiDraftEnabledForOrg(ctx, args.orgId) };
  },
});

export const requestExpenseProposal = mutation({
  args: { orgId: v.id("organizations"), message: v.string() },
  returns: v.object({ proposalId: v.id("aiAssistantProposals") }),
  handler: async (ctx, args) => {
    const { proposalId } = await requestExpenseProposalForStaff(ctx, args);
    await ctx.scheduler.runAfter(0, internal.aiAssistant.generateExpenseProposal, { proposalId });
    await ctx.scheduler.runAfter(EXPENSE_PROPOSAL_EXPIRY_MS, internal.aiAssistant.expireExpenseProposal, { proposalId });
    return { proposalId };
  },
});

export const getExpenseProposal = query({
  args: { orgId: v.id("organizations"), proposalId: v.id("aiAssistantProposals") },
  returns: expenseProposalViewValidator,
  handler: async (ctx, args) => await readExpenseProposalForStaff(ctx, args),
});

export const loadExpenseJob = internalQuery({
  args: { proposalId: v.id("aiAssistantProposals") },
  returns: expenseJobValidator,
  handler: async (ctx, args) => await loadExpenseJobData(ctx, args.proposalId),
});

export const completeExpenseProposal = internalMutation({
  args: { proposalId: v.id("aiAssistantProposals"), outcome: expenseOutcomeValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await completePendingProposal(ctx, args.proposalId, args.outcome);
    return null;
  },
});

export const expireExpenseProposal = internalMutation({
  args: { proposalId: v.id("aiAssistantProposals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await expirePendingProposal(ctx, args.proposalId);
    return null;
  },
});

/**
 * The provider call. The plaintext key exists only inside `runExpenseProposalJob`: this door
 * passes the sealed key through and never opens it.
 */
export const generateExpenseProposal = internalAction({
  args: { proposalId: v.id("aiAssistantProposals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { proposalId } = args;
    await runGenerateExpenseProposal({
      load: () => ctx.runQuery(internal.aiAssistant.loadExpenseJob, { proposalId }),
      complete: (outcome) => ctx.runMutation(internal.aiAssistant.completeExpenseProposal, { proposalId, outcome }),
    });
    return null;
  },
});
