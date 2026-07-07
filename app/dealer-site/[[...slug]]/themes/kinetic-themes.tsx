"use client";

import { useMemo, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Car,
  CheckCircle2,
  Globe2,
  Mail,
  MapPin,
  Menu,
  Phone,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import type { FormState, PublicVehicle, SiteStrings, ThemeProps } from "./theme-props";
import { TurnstileWidget } from "../turnstile-widget";

type KineticDesignId = "luxury" | "modern-ev" | "sales";

export function KineticLuxuryTheme(props: ThemeProps) {
  return <KineticRoot props={props} design="luxury" />;
}

export function KineticModernEvTheme(props: ThemeProps) {
  return <KineticRoot props={props} design="modern-ev" />;
}

export function KineticSalesTheme(props: ThemeProps) {
  return <KineticRoot props={props} design="sales" />;
}

function KineticRoot({ props, design }: { props: ThemeProps; design: KineticDesignId }) {
  const { page, t } = props;

  let content: ReactNode = null;
  if (page === "home" || page === "") {
    if (design === "luxury") {
      content = <KineticLuxuryHome {...props} />;
    } else if (design === "modern-ev") {
      content = <KineticModernEvHome {...props} />;
    } else if (design === "sales") {
      content = <KineticSalesHome {...props} />;
    }
  } else if (page === "inventory") {
    if (props.detailVehicle) {
      content = <KineticVehicleDetail {...props} vehicle={props.detailVehicle} />;
    } else {
      content = <KineticInventoryPage {...props} />;
    }
  } else if (page === "finance") {
    content = <KineticFinancePage {...props} />;
  } else if (page === "branches") {
    content = <KineticBranchesPage {...props} />;
  } else if (page === "contact") {
    content = <KineticContactPage {...props} />;
  } else if (["privacy", "terms", "data-deletion"].includes(page)) {
    content = <KineticLegalPage {...props} />;
  }

  return (
    <div className={`kh-shell kh-design-${design}`} dir={props.dir}>
      <KineticNav {...props} />
      <main>{content}</main>
      <KineticFooter {...props} />
      <KineticGlobalStyles />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Components
// ----------------------------------------------------------------------------

function KineticNav(props: ThemeProps) {
  const { site, t, lang, showLangToggle, onToggleLang, mobileNavOpen, setMobileNavOpen } = props;
  const profile = site.profile;
  const nav = [
    [t.nav.home, "/"],
    [t.nav.inventory, "/inventory"],
    [t.nav.finance, "/finance"],
    [t.nav.branches, "/branches"],
    [t.nav.contact, "/contact"],
  ];
  return (
    <header className="bg-surface/90 backdrop-blur-xl docked full-width top-0 sticky z-50 shadow-sm">
      <nav className="flex justify-between items-center px-gutter py-4 w-full max-w-screen-2xl mx-auto">
        <Link href="/" className="flex items-center gap-base">
          {profile.logoUrl ? (
            <img src={profile.logoUrl} alt={profile.dealershipName} className="h-10 w-auto" />
          ) : (
            <>
              <span className="material-symbols-outlined text-luxury-gold" style={{ fontVariationSettings: "'FILL' 1" }}>directions_car</span>
              <h1 className="font-display-luxury text-[32px] text-luxury-gold">{profile.dealershipName}</h1>
            </>
          )}
        </Link>
        <div className="hidden md:flex items-center gap-8">
          {nav.map(([label, href]) => (
            <Link key={label} href={href} className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps">
              {label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-4">
          {profile.phone && (
            <a href={`https://wa.me/${profile.phone.replace(/[^0-9]/g, "")}`} target="_blank" rel="noopener noreferrer" className="hidden lg:flex items-center gap-2 bg-whatsapp-green text-white px-4 py-2 rounded-lg font-bold hover:opacity-90 transition-opacity">
              <span className="material-symbols-outlined">whatshot</span>
              <span>{t.placeholderWhatsApp}</span>
            </a>
          )}
          {showLangToggle && (
            <button onClick={onToggleLang} className="text-primary font-arabic-ui text-arabic-ui">
              {lang === "en" ? "العربية" : "English"}
            </button>
          )}
          <button className="md:hidden text-primary" onClick={() => setMobileNavOpen(!mobileNavOpen)}>
            {mobileNavOpen ? <X /> : <Menu />}
          </button>
        </div>
      </nav>
      {mobileNavOpen && (
        <div className="md:hidden bg-surface p-4 border-t border-outline-variant">
          <div className="flex flex-col gap-4">
             {nav.map(([label, href]) => (
               <Link key={label} href={href} className="text-on-surface-variant hover:text-primary font-label-caps text-lg" onClick={() => setMobileNavOpen(false)}>
                 {label}
               </Link>
             ))}
          </div>
        </div>
      )}
    </header>
  );
}

function KineticFooter(props: ThemeProps) {
  const { site, t } = props;
  const profile = site.profile;
  return (
    <footer className="bg-primary py-section-gap w-full px-margin-desktop text-on-primary">
      <div className="max-w-screen-2xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-gutter">
        <div className="flex flex-col gap-4">
          <h2 className="font-display-luxury text-[32px] text-luxury-gold">{profile.dealershipName}</h2>
          <p className="text-on-primary-container text-sm leading-relaxed">
            {profile.slogan || "Your trusted automotive partner."}
          </p>
        </div>
        <div>
          <h4 className="font-bold text-white mb-6 uppercase tracking-widest text-xs">Quick Links</h4>
          <ul className="flex flex-col gap-4 text-sm text-on-primary-container">
            <li><Link href="/inventory" className="hover:text-white transition-colors">{t.nav.inventory}</Link></li>
            <li><Link href="/finance" className="hover:text-white transition-colors">{t.nav.finance}</Link></li>
            <li><Link href="/branches" className="hover:text-white transition-colors">{t.nav.branches}</Link></li>
            <li><Link href="/contact" className="hover:text-white transition-colors">{t.nav.contact}</Link></li>
          </ul>
        </div>
        <div>
          <h4 className="font-bold text-white mb-6 uppercase tracking-widest text-xs">Policies</h4>
          <ul className="flex flex-col gap-4 text-sm text-on-primary-container">
            <li><Link href="/privacy" className="hover:text-white transition-colors">{t.footerPrivacy}</Link></li>
            <li><Link href="/terms" className="hover:text-white transition-colors">{t.footerTerms}</Link></li>
            <li><Link href="/data-deletion" className="hover:text-white transition-colors">{t.footerDataDeletion}</Link></li>
          </ul>
        </div>
        <div>
          <h4 className="font-bold text-white mb-6 uppercase tracking-widest text-xs">Contact</h4>
          {profile.address && <p className="text-sm text-on-primary-container mb-4">{profile.address}</p>}
          {profile.phone && <p className="text-sm text-on-primary-container">{profile.phone}</p>}
        </div>
      </div>
      <div className="max-w-screen-2xl mx-auto border-t border-on-primary-fixed-variant mt-16 pt-8 text-center text-[10px] text-on-primary-container tracking-widest uppercase">
        © {new Date().getFullYear()} {profile.dealershipName}. {t.brand}.
      </div>
    </footer>
  );
}

function KineticLuxuryHome(props: ThemeProps) {
  const { site, vehicles, formatPrice } = props;
  const profile = site.profile;
  const featured = vehicles.slice(0, 3);
  return (
    <main>
      <section className="relative h-screen w-full overflow-hidden">
        <div className="absolute inset-0 bg-primary/40 z-10"></div>
        <div className="absolute inset-0 w-full h-full">
          <div className="w-full h-full bg-cover bg-center transition-transform duration-1000 scale-105" style={{ backgroundImage: "url('https://lh3.googleusercontent.com/aida-public/AB6AXuBaeBg7I5oQC5iPs3oeViaCgbyOttAAxVOWW68dpG5fFKN-sFW366E2rcwrWFK7YcTWO9AMVyUJOVT14rTMfdCAZz34IK_Ytq1P0ML1zmeRdNMtZvopTYsOAC2Vb0H5WKoVPoJztGx1641T_w87supNsYVrd0Wv_DTFyVZjR6mG69fwPXo8ssqhDtuNYC_5uppZ71xuodPp1VJgy5sUDaPAfAG0McCSOgTW2Q6a41Le-xlqyp5wdoO18Y-3cB8Ba3nb2-dXD5yjuOoP')" }}></div>
        </div>
        <div className="relative z-20 h-full flex flex-col justify-center items-center text-center px-margin-mobile md:px-margin-desktop">
          <div className="max-w-4xl space-y-6">
            <h1 className="font-display-luxury text-white text-[48px] md:text-[80px] leading-tight animate-fade-in">{profile.dealershipName}</h1>
            <p className="font-body-md text-white/90 text-lg md:text-xl max-w-2xl mx-auto opacity-80">
              {profile.slogan || "Experience the pinnacle of automotive excellence. Discover an curated collection of the world's most prestigious marques."}
            </p>
            <div className="flex flex-col md:flex-row gap-4 justify-center pt-8">
              <Link className="px-8 py-4 bg-luxury-gold text-white font-label-caps text-label-caps rounded-sm hover:bg-jod-gold transition-all transform hover:-translate-y-1 shadow-lg flex items-center justify-center gap-2" href="/inventory">
                Browse Exclusive Collection <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </Link>
              <Link className="px-8 py-4 bg-white/10 backdrop-blur-md border border-white/30 text-white font-label-caps text-label-caps rounded-sm hover:bg-white hover:text-primary transition-all flex items-center justify-center gap-2" href="/contact">
                Private Showroom Visit <span className="material-symbols-outlined text-[16px]">event</span>
              </Link>
            </div>
          </div>
        </div>
      </section>
      
      <section className="bg-primary py-12 border-y border-luxury-gold/20">
        <div className="max-w-screen-2xl mx-auto px-gutter grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="text-center">
            <div className="font-display-luxury text-luxury-gold text-4xl mb-1">15+</div>
            <div className="font-label-caps text-on-primary-container text-xs tracking-widest uppercase">Years of Heritage</div>
          </div>
          <div className="text-center">
            <div className="font-display-luxury text-luxury-gold text-4xl mb-1">500+</div>
            <div className="font-label-caps text-on-primary-container text-xs tracking-widest uppercase">Elite Deliveries</div>
          </div>
          <div className="text-center">
            <div className="font-display-luxury text-luxury-gold text-4xl mb-1">24h</div>
            <div className="font-label-caps text-on-primary-container text-xs tracking-widest uppercase">Global Sourcing</div>
          </div>
          <div className="text-center">
            <div className="font-display-luxury text-luxury-gold text-4xl mb-1">100%</div>
            <div className="font-label-caps text-on-primary-container text-xs tracking-widest uppercase">Private Service</div>
          </div>
        </div>
      </section>

      <section className="py-section-gap bg-surface-container-lowest">
        <div className="max-w-screen-2xl mx-auto px-gutter">
          <div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6">
            <div>
              <span className="font-label-caps text-luxury-gold text-sm tracking-widest uppercase">Featured Inventory</span>
              <h2 className="font-display-luxury text-primary text-headline-lg mt-2">Curated Masterpieces</h2>
            </div>
            <Link className="font-label-caps text-primary border-b border-primary pb-1 hover:text-luxury-gold hover:border-luxury-gold transition-colors" href="/inventory">View All Vehicles</Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {featured.map(v => (
              <div key={v.id} className="group cursor-pointer car-card-hover transition-all duration-700">
                <Link href={`/inventory/${v.slug || v.id}`}>
                  <div className="relative aspect-[16/10] overflow-hidden rounded-sm bg-surface-container">
                    <img className="car-image w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" src={v.imageUrls[0] || ""} />
                    <div className="absolute top-4 left-4">
                      <span className="bg-primary text-white font-label-caps text-[10px] px-3 py-1 tracking-tighter rounded-full uppercase">{v.status}</span>
                    </div>
                  </div>
                  <div className="mt-6 space-y-2">
                    <div className="flex justify-between items-start">
                      <h3 className="font-headline-lg text-xl text-primary">{v.make} {v.model}</h3>
                      <span className="font-headline-lg text-luxury-gold text-xl">{formatPrice(v.price)}</span>
                    </div>
                    <p className="font-body-md text-on-surface-variant text-sm">{v.year} • {v.mileage || "-"} km • {v.trim || "Standard"}</p>
                    <div className="flex gap-4 pt-2">
                      <div className="flex-1 py-3 text-center border border-outline text-primary font-label-caps text-xs hover:bg-primary hover:text-white transition-all uppercase">Inquire Now</div>
                    </div>
                  </div>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-section-gap bg-primary overflow-hidden">
        <div className="relative z-10 max-w-screen-2xl mx-auto px-gutter">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div className="relative">
              <div className="aspect-square rounded-sm overflow-hidden border border-luxury-gold/30 p-4">
                <div className="w-full h-full bg-cover bg-center" style={{ backgroundImage: "url('https://lh3.googleusercontent.com/aida-public/AB6AXuBd5Baj3AZCFWd5QddePY8xBqIF9sBxXj-86Nx-EK0yIhaIbJpyMJBnVLtO6tXk05g3Ns8YeFNFCEaqqU3HmUM9BTnEWDZOx-qCRLZFA5gVp9Uc_MssnlG9JuGTrmHGMA5zxCcAuZ_GYTPylTSuiWo27F9CzF06bQh5NzEnv712eM3tiXMccmBKoFqZGgBcIbJh-UaiK-CHaB8AizKxE43xV2yfm4n1qOwyVcIiJIVj54fFiL20bero-5ScZYEfV90fo_HoIQGPE7O-')" }}></div>
              </div>
              <div className="absolute -bottom-8 -right-8 bg-luxury-gold p-8 rounded-sm shadow-2xl hidden md:block">
                <div className="font-display-luxury text-white text-3xl">Est. 2009</div>
                <div className="font-label-caps text-white/80 text-[10px] tracking-widest uppercase">Trusted in Amman</div>
              </div>
            </div>
            <div className="space-y-8">
              <span className="font-label-caps text-luxury-gold text-sm tracking-widest uppercase">The AutoFlow Standard</span>
              <h2 className="font-display-luxury text-white text-[40px] md:text-[56px] leading-tight">Beyond Acquisition</h2>
              <div className="space-y-6">
                <div className="flex gap-6">
                  <span className="material-symbols-outlined text-luxury-gold text-3xl">verified_user</span>
                  <div>
                    <h4 className="font-headline-lg text-white text-xl mb-2">White-Glove Service</h4>
                    <p className="font-body-md text-on-primary-container">Every vehicle undergoes a 200-point inspection by certified technicians to ensure absolute perfection.</p>
                  </div>
                </div>
                <div className="flex gap-6">
                  <span className="material-symbols-outlined text-luxury-gold text-3xl">public</span>
                  <div>
                    <h4 className="font-headline-lg text-white text-xl mb-2">International Sourcing</h4>
                    <p className="font-body-md text-on-primary-container">If your dream car isn't in our showroom, our global network will locate it and manage the entire import process.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-24 bg-surface-container">
        <div className="max-w-4xl mx-auto px-margin-mobile text-center space-y-8">
          <h2 className="font-display-luxury text-primary text-4xl">Interested in a Private Consultation?</h2>
          <p className="font-body-md text-on-surface-variant text-lg">Our luxury specialists are available to discuss your requirements discreetly and professionally.</p>
          <div className="flex flex-col md:flex-row gap-6 justify-center">
            {profile.phone && (
              <a className="flex items-center justify-center gap-3 px-10 py-5 bg-whatsapp-green text-white rounded-full font-label-caps text-sm hover:opacity-90 transition-all shadow-lg" href={`https://wa.me/${profile.phone.replace(/[^0-9]/g, "")}`}>
                <span className="material-symbols-outlined">whatshot</span>
                Connect via WhatsApp
              </a>
            )}
            <Link className="px-10 py-5 bg-primary text-white rounded-full font-label-caps text-sm hover:bg-luxury-gold transition-all shadow-lg flex items-center justify-center" href="/contact">
              Request a Call Back
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

function KineticModernEvHome(props: ThemeProps) {
  const { site, vehicles, formatPrice, t } = props;
  const profile = site.profile;
  const featured = vehicles.slice(0, 3);
  return (
    <main>
      <section className="relative min-h-[800px] h-[90vh] overflow-hidden flex items-center bg-primary">
        <div className="relative z-10 w-full max-w-screen-2xl mx-auto px-gutter grid lg:grid-cols-2 items-center gap-12">
          <div className="space-y-8 animate-fade-in">
            <div className="inline-flex items-center gap-3 bg-electric-blue/10 border border-electric-blue/20 rounded-full px-4 py-1">
              <span className="w-2 h-2 rounded-full bg-electric-blue animate-pulse"></span>
              <span className="text-electric-blue font-label-caps text-label-caps">{t.specialOffers}</span>
            </div>
            <h1 className="font-headline-lg text-6xl text-white leading-tight">
              The Future <br/><span className="text-electric-blue">is Electric</span>
            </h1>
            <p className="text-on-primary-container text-xl max-w-lg leading-relaxed">
              {profile.slogan || "Experience the peak of automotive innovation. Precision engineered for the highways of Amman and the silence of the desert."}
            </p>
            <div className="flex flex-wrap gap-4 pt-4">
              <Link className="bg-electric-blue text-white px-8 py-4 rounded-xl font-bold flex items-center gap-2 hover:translate-y-[-2px] transition-transform" href="/inventory">
                Explore EV Inventory
                <span className="material-symbols-outlined">arrow_forward</span>
              </Link>
              <Link className="bg-white/5 border border-white/10 backdrop-blur-md text-white px-8 py-4 rounded-xl font-bold hover:bg-white/10 transition-colors" href="/finance">
                Finance Options
              </Link>
            </div>
          </div>
          <div className="relative hidden lg:block">
            <img className="w-full h-auto object-contain transform translate-x-12 scale-110 drop-shadow-[0_0_50px_rgba(99,102,241,0.2)]" src="https://lh3.googleusercontent.com/aida-public/AB6AXuBNnORI3oOFyAbC4TeenRWQ32ToBBbBkXxszpVsb_-HQWx5zPkQeOTaW2H6oe8bkDt13turpwT5g0jMwX9D2ZyV9WoK6QWLRJ5bG-sDisD5G4uFYoxsv2eJpdFEUY6XMqy1bzO4BqTcqsNpcwJsLPJhyd79s2SUmZdf84A7w9xwloDmoDvjaOBJXoy9YBBb1ZfrcAwSNkPe6nCicSJsCr661HfCuDbF_5m8f1oCC8zz4lqLPCQFQ0qdfXkbmqO9zoIgrk7_zrlJvmp0" />
          </div>
        </div>
      </section>

      <section className="py-section-gap px-gutter max-w-screen-2xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6">
          <div className="space-y-2">
            <h2 className="font-headline-lg text-headline-lg">Premium Fleet</h2>
            <p className="text-on-surface-variant font-arabic-ui">استكشف مستقبل التنقل الكهربائي في الأردن</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {featured.map(v => (
            <div key={v.id} className="group bg-surface-container-lowest border border-outline-variant rounded-3xl overflow-hidden hover:shadow-xl transition-all duration-300">
              <Link href={`/inventory/${v.slug || v.id}`}>
                <div className="relative aspect-[16/10] overflow-hidden">
                  <img className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" src={v.imageUrls[0] || ""} />
                  <div className="absolute top-4 left-4 bg-white/90 backdrop-blur-sm px-3 py-1 rounded-full text-xs font-bold text-primary">{v.status}</div>
                </div>
                <div className="p-6 space-y-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-headline-lg text-xl">{v.make} {v.model}</h3>
                      <p className="text-on-surface-variant text-sm">{v.trim}</p>
                    </div>
                    <span className="text-electric-blue font-bold text-xl">{formatPrice(v.price)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-4 border-t border-b border-outline-variant/30 py-4">
                    <div className="text-center">
                      <span className="material-symbols-outlined text-electric-blue block mb-1">speed</span>
                      <span className="font-bold text-sm">{v.mileage || "-"} KM</span>
                      <span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">{t.mileage}</span>
                    </div>
                    <div className="text-center">
                      <span className="material-symbols-outlined text-electric-blue block mb-1">battery_charging_full</span>
                      <span className="font-bold text-sm">{v.fuelType || "EV"}</span>
                      <span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">{t.fuelType}</span>
                    </div>
                    <div className="text-center">
                      <span className="material-symbols-outlined text-electric-blue block mb-1">settings</span>
                      <span className="font-bold text-sm">{v.transmission || "Auto"}</span>
                      <span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">{t.transmission}</span>
                    </div>
                  </div>
                  <div className="w-full py-3 rounded-xl border border-primary font-bold hover:bg-primary hover:text-white transition-all text-center">View Details</div>
                </div>
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-surface-container-low py-section-gap">
        <div className="max-w-screen-2xl mx-auto px-gutter grid lg:grid-cols-2 gap-16 items-center">
          <div className="order-2 lg:order-1">
            <div className="relative">
              <div className="absolute -top-10 -left-10 w-40 h-40 bg-electric-blue/10 rounded-full blur-3xl"></div>
              <img className="relative rounded-[2rem] shadow-2xl z-10" src="https://lh3.googleusercontent.com/aida-public/AB6AXuB9tkPxwJAFg1dg7T2fR9-ReZcO-EMVzIDUAjRq_nhV0pOaJykZJZR3AEAjn29KuTd4ZqvFZm9Av74w0MG2m26rKkueSl9eddpPn9InjFd010rLHkxBjL8ruhFFRBsGjHT73U8M2miU6D1pWhR4jGTCl6CsLQDoR8fRQUiaSsZq9jaTB-OqkblBG9lXg59L6eJerJJ7E-oehcR3ma5lBHOYbU3VFFXoIeaukamq1NY-WV6--Eq2S-ErndEmuAWY2R6uJQKXlbh9xNI6" />
              <div className="absolute -bottom-8 -right-8 bg-white p-6 rounded-2xl shadow-xl z-20 flex gap-4 items-center">
                <div className="bg-whatsapp-green/20 p-3 rounded-full">
                  <span className="material-symbols-outlined text-whatsapp-green">ev_station</span>
                </div>
                <div>
                  <p className="font-bold text-primary">150+ Points</p>
                  <p className="text-xs text-on-surface-variant">Jordan Public Network</p>
                </div>
              </div>
            </div>
          </div>
          <div className="order-1 lg:order-2 space-y-8">
            <h2 className="font-headline-lg text-headline-lg">Powering Your <br/>Journey Home &amp; Beyond</h2>
            <p className="text-on-surface-variant text-lg leading-relaxed">
              Say goodbye to gas stations. Our holistic charging ecosystem provides smart wall-boxes for your home and exclusive access to the fastest charging network across Jordan's main highways.
            </p>
            <div className="space-y-4">
              <div className="flex gap-4 items-start">
                <div className="bg-primary text-white p-2 rounded-lg mt-1">
                  <span className="material-symbols-outlined">home</span>
                </div>
                <div>
                  <h4 className="font-bold">AutoFlow Home Charger</h4>
                  <p className="text-sm text-on-surface-variant">Full charge overnight with our 11kW smart home station.</p>
                </div>
              </div>
              <div className="flex gap-4 items-start">
                <div className="bg-primary text-white p-2 rounded-lg mt-1">
                  <span className="material-symbols-outlined">map</span>
                </div>
                <div>
                  <h4 className="font-bold">Nationwide Network</h4>
                  <p className="text-sm text-on-surface-variant">Access to fast chargers from Amman to Aqaba via our app.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-section-gap px-gutter max-w-screen-2xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="font-headline-lg text-headline-lg">Intelligence in Every Kilowatt</h2>
          <p className="text-on-surface-variant mt-2 font-arabic-ui">تكنولوجيا القيادة الذكية والاتصال المتقدم</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-8">
          <div className="p-8 rounded-3xl border border-outline-variant hover:border-electric-blue hover:bg-electric-blue/[0.02] transition-all text-center space-y-4">
            <div className="w-16 h-16 bg-surface-container rounded-2xl flex items-center justify-center mx-auto text-electric-blue">
              <span className="material-symbols-outlined text-4xl">sensors</span>
            </div>
            <h3 className="font-bold text-xl">L2+ Autopilot</h3>
            <p className="text-sm text-on-surface-variant">Advanced sensor fusion for semi-autonomous cruising.</p>
          </div>
          <div className="p-8 rounded-3xl border border-outline-variant hover:border-electric-blue hover:bg-electric-blue/[0.02] transition-all text-center space-y-4">
            <div className="w-16 h-16 bg-surface-container rounded-2xl flex items-center justify-center mx-auto text-electric-blue">
              <span className="material-symbols-outlined text-4xl">update</span>
            </div>
            <h3 className="font-bold text-xl">OTA Updates</h3>
            <p className="text-sm text-on-surface-variant">Your car gets better every week with wireless software upgrades.</p>
          </div>
          <div className="p-8 rounded-3xl border border-outline-variant hover:border-electric-blue hover:bg-electric-blue/[0.02] transition-all text-center space-y-4">
            <div className="w-16 h-16 bg-surface-container rounded-2xl flex items-center justify-center mx-auto text-electric-blue">
              <span className="material-symbols-outlined text-4xl">smartphone</span>
            </div>
            <h3 className="font-bold text-xl">App Command</h3>
            <p className="text-sm text-on-surface-variant">Control climate, location, and security from your smartphone.</p>
          </div>
          <div className="p-8 rounded-3xl border border-outline-variant hover:border-electric-blue hover:bg-electric-blue/[0.02] transition-all text-center space-y-4">
            <div className="w-16 h-16 bg-surface-container rounded-2xl flex items-center justify-center mx-auto text-electric-blue">
              <span className="material-symbols-outlined text-4xl">shield</span>
            </div>
            <h3 className="font-bold text-xl">Safety Core</h3>
            <p className="text-sm text-on-surface-variant">5-Star safety rating with reinforced battery protection cell.</p>
          </div>
        </div>
      </section>
    </main>
  );
}

function KineticSalesHome(props: ThemeProps) {
  const { site, vehicles, formatPrice, t } = props;
  const profile = site.profile;
  const featured = vehicles.slice(0, 3);
  return (
    <main>
      <section className="relative min-h-[870px] flex items-center overflow-hidden sales-gradient text-white">
        <div className="absolute inset-0 z-0 bg-gradient-to-r from-primary via-primary/80 to-transparent"></div>
        <div className="relative z-10 w-full max-w-screen-2xl mx-auto px-margin-desktop py-section-gap grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-8">
            <div className="inline-flex items-center gap-2 px-4 py-1 bg-secondary rounded-full">
              <span className="animate-ping h-2 w-2 rounded-full bg-white opacity-75"></span>
              <span className="font-label-caps text-label-caps uppercase tracking-widest text-white">{vehicles.length}+ Cars Available</span>
            </div>
            <h1 className="font-headline-lg text-[64px] leading-tight font-extrabold uppercase italic tracking-tighter">
              Find Your Next <br/>
              <span className="text-secondary">Car Today</span>
            </h1>
            <p className="text-xl text-primary-fixed max-w-lg font-body-md">
              {profile.slogan || "The largest selection of premium used and new vehicles in Jordan. Quality inspected. Finance approved. Ready for delivery."}
            </p>
            <div className="bg-white p-2 rounded-xl shadow-2xl flex flex-col md:flex-row items-center gap-2">
              <div className="flex-1 w-full relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-outline">search</span>
                <input className="w-full pl-12 pr-4 py-4 text-primary border-none focus:ring-0 rounded-lg" placeholder="Search Make or Model" type="text"/>
              </div>
              <Link className="w-full md:w-auto px-8 py-4 bg-secondary text-white font-bold rounded-lg hover:bg-on-secondary-fixed transition-colors flex items-center justify-center gap-2" href="/inventory">
                <span className="font-label-caps text-label-caps">FIND CARS</span>
                <span className="material-symbols-outlined">arrow_forward</span>
              </Link>
            </div>
            <div className="flex flex-wrap gap-4">
              <Link className="px-8 py-4 border-2 border-white text-white font-bold rounded-lg hover:bg-white hover:text-primary transition-all" href="/inventory">
                View All {vehicles.length}+ Cars
              </Link>
              <Link className="px-8 py-4 bg-white/10 backdrop-blur-md text-white font-bold rounded-lg hover:bg-white/20 transition-all flex items-center gap-2" href="/finance">
                <span className="material-symbols-outlined">calculate</span>
                Calculate Monthly Payment
              </Link>
            </div>
          </div>
          <div className="hidden lg:block relative group">
            <div className="absolute -inset-4 bg-secondary/20 blur-3xl rounded-full group-hover:bg-secondary/40 transition-colors duration-700"></div>
            <img className="relative z-10 w-full h-auto object-cover rounded-2xl shadow-2xl transform group-hover:scale-[1.02] transition-transform duration-500" src="https://lh3.googleusercontent.com/aida-public/AB6AXuCISsNZv4p3s3nQX53EvqatD2UUtA1HnS1SuZamDkx6j07K8q3-_DmI8GsqbuwHJI70v7hECzMMo3fSJOhNX1uweay5guuGrNaEO2Qw1JV31BVKAL3nTnwKYlTDNSjJ3hK7VsxKiIBQYGy-GyMO1ViBNU75QYAVJdJJ9FqqvkfTmZekueid1yGHMjra7f_M2AFez-flbuL-CGhUIB9AxuUoXOeNfSUhtGkDkAZ_EkbrVq54BY9d1V9Q2jyBhRyKhLd_IkYbpLYZ-aw9" />
            <div className="absolute bottom-6 right-6 z-20 glass-card p-6 rounded-xl border border-white/20">
              <p className="text-primary font-bold text-lg mb-1">Weekly Special</p>
              <p className="text-secondary text-3xl font-extrabold">Save 2,500 JOD</p>
            </div>
          </div>
        </div>
      </section>

      <section className="py-section-gap px-margin-desktop max-w-screen-2xl mx-auto">
        <div className="flex justify-between items-end mb-12">
          <div>
            <h2 className="font-headline-lg text-headline-lg text-primary uppercase italic">Hot Offers <span className="text-secondary font-black">/ العروض الساخنة</span></h2>
            <div className="h-1 w-24 bg-secondary mt-2"></div>
          </div>
          <Link className="text-secondary font-bold flex items-center gap-1 hover:underline" href="/inventory">
            View All Deals <span className="material-symbols-outlined">chevron_right</span>
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter">
          {featured.map((v, i) => (
            <div key={v.id} className="group bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-shadow border border-outline-variant relative">
              <div className="absolute top-4 left-4 z-10">
                <span className="bg-secondary text-white px-3 py-1 font-bold text-xs rounded uppercase urgent-pulse">{i === 0 ? "Price Drop" : "Limited Stock"}</span>
              </div>
              <div className="h-64 overflow-hidden relative">
                <img className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" src={v.imageUrls[0] || ""} />
              </div>
              <div className="p-6">
                <div className="flex justify-between items-start mb-2">
                  <h3 className="text-xl font-bold text-primary">{v.make} {v.model}</h3>
                  <span className="text-outline text-sm">{v.mileage || "-"} KM</span>
                </div>
                <div className="flex items-center gap-4 text-sm text-on-surface-variant mb-6">
                  <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">local_gas_station</span> {v.fuelType || "Petrol"}</span>
                  <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">settings_suggest</span> {v.transmission || "Automatic"}</span>
                </div>
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-2xl font-black text-secondary">{formatPrice(v.price)}</p>
                  </div>
                  <Link className="bg-primary text-white p-3 rounded-lg hover:bg-secondary transition-colors inline-block" href={`/inventory/${v.slug || v.id}`}>
                    <span className="material-symbols-outlined">arrow_forward</span>
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-primary-container text-white py-section-gap relative overflow-hidden">
        <div className="absolute top-0 right-0 w-1/3 h-full bg-secondary/10 skew-x-12 translate-x-24"></div>
        <div className="max-w-screen-2xl mx-auto px-margin-desktop grid lg:grid-cols-2 gap-16 items-center relative z-10">
          <div>
            <h2 className="font-headline-lg text-headline-lg mb-6 uppercase">Estimate your installments <br/> <span className="text-secondary">in 10 seconds</span></h2>
            <p className="text-on-primary-container text-lg mb-10 max-w-md">
              Get an instant monthly payment estimate. No commitment required. Our finance partners offer the most competitive rates in Jordan.
            </p>
            <div className="grid grid-cols-2 gap-6">
              <div className="bg-white/5 border border-white/10 p-4 rounded-xl">
                <span className="material-symbols-outlined text-secondary text-3xl mb-2">speed</span>
                <p className="font-bold">Fast Approval</p>
                <p className="text-xs text-on-primary-container">Response within 24 hours</p>
              </div>
              <div className="bg-white/5 border border-white/10 p-4 rounded-xl">
                <span className="material-symbols-outlined text-secondary text-3xl mb-2">percent</span>
                <p className="font-bold">Low Interest</p>
                <p className="text-xs text-on-primary-container">Starting from 3.5% annually</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-2xl p-8 text-primary shadow-2xl">
            <div className="space-y-6">
              <div className="bg-surface-container-low p-6 rounded-xl border-l-4 border-secondary">
                <p className="text-sm font-bold text-outline uppercase mb-1">Flexible Options</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-black text-primary">Discover your rates</span>
                </div>
              </div>
              <Link className="w-full py-4 bg-secondary text-white font-bold rounded-lg uppercase italic tracking-widest hover:scale-95 transition-transform flex items-center justify-center gap-2" href="/finance">
                Apply for Finance Now
                <span className="material-symbols-outlined">arrow_forward_ios</span>
              </Link>
              <p className="text-[10px] text-outline text-center">*Terms and conditions apply. Rates may vary based on credit profile and bank approval.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-secondary py-16 px-margin-desktop text-white text-center">
        <h2 className="text-4xl md:text-5xl font-black uppercase italic mb-8">Ready to drive your dream car?</h2>
        <div className="flex flex-col md:flex-row gap-4 justify-center items-center">
          <Link className="w-full md:w-auto px-12 py-5 bg-primary text-white font-bold text-xl rounded-xl hover:bg-on-primary-fixed transition-all flex items-center justify-center gap-4" href="/inventory">
            <span className="material-symbols-outlined text-3xl">directions_car</span>
            VIEW ALL INVENTORY
          </Link>
          <Link className="w-full md:w-auto px-12 py-5 bg-whatsapp-green text-white font-bold text-xl rounded-xl hover:scale-105 transition-all flex items-center justify-center gap-4" href="/contact">
            <span className="material-symbols-outlined text-3xl">whatshot</span>
            CHAT WITH SALES
          </Link>
        </div>
      </section>
    </main>
  );
}

function KineticInventoryPage(props: ThemeProps) {
  const { vehicles, t, formatPrice } = props;
  return (
    <div className="max-w-screen-2xl mx-auto flex min-h-screen">
      <aside className="hidden lg:flex flex-col h-[calc(100vh-80px)] sticky top-20 w-80 bg-surface-container-lowest border-r border-outline-variant overflow-y-auto px-6 py-8 hide-scrollbar">
        <div className="flex flex-col gap-8">
          <div className="relative">
            <input className="w-full pl-10 pr-4 py-3 bg-surface-container rounded-xl border-none focus:ring-2 focus:ring-luxury-gold transition-all" placeholder="Search..." type="text"/>
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span>
          </div>
          <div className="flex flex-col gap-6">
            <div>
              <h3 className="font-headline-lg text-lg mb-4 flex items-center gap-2">
                <span className="material-symbols-outlined text-luxury-gold">filter_list</span>
                Filters
              </h3>
              <div className="text-sm text-outline">Coming soon</div>
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
        {vehicles.length === 0 ? (
          <div className="text-center py-20 text-on-surface-variant">{t.noVehicles}</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
            {vehicles.map(v => (
              <Link key={v.id} href={`/inventory/${v.slug || v.id}`} className="group bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 transform hover:-translate-y-1 border border-outline-variant/30 flex flex-col">
                <div className="relative aspect-[16/9] overflow-hidden">
                  <div className="absolute inset-0 bg-cover bg-center transition-transform duration-700 group-hover:scale-110" style={{ backgroundImage: `url('${v.imageUrls[0] || ""}')` }}></div>
                  <div className="absolute top-4 left-4 flex gap-2">
                    <span className="bg-secondary text-white px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider">{v.status}</span>
                  </div>
                </div>
                <div className="p-6 flex flex-col flex-1">
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="font-headline-lg text-xl text-primary">{v.year} {v.make} {v.model}</h3>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mb-6">
                    <div className="flex flex-col items-center p-2 bg-surface-container-low rounded-lg">
                      <span className="material-symbols-outlined text-luxury-gold text-lg">speed</span>
                      <span className="text-[10px] font-bold text-outline">{v.mileage ? `${v.mileage} KM` : "-"}</span>
                    </div>
                    <div className="flex flex-col items-center p-2 bg-surface-container-low rounded-lg">
                      <span className="material-symbols-outlined text-luxury-gold text-lg">local_gas_station</span>
                      <span className="text-[10px] font-bold text-outline">{v.fuelType || "-"}</span>
                    </div>
                    <div className="flex flex-col items-center p-2 bg-surface-container-low rounded-lg">
                      <span className="material-symbols-outlined text-luxury-gold text-lg">settings_input_component</span>
                      <span className="text-[10px] font-bold text-outline">{v.transmission || "-"}</span>
                    </div>
                  </div>
                  <div className="mt-auto">
                    <div className="flex justify-between items-end mb-4">
                      <div>
                        <p className="text-2xl font-extrabold text-primary">{formatPrice(v.price)}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="py-3 px-4 bg-primary text-white text-center rounded-lg font-bold text-sm hover:bg-primary/90 transition-colors">View Details</div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function KineticVehicleDetail(props: ThemeProps & { vehicle: PublicVehicle }) {
  const { vehicle, t, formatPrice, form, setForm, isSubmitting, formSuccess, onSubmit, turnstileSiteKey, setSelectedVehicleId } = props;
  return (
    <main className="max-w-screen-2xl mx-auto px-4 lg:px-gutter py-8">
      <nav className="mb-6 flex items-center gap-2 text-on-surface-variant font-label-caps text-label-caps">
        <Link className="hover:text-primary" href="/">{t.nav.home}</Link>
        <span className="material-symbols-outlined text-sm">chevron_right</span>
        <Link className="hover:text-primary" href="/inventory">{t.nav.inventory}</Link>
        <span className="material-symbols-outlined text-sm">chevron_right</span>
        <span className="text-primary font-bold">{vehicle.make} {vehicle.model}</span>
      </nav>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
        <div className="lg:col-span-8 space-y-8">
          <section className="space-y-4">
            <div className="relative group aspect-[16/9] overflow-hidden rounded-xl bg-surface-container shadow-lg">
              <img className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" src={vehicle.imageUrls[0] || ""} />
              <div className="absolute bottom-4 right-4 bg-primary/80 text-white px-4 py-2 rounded-full backdrop-blur-md flex items-center gap-2 font-label-caps">
                <span className="material-symbols-outlined text-base">photo_camera</span>
                1/{vehicle.imageUrls.length || 1} Photos
              </div>
            </div>
            {vehicle.imageUrls.length > 1 && (
              <div className="flex gap-4 overflow-x-auto no-scrollbar pb-2">
                {vehicle.imageUrls.slice(1).map((url, i) => (
                  <div key={i} className="min-w-[140px] aspect-video rounded-lg overflow-hidden border border-outline-variant hover:border-secondary transition-colors cursor-pointer">
                    <img className="w-full h-full object-cover" src={url} />
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-outline-variant pb-8">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="bg-secondary-fixed text-on-secondary-fixed font-label-caps text-label-caps px-3 py-1 rounded-full">{vehicle.status}</span>
              </div>
              <h1 className="font-headline-lg text-headline-lg text-primary mb-1">{vehicle.year} {vehicle.make} {vehicle.model}</h1>
            </div>
            <div className="text-left md:text-right">
              <p className="font-display-luxury text-3xl text-primary">{formatPrice(vehicle.price)}</p>
            </div>
          </section>
          <section>
            <h2 className="font-headline-lg text-xl mb-6">Key Specifications</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              <div className="bg-surface-container-low p-4 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-primary shadow-sm"><span className="material-symbols-outlined">speed</span></div>
                <div><p className="text-on-surface-variant text-xs uppercase tracking-wider font-semibold">{t.mileage}</p><p className="font-bold text-sm">{vehicle.mileage ? `${vehicle.mileage} KM` : "-"}</p></div>
              </div>
              <div className="bg-surface-container-low p-4 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-primary shadow-sm"><span className="material-symbols-outlined">palette</span></div>
                <div><p className="text-on-surface-variant text-xs uppercase tracking-wider font-semibold">{t.color}</p><p className="font-bold text-sm">{vehicle.exteriorColor || "-"}</p></div>
              </div>
              <div className="bg-surface-container-low p-4 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-primary shadow-sm"><span className="material-symbols-outlined">gas_meter</span></div>
                <div><p className="text-on-surface-variant text-xs uppercase tracking-wider font-semibold">{t.fuelType}</p><p className="font-bold text-sm">{vehicle.fuelType || "-"}</p></div>
              </div>
              <div className="bg-surface-container-low p-4 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-primary shadow-sm"><span className="material-symbols-outlined">settings</span></div>
                <div><p className="text-on-surface-variant text-xs uppercase tracking-wider font-semibold">{t.transmission}</p><p className="font-bold text-sm">{vehicle.transmission || "-"}</p></div>
              </div>
              {vehicle.trim && (
                <div className="bg-surface-container-low p-4 rounded-xl flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-primary shadow-sm"><span className="material-symbols-outlined">star</span></div>
                  <div><p className="text-on-surface-variant text-xs uppercase tracking-wider font-semibold">{t.trim}</p><p className="font-bold text-sm">{vehicle.trim}</p></div>
                </div>
              )}
            </div>
          </section>
        </div>
        <div className="lg:col-span-4">
          <div className="bg-surface-container-lowest p-6 rounded-xl border border-outline-variant/30 sticky top-28 shadow-lg">
            <h3 className="font-headline-lg text-xl mb-4">{t.askAbout}</h3>
            {formSuccess === "vehicle_inquiry" ? (
              <div className="p-4 bg-secondary-fixed text-on-secondary-fixed rounded-lg">
                <h4 className="font-bold">{t.thankYou}</h4>
                <p>{t.messageReceived}</p>
              </div>
            ) : (
              <form onSubmit={e => { setSelectedVehicleId(vehicle.id); onSubmit(e, "vehicle_inquiry"); }} className="space-y-4">
                <div>
                   <label className="block font-label-caps text-xs mb-1">{t.placeholderFirstName}</label>
                   <input name="firstName" value={form.firstName} onChange={e => setForm({...form, firstName: e.target.value})} className="w-full border border-outline-variant rounded p-2 outline-none focus:border-secondary" required />
                </div>
                <div>
                   <label className="block font-label-caps text-xs mb-1">{t.placeholderLastName}</label>
                   <input name="lastName" value={form.lastName} onChange={e => setForm({...form, lastName: e.target.value})} className="w-full border border-outline-variant rounded p-2 outline-none focus:border-secondary" />
                </div>
                <div>
                   <label className="block font-label-caps text-xs mb-1">{t.placeholderPhone}</label>
                   <input name="phone" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} className="w-full border border-outline-variant rounded p-2 outline-none focus:border-secondary" required />
                </div>
                <TurnstileWidget siteKey={turnstileSiteKey} />
                <button type="submit" disabled={isSubmitting} className="w-full py-3 bg-primary text-white rounded font-bold hover:bg-primary/90 transition-colors">
                  {t.sendInquiry}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function KineticFinancePage(props: ThemeProps) {
  const { site, t, form, setForm, isSubmitting, formSuccess, onSubmit, turnstileSiteKey } = props;
  return (
    <main className="max-w-screen-2xl mx-auto px-margin-desktop py-12 lg:py-20">
      <div className="mb-12 border-l-4 border-secondary pl-6">
        <h1 className="font-headline-lg text-headline-lg text-primary mb-2 uppercase tracking-tight">{t.financeTitle}</h1>
        <h2 className="font-arabic-ui text-arabic-ui text-on-surface-variant">{site.legal.financingDisclaimer}</h2>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter items-start">
        <section className="lg:col-span-7 space-y-6">
          <div className="bg-surface-container-low p-8 rounded-xl border border-outline-variant/30">
            <div className="flex items-center gap-3 mb-6">
              <span className="material-symbols-outlined text-primary">verified_user</span>
              <h3 className="font-headline-lg text-headline-lg text-primary text-xl">Quick Eligibility Check</h3>
            </div>
            {formSuccess === "financing" ? (
              <div className="p-4 bg-secondary-fixed text-on-secondary-fixed rounded-lg">
                <h4 className="font-bold">{t.thankYou}</h4>
                <p>{t.messageReceived}</p>
              </div>
            ) : (
              <form onSubmit={(e) => onSubmit(e, "financing")} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block font-label-caps text-label-caps text-on-surface-variant mb-2">{t.placeholderFirstName}</label>
                    <input name="firstName" value={form.firstName} onChange={e => setForm({...form, firstName: e.target.value})} className="w-full bg-white border border-outline-variant rounded-lg px-4 py-3 focus:ring-2 focus:ring-secondary focus:border-transparent outline-none" required />
                  </div>
                  <div>
                    <label className="block font-label-caps text-label-caps text-on-surface-variant mb-2">{t.placeholderLastName}</label>
                    <input name="lastName" value={form.lastName} onChange={e => setForm({...form, lastName: e.target.value})} className="w-full bg-white border border-outline-variant rounded-lg px-4 py-3 focus:ring-2 focus:ring-secondary focus:border-transparent outline-none" required />
                  </div>
                  <div>
                    <label className="block font-label-caps text-label-caps text-on-surface-variant mb-2">{t.placeholderPhone}</label>
                    <input name="phone" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} className="w-full bg-white border border-outline-variant rounded-lg px-4 py-3 focus:ring-2 focus:ring-secondary focus:border-transparent outline-none" required />
                  </div>
                  <div>
                    <label className="block font-label-caps text-label-caps text-on-surface-variant mb-2">{t.placeholderEmail}</label>
                    <input type="email" name="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} className="w-full bg-white border border-outline-variant rounded-lg px-4 py-3 focus:ring-2 focus:ring-secondary focus:border-transparent outline-none" />
                  </div>
                </div>
                <TurnstileWidget siteKey={turnstileSiteKey} />
                <button type="submit" disabled={isSubmitting} className="w-full py-4 bg-primary text-white rounded-xl font-bold hover:bg-primary/90 transition-colors shadow-lg active:scale-95 duration-200">
                  {t.requestFinancing}
                </button>
              </form>
            )}
          </div>
        </section>
        <aside className="lg:col-span-5 sticky top-28 space-y-6">
          <div className="bg-primary text-white p-8 rounded-xl shadow-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-secondary opacity-20 blur-3xl rounded-full -mr-16 -mt-16"></div>
            <h4 className="font-label-caps text-label-caps text-primary-fixed mb-6 uppercase">Estimated Monthly Installment</h4>
            <div className="flex items-baseline gap-2 mb-8">
              <span className="font-headline-lg text-5xl font-extrabold text-white">---</span>
              <span className="font-headline-lg text-xl text-primary-fixed">JOD/mo</span>
            </div>
            <div className="space-y-4 pt-6 border-t border-white/10 text-on-primary-container">
               {t.financeTitle}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function KineticBranchesPage(props: ThemeProps) {
  return <div className="kh-branches-placeholder">Branches Placeholder</div>;
}

function KineticContactPage(props: ThemeProps) {
  return <div className="kh-contact-placeholder">Contact Placeholder</div>;
}

function KineticLegalPage(props: ThemeProps) {
  return <div className="kh-legal-placeholder">Legal Placeholder</div>;
}

// ----------------------------------------------------------------------------
// Styles
// ----------------------------------------------------------------------------

function KineticGlobalStyles() {
  return (
    <style jsx global>{`
      /* Root variables for Kinetic Horizon will go here */
      .kh-shell {
        font-family: 'Inter', sans-serif;
      }
    `}</style>
  );
}
