"use client";

import Link from "next/link";
import type { ChangeEvent, ReactElement } from "react";
import type { FormState, PublicSite, ThemeProps } from "./theme-props";
import { TurnstileWidget } from "../turnstile-widget";
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
      <FallbackNav site={props.site} />
      <section className="mx-auto max-w-screen-2xl px-margin-desktop py-section-gap">
        {page === "branches" ? <BranchesContent site={props.site} /> : null}
        {page === "contact" ? <ContactContent props={props} /> : null}
        {page === "privacy" || page === "terms" || page === "data-deletion" ? <LegalContent props={props} /> : null}
      </section>
      <FallbackFooter site={props.site} />
    </main>
  );
}

function FallbackNav({ site }: { site: PublicSite }) {
  return (
    <header className="sticky top-0 z-50 bg-surface/90 shadow-sm backdrop-blur-xl">
      <nav className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-gutter py-4">
        <Link href="/" className="font-display-luxury text-[32px] text-luxury-gold">
          {site.profile.dealershipName}
        </Link>
        <div className="hidden items-center gap-8 md:flex">
          <Link className="font-label-caps text-label-caps text-on-surface-variant hover:text-primary" href="/inventory">
            Inventory
          </Link>
          <Link className="font-label-caps text-label-caps text-on-surface-variant hover:text-primary" href="/finance">
            Finance
          </Link>
          <Link className="font-label-caps text-label-caps text-on-surface-variant hover:text-primary" href="/branches">
            Branches
          </Link>
          <Link className="font-label-caps text-label-caps text-secondary" href="/contact">
            Contact
          </Link>
        </div>
      </nav>
    </header>
  );
}

function BranchesContent({ site }: { site: PublicSite }) {
  return (
    <>
      <h1 className="font-headline-lg text-headline-lg text-primary">Branches</h1>
      <div className="mt-8 grid grid-cols-1 gap-gutter md:grid-cols-3">
        {site.profile.branches.map((branch) => (
          <article key={branch.id} className="rounded-xl border border-outline-variant bg-surface-container-lowest p-6">
            <h2 className="text-xl font-bold text-primary">{branch.name}</h2>
            {branch.address ? <p className="mt-3 text-on-surface-variant">{branch.address}</p> : null}
            {branch.phone ? <p className="mt-2 font-bold text-secondary">{branch.phone}</p> : null}
          </article>
        ))}
      </div>
    </>
  );
}

function ContactContent({ props }: { props: ThemeProps }) {
  return (
    <div className="grid grid-cols-1 gap-gutter lg:grid-cols-12">
      <div className="lg:col-span-5">
        <h1 className="font-headline-lg text-headline-lg text-primary">{props.t.contactTitle}</h1>
        <p className="mt-4 text-on-surface-variant">{props.site.profile.address}</p>
        <p className="mt-2 font-bold text-secondary">{props.site.profile.phone}</p>
      </div>
      <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-8 lg:col-span-7">
        {props.formSuccess === "contact" ? (
          <div className="text-center">
            <h2 className="font-headline-lg text-2xl text-primary">{props.t.thankYou}</h2>
            <p className="mt-2 text-on-surface-variant">{props.t.messageReceived}</p>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={(event) => props.onSubmit(event, "contact")}>
            <FallbackLeadFields form={props.form} setForm={props.setForm} />
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
        <h2 className="font-display-luxury text-[32px] text-luxury-gold">{site.profile.dealershipName}</h2>
        <p className="mt-3 text-on-primary-container">{site.profile.slogan}</p>
      </div>
    </footer>
  );
}

function FallbackLeadFields({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (form: FormState) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <input
          required
          className="rounded-lg border border-outline-variant px-4 py-3"
          placeholder="First name"
          value={form.firstName}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, firstName: event.currentTarget.value })}
        />
        <input
          className="rounded-lg border border-outline-variant px-4 py-3"
          placeholder="Last name"
          value={form.lastName}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, lastName: event.currentTarget.value })}
        />
      </div>
      <input
        className="rounded-lg border border-outline-variant px-4 py-3"
        placeholder="Phone"
        value={form.phone}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, phone: event.currentTarget.value })}
      />
      <textarea
        className="min-h-32 rounded-lg border border-outline-variant px-4 py-3"
        placeholder="Message"
        value={form.message}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, message: event.currentTarget.value })}
      />
    </>
  );
}
