import type { DealCostAccounting } from "./dealCostAccounting";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import {
  assertExpectedCurrency,
  assertRoomForAnotherLine,
  loadActiveFees,
  resolveDealCurrency,
} from "../settlementDeductions";
import { ConvexError, type Infer } from "convex/values";
import {
  APPLICATION_NOT_FOUND,
  assertDealEconomicsOpen,
  assertMayPostCustody,
  assertNotFuture,
  assertTimestamp,
} from "./dealCostGuards";
import {
  assertMinorAmount,
  feeAccountingTreatmentValidator,
  feePartyValidator,
  financeFeeTypeValidator,
  isMinorAmount,
} from "../financingEconomics";
import {
  assertFeeAttachmentCount,
  assertFeeDocWithinBytes,
  assertFeeTextWithinCap,
  MAX_FEE_DESCRIPTION_CHARS,
  MAX_FEE_RECEIPT_REFERENCE_CHARS,
  truncateFeeText,
} from "../feeDocLimits";
import { runWithIdempotency } from "../idempotency";
import { resolveFeeCustody } from "./custodyRecords";
import { syncCustodyFeePosting } from "./custodyPosting";

// ---------------------------------------------------------------------------
// Cost lines
// ---------------------------------------------------------------------------

/**
 * Re-derives the deal's stored economics once a SETTLEMENT INPUT has changed
 * (SCRUM-407 P1.3) — in the same transaction, and only AFTER the fee row is
 * written, so the expected remittance is derived from the line as it now
 * stands rather than from the one it replaced.
 *
 * Material means a line the finance company withholds from its transfer
 * (`deductedFromSettlement`): those are the only lines
 * `settlementDeductedTotalMinor` sums into the remittance. A line the
 * dealership pays separately changes no stored figure, so it does not bump
 * `economicsRevision` under a confirmation somebody is looking at. Custody-
 * only changes (charging a line to custody, opening or reopening a record)
 * never reach here: they move no settlement input.
 *
 * This replaced the recompute `classifyDealAccounting` ran at the moment it
 * stamped a deal: with the stamp retired, finalization's plan-time
 * `REMITTANCE_STALE` check would otherwise refuse every deal whose deducted
 * costs changed after its approval. A refusal inside the recompute is left
 * uncaught, so it rolls the fee write back with it.
 */
export async function recomputeAfterSettlementInputChange(
  ctx: MutationCtx,
  applicationId: Id<"financeApplications">,
  deductedFromSettlement: boolean,
  accounting: DealCostAccounting
): Promise<void> {
  if (!deductedFromSettlement) return;
  await accounting.recomputeEconomicsForApplication(ctx, applicationId);
}

