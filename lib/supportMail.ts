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

/**
 * Named character references, decoded ONCE in `htmlToPlainText`. Case-sensitive
 * (`&Eacute;` and `&eacute;` differ). Latin-1 (U+00A0..U+00FF, in code-point
 * order, 96 names) plus the typographic/symbol entities mail clients actually
 * emit. Anything else stays literal text. The `entities` package is not a direct
 * dependency, so this stays a small table with no imports.
 */
const LATIN1_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr " +
  "deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml " +
  "ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml " +
  "eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map<string, string>([
  ...LATIN1_NAMES.split(" ").map((name, index): [string, string] => [name, String.fromCharCode(0xa0 + index)]),
  // `&nbsp;` is a plain space here (not U+00A0) so it collapses with the
  // surrounding whitespace; literal U+00A0 / `&#160;` are left alone and
  // collapse in `buildPreview` (JS `\s` includes them).
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["ensp", " "],
  ["emsp", " "],
  ["thinsp", " "],
  ["zwnj", "‌"],
  ["zwj", "‍"],
  ["lrm", "‎"],
  ["rlm", "‏"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["sbquo", "‚"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bdquo", "„"],
  ["dagger", "†"],
  ["Dagger", "‡"],
  ["bull", "•"],
  ["hellip", "…"],
  ["permil", "‰"],
  ["prime", "′"],
  ["Prime", "″"],
  ["lsaquo", "‹"],
  ["rsaquo", "›"],
  ["euro", "€"],
  ["trade", "™"],
  ["larr", "←"],
  ["uarr", "↑"],
  ["rarr", "→"],
  ["darr", "↓"],
  ["harr", "↔"],
  ["minus", "−"],
  ["asymp", "≈"],
  ["ne", "≠"],
  ["le", "≤"],
  ["ge", "≥"],
  ["infin", "∞"],
  // Upper-case spellings HTML also defines.
  ["AMP", "&"],
  ["LT", "<"],
  ["GT", ">"],
  ["QUOT", '"'],
  ["COPY", "©"],
  ["REG", "®"],
]);

/** `&name;`, `&#123;` or `&#x1F600;` — one regex, one pass, so a result is never decoded twice. */
const CHARACTER_REFERENCE = /&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,10})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/**
 * The HTML spec's replacement table for numeric references 0x80..0x9F (index =
 * code - 0x80): they are Windows-1252, not C1 controls, so `&#146;` is a right
 * single quote. 0 = no mapping (0x81 0x8D 0x8F 0x90 0x9D): the code point stays.
 */
const WINDOWS_1252_C1: readonly number[] = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

/**
 * Numeric references to NUL, surrogates or beyond U+10FFFF become U+FFFD, and
 * 0x80..0x9F go through the Windows-1252 table, as in browsers.
 */
