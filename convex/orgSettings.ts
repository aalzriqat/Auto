import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  currency: "JOD",
  currencySymbol: "د.أ",
  enabledPaymentTypes: ["CASH", "INSTALLMENT"],
};

/**
 * Currencies the app can actually denominate money in. This MUST stay a subset
 * of the scale table in `utils/money.ts` — `scaleForCurrency` silently falls
 * back to scale 2 for anything it doesn't recognise, so an unlisted code (say
 * "JD" for the Jordanian Dinar, which is really 3-decimal JOD) would store
 * every amount at the wrong scale. Combined with the change-lock below, that
 * mistake would be permanent. The settings UI offers exactly this list; this is
 * the server-side enforcement of it.
 */
export const SUPPORTED_CURRENCIES = [
  "JOD", "SAR", "AED", "KWD", "EGP", "QAR", "BHD", "OMR", "USD", "EUR", "GBP", "JPY",
] as const;

export function definedPatchFields(fields: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    patch[key] = value;
  }
  return patch;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns the orgSettings row for the given org, or null if not yet configured.
 */
export const get = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    // Return null gracefully during logout (brief window before redirect)
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    // Return null gracefully when activeOrgId from localStorage is stale
    // (e.g. different env, user removed from org, shared device) — the
    // OrgProvider will correct activeOrgId once orgs load.
    try {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);
    } catch {
      return null;
    }
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    return settings ?? null;
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Creates or updates orgSettings for the given org. Owner-only.
 */
export const upsert = mutation({
  args: {
    orgId: v.id("organizations"),
    currency: v.optional(v.string()),
    currencySymbol: v.optional(v.string()),
    vatRate: v.optional(v.number()),
    country: v.optional(v.string()),
    timezone: v.optional(v.string()),
    enabledPaymentTypes: v.optional(v.array(v.string())),
    logoStorageId: v.optional(v.id("_storage")),
    primaryColor: v.optional(v.string()),
    dealershipName: v.optional(v.string()),
    legalCompanyName: v.optional(v.string()),
    dealershipAddress: v.optional(v.string()),
    dealershipPhone: v.optional(v.string()),
    dealershipPhones: v.optional(v.array(v.string())),
    whatsappPhoneNumberId: v.optional(v.string()),
    whatsappApiToken: v.optional(v.string()),
    whatsappWebhookSecret: v.optional(v.string()),
    approvalThresholdEnabled: v.optional(v.boolean()),
    approvalMinProfitPercent: v.optional(v.number()),
    commissionTiers: v.optional(
      v.array(v.object({ minProfitAmount: v.number(), commissionPct: v.number() }))
    ),
    commissionMode: v.optional(v.union(v.literal("AUTO_TIERS"), v.literal("AUTO_MEMBER"), v.literal("MANUAL"))),
    generatedLeadAutoAssignmentEnabled: v.optional(v.boolean()),
    reservationHoldDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    if (args.reservationHoldDays !== undefined && args.reservationHoldDays <= 0) {
      throw new Error("Reservation hold days must be greater than zero.");
    }
    // The UI is a fixed <Select>, but this mutation is directly callable — and
    // an unrecognised code silently mis-scales every stored amount (see
    // SUPPORTED_CURRENCIES). Validate before the change-lock below runs.
    if (
      args.currency !== undefined &&
      !(SUPPORTED_CURRENCIES as readonly string[]).includes(args.currency)
    ) {
      throw new ConvexError(
        `Unsupported currency "${args.currency}". Supported: ${SUPPORTED_CURRENCIES.join(", ")}.`
      );
    }
    const touchesWhatsApp =
      args.whatsappPhoneNumberId !== undefined ||
      args.whatsappApiToken !== undefined ||
      args.whatsappWebhookSecret !== undefined;
    if (touchesWhatsApp) {
      await requireFeature(ctx, args.orgId, "whatsapp");
    }

    const existing = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    // Currency is load-bearing for every stored minor-unit amount (journal
    // lines, payroll, advances, receivables…). Changing it does NOT convert
    // any of them — 500.000 JOD would silently become 5,000.00 USD — so once
    // ANY financial record exists the currency is locked. (Fresh orgs can
    // still pick their currency during onboarding.)
    // The effective current currency is the stored one, or the JOD default when
    // no settings row exists yet (getOrgCurrency does the same). Checking this —
    // rather than `existing && ...` — closes the bypass where a legacy org with
    // financial records but no settings row creates its first row in a new
    // currency.
    const effectiveCurrentCurrency = existing?.currency ?? DEFAULT_SETTINGS.currency;
    if (
      args.currency !== undefined &&
      effectiveCurrentCurrency !== args.currency
    ) {
      // Any of these tables stores a minor-unit amount denominated in the org
      // currency (pendingAccountingEvents covers orgs whose chart isn't set up
      // yet — their events queue rather than post). If any row exists, the
      // currency is load-bearing and must not change without a migration.
      // `expenses` is included because a PENDING expense stores an amount but
      // posts no accounting event/transaction yet — switching currency and then
      // marking it paid would re-denominate the stored amount into the new one.
      // `openingBalanceDrafts` is included for the same reason `expenses` is: a
      // PENDING_APPROVAL draft stores minor-unit amounts denominated in the
      // currency they were entered in, but posts nothing yet. Without this, a
      // FRESH org — which is precisely the case this lock deliberately leaves
      // open for onboarding — could draft an opening balance in JOD, switch to
      // USD (no row in any other table yet), and approve it. Scale is
      // per-currency, so that re-denominates 1,000.000 JOD into 10,000.00 USD
      // across the org's entire starting position, silently and without
      // conversion.
      const [ledger, pending, txns, comp, advances, expenseRow, obDraft] = await Promise.all([
        ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first(),
        ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", args.orgId)).first(),
        ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first(),
        ctx.db.query("employeeCompensation").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first(),
        ctx.db.query("employeeAdvances").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first(),
        ctx.db.query("expenses").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first(),
        ctx.db
          .query("openingBalanceDrafts")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING_APPROVAL"))
          .first(),
      ]);
      if (ledger || pending || txns || comp || advances || expenseRow || obDraft) {
        throw new ConvexError(
          "The organization currency cannot be changed after financial records exist — stored amounts are not converted and would be misread. Contact support for a currency migration."
        );
      }
    }

    const { orgId, ...fields } = args;
    if (fields.dealershipPhones !== undefined) {
      fields.dealershipPhones = fields.dealershipPhones.map((phone) => phone.trim()).filter(Boolean);
    }

    if (existing) {
      const patch = definedPatchFields(fields);
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    } else {
      // Create with defaults merged in
      const newId = await ctx.db.insert("orgSettings", {
        orgId,
        currency: fields.currency ?? DEFAULT_SETTINGS.currency,
        currencySymbol: fields.currencySymbol ?? DEFAULT_SETTINGS.currencySymbol,
        enabledPaymentTypes:
          fields.enabledPaymentTypes ?? DEFAULT_SETTINGS.enabledPaymentTypes,
        vatRate: fields.vatRate,
        country: fields.country,
        timezone: fields.timezone,
        logoStorageId: fields.logoStorageId,
        primaryColor: fields.primaryColor,
        dealershipName: fields.dealershipName,
        legalCompanyName: fields.legalCompanyName,
        dealershipAddress: fields.dealershipAddress,
        dealershipPhone: fields.dealershipPhone,
        dealershipPhones: fields.dealershipPhones,
        whatsappPhoneNumberId: fields.whatsappPhoneNumberId,
        whatsappApiToken: fields.whatsappApiToken,
        whatsappWebhookSecret: fields.whatsappWebhookSecret,
        approvalThresholdEnabled: fields.approvalThresholdEnabled,
        approvalMinProfitPercent: fields.approvalMinProfitPercent,
        commissionTiers: fields.commissionTiers,
        commissionMode: fields.commissionMode,
        generatedLeadAutoAssignmentEnabled: fields.generatedLeadAutoAssignmentEnabled,
        reservationHoldDays: fields.reservationHoldDays,
      });
      return newId;
    }
  },
});

