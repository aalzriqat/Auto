export const WEBSITE_PLATFORM_DOMAIN = "autoflowdealer.com";
export const WEBSITE_DOMAIN_TARGET = "sites.autoflowdealer.com";

export const RESERVED_WEBSITE_SUBDOMAINS = new Set([
  "www",
  "app",
  "admin",
  "api",
  "support",
  "billing",
  "dashboard",
  "auth",
  "login",
  "signup",
  "mail",
  "ftp",
  "static",
  "assets",
  "cdn",
  "status",
]);

export const DEFAULT_WEBSITE_SECTION_KEYS = [
  "dealership.name",
  "dealership.logo",
  "dealership.phone",
  "dealership.whatsapp",
  "dealership.email",
  "dealership.address",
  "dealership.openingHours",
  "dealership.branches",
  "dealership.mapLocation",
  "branding.colors",
  "branding.hero",
  "branding.languages",
  "inventory.availableVehicles",
  "inventory.featuredVehicles",
  "inventory.soldVehicles",
  "inventory.hideMissingPhotos",
  "inventory.hideMissingPrice",
  "inventory.selectedCategories",
  "inventory.selectedBranches",
  "vehicle.makeModelYear",
  "vehicle.trim",
  "vehicle.mileage",
  "vehicle.transmission",
  "vehicle.fuelType",
  "vehicle.bodyType",
  "vehicle.exteriorColor",
  "vehicle.interiorColor",
  "vehicle.price",
  "vehicle.discountedPrice",
  "vehicle.vinChassis",
  "vehicle.photos",
  "vehicle.videos",
  "vehicle.view360",
  "finance.calculator",
  "finance.downPayment",
  "finance.terms",
  "finance.rateAssumptions",
  "finance.disclaimer",
  "promotions.banners",
  "promotions.specialOffers",
  "promotions.featuredDeals",
  "promotions.seasonalCampaigns",
  "forms.contact",
  "forms.vehicleInquiry",
  "forms.testDrive",
  "forms.financing",
  "forms.tradeIn",
  "forms.support",
  "seo.vehicleMetaTitle",
  "seo.vehicleMetaDescription",
  "seo.structuredData",
  "seo.sitemap",
  "seo.robots",
  "seo.canonicalUrls",
  "reviews.testimonials",
  "staff.generalSalesContact",
  "staff.branchContact",
  "staff.assignedSalesRep",
  "staff.whatsappRouting",
  "legal.privacyPolicy",
  "legal.terms",
  "legal.warrantyDisclaimer",
  "legal.financingDisclaimer",
  "legal.dataDeletionPage",
] as const;

export const DEFAULT_ENABLED_WEBSITE_SECTIONS = new Set<string>([
  "dealership.name",
  "dealership.logo",
  "dealership.phone",
  "dealership.whatsapp",
  "dealership.address",
  "dealership.openingHours",
  "inventory.availableVehicles",
  "vehicle.makeModelYear",
  "vehicle.mileage",
  "vehicle.price",
  "vehicle.photos",
  "forms.contact",
  "forms.vehicleInquiry",
  "legal.privacyPolicy",
  "legal.terms",
  "legal.financingDisclaimer",
]);

export const WEBSITE_FORM_TYPES = [
  "contact",
  "vehicle_inquiry",
  "test_drive",
  "financing",
  "trade_in",
  "support",
] as const;

export function normalizedWebsiteHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
}

export function normalizedCustomDomain(domain: string): string {
  return normalizedWebsiteHost(domain).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function platformDomainForSlug(slug: string): string {
  return `${slug}.${WEBSITE_PLATFORM_DOMAIN}`;
}

export function sectionKeyForWebsiteForm(formType: string): string {
  switch (formType) {
    case "vehicle_inquiry":
      return "forms.vehicleInquiry";
    case "test_drive":
      return "forms.testDrive";
    case "trade_in":
      return "forms.tradeIn";
    default:
      return `forms.${formType}`;
  }
}

export function validateSubdomainSlug(slug: string): { ok: true; slug: string } | { ok: false; error: string } {
  const normalizedSlug = slug.trim().toLowerCase();
  if (normalizedSlug.length < 3) return { ok: false, error: "Subdomain must be at least 3 characters." };
  if (normalizedSlug.length > 50) return { ok: false, error: "Subdomain must be 50 characters or less." };
  if (!/^[a-z0-9-]+$/.test(normalizedSlug)) {
    return { ok: false, error: "Use lowercase letters, numbers, and hyphens only." };
  }
  if (normalizedSlug.startsWith("-") || normalizedSlug.endsWith("-")) {
    return { ok: false, error: "Subdomain cannot start or end with a hyphen." };
  }
  if (RESERVED_WEBSITE_SUBDOMAINS.has(normalizedSlug)) {
    return { ok: false, error: "This subdomain is reserved." };
  }
  return { ok: true, slug: normalizedSlug };
}

export function validateCustomDomain(domain: string): { ok: true; domain: string } | { ok: false; error: string } {
  const normalizedDomain = normalizedCustomDomain(domain);
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalizedDomain)) {
    return { ok: false, error: "Enter a valid domain like premiumcarsjo.com." };
  }
  if (normalizedDomain.endsWith(`.${WEBSITE_PLATFORM_DOMAIN}`) || normalizedDomain === WEBSITE_PLATFORM_DOMAIN) {
    return { ok: false, error: "Use the free AutoFlow subdomain option for autoflowdealer.com addresses." };
  }
  return { ok: true, domain: normalizedDomain };
}
