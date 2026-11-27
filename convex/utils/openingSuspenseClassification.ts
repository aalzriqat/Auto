import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { incrementAccountSnapshot } from "../accounting/accountSnapshots";
import { assertOrgEconomicallyActive } from "./orgLifecycle";
import { orgResetState } from "./orgResetGeneration";
import { openingJournalLines } from "./openingVoidProof";
import { refuseOpeningChange } from "./openingMaintenanceErrors";
import { inTurn } from "./transactionReadHeadroom";
import { loadOpeningSourceIdentity } from "./openingSourceIdentity";
import { containsEmployeeAdvanceControl } from "./openingPayrollVisibility";
import { denominationOf } from "./money";
import { openingPolicyForAccount } from "./openingAccountPolicy";
import { SYSTEM_KEYS } from "./defaultChart";
import { isLateBankOpeningLine, LATE_BANK_OPENING_MAX_BANKS } from "../accounting/lateBankOpening";

type Opening = Doc<"openingBalanceDrafts">;
export type OpeningVisibility = { userId: Id<"users">; canViewCosts: boolean; canManagePayroll: boolean };

type Classification = NonNullable<Opening["suspenseClassification"]>;
const CLASSIFICATION_SOURCE = "openingBalanceSuspenseClassification";

async function openingSuspenseBasis(ctx: QueryCtx, draft: Opening, periodId: Id<"accountingPeriods"> | undefined) {
  const orgId = draft.orgId;
  await assertOrgEconomicallyActive(ctx, orgId);
  const org = await ctx.db.get(orgId);
  if (orgResetState(org).inProgress || org?.openingCleanupPayableScan || org?.openingCleanupReferenceScan ||
      draft.status !== "POSTED" || !draft.journalEntryId) refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
  const source = await loadOpeningSourceIdentity(ctx, orgId);
  const journal = await ctx.db.get(draft.journalEntryId);
  if (source.status !== "AVAILABLE" || source.parent._id !== draft._id ||
      journal?.status !== "POSTED" || journal.reversedByJournalEntryId ||
      !periodId || journal.periodId !== periodId) refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
  const lines = await openingJournalLines(ctx, draft, journal);
  const currency = draft.currency;
  const scale = denominationOf(currency)?.scale;
  if (!lines || !currency || scale === undefined) refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");

  const accounts = await ctx.db.query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "OPENING_SUSPENSE")).take(2);
  const suspense = accounts[0];
  if (accounts.length !== 1 || !suspense?.active || suspense.code !== "1900") {
    refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
  }
  const sourceLines = lines.filter(line => line.accountId === suspense._id);
  const [sourceLine] = sourceLines;
  if (sourceLines.length !== 1 || (sourceLine.debitMinor === 0 && sourceLine.creditMinor === 0)) {
    refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
  }
  const openingTime = Math.min(...lines.map(line => line._creationTime));
  const basis = {
    orgId, originalJournalId: journal._id, sourceAccountId: suspense._id, openingTime, lines,
    signedBalanceMinor: sourceLine.debitMinor - sourceLine.creditMinor,
    periodId, currency, scale,
  };
  await assertClassificationAccountUntouched(ctx, basis, suspense._id);
  return basis;
}

type SuspenseBasis = Awaited<ReturnType<typeof openingSuspenseBasis>>;

/**
 * Nothing may have touched the account since the opening, except (SCRUM-1022, owner ruling 2026-11-27) on Opening
 * suspense itself: at most one credit per bank from a POSTED late bank opening event, identified by event identity.
 * Those credits are not part of the classified amount (`basis.signedBalanceMinor` is the opening's own 1900 line)
 * and stay in 1900.
 */
