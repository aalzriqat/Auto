"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState, type CSSProperties } from "react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { SiteVisitorTracker } from "@/components/analytics/SiteVisitorTracker";
import "./landing.css";
import {
  ACCT,
  ACCT_FEATURES,
  BAND,
  CALC,
  FAQS,
  FAQ_HEAD,
  FLOOR,
  FLOOR_LAYOUT,
  FLOW,
  FLOW_STEPS,
  FOOTER,
  GROW,
  HERO,
  IMG,
  INTEGRATIONS,
  JOURNAL_FULL,
  JOURNAL_SHORT,
  MANAGER_POINTS,
  NAV,
  NAV_LINKS,
  OWNER_POINTS,
  PIPE_COLUMNS,
  PLAN_MONTHLY,
  PLAN_POINTS,
  PL_BARS,
  PRICING,
  QUEUE,
  RECEPTION_LOG,
  REDUCED_MOTION,
  ROLES,
  STATUS_LABEL,
  TRUST,
  VEHICLES,
  VOICES,
  VOICES_HEAD,
  pick,
  CURRENCY,
} from "./content";
import { DealSpine } from "./DealSpine";
import { amortize, fmt, money } from "./format";
import { useMotionPreference, useReveal, useScrollRail, useSmoothScroll, useTicker } from "./hooks";
import { AcctIcon, BlurIn, CheckIcon, Journal, Pill, SectionHead } from "./ui";

/**
 * Marketing landing page — v2 (SCRUM-323, port of the SCRUM-301 prototype).
 *
 * Surface: public landing for a dealership owner evaluating AutoFlow. Primary
 * job: understand in thirty seconds that this runs the whole showroom.
 * Dials: DESIGN_VARIANCE 7 / MOTION_INTENSITY 7 / VISUAL_DENSITY 3.
 *
 * Everything visual lives in ./landing.css, scoped under `.lv2` so nothing
 * leaks onto other routes once the stylesheet is loaded.
 */