function codePointOf(value: number): string {
  if (!Number.isFinite(value) || value === 0 || (value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
    return "�";
  }
  if (value >= 0x80 && value <= 0x9f) return String.fromCodePoint(WINDOWS_1252_C1[value - 0x80] || value);
  return String.fromCodePoint(value);
}

function decodeCharacterReference(match: string, hex?: string, decimal?: string, name?: string): string {
  if (hex !== undefined) return codePointOf(parseInt(hex, 16));
  if (decimal !== undefined) return codePointOf(parseInt(decimal, 10));
  return NAMED_ENTITIES.get(name ?? "") ?? match;
}

const RAW_BLOCKS: ReadonlySet<string> = new Set(["script", "style", "title", "template", "noscript"]);
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

/** HTML whitespace: tab, LF, FF, CR, space. */
function isHtmlSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

/** A closing-tag name ends at whitespace, "/" or ">" (so `</styleX>` is a different tag). */
function isNameBoundary(code: number): boolean {
  return code === 62 || code === 47 || isHtmlSpace(code);
}

/**
 * Index just past the closing `</name>` of a raw block (case-insensitive), or
 * `html.length` when it is never closed. Walks `</` occurrences with indexOf, so
 * each byte of input is inspected a bounded number of times. The name must end
 * at a boundary: `</styleX>` does not close a `<style>`.
 */
function endOfBlock(html: string, name: string, from: number): number {
  let at = html.indexOf("</", from);
  while (at !== -1) {
    const nameEnd = at + 2 + name.length;
    if (
      html.slice(at + 2, nameEnd).toLowerCase() === name &&
      (nameEnd >= html.length || isNameBoundary(html.charCodeAt(nameEnd)))
    ) {
      const gt = html.indexOf(">", nameEnd);
      return gt === -1 ? html.length : gt + 1;
    }
    at = html.indexOf("</", at + 2);
  }
  return html.length;
}

/**
 * Index of the `>` that ends a tag whose name ended at `from`, following the
 * HTML tokenizer's attribute states: a quote delimits ONLY when it opens an
 * attribute value (after `=` and optional whitespace). Anywhere else a quote is
 * an ordinary character, so `content=O'Brien` and `charset="utf-8""` do not
 * swallow the rest of the message. A quoted value that never closes (or a tag
 * with no `>`) returns -1 and the caller swallows the rest of the input.
 *
 * One forward pass; a quoted value is jumped with indexOf. The caller resumes
 * after the returned index, so no byte is ever scanned twice.
 */
function endOfTag(html: string, from: number): number {
  // 0 before attribute name, 1 in name, 2 after name, 3 before value, 4 unquoted value
  let state = 0;
  let i = from;
  const length = html.length;
  while (i < length) {
    const code = html.charCodeAt(i);
    switch (state) {
      case 0:
        if (code === 62) return i;
        if (!isHtmlSpace(code) && code !== 47) state = 1;
        break;
      case 1:
        if (code === 62) return i;
        if (code === 61) state = 3;
        else if (code === 47) state = 0;
        else if (isHtmlSpace(code)) state = 2;
        break;
      case 2:
        if (code === 62) return i;
        if (code === 61) state = 3;
        else if (code === 47) state = 0;
        else if (!isHtmlSpace(code)) state = 1;
        break;
      case 3:
        if (code === 62) return i;
        if (code === 34 || code === 39) {
          const close = html.indexOf(code === 34 ? '"' : "'", i + 1);
          if (close === -1) return -1;
          i = close;
          state = 0;
        } else if (!isHtmlSpace(code)) {
          state = 4;
        }
        break;
      default:
        if (code === 62) return i;
        if (isHtmlSpace(code)) state = 0;
        break;
    }
    i += 1;
  }
  return -1;
}

/**
 * The tag scanner behind `htmlToPlainText`: ONE left-to-right pass that only
 * ever moves forward (SCRUM-825). Every construct is consumed exactly once and
 * scanning resumes AFTER the region it examined, never behind it; an
 * unterminated comment, declaration, tag or quoted value simply swallows the
 * rest of the input. That is what keeps hostile mail (a mutation has about a
 * second) linear.
 *
 * It models a browser, not a header parser:
 *  - `<script>`, `<style>`, `<title>`, `<template>` and `<noscript>` are raw
 *    blocks, skipped ANYWHERE to their boundary-matched closing tag (none is
 *    body text; the reading pane's sanitizer removes `<noscript>` too, so the
 *    preview never shows text the message view does not);
 *  - every other tag is stripped and its text kept, so text in the head (or with
 *    no `<head>`/`<body>` at all) is just text, as the implied `<body>` makes it;
 *  - stray `<` characters are text and stay in the pending text run, so a flood
 *    of them is one slice, not one push each.
 */
function stripTags(html: string): string {
  const out: string[] = [];
  const length = html.length;
  let textFrom = 0; // start of the pending run of plain text
  let from = 0; // where to look for the next "<"
  while (from < length) {
    const lt = html.indexOf("<", from);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      out.push(html.slice(textFrom, lt), " ");
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) return out.join(""); // unclosed comment swallows the rest
      textFrom = from = end + 3;
      continue;
    }

    const second = html.charCodeAt(lt + 1);
    if (second === 33 || second === 63) {
      // "<!doctype …>", "<?xml …?>": a declaration ends at the first ">"
      out.push(html.slice(textFrom, lt), " ");
      const gt = html.indexOf(">", lt + 2);
      if (gt === -1) return out.join("");
      textFrom = from = gt + 1;
      continue;
    }

    const closing = second === 47; // "/"
    const nameStart = lt + (closing ? 2 : 1);
    if (!isAsciiLetter(html.charCodeAt(nameStart))) {
      from = lt + 1; // a stray "<" is text: stays in the pending run
      continue;
    }

    let nameEnd = nameStart + 1;
    while (nameEnd < length && !isNameBoundary(html.charCodeAt(nameEnd))) nameEnd += 1;
    const name = html.slice(nameStart, nameEnd).toLowerCase();

    out.push(html.slice(textFrom, lt));
    const gt = endOfTag(html, nameEnd);
    if (gt === -1) {
      // No real end for this tag: the rest is one unterminated tag.
      out.push(" ");
      return out.join("");
    }

    if (!closing && RAW_BLOCKS.has(name)) {
      out.push(" ");
      textFrom = from = endOfBlock(html, name, gt + 1);
      continue;
    }
    out.push(name === "br" || (closing && NEWLINE_CLOSERS.has(name)) ? "\n" : " ");
    textFrom = from = gt + 1;
  }
  out.push(html.slice(textFrom));
  return out.join("");
}

