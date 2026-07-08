"use client";

import Link from "next/link";
import type { ThemeProps } from "./theme-props";
import { KineticBrand, KineticVehicleImage, useKineticStrings, waLink } from "./kinetic-shared";

export function KineticLuxuryHome(props: ThemeProps) {
  const { site, lang, showLangToggle, isPreviewMode, onToggleLang, t, formatPrice, featuredVehicles, dir } = props;
  const profile = site.profile;
  const cars = featuredVehicles.slice(0, 3);
  const k = useKineticStrings(lang);

  return (
    <div className="theme-kinetic bg-background text-on-background selection:bg-luxury-gold selection:text-white" dir={dir}>
      {isPreviewMode && (
        <div className="bg-secondary px-4 py-2 text-center text-sm font-bold text-white">{t.previewBanner}</div>
      )}
      <nav className="bg-surface-container-low dark:bg-surface-dim backdrop-blur-xl docked full-width top-0 sticky z-50 shadow-sm">
        <div className="flex justify-between items-center px-gutter py-5 w-full max-w-screen-2xl mx-auto">
          <div className="flex items-center gap-10">
            <Link href="/">
              <KineticBrand profile={profile} size="lg" />
            </Link>
            <div className="hidden md:flex gap-8 items-center">
              <Link className="font-label-caps text-label-caps text-secondary dark:text-secondary-fixed-dim border-b-2 border-secondary font-bold pb-1" href="/inventory">{t.nav.inventory}</Link>
              <Link className="font-label-caps text-label-caps text-on-surface-variant dark:text-outline-variant hover:text-primary dark:hover:text-primary-fixed-dim transition-colors" href="/finance">{t.nav.finance}</Link>
              <Link className="font-label-caps text-label-caps text-on-surface-variant dark:text-outline-variant hover:text-primary dark:hover:text-primary-fixed-dim transition-colors" href="/contact">{t.nav.contact}</Link>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {profile.phone && (
              <a
                className="hidden lg:flex items-center gap-2 px-4 py-2 rounded-full border border-whatsapp-green text-whatsapp-green font-label-caps text-label-caps hover:bg-whatsapp-green hover:text-white transition-all"
                href={waLink(profile.phone, `Hi ${profile.dealershipName}, I'd like to know more about your inventory.`)}
                target="_blank" rel="noopener noreferrer"
              >
                <span className="material-symbols-outlined text-[18px]">whatshot</span>
                {k.whatsappSupport}
              </a>
            )}
            {showLangToggle && (
              <button onClick={onToggleLang} className="flex items-center gap-2 cursor-pointer">
                <span className="material-symbols-outlined p-2 text-on-surface-variant hover:bg-surface-container-highest/50 rounded-full transition-colors">language</span>
                <span className="font-arabic-ui text-arabic-ui text-primary">{lang === "en" ? "العربية" : "English"}</span>
              </button>
            )}
          </div>
        </div>
      </nav>

      <main>
        <section className="relative h-screen w-full overflow-hidden">
          <div className="absolute inset-0 bg-primary/40 z-10" />
          <div className="absolute inset-0 w-full h-full">
            <div
              className="w-full h-full bg-cover bg-center transition-transform duration-1000 scale-105"
              style={{ backgroundImage: "url('https://lh3.googleusercontent.com/aida-public/AB6AXuBaeBg7I5oQC5iPs3oeViaCgbyOttAAxVOWW68dpG5fFKN-sFW366E2rcwrWFK7YcTWO9AMVyUJOVT14rTMfdCAZz34IK_Ytq1P0ML1zmeRdNMtZvopTYsOAC2Vb0H5WKoVPoJztGx1641T_w87supNsYVrd0Wv_DTFyVZjR6mG69fwPXo8ssqhDtuNYC_5uppZ71xuodPp1VJgy5sUDaPAfAG0McCSOgTW2Q6a41Le-xlqyp5wdoO18Y-3cB8Ba3nb2-dXD5yjuOoP')" }}
            />
          </div>
          <div className="relative z-20 h-full flex flex-col justify-center items-center text-center px-margin-mobile md:px-margin-desktop">
            <div className="max-w-4xl space-y-6">
              <h1 className="font-display-luxury text-white text-[48px] md:text-[80px] leading-tight">{profile.heroTitle ?? k.luxuryHeroTitle}</h1>
              <p className="font-body-md text-white/90 text-lg md:text-xl max-w-2xl mx-auto opacity-80">
                {profile.heroSubtitle ?? k.luxuryHeroSubtitle}
              </p>
              <div className="flex flex-col md:flex-row gap-4 justify-center pt-8">
                <Link className="px-8 py-4 bg-luxury-gold text-white font-label-caps text-label-caps rounded-sm hover:bg-jod-gold transition-all transform hover:-translate-y-1 shadow-lg flex items-center justify-center gap-2" href="/inventory">
                  {k.luxuryBrowseCollection}
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </Link>
                <Link className="px-8 py-4 bg-white/10 backdrop-blur-md border border-white/30 text-white font-label-caps text-label-caps rounded-sm hover:bg-white hover:text-primary transition-all flex items-center justify-center gap-2" href="/contact">
                  {k.luxuryPrivateVisit}
                  <span className="material-symbols-outlined text-[16px]">event</span>
                </Link>
              </div>
            </div>
          </div>
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 animate-bounce">
            <span className="material-symbols-outlined text-white/50 text-4xl">expand_more</span>
          </div>
        </section>

        <section className="bg-primary py-12 border-y border-luxury-gold/20">
          <div className="max-w-screen-2xl mx-auto px-gutter grid grid-cols-2 md:grid-cols-4 gap-8">
            {[
              ["15+", k.luxuryStatHeritage],
              ["500+", k.luxuryStatDeliveries],
              ["24h", k.luxuryStatSourcing],
              ["100%", k.luxuryStatService],
            ].map(([value, label]) => (
              <div className="text-center" key={label}>
                <div className="font-display-luxury text-luxury-gold text-4xl mb-1">{value}</div>
                <div className="font-label-caps text-on-primary-container text-xs tracking-widest uppercase">{label}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="py-section-gap bg-surface-container-lowest">
          <div className="max-w-screen-2xl mx-auto px-gutter">
            <div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6">
              <div>
                <span className="font-label-caps text-luxury-gold text-sm tracking-widest uppercase">{k.featuredInventory}</span>
                <h2 className="font-display-luxury text-primary text-headline-lg mt-2">{k.curatedMasterpieces}</h2>
              </div>
              <Link className="font-label-caps text-primary border-b border-primary pb-1 hover:text-luxury-gold hover:border-luxury-gold transition-colors" href="/inventory">{k.viewAllVehicles}</Link>
            </div>
            {cars.length ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {cars.map((v) => (
                  <Link key={v.id} href={`/inventory/${v.slug}`} className="group cursor-pointer car-card-hover block">
                    <div className="relative aspect-[16/10] overflow-hidden rounded-sm bg-surface-container">
                      <KineticVehicleImage vehicle={v} className="car-image w-full h-full object-cover transition-transform duration-500" />
                      <div className="absolute top-4 left-4">
                        <span className="bg-primary text-white font-label-caps text-[10px] px-3 py-1 tracking-tighter rounded-full uppercase">{v.status}</span>
                      </div>
                    </div>
                    <div className="mt-6 space-y-2">
                      <div className="flex justify-between items-start">
                        <h3 className="font-headline-lg text-xl text-primary">{v.make} {v.model}</h3>
                        <span className="font-headline-lg text-luxury-gold text-xl">{formatPrice(v.price)}</span>
                      </div>
                      <p className="font-body-md text-on-surface-variant text-sm">
                        {v.year}
                        {v.mileage != null ? ` • ${v.mileage.toLocaleString()} km` : ""}
                        {v.trim ? ` • ${v.trim}` : ""}
                      </p>
                      <div className="flex gap-4 pt-2">
                        <span className="flex-1 py-3 border border-outline text-primary font-label-caps text-xs group-hover:bg-primary group-hover:text-white transition-all uppercase text-center">{t.askAbout}</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="border-2 border-dashed border-outline-variant rounded-sm p-16 text-center text-on-surface-variant">{t.noVehicles}</div>
            )}
          </div>
        </section>

        <section className="relative py-section-gap bg-primary overflow-hidden">
          <div className="relative z-10 max-w-screen-2xl mx-auto px-gutter">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
              <div className="relative">
                <div className="aspect-square rounded-sm overflow-hidden border border-luxury-gold/30 p-4">
                  <div
                    className="w-full h-full bg-cover bg-center"
                    style={{ backgroundImage: "url('https://lh3.googleusercontent.com/aida-public/AB6AXuBd5Baj3AZCFWd5QddePY8xBqIF9sBxXj-86Nx-EK0yIhaIbJpyMJBnVLtO6tXk05g3Ns8YeFNFCEaqqU3HmUM9BTnEWDZOx-qCRLZFA5gVp9Uc_MssnlG9JuGTrmHGMA5zxCcAuZ_GYTPylTSuiWo27F9CzF06bQh5NzEnv712eM3tiXMccmBKoFqZGgBcIbJh-UaiK-CHaB8AizKxE43xV2yfm4n1qOwyVcIiJIVj54fFiL20bero-5ScZYEfV90fo_HoIQGPE7O-')" }}
                  />
                </div>
                <div className="absolute -bottom-8 -right-8 bg-luxury-gold p-8 rounded-sm shadow-2xl hidden md:block">
                  <div className="font-display-luxury text-white text-3xl">{k.establishedBadge}</div>
                  <div className="font-label-caps text-white/80 text-[10px] tracking-widest uppercase">{k.trustedExcellence}</div>
                </div>
              </div>
              <div className="space-y-8">
                <span className="font-label-caps text-luxury-gold text-sm tracking-widest uppercase">{k.theStandard} — {profile.dealershipName}</span>
                <h2 className="font-display-luxury text-white text-[40px] md:text-[56px] leading-tight">{k.beyondAcquisition}</h2>
                <div className="space-y-6">
                  {[
                    ["verified_user", k.whiteGloveTitle, k.whiteGloveDesc],
                    ["public", k.intlSourcingTitle, k.intlSourcingDesc],
                    ["history_edu", k.legacyTrustTitle, k.legacyTrustDesc],
                  ].map(([icon, title, body]) => (
                    <div className="flex gap-6" key={title}>
                      <span className="material-symbols-outlined text-luxury-gold text-3xl">{icon}</span>
                      <div>
                        <h4 className="font-headline-lg text-white text-xl mb-2">{title}</h4>
                        <p className="font-body-md text-on-primary-container">{body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="py-24 bg-surface-container">
          <div className="max-w-4xl mx-auto px-margin-mobile text-center space-y-8">
            <h2 className="font-display-luxury text-primary text-4xl">{k.privateConsultationTitle}</h2>
            <p className="font-body-md text-on-surface-variant text-lg">{k.privateConsultationDesc}</p>
            <div className="flex flex-col md:flex-row gap-6 justify-center">
              {profile.phone && (
                <a className="flex items-center justify-center gap-3 px-10 py-5 bg-whatsapp-green text-white rounded-full font-label-caps text-sm hover:opacity-90 transition-all shadow-lg" href={waLink(profile.phone, `Hi ${profile.dealershipName}, I'd like a private consultation.`)} target="_blank" rel="noopener noreferrer">
                  <span className="material-symbols-outlined">whatshot</span>
                  {k.connectWhatsapp}
                </a>
              )}
              <Link className="px-10 py-5 bg-primary text-white rounded-full font-label-caps text-sm hover:bg-luxury-gold transition-all shadow-lg text-center" href="/contact">
                {k.requestCallBack}
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-primary dark:bg-on-primary-fixed w-full py-section-gap">
        <div className="w-full grid grid-cols-1 md:grid-cols-4 gap-gutter px-margin-desktop max-w-screen-2xl mx-auto">
          <div className="space-y-6">
            <div className="font-display-luxury text-display-luxury text-luxury-gold">{profile.dealershipName}</div>
            <p className="font-body-md text-on-primary-container text-sm leading-relaxed">{profile.slogan ?? k.luxuryFooterSloganDefault}</p>
          </div>
          <div className="space-y-6">
            <h4 className="font-label-caps text-white uppercase tracking-widest text-sm">{k.footerExplore}</h4>
            <ul className="space-y-3 font-body-md text-on-primary-container">
              <li><Link className="hover:text-white transition-colors" href="/inventory">{k.footerOurInventory}</Link></li>
              <li><Link className="hover:text-white transition-colors" href="/contact">{k.footerLuxuryConcierge}</Link></li>
              <li><Link className="hover:text-white transition-colors" href="/finance">{k.footerFinanceOptions}</Link></li>
              <li><Link className="hover:text-white transition-colors" href="/branches">{k.footerShowroomLocation}</Link></li>
            </ul>
          </div>
          <div className="space-y-6">
            <h4 className="font-label-caps text-white uppercase tracking-widest text-sm">{k.footerCompany}</h4>
            <ul className="space-y-3 font-body-md text-on-primary-container">
              <li><Link className="hover:text-white transition-colors" href="/privacy">{t.footerPrivacy}</Link></li>
              <li><Link className="hover:text-white transition-colors" href="/terms">{t.footerTerms}</Link></li>
              <li><Link className="hover:text-white transition-colors" href="/data-deletion">{t.footerDataDeletion}</Link></li>
            </ul>
          </div>
          <div className="space-y-6">
            <h4 className="font-label-caps text-white uppercase tracking-widest text-sm">{k.footerShowroom}</h4>
            <div className="font-body-md text-on-primary-container text-sm space-y-4">
              {profile.address && (
                <p className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-luxury-gold text-lg">location_on</span>
                  {profile.address.startsWith("http") ? (
                    <a href={profile.address} target="_blank" rel="noopener noreferrer" className="hover:underline">{t.viewOnMap}</a>
                  ) : (
                    profile.address
                  )}
                </p>
              )}
              {profile.phones.map((phone) => (
                <p key={phone} className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-luxury-gold text-lg">phone</span>
                  <a href={`tel:${phone}`} className="hover:underline">{phone}</a>
                </p>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-20 border-t border-white/10 pt-8 text-center px-gutter">
          <p className="font-body-md text-on-primary-container text-xs opacity-60">© {new Date().getFullYear()} {profile.dealershipName}. {k.allRightsReserved}.</p>
        </div>
      </footer>

      {profile.phone && (
        <a
          className="fixed bottom-8 right-8 z-50 w-16 h-16 bg-whatsapp-green rounded-full flex items-center justify-center text-white shadow-2xl hover:scale-110 active:scale-95 transition-transform md:hidden"
          href={waLink(profile.phone, `Hi ${profile.dealershipName}, I'd like to know more about your inventory.`)}
          target="_blank" rel="noopener noreferrer"
        >
          <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>whatshot</span>
        </a>
      )}
    </div>
  );
}
