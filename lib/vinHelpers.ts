export function decodeVinYear(char: string): number | null {
  const base: Record<string, number> = {
    A: 1980, B: 1981, C: 1982, D: 1983, E: 1984, F: 1985, G: 1986, H: 1987,
    J: 1988, K: 1989, L: 1990, M: 1991, N: 1992, P: 1993, R: 1994, S: 1995,
    T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000,
    "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005,
    "6": 2006, "7": 2007, "8": 2008, "9": 2009,
  };
  const year = base[char?.toUpperCase()];
  if (!year) return null;
  const now = new Date().getFullYear();
  return year + 30 <= now + 2 ? year + 30 : year;
}

export function toCarBrand(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

export function cleanMfrName(mfr: string): string {
  const cleaned = mfr
    .replace(/\b(CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|INC|AUTO|MOTOR|MOTORS|AUTOMOTIVE|MANUFACTURING|AG|GROUP)\b\.?,?/gi, " ")
    .replace(/[,./\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || mfr.split(/\s+/)[0];
}

/** I, O, and Q are never valid VIN characters (any region/scheme) — easily mistaken for 1, 0, 9. */
export function hasInvalidVinCharacters(vin: string): boolean {
  return /[IOQ]/i.test(vin);
}

const VIN_TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

const VIN_CHECK_DIGIT_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * Validates the ISO 3779 / NHTSA check-digit (position 9) for a 17-char VIN.
 * This convention is North-America-specific — many non-NA-built vehicles
 * legitimately fail it, so callers must treat a `false` result as an
 * advisory warning, never a hard rejection.
 */
export function validateVinChecksum(vin: string): boolean {
  const upper = vin.trim().toUpperCase();
  if (upper.length !== 17 || hasInvalidVinCharacters(upper)) return false;

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const char = upper[i];
    const value = /\d/.test(char) ? Number(char) : VIN_TRANSLITERATION[char];
    if (value === undefined) return false;
    sum += value * VIN_CHECK_DIGIT_WEIGHTS[i];
  }

  const remainder = sum % 11;
  const expectedCheckChar = remainder === 10 ? "X" : String(remainder);
  return upper[8] === expectedCheckChar;
}
