import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
// Read-only builder: it cannot write, so it may come from the raw module.
import { internalQuery } from "./_generated/server";
// ⚠️ SCRUM-987 F8 — the WRAPPED builder, never the raw one: its ctx.db fires
// the aggregate triggers. `aggregateWiring.test.ts` fails the build otherwise.
import { internalMutation } from "./functions";
import { hookCustodyCashReversed } from "./accounting/workflowHooks";
import { writeAuditLog } from "./utils/auditLog";
import { custodyEntryPostKey } from "./utils/custodySourceLedger";
import { assertFeeDocWithinBytes, assertFeeTextWithinCap, feeAfterPatch, MAX_FEE_VOID_REASON_CHARS } from "./utils/feeDocLimits";
import { assertReversalAllowed, recomputeCustodyTotals } from "./utils/financeDealCosts/custodyLedger";
import { syncCustodyFeePosting, syncCustodyPayable } from "./utils/financeDealCosts/custodyPosting";
import { inspectTarget, planCorrection } from "./utils/scrum987Inspection";
import { refuse } from "./utils/scrum987LedgerProof";
import {
  SCRUM987_EXPECTED_UTC_MONTH,
  SCRUM987_ORG_ID,
  SCRUM987_REASON,
  SCRUM987_TARGETS,
  type CorrectionTarget,
} from "./utils/scrum987Targets";
/**
 * SCRUM-987 slice 1 — one-time correction of three CANCELLED production deals.
 *
 * Owner ruling 2026-11-23: D-000012, D-000015 and D-000016 were input errors
 * ("paid once, recorded twice"). Every financial effect of their execution fee
 * and custody issuance is removed through the SAME system paths the app uses —
 * no manual journal:
 *
 *   (a) the fee is voided  -> `syncCustodyFeePosting` reverses CUSTODY_FEE_PAID;
 *   (b) the custody ISSUED entry is reversed -> `hookCustodyCashReversed` +
 *       `syncCustodyPayable`, exactly as `recordCustodyMovementHandler` does.
 *
 * ORDER MATTERS (F2): the fee goes first. Reversing the issuance while the
 * fee is still live drives the custody position negative and posts a spurious
 * EMPLOYEE_REIMBURSEMENTS_PAYABLE reclassification that nothing unwinds.
 *
 * Guards deliberately NOT applied, for these ids only (they exist to stop the
 * product's own doors on a finalized / closed record, which is exactly the
 * state being corrected): requireTenantAuth (the actor is passed explicitly and
 * re-proven below), assertDealEconomicsOpen, the RT11 finalized-movement door,
 * custody `status !== OPEN`, assertCustodyOpen. The custody row stays
 * RECONCILED with its sign-off metadata untouched (F6).
 *
 * Fail-closed shape: `planCorrection` reads only and proves every target;
 * `applyCorrection` writes only after the plan holds for ALL targets, then
 * reads the ledger back and throws (rolling the whole transaction back) when
 * the books do not show the effect (F1: the reversal hooks RETURN a
 * "DEFERRED" outcome instead of throwing, so a return value is never evidence).
 * Convex mutations are atomic: a throw discards every write of the call.
 */

export interface CorrectionResult {
  alreadyApplied: boolean;
  targets: Array<{ label: string; feeId: string; entryId: string; reversalEntryId?: string; amountMinor: number }>;
}

/** Whole-document equality as the database stores it — key order is irrelevant. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner
  );
}

/** The custody sign-off the correction must leave untouched (F6). */
const signoff = (custody: Doc<"financeDealCustody">): string =>
  stable({
    status: custody.status, reconciledAt: custody.reconciledAt, reconciledBy: custody.reconciledBy,
    reconciliationNotes: custody.reconciliationNotes,
  });

