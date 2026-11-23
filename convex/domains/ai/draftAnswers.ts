/**
 * What the model may say, and how the draft is built from it.
 *
 * The model never writes a word of a draft. It names which approved answers
 * fit the customer's latest message; this module turns that choice into text
 * using only sentences the repository already owns: the built-in Smart Reply
 * sentences (pre-rendered into a `SentenceTable`) and the two fixed handover
 * sentences. There is no text field in the model's output, so no wording,
 * figure, promise or link can pass through it.
 */
import type { DraftMessage } from "./draftContext";
import type { SentenceTable } from "./draftValidators";

/** Answers backed by a Smart Reply sentence, in the order they appear in a draft. */
export const SENTENCE_ANSWERS = ["greeting", "availability", "vehicleInfo", "price", "financing", "location"] as const;
/** Every answer the model may choose, in draft order: the handover sentence closes a draft. */
export const DRAFT_ANSWERS = [...SENTENCE_ANSWERS, "handover"] as const;

export type SentenceAnswer = (typeof SENTENCE_ANSWERS)[number];
export type DraftAnswer = (typeof DRAFT_ANSWERS)[number];
export type DraftLocale = "en" | "ar";

export const HANDOVER_SENTENCE_EN =
  "Thank you for your message. One of our sales team will get back to you shortly with the details.";
export const HANDOVER_SENTENCE_AR =
  "شكرًا لتواصلك معنا. سيتواصل معك أحد موظفي المبيعات قريبًا لتزويدك بالتفاصيل.";

export const MAX_DRAFT_BYTES = 1000;

/** What the model answered, after the strict parse. Names only, never text. */
export interface DraftModelOutput {
  outcome: "draft" | "needs_person";
  answers: DraftAnswer[];
}

export type DraftDecision =
  | { status: "ready"; text: string; handoverFallback: boolean }
  | { status: "needs_person" };

function isDraftAnswer(value: unknown): value is DraftAnswer {
  return typeof value === "string" && DRAFT_ANSWERS.some((answer) => answer === value);
}

/**
 * The only way the provider's text becomes an output. Accepts exactly
 * `{ outcome, answers }`: any other key (a `text` field included), an unknown
 * answer, a non-array, or `draft` with no answers is refused with null.
 * Duplicates are removed; `needs_person` carries no answers.
 */
export function parseModelOutput(text: string): DraftModelOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "answers" || keys[1] !== "outcome") return null;

  const outcome: unknown = Reflect.get(parsed, "outcome");
  const answers: unknown = Reflect.get(parsed, "answers");
  if (!Array.isArray(answers)) return null;
  const chosen = new Set<DraftAnswer>();
  for (const answer of answers) {
    if (!isDraftAnswer(answer)) return null;
    chosen.add(answer);
  }
  if (outcome === "needs_person") return { outcome, answers: [] };
  if (outcome !== "draft" || chosen.size === 0) return null;
  return { outcome, answers: DRAFT_ANSWERS.filter((answer) => chosen.has(answer)) };
}

/** Arabic when the customer's latest message contains an Arabic letter, English otherwise. Code decides, never the model. */
export function chooseLocale(conversation: readonly DraftMessage[]): DraftLocale {
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const message = conversation[i];
    if (message?.direction === "customer") return /(?=\p{L})\p{Script=Arabic}/u.test(message.text) ? "ar" : "en";
  }
  return "en";
}

/** The answers the model may choose now: those with a sentence, and always the handover. */
export function availableAnswers(sentences: SentenceTable, locale: DraftLocale): DraftAnswer[] {
  return DRAFT_ANSWERS.filter((answer) => answer === "handover" || sentences[locale][answer] !== null);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Builds what is stored from the model's choice. Pure.
 * - Sentences come from the table in the fixed order; the handover sentence closes the draft.
 * - A chosen answer with no sentence contributes nothing and adds the handover.
 * - Over the byte cap, trailing answer sentences are dropped, never cut; the
 *   handover sentence is kept, and alone it always fits.
 * - `handoverFallback` is true when the draft is the handover sentence only.
 */
export function decideDraft(
  output: DraftModelOutput,
  sentences: SentenceTable,
  conversation: readonly DraftMessage[]
): DraftDecision {
  if (output.outcome === "needs_person") return { status: "needs_person" };

  const locale = chooseLocale(conversation);
  const table = sentences[locale];
  const handover = locale === "ar" ? HANDOVER_SENTENCE_AR : HANDOVER_SENTENCE_EN;

  let wantsHandover = output.answers.includes("handover");
  const rendered: string[] = [];
  for (const answer of SENTENCE_ANSWERS) {
    if (!output.answers.includes(answer)) continue;
    const sentence = table[answer];
    if (sentence === null) wantsHandover = true;
    else rendered.push(sentence);
  }

  const closing = wantsHandover ? [handover] : [];
  while (rendered.length > 0 && utf8Bytes([...rendered, ...closing].join("\n")) > MAX_DRAFT_BYTES) rendered.pop();
  const lines = rendered.length === 0 && closing.length === 0 && output.answers.length > 0 ? [handover] : [...rendered, ...closing];
  if (lines.length === 0) return { status: "needs_person" };
  return { status: "ready", text: lines.join("\n"), handoverFallback: lines.length === 1 && lines[0] === handover };
}
