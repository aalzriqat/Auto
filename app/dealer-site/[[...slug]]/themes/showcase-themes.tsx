"use client";

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
  Phone,
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
    <header className="wf-nav">
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
      <ShowcaseFeatured props={props} copy={copy} variant="gallery" />
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
      <ShowcaseFeatured props={props} copy={copy} variant="route" />
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
      <ShowcaseFeatured props={props} copy={copy} variant="command" />
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
      <ShowcaseFeatured props={props} copy={copy} variant="studio" />
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
      <ShowcaseFeatured props={props} copy={copy} variant="editorial" />
    </>
  );
}

function ShowcaseFeatured({
  props,
  copy,
  variant,
}: {
  props: ThemeProps;
  copy: ShowcaseCopy;
  variant: "gallery" | "route" | "command" | "studio" | "editorial";
}) {
  const vehicles = props.featuredVehicles.length ? props.featuredVehicles : props.vehicles.slice(0, 6);
  return (
    <section className={`wf-section wf-section--${variant}`}>
      <div className="wf-shell">
        <div className="wf-section-heading">
          <div>
            <p className="wf-section-kicker">{copy.curated}</p>
            <h2>{props.t.featuredVehicles}</h2>
            <p>{props.t.featuredSub}</p>
          </div>
          <a href="/inventory" className="wf-inline-link">
            {props.t.viewAll}
            <ArrowIcon />
          </a>
        </div>
        <VehicleGrid
          vehicles={vehicles}
          props={props}
          copy={copy}
          variant={variant}
        />
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
  const variant = design.id === "obsidian"
    ? "gallery"
    : design.id === "desert"
      ? "route"
      : design.id === "command"
        ? "command"
        : design.id === "lucent"
          ? "studio"
          : "editorial";

  return (
    <section className="wf-page wf-shell">
      <div className="wf-page-heading">
        <p className="wf-section-kicker">{copy.availableNow}</p>
        <h1>{props.t.inventoryTitle}</h1>
        <p>{props.t.inventorySub}</p>
      </div>
      <div className="wf-inventory-toolbar">
        <span><SlidersHorizontal size={15} /> {copy.verifiedInventory}</span>
        <span dir="ltr">{props.vehicles.length} {props.t.inventoryTitle}</span>
      </div>
      <VehicleGrid vehicles={props.vehicles} props={props} copy={copy} variant={variant} />
    </section>
  );
}

function VehicleGrid({
  vehicles,
  props,
  copy,
  variant,
}: {
  vehicles: PublicVehicle[];
  props: ThemeProps;
  copy: ShowcaseCopy;
  variant: "gallery" | "route" | "command" | "studio" | "editorial";
}) {
  if (!vehicles.length) {
    return <div className="wf-empty">{props.t.noVehicles}</div>;
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
  variant: "gallery" | "route" | "command" | "studio" | "editorial";
}) {
  const specs = vehicleSpecs(vehicle, copy).slice(0, 3);
  return (
    <a
      href={`/inventory/${vehicle.slug}`}
      className={`wf-vehicle-card wf-vehicle-card--${variant} ${index === 0 ? "wf-vehicle-card--lead" : ""}`}
      style={{ "--wf-card-index": index } as CSSProperties}
    >
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
      <div className="wf-vehicle-media">
        <VehicleImage vehicle={vehicle} copy={copy} />
        <span className="wf-status">{vehicle.status}</span>
      </div>
      <div className="wf-vehicle-body">
        <p className="wf-vehicle-eyebrow">{variant === "editorial" ? copy.editorsPick : copy.availableNow}</p>
        <h3>{vehicleName(vehicle)}</h3>
        <div className="wf-specs">
          {specs.map((spec) => <span key={spec}>{spec}</span>)}
        </div>
        <div className="wf-card-footer">
          <strong dir="ltr">{props.formatPrice(vehicle.price)}</strong>
          <span>{copy.details}</span>
        </div>
      </div>
    </a>
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
  const specs = [
    [props.t.trim, vehicle.trim],
    [props.t.mileage, vehicle.mileage ? `${vehicle.mileage.toLocaleString()} ${copy.mileageShort}` : null],
    [props.t.transmission, vehicle.transmission],
    [props.t.fuelType, vehicle.fuelType],
    [props.t.color, vehicle.exteriorColor],
  ].filter(([, value]) => Boolean(value));

  return (
    <section className="wf-page wf-shell wf-detail-page">
      <div className="wf-detail-media">
        <VehicleImage vehicle={vehicle} copy={copy} />
      </div>
      <div className="wf-detail-info">
        <p className="wf-section-kicker">{design.title}</p>
        <span className="wf-status wf-status--static">{vehicle.status}</span>
        <h1>{vehicleName(vehicle)}</h1>
        {vehicle.trim && <p className="wf-detail-trim">{vehicle.trim}</p>}
        <strong className="wf-detail-price" dir="ltr">{props.formatPrice(vehicle.price)}</strong>
        <div className="wf-detail-specs">
          {specs.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        {props.formSuccess === "vehicle_inquiry" ? (
          <SuccessPanel t={props.t} onReset={() => props.setFormSuccess(null)} />
        ) : (
          <LeadPanel
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
        )}
      </div>
    </section>
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
        <div className="wf-contact-list">
          {profile.phone && (
            <a href={`tel:${profile.phone}`}>
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
  title,
  submitLabel,
  props,
  copy,
  turnstileTheme,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  props: ThemeProps;
  copy: ShowcaseCopy;
  turnstileTheme: "dark" | "light";
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="wf-lead-panel" onSubmit={onSubmit}>
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
      .wf button, .wf input, .wf textarea { font: inherit; }
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
        .wf-atelier-panel, .wf-route-ticket, .wf-command-strip, .wf-studio-card, .wf-cover-caption {
          animation: wf-rise .72s cubic-bezier(.2, .8, .2, 1) both;
        }
        .wf-motion-two { animation-delay: .08s; }
        .wf-motion-three { animation-delay: .16s; }
        .wf-motion-four { animation-delay: .24s; }
        .wf-motion-five { animation-delay: .32s; }
        .wf-atelier-panel, .wf-route-ticket, .wf-command-strip, .wf-studio-card, .wf-cover-caption { animation-delay: .38s; }
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
      .wf-vehicle-body { padding: 18px; }
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
      .wf-card-footer span { color: var(--wf-muted); font-size: 13px; font-weight: 850; }
      .wf-page { padding-block: 72px 92px; }
      .wf-page-heading { max-width: 760px; margin-bottom: 34px; }
      .wf-page-heading h1 { margin-bottom: 10px; }
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
      .wf-detail-page { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(340px, .92fr); gap: 44px; align-items: start; }
      .wf-detail-media { aspect-ratio: 4 / 3; overflow: hidden; border-radius: 8px; background: var(--wf-panel-strong); border: 1px solid var(--wf-line); position: sticky; top: 96px; }
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
      .wf-form-page { max-width: 820px; }
      .wf-contact-page { display: grid; grid-template-columns: minmax(0, .85fr) minmax(360px, 1.15fr); gap: 48px; }
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
        .wf-detail-page, .wf-contact-page { grid-template-columns: 1fr; }
        .wf-desert-stage, .wf-command-visual, .wf-lucent-stage, .wf-editorial-cover { min-height: 390px; }
        .wf-detail-media { position: relative; top: auto; }
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
        .wf-vehicle-grid--gallery .wf-vehicle-card--lead,
        .wf-vehicle-grid--editorial .wf-vehicle-card--lead { grid-column: auto; }
        .wf-vehicle-card--gallery:nth-child(3n + 2),
        .wf-vehicle-card--studio:nth-child(even) { margin-top: 0; }
        .wf-vehicle-card--route { grid-template-columns: 1fr; }
        .wf-vehicle-card--lead .wf-vehicle-media { aspect-ratio: 16 / 10; }
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
