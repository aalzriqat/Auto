import type { Doc, Id } from "../../_generated/dataModel";
import { isMinorAmount } from "../financingEconomics";
import { feeTemplatesExceedConfigurationLimit } from "../dealCostLimits";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requireOwnedRow, requireOwner } from "../tenancy";
import { APPLICATION_NOT_FOUND } from "./dealCostGuards";
import { ConvexError } from "convex/values";

// ---------------------------------------------------------------------------
// Adopting a company's configured fees onto a deal frozen without them
// ---------------------------------------------------------------------------
export type FeeTemplateAdoptionState =
  /** The snapshot already carries templates — frozen at creation, or adopted. */
  | "NOT_NEEDED"
  /** No templates on the deal, the company has some, nothing blocks adoption. */
  | "AVAILABLE"
  /** No templates on the deal, and the company has none configured either. */
  | "COMPANY_HAS_NO_TEMPLATES"
  /** A manual-financier or legacy deal: no company row, or no rule snapshot to adopt into. */
  | "NO_COMPANY_SNAPSHOT"
  /** The company is deactivated: its policy is not adopted onto anything, whatever it says. */
  | "COMPANY_INACTIVE"
  /** A cost or custody row already exists — the deal has been costed without a policy. */
  | "BLOCKED_COSTS_RECORDED"
  /** The vehicle was handed over or the deal is closed/stopped — its costs are history. */
  | "BLOCKED_DEAL_PROGRESSED"
  /**
   * A stored company template carries an amount that is not a readable
   * minor-unit figure (legacy or raw-edited). The mutation refuses such a
   * policy, so the read never advertises it as adoptable.
   */
  | "COMPANY_TEMPLATES_UNREADABLE"
  /**
   * The company has more templates configured than the configuration policy
   * admits (`MAX_FEE_TEMPLATES`). The mutation refuses such a policy, so the
   * read never advertises it as adoptable; the company is repaired by an
   * explicit compliant list.
   */
  | "COMPANY_TEMPLATES_OVER_LIMIT";

export type FeeTemplateAdoption = {
  state: FeeTemplateAdoptionState;
  /** How many fees the company has configured RIGHT NOW — informational, never used as an expectation. */
  liveTemplateCount: number;
  liveRuleVersion: number | null;
  /** When and from which company revision templates were adopted, if they were. */
  adopted: { at: number; fromRuleVersion: number } | null;
};

/**
 * Whether the finance company's configured fees can be adopted onto this deal.
 *
 * The honest answer to "the company has fees configured but this deal says it
 * expects none". The snapshot is frozen at creation (owner ruling, #scrum-215
 * 2026-09-12) and a company configured AFTER that instant legitimately leaves
 * the deal with no expected fees. Reading the live company as if the deal had
 * always carried its fees would rewrite history; refusing to ever reconcile
 * the two strands a deal created a day too early. So the live state is
 * REPORTED here, and adoption is a separate, explicit, audited act with the
 * preconditions below — never a silent fallback in a read.
 *
 * The boundary is "before the first cost is recorded and before handover":
 * once a line, a custody record or a handover exists the deal has been costed
 * on the basis that nothing was expected, and adopting a policy under it
 * would retroactively make every closure gate demand actuals for fees nobody
 * planned. That deal keeps its honest "not configured" state.
 */
export function deriveFeeTemplateAdoption(args: {
  app: Doc<"financeApplications">;
  company: Doc<"financeCompanies"> | null;
  liveFeeCount: number;
  /** Whether ANY custody record exists — existence is all the boundary asks. */
  custodyRecorded: boolean;
}): FeeTemplateAdoption {
  const { app, company } = args;
  const snapshot = app.companyRuleSnapshot;
  const liveTemplates = company?.feeTemplates ?? [];
  const base = {
    liveTemplateCount: liveTemplates.length,
    liveRuleVersion: company ? (company.ruleVersion ?? 1) : null,
    adopted:
      snapshot?.feeTemplatesAdoptedAt !== undefined &&
      snapshot.feeTemplatesAdoptedFromRuleVersion !== undefined
        ? { at: snapshot.feeTemplatesAdoptedAt, fromRuleVersion: snapshot.feeTemplatesAdoptedFromRuleVersion }
        : null,
  };
  const state = ((): FeeTemplateAdoptionState => {
    if (snapshot !== undefined && (snapshot.feeTemplates?.length ?? 0) > 0) return "NOT_NEEDED";
    if (company === null || snapshot === undefined) return "NO_COMPANY_SNAPSHOT";
    if (company.isActive === false) return "COMPANY_INACTIVE";
    if (liveTemplates.length === 0) return "COMPANY_HAS_NO_TEMPLATES";
    // The same amount rule `adoptCompanyFeeTemplates` asserts: a read that
    // offered an action the mutation would refuse is a dead end on the screen.
    if (!liveTemplates.every((template) => isMinorAmount(template.estimatedAmountMinor))) {
      return "COMPANY_TEMPLATES_UNREADABLE";
    }
    // The same count predicate `assertFeeTemplatesWithinLimit` refuses on.
    if (feeTemplatesExceedConfigurationLimit(liveTemplates)) return "COMPANY_TEMPLATES_OVER_LIMIT";
    if (
      app.status === "CLOSED" ||
      app.status === "CANCELLED" ||
      app.status === "REJECTED" ||
      app.handoverStatus === "HANDED_OVER" ||
      app.vehicleHandoverAt !== undefined ||
      app.finalizedSaleId !== undefined
    ) {
      return "BLOCKED_DEAL_PROGRESSED";
    }
    if (args.liveFeeCount > 0 || args.custodyRecorded) return "BLOCKED_COSTS_RECORDED";
    return "AVAILABLE";
  })();
  return { state, ...base };
}

/**
 * The deal's finance company row, re-scoped to the org, or null when the deal
 * has none (a manual financier) or the row is gone.
 */
export async function companyFor(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">
): Promise<Doc<"financeCompanies"> | null> {
  if (app.companyId === undefined) return null;
  const company = await ctx.db.get(app.companyId);
  return company !== null && company.orgId === app.orgId ? company : null;
}

/**
 * Adopts the finance company's CURRENTLY configured fee templates onto a deal
 * whose rule snapshot was frozen without any.
 *
 * Explicit and owner-only — the same authority that edits the company's fees
 * (`finance.updateCompany` requires the owner). Audited with an override row
 * naming what was adopted and from which company revision, and the snapshot
 * itself records the adoption, so a later reader can tell "frozen with these
 * fees at creation" from "adopted these fees on <date> from version N".
 *
 * Refuses exactly where `deriveFeeTemplateAdoption` says it is not AVAILABLE,
 * from the same predicate, so the screen never offers an action the server
 * would reject. A snapshot that already carries templates is NEVER rewritten
 * here — this adopts INTO an empty slot, it does not replace.
 */
export async function adoptCompanyFeeTemplatesHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    reason: string;
  }
) {
  await requireOwner(ctx, args.orgId);
  await requireOwnedRow(
    ctx,
    args.orgId,
    "financeApplications",
    args.applicationId,
    APPLICATION_NOT_FOUND
  );
  const reason = args.reason.trim();
  if (!reason) {
    throw new ConvexError("Say why this deal is adopting the company's configured fees.");
  }
  throw new ConvexError(
    "Company fee templates have been retired. Deal execution fees are managed via Execution Fees (مصاريف التنفيذ)."
  );
}
