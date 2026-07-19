import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { hasPlanFeature } from "./subscriptions";
import { listOptedInDealerProfiles } from "./marketplaceDealers";
import { getPublishedSnapshotData, activePrimaryDomain } from "./websites";
import { calculateUnifiedMurabaha } from "../lib/financing";

const MAX_CANDIDATE_ORGS = 100;
// Bounds the merged cross-org result set — founding-dealer scale, same
// tradeoff as other marketplace list caps in this epic. Pagination below is
// a cursor over this bounded, per-request-recomputed merge, not a scan of
// the raw `vehicles` table (which stays untouched — vehicle data comes from
// each org's already-published site snapshot, per A2).
const MAX_MERGED_VEHICLES = 500;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;

// Phase 62 illustrative finance estimate — same 20%-down/60-month defaults
// the public dealer-site theme calculator uses (app/dealer-site/.../
// kinetic-shared.tsx estimateMonthlyInstallment), so a buyer sees a
// consistent number whether they're on a dealer's own site or browsing here.
const ESTIMATE_DOWN_PAYMENT_PCT = 20;
const ESTIMATE_TERM_MONTHS = 60;

const paymentTypeValidator = v.optional(v.union(v.literal("CASH"), v.literal("FINANCE")));

const sortByValidator = v.optional(
  v.union(v.literal("price_asc"), v.literal("price_desc"), v.literal("year_desc"), v.literal("mileage_asc"))
);
export type BrowseSortBy = "price_asc" | "price_desc" | "year_desc" | "mileage_asc";

const SORT_HI = Number.MAX_SAFE_INTEGER;
const SORT_LO = Number.MIN_SAFE_INTEGER;

/** Pure comparator for the merged result set. Missing values always sort to the end, whichever direction is chosen, so a price-less/mileage-less car never floats to the top. */
export function compareBrowseVehicles(
  a: { price: number | null; year: number; mileage: number | null },
  b: { price: number | null; year: number; mileage: number | null },
  sortBy: BrowseSortBy
): number {
  switch (sortBy) {
    case "price_desc":
      return (b.price ?? SORT_LO) - (a.price ?? SORT_LO);
    case "year_desc":
      return (b.year || 0) - (a.year || 0);
    case "mileage_asc":
      return (a.mileage ?? SORT_HI) - (b.mileage ?? SORT_HI);
    case "price_asc":
    default:
      return (a.price ?? SORT_HI) - (b.price ?? SORT_HI);
  }
}

type FinanceCompanyTerms = {
  profitRate: number;
  maxTermMonths: number;
  gracePeriodMonths: number;
  insuranceRate?: number;
  adminFees?: number;
  commission?: number;
  includesCommissionInDebt?: boolean;
};

/** Illustrative only — buyer hasn't picked their own down payment/term yet, so this uses the same default assumptions as the public dealer-site calculator. Returns null when the dealer has no active finance company to estimate against. */
function estimateMonthlyPayment(price: number, financeCompany: FinanceCompanyTerms | null): number | null {
  if (!financeCompany) return null;
  const downPayment = price * (ESTIMATE_DOWN_PAYMENT_PCT / 100);
  const termMonths = Math.min(ESTIMATE_TERM_MONTHS, financeCompany.maxTermMonths);
  const { monthlyInstallment } = calculateUnifiedMurabaha({
    vehiclePrice: price,
    downPayment,
    commission: financeCompany.commission ?? 0,
    processingFees: financeCompany.adminFees ?? 0,
    annualProfitRate: financeCompany.profitRate,
    annualInsuranceRate: financeCompany.insuranceRate ?? 0,
    termMonths,
    gracePeriodMonths: financeCompany.gracePeriodMonths,
    includesCommissionInDebt: financeCompany.includesCommissionInDebt ?? false,
  });
  return Math.round(monthlyInstallment);
}

type InspectionStatus = "NONE" | "SELF_REPORTED" | "PARTNER_VERIFIED";

type SnapshotVehicle = {
  id?: string;
  slug?: string;
  make?: string;
  model?: string;
  year?: number;
  trim?: string | null;
  mileage?: number | null;
  transmission?: string | null;
  fuelType?: string | null;
  exteriorColor?: string | null;
  price?: number | null;
  financePrice?: number | null;
  imageUrls?: string[];
  status?: string;
  inspectionStatus?: InspectionStatus;
  accidentDisclosed?: boolean | null;
  ownerCount?: number | null;
  dealerGuarantee?: boolean | null;
};

type BrowseVehicle = {
  orgId: Id<"organizations">;
  dealershipName: string;
  dealerBadges: string[];
  siteUrl: string | null;
  dealerPhone: string | null;
  dealerWhatsapp: string | null;
  id: string;
  slug: string;
  make: string;
  model: string;
  year: number;
  trim: string | null;
  mileage: number | null;
  transmission: string | null;
  fuelType: string | null;
  exteriorColor: string | null;
  price: number | null;
  financePrice: number | null;
  imageUrls: string[];
  financeAvailable: boolean;
  estimatedMonthlyPayment: number | null;
  inspectionStatus: InspectionStatus;
  accidentDisclosed: boolean | null;
  ownerCount: number | null;
  dealerGuarantee: boolean | null;
};