export async function applyCorrection(
  ctx: MutationCtx,
  args: {
    orgId: string;
    actorId: Id<"users">;
    targets: ReadonlyArray<CorrectionTarget>;
    reason: string;
    now: number;
    expectedUtcMonth: string;
  }
): Promise<CorrectionResult> {
  const plan = await planCorrection(ctx, args);
  if (plan.kind === "ALREADY_APPLIED") {
    return { alreadyApplied: true, targets: [] };
  }
  const { orgId, actor } = plan;
  const reason = args.reason.trim();
  assertFeeTextWithinCap(reason, MAX_FEE_VOID_REASON_CHARS, "The reason", "removing this cost");

  const results: CorrectionResult["targets"] = [];
  // Snapshots taken before the first write, parallel to plan.targets.
  const before: Array<{ app: string; signoff: string }> = [];
  for (const inspected of plan.targets) {
    const ids = inspected.ids;
    const [app, custody] = await Promise.all([ctx.db.get(ids.applicationId), ctx.db.get(ids.custodyId)]);
    before.push({ app: stable(app), signoff: signoff(custody!) });
  }

  for (const inspected of plan.targets) {
    const { target } = inspected;
    const ids = inspected.ids;
    const fee = (await ctx.db.get(ids.feeId))!;

    // (a) The fee void FIRST (F2) — same writes and same posting call as
    // voidDealFeeHandler, WITHOUT recomputeAfterSettlementInputChange (F4):
    // the deal's economics are frozen and nothing about them changes.
    const voidPatch = { voidedAt: args.now, voidedBy: args.actorId, voidReason: reason, updatedAt: args.now };
    assertFeeDocWithinBytes(feeAfterPatch(fee, voidPatch), "removing this cost");
    await ctx.db.patch(ids.feeId, voidPatch);
    await syncCustodyFeePosting(ctx, ids.feeId, args.actorId, `Handover cost removed: ${reason}`);

    // (b) The issuance reversal — the REVERSAL branch of
    // recordCustodyMovementHandler, minus the guards listed in the header.
    await assertReversalAllowed(ctx, orgId, ids.custodyId, ids.entryId, target.amountMinor);
    const reversalEntryId = await ctx.db.insert("financeDealCustodyEntries", {
      orgId,
      custodyId: ids.custodyId,
      kind: "REVERSAL",
      reversesEntryId: ids.entryId,
      amountMinor: target.amountMinor,
      note: reason,
      occurredAt: args.now,
      recordedBy: args.actorId,
      recordedAt: args.now,
    });
    await recomputeCustodyTotals(ctx, ids.custodyId);
    await hookCustodyCashReversed(ctx, {
      orgId,
      entryId: ids.entryId,
      kind: "ISSUED",
      reversalEntryId,
      reason,
      actorId: args.actorId,
      reversalDate: args.now,
    });
    await syncCustodyPayable(ctx, ids.custodyId, args.actorId, args.now, [
      { must: "OFF_BOOKS", idempotencyKey: custodyEntryPostKey(ids.entryId) },
    ]);
    await writeAuditLog(ctx, actor, {
      action: "SCRUM-987_CANCELLED_DEAL_REVERSAL",
      targetTable: "financeApplications",
      targetId: ids.applicationId,
      orgId,
      before: { feeId: ids.feeId, custodyId: ids.custodyId, entryId: ids.entryId, amountMinor: target.amountMinor },
      after: { reversalEntryId, reason },
    });
    results.push({
      label: inspected.label, feeId: ids.feeId, entryId: ids.entryId, reversalEntryId, amountMinor: target.amountMinor,
    });
  }

  // F1 — read the ledger back. Any mismatch throws and the whole call rolls back.
  for (const [i, planned] of plan.targets.entries()) {
    const { target } = planned;
    const after = await inspectTarget(ctx, orgId, args.actorId, target, plan.periodId);
    if (after.state !== "APPLIED") {
      return refuse(`SCRUM-987: read-back failed for ${target.label}; the books do not show the reversal. Rolled back.`, after);
    }
    const ids = after.ids;
    const snapshot = before[i];
    const [app, custody] = await Promise.all([ctx.db.get(ids.applicationId), ctx.db.get(ids.custodyId)]);
    if (stable(app) !== snapshot.app) return refuse(`SCRUM-987: the application document of ${target.label} changed (economics must not). Rolled back.`);
    if (signoff(custody!) !== snapshot.signoff) return refuse(`SCRUM-987: the custody sign-off of ${target.label} changed. Rolled back.`);
  }
  return { alreadyApplied: false, targets: results };
}

// ─── Thin internal doors ─────────────────────────────────────────────────────

/** Read-only: proves every target and reports what `applyScrum987` would do. Cannot write. */
export const planScrum987 = internalQuery({
  args: { actorId: v.id("users") },
  returns: v.any(),
  handler: async (ctx, { actorId }) => {
    const plan = await planCorrection(ctx, {
      orgId: SCRUM987_ORG_ID, actorId, targets: SCRUM987_TARGETS, now: Date.now(), expectedUtcMonth: SCRUM987_EXPECTED_UTC_MONTH,
    });
    // Report the plan; the loaded actor document is reduced to its id.
    return JSON.parse(JSON.stringify(plan.kind === "READY" ? { ...plan, actor: plan.actor._id } : plan)) as unknown;
  },
});

/**
 * `rehearse` performs EVERY write and read-back, then throws a ConvexError
 * carrying the result so the transaction rolls back (F10). `apply` commits.
 */
export async function runScrum987(
  ctx: MutationCtx,
  args: {
    actorId: Id<"users">;
    mode: "rehearse" | "apply";
    orgId: string;
    targets: ReadonlyArray<CorrectionTarget>;
    now: number;
    expectedUtcMonth: string;
    reason?: string;
  }
): Promise<CorrectionResult> {
  const result = await applyCorrection(ctx, {
    orgId: args.orgId, actorId: args.actorId, targets: args.targets, reason: args.reason ?? SCRUM987_REASON,
    now: args.now, expectedUtcMonth: args.expectedUtcMonth,
  });
  if (args.mode === "rehearse") {
    throw new ConvexError({ code: "SCRUM987_REHEARSAL_ROLLED_BACK", result: JSON.parse(JSON.stringify(result)) });
  }
  return result;
}

export const applyScrum987 = internalMutation({
  args: {
    actorId: v.id("users"),
    confirm: v.literal("SCRUM-987"),
    mode: v.union(v.literal("rehearse"), v.literal("apply")),
  },
  returns: v.any(),
  handler: async (ctx, { actorId, mode }) =>
    await runScrum987(ctx, {
      actorId, mode, orgId: SCRUM987_ORG_ID, targets: SCRUM987_TARGETS,
      now: Date.now(), expectedUtcMonth: SCRUM987_EXPECTED_UTC_MONTH,
    }),
});
