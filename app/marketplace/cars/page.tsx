"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { Car, Globe2, MapPin, MessageCircle, Phone, Plus, Search, ShieldCheck, Store, User, Wallet, Zap } from "lucide-react";
import { buildWhatsAppDeepLink } from "@/lib/whatsappDeepLink";

type Lang = "en" | "ar";

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    title: "Browse Cars",
    subtitle: "Search real inventory from every dealer on the AutoFlow marketplace.",
    make: "Make",
    city: "City",
    priceMin: "Min price (JOD)",
    priceMax: "Max price (JOD)",
    maxMonthlyPayment: "Max monthly payment (JOD)",
    financeOnly: "Finance available only",
    fromPerMonth: "from",
    month: "mo",
    search: "Search",
    reset: "Reset",
    empty: "No vehicles match your filters yet — try widening your search.",
    loading: "Loading vehicles...",
    loadMore: "Load more",
    viewListing: "View listing",
    tradeIn: "Trade-in offer",
    financeAvailable: "Finance available",
    verifiedPhone: "Verified dealer",
    fastResponse: "Fast responder",
    privateSeller: "Private seller",
    trustSelfReported: "Condition self-reported by dealer",
    trustPartnerVerified: "Condition partner-verified",
    trustNoAccidents: "No accidents disclosed",
    trustAccidentDisclosed: "Accident history disclosed",
    trustOwnerCount: "previous owner(s)",
    trustDealerGuarantee: "Dealer guarantee included",
    sold: "Sold",
    toggleLang: "العربية",
    requestInstead: "Can't find it? Request a car instead",
    listYourCar: "List Your Car",
  },
  ar: {
    title: "تصفّح السيارات",
    subtitle: "ابحث في المخزون الحقيقي لجميع المعارض على منصة أوتوفلو.",
    make: "الماركة",
    city: "المدينة",
    priceMin: "أقل سعر (دينار)",
    priceMax: "أعلى سعر (دينار)",
    maxMonthlyPayment: "أقصى قسط شهري (دينار)",
    financeOnly: "التمويل متاح فقط",
    fromPerMonth: "يبدأ من",
    month: "شهرياً",
    search: "بحث",
    reset: "إعادة تعيين",
    empty: "لا توجد سيارات مطابقة لبحثك — جرّب توسيع البحث.",
    loading: "جاري تحميل السيارات...",
    loadMore: "تحميل المزيد",
    viewListing: "عرض السيارة",
    tradeIn: "عرض استبدال",
    financeAvailable: "التمويل متاح",
    verifiedPhone: "معرض موثّق",
    fastResponse: "رد سريع",
    privateSeller: "بائع فردي",
    trustSelfReported: "الحالة موضحة من قبل المعرض",
    trustPartnerVerified: "الحالة موثّقة من شريك خارجي",
    trustNoAccidents: "لا يوجد حوادث مصرح عنها",
    trustAccidentDisclosed: "تم الإفصاح عن تاريخ حوادث",
    trustOwnerCount: "مالك سابق",
    trustDealerGuarantee: "يشمل ضمان المعرض",
    sold: "تم البيع",
    toggleLang: "English",
    requestInstead: "لم تجد ما تبحث عنه؟ اطلب سيارة بدلاً من ذلك",
    listYourCar: "أضف سيارتك للبيع",
  },
};

// Matches convex/marketplaceBrowse.ts's exported BrowseSortBy union (kept as a
// local literal rather than an import — this file already hand-mirrors the
// backend's BrowseVehicle shape below instead of importing convex/*.ts types).
type SortBy = "price_asc" | "price_desc" | "year_desc" | "mileage_asc" | "newest";

