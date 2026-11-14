/**
 * Text extraction from Meta (Instagram / Facebook / WhatsApp) webhook payloads.
 *
 * Lives outside `http.ts` so it can be unit tested. It parses untrusted,
 * deeply-nested third-party JSON, and a mistake here writes straight into a
 * lead's message trail and its opening note.
 */

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/**
 * Contact evidence must come from the sender's current, free-text message.
 * Quick replies put the business-authored button title in message.text too.
 * Their payloads (including platform contact sharing), postbacks, attachments,
 * reply context and referrals are not proof of text the sender typed.
 */
export function senderMessageText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("message" in value)) return undefined;
  const message = value.message;
  if (!message || typeof message !== "object" || !("text" in message)) return undefined;
  if ("quick_reply" in message || "postback" in message || "postback" in value) return undefined;
  return optionalString(message.text);
}

export const META_TEXT_KEYS = [
  "text",
  "title",
  "description",
  "name",
  "caption",
  "url",
  "payload",
  "ref",
  "source",
  "type",
  "phone",
  "phone_number",
  "mobile",
  "number",
  "value",
  "label",
] as const;

export const META_NESTED_TEXT_KEYS = [
  "attachments",
  "data",
  "quick_reply",
  "reply_to",
  "referral",
  "postback",
] as const;

/**
 * Keys carrying a machine-generated URL rather than anything a person typed.
 * Harmless at the top level — an m.me referral link is genuine context — but
 * not inside an attachment, where `url` is Meta's signed CDN link to the media.
 */
const ATTACHMENT_URL_KEYS = new Set<string>(["url", "payload"]);

/**
 * Harvests the directly-addressable text fields on one record.
 *
 * A media DM carries no text of its own, so without the `inAttachment` skip the
 * signed CDN URL from `attachments[].payload.url` became the message body: a
 * 200-character blob rendered verbatim in the customer message trail and copied
 * into the lead's opening note. Those URLs also carry an access `signature`, so
 * it persisted a credential into the database and onto the screen. A link the
 * customer actually typed arrives in `text` and is unaffected.
 */
function collectOwnTextFields(
  record: Record<string, unknown>,
  parts: string[],
  inAttachment: boolean
): void {
  for (const key of META_TEXT_KEYS) {
    if (inAttachment && ATTACHMENT_URL_KEYS.has(key)) continue;
    const text = optionalString(record[key]);
    if (text) parts.push(text);
  }
}

/** Descends into the nested containers Meta nests real text inside. */
function collectNestedText(
  record: Record<string, unknown>,
  parts: string[],
  inAttachment: boolean
): void {
  for (const key of META_NESTED_TEXT_KEYS) {
    const nested = record[key];
    if (!nested || typeof nested !== "object") continue;
    // Everything below an `attachments` node stays marked, however deep.
    collectTextParts(nested, parts, inAttachment || key === "attachments");
  }

  const payload = record.payload;
  if (payload && typeof payload === "object") {
    collectTextParts(payload, parts, inAttachment);
  }
}

export function collectTextParts(
  value: unknown,
  parts: string[] = [],
  /** True once we have descended into an `attachments` subtree. */
  inAttachment = false
): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTextParts(item, parts, inAttachment);
    return parts;
  }
  if (!value || typeof value !== "object") return parts;

  const record = value as Record<string, unknown>;
  collectOwnTextFields(record, parts, inAttachment);
  collectNestedText(record, parts, inAttachment);
  return parts;
}
