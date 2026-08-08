import { v, ConvexError } from "convex/values";
import { query, MutationCtx, QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import {
  assertMinorAmount,
  assertPercent,
  buildRuleSnapshot,
  customerContributionSettlementValidator,
  dealerContributionSettlementValidator,
  financeFeeTemplateValidator,
  ltvBasisValidator,
} from "./utils/financingEconomics";
import { PERCENT_DECIMAL_PLACES, percentRoundsToZero } from "../lib/financingEconomics";

/**
 * The dealer-side purchase rules, as create/update accept them.
 *
 * Separate from the customer-loan terms above them (profitRate, maxTermMonths,
 * insuranceRate…) because they describe a different transaction: the company
 * buying the vehicle from the dealership, rather than the loan it sells the
 * customer. Every one is optional, so the existing companies keep working and a
 * dealership adopts them at its own pace.
 */
const dealerRuleArgs = {
  defaultLtvPercent: v.optional(v.number()),
  minimumLtvPercent: v.optional(v.number()),
  ltvBasis: v.optional(ltvBasisValidator),
  minimumCustomerFirstPaymentMinor: v.optional(v.number()),
  allowedAppraisalVariancePercent: v.optional(v.number()),
  allowsQuotationAboveAppraisal: v.optional(v.boolean()),
  lowerAppraisalTolerancePercent: v.optional(v.number()),
  quotationExceptionApproval: v.optional(
    v.union(v.literal("AUTOMATIC"), v.literal("MANUAL"))
  ),
  dealerContributionSettlement: v.optional(dealerContributionSettlementValidator),
  customerContributionSettlement: v.optional(customerContributionSettlementValidator),
  feesDeductedFromSettlement: v.optional(v.boolean()),
  customerFirstPaymentOffsetsUnfinancedShare: v.optional(v.boolean()),
  feeTemplates: v.optional(v.array(financeFeeTemplateValidator)),
} as const;

type DealerRuleArgs = {
  defaultLtvPercent?: number;
  minimumLtvPercent?: number;
  maxFinancingLTV?: number;
  minimumCustomerFirstPaymentMinor?: number;
  allowedAppraisalVariancePercent?: number;
  lowerAppraisalTolerancePercent?: number;
  feeTemplates?: Array<{ estimatedAmountMinor: number }>;
};

/**
 * Rejects rule values that would make the economics engine throw later, at a
 * point where the user has no idea which company setting caused it.
 *
 * v.number() accepts NaN and Infinity, and NaN defeats every range comparison
 * (NaN > 100 is false), so each check is written to reject rather than accept.
 */
function assertDealerRulesValid(rules: DealerRuleArgs): void {
  for (const [value, label] of [
    [rules.defaultLtvPercent, "Default LTV"],
    [rules.minimumLtvPercent, "Minimum LTV"],
    [rules.maxFinancingLTV, "Maximum LTV"],
    [rules.allowedAppraisalVariancePercent, "Allowed appraisal variance"],
    [rules.lowerAppraisalTolerancePercent, "Lower-appraisal tolerance"],
  ] as const) {
    if (value !== undefined) assertPercent(value, label);
  }

  // assertPercent allows zero, which is right for a tolerance and wrong for an
  // LTV: resolveAppliedLtv rejects anything <= 0, so a company saved with a
  // zero default or maximum passes validation here and then fails every single
  // quote later, with an error naming the deal instead of the setting.
  for (const [value, label] of [
    [rules.defaultLtvPercent, "Default LTV"],
    [rules.maxFinancingLTV, "Maximum LTV"],
  ] as const) {
    if (value === undefined) continue;
    if (value <= 0) {
      throw new ConvexError(`${label} must be greater than 0 (got ${value}).`);
    }
    // Validated at the same precision the arithmetic uses, by asking the engine
    // rather than restating its scale here. A value like 0.0000001 is positive
    // and would pass, then round to zero at the engine's scale — so the company
    // saves cleanly and every later quotation throws on a division by zero
    // instead.
    if (percentRoundsToZero(value)) {
      throw new ConvexError(
        `${label} of ${value}% rounds to zero at the ${PERCENT_DECIMAL_PLACES} decimal places the financing calculations keep, so it cannot be used.`
      );
    }
  }

  const minimum = rules.minimumLtvPercent;
  const maximum = rules.maxFinancingLTV;
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new ConvexError(
      `Minimum LTV (${minimum}%) cannot exceed maximum LTV (${maximum}%).`
    );
  }
  // A default outside its own bounds is the setting that silently blocks every
  // quote later, with an error naming the deal rather than the configuration.
  const preferred = rules.defaultLtvPercent;
  if (preferred !== undefined) {
    if (minimum !== undefined && preferred < minimum) {
      throw new ConvexError(
        `Default LTV (${preferred}%) is below the minimum of ${minimum}%.`
      );
    }
    if (maximum !== undefined && preferred > maximum) {
      throw new ConvexError(
        `Default LTV (${preferred}%) is above the maximum of ${maximum}%.`
      );
    }
  }

  if (rules.minimumCustomerFirstPaymentMinor !== undefined) {
    assertMinorAmount(rules.minimumCustomerFirstPaymentMinor, "Minimum customer first payment");
  }
  for (const template of rules.feeTemplates ?? []) {
    assertMinorAmount(template.estimatedAmountMinor, "Fee template estimated amount");
  }
}

