import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, PERMISSIONS, type Permission } from "./utils/permissions";
import { assertOrgEconomicallyActive } from "./utils/orgLifecycle";
import { orgResetState } from "./utils/orgResetGeneration";
import { getOpenPeriodForDate } from "./accountingPeriods";
import { auditLog } from "./financialAudit";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";
import { openingJournalLines, openingLedgerHasActivity, verifiedOpeningVoidPair } from "./utils/openingVoidProof";
import { openingChangeBoundary, refuseOpeningChange } from "./utils/openingMaintenanceErrors";
import { prepareOpeningVoidTargets, removeOpeningVoidTargets } from "./utils/openingVoidCleanup";
import { assertNoOpeningVoidReferences } from "./utils/openingVoidReferences";
import { inTurn } from "./utils/transactionReadHeadroom";
import { openingAllocationValidator } from "./utils/openingAllocationValidators";
import { loadOpeningSourceIdentity } from "./utils/openingSourceIdentity";

type Opening = Doc<"openingBalanceDrafts">;

async function openingNeedsPayroll(ctx: QueryCtx, draft: Opening): Promise<boolean> {
  if ((draft.allocations ?? []).some(row => row.kind === "EMPLOYEE_ADVANCE" || row.kind === "EMPLOYEE_COMMISSION")) return true;
  let sensitive = false;
  await inTurn(draft.lines, async line => {
    const account = await ctx.db.get(line.accountId);
    if (account?.orgId === draft.orgId && (account.systemKey === "EMPLOYEE_ADVANCES" || account.systemKey === "COMMISSION_PAYABLE")) sensitive = true;
  });
  return sensitive;
}

async function requireOpeningMaintenanceAuthority(ctx: QueryCtx, draft: Opening) {
  const required: Permission[] = [PERMISSIONS.MANAGE_FINANCE];
  if (await openingNeedsPayroll(ctx, draft)) required.push(PERMISSIONS.MANAGE_PAYROLL);
  return requireTenantAuth(ctx, draft.orgId, required);
}

async function inspectVoid(ctx: QueryCtx, draft: Opening) {
  await assertOrgEconomicallyActive(ctx, draft.orgId);
  const org = await ctx.db.get(draft.orgId);
  if (orgResetState(org).inProgress || org?.openingCleanupPayableScan || org?.openingCleanupReferenceScan) refuseOpeningChange("OPENING_VOID_CONFLICT");
  if (draft.status !== "POSTED" || !draft.journalEntryId) refuseOpeningChange("OPENING_CHANGE_STATE");
  const source = await loadOpeningSourceIdentity(ctx, draft.orgId);
  if (source.status !== "AVAILABLE" || source.parent._id !== draft._id) refuseOpeningChange("OPENING_VOID_CONFLICT");
  const original = await ctx.db.get(draft.journalEntryId);
  if (!original || original.status !== "POSTED" || original.reversedByJournalEntryId) refuseOpeningChange("OPENING_VOID_CONFLICT");
  const lines = await openingJournalLines(ctx, draft, original);
  if (!lines) refuseOpeningChange("OPENING_VOID_CONFLICT");
  const period = await getOpenPeriodForDate(ctx, draft.orgId, draft.asOfDate);
  if (!period || period._id !== original.periodId) refuseOpeningChange("OPENING_VOID_PERIOD");
  if (await openingLedgerHasActivity(ctx, draft.orgId, original._id)) refuseOpeningChange("OPENING_VOID_ACTIVITY");
  const [event, queued, signoff, plans] = await Promise.all([
    ctx.db.query("accountingEvents").withIndex("by_org", q => q.eq("orgId", draft.orgId)).first(),
    ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", q => q.eq("orgId", draft.orgId)).first(),
    ctx.db.query("accountingCutoverSignOffs").withIndex("by_org", q => q.eq("orgId", draft.orgId)).first(),
    ctx.db.query("openingManagementSettlementPlans").withIndex("by_org_opening_status", q => q.eq("orgId", draft.orgId).eq("openingDraftId", draft._id)).first(),
  ]);
  if (event || queued) refuseOpeningChange("OPENING_VOID_ACTIVITY");
  if (signoff || plans) refuseOpeningChange("OPENING_VOID_CONFLICT");
  const targets = await prepareOpeningVoidTargets(ctx, draft);
  await assertNoOpeningVoidReferences(ctx, draft.orgId, new Set(targets.map(target => String(target.id))), new Set(lines.map(line => String(line._id))));
  return { original, lines, periodId: period._id, targets };
}

