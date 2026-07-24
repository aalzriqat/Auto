import type { SearchableSelectOption } from "../components/SearchableSelectField";

type Locale = "en" | "ar";

const VEHICLE_MAKES = [
  "Toyota",
  "Hyundai",
  "Kia",
  "Nissan",
  "Mercedes-Benz",
  "BMW",
  "Lexus",
  "Ford",
  "Chevrolet",
  "GMC",
  "Mitsubishi",
  "Honda",
  "Mazda",
  "Volkswagen",
  "Audi",
  "Land Rover",
  "Range Rover",
  "Jeep",
  "Tesla",
  "BYD",
] as const;

const JORDAN_CITIES: Array<{ ar: string; en: string }> = [
  { en: "Amman", ar: "عمان" },
  { en: "Zarqa", ar: "الزرقاء" },
  { en: "Irbid", ar: "إربد" },
  { en: "Aqaba", ar: "العقبة" },
  { en: "Salt", ar: "السلط" },
  { en: "Madaba", ar: "مادبا" },
  { en: "Karak", ar: "الكرك" },
  { en: "Mafraq", ar: "المفرق" },
  { en: "Jerash", ar: "جرش" },
  { en: "Ajloun", ar: "عجلون" },
  { en: "Maan", ar: "معان" },
  { en: "Tafileh", ar: "الطفيلة" },
] as const;

const COLORS: Array<{ ar: string; en: string }> = [
  { en: "White", ar: "أبيض" },
  { en: "Black", ar: "أسود" },
  { en: "Silver", ar: "فضي" },
  { en: "Gray", ar: "رمادي" },
  { en: "Blue", ar: "أزرق" },
  { en: "Red", ar: "أحمر" },
  { en: "Green", ar: "أخضر" },
  { en: "Beige", ar: "بيج" },
  { en: "Brown", ar: "بني" },
  { en: "Gold", ar: "ذهبي" },
] as const;

const FUEL_TYPES: Array<{ ar: string; en: string }> = [
  { en: "Gasoline", ar: "بنزين" },
  { en: "Diesel", ar: "ديزل" },
  { en: "Hybrid", ar: "هايبرد" },
  { en: "Electric", ar: "كهربائي" },
] as const;

const TRANSMISSIONS: Array<{ ar: string; en: string }> = [
  { en: "Automatic", ar: "أوتوماتيك" },
  { en: "Manual", ar: "يدوي" },
] as const;

export function getVehicleMakeOptions(): SearchableSelectOption[] {
  return VEHICLE_MAKES.map((make) => ({ label: make, value: make }));
}

// A curated shortlist of the most-requested makes, surfaced as one-tap filter
// chips on the marketplace Browse landing. `value` is the English make string
// the search backend matches case-insensitively; the label is localized.
// Ordered by local popularity, but the brands we already have emblem art for
// (BMW, Audi) are pulled slightly forward so a logo is visible without
// scrolling — the rest render as text pills until their logo lands.
const BRAND_CHIPS: Array<{ ar: string; en: string; value: string }> = [
  { value: "Toyota", en: "Toyota", ar: "تويوتا" },
  { value: "Hyundai", en: "Hyundai", ar: "هيونداي" },
  { value: "BMW", en: "BMW", ar: "بي إم دبليو" },
  { value: "Kia", en: "Kia", ar: "كيا" },
  { value: "Audi", en: "Audi", ar: "أودي" },
  { value: "Nissan", en: "Nissan", ar: "نيسان" },
  { value: "Mercedes-Benz", en: "Mercedes", ar: "مرسيدس" },
  { value: "Lexus", en: "Lexus", ar: "لكزس" },
  { value: "BYD", en: "BYD", ar: "بي واي دي" },
  { value: "BAIC", en: "BAIC", ar: "بايك" },
  { value: "BAW", en: "BAW", ar: "باو" },
] as const;

export function getVehicleBrandChipOptions(locale: Locale): SearchableSelectOption[] {
  return BRAND_CHIPS.map((brand) => ({
    label: locale === "ar" ? brand.ar : brand.en,
    value: brand.value,
  }));
}

export function getJordanCityOptions(locale: Locale): SearchableSelectOption[] {
  return JORDAN_CITIES.map((city) => ({
    label: locale === "ar" ? city.ar : city.en,
    subLabel: locale === "ar" ? city.en : city.ar,
    value: city.en,
  }));
}

export function getVehicleColorOptions(locale: Locale): SearchableSelectOption[] {
  return COLORS.map((color) => ({
    label: locale === "ar" ? color.ar : color.en,
    subLabel: locale === "ar" ? color.en : color.ar,
    value: color.en,
  }));
}

export function getFuelTypeOptions(locale: Locale): SearchableSelectOption[] {
  return FUEL_TYPES.map((fuelType) => ({
    label: locale === "ar" ? fuelType.ar : fuelType.en,
    subLabel: locale === "ar" ? fuelType.en : fuelType.ar,
    value: fuelType.en,
  }));
}

export function getTransmissionOptions(locale: Locale): SearchableSelectOption[] {
  return TRANSMISSIONS.map((transmission) => ({
    label: locale === "ar" ? transmission.ar : transmission.en,
    subLabel: locale === "ar" ? transmission.en : transmission.ar,
    value: transmission.en,
  }));
}
