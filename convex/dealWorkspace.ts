import { v } from "convex/values";
import type { ApiFromModules, FunctionReturnType } from "convex/server";
import { query } from "./_generated/server";
import { api } from "./_generated/api";
import { pendingDepositResolution } from "./applications";
import { requireOwnedRow } from "./utils/tenancy";
import { selectActiveAppraisal } from "./utils/financingEconomics";
import type { Doc } from "./_generated/dataModel";
import type * as applicationsModule from "./applications";

/**
 * The financed cockpit payload, derived from its single authority.
 *
 * Deliberately NOT `FunctionReturnType<typeof api.applications.dealCockpit>`,
 * which is how a component would ask the same question. Inside `convex/`, the
 * generated `api` includes THIS module, so annotating this module's own return
 * type through `api` is circular: resolving `api` needs `typeof dealWorkspace`,
 * which needs the annotation, which needs `api`. TypeScript reports it as
 * TS7022/TS7023 and degrades `financedDealCockpit` to `any` — which then poisons
 * `api` for every other file. Measured, not assumed: it took the Convex
 * typecheck from 0 errors to 967.
 *
 * Building a one-module api slice from `typeof applicationsModule` asks the
 * exact same question of the exact same authority without ever mentioning the
 * generated `api`, so there is no cycle to break. The alternative — restating
 * the cockpit's shape as a literal type or a `returns:` validator — would fork
 * the payload contract and is precisely what this module must not do.
 */
type ApplicationsApi = ApiFromModules<{ applications: typeof applicationsModule }>;
type DealCockpitPayload = NonNullable<
  FunctionReturnType<ApplicationsApi["applications"]["dealCockpit"]>
>;

/**
 * Who actually valued this car, when that is known.
 *
 * `null` is a real answer and not a missing one: a deal with no appraisal yet,
 * or one carrying only a dealer estimate, genuinely has no active appraiser.
 * `DEALER_ESTIMATE` is deliberately NOT representable here — an estimate is not
 * an appraisal, `selectActiveAppraisal` never returns one, and the display must
 * not be able to present it as either party's work.
 */
export type ActiveAppraisalProvider = "FINANCE_COMPANY" | "INDEPENDENT" | null;

/**
 * Narrows the stored provider type to the two values this screen may speak for.
 *
 * Written as an explicit match rather than a cast so that adding a fourth
 * `providerType` to the schema is a TYPE ERROR here instead of a new value
 * silently reaching the UI as if it were an appraiser.
 */
function activeAppraisalProviderFor(
  appraisal: Doc<"financeAppraisals"> | undefined
): ActiveAppraisalProvider {
  if (appraisal === undefined) return null;
  switch (appraisal.providerType) {
    case "FINANCE_COMPANY":
      return "FINANCE_COMPANY";
    case "INDEPENDENT":
      return "INDEPENDENT";
    // `selectActiveAppraisal` filters estimates out, so this is unreachable —
    // and it stays here so that it CANNOT become reachable silently.
    case "DEALER_ESTIMATE":
      return null;
  }
}

/** The cockpit payload, unchanged, plus the two facts P3 adds. */
export type FinancedDealCockpit = DealCockpitPayload & {
  pendingDepositResolution: boolean;
  activeAppraisalProvider: ActiveAppraisalProvider;
};

/**
 * The Unified Deal read model for a FINANCED deal.
 *
 * This module exists for one structural reason, not an architectural one:
 * `convex/applications.ts` carries seven historical non-indexed query filters
 * that predate the repository's Convex lint rule, and the guard evaluates the
 * whole projected file — so that file is effectively immutable, and the
 * cockpit's read model cannot grow a new field in place. Rather than refactor
 * accounting-adjacent queries as a side effect of a UI change, or duplicate the
 * cockpit, the new field is composed on top of the existing authority here.
 *
 * `applications.dealCockpit` remains authoritative for its ENTIRE payload —
 * money, stages, authority, redaction, economics, settlement. Nothing in this
 * module recomputes, reinterprets or re-redacts any of it.
 *
 * No `returns:` validator, matching `applications.dealCockpit` itself: writing
 * one means hand-transcribing that whole payload here, which is the shape fork
 * this module exists to avoid. The return type is pinned above instead.
 */
