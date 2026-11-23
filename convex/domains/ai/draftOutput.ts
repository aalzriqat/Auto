import type { DraftContext } from "./draftContext";
import { DRAFT_TOKENS, draftTokenValues, type DraftToken, type DraftTokenValues } from "./draftPrompt";

export const HANDOVER_SENTENCE_EN =
  "Thank you for your message. One of our sales team will get back to you shortly with the details.";
export const HANDOVER_SENTENCE_AR =
  "شكرًا لتواصلك معنا. سيتواصل معك أحد موظفي المبيعات قريبًا لتزويدك بالتفاصيل.";

export const MAX_DRAFT_BYTES = 1000;

/** What the model answered, after the provider seam has parsed it. */
export interface DraftModelOutput {
  outcome: "draft" | "needs_person";
  text: string;
}

export type DraftDecision =
  | { status: "ready"; text: string; handoverFallback: boolean }
  | { status: "needs_person" };

/**
 * The fixed wording list (owner rulings 11 and 20: no discount, negotiation or
 * promise, and money and safety rules live in code, not in the prompt). Any
 * match in the model's text replaces the whole text with the handover sentence,
 * exactly like a digit does.
 *
 * English entries are regular expression sources, matched case-insensitively
 * with word boundaries added around each. Arabic entries are matched on text
 * normalized as `normalizeArabic` does (no tashkeel or tatweel; alef variants
 * become alef, alef maqsura becomes yaa, taa marbuta becomes haa), and are
 * written in that normalized form. `substrings` match anywhere in a word;
 * `words` match a whole word that may carry one prefix letter (w, f, b, l, k)
 * and the definite article, because a bare substring would also hit ordinary
 * words (for example "wa'd" inside "maw'id", an appointment, or "alf" inside
 * "alfahs", an inspection).
 *
 * Known limit: wording this list does not name passes. The staff member reads
 * every draft before sending it.
 */
export const DRAFT_FORBIDDEN_WORDING = {
  discount: {
    english: [
      "discounts?|discounted",
      "cheaper|cheapest",
      "lower prices?",
      "price cuts?",
      "reduce[ds]?|reduction|reductions",
      "off the price",
      // "under" directly before a price token states a lower figure.
      "under\\s+\\{\\{(?:LISTED_PRICE|MONTHLY_PAYMENT)\\}\\}",
    ],
    arabic: { substrings: ["خصم", "تخفيض", "تنزيل", "اقل من", "ارخص"], words: [] as string[] },
  },
  negotiation: {
    english: ["negotiable|negotiate[ds]?|negotiating|negotiations?", "best price"],
    arabic: { substrings: ["تفاوض", "اخر سعر"], words: [] as string[] },
  },
  promise: {
    english: [
      "guarantee[ds]?",
      "promise[ds]?",
      "(?:hold|reserve)\\b[^.!?\\n]{0,30}\\bfor you",
      "set\\b[^.!?\\n]{0,30}\\baside",
      // "feel free to ..." is a courtesy, not an offer of something for nothing.
      "(?<!feel )free",
      "no down payment",
    ],
    arabic: {
      substrings: ["مضمون", "نضمن", "اضمن", "نعدك", "حجز", "مجانا", "مجاني", "بدون دفعه"],
      words: ["وعد"],
    },
  },
  amount: {
    english: ["per ?cent", "hundreds?", "thousands?", "millions?"],
    arabic: {
      substrings: ["بالمئه", "بالمائه", "في المئه", "في المائه", "مليون"],
      words: ["مئه", "مائه", "مئتين", "مائتين", "الف", "الاف"],
    },
  },
} as const;

const TASHKEEL_AND_TATWEEL = /[ً-ْـ]/g;

function normalizeArabic(text: string): string {
  return text
    .replace(TASHKEEL_AND_TATWEEL, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ENGLISH_WORDING = new RegExp(
  `\\b(?:${Object.values(DRAFT_FORBIDDEN_WORDING).flatMap((family) => family.english).join("|")})(?![\\p{L}])`,
  "iu",
);
const ARABIC_SUBSTRINGS = Object.values(DRAFT_FORBIDDEN_WORDING).flatMap((family) =>
  family.arabic.substrings.map(normalizeArabic),
);
const ARABIC_WORDS = new RegExp(
  `(?<![\\p{L}])[وفبلك]?(?:ال)?(?:${Object.values(DRAFT_FORBIDDEN_WORDING)
    .flatMap((family) => family.arabic.words.map(normalizeArabic))
    .map(escapeForRegex)
    .join("|")})(?![\\p{L}])`,
  "u",
);

function containsForbiddenWording(text: string): boolean {
  if (ENGLISH_WORDING.test(text)) return true;
  const arabic = normalizeArabic(text);
  return ARABIC_SUBSTRINGS.some((term) => arabic.includes(term)) || ARABIC_WORDS.test(arabic);
}

const TOKEN_PATTERN =/\{\{([^{}]*)\}\}/g;
const PERCENT_AFTER_DOWN_PAYMENT = /\{\{DOWN_PAYMENT_PERCENT\}\}[%٪]/g;
const KNOWN_TOKENS: ReadonlySet<string> = new Set<string>(DRAFT_TOKENS);

function isKnownToken(name: string): name is DraftToken {
  return KNOWN_TOKENS.has(name);
}

/** True when the customer's latest message contains an Arabic letter. */
function customerWritesArabic(context: DraftContext): boolean {
  for (let i = context.conversation.length - 1; i >= 0; i -= 1) {
    const message = context.conversation[i];
    if (message?.direction === "customer") return /(?=\p{L})\p{Script=Arabic}/u.test(message.text);
  }
  return false;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The output check, applied to the model's text before any token is filled.
 * Digits of any script and any number-like character are refused, so every
 * figure in a draft comes from a token. Percent signs are accepted only right
 * after the down payment token. The fixed wording list (discount, negotiation,
 * promise, amounts in words) is refused the same way. Known limit: wording the
 * list does not name passes; the staff member reads every draft before sending.
 */
function modelTextIsAcceptable(text: string, values: DraftTokenValues): boolean {
  if (!text.trim()) return false;
  if (containsForbiddenWording(text)) return false;

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const name = match[1] ?? "";
    if (!isKnownToken(name) || values[name] === undefined) return false;
  }

  const remainder = text.replace(PERCENT_AFTER_DOWN_PAYMENT, " ").replace(TOKEN_PATTERN, " ");
  if (/[\p{N}%٪{}@]/u.test(remainder)) return false;
  if (/:\/\/|www\./i.test(remainder)) return false;
  return true;
}

function fillTokens(text: string, values: DraftTokenValues): string {
  return text.replace(TOKEN_PATTERN, (_whole, name: string) =>
    isKnownToken(name) ? (values[name] ?? "") : "",
  );
}

/** Turns the model's answer into what is stored: a filled draft, the handover sentence, or no text. */
export function decideDraft(output: DraftModelOutput, context: DraftContext): DraftDecision {
  if (output.outcome === "needs_person") return { status: "needs_person" };

  const handover = customerWritesArabic(context) ? HANDOVER_SENTENCE_AR : HANDOVER_SENTENCE_EN;
  const values = draftTokenValues(context);
  if (!modelTextIsAcceptable(output.text, values)) {
    return { status: "ready", text: handover, handoverFallback: true };
  }

  const filled = fillTokens(output.text, values).trim();
  if (!filled || utf8Bytes(filled) > MAX_DRAFT_BYTES) {
    return { status: "ready", text: handover, handoverFallback: true };
  }
  return { status: "ready", text: filled, handoverFallback: false };
}
