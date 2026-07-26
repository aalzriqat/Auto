"use client";

import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useConvexAuth } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import { CheckCircle2, Car, Loader2, Upload, X } from "lucide-react";
import {
  ALLOWED_CURRENCIES,
  LISTING_CONDITIONS,
  MAX_LISTING_IMAGES,
  SELLER_KINDS,
  listingSchema,
  type ListingFormValues,
} from "./listing.schema";
import { TextField, SelectField, TextAreaField, codeOptions } from "../listingFields";
import {
  MarketplacePageShell,
  translate,
  useMarketplaceLang,
  type Translations,
} from "../marketplaceShell";

// Mirrors convex/utils/storageValidation.ts's MARKETPLACE_LISTING_IMAGE_CONTENT_TYPES
// / max size — checked client-side too so a rejected file is caught before an
// upload round-trip, not just by the server after it.
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

const STRINGS = {
  title: { en: "List Your Car", ar: "أضف سيارتك للبيع" },
  subtitle: { en: "Sell your own car, or list inventory as a dealer without an AutoFlow account.", ar: "بع سيارتك الخاصة، أو أضف مخزونك كمعرض بدون حساب أوتوفلو." },
  toggleLang: { en: "العربية", ar: "English" },
  backToBrowse: { en: "Back to Browse Cars", ar: "الرجوع إلى تصفّح السيارات" },
  myListings: { en: "My Listings", ar: "إعلاناتي" },
  signInTitle: { en: "Sign in to list your car", ar: "سجّل الدخول لإضافة سيارتك" },
  signInBody: { en: "You'll need an AutoFlow account so we can verify your listing and let you manage it afterward.", ar: "تحتاج إلى حساب أوتوفلو حتى نتمكن من التحقق من إعلانك والسماح لك بإدارته لاحقاً." },
  signInCta: { en: "Sign in", ar: "تسجيل الدخول" },
  loading: { en: "Loading...", ar: "جاري التحميل..." },
  sellerKindLabel: { en: "Who's selling?", ar: "من البائع؟" },
  sellerKindIndividual: { en: "I'm selling my own car", ar: "أنا أبيع سيارتي الخاصة" },
  sellerKindDealer: { en: "I'm a dealer without an AutoFlow account", ar: "أنا معرض بدون حساب أوتوفلو" },
  sellerDisplayName: { en: "Your name", ar: "اسمك" },
  sellerDisplayNamePlaceholder: { en: "e.g. Ahmad Khalil", ar: "مثال: أحمد خليل" },
  sellerPhone: { en: "Phone number", ar: "رقم الهاتف" },
  sellerPhonePlaceholder: { en: "e.g. +962 7 9999 9999", ar: "مثال: 7 9999 9999 962+" },
  sellerWhatsapp: { en: "WhatsApp (optional, if different)", ar: "واتساب (اختياري، إن كان مختلفاً)" },
  make: { en: "Make", ar: "الماركة" },
  makePlaceholder: { en: "e.g. Toyota", ar: "مثال: تويوتا" },
  model: { en: "Model", ar: "الموديل" },
  modelPlaceholder: { en: "e.g. Camry", ar: "مثال: كامري" },
  year: { en: "Year", ar: "سنة الصنع" },
  mileage: { en: "Mileage (km)", ar: "الممشى (كم)" },
  price: { en: "Price", ar: "السعر" },
  currency: { en: "Currency", ar: "العملة" },
  transmission: { en: "Transmission", ar: "ناقل الحركة" },
  fuelType: { en: "Fuel type", ar: "نوع الوقود" },
  city: { en: "City", ar: "المدينة" },
  cityPlaceholder: { en: "e.g. Amman", ar: "مثال: عمّان" },
  description: { en: "Description", ar: "الوصف" },
  descriptionPlaceholder: { en: "Condition details, service history, extras...", ar: "تفاصيل الحالة، سجل الصيانة، الإضافات..." },
  condition: { en: "Condition", ar: "الحالة" },
  conditionExcellent: { en: "Excellent", ar: "ممتازة" },
  conditionGood: { en: "Good", ar: "جيدة" },
  conditionFair: { en: "Fair", ar: "مقبولة" },
  conditionPoor: { en: "Poor", ar: "ضعيفة" },
  transmissionAutomatic: { en: "Automatic", ar: "أوتوماتيك" },
  transmissionManual: { en: "Manual", ar: "عادي" },
  fuelGasoline: { en: "Gasoline", ar: "بنزين" },
  fuelDiesel: { en: "Diesel", ar: "ديزل" },
  fuelHybrid: { en: "Hybrid", ar: "هايبرد" },
  fuelElectric: { en: "Electric", ar: "كهربائي" },
  images: { en: "Photos", ar: "الصور" },
  imagesHint: { en: `Upload between 1 and ${MAX_LISTING_IMAGES} photos of the car.`, ar: `ارفع بين 1 و${MAX_LISTING_IMAGES} صورة للسيارة.` },
  uploadPhotos: { en: "Upload photos", ar: "رفع صور" },
  uploading: { en: "Uploading...", ar: "جاري الرفع..." },
  noImagesYet: { en: "No photos added yet.", ar: "لم تتم إضافة صور بعد." },
  imagesRequired: { en: "At least one photo is required.", ar: "مطلوب صورة واحدة على الأقل." },
  tooManyImages: { en: `You can upload at most ${MAX_LISTING_IMAGES} photos.`, ar: `يمكنك رفع ${MAX_LISTING_IMAGES} صورة كحد أقصى.` },
  invalidImageType: { en: "Only JPEG, PNG, or WEBP images are allowed.", ar: "يُسمح فقط بصور JPEG أو PNG أو WEBP." },
  imageTooLarge: { en: "Image exceeds the 5MB size limit.", ar: "حجم الصورة يتجاوز الحد الأقصى (5 ميجابايت)." },
  submit: { en: "Submit listing", ar: "إرسال الإعلان" },
  submitting: { en: "Submitting...", ar: "جاري الإرسال..." },
  successTitle: { en: "Listing submitted!", ar: "تم إرسال الإعلان!" },
  successBody: { en: "Your listing is now PENDING VERIFICATION — it will not appear publicly until an AutoFlow admin reviews and approves it.", ar: "إعلانك الآن قيد التحقق (PENDING VERIFICATION) — لن يظهر للعامة حتى يراجعه ويوافق عليه أحد مسؤولي أوتوفلو." },
  viewMyListings: { en: "View My Listings", ar: "عرض إعلاناتي" },
  genericError: { en: "Something went wrong. Please try again.", ar: "حدث خطأ ما. الرجاء المحاولة مرة أخرى." },
} satisfies Translations;

