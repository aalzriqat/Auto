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
// Teh marbuta -> heh, as Lucene's ArabicNormalizer does (the ending of "شركة"/"شركه" is written both ways).
const TEH_MARBUTA = /ة/g;
// Any Unicode punctuation (general category P): hyphen, full stop, comma, brackets, quotes, the
// Arabic comma and question mark. It becomes a space, so "Al-Noor Co." and "Al Noor Co" share a key.
const PUNCTUATION = /\p{P}/gu;
const WHITESPACE = /\s+/g;
// Invisible code points: format characters (Cf: bidi marks such as RLM and LRM, ZWSP, ZWNJ, ZWJ,
// soft hyphen, BOM) and Default_Ignorable_Code_Point. Unicode's own NFKC_Casefold mapping removes
// the latter (UAX #15, Unicode Standard 3.13), and UTS #39 removes them when it builds a name
// skeleton, so a trailing RLM or a soft hyphen cannot make two visibly equal names differ.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Orders two strings by UTF-16 code unit, which is what a bare `Array.prototype.sort()` does and
 * what the `<` operator on strings does. It is the order the candidate list and the confirmation
 * fingerprint were built on. Not `localeCompare`: that depends on the runtime's locale data and
 * ranks "a" before "B", which would change a stored fingerprint's input order.
 */
export function codeUnitCompare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Lookup key for a name: NFKC, Arabic-Indic digits mapped to ASCII, invisible characters removed,
 * Arabic marks and tatweel removed, alef, ya and teh marbuta folded, punctuation read as
 * whitespace, case folded, whitespace collapsed.
 *
 * JavaScript has no built-in full case folding. Upper-casing and then lower-casing approximates
 * Unicode full case folding (CaseFolding.txt, status C and F) for the cases that matter here:
 * "ß" becomes "ss", and every sigma form ends on one letter because the lower-casing step applies
 * the Final_Sigma rule. It also folds the Turkish dotless "ı" into "i", which full case folding
 * does not. For a key that only finds candidates, that over-match is the safe direction.
 */
export function normalizeNameKey(name: string): string {
  return foldDigits(name.normalize("NFKC"))
    .replace(INVISIBLE, "")
    .replace(ARABIC_MARKS, "")
    .replaceAll(TATWEEL, "")
    .replace(ALEF_VARIANTS, "ا")
    .replace(YA_VARIANTS, "ي")
    .replace(TEH_MARBUTA, "ه")
    .replace(PUNCTUATION, " ")
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

/**
 * The officially assigned ISO 3166-1 alpha-2 country codes: 249 of them.
 *
 * Source: ISO 3166-1 (https://www.iso.org/iso-3166-country-codes.html), the assigned set of
 * 249 codes. The list is written out here so that a code is checked against a fixed set, not
 * against whatever an ICU build of the runtime happens to know. It was cross-checked against
 * the CLDR region list that Node's `Intl.DisplayNames` carries: all 249 are present there, and
 * the codes CLDR has in addition are exactly the ones ISO does not assign (exceptional
 * reservations such as UK, EU and AC; retired codes such as YU, SU and ZR; user-assigned codes
 * such as XK, XA and ZZ). Those are refused on purpose: `UK` is not the code for the United
 * Kingdom (that is `GB`), and two spellings of one country would be two legal identities.
 */
export const ISO_3166_1_ALPHA_2: ReadonlySet<string> = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
    "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
    "DE DJ DK DM DO DZ " +
    "EC EE EG EH ER ES ET " +
    "FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
    "HK HM HN HR HT HU " +
    "ID IE IL IM IN IO IQ IR IS IT " +
    "JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ " +
    "LA LB LC LI LK LR LS LT LU LV LY " +
    "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
    "NA NC NE NF NG NI NL NO NP NR NU NZ " +
    "OM " +
    "PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
    "QA " +
    "RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
    "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
    "UA UG UM US UY UZ " +
    "VA VC VE VG VI VN VU " +
    "WF WS " +
    "YE YT " +
    "ZA ZM ZW"
  ).split(" "),
);

/** NFKC, trimmed, upper-case. Does not decide validity: see `isValidTaxJurisdiction`. */
export function normalizeTaxJurisdiction(jurisdiction: string): string {
  return jurisdiction.normalize("NFKC").trim().toUpperCase();
}

/**
 * True for a normalised jurisdiction that is an assigned ISO 3166-1 alpha-2 country code, and
 * nothing else. A subdivision suffix ("JO-AM", an invented "JO-XYZ") is refused: the legal identity
 * is the tax id plus the jurisdiction, so "JO", "JO-AM" and "JO-XYZ" would be three identities for
 * one company. Free text ("JOR", "Jordan", "J.O.") is refused for the same reason.
 */
export function isValidTaxJurisdiction(normalised: string): boolean {
  return ISO_3166_1_ALPHA_2.has(normalised);
}