export async function recordDealFeeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    feeType: Infer<typeof financeFeeTypeValidator>;
    description?: string;
    estimatedAmountMinor?: number;
    actualAmountMinor?: number;
    paidBy: Infer<typeof feePartyValidator>;
    paidTo: Infer<typeof feePartyValidator>;
    accountingTreatment: Infer<typeof feeAccountingTreatmentValidator>;
    includedInQuotation?: boolean;
    deductedFromSettlement?: boolean;
    refundable?: boolean;
    custodyId?: Id<"financeDealCustody">;
    paidAt?: number;
    receiptReference?: string;
    documentStorageIds?: Array<Id<"_storage">>;
    source?: "COMPANY_TEMPLATE" | "MANUAL";
    expectedCurrency: string;
    idempotencyKey: string;
  },
  accounting: DealCostAccounting
) {
  const auth = await requireTenantAuth(ctx, args.orgId, [
    PERMISSIONS.CREATE_FINANCE_APPLICATION,
  ]);
  const user = auth.user;
  assertExpectedCurrency(args.expectedCurrency, "recording this cost");
  // A configured fee's line is written by `recordTemplateFeeActual` alone,
  // which copies the finance company's policy from the deal's frozen
  // snapshot. Minting the COMPANY_TEMPLATE source here would let a caller
  // author a line that reads exactly like one — feeType, description,
  // expectation and all — and have the checklist and the closure gate treat
  // a configured fee as recorded on the caller's say-so.
  if (args.source === "COMPANY_TEMPLATE") {
    throw new ConvexError(
      "A configured fee is recorded through the deal's checklist, against the finance company's own template — not as a typed line. Record the actual for the configured fee, or record this as an additional cost."
    );
  }
  // Inline rather than behind a helper: scripts/tenantWriteGuard only accepts
  // proof it can see inside the handler, and "the ownership check is
  // somewhere else" is the exact shape that shipped two Criticals.
  const app = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeApplications",
    args.applicationId,
    APPLICATION_NOT_FOUND
  );

  if (args.estimatedAmountMinor !== undefined) {
    assertMinorAmount(args.estimatedAmountMinor, "Estimated amount");
  }
  if (args.actualAmountMinor !== undefined) {
    assertMinorAmount(args.actualAmountMinor, "Actual amount");
  }
  // A line with neither figure is allowed — "there will be a transfer fee,
  // amount unknown" is a real state, and one worth recording rather than
  // leaving to memory. It just cannot close the deal; see requireCostsClosable.

  // Free text is bounded at the input boundary, BEFORE anything is judged or
  // written, so a line this writer admits can always take every later write
  // (pay, void, reconcile, custody) inside MAX_FEE_DOC_BYTES (SCRUM-443 v6).
  assertFeeTextWithinCap(args.description?.trim(), MAX_FEE_DESCRIPTION_CHARS, "The description", "recording this cost");
  assertFeeTextWithinCap(args.receiptReference?.trim(), MAX_FEE_RECEIPT_REFERENCE_CHARS, "The receipt reference", "recording this cost");
  assertTimestamp(args.paidAt, "The paid date");
  assertNotFuture(args.paidAt, Date.now(), "The paid date");
  // A line charged to custody posts a custody journal: custody authority.
  if (args.custodyId) assertMayPostCustody(auth, "Charging a cost to an employee's custody");

  // A cost line is additive: a retried submit does not overwrite anything, it
  // adds a second real charge, and `actualTotalMinor` rises by an amount
  // nobody spent. Every other money-recording surface in this codebase
  // (expenses, deposits, the cash drawer) already takes a key for exactly
  // this; there is no reason a deal's costs should be the one that does not.
  // Ownership and permission are checked above, outside the wrapper, so a
  // replay is still authorized rather than trusting the stored result.
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "financeDealCosts.recordDealFee",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // The command's WHOLE persisted input, normalised exactly as it is
      // stored below (SCRUM-319 / AF-215-02). The previous fingerprint
      // omitted description, paidAt, includedInQuotation, refundable, the
      // attachments and the source — so a retry carrying a different
      // description or payment date under the same key replayed the first
      // row's id and silently dropped the operator's second intent. Same
      // key + same intent replays; same key + any changed field refuses.
      fingerprint: JSON.stringify({
        applicationId: args.applicationId,
        feeType: args.feeType,
        expectedCurrency: args.expectedCurrency,
        description: args.description?.trim() || null,
        estimatedAmountMinor: args.estimatedAmountMinor ?? null,
        actualAmountMinor: args.actualAmountMinor ?? null,
        paidBy: args.paidBy,
        paidTo: args.paidTo,
        accountingTreatment: args.accountingTreatment,
        includedInQuotation: args.includedInQuotation ?? false,
        // Persisted below and summed by settlementDeductedTotalMinor, so it
        // changes the dealer remittance. Two fees identical except for this
        // flag are DIFFERENT economic instructions.
        deductedFromSettlement: args.deductedFromSettlement ?? false,
        refundable: args.refundable ?? false,
        custodyId: args.custodyId ?? null,
        paidAt: args.paidAt ?? null,
        receiptReference: args.receiptReference?.trim() || null,
        documentStorageIds: args.documentStorageIds?.map((id) => id.toString()) ?? null,
        source: args.source ?? "MANUAL",
      }),
    },
    async () => {
      // ⚠️ Every MUTABLE-state check lives inside the section (Codex
      // AF-CUST-06): a replay of a line that was written must return it
      // even if the deal froze, the custody closed or the org's currency
      // moved since — those refusals describe the world after the success
      // they would otherwise deny. Caller authority and the input's own
      // shape stay outside, where a replay is still authorized.
      assertDealEconomicsOpen(app, "adding a cost");
      // The deal's denomination, proven BEFORE any write: the pin when
      // there is one, else the org's verified currency — which the first
      // cost line then fixes, because `orgSettings.upsert` refuses to
      // change it once this row exists. Resolved before the custody
      // record is, because the line's currency is what that record must
      // match (R5, F4).
      const currency = await resolveDealCurrency(ctx, app, "recording this cost");
      if (args.expectedCurrency !== currency) {
        throw new ConvexError(
          `This cost was entered in ${args.expectedCurrency}, but the deal's costs are kept in ${currency}. Reload the deal and enter the amount in ${currency}.`
        );
      }
      let custodyId: Id<"financeDealCustody"> | undefined;
      if (args.custodyId) {
        custodyId = await resolveFeeCustody(ctx, args.orgId, args.applicationId, args.custodyId, {
          paidBy: args.paidBy,
          deductedFromSettlement: args.deductedFromSettlement ?? false,
          accountingTreatment: args.accountingTreatment,
          currency,
        }, user._id, accounting);
      }
      // An exact replay of a line already recorded returns it above this,
      // and a NEW line on a deal already at the live-line cap is refused
      // with nothing written and no command record kept.
      assertRoomForAnotherLine(await loadActiveFees(ctx, args.applicationId), "recording this cost");

      const now = Date.now();
      const newFee = {
        orgId: args.orgId,
        applicationId: args.applicationId,
        feeType: args.feeType,
        description: args.description?.trim() || undefined,
        currency,
        estimatedAmountMinor: args.estimatedAmountMinor,
        actualAmountMinor: args.actualAmountMinor,
        paidBy: args.paidBy,
        paidTo: args.paidTo,
        accountingTreatment: args.accountingTreatment,
        includedInQuotation: args.includedInQuotation ?? false,
        deductedFromSettlement: args.deductedFromSettlement ?? false,
        refundable: args.refundable ?? false,
        custodyId,
        paidAt: args.paidAt,
        receiptReference: args.receiptReference?.trim() || undefined,
        documentStorageIds: args.documentStorageIds,
        source: args.source ?? "MANUAL",
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      };
      // Judged on the resulting row, before anything is written (SCRUM-443).
      assertFeeAttachmentCount(args.documentStorageIds, "recording this cost");
      assertFeeDocWithinBytes(newFee, "recording this cost");
      const feeId = await ctx.db.insert("financeDealFees", newFee);
      // Inside the idempotent section with the insert: a replay returns the
      // stored id above and never posts a second time.
      if (custodyId) await syncCustodyFeePosting(ctx, feeId, user._id, "Handover cost recorded against custody.");
      // AFTER the insert, so the stored remittance is derived from the line
      // just written (SCRUM-407 P1.3).
      await recomputeAfterSettlementInputChange(ctx, args.applicationId, args.deductedFromSettlement ?? false, accounting);
      return feeId;
    }
  );
}