/**
 * Maps each condition enum value to its STRINGS key. Explicit rather than
 * building the key from the enum at runtime, so adding a condition without its
 * translation is a compile error instead of silently rendering the raw enum.
 */
const CONDITION_LABEL_KEYS = {
  EXCELLENT: "conditionExcellent",
  GOOD: "conditionGood",
  FAIR: "conditionFair",
  POOR: "conditionPoor",
} as const satisfies Record<(typeof LISTING_CONDITIONS)[number], keyof typeof STRINGS>;

type UploadedImage = {
  storageId: Id<"_storage">;
  previewUrl: string;
};

/**
 * Object URLs are minted by the browser and always look like
 * `blob:<origin>/<uuid>` — they can't carry a script-bearing scheme. Asserting
 * that explicitly keeps a non-blob string from ever reaching an <img src>,
 * even if the preview ever stops coming from URL.createObjectURL, and makes
 * the guarantee visible to readers and static analysis instead of implicit.
 */
function safeObjectUrl(url: string): string | undefined {
  return url.startsWith("blob:") ? url : undefined;
}

export default function MarketplaceSellPage() {
  const { lang, toggleLang, dir } = useMarketplaceLang();
  const t = translate(STRINGS, lang);

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();

  const generateUploadUrl = useMutation(api.marketplaceListings.generateListingImageUploadUrl);
  const confirmUpload = useMutation(api.marketplaceListings.confirmListingImageUpload);
  const createListing = useMutation(api.marketplaceListings.createListing);

  const [images, setImages] = useState<UploadedImage[]>([]);
  const [imagesError, setImagesError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedListingId, setSubmittedListingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Release any previews still held when the page unmounts (navigating away
  // mid-listing, or after a successful submit swaps in the confirmation view).
  // Reads through a ref so the cleanup isn't re-run on every image change.
  const imagesRef = useRef<UploadedImage[]>([]);
  imagesRef.current = images;
  useEffect(() => {
    return () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    };
  }, []);

  const form = useForm<ListingFormValues>({
    resolver: zodResolver(listingSchema),
    defaultValues: {
      sellerKind: "INDIVIDUAL",
      sellerDisplayName: "",
      sellerPhone: "",
      sellerWhatsapp: "",
      make: "",
      model: "",
      year: new Date().getFullYear(),
      mileage: 0,
      price: 0,
      currency: "JOD",
      transmission: "Automatic",
      fuelType: "Gasoline",
      city: "",
      description: "",
      condition: "GOOD",
    },
  });

  const selectedSellerKind = form.watch("sellerKind");

  async function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const selectedFiles = Array.from(files);
    if (images.length + selectedFiles.length > MAX_LISTING_IMAGES) {
      setImagesError(t.tooManyImages);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsUploading(true);
    setImagesError(null);
    try {
      for (const file of selectedFiles) {
        if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
          toast.error(t.invalidImageType);
          continue;
        }
        if (file.size > MAX_IMAGE_SIZE_BYTES) {
          toast.error(t.imageTooLarge);
          continue;
        }

        const uploadUrl = await generateUploadUrl({ mimeType: file.type, sizeInBytes: file.size });
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
        await confirmUpload({ storageId });

        setImages((prev) => [...prev, { storageId, previewUrl: URL.createObjectURL(file) }]);
      }
    } catch (error) {
      toast.error(error);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleRemoveImage(index: number) {
    setImages((prev) => {
      // Each preview holds a browser object URL that lives until it's revoked
      // or the document unloads; dropping the state entry alone leaks it.
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }

  async function onSubmit(values: ListingFormValues) {
    if (images.length === 0) {
      setImagesError(t.imagesRequired);
      return;
    }
    setImagesError(null);

    setIsSubmitting(true);
    try {
      const listingId = await createListing({
        sellerKind: values.sellerKind,
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
        imageIds: images.map((image) => image.storageId),
      });
      setSubmittedListingId(listingId);
    } catch (error) {
      toast.error(error);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <MarketplacePageShell dir={dir} toggleLabel={t.toggleLang} onToggleLang={toggleLang}>

      <section className="mx-auto max-w-3xl px-4 py-10">
        <div className="flex items-center gap-2 text-slate-500 mb-2">
          <Car className="h-5 w-5" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold">{t.title}</h1>
        <p className="mt-2 text-slate-600">{t.subtitle}</p>

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
        ) : submittedListingId ? (
          <div className="mt-8 rounded-xl border border-emerald-200 bg-emerald-50 p-6 flex items-start gap-3">
            <CheckCircle2 className="h-6 w-6 text-emerald-600 shrink-0" />
            <div>
              <p className="font-semibold text-emerald-900">{t.successTitle}</p>
              <p className="text-sm text-emerald-800 mt-1">{t.successBody}</p>
              <Link
                href="/marketplace/my-listings"
                className="mt-3 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                {t.viewMyListings}
              </Link>
            </div>
          </div>
        ) : (
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="mt-8 space-y-4 bg-white border border-slate-200 rounded-xl p-6"
          >
            <div>
              <label className="text-sm font-medium block mb-2">{t.sellerKindLabel}</label>
              <div className="flex rounded-md border overflow-hidden">
                {SELLER_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => form.setValue("sellerKind", kind)}
                    className={`flex-1 py-2 px-2 text-sm font-medium transition-colors ${
                      selectedSellerKind === kind
                        ? "bg-slate-950 text-white"
                        : "bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {kind === "INDIVIDUAL" ? t.sellerKindIndividual : t.sellerKindDealer}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextField
                id="sellerDisplayName"
                label={t.sellerDisplayName}
                placeholder={t.sellerDisplayNamePlaceholder}
                registration={form.register("sellerDisplayName")}
                error={form.formState.errors.sellerDisplayName?.message}
              />
              <TextField
                id="sellerPhone"
                label={t.sellerPhone}
                placeholder={t.sellerPhonePlaceholder}
                registration={form.register("sellerPhone")}
                error={form.formState.errors.sellerPhone?.message}
              />
              <TextField
                id="sellerWhatsapp"
                label={t.sellerWhatsapp}
                registration={form.register("sellerWhatsapp")}
                error={form.formState.errors.sellerWhatsapp?.message}
              />
              <TextField
                id="city"
                label={t.city}
                placeholder={t.cityPlaceholder}
                registration={form.register("city")}
                error={form.formState.errors.city?.message}
              />
              <TextField
                id="make"
                label={t.make}
                placeholder={t.makePlaceholder}
                registration={form.register("make")}
                error={form.formState.errors.make?.message}
              />
              <TextField
                id="model"
                label={t.model}
                placeholder={t.modelPlaceholder}
                registration={form.register("model")}
                error={form.formState.errors.model?.message}
              />
              <TextField
                id="year"
                type="number"
                label={t.year}
                registration={form.register("year")}
                error={form.formState.errors.year?.message}
              />
              <TextField
                id="mileage"
                type="number"
                min={0}
                label={t.mileage}
                registration={form.register("mileage")}
                error={form.formState.errors.mileage?.message}
              />
              <TextField
                id="price"
                type="number"
                min={0}
                label={t.price}
                registration={form.register("price")}
                error={form.formState.errors.price?.message}
              />
              <SelectField
                id="currency"
                label={t.currency}
                registration={form.register("currency")}
                options={codeOptions(ALLOWED_CURRENCIES)}
                error={form.formState.errors.currency?.message}
              />
              <SelectField
                id="transmission"
                label={t.transmission}
                registration={form.register("transmission")}
                options={[
                  { value: "Automatic", label: t.transmissionAutomatic },
                  { value: "Manual", label: t.transmissionManual },
                ]}
                error={form.formState.errors.transmission?.message}
              />
              <SelectField
                id="fuelType"
                label={t.fuelType}
                registration={form.register("fuelType")}
                options={[
                  { value: "Gasoline", label: t.fuelGasoline },
                  { value: "Diesel", label: t.fuelDiesel },
                  { value: "Hybrid", label: t.fuelHybrid },
                  { value: "Electric", label: t.fuelElectric },
                ]}
                error={form.formState.errors.fuelType?.message}
              />
              <SelectField
                id="condition"
                label={t.condition}
                registration={form.register("condition")}
                options={LISTING_CONDITIONS.map((condition) => ({
                  value: condition,
                  label: CONDITION_LABEL_KEYS[condition] ? t[CONDITION_LABEL_KEYS[condition]] : condition,
                }))}
                error={form.formState.errors.condition?.message}
              />
            </div>

            <TextAreaField
              id="description"
              rows={4}
              label={t.description}
              placeholder={t.descriptionPlaceholder}
              registration={form.register("description")}
              error={form.formState.errors.description?.message}
            />

            <div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">{t.images}</label>
                <div>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleFilesSelected}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading || images.length >= MAX_LISTING_IMAGES}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    {isUploading ? t.uploading : t.uploadPhotos}
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-500">{t.imagesHint}</p>

              {images.length > 0 ? (
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {images.map((image, index) => (
                    <div
                      key={image.storageId}
                      className="relative group aspect-video bg-slate-100 rounded-md overflow-hidden border border-slate-200"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={safeObjectUrl(image.previewUrl)}
                        alt={`Upload ${index + 1}`}
                        className="object-cover w-full h-full"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveImage(index)}
                        className="absolute top-1 end-1 bg-black/50 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-slate-500">{t.noImagesYet}</p>
              )}
              {imagesError && <p className="mt-2 text-xs text-rose-600">{imagesError}</p>}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || isUploading}
              className="w-full rounded-lg bg-slate-950 text-white py-2.5 font-medium hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? t.submitting : t.submit}
            </button>
          </form>
        )}

        <div className="mt-6 flex items-center justify-between text-sm">
          <Link href="/marketplace/cars" className="text-slate-500 hover:text-slate-800">
            {t.backToBrowse}
          </Link>
          {isAuthenticated && (
            <Link href="/marketplace/my-listings" className="text-slate-500 hover:text-slate-800">
              {t.myListings}
            </Link>
          )}
        </div>
      </section>
    </MarketplacePageShell>
  );
}