export const financedDealCockpit = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args): Promise<FinancedDealCockpit | null> => {
    /**
     * Composed on the SERVER, in ONE read snapshot — deliberately not two
     * `useQuery` calls in the component.
     *
     * `ctx.runQuery` runs the nested query inside this query's own read
     * snapshot. Two independent client subscriptions would each settle on their
     * own snapshot and could disagree transiently: the deposit flag saying a
     * rejected deal is still holding customer cash while the cockpit beside it
     * has already moved on, or the reverse. For a field whose entire job is to
     * say "this deal is holding money nobody has decided about", a transient
     * disagreement is not a cosmetic flicker — it is the screen contradicting
     * itself about custody of real cash.
     *
     * This call also carries the authorization. `dealCockpit` performs the only
     * `requireTenantAuth` in this path and returns `null` for a missing
     * application or one belonging to another org, so there is exactly ONE
     * authorization boundary and this wrapper does not widen it.
     */
    const cockpit = await ctx.runQuery(api.applications.dealCockpit, {
      orgId: args.orgId,
      applicationId: args.applicationId,
    });
    if (cockpit === null) return null;

    /**
     * Read AFTER the cockpit, and through `requireOwnedRow` rather than a raw
     * `ctx.db.get`.
     *
     * A non-null cockpit already proves the caller is authorized for this org
     * and that the application belongs to it, and `ctx.runQuery` shares this
     * query's snapshot, so this guard cannot fire at this revision. It is here
     * anyway because TEN-1 is not conditional: any handler taking both an
     * `orgId` and a caller-supplied document id proves ownership of the row it
     * reads, locally. Without it this handler has no boundary of its own and
     * inherits one entirely — so a future weakening of `dealCockpit` would open
     * a second public door onto a foreign deal, and its pending-cash flag, with
     * nothing here to refuse it. The repo learned that shape from two shipped
     * cross-tenant Criticals; `scripts/tenantWriteGuard.test.ts` only scans
     * WRITES, so a read path like this one is exactly where it recurs unseen.
     *
     * This replaces a `return null` on a missing row with a throw. That branch
     * is unreachable behind a non-null cockpit, so no caller's behaviour
     * changes — see the wrong-org and foreign-id tests.
     */
    const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", args.applicationId);

    /**
     * Indexed by application, never scanned, and re-scoped to the caller's org
     * in memory.
     *
     * The index alone would be enough at this revision — the rows hang off an
     * application this handler has just proven the caller owns — but the org
     * check costs one comparison and means a mis-keyed or cross-org row can
     * never contribute provenance to somebody else's deal.
     */
    const appraisals = (
      await ctx.db
        .query("financeAppraisals")
        .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
        .collect()
    ).filter((row) => row.orgId === args.orgId);
    const activeAppraisal = selectActiveAppraisal(appraisals);

    return {
      ...cockpit,
      /**
       * Whether this deal is holding customer money nobody has decided about.
       *
       * Answered by the single exported rule in `applications.ts` — the same one
       * `applications.list` uses for its `DEPOSIT_PENDING` badge. Not reproduced
       * here: this predicate has already been written three different ways in
       * this codebase, and the cockpit disagreeing with the list about held cash
       * is the defect this field exists to close.
       */
      pendingDepositResolution: await pendingDepositResolution(ctx, app),
      /**
       * Whose move the APPRAISAL stage actually is.
       *
       * The rail classifies APPRAISAL as an EXTERNAL stage, and the screen used
       * to render every external stage as the finance company's — while the
       * stage's own definition says it may be "valued by the finance company OR
       * an independent appraiser". A deal appraised independently therefore told
       * the operator it was waiting on the finance company, which is precisely
       * the signal this rail exists to give.
       *
       * Answered from recorded provenance, never inferred from financing state:
       * a deal HAVING a finance company says nothing about who performed its
       * valuation.
       */
      activeAppraisalProvider: activeAppraisalProviderFor(activeAppraisal),
    };
  },
});
