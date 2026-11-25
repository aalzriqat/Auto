import { ConvexError } from "convex/values";
import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { mayReadFinanceEconomics } from "../../utils/financeApplicationProjection";
import {
  isForwardPlan,
  type FinancedSalePostingPlanV3,
} from "../../utils/financedSalePostingPlan";
import {
  resolveFinancedSalePlan,
  evaluateClosingReadiness,
  closingRefusalError,
  type ClosingReadiness,
  type ClosingReadinessCheck,
  type ClosingReadinessCheckKey,
} from "../../utils/financedSaleRecognition";
import {
  reasonOf,
  redactClosingReason,
  withheldReasonCode,
  type ClosingReadinessReason,
  type ClosingReadinessReasonCode,
  type ClosingReadinessReasonParams,
} from "../../../lib/closingReadinessReasonCodes";
import { getOrgCurrency } from "../../accounting/workflowHooks";
import { assertSupportedDenomination } from "../../utils/money";
import { assertApprovalExcessPostable } from "../../utils/approvalExcessProfit";
import { settlesDirectToSupplier } from "./settlementRouting";
import { type TenantAuthContext } from "../../utils/tenancy";

/**
 * The deal-level inputs the closing-readiness evaluator is judged on — the
 * settlement route and the currency — derived ONCE, by the same rule, for the
 * deal screen and the finalize door (SCRUM-407 P1.4), so the screen cannot show
 * READY on a deal the door refuses for its denomination.
 *
 * Refuses when the deal's denomination cannot be established, or when its
 * pinned `economicsCurrency` has drifted from the organization's current
 * currency: the plan and the receivable take the pin while the sale's own
 * journal posts in the org's CURRENT currency (completeSale), so finalizing
 * would recognise the plan's integers under the wrong label and open a debt the
 * receipt path settles in another currency (SCRUM-241). Pinning the economics
 * does not lock the org setting, so the two can have drifted apart. Nothing is
 * converted, relabelled or clipped; restoring the setting makes the same deal
 * ready.
 *
 * The refusal is RETURNED as a coded reason (SCRUM-414): the readiness query
 * serves it as `unavailableReason*`, and the finalize door throws it with
 * `closingRefusalError` — the same payload shape as the evaluator's refusals.
 */
export async function closingReadinessInputsOrRefusal(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  operation: string,
): Promise<
  | { ok: true; inputs: { settlesDirect: boolean; currency: string } }
  | { ok: false; refusal: ClosingReadinessReason }
> {
  // SCRUM-613: the seam every financed-plan door passes through (the payment to the finance company,
  // finalize, the readiness screen) refuses a deal whose approval has an excess, with the coded error.
  assertApprovalExcessPostable(app);
  try {
    assertSupportedDenomination(app.economicsCurrency, operation);
  } catch (error) {
    if (error instanceof ConvexError && typeof error.data === "string") {
      return {
        ok: false,
        refusal: reasonOf("READINESS_INPUTS_UNAVAILABLE", error.data),
      };
    }
    throw error;
  }
  const orgCurrencyNow = await getOrgCurrency(ctx, app.orgId);
  if (
    app.economicsCurrency !== undefined &&
    app.economicsCurrency !== orgCurrencyNow
  ) {
    return {
      ok: false,
      refusal: reasonOf(
        "READINESS_CURRENCY_DRIFT",
        `This deal's figures were recorded in ${app.economicsCurrency}, but the organization's currency is now ${orgCurrencyNow}. A deal is finalized in the currency its figures were recorded in — restore the organization's currency to ${app.economicsCurrency} before finalizing it.`,
        {
          recordedCurrency: app.economicsCurrency,
          orgCurrency: orgCurrencyNow,
        },
      ),
    };
  }
  return {
    ok: true,
    inputs: {
      settlesDirect: await settlesDirectToSupplier(ctx, app),
      currency: app.economicsCurrency ?? orgCurrencyNow,
    },
  };
}

/**
 * SCRUM-411 P2-01. The forward plan this deal WOULD freeze if it were finalized
 * now - the one derivation finalize itself uses, so the payment recorded before
 * finalizing and the gate finalize applies cannot disagree about H + D. Refuses
 * (like finalize) while the deal is not ready to close. `null`: no forward plan
 * covers the deal (a cash deal, no financier), so nothing is owed onward.
 */
export async function prospectiveForwardPlan(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  mayReadMoney: boolean,
): Promise<FinancedSalePostingPlanV3 | null> {
  const inputs = await closingReadinessInputsOrRefusal(
    ctx,
    app,
    "recording the payment to the finance company",
  );
  if (!inputs.ok)
    throw closingRefusalError(
      redactClosingReason(inputs.refusal, mayReadMoney, "WITHHELD_UNAVAILABLE"),
    );
  const plan = await resolveFinancedSalePlan(ctx, app, {
    ...inputs.inputs,
    mayReadMoney,
  });
  // `=== 3` (not the version predicate): a type guard on `plan.version` does not narrow `plan` itself.
  return plan !== undefined && isForwardPlan(plan) && plan.version === 3
    ? plan
    : null;
}