async function assertClassificationAccountUntouched(ctx: QueryCtx, basis: SuspenseBasis, accountId: Id<"chartOfAccounts">): Promise<void> {
  const originalCount = basis.lines.filter(line => line.accountId === accountId).length;
  const lateAllowance = accountId === basis.sourceAccountId ? LATE_BANK_OPENING_MAX_BANKS : 0;
  const activity = await ctx.db.query("journalLines").withIndex("by_org_account", (q) =>
    q.eq("orgId", basis.orgId).eq("accountId", accountId).gte("_creationTime", basis.openingTime)).take(originalCount + lateAllowance + 1);
  if (activity.length > originalCount + lateAllowance) refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
  const lateJournals = new Set<Id<"journalEntries">>();
  let originalSeen = 0;
  for (const line of activity) {
    if (line.journalEntryId === basis.originalJournalId) { originalSeen += 1; continue; }
    if (lateAllowance === 0 || lateJournals.has(line.journalEntryId) || !(await isLateBankOpeningLine(ctx, basis.orgId, line))) {
      refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
    }
    lateJournals.add(line.journalEntryId);
  }
  if (originalSeen !== originalCount) refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
}

function supportsSuspenseClassification(target: Doc<"chartOfAccounts">, currency: string) {
  return target.active && !target.isControlAccount && target.allowManualPosting &&
    target.systemKey !== "OPENING_SUSPENSE" && target.systemKey !== "CASH_ON_HAND" && target.systemKey !== "BANK_ACCOUNT" &&
    (target.currencyRestriction === undefined || target.currencyRestriction === currency) &&
    openingPolicyForAccount(target, false) === "LEDGER_ONLY";
}

export async function inspectSuspenseClassification(ctx: QueryCtx, draft: Opening, target: Doc<"chartOfAccounts">, periodId: Id<"accountingPeriods"> | undefined) {
  const basis = await openingSuspenseBasis(ctx, draft, periodId);
  if (!supportsSuspenseClassification(target, basis.currency)) refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
  await assertClassificationAccountUntouched(ctx, basis, target._id);
  return { ...basis, targetAccountId: target._id };
}

function classificationLines(request: Pick<Classification, "sourceAccountId" | "targetAccountId" | "signedBalanceMinor">) {
  const debitMinor = Math.max(0, -request.signedBalanceMinor);
  const creditMinor = Math.max(0, request.signedBalanceMinor);
  return [
    { lineNumber: 1, accountId: request.sourceAccountId, debitMinor, creditMinor },
    { lineNumber: 2, accountId: request.targetAccountId, debitMinor: creditMinor, creditMinor: debitMinor },
  ];
}

export async function readClassificationReplay(ctx: QueryCtx, draft: Opening, request: Classification) {
  const approval = request.approval;
  if (!approval || approval.by === request.requestedBy || draft.status !== "POSTED" ||
      draft.journalEntryId !== request.originalJournalId || !Number.isSafeInteger(request.signedBalanceMinor) ||
      request.signedBalanceMinor === 0) refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
  const journal = await ctx.db.get(approval.journalId);
  const original = await ctx.db.get(request.originalJournalId);
  if (!journal || !original || original.orgId !== draft.orgId || original.status !== "POSTED" ||
      journal.orgId !== draft.orgId || journal.status !== "POSTED" || journal.reversedByJournalEntryId ||
      journal.sourceType !== CLASSIFICATION_SOURCE || journal.sourceId !== String(draft._id) ||
      journal.category !== "ADJUSTMENT" || journal.periodId !== original.periodId ||
      journal.currency !== draft.currency || journal.accountingDate !== draft.asOfDate || journal.postedBy !== approval.by) {
    refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
  }
  const lines = await ctx.db.query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journal._id)).take(3);
  const expected = classificationLines(request);
  const scale = denominationOf(draft.currency)?.scale;
  if (lines.length !== expected.length || scale === undefined || !expected.every(line => lines.some(row =>
    row.lineNumber === line.lineNumber && row.orgId === draft.orgId && row.accountId === line.accountId &&
    row.currency === draft.currency && row.scale === scale && row.accountingDate === draft.asOfDate &&
    row.debitMinor === line.debitMinor && row.creditMinor === line.creditMinor))) {
    refuseOpeningChange("OPENING_SUSPENSE_INELIGIBLE");
  }
  return { journalId: journal._id };
}

