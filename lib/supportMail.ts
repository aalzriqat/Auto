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

function isNameChar(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57);
}

/** A closing-tag name ends at whitespace, "/" or ">" (so `</styleX>` is a different tag). */
function isNameBoundary(code: number): boolean {
  return code === 62 || code === 47 || code === 32 || (code >= 9 && code <= 13);
}

/**
 * Index just past the closing `</name>` of a skipped block (case-insensitive),
 * or `html.length` when it is never closed. Walks `</` occurrences with
 * indexOf, so each byte of input is inspected a bounded number of times. The
 * name must end at a boundary: `</styleX>` does not close a `<style>`.
 */
function endOfBlock(html: string, name: string, from: number): number {
  let at = html.indexOf("</", from);
  while (at !== -1) {
    const nameEnd = at + 2 + name.length;
    if (html.slice(at + 2, nameEnd).toLowerCase() === name && (nameEnd >= html.length || isNameBoundary(html.charCodeAt(nameEnd)))) {
      const gt = html.indexOf(">", nameEnd);
      return gt === -1 ? html.length : gt + 1;
    }
    at = html.indexOf("</", at + 2);
  }
  return html.length;
}

/**
 * Index of the `>` that really ends a tag whose name ended at `from`: quoted
 * attribute values (`content="<body"`) may contain `>` and `<`. Each quote is
 * jumped with indexOf, so the pass is linear; an unclosed quote runs to the end
 * of the input (returns -1).
 */
function endOfTag(html: string, from: number): number {
  let i = from;
  while (i < html.length) {
    const code = html.charCodeAt(i);
    if (code === 62) return i;
    if (code === 34 || code === 39) {
      const close = html.indexOf(code === 34 ? '"' : "'", i + 1);
      if (close === -1) return -1;
      i = close + 1;
    } else {
      i += 1;
    }
  }
  return -1;
}

const RAW_HEAD_BLOCKS: ReadonlySet<string> = new Set(["style", "script", "title", "noscript"]);

/**
 * Where scanning resumes after `<head>`. `</head>` is optional in HTML, so the
 * head also ends at the first real `<body` tag (which is NOT consumed: it is
 * then processed as an ordinary tag). Inside the head, tags are skipped
 * quote-aware (an attribute value can hold `<body`), and comments, `<style>`,
 * `<script>`, `<title>` and `<noscript>` are jumped to their closing tag so
 * text such as `<title>the <body> tag</title>` cannot end it early. An unclosed
 * head with no `<body` runs to the end of the input. One forward pass, linear.
 */
function endOfHead(html: string, from: number): number {
  let at = html.indexOf("<", from);
  while (at !== -1) {
    const next = html.charCodeAt(at + 1);
    if (next === 33 && html.startsWith("<!--", at)) {
      const end = html.indexOf("-->", at + 4);
      if (end === -1) return html.length;
      at = html.indexOf("<", end + 3);
      continue;
    }
    const closing = next === 47;
    const nameStart = at + (closing ? 2 : 1);
    if (isAsciiLetter(html.charCodeAt(nameStart))) {
      let nameEnd = nameStart + 1;
      while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) nameEnd += 1;
      const tag = html.slice(nameStart, nameEnd).toLowerCase();
      const gt = endOfTag(html, nameEnd);
      if (closing) {
        if (tag === "head") return gt === -1 ? html.length : gt + 1;
      } else {
        if (tag === "body") return at;
        if (gt === -1) return html.length; // unclosed tag/quote swallows the rest
        if (RAW_HEAD_BLOCKS.has(tag)) {
          at = html.indexOf("<", endOfBlock(html, tag, gt + 1));
          continue;
        }
        at = html.indexOf("<", gt + 1);
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
function stripTags(html: string): string {
  const out: string[] = [];
  const length = html.length;
  let cursor = 0;
  while (cursor < length) {
    const lt = html.indexOf("<", cursor);
    if (lt === -1) {
      out.push(html.slice(cursor));
      break;
    }
    if (lt > cursor) out.push(html.slice(cursor, lt));
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
      out.push("<"); // a stray "<" is text
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
 */
export function htmlToPlainText(html: string): string {
  return collapseBlankLines(
    stripTags(html)
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
  // The whole body is converted in the one linear pass: no input slice and no
  // early stop, because any budget counted before entity decoding can be spent
  // on invisible spacers (`&nbsp;`, `&#32;`) and leave the preview empty or cut
  // inside an entity. The input is bounded by Convex's 1 MiB document limit.
  const source =
    bodyText && bodyText.trim()
      ? bodyText
      : bodyHtml
        ? htmlToPlainText(bodyHtml)
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
