import { IN_FLIGHT_FINANCE_STATUSES } from "../../utils/financeStatuses";
import { ConvexError } from "convex/values";
import { type MutationCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { releaseHoldForApplicationQuote } from "../../utils/depositHelpers";
import { assertNoPendingDepositRequest } from "../../utils/depositRequestGuards";
import { requireCommercialVehicle } from "../../utils/vehicleLiveness";
import { getOrgCurrency } from "../../accounting/workflowHooks";
import { assertSupportedDenomination } from "../../utils/money";
import {
  creditDecisionForStatus,
  handoverStatusForFacts,
} from "../../utils/financingEconomics";
import { readActiveApplicationDocuments } from "../../utils/activeApplicationDocuments";
import { resolveCreationEconomicsInputs } from "../../utils/creationEconomics";
import { releaseRootsForApplicationQuote } from "./cancellationTeardown";
import { type TenantAuthContext } from "../../utils/tenancy";

export type FinanceApplicationStatus =
  | "DRAFT"
  | "PENDING_DOCS"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "CLOSED"
  | "CANCELLED";

export const VALID_STATUS_TRANSITIONS: Record<
  FinanceApplicationStatus,
  readonly FinanceApplicationStatus[]
> = {
  DRAFT: ["PENDING_DOCS"],
  PENDING_DOCS: ["UNDER_REVIEW", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "PENDING_DOCS"],
  // APPROVED is terminal for this mutation on purpose. The only legitimate way
  // out of it is finalizeDeal, which patches CLOSED itself after creating the
  // sale — see the guard in updateStatus.
  APPROVED: [],
  REJECTED: ["PENDING_DOCS"],
  CLOSED: [],
  CANCELLED: [],
};

export async function assertRequiredApplicationDocumentsComplete(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes">,
) {
  const rules = await ctx.db
    .query("companyDocumentRules")
    .withIndex("by_org", (q) => q.eq("orgId", app.orgId))
    .collect();
  const requiredRules = rules.filter(
    (rule) =>
      rule.isRequired &&
      (!rule.companyId || rule.companyId === quote.companyId),
  );
  if (requiredRules.length === 0) return;

  const docs = await readActiveApplicationDocuments(ctx, app);
  const docsByRule = new Map(docs.map((doc) => [doc.ruleId, doc]));

  const missing = requiredRules
    .filter((rule) => {
      const doc = docsByRule.get(rule._id);
      return !doc || (doc.status !== "VERIFIED" && doc.status !== "WAIVED");
    })
    .map((rule) => rule.documentName);

  if (missing.length > 0) {
    throw new ConvexError(
      `Required finance documents must be verified or waived before approval: ${missing.join(", ")}`,
    );
  }
}

type RepairQuoteEconomicsLineageInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  expectedCurrency: string;
  dryRun: boolean;
};

/**
 * Repairs quote economics for an in-flight application created before those
 * facts were snapshotted. Dry-run and apply share the same guarded path; the
 * apply fills only absent values and records each field in the override audit.
 */
