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
/** Visible characters of converted HTML a preview is built from (it keeps 160). */
const PREVIEW_SOURCE_CHARS = 2000;

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
 * `do-not-reply`, `donotreply`, `mailer-daemon` as a whole token, so
 * `noreply+cffa368`, `no-reply-uamktl…` and `info-noreply` match while
 * `reply-ztecov…@mail.anthropic.com` (a real, repliable address) and
 * `noreplying` do not.
 *
 * This predicate drives a HARD server-side refusal and a hidden composer, so it
 * is deliberately narrow: `notifications` and `postmaster` are NOT here. Those
 * are only "likely automated" (see AUTOMATED_LOCAL_PARTS) and can still be
 * replied to.
 */
const NO_REPLY_TOKEN =
  /(^|[^a-z])(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon)([^a-z]|$)/;

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
  "postmaster",
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

const SKIPPED_BLOCKS: ReadonlySet<string> = new Set(["script", "style", "head"]);
const NEWLINE_CLOSERS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "tr",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "blockquote",
]);

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Index just past the closing `</name>` of a skipped block (case-insensitive),
 * or `html.length` when it is never closed. Walks `</` occurrences with
 * indexOf, so each byte of input is inspected a bounded number of times.
 */
function endOfBlock(html: string, name: string, from: number): number {
  let at = html.indexOf("</", from);
  while (at !== -1) {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() === name) {
      const gt = html.indexOf(">", at + 2 + name.length);
      return gt === -1 ? html.length : gt + 1;
    }
    at = html.indexOf("</", at + 2);
  }
  return html.length;
}

function isNameChar(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57);
}

/**
 * Where scanning resumes after `<head>`. `</head>` is optional in HTML, so the
 * head also ends at the first `<body` tag (which is NOT consumed: it is then
 * processed as an ordinary tag). Nested comments, `<style>` and `<script>` are
 * jumped over so a `<body` inside a CSS/JS string cannot end the head early.
 * An unclosed head with no `<body` runs to the end of the input. One forward
 * pass over the `<` characters, so it stays linear.
 */
function endOfHead(html: string, from: number): number {
  let at = html.indexOf("<", from);
  while (at !== -1) {
    const next = html.charCodeAt(at + 1);
    if (next === 47) {
      // "</head" + a non-name character
      if (html.slice(at + 2, at + 6).toLowerCase() === "head" && !isNameChar(html.charCodeAt(at + 6))) {
        const gt = html.indexOf(">", at + 6);
        return gt === -1 ? html.length : gt + 1;
      }
    } else if (next === 33 && html.startsWith("<!--", at)) {
      const end = html.indexOf("-->", at + 4);
      if (end === -1) return html.length;
      at = html.indexOf("<", end + 3);
      continue;
    } else if (isAsciiLetter(next)) {
      let nameEnd = at + 1;
      while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) nameEnd += 1;
      const tag = html.slice(at + 1, nameEnd).toLowerCase();
      if (tag === "body") return at;
      if (tag === "style" || tag === "script") {
        const gt = html.indexOf(">", nameEnd);
        if (gt === -1) return html.length;
        at = html.indexOf("<", endOfBlock(html, tag, gt + 1));
        continue;
      }
    }
    at = html.indexOf("<", at + 1);
  }
  return html.length;
}

/**
 * The tag scanner behind `htmlToPlainText`: ONE left-to-right pass that only
 * ever moves forward. A previous regex pipeline backtracked over the whole
 * input for every unterminated `<!--`, `<head>`, `<style>` or `<a ` and took
 * 5–28 s on 480 KB (SCRUM-825 review F1) — on the inbound-mutation path, where a
 * mutation has about a second. Here every unterminated construct simply runs to
 * the end of the input, and a missing `>` is discovered once, not once per `<`.
 */
