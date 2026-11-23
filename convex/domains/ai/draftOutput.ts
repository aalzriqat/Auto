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

const TOKEN_PATTERN = /\{\{([^{}]*)\}\}/g;
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
 * after the down payment token. Known limit: numbers written as words pass.
 */
function modelTextIsAcceptable(text: string, values: DraftTokenValues): boolean {
  if (!text.trim()) return false;

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