export default function CreativeMarketingPage() {
  const { locale, setLocale, isRtl } = useLanguage();
  const motion = useMotionPreference();
  const reduced = motion.reduced;

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useSmoothScroll(reduced);
  useReveal(rootRef, reduced, locale);
  const scrolled = useScrollRail(trackRef, reduced);

  const L = (bi: { en: string; ar: string }) => pick(locale, bi);

  return (
    <div className="lv2" ref={rootRef} style={{ "--dirsign": isRtl ? -1 : 1 } as CSSProperties}>
      <SiteVisitorTracker path="/" />

      {/* ============================ NAV ============================ */}
      <nav className={scrolled ? "nav scrolled" : "nav"}>
        <div className="nav-pill">
          <Link className="brand" href="/" aria-label="AutoFlow">
            <Image className="brand-logo" src="/logo.png" alt="AutoFlow" width={1200} height={686} sizes="120px" priority />
          </Link>
          <div className="nav-links">
            {NAV_LINKS.map((n) => (
              <a key={n.href} href={n.href}>
                {L(n.label)}
              </a>
            ))}
          </div>
          <div className="nav-actions">
            <button
              type="button"
              className="lang-btn"
              onClick={() => setLocale(isRtl ? "en" : "ar")}
              aria-label={isRtl ? "Switch to English" : "التبديل إلى العربية"}
            >
              {isRtl ? "EN" : "عربي"}
            </button>
            <Link className="nav-signin" href="/sign-in">
              {L(NAV.signIn)}
            </Link>
            <Link className="nav-cta" href="/sign-up">
              {L(NAV.getStarted)}
            </Link>
          </div>
        </div>
      </nav>

      <div className="frame" id="top">
        {/* ============================ HERO ============================ */}
        <section className="hero">
          <div className="wrap">
            <DealSpine locale={locale} isRtl={isRtl} reduced={reduced} />

            <div className="hero-inner">
              <BlurIn key={locale} as="h1" text={L(HERO.title)} />
              <p className="lede reveal" style={{ "--d": "520ms" } as CSSProperties}>
                {L(HERO.lede)}
              </p>
              <div className="hero-cta reveal" style={{ "--d": "640ms" } as CSSProperties}>
                <Link className="btn btn-primary btn-lg" href="/sign-up">
                  {L(NAV.getStarted)}
                </Link>
                <a className="btn btn-ghost btn-lg" href="#workflow">
                  {L(HERO.demo)}
                </a>
              </div>
            </div>

            <div className="hero-car">
              <Image
                src={`${IMG}/hero-vehicle.webp`}
                alt=""
                width={2400}
                height={1600}
                priority
                sizes="(max-width: 990px) 100vw, 940px"
              />
            </div>

            <div className="trust reveal" style={{ "--d": "200ms" } as CSSProperties}>
              {TRUST.map((t) => (
                <span key={t.en}>{L(t)}</span>
              ))}
            </div>
          </div>
        </section>

        {/* ======================= VEHICLE FLOOR ======================= */}
        <section className="floor" id="inventory">
          <div className="wrap">
            <div className="floor-stage">
              <div className="floor-copy">
                <span className="eyebrow">{L(FLOOR.eyebrow)}</span>
                <BlurIn key={locale} text={L(FLOOR.title)} />
                <p className="lede reveal" style={{ "--d": "400ms" } as CSSProperties}>
                  {L(FLOOR.lede)}
                </p>
              </div>

              <div className="floor-cards">
                {VEHICLES.map((v, i) => {
                  const p = FLOOR_LAYOUT[i];
                  return (
                    <article
                      key={v.vin}
                      className="vcard"
                      style={
                        {
                          insetInlineStart: p.s,
                          top: p.t,
                          "--fx": `${p.fx}px`,
                          "--fy": `${p.fy}px`,
                          "--fr": `${p.r}deg`,
                          "--rr": `${p.rr}deg`,
                          "--d": `${p.d}ms`,
                        } as CSSProperties
                      }
                    >
                      <div className="vcard-img">
                        <Image src={`${IMG}/${v.img}`} alt="" width={1600} height={1200} sizes="216px" />
                      </div>
                      <div className="vcard-title">{L(v.name)}</div>
                      <div className="vcard-vin" dir="ltr">
                        {v.vin}
                      </div>
                      <div className="vcard-row">
                        <span className="vcard-price">{money(locale, v.price)}</span>
                        <Pill status={v.status}>{L(STATUS_LABEL[v.status])}</Pill>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
            <p className="floor-note">{L(FLOOR.note)}</p>
          </div>
        </section>

        {/* ========================= ROLE BENTO ========================= */}
        <span id="roles" className="anchor" aria-hidden="true" />
        <section className="bento" id="features">
          <div className="wrap">
            <SectionHead locale={locale} eyebrow={ROLES.eyebrow} title={ROLES.title} lede={ROLES.lede} />
            <div className="bento-grid">
              <OwnerCard locale={locale} />
              <ManagerCard locale={locale} />
              <SalesCard locale={locale} reduced={reduced} />
              <ReceptionCard locale={locale} />
              <AccountantCard locale={locale} />
            </div>
          </div>
        </section>

        {/* ========================== DEAL FLOW ========================= */}
        <section className="flow" id="workflow">
          <div className="wrap">
            <SectionHead locale={locale} eyebrow={FLOW.eyebrow} title={FLOW.title} lede={FLOW.lede} />
            <div className="flow-track" ref={trackRef}>
              {FLOW_STEPS.map((s, i) => (
                <div className="flow-step" key={s.title.en}>
                  <div className="flow-card">
                    <span className="flow-status">{L(s.status)}</span>
                    <h3>{L(s.title)}</h3>
                    <p>{L(s.body)}</p>
                  </div>
                  <div className="flow-dot">{i + 1}</div>
                </div>
              ))}
              {/* rail is LAST so :nth-child on .flow-step counts only the steps */}
              <div className="flow-rail">
                <i />
              </div>
            </div>
          </div>
        </section>

        {/* ========================= CALCULATOR ========================= */}
        <section className="calc" id="calculator">
          <div className="wrap">
            <SectionHead locale={locale} eyebrow={CALC.eyebrow} title={CALC.title} lede={CALC.lede} />
            <Calculator locale={locale} />
          </div>
        </section>

        {/* ========================= ACCOUNTING ========================= */}
        <span id="finance" className="anchor" aria-hidden="true" />
        <span id="analytics" className="anchor" aria-hidden="true" />
        <section className="acct" id="accounting">
          <div className="wrap">
            <div className="acct-grid">
              <div>
                <span className="eyebrow">{L(ACCT.eyebrow)}</span>
                <BlurIn key={locale} text={L(ACCT.title)} style={{ marginTop: 14 }} />
                <p className="lede reveal" style={{ "--d": "300ms", marginTop: 16, marginBottom: 30 } as CSSProperties}>
                  {L(ACCT.lede)}
                </p>
                <div className="feature-list">
                  {ACCT_FEATURES.map((f) => (
                    <div className="fitem reveal" key={f.icon} style={{ "--d": `${f.d}ms` } as CSSProperties}>
                      <span className="ficon">
                        <AcctIcon icon={f.icon} />
                      </span>
                      <div>
                        <h3>{L(f.title)}</h3>
                        <p>{L(f.body)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="post-demo reveal-scale" style={{ "--d": "120ms" } as CSSProperties}>
                <div className="post-src">
                  <Image src={`${IMG}/veh-02-sedan-silver.webp`} alt="" width={1600} height={1200} sizes="64px" />
                  <div>
                    <div className="post-src-title">{L(ACCT.saleCompleted)}</div>
                    <div className="post-src-amount">50,500</div>
                  </div>
                </div>
                <div className="post-arrow">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 4v15M6 13.5l6 6 6-6" />
                  </svg>
                </div>
                <div className="mini post-mini">
                  <Journal locale={locale} lines={JOURNAL_FULL} />
                  <span className="balanced">
                    <span>{L(ROLES.balanced)}</span> ✓
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===================== GROW / INTEGRATIONS ==================== */}
        <section className="integr" id="grow">
          <div className="wrap">
            <SectionHead locale={locale} eyebrow={GROW.eyebrow} title={GROW.title} lede={GROW.lede} />
            <IntegrationsCarousel locale={locale} reduced={reduced} />
          </div>
        </section>

        {/* =========================== VOICES =========================== */}
        <section className="voices">
          <div className="wrap">
            <SectionHead locale={locale} eyebrow={VOICES_HEAD.eyebrow} title={VOICES_HEAD.title} />
            <VoicesCarousel locale={locale} />
          </div>
        </section>

        {/* ========================== CTA BAND ========================== */}
        <section className="band">
          <div className="wrap">
            <div className="band-inner reveal-scale">
              <Image
                src={`${IMG}/delivery-handover.webp`}
                alt=""
                fill
                sizes="(max-width: 1180px) 100vw, 1132px"
                style={{ objectFit: "cover" }}
              />
              <div className="band-veil" />
              <div className="band-copy">
                <h2>{L(BAND.title)}</h2>
                <p>{L(BAND.body)}</p>
                <Link className="btn btn-primary btn-lg" href="/sign-up">
                  {L(NAV.getStarted)}
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* =========================== PRICING ========================== */}
        <section className="pricing" id="pricing">
          <div className="wrap">
            <Pricing locale={locale} />
          </div>
        </section>

        {/* ============================= FAQ ============================ */}
        <section className="wrap">
          <Faq locale={locale} />
        </section>

        {/* =========================== FOOTER =========================== */}
        <footer className="foot">
          <div className="wrap">
            <div className="foot-grid">
              <div>
                <Link className="brand brand-foot" href="/" aria-label="AutoFlow">
                  <Image className="brand-logo" src="/logo.png" alt="AutoFlow" width={1200} height={686} sizes="140px" />
                </Link>
                <p>{L(FOOTER.blurb)}</p>
              </div>
              <div>
                <h4>{L(FOOTER.product)}</h4>
                <ul>
                  <li><a href="#inventory">{L(FOOTER.inventory)}</a></li>
                  <li><a href="#features">{L(FOOTER.permissions)}</a></li>
                  <li><a href="#workflow">{L(FOOTER.dealFlow)}</a></li>
                  <li><a href="#accounting">{L(FOOTER.accounting)}</a></li>
                </ul>
              </div>
              <div>
                <h4>{L(FOOTER.grow)}</h4>
                <ul>
                  <li><a href="#grow">{L(FOOTER.dealerSite)}</a></li>
                  <li><a href="#grow">{L(FOOTER.socialInbox)}</a></li>
                  <li><a href="#grow">{L(FOOTER.teamChat)}</a></li>
                  <li><a href="#pricing">{L(FOOTER.pricing)}</a></li>
                </ul>
              </div>
              <div>
                <h4>{L(FOOTER.company)}</h4>
                <ul>
                  <li><Link href="/contact">{L(FOOTER.contact)}</Link></li>
                  <li><Link href="/privacy">{L(FOOTER.privacy)}</Link></li>
                  <li><Link href="/terms">{L(FOOTER.terms)}</Link></li>
                </ul>
              </div>
            </div>
          </div>
          <div className="wrap">
            <div className="foot-bottom">
              <span>{L(FOOTER.rights)}</span>
              <span>
                <Link href="/privacy">{L(FOOTER.privacy)}</Link>
                {" · "}
                <Link href="/terms">{L(FOOTER.terms)}</Link>
              </span>
            </div>
          </div>
        </footer>
      </div>

      {reduced ? (
        <div className="rm-note" role="status">
          <span>{L(REDUCED_MOTION.notice)}</span>
          <button type="button" onClick={motion.forceMotion}>
            {L(REDUCED_MOTION.play)}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ====================================================================== */
/* Role cards                                                              */
/* ====================================================================== */

function OwnerCard({ locale }: { locale: string }) {
  return (
    <article className="bcard span-3 reveal" style={{ "--d": "0ms" } as CSSProperties}>
      <div className="bcard-head">
        <h3>{pick(locale, ROLES.owner)}</h3>
        <span className="role-tag">{pick(locale, ROLES.ownerTag)}</span>
      </div>
      <ul>
        {OWNER_POINTS.map((p) => (
          <li key={p.en}>{pick(locale, p)}</li>
        ))}
      </ul>
      <div className="mini">
        <div className="bars">
          {PL_BARS.map((b, i) => (
            <div
              key={i}
              className={b.alt ? "bar alt" : "bar"}
              style={{ "--h": `${b.h}%`, "--d": `${b.d}ms` } as CSSProperties}
            />
          ))}
        </div>
        <div className="bars-axis">
          <span>{pick(locale, ROLES.plAxis)}</span>
          <span>{pick(locale, ROLES.pl)}</span>
        </div>
      </div>
    </article>
  );
}

function ManagerCard({ locale }: { locale: string }) {
  return (
    <article className="bcard span-3 reveal" style={{ "--d": "90ms" } as CSSProperties}>
      <div className="bcard-head">
        <h3>{pick(locale, ROLES.manager)}</h3>
        <span className="role-tag">{pick(locale, ROLES.managerTag)}</span>
      </div>
      <ul>
        {MANAGER_POINTS.map((p) => (
          <li key={p.en}>{pick(locale, p)}</li>
        ))}
      </ul>
      <div className="mini">
        {QUEUE.map((q) => (
          <div className="queue-row" key={q.what.en} style={{ "--d": `${q.d}ms` } as CSSProperties}>
            <Pill status={q.pill}>{pick(locale, q.tag)}</Pill>
            <strong>{pick(locale, q.what)}</strong>
            <span className="push-end" />
            <button className="mini-btn ok" type="button" tabIndex={-1} aria-hidden="true">
              {pick(locale, ROLES.approve)}
            </button>
            <button className="mini-btn no" type="button" tabIndex={-1} aria-hidden="true">
              {pick(locale, ROLES.reject)}
            </button>
          </div>
        ))}
      </div>
    </article>
  );
}

function SalesCard({ locale, reduced }: { locale: string; reduced: boolean }) {
  const [hot, setHot] = useState(-1);
  useTicker(1100, !reduced, () => setHot((h) => (h + 1) % PIPE_COLUMNS.length));
  return (
    <article className="bcard span-2 reveal" style={{ "--d": "0ms" } as CSSProperties}>
      <div className="bcard-head">
        <h3>{pick(locale, ROLES.sales)}</h3>
      </div>
      <p>{pick(locale, ROLES.salesBody)}</p>
      <div className="mini">
        <div className="pipe-mini">
          {PIPE_COLUMNS.map((c, i) => (
            <div className="pipe-col" key={c.label.en}>
              <b>{pick(locale, c.label)}</b>
              {Array.from({ length: c.chips }).map((_, j) => (
                <div key={j} className={j === 0 && i === hot ? "pipe-chip hot" : "pipe-chip"} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function ReceptionCard({ locale }: { locale: string }) {
  return (
    <article className="bcard span-2 reveal" style={{ "--d": "90ms" } as CSSProperties}>
      <div className="bcard-head">
        <h3>{pick(locale, ROLES.reception)}</h3>
      </div>
      <p>{pick(locale, ROLES.receptionBody)}</p>
      <div className="mini">
        {RECEPTION_LOG.map((l) => (
          <div className="log-line" key={l.time}>
            <span className="log-time">{l.time}</span>
            <span className="avatar-dot" style={{ background: l.color }}>
              {l.initial}
            </span>
            <span>{pick(locale, l.what)}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function AccountantCard({ locale }: { locale: string }) {
  return (
    <article className="bcard span-2 reveal" style={{ "--d": "180ms" } as CSSProperties}>
      <div className="bcard-head">
        <h3>{pick(locale, ROLES.accountant)}</h3>
      </div>
      <p>{pick(locale, ROLES.accountantBody)}</p>
      <div className="mini">
        <Journal locale={locale} lines={JOURNAL_SHORT} />
        <span className="balanced">
          <span>{pick(locale, ROLES.balanced)}</span> ✓
        </span>
      </div>
    </article>
  );
}

/* ====================================================================== */
/* Finance calculator                                                      */
/* ====================================================================== */

type RangeSpec = { min: number; max: number; step: number };
const R_VALUE: RangeSpec = { min: 6000, max: 120000, step: 500 };
const R_DOWN: RangeSpec = { min: 0, max: 60, step: 1 };
const R_RATE: RangeSpec = { min: 0, max: 16, step: 0.25 };
const R_TERM: RangeSpec = { min: 12, max: 84, step: 6 };

function pctOf(v: number, r: RangeSpec) {
  return `${((v - r.min) / (r.max - r.min)) * 100}%`;
}

function Range({
  id,
  label,
  output,
  value,
  spec,
  onChange,
}: {
  id: string;
  label: string;
  output: string;
  value: number;
  spec: RangeSpec;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <div className="field-top">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{output}</output>
      </div>
      <input
        type="range"
        id={id}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--pct": pctOf(value, spec) } as CSSProperties}
      />
    </div>
  );
}

function Calculator({ locale }: { locale: string }) {
  const [value, setValue] = useState(50500);
  const [downPct, setDownPct] = useState(20);
  const [apr, setApr] = useState(5.5);
  const [months, setMonths] = useState(60);
  const a = amortize(value, downPct, apr, months);
  const unit = locale === "ar" ? CURRENCY.ar : CURRENCY.en;

  return (
    <div className="calc-grid">
      <div className="panel reveal">
        <Range id="lv2-value" label={pick(locale, CALC.value)} output={money(locale, value)} value={value} spec={R_VALUE} onChange={setValue} />
        <Range
          id="lv2-down"
          label={pick(locale, CALC.down)}
          output={`${downPct}% · ${money(locale, (value * downPct) / 100)}`}
          value={downPct}
          spec={R_DOWN}
          onChange={setDownPct}
        />
        <Range id="lv2-rate" label={pick(locale, CALC.rate)} output={`${apr.toFixed(2)}%`} value={apr} spec={R_RATE} onChange={setApr} />
        <Range
          id="lv2-term"
          label={pick(locale, CALC.term)}
          output={`${months} ${pick(locale, CALC.months)}`}
          value={months}
          spec={R_TERM}
          onChange={setMonths}
        />
      </div>

      <div className="panel panel-dark reveal" style={{ "--d": "120ms" } as CSSProperties}>
        <h3>{pick(locale, CALC.monthly)}</h3>
        <div className="big">
          {fmt(a.monthly)} <small>{unit}</small>
        </div>
        <div className="breakdown">
          <div>
            <span>{pick(locale, CALC.principal)}</span>
            <span>{money(locale, a.principal)}</span>
          </div>
          <div>
            <span>{pick(locale, CALC.interest)}</span>
            <span>{money(locale, a.interest)}</span>
          </div>
          <div>
            <span>{pick(locale, CALC.total)}</span>
            <span>{money(locale, a.total)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ====================================================================== */
/* Integrations carousel                                                   */
/* ====================================================================== */

function ringOffset(i: number, index: number, n: number) {
  let off = i - index;
  if (off > n / 2) off -= n;
  if (off < -n / 2) off += n;
  return off;
}

function IntegrationsCarousel({ locale, reduced }: { locale: string; reduced: boolean }) {
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(0);
  const [swap, setSwap] = useState(false);
  const n = INTEGRATIONS.length;

  useTicker(2600, !reduced, () => {
    const next = (index + 1) % n;
    setIndex(next);
    setSwap(true);
    setTimeout(() => {
      setShown(next);
      setSwap(false);
    }, 300);
  });

  const item = INTEGRATIONS[shown];
  return (
    <>
      <div className="carousel">
        {INTEGRATIONS.map((it, i) => {
          const off = ringOffset(i, index, n);
          const pos = off >= -2 && off <= 2 ? String(off) : "hide";
          return (
            <div className="slot" key={it.name.en} data-pos={pos} aria-hidden={pos !== "0"}>
              <svg viewBox="0 0 24 24" fill={it.color} role="img" aria-label={pick(locale, it.name)}>
                <path d={it.d} />
              </svg>
            </div>
          );
        })}
      </div>
      <div className={swap ? "carousel-caption swap" : "carousel-caption"} aria-live="polite">
        <b>{pick(locale, item.name)}</b>
        <span>{pick(locale, item.sub)}</span>
      </div>
    </>
  );
}

/* ====================================================================== */
/* Voices                                                                  */
/* ====================================================================== */

function VoicesCarousel({ locale }: { locale: string }) {
  const [index, setIndex] = useState(0);
  const n = VOICES.length;
  return (
    <>
      <div className="voice-stage">
        {VOICES.map((v, i) => {
          const off = ringOffset(i, index, n);
          const pos = off >= -1 && off <= 1 ? String(off) : "hide";
          return (
            <article className="voice" key={v.who.en} data-pos={pos} aria-hidden={pos !== "0"}>
              <div className="voice-mark" aria-hidden="true">
                ”
              </div>
              <p>{pick(locale, v.quote)}</p>
              <div className="stars" aria-hidden="true">
                ★★★★★
              </div>
              <div className="who">{pick(locale, v.who)}</div>
              <div className="role">{pick(locale, v.role)}</div>
            </article>
          );
        })}
      </div>
      <div className="voice-nav">
        <button className="vnav" type="button" aria-label={pick(locale, VOICES_HEAD.prev)} onClick={() => setIndex((i) => (i - 1 + n) % n)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <button className="vnav" type="button" aria-label={pick(locale, VOICES_HEAD.next)} onClick={() => setIndex((i) => (i + 1) % n)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </>
  );
}

/* ====================================================================== */
/* Pricing + FAQ                                                           */
/* ====================================================================== */

function Pricing({ locale }: { locale: string }) {
  const [annual, setAnnual] = useState(false);
  const v = annual ? Math.round(PLAN_MONTHLY * 0.8) : PLAN_MONTHLY;
  return (
    <>
      <SectionHead locale={locale} eyebrow={PRICING.eyebrow} title={PRICING.title} lede={PRICING.lede}>
        <div className="toggle-wrap">
          <div className="toggle" role="group">
            <button type="button" className={annual ? "" : "on"} aria-pressed={!annual} onClick={() => setAnnual(false)}>
              {pick(locale, PRICING.monthly)}
            </button>
            <button type="button" className={annual ? "on" : ""} aria-pressed={annual} onClick={() => setAnnual(true)}>
              {pick(locale, PRICING.annual)}
            </button>
          </div>
        </div>
      </SectionHead>

      <div className="plan reveal-scale">
        <span className="plan-badge">{pick(locale, PRICING.badge)}</span>
        <h3 className="plan-name">{pick(locale, PRICING.plan)}</h3>
        <div className="amount">{money(locale, v)}</div>
        <div className="per">{pick(locale, annual ? PRICING.perMonthAnnual : PRICING.perMonth)}</div>
        <ul>
          {PLAN_POINTS.map((p) => (
            <li key={p.en}>
              <CheckIcon />
              <span>{pick(locale, p)}</span>
            </li>
          ))}
        </ul>
        <Link className="btn btn-primary btn-lg plan-cta" href="/sign-up">
          {pick(locale, PRICING.cta)}
        </Link>
      </div>
    </>
  );
}

function Faq({ locale }: { locale: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="faq" id="faq">
      <SectionHead locale={locale} title={FAQ_HEAD.title} lede={FAQ_HEAD.lede} style={{ marginBottom: 26 }} />
      {FAQS.map((f, i) => {
        const isOpen = open === i;
        const panelId = `lv2-faq-${i}`;
        return (
          <div className={isOpen ? "q open" : "q"} key={f.q.en}>
            <button type="button" aria-expanded={isOpen} aria-controls={panelId} onClick={() => setOpen(isOpen ? null : i)}>
              <span>{pick(locale, f.q)}</span>
              <span className="plus" aria-hidden="true" />
            </button>
            <div className="a" id={panelId}>
              <p>{pick(locale, f.a)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