/**
 * Tag-stripped text of an HTML email body. Block-level ends become newlines so
 * the plain-text view of an HTML-only message stays readable. A hand-written
 * linear scanner on purpose (it runs in the Convex runtime, which has no DOM,
 * on attacker-controlled input); the output is only ever rendered as TEXT,
 * never as markup. Character references are decoded exactly once, after the
 * tags are gone, so `&lt;script&gt;` stays text and `&amp;#60;` gives `&#60;`.
 */
export function htmlToPlainText(html: string): string {
  return collapseBlankLines(
    stripTags(html)
      .replace(CHARACTER_REFERENCE, decodeCharacterReference)
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
  ).trim();
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * One-line list preview: bodyText when it has content, else the tag-stripped
 * bodyHtml (entities already decoded); `<https://…>` dumps removed; whitespace
 * collapsed; at most 160 characters, counted in code points so an emoji or
 * surrogate pair is never cut in half. The result is always well-formed
 * UTF-16: a lone surrogate in the raw text becomes U+FFFD. References are
 * decoded before the cut, so the cut is plain truncation.
 */
export function buildPreview(bodyText?: string | null, bodyHtml?: string | null): string {
  // The whole body is converted in the one linear pass: no input slice and no
  // early stop, because any budget counted before entity decoding can be spent
  // on invisible spacers (`&nbsp;`, `&#32;`) and leave the preview empty or cut
  // inside an entity. The input is bounded by Convex's 1 MiB document limit.
  const source =
    bodyText && bodyText.trim() ? bodyText : bodyHtml ? htmlToPlainText(bodyHtml) : "";
  const cleaned = source.replace(ANGLE_LINK, " ").replace(/\s+/g, " ").trim();

  // Walk at most 161 code points instead of materialising all of them.
  let end = 0;
  let count = 0;
  let cutAt = -1;
  while (end < cleaned.length && count <= PREVIEW_MAX_LENGTH) {
    if (count === PREVIEW_MAX_LENGTH) cutAt = end;
    end += cleaned.codePointAt(end)! > 0xffff ? 2 : 1;
    count += 1;
  }
  // References are decoded before this cut, so any "&..." left here is literal
  // text and cutting it is ordinary truncation (what a browser shows).
  const preview = cutAt === -1 ? cleaned : cleaned.slice(0, cutAt).trimEnd();
  return preview.replace(LONE_SURROGATE, "�");
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