/**
 * Records the ACTUAL paid for a fee the finance company's frozen policy
 * configures — the only thing an operator enters on a configured row (owner
 * product correction, #scrum-215 2026-09-12 21:05).
 *
 * The caller names WHICH configured fee, by its position in the application's
 * frozen `companyRuleSnapshot.feeTemplates`, and the amount they paid. Every
 * other field of the line — the expected amount, description, who pays, who is
 * paid, the quotation and settlement flags, the accounting treatment — is
 * copied from that snapshot entry HERE. The client restates none of the
 * company's policy and cannot author an expectation: the line's
 * `estimatedAmountMinor` is the template's, so a receipt that differs from it
 * is a comparison, never a rewrite.
 *
 * The position is the reference because the snapshot is immutable per
 * application, so it is exact even when two templates are identical — a name
 * would be ambiguous there; a position is not. It is validated the way
 * `v.number()` does not: a safe non-negative integer inside the array, and the
 * `feeType` the caller saw must be the one at that position (a stale reference
 * from an older render is refused, not silently re-pointed). Stored on the
 * line so the checklist can match it back exactly.
 *
 * One live line per position. A second recording against the same position
 * is refused and directed to `recordActualFeeAmount` on the existing line —
 * the same rule keeps a retry honest: the same key with the same intent
 * replays the first line's id; a new key against an existing line is refused
 * inside the idempotent section, so nothing is committed. Voiding the line
 * (audited) frees the position again.
 *
 * Not a new way to spend. The row it writes is an ordinary `financeDealFees`
 * line with the same fates as every other: re-recorded through
 * `recordActualFeeAmount`, checked through `reconcileDealFee`, voided through
 * `voidDealFee`, recomputing the stored economics like any other cost, summed
 * by `summarizeFees` and by `settlementDeductedTotalMinor` under the template's
 * own `deductedFromSettlement` flag.
 */
