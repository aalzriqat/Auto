"use client";

import Link from "next/link";
import type { ChangeEvent, ReactElement } from "react";
import type { FormState, PublicSite, ThemeProps } from "./theme-props";
import { TurnstileWidget } from "../turnstile-widget";
import { KineticBrand } from "./kinetic-shared";
import { KineticLuxuryHome } from "./kinetic-home-luxury";
import { KineticModernEvHome } from "./kinetic-home-ev";
import { KineticSalesHome } from "./kinetic-home-sales";
import { KineticInventoryList, KineticVehicleDetail } from "./kinetic-inventory";
import { KineticFinanceCalculator } from "./kinetic-finance";

type KineticDesignId = "luxury" | "modern-ev" | "sales";

const HOME_BY_DESIGN: Record<KineticDesignId, (props: ThemeProps) => ReactElement> = {
  luxury: KineticLuxuryHome,
  "modern-ev": KineticModernEvHome,
  sales: KineticSalesHome,
};

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
  const { page, detailVehicle } = props;

  if (page === "home" || page === "") {
    const Home = HOME_BY_DESIGN[design];
    return <Home {...props} />;
  }
  if (page === "inventory" && detailVehicle) return <KineticVehicleDetail {...props} />;
  if (page === "inventory") return <KineticInventoryList {...props} />;
  if (page === "finance") return <KineticFinanceCalculator {...props} />;

  return <KineticFallbackPage props={props} />;
}

function KineticFallbackPage({ props }: { props: ThemeProps }) {
  const page = props.page;

  return (
    <main className="theme-kinetic min-h-screen bg-background text-on-background font-body-md" dir={props.dir}>
      <FallbackNav props={props} />
      <section className="mx-auto max-w-screen-2xl px-margin-desktop py-section-gap">
        {page === "branches" ? <BranchesContent props={props} /> : null}
        {page === "contact" ? <ContactContent props={props} /> : null}
        {page === "privacy" || page === "terms" || page === "data-deletion" ? <LegalContent props={props} /> : null}
      </section>
      <FallbackFooter site={props.site} />
    </main>
  );
}

function FallbackNav({ props }: { props: ThemeProps }) {
  const { site, t } = props;
  return (
    <header className="sticky top-0 z-50 bg-surface/90 shadow-sm backdrop-blur-xl">
      <nav className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-gutter py-3">
        <Link href="/">
          <KineticBrand profile={site.profile} size="lg" />
        </Link>
        <div className="hidden items-center gap-8 md:flex">
          <Link className="font-label-caps text-sm text-on-surface-variant hover:text-primary" href="/inventory">
            {t.nav.inventory}
          </Link>
          <Link className="font-label-caps text-sm text-on-surface-variant hover:text-primary" href="/finance">
            {t.nav.finance}
          </Link>
          <Link className="font-label-caps text-sm text-on-surface-variant hover:text-primary" href="/branches">
            {t.nav.branches}
          </Link>
          <Link className="font-label-caps text-sm text-secondary" href="/contact">
            {t.nav.contact}
          </Link>
        </div>
      </nav>
    </header>
  );
}

function BranchesContent({ props }: { props: ThemeProps }) {
  const { site, t } = props;
  return (
    <>
      <h1 className="font-headline-lg text-headline-lg text-primary">{t.branchesTitle}</h1>
      <div className="mt-8 grid grid-cols-1 gap-gutter md:grid-cols-3">
        {site.profile.branches.map((branch) => (
          <article key={branch.id} className="rounded-xl border border-outline-variant bg-surface-container-lowest p-6">
            <h2 className="text-xl font-bold text-primary">{branch.name}</h2>
            {branch.address ? (
              branch.address.startsWith("http") ? (
                <a
                  href={branch.address}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 flex items-center gap-1 text-secondary hover:underline"
                >
                  <span className="material-symbols-outlined text-base">location_on</span>
                  {t.viewOnMap}
                </a>
              ) : (
                <p className="mt-3 flex items-start gap-2 text-on-surface-variant">
                  <span className="material-symbols-outlined text-base">location_on</span>
                  {branch.address}
                </p>
              )
            ) : null}
            {branch.phones.map((phone) => (
              <a key={phone} href={`tel:${phone}`} className="mt-2 block font-bold text-secondary hover:underline">
                {phone}
              </a>
            ))}
          </article>
        ))}
      </div>
    </>
  );
}

