"use client";

import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useConvexAuth } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import {
  CheckCircle2,
  Car,
  Globe2,
  Loader2,
  Store,
  Upload,
  X,
} from "lucide-react";
import {
  ALLOWED_CURRENCIES,
  LISTING_CONDITIONS,
  MAX_LISTING_IMAGES,
  SELLER_KINDS,
  listingSchema,
  type ListingFormValues,
} from "./listing.schema";

type Lang = "en" | "ar";

// Mirrors convex/utils/storageValidation.ts's MARKETPLACE_LISTING_IMAGE_CONTENT_TYPES
// / max size — checked client-side too so a rejected file is caught before an
// upload round-trip, not just by the server after it.
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    title: "List Your Car",
    subtitle: "Sell your own car, or list inventory as a dealer without an AutoFlow account.",
    toggleLang: "العربية",
    backToBrowse: "Back to Browse Cars",
    myListings: "My Listings",
    signInTitle: "Sign in to list your car",
    signInBody: "You'll need an AutoFlow account so we can verify your listing and let you manage it afterward.",
    signInCta: "Sign in",
    loading: "Loading...",
    sellerKindLabel: "Who's selling?",
    sellerKindIndividual: "I'm selling my own car",
    sellerKindDealer: "I'm a dealer without an AutoFlow account",
    sellerDisplayName: "Your name",
    sellerDisplayNamePlaceholder: "e.g. Ahmad Khalil",
    sellerPhone: "Phone number",
    sellerPhonePlaceholder: "e.g. +962 7 9999 9999",
    sellerWhatsapp: "WhatsApp (optional, if different)",
    make: "Make",
    makePlaceholder: "e.g. Toyota",
    model: "Model",
    modelPlaceholder: "e.g. Camry",
    year: "Year",
    mileage: "Mileage (km)",
    price: "Price",
    currency: "Currency",
    transmission: "Transmission",
    fuelType: "Fuel type",
    city: "City",
    cityPlaceholder: "e.g. Amman",
    description: "Description",
    descriptionPlaceholder: "Condition details, service history, extras...",
    condition: "Condition",
    conditionExcellent: "Excellent",
    conditionGood: "Good",
    conditionFair: "Fair",
    conditionPoor: "Poor",
    transmissionAutomatic: "Automatic",
    transmissionManual: "Manual",
    fuelGasoline: "Gasoline",
    fuelDiesel: "Diesel",
    fuelHybrid: "Hybrid",
    fuelElectric: "Electric",
    images: "Photos",
    imagesHint: `Upload between 1 and ${MAX_LISTING_IMAGES} photos of the car.`,
    uploadPhotos: "Upload photos",
    uploading: "Uploading...",
    noImagesYet: "No photos added yet.",
    imagesRequired: "At least one photo is required.",
    tooManyImages: `You can upload at most ${MAX_LISTING_IMAGES} photos.`,
    invalidImageType: "Only JPEG, PNG, or WEBP images are allowed.",
    imageTooLarge: "Image exceeds the 5MB size limit.",
    submit: "Submit listing",
    submitting: "Submitting...",
    successTitle: "Listing submitted!",
    successBody: "Your listing is now PENDING VERIFICATION — it will not appear publicly until an AutoFlow admin reviews and approves it.",
    viewMyListings: "View My Listings",
    genericError: "Something went wrong. Please try again.",
  },
  ar: {
    title: "أضف سيارتك للبيع",
    subtitle: "بع سيارتك الخاصة، أو أضف مخزونك كمعرض بدون حساب أوتوفلو.",
    toggleLang: "English",
    backToBrowse: "الرجوع إلى تصفّح السيارات",
    myListings: "إعلاناتي",
    signInTitle: "سجّل الدخول لإضافة سيارتك",
    signInBody: "تحتاج إلى حساب أوتوفلو حتى نتمكن من التحقق من إعلانك والسماح لك بإدارته لاحقاً.",
    signInCta: "تسجيل الدخول",
    loading: "جاري التحميل...",
    sellerKindLabel: "من البائع؟",
    sellerKindIndividual: "أنا أبيع سيارتي الخاصة",
    sellerKindDealer: "أنا معرض بدون حساب أوتوفلو",
    sellerDisplayName: "اسمك",
    sellerDisplayNamePlaceholder: "مثال: أحمد خليل",
    sellerPhone: "رقم الهاتف",
    sellerPhonePlaceholder: "مثال: 7 9999 9999 962+",
    sellerWhatsapp: "واتساب (اختياري، إن كان مختلفاً)",
    make: "الماركة",
    makePlaceholder: "مثال: تويوتا",
    model: "الموديل",
    modelPlaceholder: "مثال: كامري",
    year: "سنة الصنع",
    mileage: "الممشى (كم)",
    price: "السعر",
    currency: "العملة",
    transmission: "ناقل الحركة",
    fuelType: "نوع الوقود",
    city: "المدينة",
    cityPlaceholder: "مثال: عمّان",
    description: "الوصف",
    descriptionPlaceholder: "تفاصيل الحالة، سجل الصيانة، الإضافات...",
    condition: "الحالة",
    conditionExcellent: "ممتازة",
    conditionGood: "جيدة",
    conditionFair: "مقبولة",
    conditionPoor: "ضعيفة",
    transmissionAutomatic: "أوتوماتيك",
    transmissionManual: "عادي",
    fuelGasoline: "بنزين",
    fuelDiesel: "ديزل",
    fuelHybrid: "هايبرد",
    fuelElectric: "كهربائي",
    images: "الصور",
    imagesHint: `ارفع بين 1 و${MAX_LISTING_IMAGES} صورة للسيارة.`,
    uploadPhotos: "رفع صور",
    uploading: "جاري الرفع...",
    noImagesYet: "لم تتم إضافة صور بعد.",
    imagesRequired: "مطلوب صورة واحدة على الأقل.",
    tooManyImages: `يمكنك رفع ${MAX_LISTING_IMAGES} صورة كحد أقصى.`,
    invalidImageType: "يُسمح فقط بصور JPEG أو PNG أو WEBP.",
    imageTooLarge: "حجم الصورة يتجاوز الحد الأقصى (5 ميجابايت).",
    submit: "إرسال الإعلان",
    submitting: "جاري الإرسال...",
    successTitle: "تم إرسال الإعلان!",
    successBody: "إعلانك الآن قيد التحقق (PENDING VERIFICATION) — لن يظهر للعامة حتى يراجعه ويوافق عليه أحد مسؤولي أوتوفلو.",
    viewMyListings: "عرض إعلاناتي",
    genericError: "حدث خطأ ما. الرجاء المحاولة مرة أخرى.",
  },
};

