/**
 * URL-scheme allowlist for image `src` values.
 *
 * Most image URLs reach the DOM from one of two places, neither of which is
 * free-form user text:
 *
 *   1. `ctx.storage.getUrl(id)` on the Convex side, which returns an absolute
 *      `https://<deployment>.convex.cloud/...` URL. See `convex/vehicles.ts`,
 *      `convex/marketplaceListings.ts`, `convex/websiteProjection.ts`.
 *   2. `URL.createObjectURL(file)` in the browser for local upload previews,
 *      which returns a `blob:` URL minted by the browser itself.
 *
 * There is one real exception, and it is publicly served:
 * `websiteSettings.logoUrl` is a caller-supplied string
 * (`websites.saveDraft`), `websiteProjection` prefers it over the
 * storage-derived logo, and `websites.resolveDomain` returns it to anonymous
 * visitors of the published dealer site. That value is validated at the write
 * by `validateStoredImageUrl` in `convex/websiteConfig.ts` — server-side is the
 * control; this function is defence in depth.
 *
 * Stating the safe set once also stops it being re-derived by hand at ~38
 * separate call sites. It was originally applied to 15 of them; a line-based
 * grep missed every multi-line `<img>` tag, which is exactly the failure mode
 * a single shared helper is supposed to prevent.
 *
 * Deny-by-default: anything that is not an allowed scheme (or a same-origin
 * relative path) yields `undefined`, and callers render no image at all.
 */

/**
 * Schemes that can appear in an AutoFlow image URL.
 *
 * `http:`/`https:` cover Convex storage and any remote image; `blob:` covers
 * local upload previews. Deliberately absent: `javascript:` and `vbscript:`
 * (script-bearing), `data:` (can carry active content and is not used by any
 * AutoFlow image path), and `file:` (local disk access).
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "blob:"]);

/**
 * ASCII whitespace and C0/DEL control characters. Browsers strip these while
 * parsing a URL, so `java\tscript:alert(1)` and `  javascript:alert(1)` both
 * reach the sink as `javascript:`. The scheme has to be inspected *after*
 * removing them, otherwise the allowlist is trivially bypassed.
 */
const IGNORED_WHEN_PARSING = /[\u0000-\u0020\u007f]/g;

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Returns the URL when it is safe to use as an image `src`, otherwise
 * `undefined`.
 *
 * Returning `undefined` (rather than `""`) matters: React omits the attribute
 * entirely, so the browser issues no request. An empty string would re-request
 * the current page in some browsers.
 */
export function safeImageSrc(rawUrl: string | null | undefined): string | undefined {
  if (typeof rawUrl !== "string") return undefined;

  const normalized = rawUrl.replace(IGNORED_WHEN_PARSING, "");
  if (!normalized) return undefined;

  // Relative (`/img/x.png`) and protocol-relative (`//host/x.png`) URLs inherit
  // the page's scheme and so can never introduce a new one.
  if (normalized.startsWith("/")) return rawUrl.trim();

  const scheme = SCHEME.exec(normalized)?.[1];
  // No scheme and not root-relative — a bare `foo.png` style reference. No
  // AutoFlow image path produces one, so deny by default.
  if (!scheme) return undefined;

  return ALLOWED_SCHEMES.has(`${scheme.toLowerCase()}:`) ? rawUrl.trim() : undefined;
}