function ContactContent({ props }: { props: ThemeProps }) {
  const profile = props.site.profile;
  return (
    <div className="grid grid-cols-1 gap-gutter lg:grid-cols-12">
      <div className="lg:col-span-5">
        <h1 className="font-headline-lg text-headline-lg text-primary">{props.t.contactTitle}</h1>
        {profile.address ? (
          profile.address.startsWith("http") ? (
            <a href={profile.address} target="_blank" rel="noopener noreferrer" className="mt-4 flex items-center gap-1 text-secondary hover:underline">
              <span className="material-symbols-outlined text-base">location_on</span>
              {props.t.viewOnMap}
            </a>
          ) : (
            <p className="mt-4 text-on-surface-variant">{profile.address}</p>
          )
        ) : null}
        {profile.phones.map((phone) => (
          <a key={phone} href={`tel:${phone}`} className="mt-2 block font-bold text-secondary hover:underline">{phone}</a>
        ))}
      </div>
      <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-8 lg:col-span-7">
        {props.formSuccess === "contact" ? (
          <div className="text-center">
            <h2 className="font-headline-lg text-2xl text-primary">{props.t.thankYou}</h2>
            <p className="mt-2 text-on-surface-variant">{props.t.messageReceived}</p>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={(event) => props.onSubmit(event, "contact")}>
            <FallbackLeadFields form={props.form} setForm={props.setForm} t={props.t} />
            <TurnstileWidget siteKey={props.turnstileSiteKey} />
            <button type="submit" disabled={props.isSubmitting} className="rounded-xl bg-secondary px-8 py-4 font-bold text-white">
              {props.t.sendMessage}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function LegalContent({ props }: { props: ThemeProps }) {
  const title =
    props.page === "privacy" ? props.t.privacyTitle : props.page === "terms" ? props.t.termsTitle : props.t.dataDeletionTitle;
  const body =
    props.page === "privacy"
      ? props.site.legal.privacyPolicy
      : props.page === "terms"
        ? props.site.legal.terms
        : props.site.legal.dataDeletion;

  return (
    <article className="max-w-3xl">
      <h1 className="font-headline-lg text-headline-lg text-primary">{title}</h1>
      <p className="mt-6 leading-8 text-on-surface-variant">{body}</p>
    </article>
  );
}

function FallbackFooter({ site }: { site: PublicSite }) {
  return (
    <footer className="mt-section-gap bg-primary px-margin-desktop py-section-gap text-white">
      <div className="mx-auto max-w-screen-2xl">
        <KineticBrand profile={site.profile} size="md" />
        <p className="mt-3 text-on-primary-container">{site.profile.slogan}</p>
      </div>
    </footer>
  );
}

function FallbackLeadFields({
  form,
  setForm,
  t,
}: {
  form: FormState;
  setForm: (form: FormState) => void;
  t: ThemeProps["t"];
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <input
          required
          className="rounded-lg border border-outline-variant px-4 py-3"
          placeholder={t.placeholderFirstName}
          value={form.firstName}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, firstName: event.currentTarget.value })}
        />
        <input
          className="rounded-lg border border-outline-variant px-4 py-3"
          placeholder={t.placeholderLastName}
          value={form.lastName}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, lastName: event.currentTarget.value })}
        />
      </div>
      <input
        className="rounded-lg border border-outline-variant px-4 py-3"
        placeholder={t.placeholderPhone}
        value={form.phone}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, phone: event.currentTarget.value })}
      />
      <textarea
        className="min-h-32 rounded-lg border border-outline-variant px-4 py-3"
        placeholder={t.placeholderMessage}
        value={form.message}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, message: event.currentTarget.value })}
      />
    </>
  );
}