export async function executeRepairQuoteEconomicsLineage(
  ctx: MutationCtx,
  args: RepairQuoteEconomicsLineageInput,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes">,
  user: Doc<"users">,
) {
  if (!IN_FLIGHT_FINANCE_STATUSES.includes(app.status)) {
    throw new ConvexError(
      "Only an in-flight finance application can have quote lineage repaired.",
    );
  }
  if (
    app.submittedQuotationMinor !== undefined ||
    app.approvedDealerPurchaseAmountMinor !== undefined ||
    app.disbursedAt !== undefined ||
    app.finalizedSaleId !== undefined
  ) {
    throw new ConvexError(
      "Quotation, approval, disbursement, or finalization evidence already exists. Reconcile this application manually.",
    );
  }

  const orgCurrency = await getOrgCurrency(ctx, args.orgId);
  const expectedCurrency = args.expectedCurrency.trim().toUpperCase();
  if (!expectedCurrency || orgCurrency !== expectedCurrency) {
    throw new ConvexError(
      `Expected denomination ${expectedCurrency || "(blank)"} does not match the organization denomination ${orgCurrency}.`,
    );
  }
  if (
    app.economicsCurrency !== undefined &&
    app.economicsCurrency !== expectedCurrency
  ) {
    throw new ConvexError(
      `The application is already denominated in ${app.economicsCurrency}; it cannot be repaired as ${expectedCurrency}.`,
    );
  }
  if (app.companyId && !app.companyRuleSnapshot) {
    throw new ConvexError(
      "The application's frozen finance-company policy is missing. Reconcile the policy snapshot before repairing quotation economics.",
    );
  }
  assertSupportedDenomination(
    expectedCurrency,
    "repairing quote economics lineage",
  );

  const {
    targetSellingAmountMinor,
    customerFirstPaymentMinor,
    dealerBorneExpensesMinor,
  } = resolveCreationEconomicsInputs({
    quote,
    companyRuleSnapshot: app.companyRuleSnapshot,
    currency: expectedCurrency,
  });
  const expected = {
    economicsCurrency: expectedCurrency,
    targetSellingAmountMinor,
    targetNetProceedsMinor: targetSellingAmountMinor,
    customerFirstPaymentMinor,
    estimatedDealerBorneExpensesMinor: dealerBorneExpensesMinor,
    estimatedClosingExpensesMinor: dealerBorneExpensesMinor,
  };
  const existing = {
    economicsCurrency: app.economicsCurrency,
    targetSellingAmountMinor: app.targetSellingAmountMinor,
    targetNetProceedsMinor: app.targetNetProceedsMinor,
    customerFirstPaymentMinor: app.customerFirstPaymentMinor,
    estimatedDealerBorneExpensesMinor: app.estimatedDealerBorneExpensesMinor,
    estimatedClosingExpensesMinor: app.estimatedClosingExpensesMinor,
  };
  for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
    if (existing[field] !== undefined && existing[field] !== expected[field]) {
      throw new ConvexError(
        `${field} disagrees with the originating quote. No repair was applied.`,
      );
    }
  }
  const missing = (
    Object.keys(expected) as Array<keyof typeof expected>
  ).filter((field) => existing[field] === undefined);
  if (args.dryRun || missing.length === 0) {
    return { applied: false, missing, expected };
  }

  const now = Date.now();
  await ctx.db.patch(app._id, {
    ...(app.economicsCurrency === undefined
      ? { economicsCurrency: expected.economicsCurrency }
      : {}),
    ...(app.targetSellingAmountMinor === undefined
      ? { targetSellingAmountMinor: expected.targetSellingAmountMinor }
      : {}),
    ...(app.targetNetProceedsMinor === undefined
      ? { targetNetProceedsMinor: expected.targetNetProceedsMinor }
      : {}),
    ...(app.customerFirstPaymentMinor === undefined
      ? { customerFirstPaymentMinor: expected.customerFirstPaymentMinor }
      : {}),
    ...(app.estimatedDealerBorneExpensesMinor === undefined
      ? {
          estimatedDealerBorneExpensesMinor:
            expected.estimatedDealerBorneExpensesMinor,
        }
      : {}),
    ...(app.estimatedClosingExpensesMinor === undefined
      ? {
          estimatedClosingExpensesMinor: expected.estimatedClosingExpensesMinor,
        }
      : {}),
    // See `economicsRevision` in the schema. The repair can fill the first payment the funding
    // split is derived from, so a stamp read before it must stop matching (SCRUM-394). It refuses
    // once approval evidence exists, so there is no stored split or reconciliation reason to recompute.
    economicsRevision: (app.economicsRevision ?? 0) + 1,
    updatedAt: now,
  });
  for (const field of missing) {
    await ctx.db.insert("financeApplicationOverrides", {
      orgId: args.orgId,
      applicationId: app._id,
      field,
      previousValue: undefined,
      newValue: String(expected[field]),
      reason: `Backfilled from originating quote ${quote._id} by explicit quote-lineage repair.`,
      changedBy: user._id,
      changedAt: now,
    });
  }
  return { applied: true, missing, expected };
}

type UpdateStatusInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  status:
    | "DRAFT"
    | "PENDING_DOCS"
    | "UNDER_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "CLOSED";
};

