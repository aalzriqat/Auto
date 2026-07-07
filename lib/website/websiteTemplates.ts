export const DEFAULT_WEBSITE_TEMPLATE_ID = "modern-showroom";

export const WEBSITE_TEMPLATE_OPTIONS = [
  { id: DEFAULT_WEBSITE_TEMPLATE_ID, labelKey: "WebsiteTemplateModernShowroom", tier: "standard" },
  { id: "classic-inventory", labelKey: "WebsiteTemplateClassicInventory", tier: "standard" },
  { id: "premium-minimal", labelKey: "WebsiteTemplatePremiumMinimal", tier: "standard" },
  { id: "prestige", labelKey: "WebsiteTemplatePrestige", tier: "signature" },
  { id: "velocity", labelKey: "WebsiteTemplateVelocity", tier: "signature" },
  { id: "avant", labelKey: "WebsiteTemplateAvant", tier: "signature" },
  { id: "obsidian-atelier", labelKey: "WebsiteTemplateObsidianAtelier", tier: "signature" },
  { id: "desert-grand-tourer", labelKey: "WebsiteTemplateDesertGrandTourer", tier: "signature" },
  { id: "velocity-command", labelKey: "WebsiteTemplateVelocityCommand", tier: "signature" },
  { id: "lucent-studio", labelKey: "WebsiteTemplateLucentStudio", tier: "signature" },
  { id: "concierge-editorial", labelKey: "WebsiteTemplateConciergeEditorial", tier: "signature" },
  { id: "neon-grid", labelKey: "WebsiteTemplateNeonGrid", tier: "signature" },
  { id: "cinema-noir", labelKey: "WebsiteTemplateCinemaNoir", tier: "signature" },
  { id: "atlas-rally", labelKey: "WebsiteTemplateAtlasRally", tier: "signature" },
  { id: "glass-horizon", labelKey: "WebsiteTemplateGlassHorizon", tier: "signature" },
  { id: "torque-lab", labelKey: "WebsiteTemplateTorqueLab", tier: "signature" },
  { id: "pearl-majlis", labelKey: "WebsiteTemplatePearlMajlis", tier: "signature" },
  { id: "prism-motion", labelKey: "WebsiteTemplatePrismMotion", tier: "signature" },
  { id: "carbon-track", labelKey: "WebsiteTemplateCarbonTrack", tier: "signature" },
  { id: "solaris-bay", labelKey: "WebsiteTemplateSolarisBay", tier: "signature" },
  { id: "pixel-showroom", labelKey: "WebsiteTemplatePixelShowroom", tier: "signature" },
  { id: "kinetic-luxury", labelKey: "WebsiteTemplateKineticLuxury", tier: "signature" },
  { id: "kinetic-ev", labelKey: "WebsiteTemplateKineticModernEv", tier: "signature" },
  { id: "kinetic-sales", labelKey: "WebsiteTemplateKineticSales", tier: "signature" },
] as const;

export type WebsiteTemplateId = (typeof WEBSITE_TEMPLATE_OPTIONS)[number]["id"];

export function websiteTemplateLabelKey(templateId: string) {
  return WEBSITE_TEMPLATE_OPTIONS.find((templateOption) => templateOption.id === templateId)?.labelKey
    ?? "WebsiteTemplateModernShowroom";
}
