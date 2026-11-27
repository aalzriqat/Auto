/**
 * The only customer data the draft writer may see: the conversation text.
 *
 * `buildConversation` keeps direction and text and nothing else. No dealership
 * fact is part of it: the answers the system can give are built from the
 * pre-rendered sentence table (`draftSentences.ts`), not from fields handed to
 * the provider.
 */

import { v, type Infer } from "convex/values";

export const MAX_CONTEXT_MESSAGES = 12;
export const MAX_MESSAGE_CHARACTERS = 1500;

export const draftMessageValidator = v.object({
  direction: v.union(v.literal("customer"), v.literal("dealership")),
  text: v.string(),
});
export type DraftMessage = Infer<typeof draftMessageValidator>;

/** Event fields that carry message text, and nothing else. */
export interface DraftEventTextInput {
  text?: string;
  autoReplyText?: string;
  manualReplyText?: string;
}

/**
 * One social DM event becomes up to three messages: what the customer wrote,
 * then the automatic reply, then the staff reply. Events are chronological.
 */
export function flattenSocialEvents(events: readonly DraftEventTextInput[]): DraftMessage[] {
  const messages: DraftMessage[] = [];
  for (const event of events) {
    if (event.text) messages.push({ direction: "customer", text: event.text });
    if (event.autoReplyText) messages.push({ direction: "dealership", text: event.autoReplyText });
    if (event.manualReplyText) messages.push({ direction: "dealership", text: event.manualReplyText });
  }
  return messages;
}

function cutToCharacters(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/**
 * The newest messages, each cut to the character cap, empty ones dropped.
 * Every message is copied into a new object holding direction and text only,
 * so a whole document handed over by mistake cannot leak its other fields.
 */
export function buildConversation(messages: readonly DraftMessage[]): DraftMessage[] {
  const conversation: DraftMessage[] = [];
  for (const message of messages) {
    const text = cutToCharacters(message.text ?? "", MAX_MESSAGE_CHARACTERS);
    if (!text.trim()) continue;
    conversation.push({ direction: message.direction, text });
  }
  return conversation.slice(-MAX_CONTEXT_MESSAGES);
}
