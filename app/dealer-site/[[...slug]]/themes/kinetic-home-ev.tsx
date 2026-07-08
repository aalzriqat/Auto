"use client";

import { useState } from "react";
import Link from "next/link";
import type { ThemeProps } from "./theme-props";
import { KineticBrand, KineticVehicleImage, useKineticStrings, waLink } from "./kinetic-shared";

export function KineticModernEvHome(props: ThemeProps) {
  const { site, lang, showLangToggle, isPreviewMode, onToggleLang, t, formatPrice, featuredVehicles, dir } = props;
  const profile = site.profile;
  const cars = featuredVehicles.slice(0, 3);
  const k = useKineticStrings(lang);

  const [distance, setDistance] = useState(2000);
  const [gasPrice, setGasPrice] = useState(1.25);
  const monthlyGasCost = (distance / 100) * 10 * gasPrice;
  const monthlyEvCost = (distance / 100) * 18 * 0.12;
  const yearlySavings = Math.round((monthlyGasCost - monthlyEvCost) * 12);

  return (
    <div className="theme-kinetic bg-surface font-body-md text-on-surface overflow-x-hidden" dir={dir}>
      {isPreviewMode && (
        <div className="bg-secondary px-4 py-2 text-center text-sm font-bold text-white">{t.previewBanner}</div>
      )}
      <nav className="bg-surface/90 backdrop-blur-xl docked full-width top-0 sticky z-50 shadow-sm">
        <div className="flex justify-between items-center px-gutter py-4 w-full max-w-screen-2xl mx-auto">
          <div className="flex items-center gap-8">
            <Link href="/">
              <KineticBrand profile={profile} size="sm" />
            </Link>
            <div className="hidden md:flex gap-6 items-center">
              <Link className="text-secondary border-b-2 border-secondary font-bold pb-1 font-label-caps text-label-caps" href="/inventory">{t.nav.inventory}</Link>
              <Link className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="/finance">{t.nav.finance}</Link>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {profile.phone && (
              <a className="hidden lg:flex items-center gap-2 bg-whatsapp-green text-white px-4 py-2 rounded-full font-bold transition-transform scale-95 active:scale-90 duration-200"
                href={waLink(profile.phone, `Hi ${profile.dealershipName}, I'd like to know more about your EV lineup.`)} target="_blank" rel="noopener noreferrer">
                <span className="material-symbols-outlined">chat</span>
                <span>{k.whatsappSupport}</span>
              </a>
            )}
            {showLangToggle && (
              <button onClick={onToggleLang} className="p-2 hover:bg-surface-container-highest/50 rounded-full transition-colors flex items-center gap-2">
                <span className="material-symbols-outlined">language</span>
                <span className="font-arabic-ui text-arabic-ui">{lang === "en" ? "العربية" : "English"}</span>
              </button>
            )}
          </div>
        </div>
      </nav>

      <main>
        <section className="relative min-h-[600px] lg:h-[921px] overflow-hidden flex items-center bg-primary">
          <div className="relative z-10 w-full max-w-screen-2xl mx-auto px-gutter grid lg:grid-cols-2 items-center gap-12 py-16">
            <div className="space-y-8">
              <div className="inline-flex items-center gap-3 bg-electric-blue/10 border border-electric-blue/20 rounded-full px-4 py-1">
                <span className="w-2 h-2 rounded-full bg-electric-blue animate-pulse" />
                <span className="text-electric-blue font-label-caps text-label-caps">{k.evBadge}</span>
              </div>
              <h1 className="font-headline-lg text-6xl text-white leading-tight">
                {profile.heroTitle ?? k.evHeroTitle}
              </h1>
              <p className="text-on-primary-container text-xl max-w-lg leading-relaxed">
                {profile.heroSubtitle ?? k.evHeroSubtitle}
              </p>
              <div className="flex flex-wrap gap-4 pt-4">
                <Link className="bg-electric-blue text-white px-8 py-4 rounded-xl font-bold flex items-center gap-2 hover:translate-y-[-2px] transition-transform" href="/inventory">
                  {k.evExploreInventory}
                  <span className="material-symbols-outlined">arrow_forward</span>
                </Link>
                <Link className="bg-white/5 border border-white/10 backdrop-blur-md text-white px-8 py-4 rounded-xl font-bold hover:bg-white/10 transition-colors" href="/contact">
                  {k.evChargingGuide}
                </Link>
              </div>
            </div>
            <div className="relative hidden lg:block">
              <img
                className="w-full h-auto object-contain transform translate-x-12 scale-110 drop-shadow-[0_0_50px_rgba(99,102,241,0.2)]"
                alt=""
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuBNnORI3oOFyAbC4TeenRWQ32ToBBbBkXxszpVsb_-HQWx5zPkQeOTaW2H6oe8bkDt13turpwT5g0jMwX9D2ZyV9WoK6QWLRJ5bG-sDisD5G4uFYoxsv2eJpdFEUY6XMqy1bzO4BqTcqsNpcwJsLPJhyd79s2SUmZdf84A7w9xwloDmoDvjaOBJXoy9YBBb1ZfrcAwSNkPe6nCicSJsCr661HfCuDbF_5m8f1oCC8zz4lqLPCQFQ0qdfXkbmqO9zoIgrk7_zrlJvmp0"
              />
            </div>
          </div>
        </section>

        <section className="py-section-gap px-gutter max-w-screen-2xl mx-auto">
          <div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6">
            <div className="space-y-2">
              <h2 className="font-headline-lg text-headline-lg">{k.premiumFleet}</h2>
            </div>
            <Link href="/inventory" className="font-label-caps text-label-caps text-electric-blue hover:underline">{t.viewAll}</Link>
          </div>
          {cars.length ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {cars.map((v) => (
                <Link key={v.id} href={`/inventory/${v.slug}`} className="group bg-surface-container-lowest border border-outline-variant rounded-3xl overflow-hidden hover:shadow-xl transition-all duration-300 block">
                  <div className="relative aspect-[16/10] overflow-hidden">
                    <KineticVehicleImage vehicle={v} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                    <div className="absolute top-4 left-4 bg-white/90 backdrop-blur-sm px-3 py-1 rounded-full text-xs font-bold text-primary">{v.status}</div>
                  </div>
                  <div className="p-6 space-y-6">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-headline-lg text-xl">{v.make} {v.model}</h3>
                        <p className="text-on-surface-variant text-sm">{v.trim ?? `${v.year}`}</p>
                      </div>
                      <span className="text-electric-blue font-bold text-xl">{formatPrice(v.price)}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-4 border-t border-b border-outline-variant/30 py-4">
                      <div className="text-center">
                        <span className="material-symbols-outlined text-electric-blue block mb-1">calendar_month</span>
                        <span className="font-bold text-sm">{v.year}</span>
                        <span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">{k.yearSpecLabel}</span>
                      </div>
                      {v.mileage != null && (
                        <div className="text-center">
                          <span className="material-symbols-outlined text-electric-blue block mb-1">speed</span>
                          <span className="font-bold text-sm">{v.mileage.toLocaleString()}km</span>
                          <span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">{t.mileage}</span>
                        </div>
                      )}
                      {v.fuelType && (
                        <div className="text-center">
                          <span className="material-symbols-outlined text-electric-blue block mb-1">bolt</span>
                          <span className="font-bold text-sm">{v.fuelType}</span>
                          <span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">{t.fuelType}</span>
                        </div>
                      )}
                    </div>
                    <span className="block w-full py-3 rounded-xl border border-primary font-bold text-center group-hover:bg-primary group-hover:text-white transition-all">{t.viewAll}</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="border-2 border-dashed border-outline-variant rounded-3xl p-16 text-center text-on-surface-variant">{t.noVehicles}</div>
          )}
        </section>

        <section className="bg-surface-container-low py-section-gap">
          <div className="max-w-screen-2xl mx-auto px-gutter grid lg:grid-cols-2 gap-16 items-center">
            <div className="order-2 lg:order-1">
              <div className="relative">
                <div className="absolute -top-10 -left-10 w-40 h-40 bg-electric-blue/10 rounded-full blur-3xl" />
                <img
                  className="relative rounded-[2rem] shadow-2xl z-10 w-full"
                  alt=""
                  src="https://lh3.googleusercontent.com/aida-public/AB6AXuB9tkPxwJAFg1dg7T2fR9-ReZcO-EMVzIDUAjRq_nhV0pOaJykZJZR3AEAjn29KuTd4ZqvFZm9Av74w0MG2m26rKkueSl9eddpPn9InjFd010rLHkxBjL8ruhFFRBsGjHT73U8M2miU6D1pWhR4jGTCl6CsLQDoR8fRQUiaSsZq9jaTB-OqkblBG9lXg59L6eJerJJ7E-oehcR3ma5lBHOYbU3VFFXoIeaukamq1NY-WV6--Eq2S-ErndEmuAWY2R6uJQKXlbh9xNI6"
                />
                <div className="absolute -bottom-8 -right-8 bg-white p-6 rounded-2xl shadow-xl z-20 flex gap-4 items-center">
                  <div className="bg-whatsapp-green/20 p-3 rounded-full">
                    <span className="material-symbols-outlined text-whatsapp-green">ev_station</span>
                  </div>
                  <div>
                    <p className="font-bold text-primary">150+ {k.chargingNetworkPoints}</p>
                    <p className="text-xs text-on-surface-variant">{k.publicChargingNetwork}</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="order-1 lg:order-2 space-y-8">
              <h2 className="font-headline-lg text-headline-lg">{k.chargingSectionTitle}</h2>
              <p className="text-on-surface-variant text-lg leading-relaxed">
                {k.chargingSectionDesc}
              </p>
              <div className="space-y-4">
                <div className="flex gap-4 items-start">
                  <div className="bg-primary text-white p-2 rounded-lg mt-1"><span className="material-symbols-outlined">home</span></div>
                  <div>
                    <h4 className="font-bold">{k.homeChargerTitle}</h4>
                    <p className="text-sm text-on-surface-variant">{k.homeChargerDesc}</p>
                  </div>
                </div>
                <div className="flex gap-4 items-start">
                  <div className="bg-primary text-white p-2 rounded-lg mt-1"><span className="material-symbols-outlined">map</span></div>
                  <div>
                    <h4 className="font-bold">{k.nationwideNetworkTitle}</h4>
                    <p className="text-sm text-on-surface-variant">{k.nationwideNetworkDesc}</p>
                  </div>
                </div>
              </div>
              <Link className="inline-block bg-primary text-white px-8 py-4 rounded-xl font-bold hover:bg-primary/90 transition-colors" href="/contact">{k.exploreInfrastructure}</Link>
            </div>
          </div>
        </section>

        <section className="py-section-gap px-gutter bg-white relative overflow-hidden">
          <div className="max-w-4xl mx-auto text-center space-y-6 mb-16 relative z-10">
            <h2 className="font-headline-lg text-headline-lg">{k.efficiencyAdvantage}</h2>
          </div>
          <div className="max-w-5xl mx-auto glass p-8 md:p-12 rounded-[3rem] border border-outline-variant/30 shadow-sm relative z-10">
            <div className="grid md:grid-cols-2 gap-12">
              <div className="space-y-8">
                <div>
                  <label className="block font-bold mb-4 flex justify-between">
                    {k.monthlyDistance} <span>{distance.toLocaleString()} km</span>
                  </label>
                  <input className="w-full h-2 bg-surface-container-high rounded-lg appearance-none cursor-pointer accent-electric-blue" max={10000} min={500} step={100} type="range" value={distance} onChange={(e) => setDistance(Number(e.target.value))} />
                </div>
                <div>
                  <label className="block font-bold mb-4 flex justify-between">
                    {k.gasPriceLabel} <span>{gasPrice.toFixed(2)} JOD</span>
                  </label>
                  <input className="w-full h-2 bg-surface-container-high rounded-lg appearance-none cursor-pointer accent-electric-blue" max={2.0} min={0.8} step={0.05} type="range" value={gasPrice} onChange={(e) => setGasPrice(Number(e.target.value))} />
                </div>
                <div className="p-6 bg-surface-container-low rounded-2xl">
                  <p className="text-xs text-on-surface-variant uppercase font-bold tracking-widest mb-2">{k.estimatedElectricityCost}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-electric-blue font-bold text-2xl">0.12 JOD</span>
                    <span className="text-sm text-on-surface-variant">{k.kwhAverage}</span>
                  </div>
                </div>
              </div>
              <div className="bg-primary rounded-[2rem] p-8 text-white flex flex-col justify-center items-center text-center space-y-4">
                <p className="text-on-primary-container font-label-caps tracking-widest">{k.estimatedYearlySavings}</p>
                <div className="text-6xl font-bold text-electric-blue">{yearlySavings.toLocaleString()}</div>
                <span className="text-2xl font-bold">JOD / {k.yearSpecLabel}</span>
                <p className="text-sm text-on-primary-container opacity-80 mt-4 leading-relaxed">
                  {k.yearlySavingsNote}
                </p>
                <Link href="/contact" className="mt-6 w-full py-4 bg-white text-primary rounded-xl font-bold hover:bg-electric-blue hover:text-white transition-all text-center">{k.startYourSwitch}</Link>
              </div>
            </div>
          </div>
        </section>

        <section className="py-section-gap px-gutter max-w-screen-2xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="font-headline-lg text-headline-lg">{k.intelligenceTitle}</h2>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              ["sensors", k.autopilotTitle, k.autopilotDesc],
              ["update", k.otaTitle, k.otaDesc],
              ["smartphone", k.appCommandTitle, k.appCommandDesc],
              ["shield", k.safetyCoreTitle, k.safetyCoreDesc],
            ].map(([icon, title, body]) => (
              <div className="p-8 rounded-3xl border border-outline-variant hover:border-electric-blue hover:bg-electric-blue/[0.02] transition-all text-center space-y-4" key={title}>
                <div className="w-16 h-16 bg-surface-container rounded-2xl flex items-center justify-center mx-auto text-electric-blue">
                  <span className="material-symbols-outlined text-4xl">{icon}</span>
                </div>
                <h3 className="font-bold text-xl">{title}</h3>
                <p className="text-sm text-on-surface-variant">{body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="bg-primary py-section-gap">
        <div className="w-full max-w-screen-2xl mx-auto px-margin-desktop grid grid-cols-1 md:grid-cols-4 gap-gutter">
          <div className="space-y-6">
            <span className="font-display-luxury text-display-luxury text-luxury-gold text-4xl block">{profile.dealershipName}</span>
            <p className="text-on-primary-container text-sm leading-relaxed">{profile.slogan ?? k.evFooterSloganDefault}</p>
          </div>
          <div className="space-y-4">
            <h4 className="text-white font-bold text-lg">{t.nav.inventory}</h4>
            <nav className="flex flex-col gap-2">
              <Link className="text-on-primary-container hover:text-white transition-colors" href="/inventory">{k.allVehicles}</Link>
              <Link className="text-on-primary-container hover:text-white transition-colors" href="/finance">{k.financeCalculatorLabel}</Link>
            </nav>
          </div>
          <div className="space-y-4">
            <h4 className="text-white font-bold text-lg">{k.evFooterOwnersHeading}</h4>
            <nav className="flex flex-col gap-2">
              <Link className="text-on-primary-container hover:text-white transition-colors" href="/contact">{k.serviceCenter}</Link>
              <Link className="text-on-primary-container hover:text-white transition-colors" href="/branches">{t.nav.branches}</Link>
            </nav>
          </div>
          <div className="space-y-4">
            <h4 className="text-white font-bold text-lg">{k.contactUsHeading}</h4>
            {profile.address && (
              <p className="text-on-primary-container text-sm">
                {profile.address.startsWith("http") ? (
                  <a href={profile.address} target="_blank" rel="noopener noreferrer" className="hover:underline">{t.viewOnMap}</a>
                ) : (
                  profile.address
                )}
              </p>
            )}
            {profile.phones.map((phone) => (
              <a key={phone} href={`tel:${phone}`} className="block text-white font-bold hover:underline">{phone}</a>
            ))}
            <Link className="block bg-luxury-gold text-primary w-full py-3 rounded-lg font-bold hover:bg-jod-gold transition-colors text-center" href="/contact">{k.bookTestDrive}</Link>
          </div>
        </div>
        <div className="max-w-screen-2xl mx-auto px-margin-desktop mt-20 pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4 text-[10px] uppercase tracking-[0.2em] text-on-primary-container">
          <span>© {new Date().getFullYear()} {profile.dealershipName}. {k.allRightsReserved}.</span>
          <div className="flex gap-8">
            <Link className="hover:text-white" href="/privacy">{t.footerPrivacy}</Link>
            <Link className="hover:text-white" href="/terms">{t.footerTerms}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
