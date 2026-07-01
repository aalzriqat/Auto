"use client";

import Link from "next/link";
import { ArrowRight, Car, CheckCircle2, Globe2, Mail, MapPin, Menu, Phone, ShieldCheck, X } from "lucide-react";
import type { ThemeProps, PublicVehicle, FormState, SiteStrings } from "./theme-props";
import { TurnstileWidget } from "../turnstile-widget";

export function AvantTheme(props: ThemeProps) {
  const {
    site, page, detailVehicle, lang, isArabic, dir, showLangToggle, isPreviewMode,
    form, setForm, setSelectedVehicleId, isSubmitting, formSuccess, setFormSuccess,
    onSubmit, turnstileSiteKey, onToggleLang, mobileNavOpen, setMobileNavOpen,
    t, primary, secondary, formatPrice, vehicles, featuredVehicles,
  } = props;

  const profile = site.profile;
  const navLinks = [
    [t.nav.home, "/"],
    [t.nav.inventory, "/inventory"],
    [t.nav.finance, "/finance"],
    [t.nav.branches, "/branches"],
    [t.nav.contact, "/contact"],
  ] as const;

  return (
    <main dir={dir} style={{ backgroundColor: "#fff", color: "#1a1a2e" }}>
      <style>{`
        .av-nav { background: ${primary}; position: sticky; top: 0; z-index: 50; }
        .av-nav-link { color: rgba(255,255,255,0.75); font-size: 14px; font-weight: 500; text-decoration: none; transition: color 0.15s; }
        .av-nav-link:hover { color: #fff; }
        .av-hero { background: linear-gradient(135deg, ${primary} 0%, ${secondary} 100%); position: relative; overflow: hidden; }
        .av-hero::before { content: ''; position: absolute; top: -50%; right: -20%; width: 600px; height: 600px; background: rgba(255,255,255,0.06); border-radius: 50%; pointer-events: none; }
        .av-hero::after { content: ''; position: absolute; bottom: -1px; left: 0; right: 0; height: 70px; background: #fff; clip-path: polygon(0 100%, 100% 0, 100% 100%); }
        .av-card { background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 2px 16px rgba(0,0,0,0.08); transition: transform 0.28s ease, box-shadow 0.28s ease; text-decoration: none; display: block; }
        .av-card:hover { transform: translateY(-6px); box-shadow: 0 16px 44px rgba(0,0,0,0.15); }
        .av-card-featured { border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.12); transition: transform 0.28s ease, box-shadow 0.28s ease; text-decoration: none; display: block; }
        .av-card-featured:hover { transform: translateY(-6px); box-shadow: 0 20px 56px rgba(0,0,0,0.18); }
        .av-input { width: 100%; padding: 11px 14px; border: 1.5px solid #e8ecf0; border-radius: 8px; font-size: 14px; color: #1a1a2e; outline: none; background: #fff; transition: border-color 0.2s, box-shadow 0.2s; }
        .av-input:focus { border-color: ${primary}; box-shadow: 0 0 0 3px ${primary}22; }
        .av-input::placeholder { color: #aab; }
        .av-btn-white { display: inline-flex; align-items: center; gap: 8px; padding: 13px 30px; background: #fff; color: ${primary}; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; text-decoration: none; transition: transform 0.15s, box-shadow 0.15s; }
        .av-btn-white:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,0.15); }
        .av-btn-outline-white { display: inline-flex; align-items: center; gap: 8px; padding: 13px 30px; background: transparent; color: #fff; border: 2px solid rgba(255,255,255,0.6); border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; text-decoration: none; transition: background 0.15s, border-color 0.15s; }
        .av-btn-outline-white:hover { background: rgba(255,255,255,0.12); border-color: #fff; }
        .av-btn-primary { display: inline-flex; align-items: center; gap: 8px; padding: 12px 28px; background: ${primary}; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; transition: opacity 0.15s; }
        .av-btn-primary:hover { opacity: 0.88; }
        .av-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .av-section-tinted { background: #f7f8fc; }
        .av-cta-block { background: linear-gradient(135deg, ${primary} 0%, ${secondary} 100%); }
        .av-badge { background: linear-gradient(135deg, ${primary} 0%, ${secondary} 100%); color: #fff; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 4px 10px; border-radius: 100px; }
        .av-spec-pill { background: #f1f5f9; color: #64748b; font-size: 12px; font-weight: 500; padding: 4px 12px; border-radius: 100px; }
        .av-price { font-size: 22px; font-weight: 900; background: linear-gradient(135deg, ${primary}, ${secondary}); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
        .av-form-card { background: #fff; border-radius: 14px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); padding: 28px; }
        .av-footer { background: #1a1a2e; color: #94a3b8; }
        @keyframes av-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
        .av-float { animation: av-float 6s ease-in-out infinite; }
        .av-section-title { font-size: clamp(26px,3.5vw,40px); font-weight: 900; color: #1a1a2e; margin-bottom: 8px; }
        .av-section-sub { font-size: 15px; color: #64748b; margin-bottom: 44px; }
      `}</style>

      {/* Header */}
      <header className="av-nav">
        {isPreviewMode && (
          <div style={{ background: "rgba(0,0,0,0.2)", borderBottom: "1px solid rgba(255,255,255,0.1)", padding: "7px 16px", textAlign: "center", fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.85)" }}>
            {t.previewBanner}
          </div>
        )}
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "0 24px", height: 64 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none" }}>
            {profile.logoUrl ? (
              <img src={profile.logoUrl} alt={profile.dealershipName} style={{ height: 36, width: "auto", maxWidth: 140, objectFit: "contain", filter: "brightness(0) invert(1)" }} />
            ) : (
              <>
                <div style={{ width: 36, height: 36, background: "rgba(255,255,255,0.2)", borderRadius: 8, display: "grid", placeItems: "center" }}>
                  <Car size={18} color="#fff" />
                </div>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{profile.dealershipName}</span>
              </>
            )}
          </Link>

          <nav style={{ display: "flex", gap: 28, alignItems: "center" }} className="av-desktop-nav">
            {navLinks.map(([label, href]) => (
              <a key={label} href={href} className="av-nav-link">{label}</a>
            ))}
          </nav>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {showLangToggle && (
              <button onClick={onToggleLang} style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#fff" }}>
                <Globe2 size={14} />
                {lang === "en" ? "العربية" : "English"}
              </button>
            )}
            <a href="/contact" style={{ background: "#fff", color: primary, borderRadius: 8, padding: "8px 18px", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
              {t.nav.contact}
            </a>
            <button onClick={() => setMobileNavOpen(!mobileNavOpen)} className="av-mobile-toggle" style={{ display: "none", background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, padding: "7px 9px", cursor: "pointer", color: "#fff" }}>
              {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>

        <style>{`
          @media (max-width: 1023px) { .av-desktop-nav { display: none !important; } .av-mobile-toggle { display: flex !important; } }
        `}</style>

        {mobileNavOpen && (
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.15)" }}>
            {navLinks.map(([label, href]) => (
              <a key={label} href={href} className="av-nav-link" onClick={() => setMobileNavOpen(false)}
                style={{ display: "block", padding: "12px 24px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                {label}
              </a>
            ))}
          </div>
        )}
      </header>

      {/* HOME */}
      {(page === "home" || page === "") && (
        <>
          {/* Hero — gradient with diagonal cutout */}
          <section className="av-hero" style={{ minHeight: 580, display: "flex", alignItems: "center", paddingBottom: 80 }}>
            <div style={{ maxWidth: 1280, margin: "0 auto", padding: "64px 24px 40px", display: "grid", gap: 40, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", alignItems: "center", width: "100%", position: "relative", zIndex: 1 }}>
              <div style={{ color: "#fff" }}>
                <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)", display: "block", marginBottom: 14 }}>
                  {profile.dealershipName}
                </span>
                <h1 style={{ fontSize: "clamp(38px, 5.5vw, 72px)", fontWeight: 900, lineHeight: 1.05, marginBottom: 18 }}>
                  {profile.heroTitle ?? "Move Forward"}
                </h1>
                <p style={{ fontSize: 17, color: "rgba(255,255,255,0.8)", lineHeight: 1.7, maxWidth: 460, marginBottom: 36 }}>
                  {profile.heroSubtitle ?? "Discover vehicles built for those who value performance, comfort, and innovation."}
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                  <a href="/inventory" className="av-btn-white">
                    {t.browseInventory} <ArrowRight size={15} style={isArabic ? { transform: "rotate(180deg)" } : {}} />
                  </a>
                  <a href="/contact" className="av-btn-outline-white">{t.contactSales}</a>
                </div>
              </div>
              <div style={{ position: "relative" }}>
                {featuredVehicles[0]?.imageUrls[0] ? (
                  <img
                    src={featuredVehicles[0].imageUrls[0]}
                    alt=""
                    className="av-float"
                    style={{ width: "100%", maxHeight: 360, objectFit: "cover", borderRadius: 20, boxShadow: "0 24px 64px rgba(0,0,0,0.3)" }}
                  />
                ) : (
                  <div style={{ width: "100%", height: 280, background: "rgba(255,255,255,0.15)", borderRadius: 20, display: "grid", placeItems: "center", color: "rgba(255,255,255,0.4)" }}>
                    <Car size={64} />
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Featured Vehicles */}
          <section style={{ padding: "72px 24px", maxWidth: 1280, margin: "0 auto" }}>
            <div style={{ textAlign: "center", marginBottom: 48 }}>
              <span className="av-badge" style={{ display: "inline-block", marginBottom: 14 }}>{t.featuredVehicles}</span>
              <h2 className="av-section-title">{t.featuredVehicles}</h2>
              <p style={{ fontSize: 15, color: "#64748b" }}>{t.featuredSub}</p>
            </div>
            <AvantVehicleGrid vehicles={featuredVehicles} primary={primary} secondary={secondary} formatPrice={formatPrice} noVehiclesLabel={t.noVehicles} featured />
            <div style={{ textAlign: "center", marginTop: 40 }}>
              <a href="/inventory" className="av-btn-primary">
                {t.viewAll} <ArrowRight size={14} style={isArabic ? { transform: "rotate(180deg)" } : {}} />
              </a>
            </div>
          </section>

          {/* CTA Band */}
          <section className="av-cta-block" style={{ padding: "64px 24px" }}>
            <div style={{ maxWidth: 760, margin: "0 auto", textAlign: "center", color: "#fff" }}>
              <h2 style={{ fontSize: "clamp(24px, 3.5vw, 38px)", fontWeight: 900, marginBottom: 14 }}>Your next vehicle is waiting</h2>
              <p style={{ fontSize: 16, color: "rgba(255,255,255,0.82)", marginBottom: 32, lineHeight: 1.7 }}>
                Speak with our team today and let us help you drive home your perfect match.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center" }}>
                <a href="/contact" className="av-btn-white">{t.nav.contact}</a>
                <a href="/inventory" className="av-btn-outline-white">{t.browseInventory}</a>
              </div>
            </div>
          </section>
        </>
      )}

      {/* INVENTORY LIST */}
      {page === "inventory" && !detailVehicle && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 1280, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <span className="av-badge" style={{ display: "inline-block", marginBottom: 14 }}>{profile.dealershipName}</span>
            <h1 className="av-section-title">{t.inventoryTitle}</h1>
            <p className="av-section-sub">{t.inventorySub}</p>
          </div>
          <AvantVehicleGrid vehicles={vehicles} primary={primary} secondary={secondary} formatPrice={formatPrice} noVehiclesLabel={t.noVehicles} />
        </section>
      )}

      {/* VEHICLE DETAIL */}
      {page === "inventory" && detailVehicle && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 1280, margin: "0 auto" }}>
          <div style={{ display: "grid", gap: 48, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
            <div style={{ borderRadius: 20, overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.12)", aspectRatio: "4/3", background: "#f1f5f9" }}>
              {detailVehicle.imageUrls[0] ? (
                <img src={detailVehicle.imageUrls[0]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "#cbd5e1" }}>
                  <Car size={48} />
                </div>
              )}
            </div>
            <div>
              <span className="av-badge">{detailVehicle.status}</span>
              <h1 style={{ fontSize: "clamp(26px, 3.5vw, 42px)", fontWeight: 900, color: "#1a1a2e", marginTop: 14, marginBottom: 6 }}>
                {detailVehicle.year} {detailVehicle.make} {detailVehicle.model}
              </h1>
              {detailVehicle.trim && <p style={{ fontSize: 16, color: "#64748b" }}>{detailVehicle.trim}</p>}
              <p className="av-price" style={{ marginTop: 14, display: "block" }}>{formatPrice(detailVehicle.price)}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 20 }}>
                {([
                  detailVehicle.mileage ? `${detailVehicle.mileage.toLocaleString()} km` : null,
                  detailVehicle.transmission,
                  detailVehicle.fuelType,
                  detailVehicle.exteriorColor,
                ] as (string | null)[]).filter(Boolean).map((s) => (
                  <span key={s} className="av-spec-pill">{s}</span>
                ))}
              </div>

              {formSuccess === "vehicle_inquiry" ? (
                <AvantSuccess t={t} primary={primary} secondary={secondary} onReset={() => setFormSuccess(null)} />
              ) : (
                <form
                  className="av-form-card"
                  style={{ marginTop: 28 }}
                  onSubmit={(e) => { setSelectedVehicleId(detailVehicle.id); onSubmit(e, "vehicle_inquiry"); }}
                >
                  <h2 style={{ fontWeight: 700, marginBottom: 16 }}>{t.askAbout}</h2>
                  <AvantFormFields form={form} setForm={setForm} t={t} isSubmitting={isSubmitting} submitLabel={t.sendInquiry} primary={primary} turnstileSiteKey={turnstileSiteKey} />
                </form>
              )}
            </div>
          </div>
        </section>
      )}

      {/* FINANCE */}
      {page === "finance" && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 760, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <span className="av-badge" style={{ display: "inline-block", marginBottom: 14 }}>Finance</span>
            <h1 className="av-section-title">{t.financeTitle}</h1>
          </div>
          {site.legal.financingDisclaimer && (
            <p style={{ fontSize: 14, color: "#64748b", marginBottom: 32, lineHeight: 1.7, textAlign: "center" }}>{site.legal.financingDisclaimer}</p>
          )}
          {formSuccess === "financing" ? (
            <AvantSuccess t={t} primary={primary} secondary={secondary} onReset={() => setFormSuccess(null)} />
          ) : (
            <form className="av-form-card" onSubmit={(e) => onSubmit(e, "financing")}>
              <AvantFormFields form={form} setForm={setForm} t={t} isSubmitting={isSubmitting} submitLabel={t.requestFinancing} primary={primary} turnstileSiteKey={turnstileSiteKey} />
            </form>
          )}
        </section>
      )}

      {/* BRANCHES */}
      {page === "branches" && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 960, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <span className="av-badge" style={{ display: "inline-block", marginBottom: 14 }}>Locations</span>
            <h1 className="av-section-title">{t.branchesTitle}</h1>
          </div>
          <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {profile.branches.map((b) => (
              <div key={b.id} style={{ background: "#fff", borderRadius: 16, boxShadow: "0 2px 16px rgba(0,0,0,0.08)", padding: 24 }}>
                <div style={{ width: 44, height: 44, background: `linear-gradient(135deg, ${primary}, ${secondary})`, borderRadius: 10, display: "grid", placeItems: "center", marginBottom: 14 }}>
                  <MapPin size={20} color="#fff" />
                </div>
                <h2 style={{ fontWeight: 700, fontSize: 17, marginBottom: 12 }}>{b.name}</h2>
                {b.address && (
                  <p style={{ fontSize: 14, color: "#64748b", marginBottom: 8 }}>
                    {b.address.startsWith("http") ? (
                      <a href={b.address} target="_blank" rel="noopener noreferrer" style={{ color: primary }}>{t.viewOnMap}</a>
                    ) : b.address}
                  </p>
                )}
                {b.phone && (
                  <a href={`tel:${b.phone}`} style={{ fontSize: 14, color: "#64748b", textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}>
                    <Phone size={13} style={{ color: primary }} /> {b.phone}
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* CONTACT */}
      {page === "contact" && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <span className="av-badge" style={{ display: "inline-block", marginBottom: 14 }}>Contact</span>
            <h1 className="av-section-title">{t.contactTitle}</h1>
          </div>
          <div style={{ display: "grid", gap: 40, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {profile.phone && (
                <div style={{ background: "#fff", borderRadius: 14, boxShadow: "0 2px 14px rgba(0,0,0,0.06)", padding: "18px 20px", display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 44, height: 44, background: `linear-gradient(135deg, ${primary}, ${secondary})`, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0 }}>
                    <Phone size={18} color="#fff" />
                  </div>
                  <a href={`tel:${profile.phone}`} style={{ fontSize: 15, color: "#1a1a2e", textDecoration: "none", fontWeight: 600 }}>{profile.phone}</a>
                </div>
              )}
              {profile.address && (
                <div style={{ background: "#fff", borderRadius: 14, boxShadow: "0 2px 14px rgba(0,0,0,0.06)", padding: "18px 20px", display: "flex", alignItems: "flex-start", gap: 14 }}>
                  <div style={{ width: 44, height: 44, background: `linear-gradient(135deg, ${primary}, ${secondary})`, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0 }}>
                    <MapPin size={18} color="#fff" />
                  </div>
                  <p style={{ fontSize: 15, color: "#475569", paddingTop: 10 }}>{profile.address}</p>
                </div>
              )}
              <p style={{ fontSize: 12, color: "#94a3b8", display: "flex", alignItems: "flex-start", gap: 6, lineHeight: 1.6 }}>
                <ShieldCheck size={13} style={{ flexShrink: 0, marginTop: 1 }} />{t.contactDisclaimer}
              </p>
            </div>
            {formSuccess === "contact" ? (
              <AvantSuccess t={t} primary={primary} secondary={secondary} onReset={() => setFormSuccess(null)} />
            ) : (
              <form className="av-form-card" onSubmit={(e) => onSubmit(e, "contact")}>
                <AvantFormFields form={form} setForm={setForm} t={t} isSubmitting={isSubmitting} submitLabel={t.sendMessage} primary={primary} turnstileSiteKey={turnstileSiteKey} />
              </form>
            )}
          </div>
        </section>
      )}

      {/* LEGAL */}
      {(page === "privacy" || page === "terms" || page === "data-deletion") && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 760, margin: "0 auto" }}>
          <span className="av-badge" style={{ display: "inline-block", marginBottom: 16 }}>Legal</span>
          <h1 className="av-section-title">
            {page === "privacy" ? t.privacyTitle : page === "terms" ? t.termsTitle : t.dataDeletionTitle}
          </h1>
          <p style={{ fontSize: 15, color: "#64748b", lineHeight: 1.85 }}>
            {page === "privacy" ? site.legal.privacyPolicy : page === "terms" ? site.legal.terms : site.legal.dataDeletion}
          </p>
        </section>
      )}

      {/* Footer */}
      <footer className="av-footer" style={{ padding: "56px 24px 32px" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 40, justifyContent: "space-between", marginBottom: 40 }}>
            <div>
              {profile.logoUrl ? (
                <img src={profile.logoUrl} alt={profile.dealershipName} style={{ height: 32, width: "auto", objectFit: "contain", filter: "brightness(0) invert(1)", opacity: 0.75, marginBottom: 10 }} />
              ) : (
                <p style={{ fontSize: 16, fontWeight: 800, color: "#f1f5f9", marginBottom: 8 }}>{profile.dealershipName}</p>
              )}
              {profile.phone && (
                <a href={`tel:${profile.phone}`} style={{ fontSize: 13, color: "#64748b", textDecoration: "none", display: "flex", alignItems: "center", gap: 7, marginTop: 8 }}>
                  <Phone size={13} style={{ color: primary }} /> {profile.phone}
                </a>
              )}
            </div>
            <nav style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
              {navLinks.map(([label, href]) => (
                <a key={label} href={href} style={{ fontSize: 13, color: "#64748b", textDecoration: "none" }}>{label}</a>
              ))}
            </nav>
          </div>
          <div style={{ borderTop: "1px solid #2d2d3f", paddingTop: 24, display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#4a5568" }}>
            <p>© {new Date().getFullYear()} {profile.dealershipName}</p>
            <div style={{ display: "flex", gap: 20 }}>
              <a href="/privacy" style={{ color: "#4a5568", textDecoration: "none" }}>{t.footerPrivacy}</a>
              <a href="/terms" style={{ color: "#4a5568", textDecoration: "none" }}>{t.footerTerms}</a>
              <a href="/data-deletion" style={{ color: "#4a5568", textDecoration: "none" }}>{t.footerDataDeletion}</a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}

function AvantVehicleGrid({ vehicles, primary, secondary, formatPrice, noVehiclesLabel, featured }: {
  vehicles: PublicVehicle[];
  primary: string;
  secondary: string;
  formatPrice: (p: number | null) => string;
  noVehiclesLabel: string;
  featured?: boolean;
}) {
  if (!vehicles.length) {
    return (
      <div style={{ border: "2px dashed #e2e8f0", borderRadius: 16, padding: 64, textAlign: "center", color: "#94a3b8" }}>
        {noVehiclesLabel}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
      {vehicles.map((v, i) => (
        <a
          key={v.id}
          href={`/inventory/${v.slug}`}
          className={featured && i === 0 ? "av-card-featured" : "av-card"}
          style={featured && i === 0 ? { gridColumn: "span 2" } : {}}
        >
          <div style={{ aspectRatio: featured && i === 0 ? "21/9" : "16/10", overflow: "hidden", position: "relative", background: "#f1f5f9" }}>
            {v.imageUrls[0] ? (
              <img src={v.imageUrls[0]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "#cbd5e1" }}>
                <Car size={48} />
              </div>
            )}
            <span style={{ position: "absolute", top: 12, left: 12, background: `linear-gradient(135deg, ${primary}, ${secondary})`, color: "#fff", fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", padding: "3px 10px", borderRadius: 100 }}>
              {v.status}
            </span>
          </div>
          <div style={{ padding: "16px 20px 20px" }}>
            <h3 style={{ fontWeight: 800, fontSize: featured && i === 0 ? 22 : 17, color: "#1a1a2e", marginBottom: 6 }}>
              {v.year} {v.make} {v.model}
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {[v.trim, v.mileage ? `${v.mileage.toLocaleString()} km` : null].filter(Boolean).map((s) => (
                <span key={s} style={{ background: "#f1f5f9", color: "#64748b", fontSize: 11, fontWeight: 500, padding: "3px 10px", borderRadius: 100 }}>{s}</span>
              ))}
            </div>
            <p style={{ fontWeight: 900, fontSize: featured && i === 0 ? 22 : 18, background: `linear-gradient(135deg, ${primary}, ${secondary})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
              {formatPrice(v.price)}
            </p>
          </div>
        </a>
      ))}
    </div>
  );
}

function AvantSuccess({ t, primary, secondary, onReset }: { t: SiteStrings; primary: string; secondary: string; onReset: () => void }) {
  return (
    <div style={{ background: "linear-gradient(135deg, #f0fdf4, #ecfdf5)", border: "1px solid #bbf7d0", borderRadius: 14, padding: 40, textAlign: "center", marginTop: 20 }}>
      <CheckCircle2 size={40} style={{ color: "#16a34a", margin: "0 auto 14px" }} />
      <h3 style={{ fontWeight: 700, fontSize: 20, marginBottom: 8, color: "#14532d" }}>{t.thankYou}</h3>
      <p style={{ color: "#166534", fontSize: 14, marginBottom: 24 }}>{t.messageReceived}</p>
      <button onClick={onReset} style={{ background: `linear-gradient(135deg, ${primary}, ${secondary})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 24px", fontWeight: 700, cursor: "pointer" }}>
        {t.sendAnother}
      </button>
    </div>
  );
}

function AvantFormFields({ form, setForm, t, isSubmitting, submitLabel, primary, turnstileSiteKey }: {
  form: FormState;
  setForm: (f: FormState) => void;
  t: SiteStrings;
  isSubmitting: boolean;
  submitLabel: string;
  primary: string;
  turnstileSiteKey?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        <input required value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} placeholder={t.placeholderFirstName} className="av-input" />
        <input value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} placeholder={t.placeholderLastName} className="av-input" />
      </div>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(3, 1fr)" }}>
        <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder={t.placeholderEmail} className="av-input" />
        <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder={t.placeholderPhone} className="av-input" />
        <input value={form.whatsapp} onChange={e => setForm({ ...form, whatsapp: e.target.value })} placeholder={t.placeholderWhatsApp} className="av-input" />
      </div>
      <textarea value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} placeholder={t.placeholderMessage} rows={4} className="av-input" style={{ resize: "none" }} />
      <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#94a3b8" }}>
        <Mail size={12} style={{ flexShrink: 0 }} /> {t.contactMethodHint}
      </p>
      <TurnstileWidget siteKey={turnstileSiteKey} theme="light" />
      <button type="submit" disabled={isSubmitting} className="av-btn-primary" style={{ justifyContent: "center" }}>
        {submitLabel}
      </button>
    </div>
  );
}
