export const WEBSITE_SECTION_GROUPS = [
  {
    title: "Dealership Profile",
    keys: [
      ["dealership.name", "Dealership name"],
      ["dealership.logo", "Logo"],
      ["dealership.phone", "Phone"],
      ["dealership.whatsapp", "WhatsApp number"],
      ["dealership.email", "Email"],
      ["dealership.address", "Address"],
      ["dealership.openingHours", "Opening hours"],
      ["dealership.branches", "Branch information"],
      ["dealership.mapLocation", "Map location"],
    ],
  },
  {
    title: "Branding",
    keys: [
      ["branding.colors", "Primary and secondary colors"],
      ["branding.hero", "Homepage hero text"],
      ["branding.languages", "EN/AR language options"],
    ],
  },
  {
    title: "Inventory",
    keys: [
      ["inventory.availableVehicles", "Available vehicles"],
      ["inventory.featuredVehicles", "Featured vehicles"],
      ["inventory.soldVehicles", "Sold vehicles"],
      ["inventory.hideMissingPhotos", "Hide vehicles with missing photos"],
      ["inventory.hideMissingPrice", "Hide vehicles with missing price"],
      ["inventory.selectedCategories", "Selected categories only"],
      ["inventory.selectedBranches", "Selected branches only"],
    ],
  },
  {
    title: "Vehicle Details",
    keys: [
      ["vehicle.makeModelYear", "Make, model, year"],
      ["vehicle.trim", "Trim"],
      ["vehicle.mileage", "Mileage"],
      ["vehicle.transmission", "Transmission"],
      ["vehicle.fuelType", "Fuel type"],
      ["vehicle.bodyType", "Body type"],
      ["vehicle.exteriorColor", "Exterior color"],
      ["vehicle.interiorColor", "Interior color"],
      ["vehicle.price", "Price"],
      ["vehicle.discountedPrice", "Discounted price"],
      ["vehicle.vinChassis", "VIN/chassis number"],
    ],
  },
  {
    title: "Vehicle Media",
    keys: [
      ["vehicle.photos", "Photos"],
      ["vehicle.videos", "Videos"],
      ["vehicle.view360", "360 view"],
    ],
  },
  {
    title: "Finance",
    keys: [
      ["finance.calculator", "Finance calculator"],
      ["finance.downPayment", "Down payment options"],
      ["finance.terms", "Term/month options"],
      ["finance.rateAssumptions", "Interest/profit rate assumptions"],
      ["finance.disclaimer", "Finance disclaimer text"],
    ],
  },
  {
    title: "Promotions",
    keys: [
      ["promotions.banners", "Homepage banners"],
      ["promotions.specialOffers", "Special offers"],
      ["promotions.featuredDeals", "Featured deals"],
      ["promotions.seasonalCampaigns", "Seasonal campaigns"],
    ],
  },
  {
    title: "Lead Forms",
    keys: [
      ["forms.contact", "Contact form"],
      ["forms.vehicleInquiry", "Vehicle inquiry form"],
      ["forms.testDrive", "Book test drive form"],
      ["forms.financing", "Request financing form"],
      ["forms.tradeIn", "Trade-in request form"],
      ["forms.support", "Support/contact form"],
    ],
  },
  {
    title: "SEO",
    keys: [
      ["seo.vehicleMetaTitle", "Vehicle meta title"],
      ["seo.vehicleMetaDescription", "Vehicle meta description"],
      ["seo.structuredData", "Structured vehicle data"],
      ["seo.sitemap", "Sitemap"],
      ["seo.robots", "Robots.txt"],
      ["seo.canonicalUrls", "Canonical URLs"],
    ],
  },
  {
    title: "Reviews",
    keys: [["reviews.testimonials", "Approved public reviews and testimonials"]],
  },
  {
    title: "Staff / Contact Routing",
    keys: [
      ["staff.generalSalesContact", "General sales contact"],
      ["staff.branchContact", "Branch contact"],
      ["staff.assignedSalesRep", "Assigned sales rep"],
      ["staff.whatsappRouting", "WhatsApp routing"],
    ],
  },
  {
    title: "Legal",
    keys: [
      ["legal.privacyPolicy", "Privacy policy"],
      ["legal.terms", "Terms"],
      ["legal.warrantyDisclaimer", "Warranty disclaimer"],
      ["legal.financingDisclaimer", "Financing disclaimer"],
      ["legal.dataDeletionPage", "Data deletion page"],
    ],
  },
] as const;

export const WEBSITE_FORM_TYPES = [
  ["contact", "Contact form"],
  ["vehicle_inquiry", "Vehicle inquiry"],
  ["test_drive", "Test drive booking"],
  ["financing", "Finance request"],
  ["trade_in", "Trade-in request"],
  ["support", "Support/contact"],
] as const;

export const SENSITIVE_WEBSITE_SECTION_KEYS = new Set([
  "vehicle.vinChassis",
  "inventory.soldVehicles",
  "staff.assignedSalesRep",
]);
