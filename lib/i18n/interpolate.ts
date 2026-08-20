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
 */
export function interpolate(
  template: string,
  values: Record<string, string | number>
): string {
  return Object.entries(values).reduce(
    (out, [key, value]) => out.split(`{${key}}`).join(String(value)),
    template
  );
}
