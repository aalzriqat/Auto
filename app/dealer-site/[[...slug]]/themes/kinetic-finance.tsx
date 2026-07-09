"use client";

import { useState } from "react";
import Link from "next/link";
import type { ThemeProps } from "./theme-props";
import { TurnstileWidget } from "../turnstile-widget";
import { DEFAULT_FINANCE_TERMS, KineticBrand, estimateMonthlyInstallment, useKineticStrings, waLink } from "./kinetic-shared";

function sliderGradient(value: number, min: number, max: number) {
  const pct = ((value - min) / (max - min)) * 100;
  return `linear-gradient(to right, #ba0035 ${pct}%, #d9e3f6 ${pct}%)`;
}

export function KineticFinanceCalculator(props: ThemeProps) {
  const {
    site, t, lang, isPreviewMode, dir, form, setForm, isSubmitting, formSuccess, setFormSuccess, onSubmit, turnstileSiteKey,
  } = props;
  const profile = site.profile;
  const k = useKineticStrings(lang);

  const [price, setPrice] = useState(25000);
  const [downPercent, setDownPercent] = useState(20);
  const [months, setMonths] = useState(60);

  const financeCompany = site.financeCompany;
  const maxMonths = financeCompany?.maxTermMonths ?? DEFAULT_FINANCE_TERMS.maxTermMonths;
  const clampedMonths = Math.min(months, maxMonths);

  const downAmount = price * (downPercent / 100);
  const { monthlyInstallment: monthlyPayment } = estimateMonthlyInstallment({
    financeCompany,
    vehiclePrice: price,
    downPayment: downAmount,
    termMonths: clampedMonths,
  });
  const profitRate = financeCompany?.profitRate ?? 4.5;

  return (
    <div className="theme-kinetic bg-surface font-body-md text-on-surface" dir={dir}>
      {isPreviewMode && (
        <div className="bg-secondary px-4 py-2 text-center text-sm font-bold text-white">{t.previewBanner}</div>
      )}
      <header className="bg-surface/90 backdrop-blur-xl docked full-width top-0 sticky z-50 shadow-sm">
        <nav className="flex justify-between items-center px-gutter py-3 w-full max-w-screen-2xl mx-auto">
          <div className="flex items-center gap-10">
            <Link href="/">
              <KineticBrand profile={profile} size="lg" />
            </Link>
            <div className="hidden md:flex gap-8 items-center">
              <Link className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-sm" href="/inventory">{t.nav.inventory}</Link>
              <Link className="text-secondary border-b-2 border-secondary font-bold pb-1 font-label-caps text-sm" href="/finance">{t.nav.finance}</Link>
              <Link className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-sm" href="/contact">{t.nav.contact}</Link>
            </div>
          </div>
          {profile.phone && (
            <a className="hidden lg:flex items-center gap-2 px-4 py-2 bg-whatsapp-green text-white rounded-lg font-bold hover:scale-95 transition-transform"
              href={waLink(profile.phone, `Hi ${profile.dealershipName}, I have a finance question.`)} target="_blank" rel="noopener noreferrer">
              <span className="material-symbols-outlined">whatshot</span>
              {k.whatsappSupport}
            </a>
          )}
        </nav>
      </header>

      <main className="max-w-screen-2xl mx-auto px-margin-desktop py-12 lg:py-20">
        <div className="mb-12 border-l-4 border-secondary pl-6">
          <h1 className="font-headline-lg text-headline-lg text-primary mb-2 uppercase tracking-tight">{t.financeTitle}</h1>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter items-start">
          <section className="lg:col-span-7 space-y-6">
            <div className="bg-surface-container-lowest p-8 rounded-xl shadow-sm border border-outline-variant/30">
              <div className="flex items-center gap-3 mb-8">
                <span className="material-symbols-outlined text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>calculate</span>
                <h3 className="font-headline-lg text-headline-lg text-primary text-xl">{k.customizeYourPlan}</h3>
              </div>
              <div className="mb-10">
                <div className="flex justify-between items-center mb-4">
                  <label className="font-label-caps text-label-caps text-on-surface-variant uppercase">{k.vehiclePriceLabel}</label>
                  <span className="font-headline-lg text-headline-lg text-2xl text-primary">{price.toLocaleString()} JOD</span>
                </div>
                <input
                  className="w-full h-2 rounded-lg cursor-pointer appearance-none"
                  style={{ background: sliderGradient(price, 5000, 150000) }}
                  max={150000} min={5000} step={500} type="range" value={price}
                  onChange={(e) => setPrice(Number(e.target.value))}
                />
                <div className="flex justify-between mt-2 font-label-caps text-[10px] text-outline">
                  <span>5,000 JOD</span>
                  <span>150,000 JOD</span>
                </div>
              </div>
              <div className="mb-10">
                <div className="flex justify-between items-center mb-4">
                  <label className="font-label-caps text-label-caps text-on-surface-variant uppercase">{k.downPaymentPercentLabel}</label>
                  <span className="font-headline-lg text-headline-lg text-2xl text-primary">{Math.round(downAmount).toLocaleString()} JOD</span>
                </div>
                <input
                  className="w-full h-2 rounded-lg cursor-pointer appearance-none"
                  style={{ background: sliderGradient(downPercent, 10, 80) }}
                  max={80} min={10} step={5} type="range" value={downPercent}
                  onChange={(e) => setDownPercent(Number(e.target.value))}
                />
                <div className="flex justify-between mt-2 font-label-caps text-[10px] text-outline">
                  <span>{Math.round(price * 0.1).toLocaleString()} JOD</span>
                  <span>{Math.round(price * 0.8).toLocaleString()} JOD</span>
                </div>
              </div>
              <div className="mb-6">
                <div className="flex justify-between items-center mb-4">
                  <label className="font-label-caps text-label-caps text-on-surface-variant uppercase">{k.paymentPeriodLabel}</label>
                  <span className="font-headline-lg text-headline-lg text-2xl text-primary">{clampedMonths} {k.monthsUnit}</span>
                </div>
                <input
                  className="w-full h-2 rounded-lg cursor-pointer appearance-none"
                  style={{ background: sliderGradient(clampedMonths, 12, maxMonths) }}
                  max={maxMonths} min={12} step={12} type="range" value={clampedMonths}
                  onChange={(e) => setMonths(Number(e.target.value))}
                />
                <div className="flex justify-between mt-2 font-label-caps text-[10px] text-outline">
                  <span>12 {k.monthsUnit}</span>
                  <span>{maxMonths} {k.monthsUnit}</span>
                </div>
              </div>
            </div>
          </section>

          <aside className="lg:col-span-5 sticky top-28 space-y-6">
            <div className="bg-primary text-white p-8 rounded-xl shadow-xl relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-secondary opacity-20 blur-3xl rounded-full -mr-16 -mt-16" />
              <h4 className="font-label-caps text-label-caps text-primary-fixed mb-6 uppercase">{k.estimatedMonthlyInstallment}</h4>
              <div className="flex items-baseline gap-2 mb-8">
                <span className="font-headline-lg text-5xl font-extrabold text-white">{Math.round(monthlyPayment).toLocaleString()}</span>
                <span className="font-headline-lg text-xl text-primary-fixed">JOD/mo</span>
              </div>
              <div className="space-y-4 pt-6 border-t border-white/10">
                <div className="flex justify-between items-center">
                  <span className="text-on-primary-container font-body-md">{k.fixedInterestRate}</span>
                  <span className="font-bold text-lg text-secondary-fixed-dim">{profitRate.toFixed(2)}%</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-on-primary-container font-body-md">{k.downPaymentAmount}</span>
                  <span className="font-bold text-lg">{Math.round(downAmount).toLocaleString()} JOD</span>
                </div>
              </div>
            </div>

            <div className="bg-surface-container-low p-6 rounded-xl border border-outline-variant/30">
              {formSuccess === "financing" ? (
                <div className="text-center py-4">
                  <span className="material-symbols-outlined text-secondary text-4xl mb-2" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                  <h3 className="font-bold text-lg mb-1">{t.thankYou}</h3>
                  <p className="text-on-surface-variant text-sm mb-4">{t.messageReceived}</p>
                  <button onClick={() => setFormSuccess(null)} className="bg-primary text-white rounded-lg px-6 py-2 font-bold">{t.sendAnother}</button>
                </div>
              ) : (
                <form onSubmit={(e) => onSubmit(e, "financing")} className="space-y-3">
                  <h3 className="font-headline-lg text-primary text-lg mb-2">{k.submitFinanceApplication}</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} placeholder={t.placeholderFirstName} className="w-full bg-white border border-outline-variant rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-secondary outline-none" />
                    <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} placeholder={t.placeholderLastName} className="w-full bg-white border border-outline-variant rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-secondary outline-none" />
                  </div>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t.placeholderPhone} className="w-full bg-white border border-outline-variant rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-secondary outline-none" />
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t.placeholderEmail} className="w-full bg-white border border-outline-variant rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-secondary outline-none" />
                  <TurnstileWidget siteKey={turnstileSiteKey} theme="light" />
                  <button type="submit" disabled={isSubmitting} className="w-full py-4 bg-secondary text-white font-headline-lg rounded-xl flex items-center justify-center gap-3 hover:bg-secondary-container transition-all active:scale-95 shadow-lg disabled:opacity-50">
                    {t.requestFinancing}
                    <span className="material-symbols-outlined">arrow_forward</span>
                  </button>
                </form>
              )}
            </div>

            {profile.phone && (
              <a
                href={waLink(profile.phone, `Hi ${profile.dealershipName}, I'd like to talk to a finance specialist.`)}
                target="_blank" rel="noopener noreferrer"
                className="w-full py-5 bg-surface-container-highest border-2 border-whatsapp-green/30 text-primary font-headline-lg rounded-xl flex items-center justify-center gap-3 hover:bg-white transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-whatsapp-green" style={{ fontVariationSettings: "'FILL' 1" }}>whatshot</span>
                {k.talkToSpecialist}
              </a>
            )}

            <div className="bg-surface-container p-6 rounded-xl border-t-4 border-luxury-gold flex items-center gap-4">
              <div className="p-3 bg-white rounded-full">
                <span className="material-symbols-outlined text-luxury-gold" style={{ fontVariationSettings: "'FILL' 1" }}>verified</span>
              </div>
              <div>
                <p className="font-bold text-primary">{k.certifiedAdvisorsTitle}</p>
                <p className="text-sm text-on-surface-variant">
                  {k.certifiedAdvisorsDesc}
                </p>
              </div>
            </div>

            <div className="p-4 bg-surface-variant/20 rounded-lg">
              <p className="text-[11px] leading-relaxed text-outline text-justify">
                <strong className="text-on-surface-variant">{k.disclaimerLabel} </strong>
                {site.legal.financingDisclaimer ?? k.defaultFinancingDisclaimer}
              </p>
            </div>
          </aside>
        </div>
      </main>

      <footer className="bg-primary dark:bg-on-primary-fixed w-full py-section-gap mt-section-gap">
        <div className="w-full grid grid-cols-1 md:grid-cols-4 gap-gutter px-margin-desktop max-w-screen-2xl mx-auto">
          <div className="space-y-4">
            <KineticBrand profile={profile} size="md" />
            <p className="text-on-primary-container font-body-md">{profile.slogan ?? k.financeFooterSloganDefault}</p>
          </div>
          <div className="flex flex-col gap-4">
            <h5 className="text-white font-bold uppercase tracking-widest text-xs">{k.quickLinks}</h5>
            <Link className="text-on-primary-container hover:text-white transition-colors" href="/inventory">{t.nav.inventory}</Link>
            <Link className="text-on-primary-container hover:text-white transition-colors" href="/terms">{t.footerTerms}</Link>
            <Link className="text-on-primary-container hover:text-white transition-colors" href="/privacy">{t.footerPrivacy}</Link>
          </div>
          <div className="flex flex-col gap-4">
            <h5 className="text-white font-bold uppercase tracking-widest text-xs">{t.nav.finance}</h5>
            <Link className="text-luxury-gold underline" href="/finance">{k.calculatorLinkLabel}</Link>
          </div>
          <div className="flex flex-col gap-4">
            <h5 className="text-white font-bold uppercase tracking-widest text-xs">{t.nav.contact}</h5>
            {profile.address && (
              <p className="text-on-primary-container font-body-md">
                {profile.address.startsWith("http") ? (
                  <a href={profile.address} target="_blank" rel="noopener noreferrer" className="hover:underline">{t.viewOnMap}</a>
                ) : (
                  profile.address
                )}
              </p>
            )}
            {profile.phones.map((phone) => (
              <a key={phone} href={`tel:${phone}`} className="text-on-primary-container font-body-md hover:underline">{phone}</a>
            ))}
          </div>
        </div>
        <div className="border-t border-white/5 mt-12 pt-8 text-center px-margin-desktop">
          <p className="text-on-primary-container text-sm font-body-md">© {new Date().getFullYear()} {profile.dealershipName}. {k.allRightsReserved}.</p>
        </div>
      </footer>
    </div>
  );
}