/**
 * Writes the immutable rule version an application will snapshot.
 *
 * One row per change, so a deal approved under last quarter's tolerance keeps
 * pointing at last quarter's tolerance no matter how the company is edited
 * afterwards.
 */
async function writeRuleVersion(
  ctx: MutationCtx,
  companyId: Id<"financeCompanies">,
  orgId: Id<"organizations">,
  actorId: Id<"users">,
  note?: string
): Promise<void> {
  const company = await ctx.db.get(companyId);
  if (!company) return;
  await ctx.db.insert("financeCompanyRuleVersions", {
    orgId,
    companyId,
    version: company.ruleVersion ?? 1,
    snapshot: buildRuleSnapshot(company),
    note,
    createdAt: Date.now(),
    createdBy: actorId,
  });
}

/**
 * Checks the accepted-status ids on a finance company and returns the set worth
 * storing.
 *
 * The two failure modes are not the same thing and must not be treated alike:
 *
 *  - A status that exists but belongs to **another org** is a cross-tenant
 *    reference. That still throws.
 *  - A status id that resolves to **nothing** is a dangling reference to a row
 *    that has since been deleted. `orgCustomerStatuses.remove` used to
 *    hard-delete without clearing these references, leaving every finance
 *    company that accepted that status holding an id pointing at no row. That
 *    delete now cascades, so this case is about the rows it already created,
 *    which stay in the data until each company is next saved.
 *
 * Throwing on the second case bricked the record. The edit dialog seeds its form
 * from the company's stored `acceptedStatuses`, and its checkbox list only
 * renders statuses that still exist — so a dangling id was invisible in the UI,
 * impossible to untick, and re-sent on every save. The company could never be
 * edited again, and deleting the statuses and re-creating them made it worse:
 * the new rows get new ids while the company still holds the old ones.
 *
 * Dropping a dangling id leaks nothing by itself — it names no document — and is
 * the only outcome that lets the record heal on the next save. Note the
 * asymmetry it creates, though: throwing now means "this id is a live row in
 * some other org" and succeeding means "no such row exists anywhere", where
 * previously both cases threw the same message. That tells an owner whether an
 * arbitrary id exists in the deployment, and nothing more — no field of it is
 * readable — which is an acceptable trade for making the record recoverable.
 */
async function sanitizeAcceptedStatuses(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  statusIds?: Id<"orgCustomerStatuses">[]
): Promise<Id<"orgCustomerStatuses">[] | undefined> {
  if (!statusIds) return undefined;

  const live: Id<"orgCustomerStatuses">[] = [];
  for (const statusId of statusIds) {
    const status = await ctx.db.get(statusId);
    if (status && status.orgId !== orgId) {
      throw new ConvexError("Accepted customer status not found in this organization.");
    }
    if (status) live.push(statusId);
  }
  return live;
}

// --- Finance Companies ---

export const listCompanies = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return await ctx.db
      .query("financeCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
  },
});

