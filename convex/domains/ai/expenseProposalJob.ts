import type { Infer } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { sinkEgress } from "../../utils/egressSink";
import { getValidatedEnv } from "../../utils/env";
import { anthropicExpenseProvider } from "./anthropicAdapter";
import { openSealedKey } from "./draftLifecycle";
import { decideExpenseProposal } from "./expenseProposal";
import { buildExpenseUserMessage, EXPENSE_SYSTEM_PROMPT } from "./expenseProposalPrompt";
import { dealershipToday } from "./expenseProposalRequest";
import type { expenseJobValidator, StoredExpenseOutcome } from "./expenseProposalValidators";
import { readSealedProviderKey } from "./keyStore";
import type { ExpenseProvider } from "./provider";
import { isAiDraftEnabledForOrg } from "./settings";

export type ExpenseJob = Infer<typeof expenseJobValidator>;

/**
 * Everything the job needs, after re-checking every condition the request checked: a refusal
 * means the action makes no provider call. Returns the ENCRYPTED key; only an internal query
 * may call this. Of the dealership it returns only today's date.
 */
export async function loadExpenseJobData(ctx: QueryCtx, proposalId: Id<"aiAssistantProposals">): Promise<ExpenseJob> {
  const row = await ctx.db.get(proposalId);
  if (row?.status !== "pending") return { ok: false, reason: "not_pending" };

  const org = await ctx.db.get(row.orgId);
  if (!org || org.suspended || org.deletionRequestedAt !== undefined || org.destructivePurgeStartedAt !== undefined) {
    return { ok: false, reason: "org_unavailable" };
  }
  if (!(await isAiDraftEnabledForOrg(ctx, row.orgId))) return { ok: false, reason: "not_enabled" };
  const key = await readSealedProviderKey(ctx, "anthropic");
  if (!key) return { ok: false, reason: "key_missing" };
  return { ok: true, message: row.message, today: await dealershipToday(ctx, row.orgId, Date.now()), sealedKey: key };
}

function logErrorClass(label: string, error: unknown): void {
  console.error(label, error instanceof Error ? error.name : "unknown");
}

/**
 * Opens the sealed key, makes the one provider call and returns the outcome to store. The
 * provider is given the message, today's date and the category names; it has no tools. Its text
 * becomes a proposal only through `decideExpenseProposal`. Never throws.
 */
export async function runExpenseProposalJob(args: {
  job: Extract<ExpenseJob, { ok: true }>;
  masterKey?: string;
  provider?: ExpenseProvider;
}): Promise<StoredExpenseOutcome> {
  // The sink is checked first: a sunk deployment never opens the stored key.
  if (sinkEgress("ai", "aiAssistant.generateExpenseProposal")) return { status: "failed", failureReason: "egress_sunk" };
  let apiKey: string;
  try {
    apiKey = await openSealedKey(args.job.sealedKey, args.masterKey ?? getValidatedEnv().AI_KEY_ENCRYPTION_KEY);
  } catch (error) {
    logErrorClass("AI assistant key decryption failed", error);
    return { status: "failed", failureReason: "key_unavailable" };
  }
  try {
    const provider = args.provider ?? anthropicExpenseProvider;
    const result = await provider({
      apiKey,
      system: EXPENSE_SYSTEM_PROMPT,
      user: buildExpenseUserMessage(args.job.message, args.job.today),
    });
    if (!result.ok) return { status: "failed", failureReason: result.reason };
    const usage = { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    const decision = decideExpenseProposal(result.text, args.job.today);
    if (decision.kind === "proposal") return { status: "ready", proposal: decision.proposal, ...usage };
    return { status: decision.kind, ...usage };
  } catch (error) {
    logErrorClass("AI assistant run failed", error);
    return { status: "failed", failureReason: "provider_error" };
  }
}

/**
 * Orchestrates one scheduled job. `load` and `complete` are the two internal calls. A failure of
 * either is logged as a label and the error class only: a validator failure message carries the
 * whole object (the message, the sealed key), so it must never be logged, stored or rethrown.
 */
export async function runGenerateExpenseProposal(args: {
  load: () => Promise<ExpenseJob>;
  complete: (outcome: StoredExpenseOutcome) => Promise<unknown>;
}): Promise<void> {
  const complete = async (outcome: StoredExpenseOutcome): Promise<void> => {
    try {
      await args.complete(outcome);
    } catch (error) {
      // The scheduled expiry ends the row.
      logErrorClass("AI assistant completion failed", error);
    }
  };
  let job: ExpenseJob;
  try {
    job = await args.load();
  } catch (error) {
    logErrorClass("AI assistant job load failed", error);
    await complete({ status: "failed", failureReason: "provider_error" });
    return;
  }
  if (!job.ok) {
    // Gone or already settled, or the dealership is unavailable: nothing to write.
    if (job.reason === "not_pending" || job.reason === "org_unavailable") return;
    await complete({ status: "failed", failureReason: "not_enabled" });
    return;
  }
  await complete(await runExpenseProposalJob({ job }));
}
