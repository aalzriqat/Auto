/**
 * Rule-based (no LLM) intent matching for the Smart Reply auto-answer feature.
 * Pure functions only -- no `ctx` dependency -- so they can run inside an
 * internalMutation without any extra Convex plumbing.
 */

export type SmartReplyIntent =
  | "complaint"
  | "price"
  | "financing"
  | "availability"
  | "vehicleInfo"
  | "location"
  | "greeting";

/**
 * Lowercases, strips Arabic diacritics/tatweel, normalizes alef/ta-marbuta/
 * alef-maksura spelling variants, and strips bidi control marks Instagram
 * sometimes injects -- so different spellings of the same word match.
 */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    // tashkeel (diacritics, U+064B-0652) + madda/hamza-above/hamza-below
    // combining marks (U+0653-0655, surfaced by NFKD decomposing precomposed
    // hamza-on-alef letters) + tatweel (U+0640)
    .replace(/[ً-ٕـ]/g, "")
    .replace(/[أإآٱ]/g, "ا") // any remaining precomposed alef variants -> bare alef
    .replace(/ة/g, "ه") // ta marbuta -> ha (common informal spelling drift)
    .replace(/ى/g, "ي") // alef maksura -> ya
    .replace(/[‎‏]/g, "") // LTR/RTL marks
    .trim();
}

const ARABIC_CHAR_RE = /[؀-ۿ]/g;
const LATIN_CHAR_RE = /[a-zA-Z]/g;

/**
 * Returns "ar"/"en" based on which script dominates the inbound text, or
 * null when the text has no matchable script (emoji-only, numeric-only) --
 * callers should fall back to the org's configured default locale in that case.
 */
export function detectLocale(text: string | undefined): "en" | "ar" | null {
  if (!text) return null;
  const arabicChars = (text.match(ARABIC_CHAR_RE) ?? []).length;
  const latinChars = (text.match(LATIN_CHAR_RE) ?? []).length;
  if (arabicChars === 0 && latinChars === 0) return null;
  return arabicChars >= latinChars ? "ar" : "en";
}

interface KeywordRule {
  intent: SmartReplyIntent;
  patterns: string[];
}

// Keyword bank seeded from real dealership comment phrasing (EN + Arabic +
// Arabizi/colloquial transliteration). Extend over time as real comment data
// comes in. Phase 2 intents (test drive, trade-in, booking, urgent buyer,
// contact request, delivery, negotiation, lead qualification) are
// intentionally not included here -- they are routing/priority signals, not
// answerable facts, and are out of scope for this feature (see project plan).
const KEYWORD_RULES: KeywordRule[] = [
  {
    // Checked first -- a complaint must never be answered with a cheerful
    // price/availability reply just because both kinds of words appear.
    intent: "complaint",
    patterns: [
      "bad",
      "problem",
      "issue",
      "not working",
      "wrong",
      "complaint",
      "مشكله",
      "عطل",
      "سيئه",
      "مش صحيح",
      "شكوي",
      "مو راضي",
    ],
  },
  {
    intent: "price",
    patterns: [
      "how much",
      "price",
      "cost",
      "asking price",
      "final price",
      "best price",
      "cash price",
      "offer price",
      "discount",
      "quote",
      "quotation",
      // NOTE: bare "كم" ("how much/many") is deliberately excluded -- it's
      // also the generic Arabic interrogative used in "كم ماشيتها" (mileage),
      // "كم القسط" (financing), "كم سلندر" (specs), etc. Only compound
      // phrases that are unambiguously about price are listed here.
      "بكم",
      "السعر",
      "كم سعر",
      "بقديش",
      "قديش",
      "شو سعرها",
      "كم طالب فيها",
      "السوم",
      "اخر سعر",
      "افضل سعر",
      "كاش كم",
      "خصم",
      "عرض سعر",
      "2adesh",
      "adeesh",
      "bkam",
      "se3r",
      "s3r",
    ],
  },
  {
    intent: "financing",
    patterns: [
      "installment",
      "installments",
      "monthly payment",
      "finance",
      "financing",
      "loan",
      "leasing",
      "down payment",
      "deposit",
      "monthly",
      "bank finance",
      "credit",
      "payment plan",
      "تقسيط",
      "قسط",
      "اقساط",
      "تمويل",
      "تمويل بنكي",
      "دفعه اولي",
      "دفعه مقدمه",
      "كم القسط",
      "كم شهري",
      "مرابحه",
      "بنك",
      "تمويل السياره",
      "ta2seet",
      "taqseet",
      "2est",
      "qest",
      "tamweel",
    ],
  },
  {
    intent: "availability",
    patterns: [
      "still available",
      "is it available",
      "availability",
      "available",
      "still have it",
      "in stock",
      "sold out",
      "sold",
      "reserved",
      "booked",
      "متوفر",
      "موجود",
      "لسه موجود",
      "بعدها موجوده",
      "مباعه",
      "بيعت",
      "محجوزه",
      "خلصت",
      "موجوده",
      "mawjood",
    ],
  },
  {
    intent: "vehicleInfo",
    patterns: [
      "year",
      "model",
      "mileage",
      "condition",
      "specs",
      "specifications",
      "engine",
      "horsepower",
      "trim",
      "features",
      "options",
      "موديل",
      "سنه",
      "سنه الصنع",
      "ممشي",
      "كم ماشيه",
      "ماشيتها",
      "ممشاها",
      "مواصفات",
      "فئه",
      "فل",
      "فل كامل",
      "محرك",
      "موتور",
      "جير",
      "قير",
      "كم سلندر",
      "مواصفاتها",
    ],
  },
  {
    intent: "location",
    patterns: ["where", "location", "address", "showroom", "branch", "وين", "العنوان", "الموقع", "المعرض وين", "اي فرع", "مكانكم", "لوكيشن"],
  },
  {
    // Lowest priority -- only fires when nothing else matched, so "hi, how
    // much is it" still resolves to "price", not "greeting".
    intent: "greeting",
    patterns: [
      "hi",
      "hello",
      "hey",
      "good morning",
      "good evening",
      "السلام عليكم",
      "مرحبا",
      "هلا",
      "اهلا",
      "يعطيكم العافيه",
      "صباح الخير",
      "مساء الخير",
    ],
  },
];

/**
 * Matches inbound comment/DM text to a Smart Reply intent. Fixed priority
 * order: complaint > price > financing > availability > vehicleInfo >
 * location > greeting. Substring match against the whole normalized text
 * (not tokenized), so a comment can legitimately contain multiple intents'
 * keywords -- the fixed order resolves the tie deterministically.
 */
export function matchIntent(rawText: string | undefined): SmartReplyIntent | null {
  if (!rawText) return null;
  const text = normalizeText(rawText);
  if (!text) return null;

  for (const rule of KEYWORD_RULES) {
    if (rule.patterns.some((pattern) => text.includes(normalizeText(pattern)))) {
      return rule.intent;
    }
  }
  return null;
}