export const createCompany = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    profitRate: v.number(),
    maxTermMonths: v.number(),
    gracePeriodMonths: v.number(),
    insuranceRate: v.optional(v.number()),
    adminFees: v.optional(v.number()),
    commission: v.optional(v.number()),
    includesCommissionInDebt: v.optional(v.boolean()),
    maxFinancingLTV: v.optional(v.number()),
    isActive: v.boolean(),
    acceptedStatuses: v.optional(v.array(v.id("orgCustomerStatuses"))),
    ...dealerRuleArgs,
  },
  handler: async (ctx, args) => {
    const { user } = await requireOwner(ctx, args.orgId);
    assertDealerRulesValid(args);
    const acceptedStatuses = await sanitizeAcceptedStatuses(ctx, args.orgId, args.acceptedStatuses);
    const companyId = await ctx.db.insert("financeCompanies", {
      ...args,
      acceptedStatuses,
      ruleVersion: 1,
    });
    await writeRuleVersion(ctx, companyId, args.orgId, user._id, "Company created");
    return companyId;
  },
});

export const updateCompany = mutation({
  args: {
    id: v.id("financeCompanies"),
    orgId: v.id("organizations"),
    name: v.string(),
    profitRate: v.number(),
    maxTermMonths: v.number(),
    gracePeriodMonths: v.number(),
    insuranceRate: v.optional(v.number()),
    adminFees: v.optional(v.number()),
    commission: v.optional(v.number()),
    includesCommissionInDebt: v.optional(v.boolean()),
    maxFinancingLTV: v.optional(v.number()),
    isActive: v.boolean(),
    acceptedStatuses: v.optional(v.array(v.id("orgCustomerStatuses"))),
    ...dealerRuleArgs,
  },
  handler: async (ctx, args) => {
    const { user } = await requireOwner(ctx, args.orgId);
    const { id, orgId, ...updates } = args;

    const existing = await ctx.db.get(id);
    if (!existing || existing.orgId !== orgId) throw new ConvexError("Not found");
    // Writes back the sanitized list, so a company carrying ids of
    // since-deleted statuses is repaired the first time it is saved.
    const acceptedStatuses = await sanitizeAcceptedStatuses(ctx, orgId, updates.acceptedStatuses);

    // `acceptedStatuses` is optional, and Convex deletes a field patched to
    // `undefined`. Spreading it unconditionally would therefore erase a
    // company's restriction list for any caller that simply left the argument
    // out — silently widening it to "accepts every customer". Only write the
    // key when the caller actually sent one.
    //
    // The dealer-purchase rules need the same treatment for a sharper reason:
    // the existing settings dialog and the mobile app do not know these fields
    // exist yet and send none of them. If an omitted rule were written as
    // `undefined` it would be deleted, so saving a company's name from an older
    // client would silently wipe its LTV bounds and exception tolerance — and
    // the next deal would be quoted under `buildRuleSnapshot`'s conservative
    // defaults instead of the company's real terms, with nothing to show why.
    const dealerRuleKeys = Object.keys(dealerRuleArgs) as Array<keyof typeof dealerRuleArgs>;
    const presentDealerRules = Object.fromEntries(
      dealerRuleKeys
        .filter((key) => updates[key] !== undefined)
        .map((key) => [key, updates[key]])
    );
    for (const key of dealerRuleKeys) delete updates[key];

    // Validate the EFFECTIVE merged rules, not the caller's arguments.
    // Validating the arguments alone let a partial update persist an
    // impossible company: lowering maxFinancingLTV to 70 while an existing
    // minimum of 80 was preserved passed every check on the way in, then
    // produced a snapshot no LTV could ever satisfy — and every subsequent
    // quote for that company failed with an error about the deal.
    // Read from `args` rather than the erased `presentDealerRules` record so
    // each field keeps its own type instead of the union of all of them.
    const effectiveRules: DealerRuleArgs = {
      defaultLtvPercent: args.defaultLtvPercent ?? existing.defaultLtvPercent,
      minimumLtvPercent: args.minimumLtvPercent ?? existing.minimumLtvPercent,
      maxFinancingLTV: args.maxFinancingLTV ?? existing.maxFinancingLTV,
      minimumCustomerFirstPaymentMinor:
        args.minimumCustomerFirstPaymentMinor ?? existing.minimumCustomerFirstPaymentMinor,
      allowedAppraisalVariancePercent:
        args.allowedAppraisalVariancePercent ?? existing.allowedAppraisalVariancePercent,
      lowerAppraisalTolerancePercent:
        args.lowerAppraisalTolerancePercent ?? existing.lowerAppraisalTolerancePercent,
      feeTemplates: args.feeTemplates ?? existing.feeTemplates,
    };
    assertDealerRulesValid(effectiveRules);

    // Archive the terms the company operated under BEFORE this edit, when it
    // has never been versioned. Otherwise the first edit bumps straight to
    // version 2 and version 1 — the version every application snapshotted in
    // the meantime points at — is never written, leaving a permanent hole in
    // the audit chain the table exists to provide.
    const needsInitialVersion = existing.ruleVersion === undefined;

    const rulesChanged = dealerRuleKeys.some(
      (key) =>
        presentDealerRules[key] !== undefined &&
        JSON.stringify(presentDealerRules[key]) !== JSON.stringify(existing[key])
    ) || (updates.maxFinancingLTV !== undefined && updates.maxFinancingLTV !== existing.maxFinancingLTV);

    if (needsInitialVersion) {
      await ctx.db.patch(id, { ruleVersion: 1 });
      await writeRuleVersion(ctx, id, orgId, user._id, "Terms in force before dealer purchase rules were first edited");
    }

    await ctx.db.patch(id, {
      ...updates,
      ...presentDealerRules,
      ...(acceptedStatuses === undefined ? {} : { acceptedStatuses }),
      // Only bump on an actual rule change: a version per name edit would fill
      // the history with rows no deal was ever approved under.
      ...(rulesChanged ? { ruleVersion: (existing.ruleVersion ?? 1) + 1 } : {}),
    });

    if (rulesChanged) {
      await writeRuleVersion(ctx, id, orgId, user._id, "Dealer purchase rules updated");
    }
  },
});

