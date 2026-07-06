"use client";

import { useMemo, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Car,
  CheckCircle2,
  Compass,
  Crown,
  Gauge,
  Globe2,
  Mail,
  MapPin,
  Menu,
  MessageCircle,
  Phone,
  Search,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import type { FormState, PublicVehicle, SiteStrings, ThemeProps } from "./theme-props";
import { TurnstileWidget } from "../turnstile-widget";

type ShowcaseDesignId =
  | "obsidian"
  | "desert"
  | "command"
  | "lucent"
  | "concierge";

type ShowcaseDesign = {
  id: ShowcaseDesignId;
  shellClass: string;
  title: string;
  bg: string;
  text: string;
  muted: string;
  panel: string;
  panelStrong: string;
  line: string;
  primaryFallback: string;
  secondaryFallback: string;
  darkTurnstile: boolean;
};

type VehicleCardVariant = "gallery" | "route" | "command" | "studio" | "editorial";

type InventorySort = "newest" | "price_low" | "price_high" | "mileage_low";

type InventoryFilterValues = {
  query: string;
  make: string;
  status: string;
  sort: InventorySort;
  makeOptions: string[];
  statusOptions: string[];
  hasActiveFilters: boolean;
};

type InventoryFilterActions = {
  setQuery: (query: string) => void;
  setMake: (make: string) => void;
  setStatus: (status: string) => void;
  setSort: (sort: InventorySort) => void;
  clearFilters: () => void;
};

type ShowcaseCopy = {
  boutique: string;
  privateViewing: string;
  readyToday: string;
  curated: string;
  arrivals: string;
  showroom: string;
  bookViewing: string;
  askConcierge: string;
  financeOptions: string;
  availableNow: string;
  inventorySignal: string;
  routeReady: string;
  commandCenter: string;
  studioSelected: string;
  editorsPick: string;
  mileageShort: string;
  call: string;
  visit: string;
  details: string;
  openGallery: string;
  verifiedInventory: string;
  deliveryReady: string;
  instantReply: string;
  featuredArrival: string;
  noImage: string;
  searchPlaceholder: string;
  filters: string;
  allMakes: string;
  allStatuses: string;
  sortBy: string;
  sortNewest: string;
  sortPriceLow: string;
  sortPriceHigh: string;
  sortMileageLow: string;
  clearFilters: string;
  matchingCars: string;
  noMatches: string;
  viewDetails: string;
  callDealer: string;
  whatsappDealer: string;
  requestFinance: string;
  shareVehicle: string;
  similarCars: string;
  dealerTrust: string;
  updatedFromShowroom: string;
  stickyInquiry: string;
  financeBadge: string;
  contactDealer: string;
  mobileContactPrompt: string;
};

const SHOWCASE_COPY: Record<"en" | "ar", ShowcaseCopy> = {
  en: {
    boutique: "Private showroom",
    privateViewing: "Private viewing",
    readyToday: "Ready today",
    curated: "Curated stock",
    arrivals: "New arrivals",
    showroom: "Showroom",
    bookViewing: "Book viewing",
    askConcierge: "Ask concierge",
    financeOptions: "Finance options",
    availableNow: "Available now",
    inventorySignal: "Inventory signal",
    routeReady: "Route-ready selection",
    commandCenter: "Command center",
    studioSelected: "Studio selected",
    editorsPick: "Editor's pick",
    mileageShort: "km",
    call: "Call",
    visit: "Visit",
    details: "Details",
    openGallery: "Open gallery",
    verifiedInventory: "Verified inventory",
    deliveryReady: "Delivery ready",
    instantReply: "Instant reply",
    featuredArrival: "Featured arrival",
    noImage: "Vehicle image coming soon",
    searchPlaceholder: "Search make, model, year, fuel, price...",
    filters: "Filters",
    allMakes: "All makes",
    allStatuses: "All statuses",
    sortBy: "Sort by",
    sortNewest: "Newest year",
    sortPriceLow: "Price: low to high",
    sortPriceHigh: "Price: high to low",
    sortMileageLow: "Mileage: low first",
    clearFilters: "Clear filters",
    matchingCars: "matching cars",
    noMatches: "No matching cars yet. Contact the showroom and we will help you find one.",
    viewDetails: "View details",
    callDealer: "Call dealer",
    whatsappDealer: "WhatsApp",
    requestFinance: "Request financing",
    shareVehicle: "Share listing",
    similarCars: "Similar cars",
    dealerTrust: "Dealer-direct information",
    updatedFromShowroom: "Inventory updated directly from the showroom",
    stickyInquiry: "Ask about this car",
    financeBadge: "Finance available",
    contactDealer: "Contact dealer",
    mobileContactPrompt: "Quick vehicle contact actions",
  },
  ar: {
    boutique: "صالة عرض خاصة",
    privateViewing: "معاينة خاصة",
    readyToday: "جاهزة اليوم",
    curated: "مخزون مختار",
    arrivals: "وصل حديثاً",
    showroom: "المعرض",
    bookViewing: "احجز معاينة",
    askConcierge: "تواصل مع المستشار",
    financeOptions: "خيارات التمويل",
    availableNow: "متاح الآن",
    inventorySignal: "مؤشر المخزون",
    routeReady: "اختيارات جاهزة للطريق",
    commandCenter: "مركز التحكم",
    studioSelected: "اختيار الاستوديو",
    editorsPick: "اختيارنا المميز",
    mileageShort: "كم",
    call: "اتصال",
    visit: "زيارة",
    details: "التفاصيل",
    openGallery: "فتح المعرض",
    verifiedInventory: "مخزون موثق",
    deliveryReady: "جاهز للتسليم",
    instantReply: "رد سريع",
    featuredArrival: "وصول مميز",
    noImage: "صورة المركبة قريباً",
    searchPlaceholder: "ابحث بالشركة أو الموديل أو السنة أو السعر...",
    filters: "الفلاتر",
    allMakes: "كل الشركات",
    allStatuses: "كل الحالات",
    sortBy: "ترتيب حسب",
    sortNewest: "الأحدث سنة",
    sortPriceLow: "السعر: من الأقل",
    sortPriceHigh: "السعر: من الأعلى",
    sortMileageLow: "الممشى: الأقل أولاً",
    clearFilters: "مسح الفلاتر",
    matchingCars: "سيارة مطابقة",
    noMatches: "لا توجد سيارات مطابقة حالياً. تواصل مع المعرض وسنساعدك في إيجادها.",
    viewDetails: "عرض التفاصيل",
    callDealer: "اتصال",
    whatsappDealer: "واتساب",
    requestFinance: "اطلب تمويل",
    shareVehicle: "مشاركة السيارة",
    similarCars: "سيارات مشابهة",
    dealerTrust: "معلومات مباشرة من المعرض",
    updatedFromShowroom: "المخزون محدث مباشرة من المعرض",
    stickyInquiry: "اسأل عن هذه السيارة",
    financeBadge: "تمويل متاح",
    contactDealer: "تواصل مع المعرض",
    mobileContactPrompt: "إجراءات تواصل سريعة للسيارة",
  },
};

const DESIGNS: Record<ShowcaseDesignId, ShowcaseDesign> = {
  obsidian: {
    id: "obsidian",
    shellClass: "wf--obsidian",
    title: "Obsidian Atelier",
    bg: "#080908",
    text: "#f7f2e8",
    muted: "#a7aaa4",
    panel: "#111310",
    panelStrong: "#181b15",
    line: "#2a2d27",
    primaryFallback: "#b5965a",
    secondaryFallback: "#e6dfcf",
    darkTurnstile: true,
  },
  desert: {
    id: "desert",
    shellClass: "wf--desert",
    title: "Desert Grand Tourer",
    bg: "#f7f8f5",
    text: "#17221d",
    muted: "#64706a",
    panel: "#ffffff",
    panelStrong: "#0d2a25",
    line: "#dfe6de",
    primaryFallback: "#0e6b5f",
    secondaryFallback: "#b45f35",
    darkTurnstile: false,
  },
  command: {
    id: "command",
    shellClass: "wf--command",
    title: "Velocity Command",
    bg: "#f4f7fa",
    text: "#111827",
    muted: "#5c6674",
    panel: "#ffffff",
    panelStrong: "#0b111c",
    line: "#dde4ee",
    primaryFallback: "#2563eb",
    secondaryFallback: "#dc2626",
    darkTurnstile: false,
  },
  lucent: {
    id: "lucent",
    shellClass: "wf--lucent",
    title: "Lucent Studio",
    bg: "#fbfcfc",
    text: "#182024",
    muted: "#667277",
    panel: "#ffffff",
    panelStrong: "#eef5f6",
    line: "#dfe8ea",
    primaryFallback: "#0891b2",
    secondaryFallback: "#65a30d",
    darkTurnstile: false,
  },
  concierge: {
    id: "concierge",
    shellClass: "wf--concierge",
    title: "Concierge Editorial",
    bg: "#f8f7f3",
    text: "#17171b",
    muted: "#686661",
    panel: "#ffffff",
    panelStrong: "#241925",
    line: "#dedbd3",
    primaryFallback: "#7f1d1d",
    secondaryFallback: "#2f6f63",
    darkTurnstile: false,
  },
};

function safeColor(value: string | undefined, fallback: string) {
  const text = value?.trim();
  if (!text) return fallback;
  return /^#[0-9a-fA-F]{3,8}$/.test(text) ? text : fallback;
}

function cssVars(design: ShowcaseDesign, primary: string, secondary: string) {
  return {
    "--wf-bg": design.bg,
    "--wf-text": design.text,
    "--wf-muted": design.muted,
    "--wf-panel": design.panel,
    "--wf-panel-strong": design.panelStrong,
    "--wf-line": design.line,
    "--wf-primary": safeColor(primary, design.primaryFallback),
    "--wf-secondary": safeColor(secondary, design.secondaryFallback),
  } as CSSProperties & Record<`--${string}`, string>;
}

function vehicleName(vehicle: PublicVehicle) {
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
}

function vehicleSpecs(vehicle: PublicVehicle, copy: ShowcaseCopy) {
  return [
    vehicle.trim,
    vehicle.mileage ? `${vehicle.mileage.toLocaleString()} ${copy.mileageShort}` : null,
    vehicle.transmission,
    vehicle.fuelType,
  ].filter((value): value is string => Boolean(value));
}

function vehicleVariantForDesign(design: ShowcaseDesign): VehicleCardVariant {
  switch (design.id) {
    case "obsidian":
      return "gallery";
    case "desert":
      return "route";
    case "command":
      return "command";
    case "lucent":
      return "studio";
    case "concierge":
      return "editorial";
  }
}

function uniqueVehicleValues(
  vehicles: PublicVehicle[],
  selector: (vehicle: PublicVehicle) => string | number | null | undefined,
) {
  return Array.from(
    new Set(
      vehicles
        .map(selector)
        .filter((value): value is string | number => value !== null && value !== undefined && String(value).trim() !== "")
        .map((value) => String(value)),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function searchableVehicleText(vehicle: PublicVehicle) {
  return [
    vehicle.make,
    vehicle.model,
    vehicle.year,
    vehicle.trim,
    vehicle.status,
    vehicle.fuelType,
    vehicle.transmission,
    vehicle.exteriorColor,
    vehicle.mileage,
    vehicle.price,
  ]
    .filter((value): value is string | number => value !== null && value !== undefined)
    .join(" ")
    .toLocaleLowerCase();
}

function sortableNumber(value: number | null, fallback: number) {
  return typeof value === "number" ? value : fallback;
}

function filterAndSortVehicles({
  vehicles,
  query,
  make,
  status,
  sort,
}: {
  vehicles: PublicVehicle[];
  query: string;
  make: string;
  status: string;
  sort: InventorySort;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = vehicles.filter((vehicle) => {
    const matchesQuery = normalizedQuery ? searchableVehicleText(vehicle).includes(normalizedQuery) : true;
    const matchesMake = make === "all" ? true : vehicle.make === make;
    const matchesStatus = status === "all" ? true : vehicle.status === status;
    return matchesQuery && matchesMake && matchesStatus;
  });

  return [...filtered].sort((a, b) => {
    if (sort === "price_low") {
      return sortableNumber(a.price, Number.MAX_SAFE_INTEGER) - sortableNumber(b.price, Number.MAX_SAFE_INTEGER);
    }
    if (sort === "price_high") {
      return sortableNumber(b.price, -1) - sortableNumber(a.price, -1);
    }
    if (sort === "mileage_low") {
      return sortableNumber(a.mileage, Number.MAX_SAFE_INTEGER) - sortableNumber(b.mileage, Number.MAX_SAFE_INTEGER);
    }
    return b.year - a.year;
  });
}

function phoneHref(phone: string | null | undefined) {
  const normalized = phone?.replace(/[^\d+]/g, "");
  return normalized ? `tel:${normalized}` : "/contact";
}

function whatsappHref(phone: string | null | undefined, message: string) {
  const digits = phone?.replace(/\D/g, "");
  if (!digits) return "/contact";
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

function vehicleContactMessage(props: ThemeProps, vehicle: PublicVehicle) {
  if (props.lang === "ar") {
    return `مرحبا، أريد الاستفسار عن ${vehicleName(vehicle)} من ${props.site.profile.dealershipName}.`;
  }
  return `Hello, I want to ask about ${vehicleName(vehicle)} at ${props.site.profile.dealershipName}.`;
}

function dealerContactMessage(props: ThemeProps) {
  if (props.lang === "ar") {
    return `مرحبا، أريد التواصل مع ${props.site.profile.dealershipName}.`;
  }
  return `Hello, I want to contact ${props.site.profile.dealershipName}.`;
}

function absoluteSitePath(origin: string, path: string) {
  if (!origin) return path;
  return `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function vehicleShareMessage(props: ThemeProps, vehicle: PublicVehicle) {
  const vehicleTitle = vehicleName(vehicle);
  const price = props.formatPrice(vehicle.price);
  const listingPath = `/inventory/${vehicle.slug}`;
  const listingUrl = absoluteSitePath(props.siteOrigin, listingPath);
  if (props.lang === "ar") {
    return `${vehicleTitle} لدى ${props.site.profile.dealershipName} - ${price} - ${listingUrl}`;
  }
  return `${vehicleTitle} at ${props.site.profile.dealershipName} - ${price} - ${listingUrl}`;
}

function similarVehiclesFor(vehicle: PublicVehicle, vehicles: PublicVehicle[]) {
  const sameMake = vehicles.filter((item) => item.id !== vehicle.id && item.make === vehicle.make);
  if (sameMake.length) return sameMake.slice(0, 3);
  return vehicles.filter((item) => item.id !== vehicle.id).slice(0, 3);
}

function heroVehicle(props: ThemeProps) {
  return props.featuredVehicles[0] ?? props.vehicles[0] ?? null;
}

function ArrowIcon() {
  return <ArrowRight className="wf-arrow" size={16} />;
}

function VehicleTicker({
  vehicles,
  props,
  copy,
}: {
  vehicles: PublicVehicle[];
  props: ThemeProps;
  copy: ShowcaseCopy;
}) {
  const tickerVehicles = vehicles.slice(0, 4);
  if (!tickerVehicles.length) return null;

  return (
    <div className="wf-live-rail" aria-hidden="true">
      {[...tickerVehicles, ...tickerVehicles].map((vehicle, index) => (
        <span key={`${vehicle.id}-${index}`}>
          {copy.featuredArrival}
          <strong>{vehicleName(vehicle)}</strong>
          <em dir="ltr">{props.formatPrice(vehicle.price)}</em>
        </span>
      ))}
    </div>
  );
}

function RouteMarkers({ copy }: { copy: ShowcaseCopy }) {
  return (
    <div className="wf-route-map" aria-hidden="true">
      <span>{copy.showroom}</span>
      <i />
      <span>{copy.readyToday}</span>
      <i />
      <span>{copy.deliveryReady}</span>
    </div>
  );
}

function CommandTelemetry({ count }: { count: number }) {
  return (
    <div className="wf-telemetry" aria-hidden="true">
      <span />
      <span />
      <span />
      <strong>{String(count).padStart(2, "0")}</strong>
    </div>
  );
}

function StudioStack({
  vehicle,
  props,
  copy,
}: {
  vehicle: PublicVehicle | null;
  props: ThemeProps;
  copy: ShowcaseCopy;
}) {
  return (
    <div className="wf-studio-stack" aria-hidden="true">
      <span>{copy.availableNow}</span>
      <strong>{vehicle ? vehicleName(vehicle) : props.site.profile.dealershipName}</strong>
      <em>{vehicle ? props.formatPrice(vehicle.price) : props.t.contactForPrice}</em>
    </div>
  );
}

function EditorialIndex({
  vehicles,
  copy,
}: {
  vehicles: PublicVehicle[];
  copy: ShowcaseCopy;
}) {
  const indexVehicles = vehicles.slice(0, 3);
  if (!indexVehicles.length) return null;

  return (
    <div className="wf-editorial-index" aria-hidden="true">
      {indexVehicles.map((vehicle, index) => (
        <span key={vehicle.id}>
          0{index + 1}
          <strong>{vehicleName(vehicle)}</strong>
          <em>{copy.editorsPick}</em>
        </span>
      ))}
    </div>
  );
}

function ShowcaseRoot({ props, design }: { props: ThemeProps; design: ShowcaseDesign }) {
  const copy = SHOWCASE_COPY[props.lang];
  const profile = props.site.profile;
  const navLinks = [
    [props.t.nav.home, "/"],
    [props.t.nav.inventory, "/inventory"],
    [props.t.nav.finance, "/finance"],
    [props.t.nav.branches, "/branches"],
    [props.t.nav.contact, "/contact"],
  ] as const;

  const rootClass = `wf ${design.shellClass}`;
  const rootStyle = cssVars(design, props.primary, props.secondary);

  return (
    <main dir={props.dir} className={rootClass} style={rootStyle}>
      <ShowcaseStyles />
      {props.isPreviewMode && <div className="wf-preview">{props.t.previewBanner}</div>}
      <ShowcaseHeader props={props} design={design} navLinks={navLinks} copy={copy} />
      {props.page === "home" || props.page === "" ? (
        <ShowcaseHome props={props} design={design} copy={copy} />
      ) : props.page === "inventory" && !props.detailVehicle ? (
        <ShowcaseInventory props={props} design={design} copy={copy} />
      ) : props.page === "inventory" && props.detailVehicle ? (
        <ShowcaseVehicleDetail props={props} design={design} copy={copy} />
      ) : props.page === "finance" ? (
        <ShowcaseFinance props={props} design={design} copy={copy} />
      ) : props.page === "branches" ? (
        <ShowcaseBranches props={props} design={design} />
      ) : props.page === "contact" ? (
        <ShowcaseContact props={props} design={design} copy={copy} />
      ) : props.page === "privacy" || props.page === "terms" || props.page === "data-deletion" ? (
        <ShowcaseLegal props={props} />
      ) : (
        <ShowcaseHome props={props} design={design} copy={copy} />
      )}
      <ShowcaseFooter profile={profile} navLinks={navLinks} t={props.t} copy={copy} />
    </main>
  );
}

function ShowcaseHeader({
  props,
  design,
  navLinks,
  copy,
}: {
  props: ThemeProps;
  design: ShowcaseDesign;
  navLinks: readonly (readonly [string, string])[];
  copy: ShowcaseCopy;
}) {
  const profile = props.site.profile;
  return (
    <header className={`wf-nav wf-nav--${design.id}`}>
      <div className="wf-shell wf-nav-inner">
        <Link href="/" className="wf-brand">
          {profile.logoUrl ? (
            <img className="wf-logo" src={profile.logoUrl} alt={profile.dealershipName} />
          ) : (
            <span className="wf-brand-mark">
              <Car size={18} />
            </span>
          )}
          <span className="wf-brand-name">{profile.dealershipName}</span>
        </Link>

        <nav className="wf-desktop-nav">
          {navLinks.map(([label, href]) => (
            <a key={href} href={href} className="wf-nav-link">
              {label}
            </a>
          ))}
        </nav>

        <div className="wf-actions">
          {props.showLangToggle && (
            <button type="button" className="wf-language" onClick={props.onToggleLang}>
              <Globe2 size={15} />
              <span>{props.lang === "en" ? "العربية" : "English"}</span>
            </button>
          )}
          <a href="/contact" className="wf-primary-action">
            {design.id === "concierge" ? copy.askConcierge : props.t.nav.contact}
          </a>
          <button
            type="button"
            className="wf-menu-button"
            aria-label="Toggle navigation"
            onClick={() => props.setMobileNavOpen(!props.mobileNavOpen)}
          >
            {props.mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      {props.mobileNavOpen && (
        <div className="wf-mobile-nav">
          {navLinks.map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="wf-mobile-link"
              onClick={() => props.setMobileNavOpen(false)}
            >
              {label}
            </a>
          ))}
        </div>
      )}
    </header>
  );
}

function ShowcaseHome({
  props,
  design,
  copy,
}: {
  props: ThemeProps;
  design: ShowcaseDesign;
  copy: ShowcaseCopy;
}) {
  switch (design.id) {
    case "obsidian":
      return <ObsidianHome props={props} copy={copy} />;
    case "desert":
      return <DesertHome props={props} copy={copy} />;
    case "command":
      return <CommandHome props={props} copy={copy} />;
    case "lucent":
      return <LucentHome props={props} copy={copy} />;
    case "concierge":
      return <ConciergeHome props={props} copy={copy} />;
  }
}

function ObsidianHome({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicle = heroVehicle(props);
  const profile = props.site.profile;
  return (
    <>
      <section className="wf-hero wf-hero--obsidian">
        <HeroImage vehicle={vehicle} copy={copy} />
        <div className="wf-hero-shade" />
        <div className="wf-atelier-sweep" aria-hidden="true" />
        <div className="wf-shell wf-hero-content wf-hero-content--obsidian">
          <div className="wf-kicker wf-motion-one">
            <Crown size={16} />
            {copy.boutique}
          </div>
          <h1 className="wf-hero-title wf-motion-two">{profile.heroTitle ?? profile.dealershipName}</h1>
          <p className="wf-hero-copy wf-motion-three">{profile.heroSubtitle}</p>
          <div className="wf-hero-buttons wf-motion-four">
            <a href="/inventory" className="wf-button wf-button--primary">
              {props.t.browseInventory}
              <ArrowIcon />
            </a>
            <a href="/contact" className="wf-button wf-button--ghost">{copy.privateViewing}</a>
          </div>
        </div>
        <div className="wf-atelier-panel">
          <p>{copy.featuredArrival}</p>
          <strong>{vehicle ? vehicleName(vehicle) : profile.dealershipName}</strong>
          {vehicle && <span dir="ltr">{props.formatPrice(vehicle.price)}</span>}
        </div>
        <VehicleTicker vehicles={props.featuredVehicles} props={props} copy={copy} />
      </section>
      <AtelierInventoryWall props={props} copy={copy} />
    </>
  );
}

function DesertHome({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicle = heroVehicle(props);
  const profile = props.site.profile;
  return (
    <>
      <section className="wf-hero wf-hero--desert">
        <div className="wf-shell wf-desert-grid">
          <div className="wf-desert-copy">
            <div className="wf-kicker wf-motion-one">
              <Compass size={16} />
              {copy.routeReady}
            </div>
            <h1 className="wf-hero-title wf-motion-two">{profile.heroTitle ?? profile.dealershipName}</h1>
            <p className="wf-hero-copy wf-motion-three">{profile.heroSubtitle}</p>
            <div className="wf-route-stats wf-motion-four">
              <span>{copy.verifiedInventory}</span>
              <strong dir="ltr">{props.vehicles.length}</strong>
              <span>{copy.deliveryReady}</span>
            </div>
            <div className="wf-hero-buttons wf-motion-five">
              <a href="/inventory" className="wf-button wf-button--primary">
                {props.t.browseInventory}
                <ArrowIcon />
              </a>
              <a href="/branches" className="wf-button wf-button--ghost">{props.t.branchesTitle}</a>
            </div>
          </div>
          <div className="wf-desert-stage">
            <HeroImage vehicle={vehicle} copy={copy} />
            <RouteMarkers copy={copy} />
            <div className="wf-route-ticket">
              <span>{copy.readyToday}</span>
              <strong>{props.vehicles.length}</strong>
              <span>{props.t.inventoryTitle}</span>
            </div>
          </div>
        </div>
      </section>
      <RouteInventoryJourney props={props} copy={copy} />
    </>
  );
}

function CommandHome({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicle = heroVehicle(props);
  const profile = props.site.profile;
  return (
    <>
      <section className="wf-hero wf-hero--command">
        <div className="wf-shell wf-command-grid">
          <div>
            <div className="wf-kicker wf-motion-one">
              <Gauge size={16} />
              {copy.commandCenter}
            </div>
            <h1 className="wf-hero-title wf-motion-two">{profile.heroTitle ?? profile.dealershipName}</h1>
            <p className="wf-hero-copy wf-motion-three">{profile.heroSubtitle}</p>
            <div className="wf-command-metrics wf-motion-four">
              <Metric icon={<Car size={17} />} label={props.t.inventoryTitle} value={`${props.vehicles.length}`} />
              <Metric icon={<Zap size={17} />} label={copy.instantReply} value={copy.readyToday} />
              <Metric icon={<ShieldCheck size={17} />} label={copy.verifiedInventory} value={copy.availableNow} />
            </div>
            <div className="wf-hero-buttons wf-motion-five">
              <a href="/inventory" className="wf-button wf-button--primary">
                {props.t.browseInventory}
                <ArrowIcon />
              </a>
              <a href="/finance" className="wf-button wf-button--ghost">{copy.financeOptions}</a>
            </div>
          </div>
          <div className="wf-command-visual">
            <HeroImage vehicle={vehicle} copy={copy} />
            <div className="wf-command-scan" aria-hidden="true" />
            <CommandTelemetry count={props.vehicles.length} />
            <div className="wf-command-strip">
              <span>{copy.inventorySignal}</span>
              <strong>{vehicle ? props.formatPrice(vehicle.price) : copy.availableNow}</strong>
            </div>
          </div>
        </div>
      </section>
      <CommandInventoryBoard props={props} copy={copy} />
    </>
  );
}

function LucentHome({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicle = heroVehicle(props);
  const profile = props.site.profile;
  return (
    <>
      <section className="wf-hero wf-hero--lucent">
        <div className="wf-shell wf-lucent-grid">
          <div className="wf-lucent-copy">
            <div className="wf-kicker wf-motion-one">
              <Sparkles size={16} />
              {copy.studioSelected}
            </div>
            <h1 className="wf-hero-title wf-motion-two">{profile.heroTitle ?? profile.dealershipName}</h1>
            <p className="wf-hero-copy wf-motion-three">{profile.heroSubtitle}</p>
            <div className="wf-hero-buttons wf-motion-four">
              <a href="/inventory" className="wf-button wf-button--primary">
                {props.t.browseInventory}
                <ArrowIcon />
              </a>
              <a href="/finance" className="wf-button wf-button--ghost">{props.t.financeTitle}</a>
            </div>
          </div>
          <div className="wf-lucent-stage">
            <HeroImage vehicle={vehicle} copy={copy} />
            <StudioStack vehicle={vehicle} props={props} copy={copy} />
            <div className="wf-studio-card">
              <span>{copy.financeOptions}</span>
              <strong>{vehicle ? props.formatPrice(vehicle.price) : props.t.contactForPrice}</strong>
              <a href="/finance">{props.t.requestFinancing}</a>
            </div>
          </div>
        </div>
      </section>
      <StudioInventoryLookbook props={props} copy={copy} />
    </>
  );
}

function ConciergeHome({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicle = heroVehicle(props);
  const profile = props.site.profile;
  return (
    <>
      <section className="wf-hero wf-hero--concierge">
        <div className="wf-shell wf-editorial-grid">
          <div className="wf-editorial-story">
            <div className="wf-kicker wf-motion-one">
              <Crown size={16} />
              {copy.editorsPick}
            </div>
            <h1 className="wf-hero-title wf-motion-two">{profile.heroTitle ?? profile.dealershipName}</h1>
            <p className="wf-hero-copy wf-motion-three">{profile.heroSubtitle}</p>
            <EditorialIndex vehicles={props.featuredVehicles} copy={copy} />
            <div className="wf-hero-buttons wf-motion-four">
              <a href="/contact" className="wf-button wf-button--primary">
                {copy.askConcierge}
                <ArrowIcon />
              </a>
              <a href="/inventory" className="wf-button wf-button--ghost">{props.t.browseInventory}</a>
            </div>
          </div>
          <div className="wf-editorial-cover">
            <HeroImage vehicle={vehicle} copy={copy} />
            <div className="wf-cover-caption">
              <span>{copy.featuredArrival}</span>
              <strong>{vehicle ? vehicleName(vehicle) : profile.dealershipName}</strong>
            </div>
          </div>
        </div>
      </section>
      <EditorialInventoryIssue props={props} copy={copy} />
    </>
  );
}

function showcaseVehicles(props: ThemeProps) {
  return props.featuredVehicles.length ? props.featuredVehicles : props.vehicles.slice(0, 6);
}

function AtelierInventoryWall({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicles = showcaseVehicles(props);
  if (!vehicles.length) return <HomeExperienceEmpty props={props} copy={copy} className="wf-atelier-wall" />;
  return (
    <section className="wf-home-experience wf-atelier-wall">
      <div className="wf-shell wf-atelier-wall-grid">
        <div className="wf-atelier-ledger">
          <p className="wf-section-kicker">{copy.privateViewing}</p>
          <h2>{props.t.featuredVehicles}</h2>
          <p>{copy.updatedFromShowroom}</p>
          <div className="wf-atelier-ledger-stats">
            <span>{copy.availableNow}<strong>{props.vehicles.length}</strong></span>
            <span>{copy.instantReply}<strong>{copy.readyToday}</strong></span>
          </div>
          <a href="/inventory" className="wf-inline-link">
            {props.t.viewAll}
            <ArrowIcon />
          </a>
        </div>
        <div className="wf-atelier-showroom-track">
          {vehicles.slice(0, 4).map((vehicle, index) => (
            <VehicleCard key={vehicle.id} vehicle={vehicle} props={props} copy={copy} index={index} variant="gallery" />
          ))}
        </div>
      </div>
    </section>
  );
}

function RouteInventoryJourney({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicles = showcaseVehicles(props);
  if (!vehicles.length) return <HomeExperienceEmpty props={props} copy={copy} className="wf-route-journey" />;
  return (
    <section className="wf-home-experience wf-route-journey">
      <div className="wf-shell">
        <div className="wf-route-journey-heading">
          <div>
            <p className="wf-section-kicker">{copy.routeReady}</p>
            <h2>{props.t.featuredVehicles}</h2>
          </div>
          <a href="/inventory" className="wf-inline-link">
            {props.t.viewAll}
            <ArrowIcon />
          </a>
        </div>
        <div className="wf-route-lanes">
          {vehicles.slice(0, 5).map((vehicle, index) => (
            <div key={vehicle.id} className="wf-route-stop">
              <span className="wf-route-stop-index">0{index + 1}</span>
              <VehicleCard vehicle={vehicle} props={props} copy={copy} index={index} variant="route" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CommandInventoryBoard({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicles = showcaseVehicles(props);
  if (!vehicles.length) return <HomeExperienceEmpty props={props} copy={copy} className="wf-command-board" />;
  return (
    <section className="wf-home-experience wf-command-board">
      <div className="wf-shell wf-command-board-grid">
        <aside className="wf-command-sidebar">
          <p className="wf-section-kicker">{copy.inventorySignal}</p>
          <h2>{copy.commandCenter}</h2>
          <div className="wf-command-readouts">
            <Metric icon={<Car size={16} />} label={props.t.inventoryTitle} value={`${props.vehicles.length}`} />
            <Metric icon={<ShieldCheck size={16} />} label={copy.verifiedInventory} value={copy.availableNow} />
            <Metric icon={<Zap size={16} />} label={copy.instantReply} value={copy.readyToday} />
          </div>
        </aside>
        <div className="wf-command-board-results">
          <div className="wf-command-board-bar">
            <span>{copy.availableNow}</span>
            <a href="/inventory">{props.t.viewAll}</a>
          </div>
          <VehicleGrid vehicles={vehicles.slice(0, 6)} props={props} copy={copy} variant="command" />
        </div>
      </div>
    </section>
  );
}

function StudioInventoryLookbook({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicles = showcaseVehicles(props);
  if (!vehicles.length) return <HomeExperienceEmpty props={props} copy={copy} className="wf-studio-lookbook" />;
  const leadVehicle = vehicles[0] ?? null;
  return (
    <section className="wf-home-experience wf-studio-lookbook">
      <div className="wf-shell wf-studio-lookbook-grid">
        <div className="wf-studio-lookbook-cover">
          <p className="wf-section-kicker">{copy.studioSelected}</p>
          <h2>{props.t.featuredVehicles}</h2>
          <p>{props.t.featuredSub}</p>
          {leadVehicle && (
            <Link href={`/inventory/${leadVehicle.slug}`} className="wf-studio-feature-link">
              <HeroImage vehicle={leadVehicle} copy={copy} />
              <span>{vehicleName(leadVehicle)}</span>
            </Link>
          )}
        </div>
        <div className="wf-studio-lookbook-strip">
          {vehicles.slice(1, 5).map((vehicle, index) => (
            <VehicleCard key={vehicle.id} vehicle={vehicle} props={props} copy={copy} index={index} variant="studio" />
          ))}
        </div>
      </div>
    </section>
  );
}

function EditorialInventoryIssue({ props, copy }: { props: ThemeProps; copy: ShowcaseCopy }) {
  const vehicles = showcaseVehicles(props);
  if (!vehicles.length) return <HomeExperienceEmpty props={props} copy={copy} className="wf-editorial-issue" />;
  return (
    <section className="wf-home-experience wf-editorial-issue">
      <div className="wf-shell wf-editorial-issue-layout">
        <div className="wf-editorial-issue-title">
          <p className="wf-section-kicker">{copy.editorsPick}</p>
          <h2>{props.t.featuredVehicles}</h2>
          <p>{copy.updatedFromShowroom}</p>
          <a href="/inventory" className="wf-inline-link">
            {props.t.viewAll}
            <ArrowIcon />
          </a>
        </div>
        <div className="wf-editorial-issue-list">
          {vehicles.slice(0, 5).map((vehicle, index) => (
            <Link key={vehicle.id} href={`/inventory/${vehicle.slug}`} className="wf-editorial-row">
              <span>0{index + 1}</span>
              <strong>{vehicleName(vehicle)}</strong>
              <em>{props.formatPrice(vehicle.price)}</em>
              <i>{vehicle.status}</i>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function HomeExperienceEmpty({
  props,
  copy,
  className,
}: {
  props: ThemeProps;
  copy: ShowcaseCopy;
  className: string;
}) {
  return (
    <section className={`wf-home-experience ${className}`}>
      <div className="wf-shell">
        <div className="wf-empty">
          <strong>{copy.updatedFromShowroom}</strong>
          <p>{props.t.noVehicles}</p>
        </div>
      </div>
    </section>
  );
}

function ShowcaseInventory({
  props,
  design,
  copy,
}: {
  props: ThemeProps;
  design: ShowcaseDesign;
  copy: ShowcaseCopy;
}) {
  const variant = vehicleVariantForDesign(design);
  const [query, setQuery] = useState("");
  const [make, setMake] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<InventorySort>("newest");
  const makeOptions = useMemo(() => uniqueVehicleValues(props.vehicles, (vehicle) => vehicle.make), [props.vehicles]);
  const statusOptions = useMemo(() => uniqueVehicleValues(props.vehicles, (vehicle) => vehicle.status), [props.vehicles]);
  const filteredVehicles = useMemo(
    () => filterAndSortVehicles({ vehicles: props.vehicles, query, make, status, sort }),
    [make, props.vehicles, query, sort, status],
  );
  const hasActiveFilters = Boolean(query.trim()) || make !== "all" || status !== "all" || sort !== "newest";
  const filters: InventoryFilterValues = {
    query,
    make,
    status,
    sort,
    makeOptions,
    statusOptions,
    hasActiveFilters,
  };
  const filterActions: InventoryFilterActions = {
    setQuery,
    setMake,
    setStatus,
    setSort,
    clearFilters: () => {
      setQuery("");
      setMake("all");
      setStatus("all");
      setSort("newest");
    },
  };

  return (
    <section className={`wf-page wf-shell wf-inventory-page wf-inventory-page--${variant}`}>
      <div className="wf-inventory-masthead">
        <div className="wf-page-heading">
          <p className="wf-section-kicker">{copy.availableNow}</p>
          <h1>{props.t.inventoryTitle}</h1>
          <p>{props.t.inventorySub}</p>
        </div>
        <InventoryPersonaPanel props={props} copy={copy} variant={variant} />
      </div>
      <div className="wf-inventory-layout">
        <aside className="wf-inventory-side">
          <div className="wf-inventory-toolbar">
            <span><SlidersHorizontal size={15} /> {copy.verifiedInventory}</span>
            <span dir="ltr">{filteredVehicles.length} / {props.vehicles.length} {copy.matchingCars}</span>
          </div>
          <InventoryControls copy={copy} filters={filters} actions={filterActions} />
        </aside>
        <div className="wf-inventory-results">
          <VehicleGrid
            vehicles={filteredVehicles}
            props={props}
            copy={copy}
            variant={variant}
            emptyMessage={hasActiveFilters ? copy.noMatches : props.t.noVehicles}
          />
        </div>
      </div>
    </section>
  );
}

function InventoryPersonaPanel({
  props,
  copy,
  variant,
}: {
  props: ThemeProps;
  copy: ShowcaseCopy;
  variant: VehicleCardVariant;
}) {
  if (variant === "command") {
    return (
      <div className="wf-inventory-persona wf-inventory-persona--command">
        <CommandTelemetry count={props.vehicles.length} />
        <span>{copy.inventorySignal}</span>
      </div>
    );
  }
  if (variant === "route") {
    return (
      <div className="wf-inventory-persona wf-inventory-persona--route">
        <span>{copy.showroom}</span>
        <i />
        <span>{copy.readyToday}</span>
        <i />
        <span>{copy.deliveryReady}</span>
      </div>
    );
  }
  if (variant === "studio") {
    return (
      <div className="wf-inventory-persona wf-inventory-persona--studio">
        <Sparkles size={18} />
        <span>{copy.studioSelected}</span>
      </div>
    );
  }
  if (variant === "editorial") {
    return (
      <div className="wf-inventory-persona wf-inventory-persona--editorial">
        <span>01</span>
        <strong>{copy.editorsPick}</strong>
      </div>
    );
  }
  return (
    <div className="wf-inventory-persona wf-inventory-persona--gallery">
      <Crown size={18} />
      <span>{copy.privateViewing}</span>
    </div>
  );
}

function InventoryControls({
  copy,
  filters,
  actions,
}: {
  copy: ShowcaseCopy;
  filters: InventoryFilterValues;
  actions: InventoryFilterActions;
}) {
  return (
    <div className="wf-inventory-controls">
      <label className="wf-search-field">
        <Search size={17} />
        <input
          type="search"
          dir="auto"
          value={filters.query}
          onChange={(event) => actions.setQuery(event.target.value)}
          placeholder={copy.searchPlaceholder}
          aria-label={copy.searchPlaceholder}
        />
      </label>
      <div className="wf-filter-grid" role="group" aria-label={copy.filters}>
        <InventorySelect
          value={filters.make}
          allLabel={copy.allMakes}
          options={filters.makeOptions}
          onChange={actions.setMake}
        />
        <InventorySelect
          value={filters.status}
          allLabel={copy.allStatuses}
          options={filters.statusOptions}
          onChange={actions.setStatus}
        />
        <select
          value={filters.sort}
          onChange={(event) => actions.setSort(event.target.value as InventorySort)}
          aria-label={copy.sortBy}
        >
          <option value="newest">{copy.sortNewest}</option>
          <option value="price_low">{copy.sortPriceLow}</option>
          <option value="price_high">{copy.sortPriceHigh}</option>
          <option value="mileage_low">{copy.sortMileageLow}</option>
        </select>
        <button
          type="button"
          className="wf-filter-reset"
          disabled={!filters.hasActiveFilters}
          onClick={actions.clearFilters}
        >
          {copy.clearFilters}
        </button>
      </div>
    </div>
  );
}

function InventorySelect({
  value,
  allLabel,
  options,
  onChange,
}: {
  value: string;
  allLabel: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={allLabel}>
      <option value="all">{allLabel}</option>
      {options.map((option) => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  );
}

function VehicleGrid({
  vehicles,
  props,
  copy,
  variant,
  emptyMessage,
}: {
  vehicles: PublicVehicle[];
  props: ThemeProps;
  copy: ShowcaseCopy;
  variant: VehicleCardVariant;
  emptyMessage?: string;
}) {
  if (!vehicles.length) {
    return <div className="wf-empty">{emptyMessage ?? props.t.noVehicles}</div>;
  }
  return (
    <div className={`wf-vehicle-grid wf-vehicle-grid--${variant}`}>
      {vehicles.map((vehicle, index) => (
        <VehicleCard
          key={vehicle.id}
          vehicle={vehicle}
          props={props}
          copy={copy}
          index={index}
          variant={variant}
        />
      ))}
    </div>
  );
}

function VehicleCard({
  vehicle,
  props,
  copy,
  index,
  variant,
}: {
  vehicle: PublicVehicle;
  props: ThemeProps;
  copy: ShowcaseCopy;
  index: number;
  variant: VehicleCardVariant;
}) {
  const specs = vehicleSpecs(vehicle, copy).slice(0, 3);
  return (
    <article
      className={`wf-vehicle-card wf-vehicle-card--${variant} ${index === 0 ? "wf-vehicle-card--lead" : ""}`}
      style={{ "--wf-card-index": index } as CSSProperties}
    >
      <VehicleCardDecoration variant={variant} index={index} />
      <VehicleCardMedia vehicle={vehicle} copy={copy} />
      <div className="wf-vehicle-body">
        <p className="wf-vehicle-eyebrow">{variant === "editorial" ? copy.editorsPick : copy.availableNow}</p>
        <h3>{vehicleName(vehicle)}</h3>
        <div className="wf-specs">
          {specs.map((spec) => <span key={spec}>{spec}</span>)}
        </div>
        <div className="wf-card-footer">
          <strong dir="ltr">{props.formatPrice(vehicle.price)}</strong>
          <span>{copy.financeBadge}</span>
        </div>
        <VehicleCardActions vehicle={vehicle} props={props} copy={copy} />
      </div>
    </article>
  );
}

function VehicleCardDecoration({
  variant,
  index,
}: {
  variant: VehicleCardVariant;
  index: number;
}) {
  return (
    <>
      {variant === "command" && (
        <span className="wf-card-signal" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      {variant === "route" && <span className="wf-card-route-pin" aria-hidden="true" />}
      {variant === "studio" && <span className="wf-card-number" aria-hidden="true">0{index + 1}</span>}
      {variant === "editorial" && <span className="wf-card-edition" aria-hidden="true">No. 0{index + 1}</span>}
    </>
  );
}

function VehicleCardMedia({ vehicle, copy }: { vehicle: PublicVehicle; copy: ShowcaseCopy }) {
  return (
    <Link href={`/inventory/${vehicle.slug}`} className="wf-vehicle-media-link" aria-label={`${copy.viewDetails}: ${vehicleName(vehicle)}`}>
      <div className="wf-vehicle-media">
        <VehicleImage vehicle={vehicle} copy={copy} />
        <span className="wf-status">{vehicle.status}</span>
      </div>
    </Link>
  );
}

function VehicleCardActions({
  vehicle,
  props,
  copy,
}: {
  vehicle: PublicVehicle;
  props: ThemeProps;
  copy: ShowcaseCopy;
}) {
  const phone = props.site.profile.phone;
  const inquiryMessage = vehicleContactMessage(props, vehicle);

  return (
    <div className="wf-card-actions">
      <Link href={`/inventory/${vehicle.slug}`} className="wf-card-action wf-card-action--primary">
        {copy.viewDetails}
      </Link>
      {phone ? (
        <>
          <a
            href={whatsappHref(phone, inquiryMessage)}
            className="wf-card-action"
            target="_blank"
            rel="noopener noreferrer"
          >
            <MessageCircle size={14} />
            <span>{copy.whatsappDealer}</span>
          </a>
          <a href={phoneHref(phone)} className="wf-card-action">
            <Phone size={14} />
            <span>{copy.callDealer}</span>
          </a>
        </>
      ) : (
        <a href="/contact" className="wf-card-action">
          {copy.contactDealer}
        </a>
      )}
    </div>
  );
}

function ShowcaseVehicleDetail({
  props,
  design,
  copy,
}: {
  props: ThemeProps;
  design: ShowcaseDesign;
  copy: ShowcaseCopy;
}) {
  const vehicle = props.detailVehicle;
  if (!vehicle) return null;
  const similarVehicles = similarVehiclesFor(vehicle, props.vehicles);
  const variant = vehicleVariantForDesign(design);
  const specs = [
    [props.t.trim, vehicle.trim],
    [props.t.mileage, vehicle.mileage ? `${vehicle.mileage.toLocaleString()} ${copy.mileageShort}` : null],
    [props.t.transmission, vehicle.transmission],
    [props.t.fuelType, vehicle.fuelType],
    [props.t.color, vehicle.exteriorColor],
  ].filter(([, value]) => Boolean(value));

  return (
    <>
      <section className={`wf-page wf-shell wf-detail-page wf-detail-page--${variant}`}>
        <div className="wf-detail-media">
          <VehicleImage vehicle={vehicle} copy={copy} />
        </div>
        <div className="wf-detail-info">
          <p className="wf-section-kicker">{design.title}</p>
          <span className="wf-status wf-status--static">{vehicle.status}</span>
          <h1>{vehicleName(vehicle)}</h1>
          {vehicle.trim && <p className="wf-detail-trim">{vehicle.trim}</p>}
          <strong className="wf-detail-price" dir="ltr">{props.formatPrice(vehicle.price)}</strong>
          <DetailActionPanel props={props} copy={copy} vehicle={vehicle} />
          <div className="wf-detail-specs">
            {specs.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <VehicleDetailLeadPanel props={props} design={design} copy={copy} vehicle={vehicle} />
        </div>
      </section>
      <SimilarVehiclesSection vehicles={similarVehicles} props={props} copy={copy} variant={variant} />
      <MobileVehicleActions props={props} copy={copy} vehicle={vehicle} />
    </>
  );
}

function VehicleDetailLeadPanel({
  props,
  design,
  copy,
  vehicle,
}: {
  props: ThemeProps;
  design: ShowcaseDesign;
  copy: ShowcaseCopy;
  vehicle: PublicVehicle;
}) {
  if (props.formSuccess === "vehicle_inquiry") {
    return <SuccessPanel t={props.t} onReset={() => props.setFormSuccess(null)} />;
  }

  return (
    <LeadPanel
      id="vehicle-lead-form"
      title={props.t.askAbout}
      submitLabel={props.t.sendInquiry}
      props={props}
      copy={copy}
      turnstileTheme={design.darkTurnstile ? "dark" : "light"}
      onSubmit={(event) => {
        props.setSelectedVehicleId(vehicle.id);
        props.onSubmit(event, "vehicle_inquiry");
      }}
    />
  );
}

function SimilarVehiclesSection({
  vehicles,
  props,
  copy,
  variant,
}: {
  vehicles: PublicVehicle[];
  props: ThemeProps;
  copy: ShowcaseCopy;
  variant: VehicleCardVariant;
}) {
  if (!vehicles.length) return null;

  return (
    <section className="wf-section wf-similar-section">
      <div className="wf-shell">
        <div className="wf-section-heading">
          <div>
            <p className="wf-section-kicker">{copy.updatedFromShowroom}</p>
            <h2>{copy.similarCars}</h2>
          </div>
          <a href="/inventory" className="wf-inline-link">
            {props.t.viewAll}
            <ArrowIcon />
          </a>
        </div>
        <VehicleGrid vehicles={vehicles} props={props} copy={copy} variant={variant} />
      </div>
    </section>
  );
}

function DetailActionPanel({
  props,
  copy,
  vehicle,
}: {
  props: ThemeProps;
  copy: ShowcaseCopy;
  vehicle: PublicVehicle;
}) {
  const profile = props.site.profile;

  return (
    <aside className="wf-detail-action-panel" aria-label={copy.stickyInquiry}>
      <p className="wf-panel-kicker">
        <ShieldCheck size={15} />
        {copy.dealerTrust}
      </p>
      <h2>{copy.stickyInquiry}</h2>
      <DetailActionButtons props={props} copy={copy} vehicle={vehicle} />
      <DetailTrustList profile={profile} props={props} copy={copy} />
    </aside>
  );
}

function DetailActionButtons({
  props,
  copy,
  vehicle,
}: {
  props: ThemeProps;
  copy: ShowcaseCopy;
  vehicle: PublicVehicle;
}) {
  const phone = props.site.profile.phone;
  const inquiryMessage = vehicleContactMessage(props, vehicle);
  const shareMessage = vehicleShareMessage(props, vehicle);

  return (
    <div className="wf-detail-action-grid">
      {phone ? (
        <>
          <a
            href={whatsappHref(phone, inquiryMessage)}
            className="wf-detail-action wf-detail-action--primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            <MessageCircle size={16} />
            {copy.whatsappDealer}
          </a>
          <a href={phoneHref(phone)} className="wf-detail-action">
            <Phone size={16} />
            {copy.callDealer}
          </a>
        </>
      ) : (
        <a href="#vehicle-lead-form" className="wf-detail-action wf-detail-action--primary">
          <Mail size={16} />
          {copy.contactDealer}
        </a>
      )}
      <a href="/finance" className="wf-detail-action">
        <Sparkles size={16} />
        {copy.requestFinance}
      </a>
      <a
        href={`https://wa.me/?text=${encodeURIComponent(shareMessage)}`}
        className="wf-detail-action"
        target="_blank"
        rel="noopener noreferrer"
      >
        <Share2 size={16} />
        {copy.shareVehicle}
      </a>
    </div>
  );
}

function DetailTrustList({
  profile,
  props,
  copy,
}: {
  profile: ThemeProps["site"]["profile"];
  props: ThemeProps;
  copy: ShowcaseCopy;
}) {
  return (
    <ul className="wf-trust-list">
      <li>
        <CheckCircle2 size={15} />
        <span>{copy.updatedFromShowroom}</span>
      </li>
      <li>
        <CheckCircle2 size={15} />
        <span>{props.t.contactMethodHint}</span>
      </li>
      {profile.address && (
        <li>
          <MapPin size={15} />
          <span>{profile.address}</span>
        </li>
      )}
    </ul>
  );
}

function MobileVehicleActions({
  props,
  copy,
  vehicle,
}: {
  props: ThemeProps;
  copy: ShowcaseCopy;
  vehicle: PublicVehicle;
}) {
  const phone = props.site.profile.phone;
  const inquiryMessage = vehicleContactMessage(props, vehicle);

  return (
    <div className={`wf-mobile-sticky-actions ${phone ? "" : "wf-mobile-sticky-actions--two"}`} role="region" aria-label={copy.mobileContactPrompt}>
      {phone ? (
        <>
          <a href={whatsappHref(phone, inquiryMessage)} target="_blank" rel="noopener noreferrer">
            <MessageCircle size={16} />
            <span>{copy.whatsappDealer}</span>
          </a>
          <a href={phoneHref(phone)}>
            <Phone size={16} />
            <span>{copy.callDealer}</span>
          </a>
        </>
      ) : (
        <a href="#vehicle-lead-form">
          <Mail size={16} />
          <span>{copy.contactDealer}</span>
        </a>
      )}
      <a href="#vehicle-lead-form" className="wf-mobile-sticky-primary">
        {props.t.sendInquiry}
      </a>
    </div>
  );
}

function ShowcaseFinance({
  props,
  design,
  copy,
}: {
  props: ThemeProps;
  design: ShowcaseDesign;
  copy: ShowcaseCopy;
}) {
  return (
    <section className="wf-page wf-shell wf-form-page">
      <div className="wf-page-heading">
        <p className="wf-section-kicker">{design.title}</p>
        <h1>{props.t.financeTitle}</h1>
        <p>{props.site.legal.financingDisclaimer}</p>
      </div>
      {props.formSuccess === "financing" ? (
        <SuccessPanel t={props.t} onReset={() => props.setFormSuccess(null)} />
      ) : (
        <LeadPanel
          title={copy.financeOptions}
          submitLabel={props.t.requestFinancing}
          props={props}
          copy={copy}
          turnstileTheme={design.darkTurnstile ? "dark" : "light"}
          onSubmit={(event) => props.onSubmit(event, "financing")}
        />
      )}
    </section>
  );
}

function ShowcaseBranches({
  props,
  design,
}: {
  props: ThemeProps;
  design: ShowcaseDesign;
}) {
  return (
    <section className="wf-page wf-shell">
      <div className="wf-page-heading">
        <p className="wf-section-kicker">{design.title}</p>
        <h1>{props.t.branchesTitle}</h1>
      </div>
      <div className="wf-branch-grid">
        {props.site.profile.branches.map((branch) => (
          <div key={branch.id} className="wf-branch-card">
            <MapPin size={22} />
            <h2>{branch.name}</h2>
            {branch.address && (
              <p>
                {branch.address.startsWith("http") ? (
                  <a href={branch.address} target="_blank" rel="noopener noreferrer">{props.t.viewOnMap}</a>
                ) : branch.address}
              </p>
            )}
            {branch.phone && <a href={`tel:${branch.phone}`} dir="ltr">{branch.phone}</a>}
          </div>
        ))}
      </div>
    </section>
  );
}

function ShowcaseContact({
  props,
  design,
  copy,
}: {
  props: ThemeProps;
  design: ShowcaseDesign;
  copy: ShowcaseCopy;
}) {
  const profile = props.site.profile;
  return (
    <section className="wf-page wf-shell wf-contact-page">
      <div>
        <p className="wf-section-kicker">{design.title}</p>
        <h1>{props.t.contactTitle}</h1>
        {profile.phone && (
          <div className="wf-contact-actions">
            <a
              href={whatsappHref(profile.phone, dealerContactMessage(props))}
              className="wf-button wf-button--primary"
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircle size={17} />
              {copy.whatsappDealer}
            </a>
            <a href={phoneHref(profile.phone)} className="wf-button wf-button--ghost" dir="ltr">
              <Phone size={17} />
              {copy.callDealer}
            </a>
          </div>
        )}
        <div className="wf-contact-list">
          {profile.phone && (
            <a
              href={whatsappHref(profile.phone, dealerContactMessage(props))}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircle size={18} />
              <span>{copy.whatsappDealer}</span>
            </a>
          )}
          {profile.phone && (
            <a href={phoneHref(profile.phone)}>
              <Phone size={18} />
              <span dir="ltr">{profile.phone}</span>
            </a>
          )}
          {profile.address && (
            <p>
              <MapPin size={18} />
              <span>{profile.address}</span>
            </p>
          )}
        </div>
        <p className="wf-disclaimer">
          <ShieldCheck size={14} />
          {props.t.contactDisclaimer}
        </p>
      </div>
      {props.formSuccess === "contact" ? (
        <SuccessPanel t={props.t} onReset={() => props.setFormSuccess(null)} />
      ) : (
        <LeadPanel
          title={design.id === "concierge" ? copy.askConcierge : props.t.sendMessage}
          submitLabel={props.t.sendMessage}
          props={props}
          copy={copy}
          turnstileTheme={design.darkTurnstile ? "dark" : "light"}
          onSubmit={(event) => props.onSubmit(event, "contact")}
        />
      )}
    </section>
  );
}

function ShowcaseLegal({ props }: { props: ThemeProps }) {
  const pageTitle = props.page === "privacy"
    ? props.t.privacyTitle
    : props.page === "terms"
      ? props.t.termsTitle
      : props.t.dataDeletionTitle;
  const body = props.page === "privacy"
    ? props.site.legal.privacyPolicy
    : props.page === "terms"
      ? props.site.legal.terms
      : props.site.legal.dataDeletion;

  return (
    <section className="wf-page wf-shell wf-legal-page">
      <p className="wf-section-kicker">AutoFlow</p>
      <h1>{pageTitle}</h1>
      <p>{body}</p>
    </section>
  );
}

function LeadPanel({
  id,
  title,
  submitLabel,
  props,
  copy,
  turnstileTheme,
  onSubmit,
}: {
  id?: string;
  title: string;
  submitLabel: string;
  props: ThemeProps;
  copy: ShowcaseCopy;
  turnstileTheme: "dark" | "light";
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form id={id} className="wf-lead-panel" onSubmit={onSubmit}>
      <h2>{title}</h2>
      <LeadFields form={props.form} setForm={props.setForm} t={props.t} />
      <TurnstileWidget siteKey={props.turnstileSiteKey} theme={turnstileTheme} />
      <button type="submit" className="wf-button wf-button--primary wf-submit" disabled={props.isSubmitting}>
        {submitLabel || copy.bookViewing}
      </button>
    </form>
  );
}

function LeadFields({
  form,
  setForm,
  t,
}: {
  form: FormState;
  setForm: (form: FormState) => void;
  t: SiteStrings;
}) {
  return (
    <div className="wf-fields">
      <div className="wf-field-row wf-field-row--two">
        <input
          required
          dir="auto"
          value={form.firstName}
          onChange={(event) => setForm({ ...form, firstName: event.target.value })}
          placeholder={t.placeholderFirstName}
        />
        <input
          dir="auto"
          value={form.lastName}
          onChange={(event) => setForm({ ...form, lastName: event.target.value })}
          placeholder={t.placeholderLastName}
        />
      </div>
      <div className="wf-field-row wf-field-row--three">
        <input
          type="email"
          dir="auto"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          placeholder={t.placeholderEmail}
        />
        <input
          dir="auto"
          value={form.phone}
          onChange={(event) => setForm({ ...form, phone: event.target.value })}
          placeholder={t.placeholderPhone}
        />
        <input
          dir="auto"
          value={form.whatsapp}
          onChange={(event) => setForm({ ...form, whatsapp: event.target.value })}
          placeholder={t.placeholderWhatsApp}
        />
      </div>
      <textarea
        dir="auto"
        value={form.message}
        onChange={(event) => setForm({ ...form, message: event.target.value })}
        placeholder={t.placeholderMessage}
        rows={4}
      />
      <p className="wf-form-hint">
        <Mail size={13} />
        {t.contactMethodHint}
      </p>
    </div>
  );
}

function SuccessPanel({ t, onReset }: { t: SiteStrings; onReset: () => void }) {
  return (
    <div className="wf-success">
      <CheckCircle2 size={42} />
      <h2>{t.thankYou}</h2>
      <p>{t.messageReceived}</p>
      <button type="button" className="wf-button wf-button--primary" onClick={onReset}>
        {t.sendAnother}
      </button>
    </div>
  );
}

function ShowcaseFooter({
  profile,
  navLinks,
  t,
  copy,
}: {
  profile: ThemeProps["site"]["profile"];
  navLinks: readonly (readonly [string, string])[];
  t: SiteStrings;
  copy: ShowcaseCopy;
}) {
  return (
    <footer className="wf-footer">
      <div className="wf-shell wf-footer-grid">
        <div>
          <p className="wf-footer-brand">{profile.dealershipName}</p>
          {profile.phone && (
            <a href={`tel:${profile.phone}`} className="wf-footer-phone" dir="ltr">
              {profile.phone}
            </a>
          )}
        </div>
        <nav>
          {navLinks.map(([label, href]) => (
            <a key={href} href={href}>{label}</a>
          ))}
        </nav>
        <div className="wf-footer-legal">
          <a href="/privacy">{t.footerPrivacy}</a>
          <a href="/terms">{t.footerTerms}</a>
          <a href="/data-deletion">{t.footerDataDeletion}</a>
          <span>{copy.verifiedInventory}</span>
        </div>
      </div>
    </footer>
  );
}

function HeroImage({ vehicle, copy }: { vehicle: PublicVehicle | null; copy: ShowcaseCopy }) {
  if (vehicle?.imageUrls[0]) {
    return <img src={vehicle.imageUrls[0]} alt={vehicleName(vehicle)} className="wf-hero-image" />;
  }
  return (
    <div className="wf-image-fallback">
      <Car size={58} />
      <span>{copy.noImage}</span>
    </div>
  );
}

function VehicleImage({ vehicle, copy }: { vehicle: PublicVehicle; copy: ShowcaseCopy }) {
  if (vehicle.imageUrls[0]) {
    return <img src={vehicle.imageUrls[0]} alt={vehicleName(vehicle)} />;
  }
  return (
    <div className="wf-image-fallback">
      <Car size={44} />
      <span>{copy.noImage}</span>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="wf-metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ShowcaseStyles() {
  return (
    <style>{`
      .wf {
        min-height: 100vh;
        background: var(--wf-bg);
        color: var(--wf-text);
        font-family: "Inter", "IBM Plex Sans Arabic", "Tajawal", system-ui, sans-serif;
        overflow-x: hidden;
      }
      .wf * { box-sizing: border-box; }
      .wf a { color: inherit; text-decoration: none; }
      .wf button, .wf input, .wf textarea, .wf select { font: inherit; }
      .wf-shell { width: min(1280px, calc(100% - 48px)); margin: 0 auto; }
      @keyframes wf-rise {
        from { opacity: 0; transform: translateY(26px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes wf-film {
        from { transform: translateX(0); }
        to { transform: translateX(-50%); }
      }
      @keyframes wf-sweep {
        0% { transform: translateX(-110%) skewX(-18deg); opacity: 0; }
        18% { opacity: .36; }
        55% { opacity: .18; }
        100% { transform: translateX(120%) skewX(-18deg); opacity: 0; }
      }
      @keyframes wf-route-flow {
        from { background-position: 0 0; }
        to { background-position: 32px 0; }
      }
      @keyframes wf-scan {
        from { transform: translateY(-100%); }
        to { transform: translateY(100%); }
      }
      @keyframes wf-meter {
        0%, 100% { transform: scaleY(.45); }
        50% { transform: scaleY(1); }
      }
      @keyframes wf-float {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-12px); }
      }
      @keyframes wf-editorial-slide {
        from { transform: translateX(-18px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @media (prefers-reduced-motion: no-preference) {
        .wf-motion-one, .wf-motion-two, .wf-motion-three, .wf-motion-four, .wf-motion-five,
        .wf-atelier-panel, .wf-route-ticket, .wf-command-strip, .wf-studio-card, .wf-cover-caption,
        .wf-inventory-controls, .wf-detail-action-panel, .wf-home-experience {
          animation: wf-rise .72s cubic-bezier(.2, .8, .2, 1) both;
        }
        .wf-motion-two { animation-delay: .08s; }
        .wf-motion-three { animation-delay: .16s; }
        .wf-motion-four { animation-delay: .24s; }
        .wf-motion-five { animation-delay: .32s; }
        .wf-atelier-panel, .wf-route-ticket, .wf-command-strip, .wf-studio-card, .wf-cover-caption { animation-delay: .38s; }
        .wf-inventory-controls, .wf-detail-action-panel { animation-delay: .1s; }
        .wf-home-experience { animation-delay: .18s; }
        .wf-atelier-sweep { animation: wf-sweep 6.5s ease-in-out infinite; }
        .wf-live-rail > span { animation: wf-film 28s linear infinite; }
        .wf-route-map::before { animation: wf-route-flow 1.6s linear infinite; }
        .wf-command-scan { animation: wf-scan 3.6s linear infinite; }
        .wf-telemetry span { animation: wf-meter 1.4s ease-in-out infinite; }
        .wf-telemetry span:nth-child(2) { animation-delay: .2s; }
        .wf-telemetry span:nth-child(3) { animation-delay: .42s; }
        .wf-studio-stack { animation: wf-float 5.5s ease-in-out infinite; }
        .wf-editorial-index span { animation: wf-editorial-slide .62s cubic-bezier(.2, .8, .2, 1) both; }
        .wf-editorial-index span:nth-child(2) { animation-delay: .12s; }
        .wf-editorial-index span:nth-child(3) { animation-delay: .24s; }
        .wf-vehicle-card { animation: wf-rise .54s cubic-bezier(.2, .8, .2, 1) both; animation-delay: calc(var(--wf-card-index) * 60ms); }
      }
      @media (prefers-reduced-motion: reduce) {
        .wf *, .wf *::before, .wf *::after {
          animation-duration: .001ms !important;
          animation-iteration-count: 1 !important;
          scroll-behavior: auto !important;
          transition-duration: .001ms !important;
        }
      }
      .wf-preview {
        background: color-mix(in srgb, var(--wf-primary) 18%, var(--wf-bg));
        border-bottom: 1px solid var(--wf-line);
        color: var(--wf-text);
        padding: 9px 16px;
        text-align: center;
        font-size: 13px;
        font-weight: 700;
      }
      .wf-nav {
        position: sticky;
        top: 0;
        z-index: 40;
        border-bottom: 1px solid var(--wf-line);
        background: color-mix(in srgb, var(--wf-bg) 92%, transparent);
        backdrop-filter: blur(18px);
      }
      .wf-nav-inner { min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
      .wf-brand { display: inline-flex; align-items: center; gap: 12px; min-width: 0; }
      .wf-logo { height: 40px; max-width: 170px; object-fit: contain; }
      .wf-brand-mark {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: 8px;
        color: white;
        background: var(--wf-primary);
      }
      .wf-brand-name { font-size: 16px; font-weight: 850; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
      .wf-desktop-nav { display: flex; align-items: center; gap: 26px; }
      .wf-nav-link { color: var(--wf-muted); font-size: 14px; font-weight: 700; transition: color .2s ease; }
      .wf-nav-link:hover { color: var(--wf-text); }
      .wf-actions { display: flex; align-items: center; gap: 10px; }
      .wf-nav--obsidian .wf-nav-inner { min-height: 82px; border-inline: 1px solid rgba(255,255,255,.08); }
      .wf-nav--desert .wf-nav-inner { min-height: 78px; }
      .wf-nav--desert .wf-desktop-nav { border: 1px solid var(--wf-line); border-radius: 8px; padding: 9px 14px; background: rgba(255,255,255,.62); }
      .wf-nav--command {
        background:
          linear-gradient(90deg, rgba(37,99,235,.16) 1px, transparent 1px),
          rgba(11,17,28,.94);
        background-size: 24px 24px;
        color: white;
      }
      .wf-nav--command .wf-nav-link,
      .wf-nav--command .wf-brand-name { color: #dbe8ff; }
      .wf-nav--command .wf-language,
      .wf-nav--command .wf-menu-button { background: rgba(255,255,255,.08); color: white; border-color: rgba(255,255,255,.16); }
      .wf-nav--lucent { border-bottom: 0; background: color-mix(in srgb, var(--wf-bg) 78%, transparent); }
      .wf-nav--lucent .wf-nav-inner {
        min-height: 76px;
        margin-top: 12px;
        margin-bottom: 12px;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: rgba(255,255,255,.78);
        box-shadow: 0 18px 60px rgba(8,145,178,.08);
        padding-inline: 16px;
      }
      .wf-nav--concierge .wf-nav-inner { border-block-end: 3px double var(--wf-line); }
      .wf-nav--concierge .wf-brand-name { font-family: Georgia, "Times New Roman", "Noto Naskh Arabic", serif; }
      .wf-language, .wf-menu-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border: 1px solid var(--wf-line);
        color: var(--wf-text);
        background: var(--wf-panel);
        border-radius: 8px;
        min-height: 38px;
        padding: 0 12px;
        cursor: pointer;
      }
      .wf-menu-button { display: none; width: 40px; padding: 0; }
      .wf-primary-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 38px;
        border-radius: 8px;
        padding: 0 16px;
        background: var(--wf-primary);
        color: white;
        font-weight: 850;
        font-size: 13px;
      }
      .wf-mobile-nav { border-top: 1px solid var(--wf-line); padding: 8px 24px 14px; background: var(--wf-bg); }
      .wf-mobile-link { display: block; padding: 13px 0; border-bottom: 1px solid var(--wf-line); color: var(--wf-muted); font-weight: 750; }
      .wf-hero { position: relative; min-height: 690px; overflow: hidden; }
      .wf-hero-title {
        margin: 0;
        font-size: 72px;
        line-height: .98;
        letter-spacing: 0;
        font-weight: 950;
      }
      .wf-hero-copy {
        max-width: 620px;
        margin: 22px 0 0;
        color: var(--wf-muted);
        font-size: 18px;
        line-height: 1.8;
      }
      .wf-kicker, .wf-section-kicker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--wf-primary);
        font-size: 13px;
        font-weight: 900;
        letter-spacing: 0;
        margin-bottom: 16px;
      }
      .wf-hero-buttons { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 34px; }
      .wf-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        min-height: 46px;
        border-radius: 8px;
        border: 1px solid var(--wf-line);
        padding: 0 22px;
        font-weight: 900;
        cursor: pointer;
        transition: transform .2s ease, border-color .2s ease, background .2s ease;
      }
      .wf-button:hover { transform: translateY(-2px); }
      .wf-button:disabled { opacity: .55; cursor: not-allowed; transform: none; }
      .wf-button--primary { background: var(--wf-primary); color: white; border-color: var(--wf-primary); }
      .wf-button--ghost { background: color-mix(in srgb, var(--wf-panel) 80%, transparent); color: var(--wf-text); }
      .wf-arrow { transition: transform .2s ease; }
      .wf[dir="rtl"] .wf-arrow { transform: rotate(180deg); }
      .wf-hero-image, .wf-vehicle-media img, .wf-detail-media img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .wf-image-fallback {
        width: 100%;
        height: 100%;
        min-height: 260px;
        display: grid;
        place-items: center;
        gap: 10px;
        text-align: center;
        background: color-mix(in srgb, var(--wf-panel-strong) 78%, var(--wf-primary));
        color: color-mix(in srgb, var(--wf-muted) 70%, white);
      }
      .wf-hero-shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(0,0,0,.88), rgba(0,0,0,.36)); }
      .wf[dir="rtl"] .wf-hero-shade { background: linear-gradient(270deg, rgba(0,0,0,.88), rgba(0,0,0,.36)); }
      .wf-hero-content { position: relative; z-index: 2; padding: 120px 0 72px; }
      .wf-hero--obsidian .wf-hero-image { position: absolute; inset: 0; transform: scale(1.02); }
      .wf-hero-content--obsidian { min-height: 690px; display: flex; flex-direction: column; justify-content: center; }
      .wf-atelier-sweep {
        position: absolute;
        z-index: 2;
        top: -20%;
        bottom: -20%;
        width: 32%;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,.18), transparent);
        pointer-events: none;
      }
      .wf-atelier-panel {
        position: absolute;
        z-index: 3;
        inset-inline-end: 48px;
        bottom: 48px;
        width: min(360px, calc(100% - 96px));
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 8px;
        padding: 20px;
        background: rgba(8,9,8,.72);
        backdrop-filter: blur(18px);
      }
      .wf-atelier-panel p, .wf-atelier-panel span { color: var(--wf-muted); margin: 0; }
      .wf-atelier-panel strong { display: block; margin: 8px 0; font-size: 22px; }
      .wf-live-rail {
        position: absolute;
        z-index: 3;
        inset-inline: 0;
        bottom: 0;
        display: flex;
        overflow: hidden;
        border-block: 1px solid rgba(255,255,255,.12);
        background: rgba(8,9,8,.78);
        backdrop-filter: blur(18px);
      }
      .wf-live-rail > span {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 13px;
        min-width: 360px;
        padding: 15px 28px;
        color: var(--wf-muted);
        font-size: 12px;
        font-weight: 850;
        text-transform: uppercase;
      }
      .wf-live-rail strong { color: var(--wf-text); text-transform: none; }
      .wf-live-rail em { color: var(--wf-primary); font-style: normal; }
      .wf-desert-grid, .wf-command-grid, .wf-lucent-grid, .wf-editorial-grid {
        min-height: 650px;
        display: grid;
        grid-template-columns: minmax(0, .92fr) minmax(360px, 1.08fr);
        gap: 42px;
        align-items: center;
        padding: 72px 0;
      }
      .wf-hero--desert { background: linear-gradient(135deg, #f7f8f5 0%, #eef7f3 46%, #ffffff 100%); }
      .wf-route-stats {
        display: inline-grid;
        grid-template-columns: auto auto auto;
        align-items: center;
        gap: 12px;
        margin-top: 26px;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--wf-panel) 88%, transparent);
        padding: 12px 14px;
        color: var(--wf-muted);
        font-size: 12px;
        font-weight: 850;
      }
      .wf-route-stats strong { color: var(--wf-primary); font-size: 24px; }
      .wf-desert-stage, .wf-command-visual, .wf-lucent-stage, .wf-editorial-cover {
        position: relative;
        min-height: 470px;
        overflow: hidden;
        border-radius: 8px;
        border: 1px solid var(--wf-line);
        background: var(--wf-panel);
      }
      .wf-route-map {
        position: absolute;
        z-index: 2;
        inset-inline: 24px;
        top: 24px;
        display: grid;
        grid-template-columns: max-content 1fr max-content 1fr max-content;
        align-items: center;
        gap: 10px;
        border: 1px solid rgba(255,255,255,.22);
        border-radius: 8px;
        background: rgba(13,42,37,.72);
        color: white;
        padding: 11px 12px;
        backdrop-filter: blur(14px);
      }
      .wf-route-map::before {
        content: "";
        position: absolute;
        inset-inline: 18px;
        top: 50%;
        height: 2px;
        background: repeating-linear-gradient(90deg, rgba(255,255,255,.82) 0 8px, transparent 8px 16px);
        opacity: .5;
      }
      .wf-route-map span {
        position: relative;
        z-index: 1;
        border-radius: 8px;
        background: rgba(13,42,37,.86);
        padding: 5px 8px;
        font-size: 11px;
        font-weight: 900;
      }
      .wf-route-map i {
        position: relative;
        z-index: 1;
        display: block;
        height: 10px;
        border-radius: 99px;
        background: rgba(255,255,255,.2);
      }
      .wf-route-ticket, .wf-command-strip, .wf-studio-card, .wf-cover-caption {
        position: absolute;
        inset-inline-start: 20px;
        bottom: 20px;
        min-width: 220px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--wf-line) 70%, transparent);
        background: color-mix(in srgb, var(--wf-panel) 88%, transparent);
        padding: 16px;
        backdrop-filter: blur(16px);
      }
      .wf-route-ticket span, .wf-command-strip span, .wf-studio-card span, .wf-cover-caption span {
        display: block;
        color: var(--wf-muted);
        font-size: 12px;
        font-weight: 800;
      }
      .wf-route-ticket strong, .wf-command-strip strong, .wf-studio-card strong, .wf-cover-caption strong {
        display: block;
        margin: 5px 0;
        font-size: 24px;
      }
      .wf-command-grid { grid-template-columns: minmax(0, 1fr) minmax(360px, .95fr); }
      .wf-hero--command {
        background:
          linear-gradient(90deg, rgba(37,99,235,.08) 1px, transparent 1px),
          linear-gradient(0deg, rgba(37,99,235,.08) 1px, transparent 1px),
          #f4f7fa;
        background-size: 36px 36px;
      }
      .wf-command-metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        margin-top: 28px;
      }
      .wf-metric {
        min-height: 110px;
        border-radius: 8px;
        border: 1px solid var(--wf-line);
        padding: 14px;
        background: var(--wf-panel);
      }
      .wf-metric svg { color: var(--wf-primary); }
      .wf-metric span { display: block; margin-top: 12px; color: var(--wf-muted); font-size: 12px; }
      .wf-metric strong { display: block; margin-top: 4px; font-size: 16px; }
      .wf-command-visual { border: 8px solid var(--wf-panel-strong); box-shadow: 0 30px 90px rgba(15,23,42,.22); }
      .wf-command-scan {
        position: absolute;
        z-index: 2;
        inset-inline: 0;
        top: 0;
        height: 42%;
        background: linear-gradient(180deg, transparent, rgba(37,99,235,.24), transparent);
        mix-blend-mode: screen;
        pointer-events: none;
      }
      .wf-telemetry {
        position: absolute;
        z-index: 3;
        inset-inline-end: 20px;
        top: 20px;
        display: grid;
        grid-template-columns: repeat(3, 8px) auto;
        align-items: end;
        gap: 7px;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 8px;
        background: rgba(11,17,28,.78);
        color: white;
        padding: 12px;
        backdrop-filter: blur(14px);
      }
      .wf-telemetry span {
        display: block;
        height: 34px;
        transform-origin: bottom;
        border-radius: 99px;
        background: var(--wf-secondary);
      }
      .wf-telemetry strong { font-size: 22px; line-height: 1; }
      .wf-hero--lucent { background: #fbfcfc; }
      .wf-lucent-grid { grid-template-columns: minmax(0, .9fr) minmax(360px, 1.1fr); }
      .wf-lucent-stage {
        background:
          linear-gradient(120deg, rgba(255,255,255,.66), transparent 40%),
          var(--wf-panel-strong);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.62), 0 30px 80px rgba(8,145,178,.12);
      }
      .wf-studio-stack {
        position: absolute;
        inset-inline-end: 26px;
        top: 26px;
        z-index: 3;
        width: min(300px, calc(100% - 52px));
        border: 1px solid rgba(255,255,255,.72);
        border-radius: 8px;
        background: rgba(255,255,255,.78);
        box-shadow: 0 20px 60px rgba(8,145,178,.13);
        padding: 18px;
        backdrop-filter: blur(18px);
      }
      .wf-studio-stack span, .wf-studio-stack em {
        display: block;
        color: var(--wf-muted);
        font-style: normal;
        font-size: 12px;
        font-weight: 850;
      }
      .wf-studio-stack strong { display: block; margin: 8px 0; font-size: 22px; }
      .wf-studio-card a { display: inline-flex; margin-top: 8px; color: var(--wf-primary); font-weight: 900; }
      .wf-hero--concierge { border-bottom: 1px solid var(--wf-line); }
      .wf-editorial-grid { grid-template-columns: minmax(0, .86fr) minmax(380px, 1.14fr); }
      .wf-editorial-story { border-block: 1px solid var(--wf-line); padding: 48px 0; }
      .wf-editorial-cover { min-height: 540px; }
      .wf-editorial-index {
        display: grid;
        gap: 10px;
        margin-top: 28px;
      }
      .wf-editorial-index span {
        display: grid;
        grid-template-columns: 40px 1fr;
        gap: 12px;
        align-items: center;
        border-bottom: 1px solid var(--wf-line);
        padding-bottom: 10px;
        color: var(--wf-primary);
        font-family: Georgia, "Times New Roman", "Noto Naskh Arabic", serif;
        font-weight: 900;
      }
      .wf-editorial-index strong { color: var(--wf-text); font-family: inherit; }
      .wf-editorial-index em { grid-column: 2; color: var(--wf-muted); font-style: normal; font-size: 12px; }
      .wf-home-experience {
        position: relative;
        overflow: hidden;
        padding: 88px 0;
      }
      .wf-home-experience h2 {
        margin: 0;
        font-size: 42px;
        line-height: 1.08;
        letter-spacing: 0;
      }
      .wf-home-experience p { color: var(--wf-muted); line-height: 1.7; }
      .wf-atelier-wall { background: #080908; color: #f7f2e8; border-top: 1px solid rgba(255,255,255,.08); }
      .wf-atelier-wall-grid {
        display: grid;
        grid-template-columns: minmax(260px, .62fr) minmax(0, 1.38fr);
        gap: 34px;
        align-items: start;
      }
      .wf-atelier-ledger {
        position: sticky;
        top: 110px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 8px;
        padding: 26px;
        background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
      }
      .wf-atelier-ledger-stats {
        display: grid;
        gap: 10px;
        margin: 24px 0;
      }
      .wf-atelier-ledger-stats span {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid rgba(255,255,255,.1);
        padding-bottom: 10px;
        color: var(--wf-muted);
        font-size: 12px;
        font-weight: 850;
      }
      .wf-atelier-ledger-stats strong { color: var(--wf-primary); }
      .wf-atelier-showroom-track {
        display: grid;
        grid-template-columns: repeat(4, minmax(210px, 1fr));
        gap: 18px;
        align-items: start;
      }
      .wf-atelier-showroom-track .wf-vehicle-card:nth-child(even) { margin-top: 54px; }
      .wf-route-journey { background: #f7f8f5; }
      .wf-route-journey-heading {
        display: flex;
        justify-content: space-between;
        align-items: end;
        gap: 22px;
        margin-bottom: 30px;
      }
      .wf-route-lanes {
        position: relative;
        display: grid;
        gap: 16px;
      }
      .wf-route-lanes::before {
        content: "";
        position: absolute;
        inset-block: 24px;
        inset-inline-start: 30px;
        width: 2px;
        background: repeating-linear-gradient(180deg, var(--wf-primary) 0 10px, transparent 10px 20px);
        opacity: .36;
      }
      .wf-route-stop {
        position: relative;
        display: grid;
        grid-template-columns: 62px minmax(0, 1fr);
        gap: 16px;
        align-items: start;
      }
      .wf-route-stop-index {
        position: sticky;
        top: 104px;
        z-index: 2;
        display: grid;
        place-items: center;
        width: 62px;
        height: 62px;
        border-radius: 8px;
        background: var(--wf-primary);
        color: white;
        font-weight: 950;
      }
      .wf-command-board {
        background:
          linear-gradient(90deg, rgba(37,99,235,.11) 1px, transparent 1px),
          linear-gradient(0deg, rgba(37,99,235,.1) 1px, transparent 1px),
          #09111d;
        background-size: 32px 32px;
        color: white;
      }
      .wf-command-board-grid {
        display: grid;
        grid-template-columns: minmax(260px, .36fr) minmax(0, 1fr);
        gap: 22px;
        align-items: start;
      }
      .wf-command-sidebar {
        position: sticky;
        top: 112px;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 8px;
        background: rgba(11,17,28,.72);
        padding: 22px;
      }
      .wf-command-sidebar h2 { color: white; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
      .wf-command-readouts { display: grid; gap: 10px; margin-top: 22px; }
      .wf-command-readouts .wf-metric { min-height: 92px; background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.12); }
      .wf-command-board-results {
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 8px;
        background: rgba(255,255,255,.04);
        padding: 16px;
      }
      .wf-command-board-bar {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
        color: #9fb2c9;
        font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
        font-size: 12px;
        font-weight: 900;
      }
      .wf-command-board-bar a { color: var(--wf-secondary); }
      .wf-studio-lookbook { background: #fbfcfc; }
      .wf-studio-lookbook-grid {
        display: grid;
        grid-template-columns: minmax(280px, .9fr) minmax(0, 1.1fr);
        gap: 34px;
        align-items: start;
      }
      .wf-studio-lookbook-cover {
        min-height: 620px;
        border-radius: 8px;
        border: 1px solid var(--wf-line);
        background: linear-gradient(180deg, #fff, #eef5f6);
        padding: 28px;
        box-shadow: 0 24px 80px rgba(8,145,178,.1);
      }
      .wf-studio-feature-link {
        position: relative;
        display: block;
        overflow: hidden;
        min-height: 390px;
        margin-top: 26px;
        border-radius: 8px;
        background: var(--wf-panel-strong);
      }
      .wf-studio-feature-link .wf-hero-image,
      .wf-studio-feature-link .wf-image-fallback { position: absolute; inset: 0; }
      .wf-studio-feature-link span {
        position: absolute;
        inset-inline: 18px;
        bottom: 18px;
        border-radius: 8px;
        background: rgba(255,255,255,.86);
        padding: 14px;
        color: var(--wf-text);
        font-weight: 950;
      }
      .wf-studio-lookbook-strip {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }
      .wf-editorial-issue {
        background: #f8f7f3;
        border-top: 1px solid var(--wf-line);
      }
      .wf-editorial-issue-layout {
        display: grid;
        grid-template-columns: minmax(250px, .52fr) minmax(0, 1.48fr);
        gap: 38px;
      }
      .wf-editorial-issue-title {
        border-block: 4px double var(--wf-line);
        padding: 34px 0;
      }
      .wf-editorial-issue-title h2 {
        font-family: Georgia, "Times New Roman", "Noto Naskh Arabic", serif;
      }
      .wf-editorial-issue-list { display: grid; border-top: 1px solid var(--wf-line); }
      .wf-editorial-row {
        display: grid;
        grid-template-columns: 58px minmax(0, 1fr) auto auto;
        gap: 16px;
        align-items: center;
        min-height: 92px;
        border-bottom: 1px solid var(--wf-line);
      }
      .wf-editorial-row span {
        color: var(--wf-primary);
        font-family: Georgia, "Times New Roman", "Noto Naskh Arabic", serif;
        font-size: 30px;
        font-weight: 900;
      }
      .wf-editorial-row strong { font-size: 20px; font-family: Georgia, "Times New Roman", "Noto Naskh Arabic", serif; }
      .wf-editorial-row em { color: var(--wf-primary); font-style: normal; font-weight: 900; }
      .wf-editorial-row i {
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        padding: 7px 10px;
        color: var(--wf-muted);
        font-style: normal;
        font-size: 12px;
        font-weight: 900;
      }
      .wf-section { padding: 84px 0; }
      .wf-section--gallery { background: color-mix(in srgb, var(--wf-bg) 88%, #000); }
      .wf-section--route { background: #f7f8f5; }
      .wf-section--command { background: #eef3f9; }
      .wf-section--studio { background: #fbfcfc; }
      .wf-section--editorial { background: #f8f7f3; }
      .wf-section-heading {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 36px;
      }
      .wf-section-heading h2, .wf-page-heading h1, .wf-contact-page h1, .wf-legal-page h1 {
        margin: 0;
        font-size: 42px;
        line-height: 1.1;
        letter-spacing: 0;
      }
      .wf-section-heading p, .wf-page-heading p { color: var(--wf-muted); margin: 8px 0 0; line-height: 1.7; }
      .wf-inline-link { display: inline-flex; align-items: center; gap: 8px; color: var(--wf-primary); font-weight: 900; white-space: nowrap; }
      .wf-vehicle-grid { display: grid; gap: 18px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .wf-vehicle-grid--route { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
      .wf-vehicle-grid--command { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .wf-vehicle-grid--studio { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 30px; }
      .wf-vehicle-grid--editorial {
        grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr) minmax(0, .85fr);
        align-items: start;
      }
      .wf-vehicle-grid--gallery .wf-vehicle-card--lead,
      .wf-vehicle-grid--editorial .wf-vehicle-card--lead { grid-column: span 2; }
      .wf-vehicle-card {
        position: relative;
        display: block;
        overflow: hidden;
        border-radius: 8px;
        border: 1px solid var(--wf-line);
        background: var(--wf-panel);
        transition: transform .24s ease, box-shadow .24s ease, border-color .24s ease;
      }
      .wf-vehicle-media-link { display: block; min-width: 0; }
      .wf-vehicle-card:hover {
        transform: translateY(-5px);
        border-color: color-mix(in srgb, var(--wf-primary) 45%, var(--wf-line));
        box-shadow: 0 24px 70px rgba(0,0,0,.16);
      }
      .wf-vehicle-media {
        position: relative;
        aspect-ratio: 16 / 10;
        overflow: hidden;
        background: var(--wf-panel-strong);
      }
      .wf-vehicle-card--lead .wf-vehicle-media { aspect-ratio: 21 / 10; }
      .wf-vehicle-media img { transition: transform .55s ease; }
      .wf-vehicle-card:hover .wf-vehicle-media img { transform: scale(1.045); }
      .wf-vehicle-card--gallery:nth-child(3n + 2) { margin-top: 26px; }
      .wf-vehicle-card--route {
        display: grid;
        grid-template-columns: minmax(150px, .78fr) minmax(0, 1fr);
        min-height: 226px;
        background: linear-gradient(90deg, var(--wf-panel), color-mix(in srgb, var(--wf-panel) 82%, var(--wf-primary)));
      }
      .wf-vehicle-card--route .wf-vehicle-media-link { min-height: 100%; }
      .wf-vehicle-card--route .wf-vehicle-media { aspect-ratio: auto; min-height: 100%; }
      .wf-card-route-pin {
        position: absolute;
        z-index: 4;
        inset-inline-start: 14px;
        top: 14px;
        width: 15px;
        height: 15px;
        border: 3px solid white;
        border-radius: 999px;
        background: var(--wf-secondary);
        box-shadow: 0 0 0 5px rgba(255,255,255,.28);
      }
      .wf-vehicle-card--command {
        background: #0b111c;
        color: white;
        font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
      }
      .wf-vehicle-card--command .wf-vehicle-media { aspect-ratio: 1 / 1; }
      .wf-vehicle-card--command .wf-vehicle-body { border-inline-start: 0; }
      .wf-vehicle-card--command .wf-vehicle-eyebrow,
      .wf-vehicle-card--command .wf-card-footer span,
      .wf-vehicle-card--command .wf-specs span { color: #9fb2c9; }
      .wf-card-signal {
        position: absolute;
        z-index: 4;
        inset-inline-end: 12px;
        top: 12px;
        display: inline-flex;
        gap: 4px;
        padding: 6px;
        border-radius: 8px;
        background: rgba(11,17,28,.72);
      }
      .wf-card-signal i {
        width: 6px;
        height: 6px;
        border-radius: 99px;
        background: var(--wf-secondary);
      }
      .wf-vehicle-card--studio {
        border-color: transparent;
        background: rgba(255,255,255,.9);
        box-shadow: 0 24px 80px rgba(8,145,178,.1);
      }
      .wf-vehicle-card--studio:nth-child(even) { margin-top: 46px; }
      .wf-card-number {
        position: absolute;
        z-index: 4;
        inset-inline-end: 18px;
        top: 18px;
        color: rgba(24,32,36,.18);
        font-size: 58px;
        font-weight: 950;
        line-height: 1;
      }
      .wf-vehicle-card--editorial {
        background: #fff;
        box-shadow: none;
      }
      .wf-vehicle-card--editorial .wf-vehicle-media { aspect-ratio: 4 / 5; }
      .wf-vehicle-card--editorial.wf-vehicle-card--lead .wf-vehicle-media { aspect-ratio: 16 / 8; }
      .wf-card-edition {
        position: absolute;
        z-index: 4;
        inset-inline-start: 14px;
        top: 14px;
        border-radius: 8px;
        background: white;
        color: var(--wf-primary);
        padding: 6px 9px;
        font-family: Georgia, "Times New Roman", "Noto Naskh Arabic", serif;
        font-size: 12px;
        font-weight: 900;
      }
      .wf-status {
        position: absolute;
        inset-block-start: 12px;
        inset-inline-start: 12px;
        display: inline-flex;
        align-items: center;
        min-height: 26px;
        border-radius: 8px;
        background: var(--wf-primary);
        color: white;
        padding: 0 10px;
        font-size: 11px;
        font-weight: 900;
      }
      .wf-status--static { position: static; margin-bottom: 18px; }
      .wf-vehicle-body { padding: 18px; min-width: 0; }
      .wf-vehicle-eyebrow { margin: 0 0 8px; color: var(--wf-primary); font-size: 12px; font-weight: 900; }
      .wf-vehicle-body h3 { margin: 0; font-size: 19px; line-height: 1.25; letter-spacing: 0; }
      .wf-specs { display: flex; flex-wrap: wrap; gap: 7px; margin: 14px 0; }
      .wf-specs span {
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        color: var(--wf-muted);
        padding: 4px 8px;
        font-size: 12px;
        font-weight: 750;
      }
      .wf-card-footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
      .wf-card-footer strong { color: var(--wf-primary); font-size: 18px; }
      .wf-card-footer span {
        display: inline-flex;
        align-items: center;
        min-height: 25px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--wf-primary) 25%, var(--wf-line));
        color: var(--wf-muted);
        background: color-mix(in srgb, var(--wf-primary) 7%, transparent);
        padding: 0 8px;
        font-size: 12px;
        font-weight: 850;
        white-space: nowrap;
      }
      .wf-card-actions {
        display: grid;
        grid-template-columns: 1fr auto auto;
        gap: 8px;
        margin-top: 16px;
      }
      .wf-card-action {
        min-height: 38px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        color: var(--wf-text);
        background: color-mix(in srgb, var(--wf-panel) 84%, var(--wf-bg));
        padding: 0 10px;
        font-size: 12px;
        font-weight: 900;
        white-space: nowrap;
        transition: transform .2s ease, border-color .2s ease, background .2s ease;
      }
      .wf-card-action:hover {
        transform: translateY(-1px);
        border-color: color-mix(in srgb, var(--wf-primary) 42%, var(--wf-line));
      }
      .wf-card-action--primary {
        background: var(--wf-primary);
        border-color: var(--wf-primary);
        color: white;
      }
      .wf-page { padding-block: 72px 92px; }
      .wf-page-heading { max-width: 760px; margin-bottom: 34px; }
      .wf-page-heading h1 { margin-bottom: 10px; }
      .wf-inventory-masthead {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 24px;
        align-items: end;
      }
      .wf-inventory-layout {
        display: grid;
        grid-template-columns: minmax(270px, .32fr) minmax(0, 1fr);
        gap: 24px;
        align-items: start;
      }
      .wf-inventory-side {
        position: sticky;
        top: 96px;
        display: grid;
        gap: 14px;
      }
      .wf-inventory-results { min-width: 0; }
      .wf-inventory-persona {
        min-width: 260px;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: var(--wf-panel);
        color: var(--wf-text);
        padding: 16px;
        font-weight: 900;
      }
      .wf-inventory-persona--gallery {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        background: #10120f;
        color: #f7f2e8;
        border-color: rgba(255,255,255,.12);
      }
      .wf-inventory-persona--route {
        display: grid;
        grid-template-columns: max-content 1fr max-content 1fr max-content;
        align-items: center;
        gap: 10px;
        background: #0d2a25;
        color: white;
      }
      .wf-inventory-persona--route i {
        height: 2px;
        border-radius: 99px;
        background: repeating-linear-gradient(90deg, rgba(255,255,255,.9) 0 8px, transparent 8px 16px);
        opacity: .7;
      }
      .wf-inventory-persona--studio {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        background: linear-gradient(135deg, #fff, #eef5f6);
        box-shadow: 0 18px 60px rgba(8,145,178,.08);
      }
      .wf-inventory-persona--command {
        position: relative;
        min-height: 96px;
        overflow: hidden;
        background: #0b111c;
        color: white;
        font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
      }
      .wf-inventory-persona--command .wf-telemetry { inset-inline-end: 12px; top: 12px; transform: scale(.82); transform-origin: top right; }
      .wf-inventory-persona--command > span { position: absolute; inset-inline-start: 16px; bottom: 16px; color: #9fb2c9; }
      .wf-inventory-persona--editorial {
        display: grid;
        grid-template-columns: 54px 1fr;
        gap: 12px;
        align-items: center;
        border-block: 4px double var(--wf-line);
        border-inline: 0;
        background: transparent;
        font-family: Georgia, "Times New Roman", "Noto Naskh Arabic", serif;
      }
      .wf-inventory-persona--editorial span { color: var(--wf-primary); font-size: 32px; }
      .wf-inventory-side .wf-inventory-controls,
      .wf-inventory-side .wf-filter-grid { grid-template-columns: 1fr; }
      .wf-inventory-side .wf-filter-reset { width: 100%; }
      .wf-inventory-page--gallery {
        width: min(1360px, calc(100% - 48px));
        border-inline: 1px solid rgba(255,255,255,.08);
      }
      .wf-inventory-page--gallery .wf-inventory-layout { grid-template-columns: minmax(280px, .28fr) minmax(0, 1fr); }
      .wf-inventory-page--route .wf-inventory-layout { grid-template-columns: 1fr; }
      .wf-inventory-page--route .wf-inventory-side {
        position: relative;
        top: auto;
        grid-template-columns: minmax(260px, .8fr) minmax(0, 1.2fr);
        align-items: stretch;
      }
      .wf-inventory-page--route .wf-inventory-side .wf-inventory-controls,
      .wf-inventory-page--route .wf-inventory-side .wf-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .wf-inventory-page--route .wf-inventory-side .wf-filter-reset { width: auto; grid-column: span 2; }
      .wf-inventory-page--command {
        width: min(1420px, calc(100% - 48px));
      }
      .wf-inventory-page--command .wf-page-heading h1,
      .wf-inventory-page--command .wf-section-kicker { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
      .wf-inventory-page--studio .wf-inventory-layout {
        grid-template-columns: 1fr;
      }
      .wf-inventory-page--studio .wf-inventory-side {
        position: relative;
        top: auto;
        grid-template-columns: 1fr;
      }
      .wf-inventory-page--studio .wf-inventory-side .wf-inventory-controls { grid-template-columns: minmax(260px, 1fr) minmax(0, 1.5fr); }
      .wf-inventory-page--studio .wf-inventory-side .wf-filter-grid { grid-template-columns: repeat(3, minmax(0, 1fr)) auto; }
      .wf-inventory-page--editorial .wf-inventory-layout {
        grid-template-columns: minmax(260px, .42fr) minmax(0, 1fr);
      }
      .wf-inventory-page--editorial .wf-inventory-toolbar,
      .wf-inventory-page--editorial .wf-inventory-controls {
        border-inline: 0;
        border-radius: 0;
        box-shadow: none;
      }
      .wf-inventory-toolbar {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        flex-wrap: wrap;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: var(--wf-panel);
        padding: 14px 16px;
        margin-bottom: 22px;
        color: var(--wf-muted);
        font-weight: 850;
      }
      .wf-inventory-toolbar span { display: inline-flex; align-items: center; gap: 8px; }
      .wf-inventory-controls {
        display: grid;
        grid-template-columns: minmax(260px, 1.1fr) minmax(0, 1.6fr);
        gap: 12px;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--wf-panel) 88%, var(--wf-bg));
        padding: 14px;
        margin-bottom: 28px;
        box-shadow: 0 18px 54px rgba(0,0,0,.05);
      }
      .wf-search-field {
        min-height: 46px;
        display: flex;
        align-items: center;
        gap: 10px;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: var(--wf-panel);
        color: var(--wf-muted);
        padding: 0 13px;
      }
      .wf-search-field input {
        min-width: 0;
        width: 100%;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--wf-text);
      }
      .wf-filter-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
        gap: 10px;
      }
      .wf-filter-grid select,
      .wf-filter-reset {
        min-height: 46px;
        min-width: 0;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: var(--wf-panel);
        color: var(--wf-text);
        padding: 0 12px;
        outline: none;
      }
      .wf-filter-grid select:focus,
      .wf-filter-reset:focus-visible,
      .wf-card-action:focus-visible,
      .wf-detail-action:focus-visible {
        border-color: var(--wf-primary);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--wf-primary) 18%, transparent);
      }
      .wf-filter-reset {
        color: var(--wf-primary);
        font-weight: 900;
        cursor: pointer;
        white-space: nowrap;
      }
      .wf-filter-reset:disabled {
        color: var(--wf-muted);
        opacity: .55;
        cursor: not-allowed;
      }
      .wf-detail-page { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(340px, .92fr); gap: 44px; align-items: start; }
      .wf-detail-media { aspect-ratio: 4 / 3; overflow: hidden; border-radius: 8px; background: var(--wf-panel-strong); border: 1px solid var(--wf-line); position: sticky; top: 96px; }
      .wf-detail-page--gallery {
        width: min(1360px, calc(100% - 48px));
        grid-template-columns: minmax(0, 1.25fr) minmax(360px, .75fr);
      }
      .wf-detail-page--gallery .wf-detail-media { aspect-ratio: 16 / 9; border-color: rgba(255,255,255,.12); box-shadow: 0 30px 110px rgba(0,0,0,.28); }
      .wf-detail-page--route {
        grid-template-columns: minmax(0, .88fr) minmax(360px, 1.12fr);
      }
      .wf-detail-page--route .wf-detail-media {
        border-block-end: 8px solid var(--wf-secondary);
      }
      .wf-detail-page--command {
        width: min(1400px, calc(100% - 48px));
        grid-template-columns: minmax(0, .82fr) minmax(380px, 1.18fr);
      }
      .wf-detail-page--command .wf-detail-info {
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 8px;
        background: #0b111c;
        color: white;
        padding: 24px;
        font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
      }
      .wf-detail-page--command .wf-detail-trim,
      .wf-detail-page--command .wf-detail-specs span,
      .wf-detail-page--command .wf-trust-list li { color: #9fb2c9; }
      .wf-detail-page--command .wf-detail-specs div,
      .wf-detail-page--command .wf-detail-action-panel,
      .wf-detail-page--command .wf-lead-panel { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.14); }
      .wf-detail-page--studio {
        grid-template-columns: minmax(360px, .9fr) minmax(0, 1.1fr);
      }
      .wf-detail-page--studio .wf-detail-media {
        aspect-ratio: 4 / 5;
        box-shadow: 0 28px 90px rgba(8,145,178,.12);
      }
      .wf-detail-page--editorial {
        grid-template-columns: minmax(300px, .68fr) minmax(0, 1.32fr);
        border-block: 1px solid var(--wf-line);
      }
      .wf-detail-page--editorial .wf-detail-media {
        aspect-ratio: 3 / 4;
        border-radius: 0;
      }
      .wf-detail-page--editorial .wf-detail-info h1 {
        font-family: Georgia, "Times New Roman", "Noto Naskh Arabic", serif;
      }
      .wf-detail-info h1 { margin: 0; font-size: 44px; line-height: 1.08; letter-spacing: 0; }
      .wf-detail-trim { color: var(--wf-muted); font-size: 18px; margin: 10px 0 0; }
      .wf-detail-price { display: block; color: var(--wf-primary); font-size: 32px; margin: 22px 0; }
      .wf-detail-specs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 26px; }
      .wf-detail-specs div {
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: var(--wf-panel);
        padding: 12px;
      }
      .wf-detail-specs span { display: block; color: var(--wf-muted); font-size: 12px; margin-bottom: 4px; }
      .wf-detail-specs strong { font-size: 14px; }
      .wf-detail-action-panel {
        position: sticky;
        top: 94px;
        z-index: 8;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--wf-panel) 92%, var(--wf-bg));
        padding: 18px;
        margin-bottom: 24px;
        box-shadow: 0 20px 70px rgba(0,0,0,.09);
      }
      .wf-panel-kicker {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 9px;
        color: var(--wf-primary);
        font-size: 12px;
        font-weight: 900;
      }
      .wf-detail-action-panel h2 {
        margin: 0 0 14px;
        font-size: 21px;
        letter-spacing: 0;
      }
      .wf-detail-action-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 9px;
      }
      .wf-detail-action {
        min-height: 44px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: var(--wf-panel);
        color: var(--wf-text);
        padding: 0 10px;
        font-size: 13px;
        font-weight: 900;
        text-align: center;
        transition: transform .2s ease, border-color .2s ease, background .2s ease;
      }
      .wf-detail-action:hover {
        transform: translateY(-1px);
        border-color: color-mix(in srgb, var(--wf-primary) 42%, var(--wf-line));
      }
      .wf-detail-action--primary {
        background: var(--wf-primary);
        border-color: var(--wf-primary);
        color: white;
      }
      .wf-trust-list {
        display: grid;
        gap: 10px;
        margin: 16px 0 0;
        padding: 0;
        list-style: none;
      }
      .wf-trust-list li {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        color: var(--wf-muted);
        font-size: 12px;
        line-height: 1.55;
      }
      .wf-trust-list svg { color: var(--wf-primary); flex: none; margin-top: 2px; }
      .wf-similar-section {
        border-top: 1px solid var(--wf-line);
        background: color-mix(in srgb, var(--wf-panel) 58%, var(--wf-bg));
      }
      .wf-form-page { max-width: 820px; }
      .wf-contact-page { display: grid; grid-template-columns: minmax(0, .85fr) minmax(360px, 1.15fr); gap: 48px; }
      .wf-contact-actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 24px 0 18px; }
      .wf-contact-list { display: grid; gap: 12px; margin: 24px 0; }
      .wf-contact-list a, .wf-contact-list p {
        margin: 0;
        display: flex;
        align-items: center;
        gap: 12px;
        color: var(--wf-text);
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        padding: 14px;
        background: var(--wf-panel);
      }
      .wf-contact-list svg, .wf-branch-card svg { color: var(--wf-primary); flex: none; }
      .wf-disclaimer { display: flex; align-items: flex-start; gap: 8px; color: var(--wf-muted); line-height: 1.7; }
      .wf-lead-panel, .wf-success {
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: var(--wf-panel);
        padding: 26px;
      }
      .wf-lead-panel h2, .wf-success h2 { margin: 0 0 18px; font-size: 24px; letter-spacing: 0; }
      .wf-fields { display: grid; gap: 12px; }
      .wf-field-row { display: grid; gap: 12px; }
      .wf-field-row--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .wf-field-row--three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .wf-fields input, .wf-fields textarea {
        width: 100%;
        border-radius: 8px;
        border: 1px solid var(--wf-line);
        background: color-mix(in srgb, var(--wf-panel) 90%, var(--wf-bg));
        color: var(--wf-text);
        padding: 12px 13px;
        outline: none;
      }
      .wf-fields input:focus, .wf-fields textarea:focus { border-color: var(--wf-primary); }
      .wf-fields textarea { resize: vertical; min-height: 120px; }
      .wf-form-hint { display: flex; align-items: center; gap: 8px; color: var(--wf-muted); font-size: 12px; margin: 0; }
      .wf-submit { width: 100%; margin-top: 14px; }
      .wf-success { text-align: center; }
      .wf-success svg { color: var(--wf-primary); margin-bottom: 12px; }
      .wf-success p { color: var(--wf-muted); line-height: 1.7; margin-bottom: 24px; }
      .wf-branch-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
      .wf-branch-card {
        border: 1px solid var(--wf-line);
        border-radius: 8px;
        background: var(--wf-panel);
        padding: 22px;
      }
      .wf-branch-card h2 { margin: 14px 0 10px; font-size: 20px; }
      .wf-branch-card p, .wf-branch-card a { color: var(--wf-muted); line-height: 1.7; }
      .wf-legal-page { max-width: 820px; }
      .wf-legal-page p { color: var(--wf-muted); line-height: 1.9; }
      .wf-empty {
        border: 1px dashed var(--wf-line);
        border-radius: 8px;
        color: var(--wf-muted);
        text-align: center;
        padding: 60px 20px;
        background: var(--wf-panel);
      }
      .wf-mobile-sticky-actions {
        display: none;
        position: fixed;
        inset-inline: 12px;
        bottom: 12px;
        z-index: 70;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        border: 1px solid color-mix(in srgb, var(--wf-primary) 24%, var(--wf-line));
        border-radius: 8px;
        background: color-mix(in srgb, var(--wf-panel) 94%, var(--wf-bg));
        padding: 8px;
        box-shadow: 0 24px 80px rgba(0,0,0,.24);
      }
      .wf-mobile-sticky-actions a {
        min-height: 46px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        border-radius: 8px;
        border: 1px solid var(--wf-line);
        background: var(--wf-panel);
        color: var(--wf-text);
        padding: 0 8px;
        font-size: 12px;
        font-weight: 900;
        text-align: center;
      }
      .wf-mobile-sticky-actions .wf-mobile-sticky-primary {
        background: var(--wf-primary);
        border-color: var(--wf-primary);
        color: white;
      }
      .wf-mobile-sticky-actions--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .wf-footer { border-top: 1px solid var(--wf-line); padding: 44px 0; background: color-mix(in srgb, var(--wf-bg) 94%, var(--wf-panel)); }
      .wf-footer-grid { display: grid; grid-template-columns: 1fr 1.4fr 1fr; gap: 24px; align-items: start; }
      .wf-footer-brand { margin: 0 0 8px; font-size: 18px; font-weight: 900; }
      .wf-footer-phone, .wf-footer nav a, .wf-footer-legal a, .wf-footer-legal span { color: var(--wf-muted); font-size: 13px; }
      .wf-footer nav, .wf-footer-legal { display: flex; flex-wrap: wrap; gap: 14px; }
      .wf-footer-legal { justify-content: flex-end; }
      .wf--obsidian .wf-vehicle-card { background: #10120f; }
      .wf--obsidian .wf-nav, .wf--obsidian .wf-footer { background: rgba(8,9,8,.88); }
      .wf--desert .wf-button--primary, .wf--desert .wf-primary-action { color: white; }
      .wf--lucent .wf-vehicle-card, .wf--lucent .wf-lead-panel { box-shadow: 0 18px 60px rgba(8,145,178,.08); }
      .wf--concierge .wf-hero-title { font-family: Georgia, "Times New Roman", "Noto Naskh Arabic", serif; font-weight: 850; }
      .wf--concierge .wf-vehicle-card--editorial .wf-vehicle-body { border-block-start: 4px solid var(--wf-primary); }
      @media (max-width: 1060px) {
        .wf-desktop-nav { display: none; }
        .wf-menu-button { display: inline-flex; }
        .wf-hero-title { font-size: 54px; }
        .wf-desert-grid, .wf-command-grid, .wf-lucent-grid, .wf-editorial-grid,
        .wf-detail-page, .wf-contact-page,
        .wf-atelier-wall-grid, .wf-command-board-grid, .wf-studio-lookbook-grid,
        .wf-editorial-issue-layout, .wf-inventory-layout,
        .wf-inventory-page--gallery .wf-inventory-layout,
        .wf-inventory-page--command .wf-inventory-layout,
        .wf-inventory-page--editorial .wf-inventory-layout { grid-template-columns: 1fr; }
        .wf-desert-stage, .wf-command-visual, .wf-lucent-stage, .wf-editorial-cover { min-height: 390px; }
        .wf-detail-media, .wf-inventory-side, .wf-atelier-ledger, .wf-command-sidebar { position: relative; top: auto; }
        .wf-detail-action-panel { position: relative; top: auto; }
        .wf-inventory-controls { grid-template-columns: 1fr; }
        .wf-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .wf-filter-reset { grid-column: span 2; }
        .wf-atelier-showroom-track, .wf-studio-lookbook-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .wf-route-lanes::before { inset-inline-start: 24px; }
        .wf-inventory-masthead { grid-template-columns: 1fr; }
        .wf-inventory-page--route .wf-inventory-side,
        .wf-inventory-page--studio .wf-inventory-side .wf-inventory-controls,
        .wf-inventory-page--studio .wf-inventory-side .wf-filter-grid { grid-template-columns: 1fr; }
        .wf-inventory-page--route .wf-inventory-side .wf-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .wf-vehicle-grid, .wf-branch-grid, .wf-footer-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 720px) {
        .wf-shell { width: min(100% - 32px, 1280px); }
        .wf-brand-name { max-width: 130px; }
        .wf-language span, .wf-primary-action { display: none; }
        .wf-hero { min-height: auto; }
        .wf-hero-title { font-size: 38px; line-height: 1.05; }
        .wf-hero-copy { font-size: 15px; }
        .wf-hero-content--obsidian { min-height: 620px; }
        .wf-desert-grid, .wf-command-grid, .wf-lucent-grid, .wf-editorial-grid { padding: 44px 0; gap: 28px; }
        .wf-command-metrics, .wf-field-row--two, .wf-field-row--three, .wf-detail-specs,
        .wf-vehicle-grid, .wf-branch-grid, .wf-footer-grid { grid-template-columns: 1fr; }
        .wf-home-experience { padding: 56px 0; }
        .wf-home-experience h2 { font-size: 31px; }
        .wf-atelier-showroom-track,
        .wf-studio-lookbook-strip,
        .wf-inventory-persona--route,
        .wf-editorial-row { grid-template-columns: 1fr; }
        .wf-atelier-showroom-track .wf-vehicle-card:nth-child(even),
        .wf-vehicle-card--studio:nth-child(even) { margin-top: 0; }
        .wf-route-journey-heading { align-items: start; flex-direction: column; }
        .wf-route-stop { grid-template-columns: 44px minmax(0, 1fr); gap: 10px; }
        .wf-route-stop-index { width: 44px; height: 44px; font-size: 12px; }
        .wf-route-lanes::before { inset-inline-start: 21px; }
        .wf-studio-lookbook-cover { min-height: auto; }
        .wf-studio-feature-link { min-height: 280px; }
        .wf-editorial-row {
          align-items: start;
          gap: 7px;
          padding: 16px 0;
        }
        .wf-inventory-page--route .wf-inventory-side .wf-filter-grid,
        .wf-filter-grid { grid-template-columns: 1fr; }
        .wf-vehicle-grid--gallery .wf-vehicle-card--lead,
        .wf-vehicle-grid--editorial .wf-vehicle-card--lead { grid-column: auto; }
        .wf-vehicle-card--gallery:nth-child(3n + 2),
        .wf-vehicle-card--studio:nth-child(even) { margin-top: 0; }
        .wf-vehicle-card--route { grid-template-columns: 1fr; }
        .wf-vehicle-card--lead .wf-vehicle-media { aspect-ratio: 16 / 10; }
        .wf-card-actions { grid-template-columns: 1fr 1fr; }
        .wf-card-action--primary { grid-column: 1 / -1; }
        .wf-filter-grid { grid-template-columns: 1fr; }
        .wf-filter-reset { grid-column: auto; }
        .wf-detail-page { padding-bottom: 98px; }
        .wf-detail-info h1 { font-size: 34px; }
        .wf-detail-action-grid { grid-template-columns: 1fr; }
        .wf-mobile-sticky-actions { display: grid; }
        .wf-mobile-sticky-actions a span { display: inline; }
        .wf-section-heading { align-items: start; flex-direction: column; }
        .wf-section-heading h2, .wf-page-heading h1, .wf-contact-page h1, .wf-legal-page h1 { font-size: 31px; }
        .wf-atelier-panel { position: relative; inset-inline-end: auto; bottom: auto; width: calc(100% - 32px); margin: -110px auto 28px; }
        .wf-route-ticket, .wf-command-strip, .wf-studio-card, .wf-cover-caption { inset-inline: 14px; bottom: 14px; min-width: auto; }
        .wf-footer-legal { justify-content: flex-start; }
      }
    `}</style>
  );
}

export function ObsidianAtelierTheme(props: ThemeProps) {
  return <ShowcaseRoot props={props} design={DESIGNS.obsidian} />;
}

export function DesertGrandTourerTheme(props: ThemeProps) {
  return <ShowcaseRoot props={props} design={DESIGNS.desert} />;
}

export function VelocityCommandTheme(props: ThemeProps) {
  return <ShowcaseRoot props={props} design={DESIGNS.command} />;
}

export function LucentStudioTheme(props: ThemeProps) {
  return <ShowcaseRoot props={props} design={DESIGNS.lucent} />;
}

export function ConciergeEditorialTheme(props: ThemeProps) {
  return <ShowcaseRoot props={props} design={DESIGNS.concierge} />;
}
