type UnknownRecord = Readonly<Record<string, unknown>>;

export type MobileVinReadiness =
  | "empty"
  | "incomplete"
  | "invalid-characters"
  | "checksum-warning"
  | "ready";

export type MobileVinDecodedFields = Readonly<{
  vin: string;
  make?: string;
  model?: string;
  trim?: string;
  year?: number;
  fuelType?: string;
}>;

export function normalizeVinInput(value: string): string {
  return value.replace(/[\s-]+/g, "").trim().toUpperCase();
}

export function hasInvalidMobileVinCharacters(vin: string): boolean {
  return /[^A-HJ-NPR-Z0-9]/i.test(vin);
}

export function decodeMobileVinYear(char: string): number | undefined {
  const base: Record<string, number> = {
    A: 1980,
    B: 1981,
    C: 1982,
    D: 1983,
    E: 1984,
    F: 1985,
    G: 1986,
    H: 1987,
    J: 1988,
    K: 1989,
    L: 1990,
    M: 1991,
    N: 1992,
    P: 1993,
    R: 1994,
    S: 1995,
    T: 1996,
    V: 1997,
    W: 1998,
    X: 1999,
    Y: 2000,
    "1": 2001,
    "2": 2002,
    "3": 2003,
    "4": 2004,
    "5": 2005,
    "6": 2006,
    "7": 2007,
    "8": 2008,
    "9": 2009,
  };
  const year = base[char?.toUpperCase()];
  if (!year) return undefined;
  return /\d/.test(char) ? year : undefined;
}

export function toMobileCarBrand(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

export function cleanMobileMfrName(value: string): string {
  const cleaned = value
    .replace(/\b(CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|INC|AUTO|MOTOR|MOTORS|AUTOMOTIVE|MANUFACTURING|AG|GROUP)\b\.?,?/gi, " ")
    .replace(/[,./\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || value.split(/\s+/)[0] || "";
}

const VIN_TRANSLITERATION: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};

const VIN_CHECK_DIGIT_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

export function validateMobileVinChecksum(vin: string): boolean {
  const upper = normalizeVinInput(vin);
  if (upper.length !== 17 || hasInvalidMobileVinCharacters(upper)) return false;

  let sum = 0;
  for (let index = 0; index < upper.length; index += 1) {
    const char = upper[index];
    const value = /\d/.test(char) ? Number(char) : VIN_TRANSLITERATION[char]!;
    sum += value * VIN_CHECK_DIGIT_WEIGHTS[index];
  }

  const remainder = sum % 11;
  const expected = remainder === 10 ? "X" : String(remainder);
  return upper[8] === expected;
}

export function getMobileVinReadiness(value: string): MobileVinReadiness {
  const vin = normalizeVinInput(value);
  if (!vin) return "empty";
  if (hasInvalidMobileVinCharacters(vin)) return "invalid-characters";
  if (vin.length !== 17) return "incomplete";
  return validateMobileVinChecksum(vin) ? "ready" : "checksum-warning";
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getFirstNhtsaResult(payload: unknown): UnknownRecord {
  const record = asRecord(payload);
  const results = record?.Results;
  return Array.isArray(results) ? (asRecord(results[0]) ?? {}) : {};
}

export function getFirstNhtsaWmiName(payload: unknown): string {
  const firstResult = getFirstNhtsaResult(payload);
  return asString(firstResult.Name) ?? "";
}

export function mapFuelType(rawFuelType: string | undefined): string | undefined {
  const value = rawFuelType?.toLowerCase() ?? "";
  if (value.includes("gasoline") || value.includes("petrol")) return "Gasoline";
  if (value.includes("diesel")) return "Diesel";
  if (value.includes("hybrid")) return "Hybrid";
  if (value.includes("electric")) return "Electric";
  return undefined;
}

export function mapNhtsaVinPayload({
  vin,
  vinValues,
  wmiName,
}: {
  vin: string;
  vinValues: UnknownRecord;
  wmiName?: string;
}): MobileVinDecodedFields {
  const normalizedVin = normalizeVinInput(vin);
  const makeFromWmi = wmiName ? toMobileCarBrand(cleanMobileMfrName(wmiName)) : undefined;
  const makeFromVin = asString(vinValues.Make) ? toMobileCarBrand(asString(vinValues.Make)!) : undefined;
  const modelSource = asString(vinValues.Model) ?? asString(vinValues.Series);
  const yearSource = asString(vinValues.ModelYear);
  const parsedYear = yearSource ? Number.parseInt(yearSource, 10) : undefined;
  const fallbackYear = normalizedVin.length >= 10 ? decodeMobileVinYear(normalizedVin[9]) : undefined;

  return {
    vin: normalizedVin,
    make: makeFromWmi ?? makeFromVin,
    model: modelSource ? toMobileCarBrand(modelSource) : undefined,
    trim: asString(vinValues.Trim),
    year: parsedYear !== undefined && Number.isFinite(parsedYear) ? parsedYear : fallbackYear,
    fuelType: mapFuelType(asString(vinValues.FuelTypePrimary)),
  };
}