export const deleteCompany = mutation({
  args: { 
    id: v.id("financeCompanies"),
    orgId: v.id("organizations"),
  },
  handler: async (ctx, { id, orgId }) => {
    const { user } = await requireOwner(ctx, orgId);
    const existing = await ctx.db.get(id);
    if (!existing || existing.orgId !== orgId) throw new ConvexError("Not found");
    await ctx.db.patch(id, {
      isActive: false,
      deactivatedAt: Date.now(),
      deactivatedBy: user._id,
    });
  },
});

// --- Vehicle Valuations ---

export const listValuations = query({
  args: { 
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles") 
  },
  handler: async (ctx, { orgId, vehicleId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_VEHICLES]);
    const vehicle = await ctx.db.get(vehicleId);
    if (!vehicle || vehicle.orgId !== orgId) throw new ConvexError("Vehicle not found in this organization.");
    return await ctx.db
      .query("vehicleValuations")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId))
      .filter((q) => q.eq(q.field("orgId"), orgId))
      .collect();
  },
});

export const saveValuation = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    companyId: v.id("financeCompanies"),
    valuationAmount: v.number(),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Gated on EDIT_VEHICLE_VALUATIONS rather than EDIT_VEHICLES so SALES can
    // keep finance-company valuations current directly. Everything else about a
    // vehicle still goes through the vehicleEdits approval flow for that role.
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLE_VALUATIONS]);
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    const company = await ctx.db.get(args.companyId);
    if (!company || company.orgId !== args.orgId) {
      throw new ConvexError("Finance company not found in this organization.");
    }

    // v.number() accepts NaN and Infinity, and NaN defeats every comparison
    // guard downstream (NaN < 0 is false), so reject them explicitly before
    // the value reaches the financing-limit maths.
    if (!Number.isFinite(args.valuationAmount) || args.valuationAmount < 0) {
      throw new ConvexError("Valuation amount must be a non-negative number.");
    }
    if (args.expiresAt !== undefined && !Number.isFinite(args.expiresAt)) {
      throw new ConvexError("Valuation expiry must be a valid timestamp.");
    }

    // Check if one already exists for this company
    const existing = await ctx.db
      .query("vehicleValuations")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", args.vehicleId))
      .filter((q) => q.eq(q.field("companyId"), args.companyId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        valuationAmount: args.valuationAmount,
        expiresAt: args.expiresAt,
      });
      return existing._id;
    } else {
      return await ctx.db.insert("vehicleValuations", {
        ...args,
      });
    }
  },
});