export async function postSuspenseClassification(
  ctx: MutationCtx,
  draft: Opening,
  request: Classification,
  plan: Awaited<ReturnType<typeof inspectSuspenseClassification>>,
  actorId: Id<"users">,
) {
  const now = Date.now();
  const journalId = await ctx.db.insert("journalEntries", {
    orgId: draft.orgId, periodId: plan.periodId, accountingDate: draft.asOfDate,
    journalNumber: `OB-CLASS-${String(draft._id).slice(-10).toUpperCase()}`,
    sourceType: CLASSIFICATION_SOURCE, sourceId: String(draft._id), category: "ADJUSTMENT",
    memo: "Opening balance difference classification", status: "POSTED", currency: plan.currency,
    postedBy: actorId, postedAt: now, createdAt: now,
  });
  await inTurn(classificationLines(request), async line => {
    await ctx.db.insert("journalLines", { ...line, orgId: draft.orgId, journalEntryId: journalId,
      currency: plan.currency, scale: plan.scale, accountingDate: draft.asOfDate });
    await incrementAccountSnapshot(ctx, { orgId: draft.orgId, accountId: line.accountId,
      periodId: plan.periodId, currency: plan.currency, debitMinor: line.debitMinor, creditMinor: line.creditMinor });
  });
  await ctx.db.patch(draft._id, { suspenseClassification: {
    ...request, approval: { by: actorId, at: now, journalId },
  } });
  return journalId;
}

export async function suspenseClassificationCapability(ctx: QueryCtx, draft: Opening | null, visibility: OpeningVisibility, periodId: Id<"accountingPeriods"> | undefined) {
  if (!draft?.currency || !visibility.canViewCosts || draft.suspenseClassification?.approval ||
      (!visibility.canManagePayroll && await containsEmployeeAdvanceControl(ctx, draft.orgId, draft))) return undefined;
  const { currency } = draft;
  const current = draft.suspenseClassification;
  const pending = current && !current.dismissal ? current : null;
  let basis: SuspenseBasis | null = null;
  try { basis = await openingSuspenseBasis(ctx, draft, periodId); }
  catch (error) {
    if (!(error instanceof ConvexError)) console.error("Opening suspense eligibility unavailable", error);
  }
  if (!basis && !pending) return undefined;
  const systemAccountCount = Object.keys(SYSTEM_KEYS).length;
  const targets = !pending && basis ? await ctx.db.query("chartOfAccounts")
    .withIndex("by_org_systemKey", q => q.eq("orgId", draft.orgId).gt("systemKey", undefined))
    .take(systemAccountCount + 1) : [];
  if (targets.length > systemAccountCount) return undefined;
  const pendingTarget = pending ? await ctx.db.get(pending.targetAccountId) : null;
  const describeTarget = (account: Doc<"chartOfAccounts">) => ({
    accountId: account._id, code: account.code, name: account.name, nameAr: account.nameAr,
  });
  const resolvedTarget = pendingTarget?.orgId === draft.orgId ? pendingTarget : null;
  let canApprove = false;
  if (basis && pending && resolvedTarget && pending.requestedBy !== visibility.userId &&
      pending.originalJournalId === basis.originalJournalId && pending.sourceAccountId === basis.sourceAccountId &&
      pending.signedBalanceMinor === basis.signedBalanceMinor && supportsSuspenseClassification(resolvedTarget, currency)) {
    try {
      await assertClassificationAccountUntouched(ctx, basis, resolvedTarget._id);
      canApprove = true;
    } catch (error) {
      if (!(error instanceof ConvexError)) console.error("Opening suspense destination eligibility unavailable", error);
    }
  }
  return {
    draftId: draft._id,
    signedBalanceMinor: pending?.signedBalanceMinor ?? basis?.signedBalanceMinor ?? 0,
    currency,
    targets: targets.filter(account => supportsSuspenseClassification(account, currency)).map(describeTarget),
    pending: pending ? {
      version: pending.version, reason: pending.reason, canApprove,
      target: resolvedTarget ? describeTarget(resolvedTarget) : null,
    } : null,
  };
}

const classificationTargetValidator = v.object({
  accountId: v.id("chartOfAccounts"), code: v.string(), name: v.string(), nameAr: v.optional(v.string()),
});

export const suspenseClassificationCapabilityValidator = v.optional(v.object({
      draftId: v.id("openingBalanceDrafts"), signedBalanceMinor: v.number(), currency: v.string(),
      targets: v.array(classificationTargetValidator),
      pending: v.union(v.null(), v.object({
        version: v.number(), reason: v.string(), canApprove: v.boolean(),
        target: v.union(v.null(), classificationTargetValidator),
      })),
    }));