export async function recordTemplateFeeActualHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    templateIndex: number;
    feeType: Infer<typeof financeFeeTypeValidator>;
    actualAmountMinor: number;
    expectedCurrency: string;
    paidAt?: number;
    receiptReference?: string;
    documentStorageIds?: Array<Id<"_storage">>;
    custodyId?: Id<"financeDealCustody">;
    idempotencyKey: string;
  },
  accounting: DealCostAccounting
) {
  const auth = await requireTenantAuth(ctx, args.orgId, [
    PERMISSIONS.CREATE_FINANCE_APPLICATION,
  ]);
  const user = auth.user;
  assertExpectedCurrency(args.expectedCurrency, "recording this cost");
  const app = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeApplications",
    args.applicationId,
    APPLICATION_NOT_FOUND
  );

  // The reference, validated positively. `v.number()` admits NaN, Infinity,
  // negatives and fractions, and every one of them indexes an array to
  // `undefined` without a word.
  if (!Number.isSafeInteger(args.templateIndex) || args.templateIndex < 0) {
    throw new ConvexError(
      `The configured fee reference must be a non-negative whole number (got ${args.templateIndex}).`
    );
  }
  const templates = app.companyRuleSnapshot?.feeTemplates ?? [];
  if (app.companyRuleSnapshot === undefined || templates.length === 0) {
    throw new ConvexError(
      "This deal's finance company configured no fees when the deal was created, so there is no configured fee to record an actual for. Record it as an additional cost instead."
    );
  }
  if (args.templateIndex >= templates.length) {
    throw new ConvexError(
      `This deal's finance company configured ${templates.length} fee(s); there is no configured fee at position ${args.templateIndex}. Reload the deal.`
    );
  }
  const template = templates[args.templateIndex];
  if (template.feeType !== args.feeType) {
    throw new ConvexError(
      "The configured fee at that position is not the one you were shown. Reload the deal and record the actual against the fee as it is now listed."
    );
  }
  assertMinorAmount(args.actualAmountMinor, "Actual amount");
  if (args.custodyId) assertMayPostCustody(auth, "Charging a configured fee to an employee's custody");
  // The template's estimate is COPIED onto the line below — only when it is
  // a readable figure. A frozen snapshot is never rewritten, so a corrupt
  // estimate (legacy or raw-edited; the schema admits it) is neither
  // repaired nor propagated: the line is written WITHOUT an estimate, the
  // checklist keeps reporting the expected amount as unreadable, and the
  // real actual still satisfies the configured-position gate — the
  // operator is not stranded on a position nobody can record against.
  const estimatedAmountMinor = isMinorAmount(template.estimatedAmountMinor)
    ? template.estimatedAmountMinor
    : undefined;
  // A timestamp, not a number: `v.number()` admits NaN, Infinity and
  // negatives, and a stored NaN date is a row no report can order.
  assertFeeTextWithinCap(args.receiptReference?.trim(), MAX_FEE_RECEIPT_REFERENCE_CHARS, "The receipt reference", "recording this cost");
  assertTimestamp(args.paidAt, "The paid date");
  assertNotFuture(args.paidAt, Date.now(), "The paid date");

  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "financeDealCosts.recordTemplateFeeActual",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // The WHOLE persisted input, position included: the same key against a
      // different position, amount, date, reference, attachment or custody
      // is a different intent and is refused, not replayed.
      fingerprint: JSON.stringify({
        applicationId: args.applicationId,
        templateIndex: args.templateIndex,
        feeType: args.feeType,
        expectedCurrency: args.expectedCurrency,
        actualAmountMinor: args.actualAmountMinor,
        custodyId: args.custodyId ?? null,
        paidAt: args.paidAt ?? null,
        receiptReference: args.receiptReference?.trim() || null,
        documentStorageIds: args.documentStorageIds?.map((id) => id.toString()) ?? null,
      }),
    },
    async () => {
      // Mutable-state checks inside the section, as in `recordDealFee`
      // (Codex AF-CUST-06): the freeze, the custody's state and the deal's
      // denomination are judged for a NEW intent, never for a replay.
      assertDealEconomicsOpen(app, "recording a configured fee's actual");
      const currency = await resolveDealCurrency(ctx, app, "recording this cost");
      if (args.expectedCurrency !== currency) {
        throw new ConvexError(
          `This cost was entered in ${args.expectedCurrency}, but the deal's costs are kept in ${currency}. Reload the deal and enter the amount in ${currency}.`
        );
      }
      let custodyId: Id<"financeDealCustody"> | undefined;
      if (args.custodyId) {
        // The line is written in the deal's currency; the record must match it.
        custodyId = await resolveFeeCustody(ctx, args.orgId, args.applicationId, args.custodyId, { ...template, currency }, user._id, accounting);
      }
      // A replay of the SAME intent returns the line it already wrote
      // before reaching this, while
      // a NEW intent against a position that already has a live line is
      // refused here and rolls back with nothing committed. Proven on the
      // live-position index with every field an equality and `.unique()`:
      // a second live line at one position is a state this writer never
      // creates, and if one is ever found the read refuses rather than picks.
      const existing = await ctx.db
        .query("financeDealFees")
        .withIndex("by_application_source_templateIndex_voidedAt", (q) =>
          q
            .eq("applicationId", args.applicationId)
            .eq("source", "COMPANY_TEMPLATE")
            .eq("templateIndex", args.templateIndex)
            .eq("voidedAt", undefined)
        )
        .unique();
      if (existing) {
        throw new ConvexError(
          "An actual is already recorded for this configured fee. Edit that line to change the amount, or remove it first."
        );
      }
      // Same bound as `recordDealFee`, in the same place: before the line
      // exists.
      assertRoomForAnotherLine(await loadActiveFees(ctx, args.applicationId), "recording this cost");

      const now = Date.now();
      const templateFee = {
        orgId: args.orgId,
        applicationId: args.applicationId,
        feeType: template.feeType,
        // Copied from the frozen snapshot, which a deal's operator cannot edit
        // and a manual line can never stand in for (the configured-position
        // gate matches by position). A legacy over-long description is
        // therefore SHORTENED to the cap, never refused — a refusal would
        // strand the position with no door (SCRUM-443 v6). The snapshot keeps
        // the full text; the identity flag is display-only.
        description: truncateFeeText(template.description?.trim() ?? "", MAX_FEE_DESCRIPTION_CHARS) || undefined,
        currency,
        // The template's expectation, copied — never the caller's, and
        // never a corrupt one (see above).
        estimatedAmountMinor,
        actualAmountMinor: args.actualAmountMinor,
        paidBy: template.paidBy,
        paidTo: template.paidTo,
        accountingTreatment: template.accountingTreatment,
        includedInQuotation: template.includedInQuotation,
        deductedFromSettlement: template.deductedFromSettlement,
        refundable: template.refundable,
        custodyId,
        paidAt: args.paidAt,
        receiptReference: args.receiptReference?.trim() || undefined,
        documentStorageIds: args.documentStorageIds,
        source: "COMPANY_TEMPLATE" as const,
        templateIndex: args.templateIndex,
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      };
      assertFeeAttachmentCount(args.documentStorageIds, "recording this cost");
      assertFeeDocWithinBytes(templateFee, "recording this cost");
      const feeId = await ctx.db.insert("financeDealFees", templateFee);
      if (custodyId) await syncCustodyFeePosting(ctx, feeId, user._id, "Configured fee actual recorded against custody.");
      await recomputeAfterSettlementInputChange(ctx, args.applicationId, template.deductedFromSettlement, accounting);
      return feeId;
    }
  );
}
