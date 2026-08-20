/**
 * Fill every `{placeholder}` in a translated string.
 *
 * ⚠️ `String.prototype.replace` with a STRING pattern replaces the FIRST match
 * only. That is fine until a message names the same value twice — and
 * `ImportPurchaseTooManyRows` does, in both locales:
 *
 *   "…records at most {max} at a time… Split it into files of {max} or fewer"
 *
 * so the chained `.replace("{max}", …)` left a literal `{max}` on screen for
 * every operator who hit the row cap, in English and Arabic alike. The bug is
 * invisible in any message with one placeholder, which is most of them — which
 * is exactly why it survived.
 *
 * Replacing every occurrence removes the whole class rather than that one
 * string. A missing key is left untouched rather than blanked, so a gap shows
 * up as a visible `{name}` instead of a sentence with a hole in it.
 *
 * ⚠️ SINGLE PASS OVER THE ORIGINAL TEMPLATE — never a fold over the running
 * result. A reviewer caught the first version doing the latter, and it was
 * order-dependent: a value that itself contained another key's placeholder got
 * re-substituted by a later iteration. Reproduced —
 *
 *   fold: interpolate("{a}{b}", { a: "{b}", b: "X" })  ->  "XX"
 *   fold: interpolate("{a}{b}", { b: "X", a: "{b}" })  ->  "{b}X"
 *
 * same inputs, different key order, different output; and realistically
 * `{ company: "{count} Motors", count: 5 }` silently became "5 Motors". Only
 * numbers reach the one call site today, so it was unreachable — but this
 * signature accepts strings, and the values this product puts in messages are
 * dealer-entered spreadsheet text: company names, supplier names, VINs.
 *
 * Scanning the template once cannot re-read inserted text, so the class is
 * closed by construction rather than by every future caller being careful.
 */
export function interpolate(
  template: string,
  values: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match
  );
}
