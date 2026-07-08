"use client";

import { useState } from "react";
import Link from "next/link";
import type { ThemeProps } from "./theme-props";
import { KineticVehicleImage, waLink } from "./kinetic-shared";

export function KineticSalesHome(props: ThemeProps) {
  const { site, lang, showLangToggle, isPreviewMode, onToggleLang, t, formatPrice, featuredVehicles, dir } = props;
  const profile = site.profile;
  const deals = featuredVehicles.slice(0, 3);

  const [price, setPrice] = useState(25000);
  const [downPercent, setDownPercent] = useState(20);
  const monthlyRate = 0.045 / 12;
  const termMonths = 60;
  const loanAmount = price * (1 - downPercent / 100);
  const monthly = Math.round(
    (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1)
  );

  return (
    <div className="theme-kinetic bg-background text-on-background font-body-md selection:bg-secondary selection:text-white" dir={dir}>
      {isPreviewMode && (
        <div className="bg-secondary px-4 py-2 text-center text-sm font-bold text-white">{t.previewBanner}</div>
      )}
      <nav className="bg-surface/90 backdrop-blur-xl docked full-width top-0 sticky z-50 shadow-sm">
        <div className="flex justify-between items-center px-gutter py-4 w-full max-w-screen-2xl mx-auto">
          <div className="flex items-center gap-8">
            <Link className="font-display-luxury text-display-luxury text-luxury-gold" href="/">{profile.dealershipName}</Link>
            <div className="hidden lg:flex items-center gap-6">
              <Link className="text-secondary border-b-2 border-secondary font-bold pb-1 font-label-caps text-label-caps" href="/inventory">{t.nav.inventory}</Link>
              <Link className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="/finance">{t.nav.finance}</Link>
              <Link className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="/contact">{t.nav.contact}</Link>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {profile.phone && (
              <a className="hidden md:flex items-center gap-2 px-4 py-2 bg-whatsapp-green text-white rounded-lg font-bold hover:scale-95 transition-transform active:scale-90"
                href={waLink(profile.phone, `Hi ${profile.dealershipName}, I'd like to know more about your cars.`)} target="_blank" rel="noopener noreferrer">
                <span className="material-symbols-outlined">whatshot</span>
                <span className="font-arabic-ui text-arabic-ui">WhatsApp Support</span>
              </a>
            )}
            {showLangToggle && (
              <button onClick={onToggleLang} className="flex items-center gap-3">
                <span className="material-symbols-outlined text-primary cursor-pointer p-2 hover:bg-surface-container-highest/50 rounded-full transition-colors">language</span>
                <span className="font-arabic-ui text-arabic-ui text-primary font-bold">{lang === "en" ? "العربية" : "English"}</span>
              </button>
            )}
          </div>
        </div>
      </nav>

      <main>
        <section className="relative min-h-[700px] lg:min-h-[870px] flex items-center overflow-hidden sales-gradient text-white">
          <div className="absolute inset-0 z-0 bg-gradient-to-r from-primary via-primary/80 to-transparent" />
          <div className="relative z-10 w-full max-w-screen-2xl mx-auto px-margin-desktop py-section-gap grid lg:grid-cols-2 gap-12 items-center">
            <div className="space-y-8">
              <div className="inline-flex items-center gap-2 px-4 py-1 bg-secondary rounded-full">
                <span className="animate-ping h-2 w-2 rounded-full bg-white opacity-75" />
                <span className="font-label-caps text-label-caps uppercase tracking-widest text-white">{deals.length}+ Cars Available</span>
              </div>
              <h1 className="font-headline-lg text-[64px] leading-tight font-extrabold uppercase italic tracking-tighter">
                {profile.heroTitle ?? <>Find Your Next <br /><span className="text-secondary">Car Today</span></>}
              </h1>
              <p className="text-xl text-primary-fixed max-w-lg font-body-md">
                {profile.heroSubtitle ?? "The largest selection of premium used and new vehicles. Quality inspected. Finance approved. Ready for delivery."}
              </p>
              <div className="flex flex-col md:flex-row gap-4">
                <Link className="w-full md:w-auto px-8 py-4 border-2 border-white text-white font-bold rounded-lg hover:bg-white hover:text-primary transition-all text-center" href="/inventory">
                  View All Inventory
                </Link>
                <Link className="w-full md:w-auto px-8 py-4 bg-white/10 backdrop-blur-md text-white font-bold rounded-lg hover:bg-white/20 transition-all flex items-center justify-center gap-2" href="/finance">
                  <span className="material-symbols-outlined">calculate</span>
                  Calculate Monthly Payment
                </Link>
              </div>
            </div>
            <div className="hidden lg:block relative group">
              <div className="absolute -inset-4 bg-secondary/20 blur-3xl rounded-full group-hover:bg-secondary/40 transition-colors duration-700" />
              <img
                className="relative z-10 w-full h-auto object-cover rounded-2xl shadow-2xl transform group-hover:scale-[1.02] transition-transform duration-500"
                alt=""
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuCISsNZv4p3s3nQX53EvqatD2UUtA1HnS1SuZamDkx6j07K8q3-_DmI8GsqbuwHJI70v7hECzMMo3fSJOhNX1uweay5guuGrNaEO2Qw1JV31BVKAL3nTnwKYlTDNSjJ3hK7VsxKiIBQYGy-GyMO1ViBNU75QYAVJdJJ9FqqvkfTmZekueid1yGHMjra7f_M2AFez-flbuL-CGhUIB9AxuUoXOeNfSUhtGkDkAZ_EkbrVq54BY9d1V9Q2jyBhRyKhLd_IkYbpLYZ-aw9"
              />
              <div className="absolute bottom-6 right-6 z-20 glass-card p-6 rounded-xl border border-white/20">
                <p className="text-primary font-bold text-lg mb-1">Weekly Special</p>
                <p className="text-secondary text-3xl font-extrabold">Ask About Our Deals</p>
              </div>
            </div>
          </div>
        </section>

        <section className="py-section-gap px-margin-desktop max-w-screen-2xl mx-auto">
          <div className="flex justify-between items-end mb-12">
            <div>
              <h2 className="font-headline-lg text-headline-lg text-primary uppercase italic">Hot Offers</h2>
              <div className="h-1 w-24 bg-secondary mt-2" />
            </div>
            <Link className="text-secondary font-bold flex items-center gap-1 hover:underline" href="/inventory">
              View All <span className="material-symbols-outlined">chevron_right</span>
            </Link>
          </div>
          {deals.length ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter">
              {deals.map((v) => (
                <Link key={v.id} href={`/inventory/${v.slug}`} className="group bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-shadow border border-outline-variant relative block">
                  <div className="absolute top-4 left-4 z-10">
                    <span className="bg-secondary text-white px-3 py-1 font-bold text-xs rounded uppercase">{v.status}</span>
                  </div>
                  <div className="h-64 overflow-hidden relative">
                    <KineticVehicleImage vehicle={v} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" />
                  </div>
                  <div className="p-6">
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="text-xl font-bold text-primary">{v.year} {v.make} {v.model}</h3>
                      {v.mileage != null && <span className="text-outline text-sm">{v.mileage.toLocaleString()} KM</span>}
                    </div>
                    <div className="flex items-center gap-4 text-sm text-on-surface-variant mb-6">
                      {v.fuelType && <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">local_gas_station</span>{v.fuelType}</span>}
                      {v.transmission && <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">settings_suggest</span>{v.transmission}</span>}
                    </div>
                    <div className="flex items-end justify-between">
                      <p className="text-2xl font-black text-secondary">{formatPrice(v.price)}</p>
                      <span className="bg-primary text-white p-3 rounded-lg group-hover:bg-secondary transition-colors">
                        <span className="material-symbols-outlined">arrow_forward</span>
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="border-2 border-dashed border-outline-variant rounded-xl p-16 text-center text-on-surface-variant">{t.noVehicles}</div>
          )}
        </section>

        <section className="bg-primary-container text-white py-section-gap relative overflow-hidden">
          <div className="absolute top-0 right-0 w-1/3 h-full bg-secondary/10 skew-x-12 translate-x-24" />
          <div className="max-w-screen-2xl mx-auto px-margin-desktop grid lg:grid-cols-2 gap-16 items-center relative z-10">
            <div>
              <h2 className="font-headline-lg text-headline-lg mb-6 uppercase">Estimate your installments <br /> <span className="text-secondary">in 10 seconds</span></h2>
              <p className="text-on-primary-container text-lg mb-10 max-w-md">
                Get an instant monthly payment estimate. No commitment required.
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
                  <p className="text-xs text-on-primary-container">Starting from 4.5% annually</p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-2xl p-8 text-primary shadow-2xl">
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-bold uppercase tracking-wider text-outline mb-2">Car Price (JOD)</label>
                  <input className="w-full accent-secondary" max={100000} min={5000} step={500} type="range" value={price} onChange={(e) => setPrice(Number(e.target.value))} />
                  <div className="flex justify-between mt-2 font-black text-xl">
                    <span>{price.toLocaleString()} JOD</span>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-bold uppercase tracking-wider text-outline mb-2">Down Payment (%)</label>
                  <div className="flex gap-2">
                    {[20, 30, 50].map((pct) => (
                      <button
                        key={pct}
                        onClick={() => setDownPercent(pct)}
                        className={`flex-1 py-2 border-2 rounded-lg font-bold transition-colors ${
                          downPercent === pct ? "border-secondary bg-secondary text-white" : "border-outline-variant hover:border-secondary"
                        }`}
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>
                </div>
                <div className="bg-surface-container-low p-6 rounded-xl border-l-4 border-secondary">
                  <p className="text-sm font-bold text-outline uppercase mb-1">Estimated Monthly Payment</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-black text-primary">{monthly.toLocaleString()} JOD</span>
                    <span className="text-on-surface-variant text-sm">/ month*</span>
                  </div>
                </div>
                <Link href="/finance" className="w-full py-4 bg-secondary text-white font-bold rounded-lg uppercase italic tracking-widest hover:scale-95 transition-transform flex items-center justify-center gap-2">
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
            {profile.phone && (
              <a className="w-full md:w-auto px-12 py-5 bg-whatsapp-green text-white font-bold text-xl rounded-xl hover:scale-105 transition-all flex items-center justify-center gap-4"
                href={waLink(profile.phone, `Hi ${profile.dealershipName}, I'd like to chat with sales.`)} target="_blank" rel="noopener noreferrer">
                <span className="material-symbols-outlined text-3xl">whatshot</span>
                CHAT WITH SALES
              </a>
            )}
          </div>
        </section>
      </main>

      <footer className="bg-primary py-section-gap">
        <div className="w-full max-w-screen-2xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-gutter px-margin-desktop text-on-primary">
          <div className="space-y-6">
            <span className="font-display-luxury text-display-luxury text-luxury-gold">{profile.dealershipName}</span>
            <p className="text-on-primary-container text-sm">{profile.slogan ?? "Bringing transparency and efficiency to every transaction."}</p>
          </div>
          <div>
            <h4 className="font-bold text-white mb-6 uppercase tracking-widest">Quick Links</h4>
            <ul className="space-y-4 text-on-primary-container">
              <li><Link className="hover:text-luxury-gold transition-colors" href="/privacy">{t.footerPrivacy}</Link></li>
              <li><Link className="hover:text-luxury-gold transition-colors" href="/terms">{t.footerTerms}</Link></li>
              <li><Link className="hover:text-luxury-gold transition-colors" href="/branches">Locations</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-white mb-6 uppercase tracking-widest">Showroom</h4>
            <div className="space-y-4 text-on-primary-container">
              {profile.address && <p className="flex items-center gap-2"><span className="material-symbols-outlined text-secondary">location_on</span>{profile.address}</p>}
              {profile.phone && <p className="flex items-center gap-2"><span className="material-symbols-outlined text-secondary">phone</span>{profile.phone}</p>}
            </div>
          </div>
          <div>
            <h4 className="font-bold text-white mb-6 uppercase tracking-widest">Get In Touch</h4>
            <p className="text-on-primary-container text-sm mb-4">Have a question? Reach out and our team will respond shortly.</p>
            <Link href="/contact" className="inline-block bg-secondary text-white px-4 py-2 rounded-lg font-bold">Contact Us</Link>
          </div>
        </div>
        <div className="max-w-screen-2xl mx-auto px-margin-desktop mt-16 pt-8 border-t border-white/5 text-center text-on-primary-container text-xs">
          © {new Date().getFullYear()} {profile.dealershipName}. All Rights Reserved.
        </div>
      </footer>

      {profile.phone && (
        <div className="fixed bottom-8 right-6 z-40">
          <a className="bg-whatsapp-green text-white p-4 rounded-full shadow-2xl hover:scale-110 transition-transform active:scale-90 group relative flex"
            href={waLink(profile.phone, `Hi ${profile.dealershipName}, I need help.`)} target="_blank" rel="noopener noreferrer">
            <span className="material-symbols-outlined text-4xl">whatshot</span>
          </a>
        </div>
      )}
    </div>
  );
}
