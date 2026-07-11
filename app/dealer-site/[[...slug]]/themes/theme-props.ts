import type { FormEvent } from "react";
import type { Id } from "@/convex/_generated/dataModel";

export type Lang = "en" | "ar";

export type PublicVehicle = {
  id: Id<"vehicles">;
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
  status: string;
  imageUrls: string[];
};

export type SiteStrings = {
  brand: string;
  browseInventory: string;
  contactSales: string;
  featuredVehicles: string;
  featuredSub: string;
  viewAll: string;
  nav: { home: string; inventory: string; finance: string; branches: string; contact: string };
  inventoryTitle: string;
  inventorySub: string;
  trim: string;
  mileage: string;
  transmission: string;
  fuelType: string;
  color: string;
  askAbout: string;
  sendInquiry: string;
  financeTitle: string;
  requestFinancing: string;
  branchesTitle: string;
  viewOnMap: string;
  contactTitle: string;
  contactDisclaimer: string;
  sendMessage: string;
  privacyTitle: string;
  termsTitle: string;
  dataDeletionTitle: string;
  footerPrivacy: string;
  footerTerms: string;
  footerDataDeletion: string;
  noVehicles: string;
  contactForPrice: string;
  placeholderFirstName: string;
  placeholderLastName: string;
  placeholderEmail: string;
  placeholderPhone: string;
  placeholderWhatsApp: string;
  placeholderMessage: string;
  contactMethodHint: string;
  previewBanner: string;
  thankYou: string;
  messageReceived: string;
  sendAnother: string;
};

export type FormState = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  whatsapp: string;
  message: string;
};

export type SubmitLeadOptions = {
  vehicleId?: Id<"vehicles">;
};

export type PublicSite = {
  settings: {
    status?: string;
    defaultLanguage?: string;
    supportedLanguages?: string[];
    templateId?: string;
    primaryColor?: string;
    secondaryColor?: string;
    domain?: string | null;
  };
  profile: {
    dealershipName: string;
    logoUrl?: string | null;
    phone?: string | null;
    phones: string[];
    address?: string | null;
    heroTitle?: string;
    heroSubtitle?: string;
    heroBadgeText?: string | null;
    slogan?: string | null;
    branches: Array<{ id: string; name: string; address?: string | null; phone?: string | null; phones: string[] }>;
  };
  vehicles: PublicVehicle[];
  legal: {
    privacyPolicy?: string;
    terms?: string;
    dataDeletion?: string;
    financingDisclaimer?: string;
  };
  financeCompany: {
    name: string;
    profitRate: number;
    maxTermMonths: number;
    gracePeriodMonths: number;
    insuranceRate: number;
    adminFees: number;
    commission: number;
    includesCommissionInDebt: boolean;
  } | null;
};

export type ThemeProps = {
  site: PublicSite;
  page: string;
  detailVehicle: PublicVehicle | null;
  siteOrigin: string;
  lang: Lang;
  isArabic: boolean;
  dir: "ltr" | "rtl";
  showLangToggle: boolean;
  isPreviewMode: boolean;
  form: FormState;
  setForm: (f: FormState) => void;
  setSelectedVehicleId: (id: Id<"vehicles"> | undefined) => void;
  isSubmitting: boolean;
  formSuccess: string | null;
  setFormSuccess: (s: string | null) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>, formType: string, options?: SubmitLeadOptions) => void;
  turnstileSiteKey?: string;
  onToggleLang: () => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
  t: SiteStrings;
  primary: string;
  secondary: string;
  formatPrice: (price: number | null) => string;
  vehicles: PublicVehicle[];
  featuredVehicles: PublicVehicle[];
};
