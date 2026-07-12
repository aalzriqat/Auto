"use client";

import Link from "next/link";
import { ArrowRight, Car, CheckCircle2, Globe2, Mail, MapPin, Menu, Phone, ShieldCheck, X, Zap } from "lucide-react";
import type { ThemeProps, PublicVehicle, FormState, SiteStrings } from "./theme-props";
import { TurnstileWidget } from "../turnstile-widget";

export function VelocityTheme(props: ThemeProps) {
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
    <main dir={dir} style={{ backgroundColor: "#fff", color: "#0f172a", fontFamily: "system-ui, sans-serif" }}>
      <style>{`
        .vl-nav { background: #fff; border-bottom: 1px solid #e8ecf0; position: sticky; top: 0; z-index: 50; }
        .vl-nav-link { font-size: 14px; font-weight: 500; color: #475569; text-decoration: none; position: relative; padding-bottom: 3px; transition: color 0.15s; }
        .vl-nav-link::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: ${primary}; transform: scaleX(0); transform-origin: left; transition: transform 0.2s ease; border-radius: 2px; }
        .vl-nav-link:hover { color: #0f172a; }
        .vl-nav-link:hover::after { transform: scaleX(1); }
        .vl-btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 28px; border-radius: 6px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; transition: opacity 0.15s, transform 0.15s; border: none; }
        .vl-btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .vl-btn:active { transform: translateY(0); }
        .vl-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .vl-btn-primary { background: ${primary}; color: #fff; }
        .vl-btn-secondary { background: transparent; color: ${primary}; border: 2px solid ${primary} !important; }
        .vl-btn-secondary:hover { background: ${primary}; color: #fff; }
        .vl-card { background: #fff; border-radius: 10px; border: 1px solid #e8ecf0; overflow: hidden; transition: box-shadow 0.2s, transform 0.2s; text-decoration: none; display: block; }
        .vl-card:hover { box-shadow: 0 12px 32px rgba(0,0,0,0.12); transform: translateY(-3px); }
        .vl-input { width: 100%; padding: 10px 14px; border: 1.5px solid #e2e8f0; border-radius: 6px; font-size: 14px; color: #0f172a; outline: none; background: #fff; transition: border-color 0.2s, box-shadow 0.2s; }
        .vl-input:focus { border-color: ${primary}; box-shadow: 0 0 0 3px ${primary}1a; }
        .vl-input::placeholder { color: #94a3b8; }
        .vl-section-alt { background: #f8fafc; }
        .vl-accent-bar { width: 40px; height: 4px; background: ${primary}; border-radius: 2px; margin-bottom: 14px; }
        .vl-spec-chip { background: #f1f5f9; color: #475569; font-size: 12px; font-weight: 500; padding: 4px 10px; border-radius: 100px; display: inline-flex; align-items: center; gap: 5px; }
        .vl-price-badge { background: ${primary}; color: #fff; font-weight: 700; font-size: 15px; padding: 6px 14px; border-radius: 6px; }
        .vl-stat { border-right: 1px solid #e2e8f0; padding: 0 32px; }
        .vl-stat:last-child { border-right: none; }
        .vl-hero-panel { clip-path: polygon(6% 0, 100% 0, 100% 100%, 0% 100%); }
        @media (max-width: 767px) { .vl-hero-panel { clip-path: none; } }
        .vl-cta-section { background: ${primary}; }
        .vl-footer { background: #0f172a; color: #94a3b8; }
        .vl-card-border { border-left: 4px solid ${primary}; }
      `}</style>

      {/* Header */}
      <header className="vl-nav">
        {isPreviewMode && (
          <div style={{ background: "#fffbeb", borderBottom: "1px solid #fde68a", padding: "7px 16px", textAlign: "center", fontSize: 12, fontWeight: 500, color: "#92400e" }}>
            {t.previewBanner}
          </div>
        )}
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "0 24px", height: 68 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none" }}>
            {profile.logoUrl ? (
              <img src={profile.logoUrl} alt={profile.dealershipName} style={{ height: 38, width: "auto", maxWidth: 150, objectFit: "contain" }} />
            ) : (
              <>
                <div style={{ width: 38, height: 38, background: primary, borderRadius: 8, display: "grid", placeItems: "center" }}>
                  <Car size={18} color="#fff" />
                </div>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{profile.dealershipName}</span>
              </>
            )}
          </Link>

          <nav style={{ display: "flex", gap: 28, alignItems: "center" }} className="vl-desktop-nav">
            {navLinks.map(([label, href]) => (
              <a key={label} href={href} className="vl-nav-link">{label}</a>
            ))}
          </nav>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {showLangToggle && (
              <button onClick={onToggleLang} style={{ background: "none", border: "1px solid #e2e8f0", borderRadius: 6, padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#64748b" }}>
                <Globe2 size={14} />
                {lang === "en" ? "العربية" : "English"}
              </button>
            )}
            <a href="/contact" className="vl-btn vl-btn-primary" style={{ padding: "8px 20px", fontSize: 13 }}>
              {t.nav.contact}
            </a>
            <button onClick={() => setMobileNavOpen(!mobileNavOpen)} className="vl-mobile-toggle" style={{ display: "none", background: "none", border: "1px solid #e2e8f0", borderRadius: 6, padding: "7px 9px", cursor: "pointer", color: "#475569" }}>
              {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>

        <style>{`
          @media (max-width: 1023px) { .vl-desktop-nav { display: none !important; } .vl-mobile-toggle { display: flex !important; } }
        `}</style>

        {mobileNavOpen && (
          <div style={{ borderTop: "1px solid #f1f5f9", background: "#fff" }}>
            {navLinks.map(([label, href]) => (
              <a key={label} href={href} className="vl-nav-link" onClick={() => setMobileNavOpen(false)}
                style={{ display: "block", padding: "12px 24px", borderBottom: "1px solid #f8fafc" }}>
                {label}
              </a>
            ))}
          </div>
        )}
      </header>

      {/* HOME */}
      {(page === "home" || page === "") && (
        <>
          {/* Hero — split layout */}
          <section style={{ overflow: "hidden", background: "#f8fafc" }}>
            <div style={{ maxWidth: 1280, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", minHeight: 540 }}>
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: "60px 24px 60px 24px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <div style={{ width: 28, height: 3, background: primary, borderRadius: 2 }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: primary, letterSpacing: "0.15em", textTransform: "uppercase" }}>{profile.dealershipName}</span>
                </div>
                <h1 style={{ fontSize: "clamp(36px, 5vw, 64px)", fontWeight: 900, lineHeight: 1.08, color: "#0f172a", marginBottom: 20 }}>
                  {profile.heroTitle ?? "Drive Your Dream"}
                </h1>
                <p style={{ fontSize: 16, color: "#64748b", lineHeight: 1.75, maxWidth: 440, marginBottom: 36 }}>
                  {profile.heroSubtitle ?? "Browse our curated inventory and connect with our sales team."}
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                  <a href="/inventory" className="vl-btn vl-btn-primary">
                    {t.browseInventory} <ArrowRight size={15} style={isArabic ? { transform: "rotate(180deg)" } : {}} />
                  </a>
                  <a href="/contact" className="vl-btn vl-btn-secondary">{t.contactSales}</a>
                </div>
              </div>
              <div className="vl-hero-panel" style={{ overflow: "hidden", minHeight: 360, background: "#e2e8f0", position: "relative" }}>
                {featuredVehicles[0]?.imageUrls[0] ? (
                  <img src={featuredVehicles[0].imageUrls[0]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", position: "absolute", inset: 0 }} />
                ) : (
                  <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#cbd5e1" }}>
                    <Car size={64} />
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Stats bar */}
          <section style={{ borderBottom: "1px solid #e8ecf0" }}>
            <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
              {[
                { icon: <Car size={18} style={{ color: primary }} />, value: `${vehicles.length}+`, label: "Vehicles in stock" },
                { icon: <Zap size={18} style={{ color: primary }} />, value: "Fast", label: "Response time" },
                { icon: <ShieldCheck size={18} style={{ color: primary }} />, value: "Trusted", label: "Dealership" },
              ].map((stat) => (
                <div key={stat.label} className="vl-stat" style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 32px" }}>
                  {stat.icon}
                  <div>
                    <p style={{ fontWeight: 800, fontSize: 18, color: "#0f172a", lineHeight: 1 }}>{stat.value}</p>
                    <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{stat.label}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Featured Vehicles */}
          <section style={{ padding: "72px 24px", maxWidth: 1280, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 40 }}>
              <div>
                <div className="vl-accent-bar" />
                <h2 style={{ fontSize: "clamp(26px, 3.5vw, 38px)", fontWeight: 800, color: "#0f172a" }}>{t.featuredVehicles}</h2>
                <p style={{ fontSize: 14, color: "#64748b", marginTop: 6 }}>{t.featuredSub}</p>
              </div>
              <a href="/inventory" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600, color: primary, textDecoration: "none" }}>
                {t.viewAll} <ArrowRight size={14} style={isArabic ? { transform: "rotate(180deg)" } : {}} />
              </a>
            </div>
            <VelocityVehicleGrid vehicles={featuredVehicles} primary={primary} secondary={secondary} formatPrice={formatPrice} noVehiclesLabel={t.noVehicles} />
          </section>

          {/* CTA */}
          <section className="vl-cta-section" style={{ padding: "72px 24px" }}>
            <div style={{ maxWidth: 720, margin: "0 auto", textAlign: "center" }}>
              <h2 style={{ fontSize: "clamp(26px, 3.5vw, 40px)", fontWeight: 800, color: "#fff", marginBottom: 14 }}>
                Ready to find your vehicle?
              </h2>
              <p style={{ fontSize: 16, color: "rgba(255,255,255,0.8)", marginBottom: 32 }}>
                Our team is ready to help you find the perfect match.
              </p>
              <a href="/contact" className="vl-btn" style={{ background: "#fff", color: primary, padding: "14px 36px", fontSize: 15, margin: "0 auto" }}>
                {t.nav.contact} <ArrowRight size={15} style={isArabic ? { transform: "rotate(180deg)" } : {}} />
              </a>
            </div>
          </section>
        </>
      )}

      {/* INVENTORY LIST */}
      {page === "inventory" && !detailVehicle && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 1280, margin: "0 auto" }}>
          <div className="vl-accent-bar" />
          <h1 style={{ fontSize: "clamp(28px, 4vw, 48px)", fontWeight: 800, marginBottom: 8 }}>{t.inventoryTitle}</h1>
          <p style={{ fontSize: 15, color: "#64748b", marginBottom: 48 }}>{t.inventorySub}</p>
          <VelocityVehicleGrid vehicles={vehicles} primary={primary} secondary={secondary} formatPrice={formatPrice} noVehiclesLabel={t.noVehicles} />
        </section>
      )}

      {/* VEHICLE DETAIL */}
      {page === "inventory" && detailVehicle && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 1280, margin: "0 auto" }}>
          <div style={{ display: "grid", gap: 48, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
            <div style={{ borderRadius: 12, overflow: "hidden", background: "#f1f5f9", aspectRatio: "4/3" }}>
              {detailVehicle.imageUrls[0] ? (
                <img src={detailVehicle.imageUrls[0]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "#cbd5e1" }}>
                  <Car size={48} />
                </div>
              )}
            </div>
            <div>
              <span style={{ display: "inline-block", background: `${primary}15`, color: primary, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", padding: "4px 12px", borderRadius: 100 }}>
                {detailVehicle.status}
              </span>
              <h1 style={{ fontSize: "clamp(26px, 3.5vw, 40px)", fontWeight: 900, color: "#0f172a", marginTop: 14, marginBottom: 4 }}>
                {detailVehicle.year} {detailVehicle.make} {detailVehicle.model}
              </h1>
              {detailVehicle.trim && <p style={{ fontSize: 16, color: "#64748b" }}>{detailVehicle.trim}</p>}
              <div className="vl-price-badge" style={{ display: "inline-flex", marginTop: 16 }}>
                {formatPrice(detailVehicle.price)}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 24 }}>
                {([
                  detailVehicle.mileage ? `${detailVehicle.mileage.toLocaleString()} km` : null,
                  detailVehicle.transmission,
                  detailVehicle.fuelType,
                  detailVehicle.exteriorColor,
                ] as (string | null)[]).filter(Boolean).map((spec) => (
                  <span key={spec} className="vl-spec-chip">{spec}</span>
                ))}
              </div>

              {formSuccess === "vehicle_inquiry" ? (
                <VelocitySuccess t={t} primary={primary} onReset={() => setFormSuccess(null)} />
              ) : (
                <form
                  style={{ marginTop: 32, border: "1px solid #e2e8f0", borderRadius: 10, padding: 24, borderLeft: `4px solid ${primary}` }}
                  onSubmit={(e) => { setSelectedVehicleId(detailVehicle.id); onSubmit(e, "vehicle_inquiry", { vehicleId: detailVehicle.id }); }}
                >
                  <h2 style={{ fontWeight: 700, marginBottom: 16 }}>{t.askAbout}</h2>
                  <VelocityFormFields form={form} setForm={setForm} t={t} isSubmitting={isSubmitting} submitLabel={t.sendInquiry} primary={primary} turnstileSiteKey={turnstileSiteKey} />
                </form>
              )}
            </div>
          </div>
        </section>
      )}

      {/* FINANCE */}
      {page === "finance" && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 760, margin: "0 auto" }}>
          <div className="vl-accent-bar" />
          <h1 style={{ fontSize: "clamp(28px, 4vw, 48px)", fontWeight: 800, marginBottom: 10 }}>{t.financeTitle}</h1>
          {site.legal.financingDisclaimer && (
            <p style={{ fontSize: 14, color: "#64748b", marginBottom: 36, lineHeight: 1.7 }}>{site.legal.financingDisclaimer}</p>
          )}
          {formSuccess === "financing" ? (
            <VelocitySuccess t={t} primary={primary} onReset={() => setFormSuccess(null)} />
          ) : (
            <form
              style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 28, borderLeft: `4px solid ${primary}` }}
              onSubmit={(e) => onSubmit(e, "financing")}
            >
              <VelocityFormFields form={form} setForm={setForm} t={t} isSubmitting={isSubmitting} submitLabel={t.requestFinancing} primary={primary} turnstileSiteKey={turnstileSiteKey} />
            </form>
          )}
        </section>
      )}

      {/* BRANCHES */}
      {page === "branches" && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 960, margin: "0 auto" }}>
          <div className="vl-accent-bar" />
          <h1 style={{ fontSize: "clamp(28px, 4vw, 48px)", fontWeight: 800, marginBottom: 40 }}>{t.branchesTitle}</h1>
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {profile.branches.map((b) => (
              <div key={b.id} className="vl-card vl-card-border" style={{ padding: 24 }}>
                <h2 style={{ fontWeight: 700, fontSize: 17, marginBottom: 14 }}>{b.name}</h2>
                {b.address && (
                  <p style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 14, color: "#64748b", marginBottom: 8 }}>
                    <MapPin size={14} style={{ color: primary, flexShrink: 0, marginTop: 1 }} />
                    {b.address.startsWith("http") ? (
                      <a href={b.address} target="_blank" rel="noopener noreferrer" style={{ color: primary }}>{t.viewOnMap}</a>
                    ) : b.address}
                  </p>
                )}
                {b.phone && (
                  <p style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#64748b" }}>
                    <Phone size={14} style={{ color: primary, flexShrink: 0 }} />
                    <a href={`tel:${b.phone}`} style={{ color: "#475569", textDecoration: "none" }}>{b.phone}</a>
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* CONTACT */}
      {page === "contact" && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "grid", gap: 56, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
            <div>
              <div className="vl-accent-bar" />
              <h1 style={{ fontSize: "clamp(26px, 3.5vw, 40px)", fontWeight: 800, marginBottom: 28 }}>{t.contactTitle}</h1>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {profile.phone && (
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ width: 42, height: 42, background: `${primary}15`, borderRadius: 10, display: "grid", placeItems: "center" }}>
                      <Phone size={18} style={{ color: primary }} />
                    </div>
                    <a href={`tel:${profile.phone}`} style={{ fontSize: 15, color: "#0f172a", textDecoration: "none", fontWeight: 500 }}>{profile.phone}</a>
                  </div>
                )}
                {profile.address && (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                    <div style={{ width: 42, height: 42, background: `${primary}15`, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0 }}>
                      <MapPin size={18} style={{ color: primary }} />
                    </div>
                    <p style={{ fontSize: 15, color: "#475569", marginTop: 10 }}>{profile.address}</p>
                  </div>
                )}
              </div>
              <p style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: "#94a3b8", marginTop: 24, lineHeight: 1.6 }}>
                <ShieldCheck size={13} style={{ flexShrink: 0, marginTop: 1 }} />{t.contactDisclaimer}
              </p>
            </div>
            {formSuccess === "contact" ? (
              <VelocitySuccess t={t} primary={primary} onReset={() => setFormSuccess(null)} />
            ) : (
              <form
                style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 32, borderLeft: `4px solid ${primary}` }}
                onSubmit={(e) => onSubmit(e, "contact")}
              >
                <VelocityFormFields form={form} setForm={setForm} t={t} isSubmitting={isSubmitting} submitLabel={t.sendMessage} primary={primary} turnstileSiteKey={turnstileSiteKey} />
              </form>
            )}
          </div>
        </section>
      )}

      {/* LEGAL */}
      {(page === "privacy" || page === "terms" || page === "data-deletion") && (
        <section style={{ padding: "56px 24px 72px", maxWidth: 760, margin: "0 auto" }}>
          <div className="vl-accent-bar" />
          <h1 style={{ fontSize: "clamp(24px, 3.5vw, 36px)", fontWeight: 800, marginBottom: 24 }}>
            {page === "privacy" ? t.privacyTitle : page === "terms" ? t.termsTitle : t.dataDeletionTitle}
          </h1>
          <p style={{ fontSize: 15, color: "#64748b", lineHeight: 1.85 }}>
            {page === "privacy" ? site.legal.privacyPolicy : page === "terms" ? site.legal.terms : site.legal.dataDeletion}
          </p>
        </section>
      )}

      {/* Footer */}
      <footer className="vl-footer" style={{ padding: "52px 24px" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 40, justifyContent: "space-between", marginBottom: 36 }}>
            <div>
              {profile.logoUrl ? (
                <img src={profile.logoUrl} alt={profile.dealershipName} style={{ height: 30, width: "auto", objectFit: "contain", opacity: 0.7, marginBottom: 8 }} />
              ) : (
                <p style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9", marginBottom: 6 }}>{profile.dealershipName}</p>
              )}
              {profile.phone && (
                <p style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 8 }}>
                  <Phone size={13} style={{ color: primary }} />
                  <a href={`tel:${profile.phone}`} style={{ color: "#94a3b8", textDecoration: "none" }}>{profile.phone}</a>
                </p>
              )}
            </div>
            <nav style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
              {navLinks.map(([label, href]) => (
                <a key={label} href={href} style={{ fontSize: 13, color: "#64748b", textDecoration: "none" }}>{label}</a>
              ))}
            </nav>
          </div>
          <div style={{ borderTop: "1px solid #1e293b", paddingTop: 24, display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#475569" }}>
            <p>© {new Date().getFullYear()} {profile.dealershipName}</p>
            <div style={{ display: "flex", gap: 20 }}>
              <a href="/privacy" style={{ color: "#475569", textDecoration: "none" }}>{t.footerPrivacy}</a>
              <a href="/terms" style={{ color: "#475569", textDecoration: "none" }}>{t.footerTerms}</a>
              <a href="/data-deletion" style={{ color: "#475569", textDecoration: "none" }}>{t.footerDataDeletion}</a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}

function VelocityVehicleGrid({ vehicles, primary, secondary, formatPrice, noVehiclesLabel }: {
  vehicles: PublicVehicle[];
  primary: string;
  secondary: string;
  formatPrice: (p: number | null) => string;
  noVehiclesLabel: string;
}) {
  if (!vehicles.length) {
    return (
      <div style={{ border: "2px dashed #e2e8f0", borderRadius: 10, padding: 64, textAlign: "center", color: "#94a3b8" }}>
        {noVehiclesLabel}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
      {vehicles.map((v) => (
        <a key={v.id} href={`/inventory/${v.slug}`} className="vl-card">
          <div style={{ aspectRatio: "16/10", overflow: "hidden", background: "#f1f5f9", position: "relative" }}>
            {v.imageUrls[0] ? (
              <img src={v.imageUrls[0]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform 0.4s ease", display: "block" }}
                onMouseEnter={e => (e.currentTarget.style.transform = "scale(1.04)")}
                onMouseLeave={e => (e.currentTarget.style.transform = "scale(1)")}
              />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "#cbd5e1" }}>
                <Car size={40} />
              </div>
            )}
            <span style={{ position: "absolute", top: 10, left: 10, background: `${primary}e8`, color: "#fff", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 100 }}>
              {v.status}
            </span>
          </div>
          <div style={{ padding: "16px 18px", borderLeft: `3px solid ${primary}` }}>
            <h3 style={{ fontWeight: 700, fontSize: 16, color: "#0f172a", marginBottom: 4 }}>
              {v.year} {v.make} {v.model}
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {[v.trim, v.mileage ? `${v.mileage.toLocaleString()} km` : null, v.transmission].filter(Boolean).map((spec) => (
                <span key={spec} style={{ background: "#f1f5f9", color: "#64748b", fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 100 }}>{spec}</span>
              ))}
            </div>
            <p style={{ fontWeight: 800, fontSize: 18, color: primary }}>{formatPrice(v.price)}</p>
          </div>
        </a>
      ))}
    </div>
  );
}

function VelocitySuccess({ t, primary, onReset }: { t: SiteStrings; primary: string; onReset: () => void }) {
  return (
    <div style={{ border: `1px solid ${primary}30`, background: `${primary}08`, borderRadius: 10, padding: 40, textAlign: "center", marginTop: 24 }}>
      <CheckCircle2 size={40} style={{ color: primary, margin: "0 auto 14px" }} />
      <h3 style={{ fontWeight: 700, fontSize: 20, marginBottom: 8 }}>{t.thankYou}</h3>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>{t.messageReceived}</p>
      <button onClick={onReset} style={{ background: primary, color: "#fff", border: "none", borderRadius: 6, padding: "10px 24px", fontWeight: 600, cursor: "pointer" }}>
        {t.sendAnother}
      </button>
    </div>
  );
}

function VelocityFormFields({ form, setForm, t, isSubmitting, submitLabel, primary, turnstileSiteKey }: {
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
        <input required value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} placeholder={t.placeholderFirstName} className="vl-input" />
        <input value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} placeholder={t.placeholderLastName} className="vl-input" />
      </div>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(3, 1fr)" }}>
        <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder={t.placeholderEmail} className="vl-input" />
        <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder={t.placeholderPhone} className="vl-input" />
        <input value={form.whatsapp} onChange={e => setForm({ ...form, whatsapp: e.target.value })} placeholder={t.placeholderWhatsApp} className="vl-input" />
      </div>
      <textarea value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} placeholder={t.placeholderMessage} rows={4} className="vl-input" style={{ resize: "none" }} />
      <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#94a3b8" }}>
        <Mail size={12} style={{ flexShrink: 0 }} /> {t.contactMethodHint}
      </p>
      <TurnstileWidget siteKey={turnstileSiteKey} theme="light" />
      <button
        type="submit"
        disabled={isSubmitting}
        className="vl-btn vl-btn-primary"
        style={{ justifyContent: "center", padding: "12px 24px" }}
      >
        {submitLabel}
      </button>
    </div>
  );
}