type UploadedImage = {
  storageId: Id<"_storage">;
  previewUrl: string;
};

export default function MarketplaceSellPage() {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    const browserLang = typeof navigator !== "undefined" ? navigator.language : "en";
    if (browserLang.toLowerCase().startsWith("ar")) setLang("ar");
  }, []);
  const t = STRINGS[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

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
    setImages((prev) => prev.filter((_, i) => i !== index));
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
    <main dir={dir} className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-3xl px-4 py-4 flex items-center justify-between">
          <Link href="/marketplace/cars" className="flex items-center gap-2 font-semibold">
            <Store className="h-5 w-5" />
            AutoFlow
          </Link>
          <button
            type="button"
            onClick={() => setLang(lang === "en" ? "ar" : "en")}
            className="text-sm text-slate-600 hover:text-slate-950"
          >
            <Globe2 className="h-4 w-4 inline me-1" />
            {t.toggleLang}
          </button>
        </div>
      </header>

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
              <div>
                <label htmlFor="sellerDisplayName" className="text-sm font-medium block mb-1">
                  {t.sellerDisplayName}
                </label>
                <input
                  id="sellerDisplayName"
                  placeholder={t.sellerDisplayNamePlaceholder}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  {...form.register("sellerDisplayName")}
                />
                {form.formState.errors.sellerDisplayName && (
                  <p className="mt-1 text-xs text-rose-600">{form.formState.errors.sellerDisplayName.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="sellerPhone" className="text-sm font-medium block mb-1">
                  {t.sellerPhone}
                </label>
                <input
                  id="sellerPhone"
                  placeholder={t.sellerPhonePlaceholder}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  {...form.register("sellerPhone")}
                />
                {form.formState.errors.sellerPhone && (
                  <p className="mt-1 text-xs text-rose-600">{form.formState.errors.sellerPhone.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="sellerWhatsapp" className="text-sm font-medium block mb-1">
                  {t.sellerWhatsapp}
                </label>
                <input
                  id="sellerWhatsapp"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  {...form.register("sellerWhatsapp")}
                />
                {form.formState.errors.sellerWhatsapp && (
                  <p className="mt-1 text-xs text-rose-600">{form.formState.errors.sellerWhatsapp.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="city" className="text-sm font-medium block mb-1">
                  {t.city}
                </label>
                <input
                  id="city"
                  placeholder={t.cityPlaceholder}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  {...form.register("city")}
                />
                {form.formState.errors.city && (
                  <p className="mt-1 text-xs text-rose-600">{form.formState.errors.city.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="make" className="text-sm font-medium block mb-1">
                  {t.make}
                </label>
                <input
                  id="make"
                  placeholder={t.makePlaceholder}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  {...form.register("make")}
                />
                {form.formState.errors.make && (
                  <p className="mt-1 text-xs text-rose-600">{form.formState.errors.make.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="model" className="text-sm font-medium block mb-1">
                  {t.model}
                </label>
                <input
                  id="model"
                  placeholder={t.modelPlaceholder}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  {...form.register("model")}
                />
                {form.formState.errors.model && (
                  <p className="mt-1 text-xs text-rose-600">{form.formState.errors.model.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="year" className="text-sm font-medium block mb-1">
                  {t.year}
                </label>
                <input
                  id="year"
                  type="number"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  {...form.register("year")}
                />
                {form.formState.errors.year && (
                  <p className="mt-1 text-xs text-rose-600">{form.formState.errors.year.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="mileage" className="text-sm font-medium block mb-1">
                  {t.mileage}
                </label>
                <input
                  id="mileage"
                  type="number"
                  min={0}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  {...form.register("mileage")}
                />
                {form.formState.errors.mileage && (
                  <p className="mt-1 text-xs text-rose-600">{form.formState.errors.mileage.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="price" className="text-sm font-medium block mb-1">
                  {t.price}
                </label>
                <input
                  id="price"
                  type="number"
                  min={0}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  {...form.register("price")}
                />
                {form.formState.errors.price && (
                  <p className="mt-1 text-xs text-rose-600">{form.formState.errors.price.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="currency" className="text-sm font-medium block mb-1">
                  {t.currency}
                </label>
                <select
                  id="currency"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
                  {...form.register("currency")}
                >
                  {ALLOWED_CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="transmission" className="text-sm font-medium block mb-1">
                  {t.transmission}
                </label>
                <select
                  id="transmission"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
                  {...form.register("transmission")}
                >
                  <option value="Automatic">{t.transmissionAutomatic}</option>
                  <option value="Manual">{t.transmissionManual}</option>
                </select>
              </div>
              <div>
                <label htmlFor="fuelType" className="text-sm font-medium block mb-1">
                  {t.fuelType}
                </label>
                <select
                  id="fuelType"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
                  {...form.register("fuelType")}
                >
                  <option value="Gasoline">{t.fuelGasoline}</option>
                  <option value="Diesel">{t.fuelDiesel}</option>
                  <option value="Hybrid">{t.fuelHybrid}</option>
                  <option value="Electric">{t.fuelElectric}</option>
                </select>
              </div>
              <div>
                <label htmlFor="condition" className="text-sm font-medium block mb-1">
                  {t.condition}
                </label>
                <select
                  id="condition"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
                  {...form.register("condition")}
                >
                  {LISTING_CONDITIONS.map((condition) => (
                    <option key={condition} value={condition}>
                      {t[`condition${condition.charAt(0)}${condition.slice(1).toLowerCase()}`] ?? condition}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="description" className="text-sm font-medium block mb-1">
                {t.description}
              </label>
              <textarea
                id="description"
                rows={4}
                placeholder={t.descriptionPlaceholder}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                {...form.register("description")}
              />
              {form.formState.errors.description && (
                <p className="mt-1 text-xs text-rose-600">{form.formState.errors.description.message}</p>
              )}
            </div>

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
                      <img src={image.previewUrl} alt={`Upload ${index + 1}`} className="object-cover w-full h-full" />
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
    </main>
  );
}
