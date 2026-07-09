"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import {
  ArrowRight, Car, CheckCircle2, Globe2, Mail, MapPin, Menu, Phone, Send, ShieldCheck, X,
} from "lucide-react";
import Link from "next/link";
import Script from "next/script";
import { useParams, useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { Id } from "@/convex/_generated/dataModel";
import { PrestigeTheme } from "./themes/prestige-theme";
import { VelocityTheme } from "./themes/velocity-theme";
import { AvantTheme } from "./themes/avant-theme";
import {
  AtlasRallyTheme,
  CarbonTrackTheme,
  CinemaNoirTheme,
  ConciergeEditorialTheme,
  DesertGrandTourerTheme,
  GlassHorizonTheme,
  LucentStudioTheme,
  NeonGridTheme,
  ObsidianAtelierTheme,
  PearlMajlisTheme,
  PixelShowroomTheme,
  PrismMotionTheme,
  SolarisBayTheme,
  TorqueLabTheme,
  VelocityCommandTheme,
} from "./themes/showcase-themes";
import { KineticLuxuryTheme, KineticModernEvTheme, KineticSalesTheme } from "./themes/kinetic-themes";
import { TurnstileWidget } from "./turnstile-widget";
import { DEFAULT_WEBSITE_TEMPLATE_ID } from "@/lib/website/websiteTemplates";
import type { PublicVehicle } from "./themes/theme-props";
import { useSiteVisitorTracking } from "@/hooks/useSiteVisitorTracking";

type PublicBranch = {
  id: Id<"branches">;
  name: string;
  address: string | null;
  phone: string | null;
};

const STRINGS = {
  en: {
    brand: "AutoFlow dealer website",
    browseInventory: "Browse inventory",
    contactSales: "Contact sales",
    featuredVehicles: "Featured vehicles",
    featuredSub: "Public inventory from AutoFlow.",
    viewAll: "View all",
    nav: { home: "Home", inventory: "Inventory", finance: "Finance", branches: "Branches", contact: "Contact" },
    inventoryTitle: "Inventory",
    inventorySub: "Browse available vehicles.",
    trim: "Trim",
    mileage: "Mileage",
    transmission: "Transmission",
    fuelType: "Fuel type",
    color: "Color",
    askAbout: "Ask about this vehicle",
    sendInquiry: "Send inquiry",
    financeTitle: "Finance",
    requestFinancing: "Request financing",
    branchesTitle: "Branches",
    viewOnMap: "View on map",
    contactTitle: "Contact",
    contactDisclaimer: "Your submitted contact details are used by this dealership to respond to your request.",
    sendMessage: "Send message",
    privacyTitle: "Privacy Policy",
    termsTitle: "Terms",
    dataDeletionTitle: "Data Deletion",
    footerPrivacy: "Privacy",
    footerTerms: "Terms",
    footerDataDeletion: "Data deletion",
    notFound: "Website not found",
    notFoundSub: "This dealership website is not active or the domain is not configured.",
    noVehicles: "No public vehicles are available right now.",
    contactForPrice: "Contact for price",
    placeholderFirstName: "First name",
    placeholderLastName: "Last name",
    placeholderEmail: "Email",
    placeholderPhone: "Phone",
    placeholderWhatsApp: "WhatsApp",
    placeholderMessage: "Message",
    contactMethodHint: "Provide at least one contact method.",
    previewBanner: "Preview mode. This draft is visible only inside AutoFlow and lead forms are disabled.",
    requestSent: "Your request was sent.",
    previewNoSubmit: "Preview mode does not submit leads.",
    thankYou: "Thank you!",
    messageReceived: "We've received your message. Our team will be in touch with you shortly.",
    sendAnother: "Send another message",
  },
  ar: {
    brand: "موقع معرض AutoFlow",
    browseInventory: "تصفح المخزون",
    contactSales: "تواصل مع المبيعات",
    featuredVehicles: "المركبات المميزة",
    featuredSub: "المخزون العام من AutoFlow.",
    viewAll: "عرض الكل",
    nav: { home: "الرئيسية", inventory: "المخزون", finance: "التمويل", branches: "الفروع", contact: "تواصل" },
    inventoryTitle: "المخزون",
    inventorySub: "تصفح المركبات المتاحة.",
    trim: "الفئة",
    mileage: "الممشى",
    transmission: "ناقل الحركة",
    fuelType: "نوع الوقود",
    color: "اللون",
    askAbout: "استفسر عن هذه المركبة",
    sendInquiry: "إرسال الاستفسار",
    financeTitle: "التمويل",
    requestFinancing: "طلب تمويل",
    branchesTitle: "الفروع",
    viewOnMap: "عرض على الخريطة",
    contactTitle: "تواصل معنا",
    contactDisclaimer: "يتم استخدام بيانات الاتصال التي تقدمها من قبل هذا المعرض للرد على طلبك.",
    sendMessage: "إرسال الرسالة",
    privacyTitle: "سياسة الخصوصية",
    termsTitle: "الشروط والأحكام",
    dataDeletionTitle: "حذف البيانات",
    footerPrivacy: "الخصوصية",
    footerTerms: "الشروط",
    footerDataDeletion: "حذف البيانات",
    notFound: "الموقع غير موجود",
    notFoundSub: "هذا الموقع الإلكتروني للمعرض غير نشط أو أن النطاق غير مهيأ.",
    noVehicles: "لا توجد مركبات متاحة للعرض حالياً.",
    contactForPrice: "تواصل لمعرفة السعر",
    placeholderFirstName: "الاسم الأول",
    placeholderLastName: "اسم العائلة",
    placeholderEmail: "البريد الإلكتروني",
    placeholderPhone: "الهاتف",
    placeholderWhatsApp: "واتساب",
    placeholderMessage: "الرسالة",
    contactMethodHint: "أدخل طريقة تواصل واحدة على الأقل.",
    previewBanner: "وضع المعاينة. هذه المسودة مرئية فقط داخل AutoFlow ونماذج العملاء معطّلة.",
    requestSent: "تم إرسال طلبك.",
    previewNoSubmit: "وضع المعاينة لا يرسل بيانات العملاء.",
    thankYou: "شكراً لك!",
    messageReceived: "لقد استلمنا رسالتك. سيتواصل معك فريقنا قريباً.",
    sendAnother: "إرسال رسالة أخرى",
  },
} as const;

type Lang = "en" | "ar";
type TurnstileWindow = Window & {
  turnstile?: { reset: (container?: HTMLElement | string) => void };
};

type StoredHeadLink = {
  rel: string;
  href: string | null;
  existed: boolean;
};

const PUBLIC_LEAD_FINGERPRINT_KEY = "autoflow_public_lead_fingerprint";
const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const PREMIUM_THEME_COMPONENTS = {
  prestige: PrestigeTheme,
  velocity: VelocityTheme,
  avant: AvantTheme,
  "obsidian-atelier": ObsidianAtelierTheme,
  "desert-grand-tourer": DesertGrandTourerTheme,
  "velocity-command": VelocityCommandTheme,
  "lucent-studio": LucentStudioTheme,
  "concierge-editorial": ConciergeEditorialTheme,
  "neon-grid": NeonGridTheme,
  "cinema-noir": CinemaNoirTheme,
  "atlas-rally": AtlasRallyTheme,
  "glass-horizon": GlassHorizonTheme,
  "torque-lab": TorqueLabTheme,
  "pearl-majlis": PearlMajlisTheme,
  "prism-motion": PrismMotionTheme,
  "carbon-track": CarbonTrackTheme,
  "solaris-bay": SolarisBayTheme,
  "pixel-showroom": PixelShowroomTheme,
  "kinetic-luxury": KineticLuxuryTheme,
  "kinetic-ev": KineticModernEvTheme,
  "kinetic-sales": KineticSalesTheme,
};

// crypto.randomUUID() only exists in secure contexts (HTTPS/localhost). A
// dealer's custom domain can be reached over plain HTTP before its
// certificate is provisioned, so fall back to crypto.getRandomValues (which
// remains available) instead of letting lead capture throw.
function randomId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function publicLeadFingerprint() {
  let visitorId = window.localStorage.getItem(PUBLIC_LEAD_FINGERPRINT_KEY);
  if (!visitorId) {
    visitorId = randomId();
    window.localStorage.setItem(PUBLIC_LEAD_FINGERPRINT_KEY, visitorId);
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown";
  return [
    visitorId,
    navigator.language,
    timezone,
    `${window.screen.width}x${window.screen.height}`,
  ].join(":");
}

function resetTurnstile(formElement: HTMLFormElement) {
  const turnstile = (window as TurnstileWindow).turnstile;
  const widget = formElement.querySelector<HTMLElement>(".cf-turnstile");
  if (turnstile && widget) turnstile.reset(widget);
}

function publicSiteOrigin(host: string) {
  const trimmedHost = host.trim();
  if (!trimmedHost) return "";
  if (typeof window !== "undefined" && window.location.hostname === trimmedHost) {
    return window.location.origin;
  }
  const protocolOrigin = trimmedHost.match(/^(https?:\/\/[^/]+)/i)?.[1];
  if (protocolOrigin) {
    return protocolOrigin;
  }
  return `https://${trimmedHost}`;
}

function setHeadIcon(rel: string, href: string): StoredHeadLink {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  const previousLink = {
    rel,
    href: link?.getAttribute("href") ?? null,
    existed: Boolean(link),
  };
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.href = href;
  return previousLink;
}

function restoreHeadIcon(previousLink: StoredHeadLink) {
  const link = document.head.querySelector<HTMLLinkElement>(`link[rel="${previousLink.rel}"]`);
  if (!link) return;
  if (!previousLink.existed) {
    link.remove();
    return;
  }
  if (previousLink.href) {
    link.href = previousLink.href;
  } else {
    link.removeAttribute("href");
  }
}

function DealerBrowserChrome({
  dealershipName,
  logoUrl,
}: {
  dealershipName: string;
  logoUrl?: string | null;
}) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = dealershipName;
    const previousIcons = logoUrl
      ? ["icon", "shortcut icon", "apple-touch-icon"].map((rel) => setHeadIcon(rel, logoUrl))
      : [];

    return () => {
      document.title = previousTitle;
      previousIcons.forEach(restoreHeadIcon);
    };
  }, [dealershipName, logoUrl]);

  return null;
}