/** A readiness reason flattened onto the wire: the English diagnostic, the code, and params only when there are any. */
export type ClosingReasonView = {
  reason: string | null;
  reasonCode: ClosingReadinessReasonCode | null;
  reasonParams?: ClosingReadinessReasonParams;
};

export function closingReasonView(
  reason: ClosingReadinessReason | null,
): ClosingReasonView {
  return {
    reason: reason?.message ?? null,
    reasonCode: reason?.code ?? null,
    ...(reason?.params === undefined ? {} : { reasonParams: reason.params }),
  };
}

/** One readiness check as the deal screen is served it. */
export type ClosingReadinessCheckView = ClosingReasonView & {
  key: ClosingReadinessCheckKey;
  status: ClosingReadinessCheck["status"];
  /** The cost lines a BLOCKED check is about (`HANDOVER_COSTS_PAID`), by id — never amounts, so served whole below the finance tier. */
  feeIds?: string[];
};

type GetClosingReadinessInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
};

/**
 * The deal's automatic closing readiness (SCRUM-407 P1.4): the SAME evaluator,
 * fed by the same `closingReadinessInputsOrRefusal`, that `finalizeDeal` re-runs
 * internally — so on the closing-evidence checks listed here the screen and the
 * server cannot disagree, and the server never trusts the screen.
 *
 * It is NOT the whole finalize gate. `finalizeDeal` also enforces the workflow
 * preconditions the deal screen tracks elsewhere (handover, expected payment,
 * supplier route, required documents, quote match) and judges the operator's
 * deposit choice and the plan's own balance at the moment of finalizing; READY
 * here means the accounting evidence is complete, not that all of those pass.
 *
 * Read-only and never throws on the deal's own state: a verdict that cannot be
 * formed is reported as UNAVAILABLE with its reason. Money-bearing reasons are
 * scoped to the accounting-economics tier (`mayReadFinanceEconomics`: owner or
 * VIEW_FINANCE) — the SCRUM-117 read boundary, under which the dealer remittance
 * is a FINANCE-ONLY figure even for a role that confirms disbursements (the
 * boundary sweep in `financeApplicationBoundary.test.ts` covers this door):
 * below it every reason is a plain sentence, and
 * `moneyWithheld` says so explicitly rather than letting an absence stand for a
 * value (ACC-10).
 */
export async function executeGetClosingReadiness(
  ctx: QueryCtx,
  args: GetClosingReadinessInput,
  app: Doc<"financeApplications">,
  auth: TenantAuthContext,
) {
  const mayReadMoney = mayReadFinanceEconomics(auth.role);
  /** Whether this deal is still open to be finalized at all. */
  const open =
    app.status !== "CLOSED" &&
    app.status !== "CANCELLED" &&
    app.status !== "REJECTED";

  let readiness: ClosingReadiness = { state: "UNAVAILABLE", checks: [] };
  /** Why no verdict could be formed — set only when the evaluator refused. */
  let unavailable: ClosingReadinessReason | null = null;
  if (open) {
    try {
      const inputs = await closingReadinessInputsOrRefusal(
        ctx,
        app,
        "checking this deal's closing readiness",
      );
      if (inputs.ok)
        readiness = (await evaluateClosingReadiness(ctx, app, inputs.inputs))
          .readiness;
      else unavailable = inputs.refusal;
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      unavailable = reasonOf(
        "READINESS_INPUTS_UNAVAILABLE",
        typeof error.data === "string"
          ? error.data
          : "This deal's closing readiness cannot be determined from its current records.",
      );
    }
  }

  const checks: ClosingReadinessCheckView[] = readiness.checks.map(
    ({ key, status, reason, feeIds }) => ({
      key,
      status,
      ...(feeIds === undefined ? {} : { feeIds }),
      ...closingReasonView(
        redactClosingReason(reason, mayReadMoney, withheldReasonCode(key)),
      ),
    }),
  );
  const why = closingReasonView(
    redactClosingReason(unavailable, mayReadMoney, "WITHHELD_UNAVAILABLE"),
  );

  return {
    state: readiness.state,
    open,
    checks,
    unavailableReason: why.reason,
    unavailableReasonCode: why.reasonCode,
    ...(why.reasonParams === undefined
      ? {}
      : { unavailableReasonParams: why.reasonParams }),
    moneyWithheld: !mayReadMoney,
  };
}
