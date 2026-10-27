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
// Invisible code points: format characters (Cf: bidi marks such as RLM and LRM, ZWSP, ZWNJ, ZWJ,
// soft hyphen, BOM) and Default_Ignorable_Code_Point. Unicode's own NFKC_Casefold mapping removes
// the latter (UAX #15, Unicode Standard 3.13), and UTS #39 removes them when it builds a name
// skeleton, so a trailing RLM or a soft hyphen cannot make two visibly equal names differ.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Lookup key for a name: NFKC, invisible characters removed, Arabic marks and tatweel removed,
 * alef and ya folded, case folded, whitespace collapsed.
 *
 * JavaScript has no built-in full case folding. Upper-casing and then lower-casing approximates
 * Unicode full case folding (CaseFolding.txt, status C and F) for the cases that matter here:
 * "ß" becomes "ss", and every sigma form ends on one letter because the lower-casing step applies
 * the Final_Sigma rule. It also folds the Turkish dotless "ı" into "i", which full case folding
 * does not. For a key that only finds candidates, that over-match is the safe direction.
 */
export function normalizeNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(ARABIC_MARKS, "")
    .replace(TATWEEL, "")
    .replace(ALEF_VARIANTS, "ا")
    .replace(YA_VARIANTS, "ي")
    .toUpperCase()
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
