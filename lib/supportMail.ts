/**
 * Pure helpers for the super-admin Support Inbox (SCRUM-825).
 *
 * Shared by the Convex backend (`convex/support.ts` imports `../lib/supportMail`,
 * the same precedent as `../lib/notifications/render`) and by the inbox UI, so
 * the "is this a no-reply sender" decision is made by ONE function on both
 * sides: the composer is hidden client-side and `sendReply` refuses server-side
 * with the same predicate. No imports — must stay safe in the Convex runtime.
 */

const PREVIEW_MAX_LENGTH = 160;

/** `<https://…>` link dumps that plain-text mail bodies are full of. */
const ANGLE_LINK = /<\s*(https?:\/\/[^\s<>]+)\s*>/gi;

function localPartOf(email: string): string {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  return at < 0 ? trimmed : trimmed.slice(0, at);
}

function domainOf(email: string): string {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  return at < 0 ? "" : trimmed.slice(at + 1);
}

/**
 * Token match on the LOCAL part only: `noreply`, `no-reply`, `no_reply`,
 * `do-not-reply`, `donotreply`, `mailer-daemon`, `postmaster`, `notification(s)`
 * as a whole token, so `noreply+cffa368`, `no-reply-uamktl…` and `info-noreply`
 * match while `reply-ztecov…@mail.anthropic.com` (a real, repliable address)
 * and `noreplying` do not.
 */
const NO_REPLY_TOKEN =
  /(^|[^a-z])(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|notifications?)([^a-z]|$)/;

export function isNoReplyAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  return NO_REPLY_TOKEN.test(localPartOf(email));
}

/**
 * Local parts that are conservative signals of bulk / system mail. Deliberately
 * excludes words a real customer mailbox could be named (`billing`, `accounts`,
 * `sales`, `support`, `info`, `hello`, `admin`, `contact`). A wrong guess is
 * recoverable (the admin can override per thread) but a customer filed under
 * "Automated" is easy to miss, so the list errs toward "people".
 */
const AUTOMATED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "notify",
  "notifications",
  "notification",
  "news",
  "newsletter",
  "newsletters",
  "events",
  "learn",
  "marketing",
  "updates",
  "update",
  "digest",
  "alerts",
  "announce",
  "announcements",
  "mailer",
  "bounce",
  "bounces",
]);

/**
 * First domain label of a bulk-sending subdomain, e.g. `send.zapier.com`,
 * `mail.notion.com`, `email.claude.com`, `em.example.com`. Only counts when the
 * address has at least three labels, so a plain `mail.com` / `em.com` mailbox is
 * never classified by its name alone.
 */
const BULK_SUBDOMAIN_LABELS: ReadonlySet<string> = new Set([
  "send",
  "mail",
  "email",
  "em",
  "bounce",
  "mailer",
]);

export function isLikelyAutomated(email: string | null | undefined): boolean {
  if (!email) return false;
  if (isNoReplyAddress(email)) return true;
  if (AUTOMATED_LOCAL_PARTS.has(localPartOf(email))) return true;
  const labels = domainOf(email).split(".").filter(Boolean);
  return labels.length >= 3 && BULK_SUBDOMAIN_LABELS.has(labels[0]!);
}

export type SupportThreadCategory = "people" | "automated";

/**
 * The category shown in the list. An admin override always wins over the
 * heuristic. Phase 2 moves this server-side (header-based classification).
 */
export function resolveThreadCategory(thread: {
  participantEmail: string;
  categoryOverride?: SupportThreadCategory | null;
}): SupportThreadCategory {
  if (thread.categoryOverride === "people" || thread.categoryOverride === "automated") {
    return thread.categoryOverride;
  }
  return isLikelyAutomated(thread.participantEmail) ? "automated" : "people";
}

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Tag-stripped text of an HTML email body. Block-level ends become newlines so
 * the plain-text view of an HTML-only message stays readable. Regex-based on
 * purpose (it runs in the Convex runtime, which has no DOM); the output is only
 * ever rendered as TEXT, never as markup.
 */
export function htmlToPlainText(html: string): string {
  return collapseBlankLines(
    html
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
      .replace(/&#(\d{1,6});/g, (m, code: string) => {
        const point = Number(code);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : m;
      })
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
  ).trim();
}

/**
 * One-line list preview: bodyText when it has content, else the tag-stripped
 * bodyHtml; `<https://…>` dumps removed; whitespace collapsed; at most 160
 * characters (counted in code points so an emoji or surrogate pair is never cut
 * in half).
 */
export function buildPreview(bodyText?: string | null, bodyHtml?: string | null): string {
  const source = bodyText && bodyText.trim() ? bodyText : bodyHtml ? htmlToPlainText(bodyHtml) : "";
  const cleaned = source.replace(ANGLE_LINK, " ").replace(/\s+/g, " ").trim();
  const points = Array.from(cleaned);
  return points.length <= PREVIEW_MAX_LENGTH ? cleaned : points.slice(0, PREVIEW_MAX_LENGTH).join("").trimEnd();
}

export type BodyTextSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string; host: string };

/** Collapse runs of 3+ newlines (with optional blank-line whitespace) to one blank line. */
export function collapseBlankLines(text: string): string {
  return text.replace(/(?:[ \t]*\r?\n){3,}/g, "\n\n");
}

/**
 * Split a plain-text body into text and link segments. `<https://…>` dumps
 * become compact link segments (host shown, full URL kept for the title/href);
 * only http(s) URLs qualify, so a `<javascript:…>` string stays inert text.
 */
export function splitBodyText(text: string): BodyTextSegment[] {
  const segments: BodyTextSegment[] = [];
  const source = collapseBlankLines(text ?? "");
  let cursor = 0;
  for (const match of source.matchAll(ANGLE_LINK)) {
    const url = match[1]!;
    const start = match.index ?? 0;
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      continue; // unparseable: leave it in the surrounding text
    }
    if (start > cursor) segments.push({ kind: "text", text: source.slice(cursor, start) });
    segments.push({ kind: "link", url, host });
    cursor = start + match[0].length;
  }
  if (cursor < source.length) segments.push({ kind: "text", text: source.slice(cursor) });
  return segments;
}
