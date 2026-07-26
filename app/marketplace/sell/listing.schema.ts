import * as z from "zod";

// Mirrors convex/marketplaceListings.ts's ALLOWED_CURRENCIES exactly — kept as
// a local literal (like app/marketplace/cars/page.tsx's own BrowseVehicle
// mirroring) rather than importing from convex/*.ts, since this route group
// hand-mirrors backend shapes instead of importing server-only modules.
export const ALLOWED_CURRENCIES = ["JOD", "USD", "SAR", "AED", "KWD", "EGP", "QAR", "BHD", "OMR"] as const;

export const SELLER_KINDS = ["INDIVIDUAL", "UNAFFILIATED_DEALER"] as const;
export const LISTING_CONDITIONS = ["EXCELLENT", "GOOD", "FAIR", "POOR"] as const;

// The backend stores transmission/fuelType as free text (no enum to mirror),
// so these are the values the UI offers. Shared by the create and edit forms
// so editing a listing can't introduce a value the create form would never
// produce.
export const TRANSMISSIONS = ["Automatic", "Manual"] as const;
export const FUEL_TYPES = ["Gasoline", "Diesel", "Hybrid", "Electric"] as const;

// Same bound createListing enforces server-side (MAX_LISTING_IMAGES in
// convex/marketplaceListings.ts) — checked client-side too so a seller finds
// out before uploading 21 images, not after the mutation rejects it.
export const MAX_LISTING_IMAGES = 20;

// Mirrors MIN_LISTING_YEAR / assertValidYear's max-year rule in
// convex/marketplaceListings.ts.
const MIN_LISTING_YEAR = 1980;
const MAX_LISTING_YEAR = new Date().getFullYear() + 1;

// Mirrors the MAX_*_LENGTH constants in convex/marketplaceListings.ts exactly,
// so client-side validation gives the same feedback the server would.
const MAX_SELLER_DISPLAY_NAME_LENGTH = 120;
const MAX_SELLER_PHONE_LENGTH = 32;
const MAX_CITY_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_MAKE_LENGTH = 60;
const MAX_MODEL_LENGTH = 60;
const MAX_TRANSMISSION_LENGTH = 40;
const MAX_FUEL_TYPE_LENGTH = 40;

export const listingSchema = z.object({
  sellerKind: z.enum(SELLER_KINDS),
  sellerDisplayName: z
    .string()
    .trim()
    .min(1, "Your name is required.")
    .max(MAX_SELLER_DISPLAY_NAME_LENGTH, `Must be at most ${MAX_SELLER_DISPLAY_NAME_LENGTH} characters.`),
  sellerPhone: z
    .string()
    .trim()
    .min(1, "A phone number is required.")
    .max(MAX_SELLER_PHONE_LENGTH, `Must be at most ${MAX_SELLER_PHONE_LENGTH} characters.`),
  sellerWhatsapp: z
    .string()
    .trim()
    .max(MAX_SELLER_PHONE_LENGTH, `Must be at most ${MAX_SELLER_PHONE_LENGTH} characters.`)
    .optional()
    .or(z.literal("")),
  make: z.string().trim().min(1, "Make is required.").max(MAX_MAKE_LENGTH, `Must be at most ${MAX_MAKE_LENGTH} characters.`),
  model: z.string().trim().min(1, "Model is required.").max(MAX_MODEL_LENGTH, `Must be at most ${MAX_MODEL_LENGTH} characters.`),
  year: z.coerce
    .number()
    .int("Year must be a whole number.")
    .min(MIN_LISTING_YEAR, `Year must be ${MIN_LISTING_YEAR} or later.`)
    .max(MAX_LISTING_YEAR, `Year cannot be later than ${MAX_LISTING_YEAR}.`),
  mileage: z.coerce.number().min(0, "Mileage cannot be negative."),
  price: z.coerce.number().gt(0, "Price must be greater than zero."),
  currency: z.enum(ALLOWED_CURRENCIES),
  transmission: z
    .string()
    .trim()
    .min(1, "Transmission is required.")
    .max(MAX_TRANSMISSION_LENGTH, `Must be at most ${MAX_TRANSMISSION_LENGTH} characters.`),
  fuelType: z
    .string()
    .trim()
    .min(1, "Fuel type is required.")
    .max(MAX_FUEL_TYPE_LENGTH, `Must be at most ${MAX_FUEL_TYPE_LENGTH} characters.`),
  city: z.string().trim().min(1, "City is required.").max(MAX_CITY_LENGTH, `Must be at most ${MAX_CITY_LENGTH} characters.`),
  description: z
    .string()
    .trim()
    .min(1, "Description is required.")
    .max(MAX_DESCRIPTION_LENGTH, `Must be at most ${MAX_DESCRIPTION_LENGTH} characters.`),
  condition: z.enum(LISTING_CONDITIONS),
});

export type ListingFormValues = z.infer<typeof listingSchema>;

// Every field updateListing can patch is optional there — reused by the
// my-listings inline editor so edits get the same bounds without duplicating
// them.
export const listingUpdateSchema = listingSchema.omit({ sellerKind: true }).partial();

export type ListingUpdateValues = z.infer<typeof listingUpdateSchema>;
