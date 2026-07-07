"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { PublicVehicle, ThemeProps } from "./theme-props";
import { KineticVehicleImage, telLink, vehicleTitle, waLink } from "./kinetic-shared";

function KineticTopNav({ props, activeInventory, activeFinance }: { props: ThemeProps; activeInventory?: boolean; activeFinance?: boolean }) {
  const { site, lang, showLangToggle, onToggleLang, t } = props;
  const profile = site.profile;
  const linkClass = (active?: boolean) =>
    active
      ? "text-secondary border-b-2 border-secondary font-bold pb-1 font-label-caps text-label-caps"
      : "text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps";
  return (
    <header className="bg-surface/90 backdrop-blur-xl docked full-width top-0 sticky z-50 shadow-sm">
      <nav className="flex justify-between items-center px-gutter py-4 w-full max-w-screen-2xl mx-auto">
        <div className="flex items-center gap-8">
          <Link className="font-display-luxury text-display-luxury text-luxury-gold" href="/">{profile.dealershipName}</Link>
          <div className="hidden md:flex items-center gap-6">
            <Link className={linkClass(activeInventory)} href="/inventory">{t.nav.inventory}</Link>
            <Link className={linkClass(activeFinance)} href="/finance">{t.nav.finance}</Link>
            <Link className={linkClass(false)} href="/contact">{t.nav.contact}</Link>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {profile.phone && (
            <a className="hidden lg:flex items-center gap-2 bg-whatsapp-green text-white px-4 py-2 rounded-lg font-bold hover:opacity-90 transition-opacity"
              href={waLink(profile.phone, `Hi ${profile.dealershipName}, I have a question.`)} target="_blank" rel="noopener noreferrer">
              <span className="material-symbols-outlined">whatshot</span>
              <span>WhatsApp Support</span>
            </a>
          )}
          {showLangToggle && (
            <button onClick={onToggleLang} className="flex items-center gap-2 text-on-surface-variant">
              <span className="material-symbols-outlined cursor-pointer hover:bg-surface-container-highest/50 p-2 rounded-full transition-colors">language</span>
              <span className="font-arabic-ui text-arabic-ui text-primary cursor-pointer">{lang === "en" ? "العربية" : "English"}</span>
            </button>
          )}
        </div>
      </nav>
    </header>
  );
}

function KineticFooter({ props }: { props: ThemeProps }) {
  const { site, t } = props;
  const profile = site.profile;
  return (
    <footer className="bg-primary py-section-gap w-full px-margin-desktop text-on-primary">
      <div className="max-w-screen-2xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-gutter">
        <div className="flex flex-col gap-4">
          <h2 className="font-display-luxury text-[32px] text-luxury-gold">{profile.dealershipName}</h2>
          <p className="text-on-primary-container text-sm leading-relaxed">{profile.slogan ?? "Providing unparalleled vehicle sourcing and financing solutions."}</p>
        </div>
        <div>
          <h4 className="font-bold text-white mb-6 uppercase tracking-widest text-xs">Quick Links</h4>
          <ul className="flex flex-col gap-4 text-sm text-on-primary-container">
            <li><Link className="hover:text-white transition-colors" href="/inventory">{t.nav.inventory}</Link></li>
            <li><Link className="hover:text-white transition-colors" href="/finance">{t.nav.finance}</Link></li>
            <li><Link className="hover:text-white transition-colors" href="/contact">{t.nav.contact}</Link></li>
          </ul>
        </div>
        <div>
          <h4 className="font-bold text-white mb-6 uppercase tracking-widest text-xs">Policies</h4>
          <ul className="flex flex-col gap-4 text-sm text-on-primary-container">
            <li><Link className="hover:text-white transition-colors" href="/privacy">{t.footerPrivacy}</Link></li>
            <li><Link className="hover:text-white transition-colors" href="/terms">{t.footerTerms}</Link></li>
          </ul>
        </div>
        <div>
          <h4 className="font-bold text-white mb-6 uppercase tracking-widest text-xs">Our Showroom</h4>
          {profile.address && <p className="text-sm text-on-primary-container mb-2">{profile.address}</p>}
          {profile.phone && <p className="text-sm text-on-primary-container">{profile.phone}</p>}
        </div>
      </div>
      <div className="max-w-screen-2xl mx-auto border-t border-on-primary-fixed-variant mt-16 pt-8 text-center text-[10px] text-on-primary-container tracking-widest uppercase">
        © {new Date().getFullYear()} {profile.dealershipName}. All Rights Reserved.
      </div>
    </footer>
  );
}

