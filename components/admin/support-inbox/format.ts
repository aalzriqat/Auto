import { differenceInCalendarDays, isSameDay } from "date-fns";
import { formatLocalized } from "@/lib/dateLocale";
import { isConvexError } from "@/lib/errors";

export type InboxKey = "support" | "info" | "subscriptions";

export const INBOX_KEYS: readonly InboxKey[] = ["support", "info", "subscriptions"];

/** Mirrors FROM_EMAIL in convex/support.ts (the backend decides the real sender). */
export const INBOX_ADDRESS: Record<InboxKey, string> = {
  support: "support@autoflowdealer.com",
  info: "info@autoflowdealer.com",
  subscriptions: "subscriptions@autoflowdealer.com",
};

const AVATAR_COLORS = [
  "bg-indigo-600",
  "bg-cyan-700",
  "bg-amber-700",
  "bg-rose-700",
  "bg-green-700",
  "bg-violet-600",
  "bg-sky-700",
] as const;

/** Deterministic: the same address always gets the same colour. */
export function avatarColorClass(seed: string): string {
  let sum = 0;
  for (const char of seed) sum += char.codePointAt(0) ?? 0;
  return AVATAR_COLORS[sum % AVATAR_COLORS.length]!;
}

export function senderInitial(name: string | null | undefined): string {
  const first = Array.from((name ?? "").trim())[0];
  return first ? first.toUpperCase() : "?";
}

/**
 * List timestamp: today -> time, within the last 6 days -> weekday, otherwise
 * "d MMM". date-fns formats numerals as Latin digits in Arabic too, which is the
 * product convention.
 */
export function formatListTime(timestamp: number, now: number, locale: string | undefined): string {
  if (isSameDay(timestamp, now)) return formatLocalized(timestamp, "p", locale);
  if (differenceInCalendarDays(now, timestamp) < 6 && timestamp <= now) {
    return formatLocalized(timestamp, "EEE", locale);
  }
  return formatLocalized(timestamp, "d MMM", locale);
}

export function formatFullDate(timestamp: number, locale: string | undefined): string {
  return formatLocalized(timestamp, "EEE, d MMM yyyy, p", locale);
}

/** Reply subject; mirrors the backend rule in `sendReply`. */
export function replySubject(subject: string): string {
  return subject.startsWith("Re:") ? subject : `Re: ${subject}`;
}

/**
 * An automated acknowledgement is an OUTBOUND message nobody typed. The backend
 * marks human replies with `sentByUserId`; the text check keeps a legacy human
 * reply (written before that field existed) from being folded away as automated.
 */
export function isAutomatedAck(message: {
  direction: "INBOUND" | "OUTBOUND";
  sentByUserId?: unknown;
  bodyText?: string;
}): boolean {
  return (
    message.direction === "OUTBOUND" &&
    !message.sentByUserId &&
    (message.bodyText ?? "").startsWith("(Automated acknowledg")
  );
}

/** True when a keyboard event started in a place where letters are typed. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Toast text for a failed call: the server's own message when it threw a
 * `ConvexError("…")` (those are written to be shown), otherwise the localized
 * fallback. Never the raw error object, which is what `toast.error(e)` showed.
 */
export function errorToastMessage(error: unknown, fallback: string): string {
  if (isConvexError(error) && typeof error.data === "string" && error.data.trim()) return error.data;
  return fallback;
}

export function includesQuery(haystacks: Array<string | null | undefined>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystacks.some((value) => (value ?? "").toLowerCase().includes(needle));
}
