"use client";

import Link from "next/link";
import { ArrowRight, Car, CheckCircle2, Globe2, Mail, MapPin, Menu, Phone, ShieldCheck, X } from "lucide-react";
import type { ThemeProps, PublicVehicle, FormState, SiteStrings } from "./theme-props";

export function PrestigeTheme(props: ThemeProps) {
  const {
    site, page, detailVehicle, lang, isArabic, dir, showLangToggle, isPreviewMode,
    form, setForm, setSelectedVehicleId, isSubmitting, formSuccess, setFormSuccess,
    onSubmit, onToggleLang, mobileNavOpen, setMobileNavOpen,
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
    <main dir={dir} style={{ backgroundColor: "#080808", color: "#f0f0f0" }}>
      <style>{`
        .pt-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 50; background: rgba(8,8,8,0.82); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid rgba(255,255,255,0.06); }
        .pt-card { background: #111; border: 1px solid #1e1e1e; border-radius: 4px; }
        .pt-card-vehicle { background: #111; border-radius: 4px; overflow: hidden; position: relative; }
        .pt-card-vehicle:hover .pt-vehicle-img { transform: scale(1.04); filter: brightness(1.1); }
        .pt-vehicle-img { transition: transform 0.6s cubic-bezier(0.25,0.46,0.45,0.94), filter 0.4s ease; width: 100%; height: 100%; object-fit: cover; display: block; }
        .pt-card-vehicle:hover { box-shadow: 0 20px 56px rgba(0,0,0,0.7); transform: translateY(-3px); transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .pt-card-vehicle { transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .pt-input { background: #141414; border: 1px solid #272727; color: #f0f0f0; border-radius: 4px; padding: 10px 14px; font-size: 14px; width: 100%; outline: none; transition: border-color 0.2s; }
        .pt-input:focus { border-color: ${primary}; }
        .pt-input::placeholder { color: #555; }
        .pt-divider { border-top: 1px solid #1a1a1a; }
        .pt-label { font-size: 10px; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; color: ${primary}; }
        .pt-muted { color: #888; }
        .pt-btn-primary { background: ${primary}; color: #fff; border: none; border-radius: 4px; padding: 12px 32px; font-size: 13px; font-weight: 600; letter-spacing: 0.15em; text-transform: uppercase; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; text-decoration: none; transition: opacity 0.2s; }
        .pt-btn-primary:hover { opacity: 0.85; }
        .pt-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .pt-btn-outline { background: transparent; color: #ccc; border: 1px solid #333; border-radius: 4px; padding: 12px 32px; font-size: 13px; font-weight: 600; letter-spacing: 0.15em; text-transform: uppercase; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; text-decoration: none; transition: border-color 0.2s, color 0.2s; }
        .pt-btn-outline:hover { border-color: ${primary}; color: #fff; }
        .pt-nav-link { font-size: 11px; font-weight: 500; letter-spacing: 0.2em; text-transform: uppercase; color: #888; text-decoration: none; transition: color 0.2s; }
        .pt-nav-link:hover { color: #fff; }
        .pt-footer { background: #040404; border-top: 1px solid #161616; }
        .pt-spec-item { background: #141414; border: 1px solid #1e1e1e; border-radius: 3px; padding: 10px 12px; }
        @keyframes pt-rise { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: translateY(0); } }
        .pt-hero-text { animation: pt-rise 0.9s ease forwards; }
        .pt-hero-sub { animation: pt-rise 0.9s 0.15s ease both; }
        .pt-hero-cta { animation: pt-rise 0.9s 0.3s ease both; }
        .pt-tag { background: ${primary}; color: #fff; font-size: 10px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; padding: 3px 8px; border-radius: 2px; }
      `}</style>

      {/* Header */}
      <header className="pt-nav">
        {isPreviewMode && (
          <div style={{ background: "rgba(120,80,0,0.3)", borderBottom: "1px solid rgba(180,120,0,0.25)", padding: "7px 16px", textAlign: "center", fontSize: 12, fontWeight: 500, color: "#f5c842" }}>
            {t.previewBanner}
          </div>
        )}
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "0 24px", height: 64 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none" }}>
            {profile.logoUrl ? (
              <img src={profile.logoUrl} alt={profile.dealershipName} style={{ height: 36, width: "auto", maxWidth: 140, objectFit: "contain" }} />
            ) : (
              <>
                <div style={{ width: 36, height: 36, background: primary, borderRadius: 4, display: "grid", placeItems: "center" }}>
                  <Car size={16} color="#fff" />
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#fff" }}>{profile.dealershipName}</span>
              </>
            )}
          </Link>

          <nav style={{ display: "flex", gap: 32, alignItems: "center" }} className="hidden-mobile">
            {navLinks.map(([label, href]) => (
              <a key={label} href={href} className="pt-nav-link">{label}</a>
            ))}
          </nav>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {showLangToggle && (
              <button onClick={onToggleLang} style={{ background: "none", border: "1px solid #333", borderRadius: 4, padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 11, letterSpacing: "0.1em", color: "#888" }}>
                <Globe2 size={13} />
                {lang === "en" ? "عربي" : "EN"}
              </button>
            )}
            <a href="/contact" className="pt-btn-primary" style={{ padding: "8px 20px", fontSize: 11 }}>
              {t.nav.contact}
            </a>
            <button
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
              style={{ display: "none", background: "none", border: "none", cursor: "pointer", color: "#ccc", padding: 4 }}
              className="show-mobile"
            >
              {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        <style>{`
          @media (max-width: 1023px) { .hidden-mobile { display: none !important; } .show-mobile { display: block !important; } }
          @media (min-width: 1024px) { .show-mobile { display: none !important; } }
        `}</style>

        {mobileNavOpen && (
          <div style={{ borderTop: "1px solid #1a1a1a", padding: "8px 0 12px" }}>
            {navLinks.map(([label, href]) => (
              <a
                key={label} href={href}
                className="pt-nav-link"
                onClick={() => setMobileNavOpen(false)}
                style={{ display: "block", padding: "10px 24px" }}
              >
                {label}
              </a>
            ))}
          </div>
        )}
      </header>

      {/* HOME */}
      {(page === "home" || page === "") && (
        <>
          {/* Hero */}
          <section style={{ position: "relative", minHeight: "100vh", display: "flex", alignItems: "center" }}>
            {featuredVehicles[0]?.imageUrls[0] ? (
              <img
                src={featuredVehicles[0].imageUrls[0]}
                alt=""
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "brightness(0.55)" }}
              />
            ) : (
              <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%)" }} />
            )}
            <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to right, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.2) 100%)` }} />
            <div style={{ position: "relative", zIndex: 10, maxWidth: 1280, margin: "0 auto", padding: "120px 24px 80px", width: "100%" }}>
              <p className="pt-label pt-hero-text" style={{ marginBottom: 16 }}>{profile.dealershipName}</p>
              <h1 className="pt-hero-text" style={{ fontSize: "clamp(42px, 6vw, 88px)", fontWeight: 900, lineHeight: 1.0, letterSpacing: "-0.02em", color: "#fff", maxWidth: 680, marginBottom: 20 }}>
                {profile.heroTitle ?? "Drive Excellence"}
              </h1>
              <p className="pt-hero-sub pt-muted" style={{ fontSize: "clamp(15px, 1.8vw, 18px)", maxWidth: 500, lineHeight: 1.7, marginBottom: 40 }}>
                {profile.heroSubtitle ?? "Discover our curated collection of premium vehicles."}
              </p>
              <div className="pt-hero-cta" style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                <a href="/inventory" className="pt-btn-primary">
                  {t.browseInventory}
                  <ArrowRight size={14} style={isArabic ? { transform: "rotate(180deg)" } : {}} />
                </a>
                <a href="/contact" className="pt-btn-outline">{t.contactSales}</a>
              </div>
            </div>
            <div style={{ position: "absolute", bottom: 32, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, opacity: 0.3 }}>
              <div style={{ width: 1, height: 48, background: `linear-gradient(to bottom, transparent, ${primary})` }} />
            </div>
          </section>

          {/* Featured */}
          <section style={{ maxWidth: 1280, margin: "0 auto", padding: "80px 24px" }}>
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 48 }}>
              <div>
                <p className="pt-label" style={{ marginBottom: 10 }}>{t.featuredVehicles}</p>
                <h2 style={{ fontSize: "clamp(28px, 3.5vw, 42px)", fontWeight: 900, color: "#fff", lineHeight: 1.1 }}>{t.featuredVehicles}</h2>
              </div>
              <a href="/inventory" className="pt-label" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}>
                {t.viewAll} <ArrowRight size={11} style={isArabic ? { transform: "rotate(180deg)" } : {}} />
              </a>
            </div>
            <PrestigeVehicleGrid vehicles={featuredVehicles} primary={primary} formatPrice={formatPrice} noVehiclesLabel={t.noVehicles} />
          </section>

          {/* Contact strip */}
          <section className="pt-divider" style={{ padding: "0 24px" }}>
            <div style={{ maxWidth: 1280, margin: "0 auto", padding: "60px 0", display: "grid", gap: 32, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
              {profile.phone && (
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 40, height: 40, background: primary, borderRadius: 4, display: "grid", placeItems: "center", flexShrink: 0 }}>
                    <Phone size={16} color="#fff" />
                  </div>
                  <div>
                    <p className="pt-label" style={{ marginBottom: 4 }}>Call us</p>
                    <a href={`tel:${profile.phone}`} style={{ color: "#fff", fontWeight: 600, fontSize: 14, textDecoration: "none" }}>{profile.phone}</a>
                  </div>
                </div>
              )}
              {profile.address && (
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 40, height: 40, background: primary, borderRadius: 4, display: "grid", placeItems: "center", flexShrink: 0 }}>
                    <MapPin size={16} color="#fff" />
                  </div>
                  <div>
                    <p className="pt-label" style={{ marginBottom: 4 }}>Visit us</p>
                    <p style={{ color: "#fff", fontWeight: 600, fontSize: 14 }}>{profile.address}</p>
                  </div>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 40, height: 40, background: primary, borderRadius: 4, display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Mail size={16} color="#fff" />
                </div>
                <div>
                  <p className="pt-label" style={{ marginBottom: 4 }}>Get in touch</p>
                  <a href="/contact" style={{ color: "#fff", fontWeight: 600, fontSize: 14, textDecoration: "none" }}>{t.nav.contact}</a>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {/* INVENTORY LIST */}
      {page === "inventory" && !detailVehicle && (
        <section style={{ paddingTop: 96, paddingBottom: 80, maxWidth: 1280, margin: "0 auto", padding: "96px 24px 80px" }}>
          <p className="pt-label" style={{ marginBottom: 12 }}>{profile.dealershipName}</p>
          <h1 style={{ fontSize: "clamp(32px, 4.5vw, 56px)", fontWeight: 900, color: "#fff", marginBottom: 10 }}>{t.inventoryTitle}</h1>
          <p className="pt-muted" style={{ fontSize: 15, marginBottom: 48 }}>{t.inventorySub}</p>
          <PrestigeVehicleGrid vehicles={vehicles} primary={primary} formatPrice={formatPrice} noVehiclesLabel={t.noVehicles} />
        </section>
      )}

      {/* VEHICLE DETAIL */}
      {page === "inventory" && detailVehicle && (
        <section style={{ paddingTop: 96, paddingBottom: 80, maxWidth: 1280, margin: "0 auto", padding: "96px 24px 80px" }}>
          <div style={{ display: "grid", gap: 48, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
            <div style={{ borderRadius: 4, overflow: "hidden", background: "#111", aspectRatio: "4/3" }}>
              {detailVehicle.imageUrls[0] ? (
                <img src={detailVehicle.imageUrls[0]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "#555" }}>
                  <Car size={48} />
                </div>
              )}
            </div>
            <div>
              <span className="pt-tag">{detailVehicle.status}</span>
              <h1 style={{ fontSize: "clamp(28px, 3.5vw, 44px)", fontWeight: 900, color: "#fff", marginTop: 16, lineHeight: 1.1 }}>
                {detailVehicle.year} {detailVehicle.make}
              </h1>
              <p style={{ fontSize: "clamp(18px, 2vw, 24px)", color: "#888", fontWeight: 300 }}>
                {detailVehicle.model} {detailVehicle.trim}
              </p>
              <p style={{ fontSize: "clamp(24px, 3vw, 36px)", fontWeight: 900, color: primary, marginTop: 20 }}>
                {formatPrice(detailVehicle.price)}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 28 }}>
                {([
                  [t.mileage, detailVehicle.mileage ? `${detailVehicle.mileage.toLocaleString()} km` : null],
                  [t.transmission, detailVehicle.transmission],
                  [t.fuelType, detailVehicle.fuelType],
                  [t.color, detailVehicle.exteriorColor],
                ] as [string, string | null][]).filter(([, v]) => v).map(([label, value]) => (
                  <div key={label} className="pt-spec-item">
                    <p style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "#666", marginBottom: 4 }}>{label}</p>
                    <p style={{ fontWeight: 700, fontSize: 14, color: "#e0e0e0" }}>{value}</p>
                  </div>
                ))}
              </div>

              {formSuccess === "vehicle_inquiry" ? (
                <PrestigeSuccess t={t} primary={primary} onReset={() => setFormSuccess(null)} />
              ) : (
                <form
                  style={{ marginTop: 32, background: "#111", border: "1px solid #1e1e1e", borderRadius: 4, padding: 24 }}
                  onSubmit={(e) => { setSelectedVehicleId(detailVehicle.id); onSubmit(e, "vehicle_inquiry"); }}
                >
                  <h2 style={{ fontWeight: 700, color: "#fff", marginBottom: 16 }}>{t.askAbout}</h2>
                  <PrestigeFormFields form={form} setForm={setForm} t={t} isSubmitting={isSubmitting} submitLabel={t.sendInquiry} primary={primary} />
                </form>
              )}
            </div>
          </div>
        </section>
      )}

      {/* FINANCE */}
      {page === "finance" && (
        <section style={{ paddingTop: 96, paddingBottom: 80, maxWidth: 760, margin: "0 auto", padding: "96px 24px 80px" }}>
          <p className="pt-label" style={{ marginBottom: 12 }}>{profile.dealershipName}</p>
          <h1 style={{ fontSize: "clamp(32px, 4vw, 52px)", fontWeight: 900, color: "#fff", marginBottom: 12 }}>{t.financeTitle}</h1>
          {site.legal.financingDisclaimer && (
            <p className="pt-muted" style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 40 }}>{site.legal.financingDisclaimer}</p>
          )}
          {formSuccess === "financing" ? (
            <PrestigeSuccess t={t} primary={primary} onReset={() => setFormSuccess(null)} />
          ) : (
            <form
              style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 4, padding: 28 }}
              onSubmit={(e) => onSubmit(e, "financing")}
            >
              <PrestigeFormFields form={form} setForm={setForm} t={t} isSubmitting={isSubmitting} submitLabel={t.requestFinancing} primary={primary} />
            </form>
          )}
        </section>
      )}

      {/* BRANCHES */}
      {page === "branches" && (
        <section style={{ paddingTop: 96, paddingBottom: 80, maxWidth: 900, margin: "0 auto", padding: "96px 24px 80px" }}>
          <p className="pt-label" style={{ marginBottom: 12 }}>{profile.dealershipName}</p>
          <h1 style={{ fontSize: "clamp(32px, 4vw, 52px)", fontWeight: 900, color: "#fff", marginBottom: 48 }}>{t.branchesTitle}</h1>
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {profile.branches.map((b) => (
              <div key={b.id} className="pt-card" style={{ padding: 24 }}>
                <h2 style={{ fontWeight: 700, color: "#fff", fontSize: 17, marginBottom: 16 }}>{b.name}</h2>
                {b.address && (
                  <p style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 14, color: "#888", marginBottom: 10 }}>
                    <MapPin size={15} style={{ color: primary, flexShrink: 0, marginTop: 1 }} />
                    {b.address.startsWith("http") ? (
                      <a href={b.address} target="_blank" rel="noopener noreferrer" style={{ color: primary, textDecoration: "none" }}>{t.viewOnMap}</a>
                    ) : b.address}
                  </p>
                )}
                {b.phone && (
                  <p style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#888" }}>
                    <Phone size={14} style={{ color: primary, flexShrink: 0 }} />
                    <a href={`tel:${b.phone}`} style={{ color: "#ccc", textDecoration: "none" }}>{b.phone}</a>
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* CONTACT */}
      {page === "contact" && (
        <section style={{ paddingTop: 96, paddingBottom: 80, maxWidth: 1100, margin: "0 auto", padding: "96px 24px 80px" }}>
          <div style={{ display: "grid", gap: 56, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
            <div>
              <p className="pt-label" style={{ marginBottom: 12 }}>{profile.dealershipName}</p>
              <h1 style={{ fontSize: "clamp(28px, 3.5vw, 44px)", fontWeight: 900, color: "#fff", marginBottom: 32 }}>{t.contactTitle}</h1>
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                {profile.phone && (
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ width: 40, height: 40, background: primary, borderRadius: 4, display: "grid", placeItems: "center", flexShrink: 0 }}>
                      <Phone size={16} color="#fff" />
                    </div>
                    <a href={`tel:${profile.phone}`} style={{ color: "#fff", textDecoration: "none", fontSize: 15 }}>{profile.phone}</a>
                  </div>
                )}
                {profile.address && (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                    <div style={{ width: 40, height: 40, background: primary, borderRadius: 4, display: "grid", placeItems: "center", flexShrink: 0 }}>
                      <MapPin size={16} color="#fff" />
                    </div>
                    <p style={{ color: "#ccc", fontSize: 15, marginTop: 10 }}>{profile.address}</p>
                  </div>
                )}
              </div>
              <p style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: "#555", marginTop: 28, lineHeight: 1.6 }}>
                <ShieldCheck size={13} style={{ flexShrink: 0, marginTop: 2 }} />{t.contactDisclaimer}
              </p>
            </div>
            {formSuccess === "contact" ? (
              <PrestigeSuccess t={t} primary={primary} onReset={() => setFormSuccess(null)} />
            ) : (
              <form
                style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 4, padding: 32 }}
                onSubmit={(e) => onSubmit(e, "contact")}
              >
                <PrestigeFormFields form={form} setForm={setForm} t={t} isSubmitting={isSubmitting} submitLabel={t.sendMessage} primary={primary} />
              </form>
            )}
          </div>
        </section>
      )}

      {/* LEGAL */}
      {(page === "privacy" || page === "terms" || page === "data-deletion") && (
        <section style={{ paddingTop: 96, paddingBottom: 80, maxWidth: 760, margin: "0 auto", padding: "96px 24px 80px" }}>
          <h1 style={{ fontSize: "clamp(26px, 3.5vw, 40px)", fontWeight: 900, color: "#fff", marginBottom: 28 }}>
            {page === "privacy" ? t.privacyTitle : page === "terms" ? t.termsTitle : t.dataDeletionTitle}
          </h1>
          <p className="pt-muted" style={{ fontSize: 15, lineHeight: 1.9 }}>
            {page === "privacy" ? site.legal.privacyPolicy : page === "terms" ? site.legal.terms : site.legal.dataDeletion}
          </p>
        </section>
      )}

      {/* Footer */}
      <footer className="pt-footer" style={{ padding: "48px 24px" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20, alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            {profile.logoUrl ? (
              <img src={profile.logoUrl} alt={profile.dealershipName} style={{ height: 28, width: "auto", objectFit: "contain", opacity: 0.6 }} />
            ) : (
              <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.25em", textTransform: "uppercase", color: "#555" }}>{profile.dealershipName}</p>
            )}
            <p className="pt-label" style={{ marginTop: 2 }}>Premium Automobiles</p>
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            {[["Privacy", "/privacy", t.footerPrivacy], ["Terms", "/terms", t.footerTerms], ["Data", "/data-deletion", t.footerDataDeletion]].map(([, href, label]) => (
              <a key={href} href={href} style={{ fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", color: "#444", textDecoration: "none" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#888")}
                onMouseLeave={e => (e.currentTarget.style.color = "#444")}>
                {label}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </main>
  );
}

function PrestigeVehicleGrid({ vehicles, primary, formatPrice, noVehiclesLabel }: {
  vehicles: PublicVehicle[];
  primary: string;
  formatPrice: (p: number | null) => string;
  noVehiclesLabel: string;
}) {
  if (!vehicles.length) {
    return (
      <div style={{ border: "1px dashed #2a2a2a", borderRadius: 4, padding: 64, textAlign: "center", color: "#444" }}>
        {noVehiclesLabel}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
      {vehicles.map((v) => (
        <a key={v.id} href={`/inventory/${v.slug}`} className="pt-card-vehicle" style={{ display: "block", textDecoration: "none" }}>
          <div style={{ aspectRatio: "16/10", overflow: "hidden", position: "relative", background: "#1a1a1a" }}>
            {v.imageUrls[0] ? (
              <img src={v.imageUrls[0]} alt="" className="pt-vehicle-img" />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "#333" }}>
                <Car size={40} />
              </div>
            )}
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.82) 0%, transparent 55%)" }} />
            <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 16 }}>
              <p style={{ color: "#fff", fontWeight: 900, fontSize: 17, lineHeight: 1.2 }}>{v.year} {v.make} {v.model}</p>
              {v.trim && <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, marginTop: 2 }}>{v.trim}</p>}
            </div>
            <span style={{ position: "absolute", top: 12, right: 12, background: primary, color: "#fff", fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", padding: "3px 7px", borderRadius: 2 }}>{v.status}</span>
          </div>
          <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p style={{ fontWeight: 900, fontSize: 17, color: primary }}>{formatPrice(v.price)}</p>
            {v.mileage && <p style={{ fontSize: 12, color: "#555" }}>{v.mileage.toLocaleString()} km</p>}
          </div>
        </a>
      ))}
    </div>
  );
}

function PrestigeSuccess({ t, primary, onReset }: { t: SiteStrings; primary: string; onReset: () => void }) {
  return (
    <div style={{ border: "1px solid #1e1e1e", background: "#111", borderRadius: 4, padding: 40, textAlign: "center", marginTop: 32 }}>
      <CheckCircle2 size={40} style={{ color: primary, margin: "0 auto 16px" }} />
      <h3 style={{ color: "#fff", fontWeight: 700, fontSize: 20, marginBottom: 8 }}>{t.thankYou}</h3>
      <p style={{ color: "#888", fontSize: 14, marginBottom: 24 }}>{t.messageReceived}</p>
      <button onClick={onReset} className="pt-btn-primary">{t.sendAnother}</button>
    </div>
  );
}

function PrestigeFormFields({ form, setForm, t, isSubmitting, submitLabel, primary }: {
  form: FormState;
  setForm: (f: FormState) => void;
  t: SiteStrings;
  isSubmitting: boolean;
  submitLabel: string;
  primary: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        <input required value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} placeholder={t.placeholderFirstName} className="pt-input" />
        <input value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} placeholder={t.placeholderLastName} className="pt-input" />
      </div>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(3, 1fr)" }}>
        <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder={t.placeholderEmail} className="pt-input" />
        <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder={t.placeholderPhone} className="pt-input" />
        <input value={form.whatsapp} onChange={e => setForm({ ...form, whatsapp: e.target.value })} placeholder={t.placeholderWhatsApp} className="pt-input" />
      </div>
      <textarea value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} placeholder={t.placeholderMessage} rows={4} className="pt-input" style={{ resize: "none" }} />
      <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#555", letterSpacing: "0.05em" }}>
        <Mail size={11} style={{ flexShrink: 0 }} /> {t.contactMethodHint}
      </p>
      <button type="submit" disabled={isSubmitting} className="pt-btn-primary" style={{ marginTop: 4, justifyContent: "center" }}>
        {submitLabel}
      </button>
    </div>
  );
}