export async function executeUpdateStatus(
  ctx: MutationCtx,
  args: UpdateStatusInput,
  app: Doc<"financeApplications">,
  auth: TenantAuthContext,
  requireStatusReview: () => Promise<unknown>,
  requireStatusApproval: () => Promise<unknown>,
  releaseRootIfNoLiveBasis: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      vehicleId: Id<"vehicles">;
      reason: string;
      decisionNow: number;
    },
  ) => Promise<void>,
) {
  // CLOSED is not a status you set; it is what finalizeDeal leaves behind
  // once it has created the sale, marked the vehicle sold, resolved deposits
  // and posted the accounting — and it always writes finalizedSaleId with it.
  // Setting it here skipped every one of those preconditions and produced a
  // CLOSED application with no sale, which finalizeDeal then rejects forever
  // because it requires APPROVED. The deal could never be completed.
  if (args.status === "CLOSED") {
    throw new ConvexError(
      "An application is closed by finalizing the deal, not by setting its status. Use finalizeDeal.",
    );
  }

  const allowedNextStatuses = VALID_STATUS_TRANSITIONS[app.status];
  if (!allowedNextStatuses.includes(args.status)) {
    throw new ConvexError(
      `Invalid finance application status transition: ${app.status} -> ${args.status}.`,
    );
  }

  if (args.status === "UNDER_REVIEW" || args.status === "REJECTED") {
    await requireStatusReview();
  }

  // SCRUM-444 DA-03: rejecting ends the deal like cancelling does.
  if (args.status === "REJECTED" && app.status !== "REJECTED") {
    await assertNoPendingDepositRequest(ctx, {
      orgId: args.orgId,
      quoteId: app.quoteId,
      action: "reject this application",
    });
  }

  // SCRUM-195 PHASE-3 DEMOLITION MARKER — THIS DOOR FAILS CLOSED ON PURPOSE.
  //
  // Re-entering the in-flight set means the application is finance-LIVE again
  // while nothing holds its car: `hasLiveCommitmentBasis` reads the status and
  // says held, `resolveOwnership` reads the root and says FREE. The damage is
  // not the theft case — a rival is independently refused at completion. It is
  // the case with NO rival: the car really is free, the completion barrier
  // correctly passes, and `consumeRootForSale` finds no OPEN root and returns
  // silently BY DESIGN, so the financed sale completes carrying no
  // `consumedBySaleId` — the one stamp Phase 3 uses to walk a cancelled sale
  // back to the deal that made it.
  //
  // ⚠️ THE FIX IS NOT REACQUISITION HERE. Reacquiring the car at this door was
  // implemented and rejected on a phase boundary, not on its correctness:
  // restoring a commitment is Phase-3 work, and Phase 3 defines the canonical
  // restoration and provenance semantics (which episode comes back, what its
  // predecessor is, how a sale-consumed episode is restored exactly). A
  // Phase-2 reacquisition would have to guess all of that, and a guess that
  // writes roots is how the distributed inference this program exists to
  // delete got built in the first place.
  //
  // ⚠️ SO THE CAPABILITY IS DEFERRED, NOT DELETED. `REJECTED -> PENDING_DOCS`
  // remains a real product requirement and stays in `VALID_STATUS_TRANSITIONS`
  // as the record of it; it is Phase 3 that restores it, over canonical
  // restoration rather than a fresh acquisition. Until then this branch
  // refuses rather than shipping a live application that owns nothing.
  //
  // Derived from the status list rather than from `VALID_STATUS_TRANSITIONS`,
  // so a future edit to the transition map cannot open a second door this
  // refusal does not cover. Today only REJECTED -> PENDING_DOCS re-enters the
  // set, but that is an outcome of the data, not an assumption in here.
  //
  // ⚠️ AND IT REFUSES **BEFORE** ANY DURABLE MUTATION. Convex would roll the
  // whole mutation back from anywhere, but "the rollback saves us" is a
  // property of the runtime, not of this handler. Refusing above the patch and
  // the status-log insert means the application, its audit trail, its roots
  // and claims, the vehicle and every money/accounting/outbox consequence are
  // untouched by construction rather than by recovery.
  const wasInFlight = IN_FLIGHT_FINANCE_STATUSES.includes(app.status);
  const isInFlight = IN_FLIGHT_FINANCE_STATUSES.includes(args.status);
  if (!wasInFlight && isInFlight) {
    throw new ConvexError(
      "This application has already left the finance pipeline and cannot be reopened yet. Start a new application for this deal.",
    );
  }

  let approvedBy = app.approvedBy;
  let approvedAt = app.approvedAt;

  if (args.status === "APPROVED") {
    await requireStatusApproval();
    if (auth.user._id === app.salespersonId) {
      throw new ConvexError("You cannot approve your own application");
    }
    const quote = await ctx.db.get(app.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throw new ConvexError("Application quote not found.");
    }
    // SCRUM-641 (D-35): approval is new authority over the car; see convex/utils/vehicleLiveness.ts.
    requireCommercialVehicle(await ctx.db.get(app.vehicleId), args.orgId);
    await assertRequiredApplicationDocumentsComplete(ctx, app, quote);
    approvedBy = auth.user._id;
    approvedAt = Date.now();
  }

  const patchedAt = Date.now();
  const nextFacts = { ...app, status: args.status };
  await ctx.db.patch(args.applicationId, {
    status: args.status,
    updatedAt: patchedAt,
    approvedBy,
    approvedAt,
    // The dimensions have to move with the status that drives them. Setting
    // them once at creation and never again left a normally-completed deal
    // reading creditDecision=SUBMITTED and handoverStatus=BLOCKED forever,
    // with the backfill skipping it because creditDecision was already set —
    // a wrong value is harder to find than a missing one.
    creditDecision: creditDecisionForStatus(args.status),
    handoverStatus: handoverStatusForFacts(nextFacts),
    ...(args.status === "REJECTED" &&
    app.gapResolution === "PENDING_NEGOTIATION"
      ? { gapResolution: "FAILED" as const }
      : {}),
  });

  await ctx.db.insert("applicationStatusLog", {
    orgId: args.orgId,
    applicationId: args.applicationId,
    fromStatus: app.status,
    toStatus: args.status,
    changedBy: auth.user._id,
    changedAt: patchedAt,
  });

  if (args.status === "REJECTED" && app.status !== "REJECTED") {
    await releaseHoldForApplicationQuote(ctx, {
      quoteId: app.quoteId,
      actorId: auth.user._id,
    });
    // The application has left the in-flight set and its quote's holds are
    // released, so this is the first moment the canonical answer can change.
    await releaseRootsForApplicationQuote(
      ctx,
      {
        orgId: args.orgId,
        quoteId: app.quoteId,
        decisionNow: patchedAt,
        reason: "finance application rejected",
      },
      releaseRootIfNoLiveBasis,
    );
  }
}