export default function DealerSitePage() {
  const params = useParams<{ slug?: string[] }>();
  const searchParams = useSearchParams();
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", phone: "", whatsapp: "", message: "" });
  const [selectedVehicleId, setSelectedVehicleId] = useState<Id<"vehicles"> | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const submitLead = useAction(api.websites.submitPublicLead);

  // Host detection
  const hostParam = searchParams.get("host");
  const [browserHost, setBrowserHost] = useState("");
  useEffect(() => {
    if (!hostParam) {
      const h = window.location.hostname;
      if (h && !h.includes("localhost") && !h.includes("vercel.app") && h !== "autoflowdealer.com" && !h.startsWith("www.")) {
        setBrowserHost(h);
      }
    }
  }, [hostParam]);
  const liveHost = hostParam ?? browserHost;
  const previewOrgId = searchParams.get("previewOrgId") as Id<"organizations"> | null;
  const liveSite = useQuery(api.websites.resolveDomain, !previewOrgId && liveHost ? { host: liveHost } : "skip");
  const previewSite = useQuery(api.websites.preview, previewOrgId ? { orgId: previewOrgId } : "skip");
  const site = previewOrgId ? previewSite : liveSite;
  const host = liveHost || site?.settings.domain || "";
  const isPreviewMode = Boolean(previewOrgId);
  const slug = params?.slug ?? [];
  const page = slug[0] ?? "home";
  const detailSlug = page === "inventory" && slug[1] ? slug[1] : null;
  const trackedPath = page === "home" ? "/" : `/${page}${detailSlug ? `/${detailSlug}` : ""}`;
  useSiteVisitorTracking({ host, path: trackedPath, enabled: Boolean(site) && !isPreviewMode });

  const vehicles: PublicVehicle[] = useMemo(() => site?.vehicles ?? [], [site?.vehicles]);
  const featuredVehicles = vehicles.slice(0, 6);
  const detailVehicle = useMemo(
    () => vehicles.find((v) => v.slug === detailSlug || v.id === detailSlug) ?? null,
    [detailSlug, vehicles]
  );

  // Language: derive from site's defaultLanguage, allow user toggle
  const supportedLangs = (site?.settings.supportedLanguages ?? ["en"]) as Lang[];
  const siteLang = (site?.settings.defaultLanguage ?? "en") as Lang;
  const [userSelectedLang, setUserSelectedLang] = useState<Lang | null>(null);
  const lang: Lang = userSelectedLang ?? siteLang;

  const t = STRINGS[lang];
  const isArabic = lang === "ar";
  const dir: "ltr" | "rtl" = isArabic ? "rtl" : "ltr";
  const showLangToggle = supportedLangs.includes("en") && supportedLangs.includes("ar");

  const primary = site?.settings.primaryColor ?? "#0f172a";
  const secondary = site?.settings.secondaryColor ?? "#f97316";

  function formatPrice(price: number | null) {
    return price == null ? t.contactForPrice : `${price.toLocaleString()} JOD`;
  }

  const siteOrigin = publicSiteOrigin(host);
  const templateId = site?.settings?.templateId ?? DEFAULT_WEBSITE_TEMPLATE_ID;

  async function handleSubmit(event: FormEvent<HTMLFormElement>, formType: string) {
    event.preventDefault();
    if (isPreviewMode) { toast.error(t.previewNoSubmit); return; }
    if (!host) return;
    const formElement = event.currentTarget;
    const token = new FormData(formElement).get("cf-turnstile-response");
    const turnstileToken = typeof token === "string" ? token : "";
    if (!turnstileToken) {
      toast.error("Please complete the verification challenge.");
      return;
    }
    setIsSubmitting(true);
    try {
      await submitLead({
        host, formType,
        vehicleId: selectedVehicleId,
        firstName: form.firstName,
        lastName: form.lastName || undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
        whatsapp: form.whatsapp || undefined,
        message: form.message || undefined,
        turnstileToken,
        clientFingerprint: publicLeadFingerprint(),
      });
      toast.success(t.requestSent);
      setForm({ firstName: "", lastName: "", email: "", phone: "", whatsapp: "", message: "" });
      setSelectedVehicleId(undefined);
      setFormSuccess(formType);
    } catch (error) {
      console.error("Website lead submission failed", error);
      toast.error("An unexpected error occurred. Please try again later.");
    } finally {
      resetTurnstile(formElement);
      setIsSubmitting(false);
    }
  }

  if (site === undefined) {
    return (
      <main className="min-h-screen bg-white text-slate-950 grid place-items-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-slate-950" />
      </main>
    );
  }

  if (!site) {
    return (
      <main className="min-h-screen bg-white text-slate-950 grid place-items-center p-6">
        <div className="max-w-md text-center">
          <Globe2 className="mx-auto mb-4 h-10 w-10 text-slate-400" />
          <h1 className="text-2xl font-bold">{STRINGS.en.notFound}</h1>
          <p className="mt-2 text-sm text-slate-600">{STRINGS.en.notFoundSub}</p>
        </div>
      </main>
    );
  }

  // Premium theme dispatch
  const premiumThemeProps = {
    site,
    page,
    detailVehicle,
    siteOrigin,
    lang,
    isArabic,
    dir,
    showLangToggle,
    isPreviewMode,
    form,
    setForm,
    setSelectedVehicleId,
    isSubmitting,
    formSuccess,
    setFormSuccess,
    onSubmit: handleSubmit,
    turnstileSiteKey,
    onToggleLang: () => setUserSelectedLang(lang === "en" ? "ar" : "en"),
    mobileNavOpen,
    setMobileNavOpen,
    t,
    primary,
    secondary,
    formatPrice,
    vehicles,
    featuredVehicles,
  };

  const turnstileScript = turnstileSiteKey ? (
    <Script
      src="https://challenges.cloudflare.com/turnstile/v0/api.js"
      async
      defer
      strategy="afterInteractive"
    />
  ) : null;

  const PremiumTheme = templateId in PREMIUM_THEME_COMPONENTS
    ? PREMIUM_THEME_COMPONENTS[templateId as keyof typeof PREMIUM_THEME_COMPONENTS]
    : null;
  if (PremiumTheme) {
    return (
      <>
        {turnstileScript}
        <DealerBrowserChrome dealershipName={site.profile.dealershipName} logoUrl={site.profile.logoUrl} />
        <PremiumTheme {...premiumThemeProps} />
      </>
    );
  }

  const profile = site.profile;
  const nav = [
    [t.nav.home, "/"],
    [t.nav.inventory, "/inventory"],
    [t.nav.finance, "/finance"],
    [t.nav.branches, "/branches"],
    [t.nav.contact, "/contact"],
  ];

  return (
    <>
    {turnstileScript}
    <DealerBrowserChrome dealershipName={profile.dealershipName} logoUrl={profile.logoUrl} />
    <main dir={dir} className="min-h-screen bg-white text-slate-950">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
        {isPreviewMode && (
          <div className="border-b bg-amber-50 px-4 py-2 text-center text-sm font-medium text-amber-900">
            {t.previewBanner}
          </div>
        )}
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3 shrink-0">
            {profile.logoUrl ? (
              <img
                src={profile.logoUrl}
                alt={profile.dealershipName}
                className="h-12 w-auto max-w-[160px] object-contain md:h-14 md:max-w-[200px]"
              />
            ) : (
              <div className="grid h-12 w-12 place-items-center rounded-md text-white" style={{ backgroundColor: primary }}>
                <Car className="h-6 w-6" />
              </div>
            )}
            <span className="hidden font-bold sm:inline-block">{profile.dealershipName}</span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden gap-5 text-sm font-medium lg:flex">
            {nav.map(([label, href]) => (
              <a key={label} href={href} className="text-slate-600 hover:text-slate-950 transition-colors">{label}</a>
            ))}
          </nav>

          {/* Right side controls */}
          <div className="flex items-center gap-2">
            {showLangToggle && (
              <button
                onClick={() => setUserSelectedLang(lang === "en" ? "ar" : "en")}
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <Globe2 className="h-4 w-4" />
                <span className="hidden sm:inline">{lang === "en" ? "العربية" : "English"}</span>
              </button>
            )}
            <a
              href="/contact"
              className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold text-white"
              style={{ backgroundColor: secondary }}
            >
              {t.nav.contact}
            </a>
            {/* Mobile hamburger */}
            <button
              className="lg:hidden rounded-md p-2 text-slate-700 hover:bg-slate-100 transition-colors"
              onClick={() => setMobileNavOpen((prev) => !prev)}
              aria-label="Toggle navigation"
            >
              {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile nav drawer */}
        {mobileNavOpen && (
          <div className="border-t bg-white lg:hidden">
            <nav className="mx-auto flex max-w-7xl flex-col px-4 py-2">
              {nav.map(([label, href]) => (
                <a
                  key={label}
                  href={href}
                  className="border-b py-3 text-sm font-medium text-slate-700 last:border-b-0 hover:text-slate-950"
                  onClick={() => setMobileNavOpen(false)}
                >
                  {label}
                </a>
              ))}
            </nav>
          </div>
        )}
      </header>

      {/* Home page */}
      {(page === "home" || page === "") && (
        <>
          <section className="border-b">
            <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 md:py-16 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:min-h-[500px]">
              <div>
                <p className="mb-3 text-sm font-semibold uppercase tracking-wide" style={{ color: secondary }}>{t.brand}</p>
                <h1 className="text-3xl font-black tracking-tight sm:text-4xl md:text-5xl lg:text-6xl">{profile.heroTitle}</h1>
                <p className="mt-4 text-base text-slate-600 sm:text-lg">{profile.heroSubtitle}</p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <a
                    href="/inventory"
                    className="inline-flex items-center gap-2 rounded-md px-5 py-3 text-sm font-semibold text-white sm:text-base"
                    style={{ backgroundColor: primary }}
                  >
                    {t.browseInventory} <ArrowRight className={`h-4 w-4 ${isArabic ? "rotate-180" : ""}`} />
                  </a>
                  <a href="/contact" className="inline-flex items-center gap-2 rounded-md border px-5 py-3 text-sm font-semibold sm:text-base">
                    {t.contactSales}
                  </a>
                </div>
              </div>
              <div className="order-first overflow-hidden rounded-md border bg-slate-100 lg:order-last">
                {featuredVehicles[0]?.imageUrls[0] ? (
                  <img src={featuredVehicles[0].imageUrls[0]} alt="" className="aspect-[4/3] h-full w-full object-cover" />
                ) : (
                  <div className="grid aspect-[4/3] place-items-center text-slate-400">
                    <Car className="h-16 w-16" />
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="mx-auto max-w-7xl px-4 py-10 md:py-14">
            <div className="mb-6 flex items-end justify-between">
              <div>
                <h2 className="text-xl font-bold sm:text-2xl">{t.featuredVehicles}</h2>
                <p className="text-sm text-slate-600">{t.featuredSub}</p>
              </div>
              <a href="/inventory" className="text-sm font-semibold" style={{ color: primary }}>{t.viewAll}</a>
            </div>
            <VehicleGrid vehicles={featuredVehicles} primary={primary} formatPrice={formatPrice} noVehiclesLabel={t.noVehicles} />
          </section>
        </>
      )}

      {/* Inventory list */}
      {page === "inventory" && !detailVehicle && (
        <section className="mx-auto max-w-7xl px-4 py-8 md:py-10">
          <h1 className="text-2xl font-bold sm:text-3xl">{t.inventoryTitle}</h1>
          <p className="mt-2 text-sm text-slate-600">{t.inventorySub}</p>
          <div className="mt-6">
            <VehicleGrid vehicles={vehicles} primary={primary} formatPrice={formatPrice} noVehiclesLabel={t.noVehicles} />
          </div>
        </section>
      )}

      {/* Vehicle detail */}
      {page === "inventory" && detailVehicle && (
        <section className="mx-auto max-w-7xl px-4 py-8 md:py-10">
          <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="overflow-hidden rounded-md border bg-slate-100">
              {detailVehicle.imageUrls[0] ? (
                <img
                  src={detailVehicle.imageUrls[0]}
                  alt={`${detailVehicle.year} ${detailVehicle.make} ${detailVehicle.model}`}
                  className="aspect-[4/3] w-full object-cover"
                />
              ) : (
                <div className="grid aspect-[4/3] place-items-center text-slate-400"><Car className="h-16 w-16" /></div>
              )}
            </div>
            <div>
              <p className="text-sm font-semibold uppercase" style={{ color: secondary }}>{detailVehicle.status}</p>
              <h1 className="mt-2 text-3xl font-black sm:text-4xl">{detailVehicle.year} {detailVehicle.make} {detailVehicle.model}</h1>
              <p className="mt-4 text-xl font-bold sm:text-2xl">{formatPrice(detailVehicle.price)}</p>
              <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
                {[
                  [t.trim, detailVehicle.trim],
                  [t.mileage, detailVehicle.mileage ? `${detailVehicle.mileage.toLocaleString()} km` : null],
                  [t.transmission, detailVehicle.transmission],
                  [t.fuelType, detailVehicle.fuelType],
                  [t.color, detailVehicle.exteriorColor],
                ].map(([label, value]) => value && (
                  <div key={label} className="rounded-md border p-3">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>

              {formSuccess === "vehicle_inquiry" ? (
                <SuccessCard t={t} secondary={secondary} onReset={() => setFormSuccess(null)} />
              ) : (
                <form
                  className="mt-8 space-y-3 rounded-md border p-4"
                  onSubmit={(event) => {
                    setSelectedVehicleId(detailVehicle.id);
                    void handleSubmit(event, "vehicle_inquiry");
                  }}
                >
                  <h2 className="font-bold">{t.askAbout}</h2>
                  <LeadFields form={form} setForm={setForm} t={t} />
                  <TurnstileWidget siteKey={turnstileSiteKey} />
                  <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto" style={{ backgroundColor: primary }}>
                    <Send className="h-4 w-4" />
                    {t.sendInquiry}
                  </Button>
                </form>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Finance */}
      {page === "finance" && (
        <section className="mx-auto max-w-4xl px-4 py-8 md:py-10">
          <h1 className="text-2xl font-bold sm:text-3xl">{t.financeTitle}</h1>
          <p className="mt-2 text-slate-600">{site.legal.financingDisclaimer}</p>
          {formSuccess === "financing" ? (
            <div className="mt-8">
              <SuccessCard t={t} secondary={secondary} onReset={() => setFormSuccess(null)} />
            </div>
          ) : (
            <form
              className="mt-8 space-y-3 rounded-md border p-4"
              onSubmit={(event) => void handleSubmit(event, "financing")}
            >
              <LeadFields form={form} setForm={setForm} t={t} />
              <TurnstileWidget siteKey={turnstileSiteKey} />
              <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto" style={{ backgroundColor: primary }}>
                {t.requestFinancing}
              </Button>
            </form>
          )}
        </section>
      )}

      {/* Branches */}
      {page === "branches" && (
        <section className="mx-auto max-w-5xl px-4 py-8 md:py-10">
          <h1 className="text-2xl font-bold sm:text-3xl">{t.branchesTitle}</h1>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {(profile.branches as PublicBranch[]).map((branch) => (
              <div key={branch.id} className="rounded-md border p-4">
                <h2 className="font-bold text-base">{branch.name}</h2>
                {branch.address && (
                  <p className="mt-2 flex items-start gap-2 text-sm text-slate-600">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                    {branch.address.startsWith("http") ? (
                      <a
                        href={branch.address}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium hover:underline"
                        style={{ color: primary }}
                      >
                        {t.viewOnMap}
                      </a>
                    ) : (
                      <span>{branch.address}</span>
                    )}
                  </p>
                )}
                {branch.phone && (
                  <p className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                    <Phone className="h-4 w-4 shrink-0" />
                    <a href={`tel:${branch.phone}`} className="hover:underline">{branch.phone}</a>
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Contact */}
      {page === "contact" && (
        <section className="mx-auto max-w-6xl px-4 py-8 md:py-10">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <h1 className="text-2xl font-bold sm:text-3xl">{t.contactTitle}</h1>
              {profile.phone && (
                <p className="mt-4 flex items-center gap-2 text-slate-700">
                  <Phone className="h-4 w-4 shrink-0" />
                  <a href={`tel:${profile.phone}`} className="hover:underline">{profile.phone}</a>
                </p>
              )}
              {profile.address && (
                <p className="mt-3 flex items-start gap-2 text-slate-700">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{profile.address}</span>
                </p>
              )}
              <p className="mt-6 flex items-start gap-2 text-sm text-slate-500">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                {t.contactDisclaimer}
              </p>
            </div>
            {formSuccess === "contact" ? (
              <SuccessCard t={t} secondary={secondary} onReset={() => setFormSuccess(null)} />
            ) : (
              <form
                className="space-y-3 rounded-md border p-4"
                onSubmit={(event) => void handleSubmit(event, "contact")}
              >
                <LeadFields form={form} setForm={setForm} t={t} />
                <TurnstileWidget siteKey={turnstileSiteKey} />
                <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto" style={{ backgroundColor: primary }}>
                  {t.sendMessage}
                </Button>
              </form>
            )}
          </div>
        </section>
      )}

      {/* Legal pages */}
      {(page === "privacy" || page === "terms" || page === "data-deletion") && (
        <section className="mx-auto max-w-3xl px-4 py-8 md:py-10">
          <h1 className="text-2xl font-bold sm:text-3xl">
            {page === "privacy" ? t.privacyTitle : page === "terms" ? t.termsTitle : t.dataDeletionTitle}
          </h1>
          <p className="mt-4 text-slate-700 leading-relaxed">
            {page === "privacy" ? site.legal.privacyPolicy : page === "terms" ? site.legal.terms : site.legal.dataDeletion}
          </p>
        </section>
      )}

      {/* Footer */}
      <footer className="mt-12 border-t px-4 py-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>{profile.dealershipName}</p>
          <div className="flex gap-4">
            <a href="/privacy" className="hover:text-slate-700">{t.footerPrivacy}</a>
            <a href="/terms" className="hover:text-slate-700">{t.footerTerms}</a>
            <a href="/data-deletion" className="hover:text-slate-700">{t.footerDataDeletion}</a>
          </div>
        </div>
      </footer>
    </main>
    </>
  );
}

function SuccessCard({
  t,
  secondary,
  onReset,
}: {
  t: (typeof STRINGS)[Lang];
  secondary: string;
  onReset: () => void;
}) {
  return (
    <div className="rounded-md border border-green-200 bg-green-50 p-6 text-center">
      <CheckCircle2 className="mx-auto h-10 w-10 text-green-600" />
      <h3 className="mt-3 text-lg font-bold text-green-900">{t.thankYou}</h3>
      <p className="mt-2 text-sm text-green-800">{t.messageReceived}</p>
      <button
        type="button"
        onClick={onReset}
        className="mt-4 inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        style={{ backgroundColor: secondary }}
      >
        {t.sendAnother}
      </button>
    </div>
  );
}

function VehicleGrid({
  vehicles,
  primary,
  formatPrice,
  noVehiclesLabel,
}: {
  vehicles: PublicVehicle[];
  primary: string;
  formatPrice: (price: number | null) => string;
  noVehiclesLabel: string;
}) {
  if (vehicles.length === 0) {
    return <div className="rounded-md border border-dashed p-10 text-center text-slate-500">{noVehiclesLabel}</div>;
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {vehicles.map((vehicle) => (
        <a
          key={vehicle.id}
          href={`/inventory/${vehicle.slug}`}
          className="overflow-hidden rounded-md border bg-white transition hover:shadow-md"
        >
          <div className="bg-slate-100">
            {vehicle.imageUrls[0] ? (
              <img
                src={vehicle.imageUrls[0]}
                alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
                className="aspect-[4/3] w-full object-cover"
              />
            ) : (
              <div className="grid aspect-[4/3] place-items-center text-slate-400"><Car className="h-12 w-12" /></div>
            )}
          </div>
          <div className="p-3 sm:p-4">
            <p className="text-xs font-semibold uppercase" style={{ color: primary }}>{vehicle.status}</p>
            <h3 className="mt-1 font-bold text-sm sm:text-base">{vehicle.year} {vehicle.make} {vehicle.model}</h3>
            <p className="mt-1 text-xs text-slate-600 sm:mt-2 sm:text-sm">
              {[vehicle.trim, vehicle.mileage ? `${vehicle.mileage.toLocaleString()} km` : null].filter(Boolean).join(" · ")}
            </p>
            <p className="mt-2 font-bold sm:mt-3">{formatPrice(vehicle.price)}</p>
          </div>
        </a>
      ))}
    </div>
  );
}

function LeadFields({
  form,
  setForm,
  t,
}: {
  form: { firstName: string; lastName: string; email: string; phone: string; whatsapp: string; message: string };
  setForm: (value: { firstName: string; lastName: string; email: string; phone: string; whatsapp: string; message: string }) => void;
  t: (typeof STRINGS)[Lang];
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} placeholder={t.placeholderFirstName} />
        <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} placeholder={t.placeholderLastName} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t.placeholderEmail} />
        <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t.placeholderPhone} />
        <Input value={form.whatsapp} onChange={(e) => setForm({ ...form, whatsapp: e.target.value })} placeholder={t.placeholderWhatsApp} />
      </div>
      <Textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder={t.placeholderMessage} rows={4} />
      <p className="flex items-center gap-2 text-xs text-slate-500"><Mail className="h-3 w-3 shrink-0" /> {t.contactMethodHint}</p>
    </>
  );
}