const SORT_BY_LABEL: Record<Lang, string> = { en: "Sort by", ar: "الترتيب حسب" };
const SORT_STRINGS: Record<Lang, Record<SortBy, string>> = {
  en: {
    price_asc: "Price: Low to High",
    price_desc: "Price: High to Low",
    year_desc: "Year: Newest First",
    mileage_asc: "Mileage: Lowest First",
    // Honesty check: this sorts by when the inventory row was created
    // (createdAt / _creationTime), not a real publish/relist timestamp — see
    // convex/marketplaceBrowse.ts's `listedAt`. "Recently Added" describes
    // that accurately; "Newest Listings" would overclaim it reflects when a
    // car became visible on the marketplace.
    newest: "Recently Added",
  },
  ar: {
    price_asc: "السعر: من الأقل للأعلى",
    price_desc: "السعر: من الأعلى للأقل",
    year_desc: "سنة الصنع: الأحدث أولاً",
    mileage_asc: "الممشى: الأقل أولاً",
    newest: "الأحدث إضافةً",
  },
};

const CONTACT_STRINGS: Record<Lang, { call: string; whatsapp: string; whatsappGreeting: string }> = {
  en: { call: "Call", whatsapp: "WhatsApp", whatsappGreeting: "Hi, I'm interested in this car:" },
  ar: { call: "اتصال", whatsapp: "واتساب", whatsappGreeting: "مرحباً، أنا مهتم بهذه السيارة:" },
};

type SearchFilters = {
  make?: string;
  city?: string;
  priceMin?: number;
  priceMax?: number;
  maxMonthlyPayment?: number;
  paymentType?: "FINANCE";
  sortBy?: SortBy;
};

type BrowseVehicle = {
  // "DIRECT" rows come from an individual or unaffiliated seller and carry no
  // organization, so org-scoped actions (trade-in) are hidden for them.
  sellerType: "DEALER" | "DIRECT";
  orgId: string | null;
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
  price: number | null;
  financePrice: number | null;
  currency: string;
  status: "AVAILABLE" | "SOLD";
  imageUrls: string[];
  financeAvailable: boolean;
  estimatedMonthlyPayment: number | null;
  inspectionStatus: "NONE" | "SELF_REPORTED" | "PARTNER_VERIFIED";
  accidentDisclosed: boolean | null;
  ownerCount: number | null;
  dealerGuarantee: boolean | null;
};

/** `tel:` link preserving a leading + so the dialer keeps the country code — mirrors apps/mobile/src/features/marketplace/marketplaceUtils.ts's buildTelUrl. Null when the dealer exposed no phone. */
function buildTelUrl(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/gu, "");
  if (!digits) return null;
  return phone.trim().startsWith("+") ? `tel:+${digits}` : `tel:${digits}`;
}

