// SCRUM-1005: the pure rules behind bombadil/public-surface.spec.ts. They live
// here, under scripts/, so the unit suite measures them (the trusted LCOV
// validator admits no source under bombadil/: scripts/validateLcovSources.cjs).
// The spec keeps only the Bombadil wiring. Local imports need the `.ts`
// extension for Bombadil's bundler.
import { isSameOrigin } from "./publicRoutes.ts";

/** The Clerk sign-in and sign-up routes: one definition for every use. */
const AUTH_PATH = /^\/sign-(in|up)(\/|\?|#|$)/;
const AUTH_LABEL = /\b(sign[ -]?(in|up)|log[ -]?in|get started)\b/i;
const ABSOLUTE_PREFIX = /^[a-z][a-z0-9+.-]*:/i;
const AUTHORITY_PREFIX = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const BROKEN_VALUE_TEXT = /(^|[^\w])(NaN|undefined)([^\w]|$)|\[object Object\]/;

/** True for a pathname (or path with query or hash) on a Clerk page. */
export function isAuthPath(pathname: string): boolean {
  return AUTH_PATH.test(pathname);
}

/** True for a link target, relative or absolute, that points at a Clerk page. */
export function isAuthHref(href: string): boolean {
  return isAuthPath(href.replace(AUTHORITY_PREFIX, ""));
}

/**
 * True when clicking a link would leave the safe area: Clerk pages (they reject
 * random input by design and could rate-limit the test instance), auth-looking
 * labels, and any absolute URL on another origin.
 */
export function leavesSafeArea(
  href: string | null,
  label: string,
  origin: string,
): boolean {
  if (AUTH_LABEL.test(label)) return true;
  if (href === null) return false;
  if (isAuthHref(href)) return true;
  if (ABSOLUTE_PREFIX.test(href)) {
    return !isSameOrigin(href, origin) && !href.startsWith("#");
  }
  return false;
}

/** Arabic is right-to-left and English left-to-right on every screen. */
export function htmlDirectionMatchesLanguage(
  lang: string,
  dir: string,
): boolean {
  return (
    (lang === "ar" || lang === "en") && dir === (lang === "ar" ? "rtl" : "ltr")
  );
}

/** A literal "NaN", "undefined" or "[object Object]" where a value belongs. */
export function hasBrokenValueText(text: string): boolean {
  return BROKEN_VALUE_TEXT.test(text);
}

/** Deal money elements that only a signed-in, permitted role may ever render. */
export const DEAL_MONEY_TEST_IDS: readonly string[] = [
  "deal-financial-overview",
  "overview-net-profit",
  "overview-sale-price",
  "deal-commissions-row",
];

interface TestIdQuery {
  querySelectorAll(selector: string): { length: number };
}

/** How many deal money elements the document renders. */
export function countDealMoneyElements(document: TestIdQuery): number {
  return DEAL_MONEY_TEST_IDS.reduce(
    (count, id) =>
      count + document.querySelectorAll(`[data-testid="${id}"]`).length,
    0,
  );
}
