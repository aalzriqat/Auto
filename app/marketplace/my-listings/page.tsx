"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { toast } from "@/components/ui/sonner";
import { Car, ImageOff } from "lucide-react";
import {
  ALLOWED_CURRENCIES,
  LISTING_CONDITIONS,
  listingUpdateSchema,
  type ListingUpdateValues,
} from "../sell/listing.schema";
import { TextField, SelectField, TextAreaField, codeOptions } from "../listingFields";
import {
  MarketplacePageShell,
  translate,
  useMarketplaceLang,
  type Lang,
  type Translations,
} from "../marketplaceShell";

// getMyListings returns each raw listing doc plus a resolved thumbnailUrl
// (first image only) that doesn't exist on the underlying schema doc.
type ListingDoc = FunctionReturnType<typeof api.marketplaceListings.getMyListings>[number];
type ListingStatus = ListingDoc["status"];
type Condition = ListingDoc["condition"];

const STRINGS = {
  title: { en: "My Listings", ar: "إعلاناتي" },
  subtitle: { en: "Manage the cars you've listed for sale.", ar: "أدر السيارات التي أضفتها للبيع." },
  toggleLang: { en: "العربية", ar: "English" },
  backToBrowse: { en: "Back to Browse Cars", ar: "الرجوع إلى تصفّح السيارات" },
  listAnotherCar: { en: "List Another Car", ar: "أضف سيارة أخرى" },
  signInTitle: { en: "Sign in to see your listings", ar: "سجّل الدخول لعرض إعلاناتك" },
  signInBody: { en: "You'll need to be signed in to view and manage the cars you've listed.", ar: "تحتاج إلى تسجيل الدخول لعرض وإدارة السيارات التي أضفتها." },
  signInCta: { en: "Sign in", ar: "تسجيل الدخول" },
  loading: { en: "Loading your listings...", ar: "جاري تحميل إعلاناتك..." },
  empty: { en: "You haven't listed any cars yet.", ar: "لم تقم بإضافة أي سيارة بعد." },
  listFirstCar: { en: "List Your Car", ar: "أضف سيارتك" },
  photosCount: { en: "photos", ar: "صور" },
  noPhotos: { en: "No photos", ar: "لا توجد صور" },
  edit: { en: "Edit", ar: "تعديل" },
  save: { en: "Save changes", ar: "حفظ التعديلات" },
  saving: { en: "Saving...", ar: "جاري الحفظ..." },
  cancel: { en: "Cancel", ar: "إلغاء" },
  markSold: { en: "Mark as sold", ar: "تعليم كمباعة" },
  marking: { en: "Marking...", ar: "جاري التعليم..." },
  delete: { en: "Delete", ar: "حذف" },
  deleting: { en: "Deleting...", ar: "جاري الحذف..." },
  confirmDelete: { en: "Delete this listing? This can't be undone.", ar: "هل تريد حذف هذا الإعلان؟ لا يمكن التراجع عن هذا الإجراء." },
  rejectionReasonLabel: { en: "Rejection reason", ar: "سبب الرفض" },
  removalReasonLabel: { en: "Removal reason", ar: "سبب الإزالة" },
  sellerDisplayName: { en: "Your name", ar: "اسمك" },
  sellerPhone: { en: "Phone number", ar: "رقم الهاتف" },
  sellerWhatsapp: { en: "WhatsApp (optional)", ar: "واتساب (اختياري)" },
  make: { en: "Make", ar: "الماركة" },
  model: { en: "Model", ar: "الموديل" },
  year: { en: "Year", ar: "سنة الصنع" },
  mileage: { en: "Mileage (km)", ar: "الممشى (كم)" },
  price: { en: "Price", ar: "السعر" },
  currency: { en: "Currency", ar: "العملة" },
  transmission: { en: "Transmission", ar: "ناقل الحركة" },
  fuelType: { en: "Fuel type", ar: "نوع الوقود" },
  city: { en: "City", ar: "المدينة" },
  description: { en: "Description", ar: "الوصف" },
  condition: { en: "Condition", ar: "الحالة" },
  updated: { en: "Listing updated.", ar: "تم تحديث الإعلان." },
  markedSold: { en: "Listing marked as sold.", ar: "تم تعليم الإعلان كمباع." },
  deleted: { en: "Listing deleted.", ar: "تم حذف الإعلان." },
  genericError: { en: "Something went wrong. Please try again.", ar: "حدث خطأ ما. الرجاء المحاولة مرة أخرى." },
} satisfies Translations;

const STATUS_LABELS: Record<Lang, Record<ListingStatus, string>> = {
  en: {
    PENDING_VERIFICATION: "Pending Verification",
    LIVE: "Live",
    REJECTED: "Rejected",
    SOLD: "Sold",
    REMOVED: "Removed",
  },
  ar: {
    PENDING_VERIFICATION: "قيد التحقق",
    LIVE: "منشور",
    REJECTED: "مرفوض",
    SOLD: "مباع",
    REMOVED: "تمت إزالته",
  },
};