export const requestVoid = mutation({
  args: { orgId: v.id("organizations"), draftId: v.id("openingBalanceDrafts"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => openingChangeBoundary(async () => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const draft = await requireOwnedRow(ctx, args.orgId, "openingBalanceDrafts", args.draftId);
    const { user } = await requireOpeningMaintenanceAuthority(ctx, draft);
    if (draft.status === "VOIDED" && await verifiedOpeningVoidPair(ctx, draft)) return null;
    const reason = args.reason.trim();
    if (!reason || reason.length > 500) refuseOpeningChange("OPENING_VOID_REASON");
    await inspectVoid(ctx, draft);
    // Stable identity is the posted draft. A retry cannot replace the requester
    // or reason behind a different approver's screen.
    if (draft.voidRequest) return null;
    await ctx.db.patch(draft._id, { voidRequest: { requestedBy: user._id, requestedAt: Date.now(), reason } });
    await auditLog(ctx, { orgId: args.orgId, actorId: user._id, actionType: "REQUEST_OPENING_VOID", resourceType: "openingBalanceDrafts",
      resourceId: String(draft._id), description: "Opening balance void requested.", after: { reason, journalEntryId: draft.journalEntryId } });
    return null;
  }),
});

async function postVoidReversal(ctx: MutationCtx, draft: Opening, plan: Awaited<ReturnType<typeof inspectVoid>>, actorId: Id<"users">) {
  const now = Date.now();
  const reversalId = await ctx.db.insert("journalEntries", {
    orgId: draft.orgId, periodId: plan.periodId, journalNumber: `OB-VOID-${String(draft._id).slice(-10).toUpperCase()}`,
    accountingDate: draft.asOfDate, sourceType: "openingBalanceVoid", sourceId: String(draft._id), category: "REVERSAL",
    memo: draft.voidRequest!.reason, status: "POSTED", currency: draft.currency, reversalOfJournalEntryId: plan.original._id,
    postedBy: actorId, postedAt: now, createdAt: now,
  });
  await inTurn(plan.lines, async line => {
    await ctx.db.insert("journalLines", { orgId: draft.orgId, journalEntryId: reversalId, lineNumber: line.lineNumber,
      accountId: line.accountId, debitMinor: line.creditMinor, creditMinor: line.debitMinor, currency: line.currency, scale: line.scale,
      accountingDate: draft.asOfDate, bankAccountId: line.bankAccountId, description: line.description });
    await incrementAccountSnapshot(ctx, { orgId: draft.orgId, accountId: line.accountId, periodId: plan.periodId,
      currency: line.currency, debitMinor: line.creditMinor, creditMinor: line.debitMinor });
  });
  await ctx.db.patch(plan.original._id, { status: "REVERSED", reversedByJournalEntryId: reversalId });
  return reversalId;
}

export const approveVoid = mutation({
  args: { orgId: v.id("organizations"), draftId: v.id("openingBalanceDrafts") },
  returns: v.object({ reversalJournalId: v.id("journalEntries") }),
  handler: async (ctx, args) => openingChangeBoundary(async () => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const draft = await requireOwnedRow(ctx, args.orgId, "openingBalanceDrafts", args.draftId);
    const { user } = await requireOpeningMaintenanceAuthority(ctx, draft);
    if (!draft.voidRequest) refuseOpeningChange("OPENING_CHANGE_STATE");
    if (draft.voidRequest.requestedBy === user._id) refuseOpeningChange("OPENING_CHANGE_SECOND_PERSON");
    if (draft.status === "VOIDED") {
      const pair = await verifiedOpeningVoidPair(ctx, draft);
      if (!pair) refuseOpeningChange("OPENING_VOID_CONFLICT");
      return { reversalJournalId: pair.reversalId };
    }
    const plan = await inspectVoid(ctx, draft);
    await removeOpeningVoidTargets(ctx, plan.targets);
    const reversalJournalId = await postVoidReversal(ctx, draft, plan, user._id);
    await ctx.db.patch(draft._id, { status: "VOIDED", voidRequest: { ...draft.voidRequest,
      approvedBy: user._id, approvedAt: Date.now(), reversalJournalEntryId: reversalJournalId } });
    await auditLog(ctx, { orgId: args.orgId, actorId: user._id, actionType: "APPROVE_OPENING_VOID", resourceType: "openingBalanceDrafts",
      resourceId: String(draft._id), description: "Opening balance and its native allocations voided together.",
      after: { requestedBy: draft.voidRequest.requestedBy, reason: draft.voidRequest.reason, reversalJournalId } });
    return { reversalJournalId };
  }),
});

