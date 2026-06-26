"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowRight, Car, Globe2, Mail, MapPin, Phone, Send, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { Id } from "@/convex/_generated/dataModel";

type PublicVehicle = {
  id: Id<"vehicles">;
  slug: string;
  make: string;
  model: string;
  year: number;
  trim: string | null;
  mileage: number | null;
  transmission: string | null;
  fuelType: string | null;
  exteriorColor: string | null;
  price: number | null;
  status: string;
  imageUrls: string[];
};

function formatPrice(price: number | null) {
  return price == null ? "Contact for price" : `${price.toLocaleString()} JOD`;
}

export default function DealerSitePage() {
  const params = useParams<{ slug?: string[] }>();
  const searchParams = useSearchParams();
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    whatsapp: "",
    message: "",
  });
  const [selectedVehicleId, setSelectedVehicleId] = useState<Id<"vehicles"> | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLead = useMutation(api.websites.submitPublicLead);

  const hostParam = searchParams.get("host");
  const [browserHost, setBrowserHost] = useState("");
  useEffect(() => {
    if (!hostParam) {
      const h = window.location.hostname;
      // Use browser hostname when served at a dealer subdomain (not the AutoFlow app itself)
      if (h && !h.includes("localhost") && !h.includes("vercel.app") && h !== "autoflowdealer.com" && !h.startsWith("www.")) {
        setBrowserHost(h);
      }
    }
  }, [hostParam]);
  const liveHost = hostParam ?? browserHost;
  const previewOrgId = searchParams.get("previewOrgId") as Id<"organizations"> | null;
  const liveSite = useQuery(api.websites.resolveDomain, !previewOrgId && liveHost ? { host: liveHost } : "skip");
  const previewSite = useQuery(api.websites.preview, previewOrgId ? { orgId: previewOrgId } : "skip");
  const site = previewOrgId ? previewSite : liveSite;
  const host = liveHost || site?.settings.domain || "";
  const isPreviewMode = Boolean(previewOrgId);
  const slug = params?.slug ?? [];
  const page = slug[0] ?? "home";
  const detailSlug = page === "inventory" && slug[1] ? slug[1] : null;

  const vehicles: PublicVehicle[] = useMemo(() => site?.vehicles ?? [], [site?.vehicles]);
  const featuredVehicles = vehicles.slice(0, 6);
  const detailVehicle = useMemo(
    () => vehicles.find((vehicle) => vehicle.slug === detailSlug || vehicle.id === detailSlug) ?? null,
    [detailSlug, vehicles]
  );

  const isArabic = site?.settings.defaultLanguage === "ar";
  const direction = isArabic ? "rtl" : "ltr";

  async function handleSubmit(event: FormEvent<HTMLFormElement>, formType: string) {
    event.preventDefault();
    if (isPreviewMode) {
      toast.error("Preview mode does not submit leads.");
      return;
    }
    if (!host) return;
    setIsSubmitting(true);
    try {
      await submitLead({
        host,
        formType,
        vehicleId: selectedVehicleId,
        firstName: form.firstName,
        lastName: form.lastName || undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
        whatsapp: form.whatsapp || undefined,
        message: form.message || undefined,
      });
      toast.success("Your request was sent.");
      setForm({ firstName: "", lastName: "", email: "", phone: "", whatsapp: "", message: "" });
      setSelectedVehicleId(undefined);
    } catch (error) {
      console.error("Website lead submission failed", error);
      toast.error("An unexpected error occurred. Please try again later.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (site === undefined) {
    return (
      <main className="min-h-screen bg-white text-slate-950 grid place-items-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-slate-950" />
      </main>
    );
  }

  if (!site) {
    return (
      <main className="min-h-screen bg-white text-slate-950 grid place-items-center p-6">
        <div className="max-w-md text-center">
          <Globe2 className="mx-auto mb-4 h-10 w-10 text-slate-400" />
          <h1 className="text-2xl font-bold">Website not found</h1>
          <p className="mt-2 text-sm text-slate-600">This dealership website is not active or the domain is not configured.</p>
        </div>
      </main>
    );
  }

  const profile = site.profile;
  const primary = site.settings.primaryColor;
  const secondary = site.settings.secondaryColor;

  const nav = [
    ["Home", "/"],
    ["Inventory", "/inventory"],
    ["Finance", "/finance"],
    ["Branches", "/branches"],
    ["Contact", "/contact"],
  ];

  return (
    <main dir={direction} className="min-h-screen bg-white text-slate-950">
      <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
        {isPreviewMode && (
          <div className="border-b bg-amber-50 px-4 py-2 text-center text-sm font-medium text-amber-900">
            Preview mode. This draft is visible only inside AutoFlow and lead forms are disabled.
          </div>
        )}
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="flex items-center gap-3">
            {profile.logoUrl ? (
              <img src={profile.logoUrl} alt={profile.dealershipName} className="h-10 max-w-32 object-contain" />
            ) : (
              <div className="grid h-10 w-10 place-items-center rounded-md text-white" style={{ backgroundColor: primary }}>
                <Car className="h-5 w-5" />
              </div>
            )}
            <span className="font-bold">{profile.dealershipName}</span>
          </Link>
          <nav className="hidden gap-5 text-sm font-medium md:flex">
            {nav.map(([label, href]) => (
              <a key={label} href={href} className="text-slate-600 hover:text-slate-950">{label}</a>
            ))}
          </nav>
          <a href="/contact" className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold text-white" style={{ backgroundColor: secondary }}>
            Contact
          </a>
        </div>
      </header>

      {(page === "home" || page === "") && (
        <>
          <section className="border-b">
            <div className="mx-auto grid min-h-[520px] max-w-7xl content-center gap-8 px-4 py-16 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
              <div>
                <p className="mb-3 text-sm font-semibold uppercase tracking-wide" style={{ color: secondary }}>AutoFlow dealer website</p>
                <h1 className="max-w-3xl text-4xl font-black tracking-tight md:text-6xl">{profile.heroTitle}</h1>
                <p className="mt-5 max-w-2xl text-lg text-slate-600">{profile.heroSubtitle}</p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <a href="/inventory" className="inline-flex items-center gap-2 rounded-md px-5 py-3 font-semibold text-white" style={{ backgroundColor: primary }}>
                    Browse inventory <ArrowRight className="h-4 w-4" />
                  </a>
                  <a href="/contact" className="inline-flex items-center gap-2 rounded-md border px-5 py-3 font-semibold">
                    Contact sales
                  </a>
                </div>
              </div>
              <div className="overflow-hidden rounded-md border bg-slate-100">
                {featuredVehicles[0]?.imageUrls[0] ? (
                  <img src={featuredVehicles[0].imageUrls[0]} alt="" className="aspect-[4/3] h-full w-full object-cover" />
                ) : (
                  <div className="grid aspect-[4/3] place-items-center text-slate-400">
                    <Car className="h-16 w-16" />
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="mx-auto max-w-7xl px-4 py-12">
            <div className="mb-6 flex items-end justify-between">
              <div>
                <h2 className="text-2xl font-bold">Featured vehicles</h2>
                <p className="text-sm text-slate-600">Public inventory from AutoFlow.</p>
              </div>
              <a href="/inventory" className="text-sm font-semibold" style={{ color: primary }}>View all</a>
            </div>
            <VehicleGrid vehicles={featuredVehicles} primary={primary} />
          </section>
        </>
      )}

      {page === "inventory" && !detailVehicle && (
        <section className="mx-auto max-w-7xl px-4 py-10">
          <h1 className="text-3xl font-bold">Inventory</h1>
          <p className="mt-2 text-sm text-slate-600">Filter and inspect available public vehicles.</p>
          <div className="mt-8">
            <VehicleGrid vehicles={vehicles} primary={primary} />
          </div>
        </section>
      )}

      {page === "inventory" && detailVehicle && (
        <section className="mx-auto grid max-w-7xl gap-8 px-4 py-10 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="overflow-hidden rounded-md border bg-slate-100">
            {detailVehicle.imageUrls[0] ? (
              <img src={detailVehicle.imageUrls[0]} alt={`${detailVehicle.year} ${detailVehicle.make} ${detailVehicle.model}`} className="aspect-[4/3] w-full object-cover" />
            ) : (
              <div className="grid aspect-[4/3] place-items-center text-slate-400"><Car className="h-16 w-16" /></div>
            )}
          </div>
          <div>
            <p className="text-sm font-semibold uppercase" style={{ color: secondary }}>{detailVehicle.status}</p>
            <h1 className="mt-2 text-4xl font-black">{detailVehicle.year} {detailVehicle.make} {detailVehicle.model}</h1>
            <p className="mt-4 text-2xl font-bold">{formatPrice(detailVehicle.price)}</p>
            <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
              {[
                ["Trim", detailVehicle.trim],
                ["Mileage", detailVehicle.mileage ? `${detailVehicle.mileage.toLocaleString()} km` : null],
                ["Transmission", detailVehicle.transmission],
                ["Fuel type", detailVehicle.fuelType],
                ["Color", detailVehicle.exteriorColor],
              ].map(([label, value]) => value && (
                <div key={label} className="rounded-md border p-3">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            <form className="mt-8 space-y-3 rounded-md border p-4" onSubmit={(event) => {
              setSelectedVehicleId(detailVehicle.id);
              void handleSubmit(event, "vehicle_inquiry");
            }}>
              <h2 className="font-bold">Ask about this vehicle</h2>
              <LeadFields form={form} setForm={setForm} />
              <Button type="submit" disabled={isSubmitting} style={{ backgroundColor: primary }}>
                <Send className="h-4 w-4" />
                Send inquiry
              </Button>
            </form>
          </div>
        </section>
      )}

      {page === "finance" && (
        <section className="mx-auto max-w-4xl px-4 py-10">
          <h1 className="text-3xl font-bold">Finance</h1>
          <p className="mt-2 text-slate-600">{site.legal.financingDisclaimer}</p>
          <form className="mt-8 space-y-3 rounded-md border p-4" onSubmit={(event) => handleSubmit(event, "financing")}>
            <LeadFields form={form} setForm={setForm} />
            <Button type="submit" disabled={isSubmitting} style={{ backgroundColor: primary }}>Request financing</Button>
          </form>
        </section>
      )}

      {page === "branches" && (
        <section className="mx-auto max-w-5xl px-4 py-10">
          <h1 className="text-3xl font-bold">Branches</h1>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {profile.branches.map((branch) => (
              <div key={branch.id} className="rounded-md border p-4">
                <h2 className="font-bold">{branch.name}</h2>
                {branch.address && <p className="mt-2 flex items-center gap-2 text-sm text-slate-600"><MapPin className="h-4 w-4" />{branch.address}</p>}
                {branch.phone && <p className="mt-2 flex items-center gap-2 text-sm text-slate-600"><Phone className="h-4 w-4" />{branch.phone}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {page === "contact" && (
        <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <h1 className="text-3xl font-bold">Contact</h1>
            {profile.phone && <p className="mt-4 flex items-center gap-2 text-slate-700"><Phone className="h-4 w-4" />{profile.phone}</p>}
            {profile.address && <p className="mt-3 flex items-center gap-2 text-slate-700"><MapPin className="h-4 w-4" />{profile.address}</p>}
            <p className="mt-6 flex items-start gap-2 text-sm text-slate-500">
              <ShieldCheck className="mt-0.5 h-4 w-4" />
              Your submitted contact details are used by this dealership to respond to your request.
            </p>
          </div>
          <form className="space-y-3 rounded-md border p-4" onSubmit={(event) => handleSubmit(event, "contact")}>
            <LeadFields form={form} setForm={setForm} />
            <Button type="submit" disabled={isSubmitting} style={{ backgroundColor: primary }}>Send message</Button>
          </form>
        </section>
      )}

      {(page === "privacy" || page === "terms" || page === "data-deletion") && (
        <section className="mx-auto max-w-3xl px-4 py-10">
          <h1 className="text-3xl font-bold">{page === "privacy" ? "Privacy Policy" : page === "terms" ? "Terms" : "Data Deletion"}</h1>
          <p className="mt-4 text-slate-700">
            {page === "privacy" ? site.legal.privacyPolicy : page === "terms" ? site.legal.terms : site.legal.dataDeletion}
          </p>
        </section>
      )}

      <footer className="mt-12 border-t px-4 py-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 text-sm text-slate-500 md:flex-row md:items-center md:justify-between">
          <p>{profile.dealershipName}</p>
          <div className="flex gap-4">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/data-deletion">Data deletion</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function VehicleGrid({ vehicles, primary }: { vehicles: PublicVehicle[]; primary: string }) {
  if (vehicles.length === 0) {
    return <div className="rounded-md border border-dashed p-10 text-center text-slate-500">No public vehicles are available right now.</div>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {vehicles.map((vehicle) => (
        <a key={vehicle.id} href={`/inventory/${vehicle.slug}`} className="overflow-hidden rounded-md border bg-white transition hover:shadow-md">
          <div className="bg-slate-100">
            {vehicle.imageUrls[0] ? (
              <img src={vehicle.imageUrls[0]} alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`} className="aspect-[4/3] w-full object-cover" />
            ) : (
              <div className="grid aspect-[4/3] place-items-center text-slate-400"><Car className="h-12 w-12" /></div>
            )}
          </div>
          <div className="p-4">
            <p className="text-xs font-semibold uppercase" style={{ color: primary }}>{vehicle.status}</p>
            <h3 className="mt-1 font-bold">{vehicle.year} {vehicle.make} {vehicle.model}</h3>
            <p className="mt-2 text-sm text-slate-600">{[vehicle.trim, vehicle.mileage ? `${vehicle.mileage.toLocaleString()} km` : null].filter(Boolean).join(" · ")}</p>
            <p className="mt-3 font-bold">{formatPrice(vehicle.price)}</p>
          </div>
        </a>
      ))}
    </div>
  );
}

function LeadFields({
  form,
  setForm,
}: {
  form: { firstName: string; lastName: string; email: string; phone: string; whatsapp: string; message: string };
  setForm: (value: { firstName: string; lastName: string; email: string; phone: string; whatsapp: string; message: string }) => void;
}) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <Input required value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} placeholder="First name" />
        <Input value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.target.value })} placeholder="Last name" />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="Email" />
        <Input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="Phone" />
        <Input value={form.whatsapp} onChange={(event) => setForm({ ...form, whatsapp: event.target.value })} placeholder="WhatsApp" />
      </div>
      <Textarea value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} placeholder="Message" />
      <p className="flex items-center gap-2 text-xs text-slate-500"><Mail className="h-3 w-3" /> Provide at least one contact method.</p>
    </>
  );
}