/**
 * Controls whether automated lead sources assign new leads to SALES members
 * in round-robin order. Owner-only because it changes routing behavior.
 */
export const setGeneratedLeadAutoAssignmentEnabled = mutation({
  args: {
    orgId: v.id("organizations"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    if (settings) {
      await ctx.db.patch(settings._id, {
        generatedLeadAutoAssignmentEnabled: args.enabled,
      });
      return settings._id;
    }

    return await ctx.db.insert("orgSettings", {
      orgId: args.orgId,
      currency: DEFAULT_SETTINGS.currency,
      currencySymbol: DEFAULT_SETTINGS.currencySymbol,
      enabledPaymentTypes: DEFAULT_SETTINGS.enabledPaymentTypes,
      generatedLeadAutoAssignmentEnabled: args.enabled,
    });
  },
});

/**
 * Returns the Convex storage URL for the org's logo, or null if not set.
 */
export const getLogoUrl = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    // Same graceful-degradation shape as `get` above: this renders in the
    // Sidebar/TopNav on every dashboard page, so a stale activeOrgId or a
    // mid-logout call must return null rather than throw. It must NOT return
    // another org's logo to a non-member, which is what having no guard at all
    // did — every caller is an authenticated dashboard surface.
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    try {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);
    } catch {
      return null;
    }

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings?.logoStorageId) return null;
    return await ctx.storage.getUrl(settings.logoStorageId);
  },
});

/**
 * Generates a short-lived upload URL for the org logo. Owner-only.
 */
export const generateLogoUploadUrl = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    return await ctx.storage.generateUploadUrl();
  },
});