function stripTags(html: string, maxOutputChars?: number): string {
  const out: string[] = [];
  const length = html.length;
  let cursor = 0;
  // Visible (non-whitespace) characters still allowed; Infinity = unbounded.
  let budget = maxOutputChars ?? Infinity;
  /** Push text, honouring the budget. Returns true when the budget is spent. */
  const pushText = (chunk: string): boolean => {
    if (budget === Infinity) {
      out.push(chunk);
      return false;
    }
    let taken = 0;
    while (taken < chunk.length && budget > 0) {
      if (chunk.charCodeAt(taken) > 32) budget -= 1;
      taken += 1;
    }
    out.push(taken === chunk.length ? chunk : chunk.slice(0, taken));
    return budget <= 0;
  };
  while (cursor < length) {
    const lt = html.indexOf("<", cursor);
    if (lt === -1) {
      pushText(html.slice(cursor));
      break;
    }
    if (lt > cursor && pushText(html.slice(cursor, lt))) break;

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      out.push(" ");
      if (end === -1) break; // unclosed comment swallows the rest
      cursor = end + 3;
      continue;
    }

    const closing = html.charCodeAt(lt + 1) === 47; // "/"
    const nameStart = lt + (closing ? 2 : 1);
    const first = html.charCodeAt(nameStart);
    const isDeclaration = first === 33 || first === 63; // "<!doctype", "<?xml"
    if (!isAsciiLetter(first) && !isDeclaration) {
      if (pushText("<")) break; // a stray "<" is text
      cursor = lt + 1;
      continue;
    }

    let nameEnd = nameStart;
    if (!isDeclaration) {
      while (nameEnd < length) {
        const code = html.charCodeAt(nameEnd);
        if (!isAsciiLetter(code) && !(code >= 48 && code <= 57)) break;
        nameEnd += 1;
      }
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();

    const gt = html.indexOf(">", nameEnd);
    if (gt === -1) {
      // No ">" anywhere after this point: the rest is one unterminated tag.
      // Stopping here (not skipping just this "<") is what keeps it linear.
      out.push(" ");
      break;
    }

    if (!closing && SKIPPED_BLOCKS.has(name)) {
      out.push(" ");
      cursor = name === "head" ? endOfHead(html, gt + 1) : endOfBlock(html, name, gt + 1);
      continue;
    }
    out.push(!isDeclaration && (name === "br" || (closing && NEWLINE_CLOSERS.has(name))) ? "\n" : " ");
    cursor = gt + 1;
  }
  return out.join("");
}

/**
 * Tag-stripped text of an HTML email body. Block-level ends become newlines so
 * the plain-text view of an HTML-only message stays readable. A hand-written
 * linear scanner on purpose (it runs in the Convex runtime, which has no DOM,
 * on attacker-controlled input); the output is only ever rendered as TEXT,
 * never as markup.
 *
 * `maxOutputChars` stops the scan once that many non-whitespace characters of
 * visible text have been produced (the preview needs ~160, so it passes ~2000);
 * omit it to convert the whole body.
 */
export function htmlToPlainText(html: string, options?: { maxOutputChars?: number }): string {
  return collapseBlankLines(
    stripTags(html, options?.maxOutputChars)
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
  // The scanner is linear and stops once ~2000 visible characters have been
  // produced; the whole body is NOT sliced first (a large <head> would otherwise
  // use up the slice and leave an empty preview). The stored body is untouched.
  const source =
    bodyText && bodyText.trim()
      ? bodyText
      : bodyHtml
        ? htmlToPlainText(bodyHtml, { maxOutputChars: PREVIEW_SOURCE_CHARS })
        : "";
  const cleaned = source.replace(ANGLE_LINK, " ").replace(/\s+/g, " ").trim();
  const points = Array.from(cleaned);
  return points.length <= PREVIEW_MAX_LENGTH ? cleaned : points.slice(0, PREVIEW_MAX_LENGTH).join("").trimEnd();
}

export type BodyTextSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string; host: string };

/**
 * Collapse runs of 3+ newlines (with optional blank-line whitespace) to one blank line.
 *
 * Output is identical to `text.replace(/(?:[ \t]*\r?\n){3,}/g, "\n\n")`, which
 * was super-linear on long space/tab runs (80K of them took 3.3 s, and this runs
 * in the admin's browser on raw message text). One pass over the "\n"
 * positions instead: a "unit" is `[ \t]*\r?\n`; consecutive units form a run, and
 * a run of 3 or more becomes "\n\n" — including the whitespace that led its
 * first line, exactly as the regex consumed it.
 */
export function collapseBlankLines(text: string): string {
  const out: string[] = [];
  let copyFrom = 0;
  let runStart = -1;
  let runUnits = 0;
  let lastNewline = -1;
  const closeRun = () => {
    if (runUnits >= 3) {
      out.push(text.slice(copyFrom, runStart), "\n\n");
      copyFrom = lastNewline + 1;
    }
    runUnits = 0;
  };
  let newline = text.indexOf("\n");
  while (newline !== -1) {
    // Start of the maximal `[ \t]*\r?` that ends right before this newline,
    // never reaching back past the previous newline.
    const segmentStart = lastNewline + 1;
    let unitStart = newline;
    if (unitStart > segmentStart && text.charCodeAt(unitStart - 1) === 13) unitStart -= 1;
    while (unitStart > segmentStart) {
      const code = text.charCodeAt(unitStart - 1);
      if (code !== 32 && code !== 9) break;
      unitStart -= 1;
    }
    if (runUnits > 0 && unitStart === segmentStart) {
      runUnits += 1; // the whole segment is blank: the run continues
    } else {
      closeRun();
      runStart = unitStart;
      runUnits = 1;
    }
    lastNewline = newline;
    newline = text.indexOf("\n", newline + 1);
  }
  closeRun();
  out.push(text.slice(copyFrom));
  return out.join("");
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
