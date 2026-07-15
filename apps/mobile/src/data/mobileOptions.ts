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