type OpeningVisibility = { userId: Id<"users">; canViewCosts: boolean; canManagePayroll: boolean };

async function editableOpening(ctx: QueryCtx, draft: Opening | null, visibility: OpeningVisibility) {
  if (!draft || draft.createdBy !== visibility.userId || !visibility.canViewCosts) return null;
  if (!visibility.canManagePayroll && await openingNeedsPayroll(ctx, draft)) return null;
  return { _id: draft._id, version: draft.version ?? 0, lines: draft.lines, asOfDate: draft.asOfDate, memo: draft.memo, allocations: draft.allocations, currency: draft.currency };
}

async function openingVoidCapability(ctx: QueryCtx, draft: Opening | null, visibility: OpeningVisibility) {
  const withheld = { postedDraftId: null, canRequestVoid: false, canApproveVoid: false, voidReason: null };
  if (!draft || !visibility.canViewCosts) return withheld;
  if (!visibility.canManagePayroll && await openingNeedsPayroll(ctx, draft)) return withheld;
  let allowed = false;
  try { await inspectVoid(ctx, draft); allowed = true; }
  catch (error) {
    if (!(error instanceof ConvexError)) console.error("Opening void eligibility unavailable", error);
  }
  return { postedDraftId: draft._id, canRequestVoid: allowed && !draft.voidRequest,
    canApproveVoid: allowed && !!draft.voidRequest && draft.voidRequest.requestedBy !== visibility.userId,
    voidReason: draft.voidRequest?.reason ?? null };
}

/** Permission-filtered form content and capability. Commands repeat inspection. */
export const status = query({
  args: { orgId: v.id("organizations") },
  returns: v.object({
    editable: v.union(v.null(), v.object({ _id: v.id("openingBalanceDrafts"), version: v.number(), asOfDate: v.number(), memo: v.optional(v.string()),
      currency: v.optional(v.string()), allocations: v.optional(v.array(openingAllocationValidator)),
      lines: v.array(v.object({ accountId: v.id("chartOfAccounts"), debitMinor: v.number(), creditMinor: v.number(),
        description: v.optional(v.string()), bankAccountId: v.optional(v.id("bankAccounts")) })) })),
    postedDraftId: v.union(v.null(), v.id("openingBalanceDrafts")), canRequestVoid: v.boolean(), canApproveVoid: v.boolean(),
    voidReason: v.union(v.null(), v.string()),
  }),
  handler: async (ctx, args) => openingChangeBoundary(async () => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const owner = isSystemOwnerRole(role);
    const visibility = { userId: user._id,
      canViewCosts: owner || role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE),
      canManagePayroll: owner || role.permissions.includes(PERMISSIONS.MANAGE_PAYROLL) };
    const pending = await ctx.db.query("openingBalanceDrafts").withIndex("by_org_status", q => q.eq("orgId", args.orgId).eq("status", "PENDING_APPROVAL")).first();
    const posted = await ctx.db.query("openingBalanceDrafts").withIndex("by_org_status", q => q.eq("orgId", args.orgId).eq("status", "POSTED")).take(2);
    const draft = posted.length === 1 ? posted[0] : null;
    return { editable: await editableOpening(ctx, pending, visibility), ...await openingVoidCapability(ctx, draft, visibility) };
  }),
});