export function KineticInventoryList(props: ThemeProps) {
  const { site, t, formatPrice, vehicles, isPreviewMode, dir } = props;

  const [search, setSearch] = useState("");
  const [make, setMake] = useState("all");
  const [maxPriceOverride, setMaxPriceOverride] = useState<number | null>(null);
  const prices = vehicles.map((v) => v.price).filter((p): p is number => p != null);
  const priceCeiling = prices.length ? Math.max(...prices) : 100000;
  const maxPrice = maxPriceOverride ?? priceCeiling;
  const makes = useMemo(() => Array.from(new Set(vehicles.map((v) => v.make))).sort(), [vehicles]);

  const filtered = vehicles.filter((v) => {
    if (make !== "all" && v.make !== make) return false;
    if (maxPriceOverride != null && v.price != null && v.price > maxPriceOverride) return false;
    if (search.trim()) {
      const haystack = `${v.make} ${v.model} ${v.trim ?? ""}`.toLowerCase();
      if (!haystack.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="theme-kinetic bg-background text-on-background font-body-md text-body-md overflow-x-hidden" dir={dir}>
      {isPreviewMode && (
        <div className="bg-secondary px-4 py-2 text-center text-sm font-bold text-white">{t.previewBanner}</div>
      )}
      <KineticTopNav props={props} activeInventory />
      <main className="max-w-screen-2xl mx-auto flex min-h-screen">
        <aside className="hidden lg:flex flex-col h-[calc(100vh-80px)] sticky top-20 w-80 bg-surface-container-lowest border-r border-outline-variant overflow-y-auto px-6 py-8 hide-scrollbar">
          <div className="flex flex-col gap-8">
            <div className="relative">
              <input
                className="w-full pl-10 pr-4 py-3 bg-surface-container rounded-xl border-none focus:ring-2 focus:ring-luxury-gold transition-all"
                placeholder="Search vehicle..."
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span>
            </div>
            <div className="flex flex-col gap-6">
              <h3 className="font-headline-lg text-lg flex items-center gap-2">
                <span className="material-symbols-outlined text-luxury-gold">filter_list</span>
                Filter Inventory
              </h3>
              <div className="mb-4">
                <span className="font-label-caps text-label-caps uppercase text-outline block mb-2">Price Range</span>
                <input
                  className="w-full accent-luxury-gold"
                  max={priceCeiling}
                  min={0}
                  type="range"
                  value={maxPrice}
                  onChange={(e) => setMaxPriceOverride(Number(e.target.value))}
                />
                <div className="flex justify-between mt-1 text-xs font-semibold text-primary">
                  <span>0</span>
                  <span>{maxPrice.toLocaleString()}+</span>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="font-label-caps text-label-caps text-outline">Make</label>
                <select
                  className="bg-surface-container border-none rounded-lg focus:ring-luxury-gold p-3"
                  value={make}
                  onChange={(e) => setMake(e.target.value)}
                >
                  <option value="all">All Makes</option>
                  {makes.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </aside>
        <section className="flex-1 px-margin-mobile md:px-gutter py-8 bg-surface-container-low">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
            <div>
              <h2 className="font-headline-lg text-headline-lg text-primary">{t.inventoryTitle}</h2>
              <p className="text-on-surface-variant font-body-md">{t.inventorySub}</p>
            </div>
          </div>
          {filtered.length ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
              {filtered.map((v) => (
                <KineticInventoryCard key={v.id} vehicle={v} formatPrice={formatPrice} profile={site.profile} t={t} />
              ))}
            </div>
          ) : (
            <div className="border-2 border-dashed border-outline-variant rounded-xl p-16 text-center text-on-surface-variant">{t.noVehicles}</div>
          )}
        </section>
      </main>
      <KineticFooter props={props} />
    </div>
  );
}

function KineticInventoryCard({
  vehicle: v,
  formatPrice,
  profile,
  t,
}: {
  vehicle: PublicVehicle;
  formatPrice: (p: number | null) => string;
  profile: ThemeProps["site"]["profile"];
  t: ThemeProps["t"];
}) {
  return (
    <div className="group bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 transform hover:-translate-y-1 border border-outline-variant/30 flex flex-col">
      <Link href={`/inventory/${v.slug}`} className="relative aspect-[16/9] overflow-hidden block">
        <KineticVehicleImage vehicle={v} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
        <div className="absolute top-4 left-4 flex gap-2">
          <span className="bg-secondary text-white px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider">{v.status}</span>
        </div>
      </Link>
      <div className="p-6 flex flex-col flex-1">
        <Link href={`/inventory/${v.slug}`}>
          <h3 className="font-headline-lg text-xl text-primary mb-2 hover:text-secondary transition-colors">{vehicleTitle(v)}</h3>
        </Link>
        <div className="grid grid-cols-3 gap-2 mb-6">
          <div className="flex flex-col items-center p-2 bg-surface-container-low rounded-lg">
            <span className="material-symbols-outlined text-luxury-gold text-lg">speed</span>
            <span className="text-[10px] font-bold text-outline">{v.mileage != null ? `${v.mileage.toLocaleString()} KM` : t.mileage}</span>
          </div>
          <div className="flex flex-col items-center p-2 bg-surface-container-low rounded-lg">
            <span className="material-symbols-outlined text-luxury-gold text-lg">local_gas_station</span>
            <span className="text-[10px] font-bold text-outline">{v.fuelType ?? t.fuelType}</span>
          </div>
          <div className="flex flex-col items-center p-2 bg-surface-container-low rounded-lg">
            <span className="material-symbols-outlined text-luxury-gold text-lg">settings_input_component</span>
            <span className="text-[10px] font-bold text-outline">{v.transmission ?? t.transmission}</span>
          </div>
        </div>
        <div className="mt-auto">
          <p className="text-2xl font-extrabold text-primary mb-4">{formatPrice(v.price)}</p>
          <div className="grid grid-cols-2 gap-3">
            <Link href={`/inventory/${v.slug}`} className="py-3 px-4 bg-primary text-white rounded-lg font-bold text-sm hover:bg-primary/90 transition-colors text-center">View Details</Link>
            {profile.phone && (
              <a
                href={waLink(profile.phone, `Hi, I'm interested in the ${vehicleTitle(v)}.`)}
                target="_blank" rel="noopener noreferrer"
                className="py-3 px-4 bg-whatsapp-green text-white rounded-lg font-bold text-sm flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
              >
                <span className="material-symbols-outlined text-sm">whatshot</span>
                Chat
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function KineticVehicleDetail(props: ThemeProps) {
  const { site, detailVehicle, t, formatPrice, vehicles, isPreviewMode, dir } = props;
  const [activeImage, setActiveImage] = useState(0);

  if (!detailVehicle) return null;
  const v = detailVehicle;
  const profile = site.profile;
  const images = v.imageUrls.length ? v.imageUrls : [];
  const similar = vehicles.filter((other) => other.id !== v.id).slice(0, 4);

  const specs: Array<[string, string, string]> = [
    ["calendar_month", "Year", String(v.year)],
    ...(v.mileage != null ? [["speed", t.mileage, `${v.mileage.toLocaleString()} KM`] as [string, string, string]] : []),
    ...(v.fuelType ? [["gas_meter", t.fuelType, v.fuelType] as [string, string, string]] : []),
    ...(v.transmission ? [["settings_input_component", t.transmission, v.transmission] as [string, string, string]] : []),
    ...(v.exteriorColor ? [["palette", t.color, v.exteriorColor] as [string, string, string]] : []),
    ...(v.trim ? [["style", t.trim, v.trim] as [string, string, string]] : []),
  ];

  return (
    <div className="theme-kinetic bg-background text-on-background font-body-md antialiased" dir={dir}>
      {isPreviewMode && (
        <div className="bg-secondary px-4 py-2 text-center text-sm font-bold text-white">{t.previewBanner}</div>
      )}
      <KineticTopNav props={props} activeInventory />
      <main className="max-w-screen-2xl mx-auto px-4 lg:px-gutter py-8">
        <nav className="mb-6 flex items-center gap-2 text-on-surface-variant font-label-caps text-label-caps">
          <Link className="hover:text-primary" href="/">Home</Link>
          <span className="material-symbols-outlined text-sm">chevron_right</span>
          <Link className="hover:text-primary" href="/inventory">{t.nav.inventory}</Link>
          <span className="material-symbols-outlined text-sm">chevron_right</span>
          <span className="text-primary font-bold">{vehicleTitle(v)}</span>
        </nav>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
          <div className="lg:col-span-8 space-y-8">
            <section className="space-y-4">
              <div className="relative aspect-[16/9] overflow-hidden rounded-xl bg-surface-container shadow-lg">
                {images[activeImage] ? (
                  <img className="w-full h-full object-cover" src={images[activeImage]} alt={vehicleTitle(v)} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-outline-variant">
                    <span className="material-symbols-outlined text-6xl">directions_car</span>
                  </div>
                )}
              </div>
              {images.length > 1 && (
                <div className="flex gap-4 overflow-x-auto no-scrollbar pb-2">
                  {images.map((url, i) => (
                    <button
                      key={url}
                      onClick={() => setActiveImage(i)}
                      className={`min-w-[140px] aspect-video rounded-lg overflow-hidden border-2 transition-colors ${
                        i === activeImage ? "border-secondary" : "border-outline-variant hover:border-secondary"
                      }`}
                    >
                      <img className="w-full h-full object-cover" src={url} alt="" />
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-outline-variant pb-8">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="bg-secondary-fixed text-on-secondary-fixed font-label-caps text-label-caps px-3 py-1 rounded-full">{v.status}</span>
                </div>
                <h1 className="font-headline-lg text-headline-lg text-primary mb-1">{vehicleTitle(v)}</h1>
                {profile.address && (
                  <p className="text-on-surface-variant flex items-center gap-2">
                    <span className="material-symbols-outlined text-base">location_on</span>
                    {profile.address}
                  </p>
                )}
              </div>
              <div className="text-left md:text-right">
                <p className="font-display-luxury text-3xl text-primary">{formatPrice(v.price)}</p>
              </div>
            </section>
            {specs.length > 0 && (
              <section>
                <h2 className="font-headline-lg text-xl mb-6">Key Specifications</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {specs.map(([icon, label, value]) => (
                    <div className="bg-surface-container-low p-4 rounded-xl flex items-center gap-4" key={label}>
                      <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-primary shadow-sm">
                        <span className="material-symbols-outlined">{icon}</span>
                      </div>
                      <div>
                        <p className="text-on-surface-variant text-xs uppercase tracking-wider font-semibold">{label}</p>
                        <p className="font-bold text-sm">{value}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <section className="space-y-6">
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-outline-variant">
                <h2 className="font-headline-lg text-xl mb-4">Vehicle Description</h2>
                <p className="text-on-surface-variant leading-relaxed">
                  This {vehicleTitle(v)} is available now
                  {v.mileage != null ? ` with ${v.mileage.toLocaleString()} km on the odometer` : ""}
                  {v.transmission ? `, ${v.transmission.toLowerCase()} transmission` : ""}
                  {v.fuelType ? `, running on ${v.fuelType.toLowerCase()}` : ""}. Contact us for a full inspection report and viewing appointment.
                </p>
              </div>
            </section>
          </div>
          <aside className="lg:col-span-4">
            <div className="sticky top-24 space-y-6">
              <div className="bg-white p-6 rounded-2xl shadow-xl border border-outline-variant space-y-4">
                <h3 className="font-bold text-xl">Interested in this car?</h3>
                <p className="text-on-surface-variant text-sm">Speak with our sales team for personalized assistance.</p>
                {profile.phone && (
                  <a
                    className="w-full bg-whatsapp-green text-white py-4 rounded-xl flex items-center justify-center gap-3 font-bold text-lg hover:brightness-95 transition-all shadow-lg"
                    href={waLink(profile.phone, `Hi, I'm interested in the ${vehicleTitle(v)}.`)} target="_blank" rel="noopener noreferrer"
                  >
                    <span className="material-symbols-outlined">whatshot</span>
                    WhatsApp Sales Advisor
                  </a>
                )}
                {profile.phone && (
                  <a className="w-full bg-surface-container-highest text-primary py-4 rounded-xl flex items-center justify-center gap-3 font-bold text-lg hover:bg-outline-variant transition-all" href={telLink(profile.phone)}>
                    <span className="material-symbols-outlined">call</span>
                    Call Showroom
                  </a>
                )}
              </div>
              <KineticFinanceMiniCalculator startingPrice={v.price ?? 25000} />
              {profile.address && (
                <div className="bg-surface-container-low p-4 rounded-2xl border border-outline-variant">
                  <h3 className="font-bold mb-3 flex items-center gap-2">
                    <span className="material-symbols-outlined text-secondary">map</span>
                    Our Location
                  </h3>
                  <p className="text-sm font-semibold">{profile.dealershipName}</p>
                  <p className="text-xs text-on-surface-variant">{profile.address}</p>
                </div>
              )}
            </div>
          </aside>
        </div>
        {similar.length > 0 && (
          <section className="mt-section-gap">
            <h2 className="font-headline-lg text-headline-lg mb-8">Similar Inventory</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-gutter">
              {similar.map((sv) => (
                <Link key={sv.id} href={`/inventory/${sv.slug}`} className="group bg-white rounded-xl overflow-hidden border border-outline-variant hover:shadow-2xl transition-all duration-300 block">
                  <div className="aspect-[16/9] relative overflow-hidden">
                    <KineticVehicleImage vehicle={sv} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
                  </div>
                  <div className="p-4 space-y-2">
                    <h4 className="font-bold text-primary group-hover:text-secondary transition-colors">{vehicleTitle(sv)}</h4>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-on-surface-variant">{sv.mileage != null ? `${sv.mileage.toLocaleString()} KM` : sv.status}</span>
                      <span className="font-bold text-primary">{formatPrice(sv.price)}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
      <KineticFooter props={props} />
      <div className="md:hidden fixed bottom-0 left-0 right-0 glass-panel border-t border-outline-variant p-4 z-[100] flex gap-3">
        {profile.phone && (
          <>
            <a className="flex-1 bg-whatsapp-green text-white py-3 rounded-lg flex items-center justify-center gap-2 font-bold text-sm" href={waLink(profile.phone, `Hi, I'm interested in the ${vehicleTitle(v)}.`)} target="_blank" rel="noopener noreferrer">
              <span className="material-symbols-outlined">whatshot</span>
              WhatsApp
            </a>
            <a className="flex-1 bg-primary text-white py-3 rounded-lg flex items-center justify-center gap-2 font-bold text-sm" href={telLink(profile.phone)}>
              <span className="material-symbols-outlined">call</span>
              Call Now
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function KineticFinanceMiniCalculator({ startingPrice }: { startingPrice: number }) {
  const [downPercent, setDownPercent] = useState(20);
  const [termMonths, setTermMonths] = useState(60);
  const monthlyRate = 0.045 / 12;
  const loanAmount = startingPrice * (1 - downPercent / 100);
  const monthly = Math.round(
    (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1)
  );
  const downAmount = Math.round(startingPrice * (downPercent / 100));

  return (
    <div className="bg-primary text-white p-6 rounded-2xl shadow-xl space-y-6 overflow-hidden relative">
      <h3 className="font-bold text-xl relative z-10">Finance Calculator</h3>
      <div className="space-y-4 relative z-10">
        <div>
          <label className="text-xs text-on-primary-container font-semibold uppercase tracking-wider">Down Payment ({downPercent}%)</label>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="font-bold whitespace-nowrap">{downAmount.toLocaleString()} JOD</span>
            <input className="w-1/2 accent-secondary" max={80} min={10} step={5} type="range" value={downPercent} onChange={(e) => setDownPercent(Number(e.target.value))} />
          </div>
        </div>
        <div>
          <label className="text-xs text-on-primary-container font-semibold uppercase tracking-wider">Term ({termMonths} Months)</label>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="font-bold whitespace-nowrap">{Math.round(termMonths / 12)} Years</span>
            <input className="w-1/2 accent-secondary" max={84} min={12} step={12} type="range" value={termMonths} onChange={(e) => setTermMonths(Number(e.target.value))} />
          </div>
        </div>
        <div className="pt-4 border-t border-white/10 flex items-center justify-between">
          <p className="text-sm">Monthly Installment</p>
          <p className="text-2xl font-bold text-luxury-gold">{monthly.toLocaleString()} JOD</p>
        </div>
      </div>
      <Link href="/finance" className="w-full bg-secondary text-white py-3 rounded-xl font-bold hover:brightness-110 transition-all z-10 relative block text-center">Apply for Finance</Link>
    </div>
  );
}
