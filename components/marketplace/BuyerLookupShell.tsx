"use client";

import { FormEvent, ReactNode } from "react";
import Link from "next/link";
import { Store } from "lucide-react";

/** Shared page shell for the public marketplace's "buyer looks up their submission by phone" pages (status/[id] for buyer requests, tradein/[id] for trade-in offers) — header/lang toggle/phone form/not-found message are identical; only the result card differs per caller. */
export function BuyerLookupShell(props: {
  dir: "rtl" | "ltr";
  homeHref: string;
  langToggleLabel: string;
  onToggleLang: () => void;
  title: string;
  subtitle: string;
  phone: string;
  onPhoneChange: (value: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  phonePlaceholder: string;
  checkLabel: string;
  notFound: boolean;
  notFoundMessage: string;
  aboveTitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main dir={props.dir} className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-md px-4 py-4 flex items-center justify-between">
          <Link href={props.homeHref} className="flex items-center gap-2 font-semibold">
            <Store className="h-5 w-5" />
            AutoFlow
          </Link>
          <button type="button" onClick={props.onToggleLang} className="text-sm text-slate-600">
            {props.langToggleLabel}
          </button>
        </div>
      </header>

      <section className="mx-auto max-w-md px-4 py-10">
        {props.aboveTitle}
        <h1 className="text-2xl font-bold">{props.title}</h1>
        <p className="mt-2 text-slate-600">{props.subtitle}</p>

        <form onSubmit={props.onSubmit} className="mt-6 flex gap-2">
          <input
            value={props.phone}
            onChange={(e) => props.onPhoneChange(e.target.value)}
            placeholder={props.phonePlaceholder}
            aria-label={props.phonePlaceholder}
            required
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
          />
          <button type="submit" className="rounded-lg bg-slate-950 text-white px-4 py-2 font-medium">
            {props.checkLabel}
          </button>
        </form>

        {props.notFound && <p className="mt-6 text-sm text-rose-600">{props.notFoundMessage}</p>}

        {props.children}
      </section>
    </main>
  );
}
