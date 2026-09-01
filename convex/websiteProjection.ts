import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";

/** Human-readable public URL segment for a vehicle's detail page — always ends in its raw `_id`, so it's reversible without a stored slug column. */
export function vehicleSlug(vehicle: { year: number; make: string; model: string; _id: string }): string {
  return `${vehicle.year}-${vehicle.make}-${vehicle.model}-${vehicle._id}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

async function primaryWebsiteDomain(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
  return await ctx.db
    .query("websiteDomains")
    .withIndex("by_org_primary", (domainQuery) => domainQuery.eq("orgId", orgId).eq("isPrimary", true))
    .first();
}

export async function websiteSectionMap(
  ctx: QueryCtx | MutationCtx,
  websiteSettingsId: Id<"websiteSettings">
): Promise<Record<string, boolean>> {
  const sectionRows = await ctx.db
    .query("websitePublishedSections")
    .withIndex("by_settings", (sectionQuery) => sectionQuery.eq("websiteSettingsId", websiteSettingsId))
    .take(100);

  return Object.fromEntries(sectionRows.map((sectionRow) => [sectionRow.sectionKey, sectionRow.enabled]));
}

function combinePhones(primary: string | null | undefined, extra: string[] | undefined) {
  const numbers = [primary, ...(extra ?? [])]
    .map((phone) => phone?.trim())
    .filter((phone): phone is string => Boolean(phone));
  return Array.from(new Set(numbers));
}

async function publicFinanceCompany(ctx: QueryCtx | MutationCtx, websiteSettings: Doc<"websiteSettings">) {
  if (!websiteSettings.activeFinanceCompanyId) return null;
  const company = await ctx.db.get(websiteSettings.activeFinanceCompanyId);
  if (!company || !company.isActive) return null;

  return {
    name: company.name,
    profitRate: company.profitRate,
    maxTermMonths: company.maxTermMonths,
    gracePeriodMonths: company.gracePeriodMonths,
    insuranceRate: company.insuranceRate ?? 0,
    adminFees: company.adminFees ?? 0,
    commission: company.commission ?? 0,
    includesCommissionInDebt: company.includesCommissionInDebt ?? false,
  };
}

async function publicDealerProfile(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  websiteSettings: Doc<"websiteSettings">
) {
  const organization = await ctx.db.get(orgId);
  const orgSettings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (settingsQuery) => settingsQuery.eq("orgId", orgId))
    .unique();
  // Resolved through ctx.storage.getUrl(), so the only URL this projection can
  // emit points at our own storage backend. `websiteSettings` used to carry a
  // caller-supplied `logoUrl` that won over this one; it was removed (see the
  // note in schema.ts) because it let a `website.manage` holder aim every
  // anonymous visitor's browser at an arbitrary origin.
  //
  // The value is not only rendered as an <img>: the dealer site also assigns it
  // to the icon / shortcut icon / apple-touch-icon <link> elements, so every
  // visitor's browser fetches it. That is why the trust boundary has to hold
  // here, in the projection, rather than at each render site.
  //
  // Scope, so this does not read as a completeness claim: only the LOGO is
  // closed. `primaryColor` / `secondaryColor` below are still unvalidated
  // caller strings, and the themes interpolate them into a raw <style> block —
  // a live CSS-injection vector on this same anonymous surface, with a
  // shipped free-text producer in the settings UI. Tracked separately; the
  // projection is the right choke point for that fix too.
  const logoUrl = orgSettings?.logoStorageId ? await ctx.storage.getUrl(orgSettings.logoStorageId) : null;

  const branchRows = await ctx.db
    .query("branches")
    .withIndex("by_org", (branchQuery) => branchQuery.eq("orgId", orgId))
    .take(50);

  return {
    dealershipName: orgSettings?.dealershipName ?? organization?.name ?? "Dealership",
    phone: orgSettings?.dealershipPhone ?? null,
    phones: combinePhones(orgSettings?.dealershipPhone, orgSettings?.dealershipPhones),
    address: orgSettings?.dealershipAddress ?? null,
    logoUrl,
    primaryColor: websiteSettings.primaryColor ?? orgSettings?.primaryColor ?? "#0f172a",
    secondaryColor: websiteSettings.secondaryColor ?? "#f97316",
    heroTitle: websiteSettings.heroTitle ?? orgSettings?.dealershipName ?? organization?.name ?? "Find your next vehicle",
    heroSubtitle: websiteSettings.heroSubtitle ?? "Browse public inventory and contact the dealership directly.",
    heroBadgeText: websiteSettings.heroBadgeText ?? null,
    slogan: websiteSettings.slogan ?? null,
    branches: branchRows
      .filter((branchRow) => branchRow.isActive)
      .map((branchRow) => ({
        id: branchRow._id,
        name: branchRow.name,
        address: branchRow.address ?? null,
        phone: branchRow.phone ?? null,
        phones: combinePhones(branchRow.phone, branchRow.additionalPhones),
      })),
  };
}

export async function projectedVehicleRows(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  enabledSections: Record<string, boolean>,
  // `resolveImageUrls: false` returns raw storage IDs and skips the per-image
  // `ctx.storage.getUrl` round-trips. The marketplace uses this so image URLs
  // are resolved only for the handful of cars that survive filtering +
  // pagination, not every car in every org. Defaults to true so the public
  // website projection keeps returning ready-to-render URLs.
  options: { resolveImageUrls?: boolean } = {}
) {
  const resolveImageUrls = options.resolveImageUrls !== false;
  const includeSoldVehicles = enabledSections["inventory.soldVehicles"] === true;
  const publicStatuses = includeSoldVehicles ? (["AVAILABLE", "SOLD"] as const) : (["AVAILABLE"] as const);
  const inventoryRows: Doc<"vehicles">[] = [];

  for (const publicStatus of publicStatuses) {
    const statusRows = await ctx.db
      .query("vehicles")
      .withIndex("by_org_status", (vehicleQuery) => vehicleQuery.eq("orgId", orgId).eq("status", publicStatus))
      .order("desc")
      .take(100);
    inventoryRows.push(...statusRows.filter((vehicleRow) => !vehicleRow.isDeleted));
  }

  const hideMissingPhotos = enabledSections["inventory.hideMissingPhotos"] === true;
  const hideMissingPrice = enabledSections["inventory.hideMissingPrice"] === true;
  const includeVinChassis = enabledSections["vehicle.vinChassis"] === true;
  const photosEnabled = Boolean(enabledSections["vehicle.photos"]);

  const publicVehicles = await Promise.all(
    inventoryRows.map(async (vehicleRow) => {
      const imageStorageIds = photosEnabled ? (vehicleRow.imageIds ?? []) : [];
      const imageUrls = resolveImageUrls
        ? (await Promise.all(imageStorageIds.map((storageId) => ctx.storage.getUrl(storageId)))).filter(
            (imageUrl): imageUrl is string => Boolean(imageUrl)
          )
        : [];

      return {
        id: vehicleRow._id,
        slug: vehicleSlug(vehicleRow),
        make: vehicleRow.make,
        model: vehicleRow.model,
        year: vehicleRow.year,
        trim: enabledSections["vehicle.trim"] ? (vehicleRow.trim ?? null) : null,
        mileage: enabledSections["vehicle.mileage"] ? vehicleRow.mileage : null,
        transmission: enabledSections["vehicle.transmission"] ? vehicleRow.transmission : null,
        fuelType: enabledSections["vehicle.fuelType"] ? vehicleRow.fuelType : null,
        exteriorColor: enabledSections["vehicle.exteriorColor"] ? vehicleRow.color : null,
        price: enabledSections["vehicle.price"] ? vehicleRow.sellingPrice : null,
        financePrice: vehicleRow.sellingPrice,
        vin: includeVinChassis ? vehicleRow.vin : null,
        status: vehicleRow.status,
        listedAt: vehicleRow.createdAt ?? vehicleRow._creationTime,
        imageStorageIds,
        imageUrls,
        inspectionStatus: vehicleRow.inspectionStatus ?? "NONE",
        accidentDisclosed: vehicleRow.accidentDisclosed ?? null,
        ownerCount: vehicleRow.ownerCount ?? null,
        dealerGuarantee: vehicleRow.dealerGuarantee ?? null,
      };
    })
  );

  // hideMissingPhotos keys off the presence of stored images (storage IDs), so
  // it works identically whether or not URLs were resolved.
  return publicVehicles.filter((publicVehicle) => {
    if (hideMissingPhotos && publicVehicle.imageStorageIds.length === 0) return false;
    if (hideMissingPrice && publicVehicle.price == null) return false;
    return true;
  });
}

export async function websitePublicProjection(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  websiteSettings: Doc<"websiteSettings">
) {
  const enabledSections = await websiteSectionMap(ctx, websiteSettings._id);
  const primaryDomain = await primaryWebsiteDomain(ctx, orgId);

  return {
    settings: {
      status: websiteSettings.status,
      defaultLanguage: websiteSettings.defaultLanguage,
      supportedLanguages: websiteSettings.supportedLanguages,
      templateId: websiteSettings.templateId,
      primaryColor: websiteSettings.primaryColor ?? "#0f172a",
      secondaryColor: websiteSettings.secondaryColor ?? "#f97316",
      domain: primaryDomain?.domain ?? websiteSettings.defaultSubdomain ?? null,
    },
    sections: enabledSections,
    profile: await publicDealerProfile(ctx, orgId, websiteSettings),
    financeCompany: await publicFinanceCompany(ctx, websiteSettings),
    vehicles: await projectedVehicleRows(ctx, orgId, enabledSections),
    legal: {
      privacyPolicy: "Contact the dealership to request privacy details for this website.",
      terms: "Vehicle availability, pricing, finance estimates, and offers are subject to confirmation by the dealership.",
      financingDisclaimer: "Finance estimates are illustrative and do not represent final approval or a binding offer.",
      dataDeletion: "Use the contact form to request deletion of personal data submitted through this website.",
    },
  };
}