/** Public: cross-org vehicle search, unioning each opted-in dealer's already-published site inventory (master plan A2 — no new listings table). */
export const search = query({
  args: {
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    priceMin: v.optional(v.number()),
    priceMax: v.optional(v.number()),
    maxMonthlyPayment: v.optional(v.number()),
    city: v.optional(v.string()),
    paymentType: paymentTypeValidator,
    sortBy: sortByValidator,
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ vehicles: BrowseVehicle[]; continueCursor: string | null; isDone: boolean }> => {
    const numItems = Math.min(Math.max(args.numItems ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = args.cursor ? Number(args.cursor) || 0 : 0;
    const cityFilter = args.city?.trim().toLowerCase();
    const makeFilter = args.make?.trim().toLowerCase();
    const modelFilter = args.model?.trim().toLowerCase();

    const profiles = await listOptedInDealerProfiles(ctx, MAX_CANDIDATE_ORGS);

    const merged: BrowseVehicle[] = [];

    for (const profile of profiles) {
      if (merged.length >= MAX_MERGED_VEHICLES) break;
      if (cityFilter && !profile.areas.some((area) => area.toLowerCase().includes(cityFilter))) continue;

      const orgId = profile.orgId;
      const org = await ctx.db.get(orgId);
      if (!org || org.suspended) continue;
      if (!(await hasPlanFeature(ctx, orgId, "websiteBuilder"))) continue;

      const snapshotData = await getPublishedSnapshotData(ctx, orgId);
      if (!snapshotData) continue;
      const financeCompany = (snapshotData.financeCompany as FinanceCompanyTerms | null | undefined) ?? null;
      const financeAvailable = Boolean(financeCompany);
      if (args.paymentType === "FINANCE" && !financeAvailable) continue;
      if (args.maxMonthlyPayment != null && !financeAvailable) continue;

      const vehicles = Array.isArray(snapshotData?.vehicles) ? (snapshotData.vehicles as SnapshotVehicle[]) : [];
      if (vehicles.length === 0) continue;

      const domain = await activePrimaryDomain(ctx, orgId);
      const siteUrl = domain?.status === "active" ? `https://${domain.domain}` : null;
      const dealershipName = snapshotData?.profile?.dealershipName ?? org.name;

      // Direct-contact channels (P0 conversion): the dealership phone lives on
      // org settings; the WhatsApp number is the dealer's marketplace profile
      // number, falling back to the same phone so a dealer who set only a phone
      // still gets a working WhatsApp deep-link.
      const orgSettings = await ctx.db
        .query("orgSettings")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique();
      const dealerPhone = orgSettings?.dealershipPhone ?? null;
      const dealerWhatsapp = profile.whatsappNumber ?? orgSettings?.dealershipPhone ?? null;

      for (const vehicle of vehicles) {
        if (!vehicle.id || !vehicle.make || !vehicle.model) continue;
        if (vehicle.status && vehicle.status !== "AVAILABLE") continue;
        if (makeFilter && vehicle.make.toLowerCase() !== makeFilter) continue;
        if (modelFilter && vehicle.model.toLowerCase() !== modelFilter) continue;
        if (args.priceMin != null && (vehicle.price ?? Infinity) < args.priceMin) continue;
        if (args.priceMax != null && (vehicle.price ?? -Infinity) > args.priceMax) continue;

        // financePrice survives the dealer's "hide public prices" toggle, so a
        // price-hidden vehicle still gets a real installment estimate.
        const financeBasePrice = vehicle.financePrice ?? vehicle.price;
        const estimatedMonthlyPayment =
          financeBasePrice != null ? estimateMonthlyPayment(financeBasePrice, financeCompany) : null;
        if (args.maxMonthlyPayment != null && (estimatedMonthlyPayment ?? Infinity) > args.maxMonthlyPayment) continue;

        merged.push({
          orgId,
          dealershipName,
          dealerBadges: profile.badges,
          siteUrl,
          dealerPhone,
          dealerWhatsapp,
          id: vehicle.id,
          slug: vehicle.slug ?? vehicle.id,
          make: vehicle.make,
          model: vehicle.model,
          year: vehicle.year ?? 0,
          trim: vehicle.trim ?? null,
          mileage: vehicle.mileage ?? null,
          transmission: vehicle.transmission ?? null,
          fuelType: vehicle.fuelType ?? null,
          exteriorColor: vehicle.exteriorColor ?? null,
          price: vehicle.price ?? null,
          financePrice: vehicle.financePrice ?? null,
          imageUrls: vehicle.imageUrls ?? [],
          financeAvailable,
          estimatedMonthlyPayment,
          inspectionStatus: vehicle.inspectionStatus ?? "NONE",
          accidentDisclosed: vehicle.accidentDisclosed ?? null,
          ownerCount: vehicle.ownerCount ?? null,
          dealerGuarantee: vehicle.dealerGuarantee ?? null,
        });
        if (merged.length >= MAX_MERGED_VEHICLES) break;
      }
    }

    merged.sort((a, b) => compareBrowseVehicles(a, b, args.sortBy ?? "price_asc"));

    const page = merged.slice(offset, offset + numItems);
    const nextOffset = offset + numItems;
    const isDone = nextOffset >= merged.length;

    return { vehicles: page, continueCursor: isDone ? null : String(nextOffset), isDone };
  },
});
