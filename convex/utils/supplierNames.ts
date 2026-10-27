/**
 * Name and tax-identity keys for the supplier master (SCRUM-868 S1, design 3.3).
 *
 * A key exists to FIND candidates. It is never identity: two suppliers can share a name key and
 * stay two ids (invariant I4), and a name match never links a money row (I3). Keys are stored
 * next to the display value so the lookup is an indexed equality read.
 */

// Fathatan..sukun (U+064B-U+065F) and the superscript alef (U+0670).
const ARABIC_MARKS = /[ً-ٰٟ]/g;
const TATWEEL = /ـ/g;
// Alef with hamza above or below, alef with madda, alef wasla -> plain alef.
const ALEF_VARIANTS = /[أإآٱ]/g;
// Alef maqsura and Farsi yeh -> Arabic yeh.
const YA_VARIANTS = /[ىی]/g;
const WHITESPACE = /\s+/g;

export function normalizeNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(ARABIC_MARKS, "")
    .replace(TATWEEL, "")
    .replace(ALEF_VARIANTS, "ا")
    .replace(YA_VARIANTS, "ي")
    .toLowerCase()
    .replace(WHITESPACE, " ")
    .trim();
}

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

function foldDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const base = code >= EXTENDED_ARABIC_INDIC_ZERO ? EXTENDED_ARABIC_INDIC_ZERO : ARABIC_INDIC_ZERO;
    return String(code - base);
  });
}

/** Letters and digits only, Arabic-Indic digits folded to ASCII, upper-case. */
export function normalizeTaxIdKey(taxId: string): string {
  return foldDigits(taxId.normalize("NFKC"))
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();
}

export function normalizeTaxJurisdiction(jurisdiction: string): string {
  return jurisdiction.normalize("NFKC").trim().toUpperCase();
}