const STATUS_BADGE_CLASS: Record<ListingStatus, string> = {
  PENDING_VERIFICATION: "bg-amber-50 text-amber-700",
  LIVE: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-rose-50 text-rose-700",
  SOLD: "bg-slate-200 text-slate-700",
  REMOVED: "bg-slate-200 text-slate-700",
};

const CONDITION_LABELS: Record<Lang, Record<Condition, string>> = {
  en: { EXCELLENT: "Excellent", GOOD: "Good", FAIR: "Fair", POOR: "Poor" },
  ar: { EXCELLENT: "ممتازة", GOOD: "جيدة", FAIR: "مقبولة", POOR: "ضعيفة" },
};

function EditListingForm({
  listing,
  t,
  onSaved,
  onCancel,
}: {
  readonly listing: ListingDoc;
  readonly t: Record<string, string>;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const updateListing = useMutation(api.marketplaceListings.updateListing);
  const [isSaving, setIsSaving] = useState(false);

  const form = useForm<ListingUpdateValues>({
    resolver: zodResolver(listingUpdateSchema),
    defaultValues: {
      sellerDisplayName: listing.sellerDisplayName,
      sellerPhone: listing.sellerPhone,
      sellerWhatsapp: listing.sellerWhatsapp ?? "",
      make: listing.make,
      model: listing.model,
      year: listing.year,
      mileage: listing.mileage,
      price: listing.price,
      currency: listing.currency as (typeof ALLOWED_CURRENCIES)[number],
      transmission: listing.transmission,
      fuelType: listing.fuelType,
      city: listing.city,
      description: listing.description,
      condition: listing.condition,
    },
  });

  async function onSubmit(values: ListingUpdateValues) {
    setIsSaving(true);
    try {
      await updateListing({
        listingId: listing._id,
        sellerDisplayName: values.sellerDisplayName,
        sellerPhone: values.sellerPhone,
        sellerWhatsapp: values.sellerWhatsapp || undefined,
        make: values.make,
        model: values.model,
        year: values.year,
        mileage: values.mileage,
        price: values.price,
        currency: values.currency,
        transmission: values.transmission,
        fuelType: values.fuelType,
        city: values.city,
        description: values.description,
        condition: values.condition,
      });
      toast.success(t.updated);
      onSaved();
    } catch (error) {
      toast.error(error);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="mt-4 space-y-3 border-t border-slate-200 pt-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField size="compact" label={t.sellerDisplayName} registration={form.register("sellerDisplayName")} />
        <TextField size="compact" label={t.sellerPhone} registration={form.register("sellerPhone")} />
        <TextField size="compact" label={t.sellerWhatsapp} registration={form.register("sellerWhatsapp")} />
        <TextField size="compact" label={t.city} registration={form.register("city")} />
        <TextField size="compact" label={t.make} registration={form.register("make")} />
        <TextField size="compact" label={t.model} registration={form.register("model")} />
        <TextField size="compact" type="number" label={t.year} registration={form.register("year")} />
        <TextField size="compact" type="number" min={0} label={t.mileage} registration={form.register("mileage")} />
        <TextField size="compact" type="number" min={0} label={t.price} registration={form.register("price")} />
        <SelectField
          size="compact"
          label={t.currency}
          registration={form.register("currency")}
          options={codeOptions(ALLOWED_CURRENCIES)}
        />
        <TextField size="compact" label={t.transmission} registration={form.register("transmission")} />
        <TextField size="compact" label={t.fuelType} registration={form.register("fuelType")} />
        <SelectField
          size="compact"
          label={t.condition}
          registration={form.register("condition")}
          options={codeOptions(LISTING_CONDITIONS)}
        />
      </div>
      <TextAreaField size="compact" label={t.description} registration={form.register("description")} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isSaving}
          className="rounded-lg bg-slate-950 text-white px-4 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-60"
        >
          {isSaving ? t.saving : t.save}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-300 px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

function ListingCard({ listing, lang, t }: { readonly listing: ListingDoc; readonly lang: Lang; readonly t: Record<string, string> }) {
  const markSold = useMutation(api.marketplaceListings.markListingSold);
  const softDeleteListing = useMutation(api.marketplaceListings.softDeleteListing);

  const [isEditing, setIsEditing] = useState(false);
  const [isMarkingSold, setIsMarkingSold] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleted, setIsDeleted] = useState(false);

  const imageCount = listing.imageIds?.length ?? 0;
  const canEdit = listing.status !== "SOLD" && listing.status !== "REMOVED";

  async function handleMarkSold() {
    setIsMarkingSold(true);
    try {
      await markSold({ listingId: listing._id });
      toast.success(t.markedSold);
    } catch (error) {
      toast.error(error);
    } finally {
      setIsMarkingSold(false);
    }
  }

  async function handleDelete() {
    if (typeof window !== "undefined" && !window.confirm(t.confirmDelete)) return;
    setIsDeleting(true);
    try {
      await softDeleteListing({ listingId: listing._id });
      toast.success(t.deleted);
      setIsDeleted(true);
    } catch (error) {
      toast.error(error);
      setIsDeleting(false);
    }
  }

  // The listing vanishes from getMyListings' live subscription right after a
  // successful delete anyway (isDeleted flips the index prefix it's queried
  // by) — this local flag just avoids a flash of now-stale action buttons in
  // the brief window before that refetch lands.
  if (isDeleted) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex gap-4">
        <div className="relative w-28 h-20 shrink-0 rounded-lg bg-slate-100 flex flex-col items-center justify-center text-slate-400 overflow-hidden">
          {listing.thumbnailUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- Convex-hosted storage URL, not a static/local asset next/image can optimize */}
              <img
                src={listing.thumbnailUrl}
                alt={`${listing.make} ${listing.model}`}
                className="absolute inset-0 h-full w-full object-cover"
              />
              {imageCount > 1 && (
                <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                  {imageCount} {t.photosCount}
                </span>
              )}
            </>
          ) : imageCount > 0 ? (
            <>
              <Car className="h-6 w-6" />
              <span className="text-[10px] mt-1">
                {imageCount} {t.photosCount}
              </span>
            </>
          ) : (
            <>
              <ImageOff className="h-6 w-6" />
              <span className="text-[10px] mt-1">{t.noPhotos}</span>
            </>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold">
              {listing.year} {listing.make} {listing.model}
            </p>
            <span className={`rounded-full text-[11px] font-medium px-2 py-0.5 ${STATUS_BADGE_CLASS[listing.status]}`}>
              {STATUS_LABELS[lang][listing.status]}
            </span>
          </div>
          <p className="text-sm text-slate-600 mt-0.5">
            {listing.price.toLocaleString()} {listing.currency} · {CONDITION_LABELS[lang][listing.condition]} · {listing.city}
          </p>
          {listing.status === "REJECTED" && listing.rejectionReason && (
            <p className="mt-1 text-xs text-rose-600">
              {t.rejectionReasonLabel}: {listing.rejectionReason}
            </p>
          )}
          {listing.status === "REMOVED" && listing.removalReason && (
            <p className="mt-1 text-xs text-rose-600">
              {t.removalReasonLabel}: {listing.removalReason}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {canEdit && (
              <button
                type="button"
                onClick={() => setIsEditing((prev) => !prev)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                {t.edit}
              </button>
            )}
            {listing.status === "LIVE" && (
              <button
                type="button"
                onClick={handleMarkSold}
                disabled={isMarkingSold}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {isMarkingSold ? t.marking : t.markSold}
              </button>
            )}
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className="rounded-lg border border-rose-200 px-3 py-1.5 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-60"
            >
              {isDeleting ? t.deleting : t.delete}
            </button>
          </div>
        </div>
      </div>

      {isEditing && canEdit && (
        <EditListingForm listing={listing} t={t} onSaved={() => setIsEditing(false)} onCancel={() => setIsEditing(false)} />
      )}
    </div>
  );
}

export default function MyListingsPage() {
  const { lang, toggleLang, dir } = useMarketplaceLang();
  const t = translate(STRINGS, lang);

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const listings = useQuery(api.marketplaceListings.getMyListings, isAuthenticated ? {} : "skip");

  return (
    <MarketplacePageShell dir={dir} toggleLabel={t.toggleLang} onToggleLang={toggleLang}>

      <section className="mx-auto max-w-3xl px-4 py-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">{t.title}</h1>
            <p className="mt-2 text-slate-600">{t.subtitle}</p>
          </div>
          {isAuthenticated && (
            <Link
              href="/marketplace/sell"
              className="rounded-lg bg-slate-950 text-white px-4 py-2 text-sm font-medium hover:bg-slate-800"
            >
              {t.listAnotherCar}
            </Link>
          )}
        </div>

        {isAuthLoading ? (
          <p className="mt-8 text-slate-500">{t.loading}</p>
        ) : !isAuthenticated ? (
          <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
            <p className="font-semibold text-slate-950">{t.signInTitle}</p>
            <p className="mt-1 text-sm text-slate-600">{t.signInBody}</p>
            <Link
              href="/sign-in"
              className="mt-4 inline-block rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              {t.signInCta}
            </Link>
          </div>
        ) : listings === undefined ? (
          <p className="mt-8 text-slate-500">{t.loading}</p>
        ) : listings.length === 0 ? (
          <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 text-center">
            <p className="text-slate-600">{t.empty}</p>
            <Link
              href="/marketplace/sell"
              className="mt-4 inline-block rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              {t.listFirstCar}
            </Link>
          </div>
        ) : (
          <div className="mt-8 space-y-4">
            {(listings ?? []).map((listing) => (
              <ListingCard key={listing._id} listing={listing} lang={lang} t={t} />
            ))}
          </div>
        )}

        <div className="mt-6 text-sm">
          <Link href="/marketplace/cars" className="text-slate-500 hover:text-slate-800">
            {t.backToBrowse}
          </Link>
        </div>
      </section>
    </MarketplacePageShell>
  );
}