/** Direct-contact CTA (Call + WhatsApp) — the #1 marketplace conversion lever, same rationale as mobile's ContactBar. Renders nothing when the dealer exposed no reachable number, or when the vehicle is already SOLD (nothing to buy, so no reason to invite contact), so no dead/misleading button ever shows. */
function ContactBar({ vehicle, lang }: { readonly vehicle: BrowseVehicle; readonly lang: Lang }) {
  if (vehicle.status === "SOLD") return null;
  const c = CONTACT_STRINGS[lang];
  const telUrl = buildTelUrl(vehicle.dealerPhone);
  const message = [c.whatsappGreeting, `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const whatsappUrl = vehicle.dealerWhatsapp ? buildWhatsAppDeepLink(vehicle.dealerWhatsapp, message) : null;

  if (!telUrl && !whatsappUrl) return null;

  return (
    <div className="flex gap-2">
      {telUrl && (
        <a
          href={telUrl}
          aria-label={c.call}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-slate-100 text-slate-800 text-sm font-medium py-2 hover:bg-slate-200"
        >
          <Phone className="h-3.5 w-3.5" />
          {c.call}
        </a>
      )}
      {whatsappUrl && (
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={c.whatsapp}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium py-2 hover:bg-emerald-700"
        >
          <MessageCircle className="h-3.5 w-3.5" />
          {c.whatsapp}
        </a>
      )}
    </div>
  );
}

/** Phase 61 trust passport — only renders facts the dealer actually reported; every field is optional and falls back to nothing rather than a misleading default (core dev rule: `?.`/`||` fallbacks, no crash on missing data). */
function TrustInfoPanel({ vehicle, t }: { readonly vehicle: BrowseVehicle; readonly t: Record<string, string> }) {
  const facts: string[] = [];
  if (vehicle.inspectionStatus === "SELF_REPORTED") facts.push(t.trustSelfReported);
  if (vehicle.inspectionStatus === "PARTNER_VERIFIED") facts.push(t.trustPartnerVerified);
  if (vehicle.accidentDisclosed === false) facts.push(t.trustNoAccidents);
  if (vehicle.accidentDisclosed === true) facts.push(t.trustAccidentDisclosed);
  if (vehicle.ownerCount != null) facts.push(`${vehicle.ownerCount} ${t.trustOwnerCount}`);
  if (vehicle.dealerGuarantee) facts.push(t.trustDealerGuarantee);

  if (facts.length === 0) return null;

  return (
    <ul className="text-xs text-slate-500 flex flex-col gap-0.5">
      {facts.map((fact) => (
        <li key={fact} className="flex items-center gap-1">
          <ShieldCheck className="h-3 w-3 shrink-0 text-slate-400" />
          {fact}
        </li>
      ))}
    </ul>
  );
}

function VehicleCard({
  vehicle,
  t,
  lang,
}: {
  readonly vehicle: BrowseVehicle;
  readonly t: Record<string, string>;
  readonly lang: Lang;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden flex flex-col shadow-sm">
      <div className="relative aspect-video bg-slate-100 flex items-center justify-center">
        {vehicle.imageUrls[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={vehicle.imageUrls[0]} alt={`${vehicle.make} ${vehicle.model}`} className="h-full w-full object-cover" />
        ) : (
          <Car className="h-10 w-10 text-slate-300" />
        )}
        {vehicle.status === "SOLD" && (
          <span className="absolute top-2 start-2 rounded-full bg-slate-950/90 text-white text-[11px] font-semibold px-2.5 py-1">
            {t.sold}
          </span>
        )}
      </div>
      <div className="p-4 flex flex-col gap-2 flex-1">
        <p className="font-semibold">
          {vehicle.year} {vehicle.make} {vehicle.model}
          {vehicle.trim ? ` ${vehicle.trim}` : ""}
        </p>
        <p className="text-sm text-slate-500 flex items-center gap-1 truncate">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          {vehicle.dealershipName}
          {vehicle.dealerBadges.includes("VERIFIED_PHONE") && (
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label={t.verifiedPhone} />
          )}
        </p>
        {vehicle.price != null && (
          <p className="text-lg font-bold text-slate-950">{vehicle.price.toLocaleString()} {vehicle.currency}</p>
        )}
        {vehicle.estimatedMonthlyPayment != null && (
          <p className="text-xs text-slate-500">
            {t.fromPerMonth} {vehicle.estimatedMonthlyPayment.toLocaleString()} {vehicle.currency}/{t.month}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {/* Buyers treat dealer and private listings very differently (recourse,
              paperwork, negotiation), so the distinction has to be visible on the
              card itself, not just on the detail page. */}
          {vehicle.sellerType === "DIRECT" && (
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-sky-50 text-sky-700 text-[11px] font-medium px-2 py-0.5">
              <User className="h-3 w-3" />
              {t.privateSeller}
            </span>
          )}
          {vehicle.financeAvailable && (
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-medium px-2 py-0.5">
              <Wallet className="h-3 w-3" />
              {t.financeAvailable}
            </span>
          )}
          {vehicle.dealerBadges.includes("FAST_RESPONSE") && (
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-amber-50 text-amber-700 text-[11px] font-medium px-2 py-0.5">
              <Zap className="h-3 w-3" />
              {t.fastResponse}
            </span>
          )}
        </div>
        <TrustInfoPanel vehicle={vehicle} t={t} />
        {/* Sticky bottom action group: direct-contact CTA (the #1 conversion lever,
            same rationale as mobile's ContactBar) pinned above the secondary
            view-listing/trade-in row via mt-auto/sticky, so it stays reachable
            without scrolling the card out of view. */}
        <div className="mt-auto sticky bottom-0 flex flex-col gap-2 bg-white pt-2">
          <ContactBar vehicle={vehicle} lang={lang} />
          {/* A private seller has neither a dealer site to link to nor an org to
              route a trade-in request to, so this whole row drops out rather
              than rendering an empty gap under the contact buttons. */}
          {(vehicle.siteUrl || vehicle.orgId) && (
            <div className="flex gap-2">
              {vehicle.siteUrl && (
                <a
                  href={`${vehicle.siteUrl}/inventory/${vehicle.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-center text-sm font-medium rounded-lg bg-slate-950 text-white py-2 hover:bg-slate-800"
                >
                  {t.viewListing}
                </a>
              )}
              {vehicle.orgId && (
                <Link
                  href={`/marketplace/tradein?orgId=${vehicle.orgId}&dealerName=${encodeURIComponent(vehicle.dealershipName)}`}
                  className="flex-1 text-center text-sm font-medium rounded-lg border border-slate-300 py-2 text-slate-700 hover:bg-slate-50"
                >
                  {t.tradeIn}
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders one page of results for its own fixed cursor via its own live
 * `useQuery` — each page stays independently reactive to dealer inventory
 * changes. Mounting one of these per accumulated cursor (keyed, so React
 * never remounts earlier pages) avoids the anti-pattern of copying query
 * results into parent state inside a useEffect.
 */
function CarsResultsPage({
  filters,
  cursor,
  isFirst,
  isLast,
  t,
  lang,
  onLoadMore,
}: {
  readonly filters: SearchFilters;
  readonly cursor: string | undefined;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly t: Record<string, string>;
  readonly lang: Lang;
  readonly onLoadMore: (nextCursor: string) => void;
}) {
  const result = useQuery(api.marketplaceBrowse.search, { ...filters, cursor });

  if (result === undefined) {
    return isFirst ? <p className="mt-8 text-slate-500">{t.loading}</p> : null;
  }
  if (isFirst && result.vehicles.length === 0) {
    return <p className="mt-8 text-slate-500">{t.empty}</p>;
  }

  return (
    <>
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {result.vehicles.map((vehicle) => (
          <VehicleCard key={`${vehicle.orgId}-${vehicle.id}`} vehicle={vehicle} t={t} lang={lang} />
        ))}
      </div>
      {isLast && !result.isDone && result.continueCursor && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => onLoadMore(result.continueCursor!)}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            {t.loadMore}
          </button>
        </div>
      )}
    </>
  );
}

export default function MarketplaceCarsPage() {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    const browserLang = typeof navigator !== "undefined" ? navigator.language : "en";
    if (browserLang.toLowerCase().startsWith("ar")) setLang("ar");
  }, []);
  const t = STRINGS[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

  const [make, setMake] = useState("");
  const [city, setCity] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [maxMonthlyPayment, setMaxMonthlyPayment] = useState("");
  const [financeOnly, setFinanceOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>("price_asc");
  const [searchKey, setSearchKey] = useState(0);
  const [appliedFilters, setAppliedFilters] = useState<SearchFilters>({});
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);

  function handleSearch() {
    setSearchKey((key) => key + 1);
    setCursors([undefined]);
    setAppliedFilters({
      make: make.trim() || undefined,
      city: city.trim() || undefined,
      priceMin: priceMin ? Number(priceMin) : undefined,
      priceMax: priceMax ? Number(priceMax) : undefined,
      maxMonthlyPayment: maxMonthlyPayment ? Number(maxMonthlyPayment) : undefined,
      paymentType: financeOnly ? "FINANCE" : undefined,
      sortBy: sortBy !== "price_asc" ? sortBy : undefined,
    });
  }

  function handleReset() {
    setMake("");
    setCity("");
    setPriceMin("");
    setPriceMax("");
    setMaxMonthlyPayment("");
    setFinanceOnly(false);
    setSortBy("price_asc");
    setSearchKey((key) => key + 1);
    setCursors([undefined]);
    setAppliedFilters({});
  }

  // Sort applies immediately (no Search click needed), matching the
  // conventional "sort changes re-order right away" UX for a dropdown.
  function handleSortChange(nextSortBy: SortBy) {
    setSortBy(nextSortBy);
    setSearchKey((key) => key + 1);
    setCursors([undefined]);
    setAppliedFilters((prev) => ({ ...prev, sortBy: nextSortBy !== "price_asc" ? nextSortBy : undefined }));
  }

  return (
    <main dir={dir} className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <Link href="/marketplace/dealers" className="flex items-center gap-2 font-semibold">
            <Store className="h-5 w-5" />
            AutoFlow
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/marketplace/sell"
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 text-white text-sm font-medium px-3 py-1.5 hover:bg-slate-800"
            >
              <Plus className="h-3.5 w-3.5" />
              {t.listYourCar}
            </Link>
            <button
              type="button"
              onClick={() => setLang(lang === "en" ? "ar" : "en")}
              className="text-sm text-slate-600 hover:text-slate-950"
            >
              <Globe2 className="h-4 w-4 inline me-1" />
              {t.toggleLang}
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="text-2xl sm:text-3xl font-bold">{t.title}</h1>
        <p className="mt-2 text-slate-600">{t.subtitle}</p>

        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 items-end">
          <div className="col-span-1">
            <label htmlFor="cars-make" className="block text-xs font-medium text-slate-600 mb-1">{t.make}</label>
            <input
              id="cars-make"
              value={make}
              onChange={(e) => setMake(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="col-span-1">
            <label htmlFor="cars-city" className="block text-xs font-medium text-slate-600 mb-1">{t.city}</label>
            <input
              id="cars-city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="col-span-1">
            <label htmlFor="cars-price-min" className="block text-xs font-medium text-slate-600 mb-1">{t.priceMin}</label>
            <input
              id="cars-price-min"
              type="number"
              min={0}
              value={priceMin}
              onChange={(e) => setPriceMin(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="col-span-1">
            <label htmlFor="cars-price-max" className="block text-xs font-medium text-slate-600 mb-1">{t.priceMax}</label>
            <input
              id="cars-price-max"
              type="number"
              min={0}
              value={priceMax}
              onChange={(e) => setPriceMax(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="col-span-1">
            <label htmlFor="cars-max-monthly" className="block text-xs font-medium text-slate-600 mb-1">{t.maxMonthlyPayment}</label>
            <input
              id="cars-max-monthly"
              type="number"
              min={0}
              value={maxMonthlyPayment}
              onChange={(e) => setMaxMonthlyPayment(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <label className="col-span-1 flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={financeOnly} onChange={(e) => setFinanceOnly(e.target.checked)} />
            {t.financeOnly}
          </label>
          <div className="col-span-1">
            <label htmlFor="cars-sort" className="block text-xs font-medium text-slate-600 mb-1">
              {SORT_BY_LABEL[lang]}
            </label>
            <select
              id="cars-sort"
              value={sortBy}
              onChange={(e) => handleSortChange(e.target.value as SortBy)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              {(Object.keys(SORT_STRINGS[lang]) as SortBy[]).map((option) => (
                <option key={option} value={option}>
                  {SORT_STRINGS[lang][option]}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2 sm:col-span-1 flex gap-2">
            <button
              type="button"
              onClick={handleSearch}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-slate-950 text-white text-sm font-medium py-2 hover:bg-slate-800"
            >
              <Search className="h-4 w-4" />
              {t.search}
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              {t.reset}
            </button>
          </div>
        </div>

        {cursors.map((cursor, index) => (
          <CarsResultsPage
            key={`${searchKey}-${index}`}
            filters={appliedFilters}
            cursor={cursor}
            isFirst={index === 0}
            isLast={index === cursors.length - 1}
            t={t}
            lang={lang}
            onLoadMore={(nextCursor) => setCursors((prev) => [...prev, nextCursor])}
          />
        ))}

        <div className="mt-10 text-center">
          <Link href="/marketplace/request" className="text-sm text-slate-600 hover:text-slate-950 underline">
            {t.requestInstead}
          </Link>
        </div>
      </section>
    </main>
  );
}
