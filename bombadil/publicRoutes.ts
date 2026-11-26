// Page routes a signed-out visitor may open, copied from the createRouteMatcher
// list in proxy.ts. A Bombadil spec runs in a restricted runtime and cannot
// import proxy.ts, so publicRoutes.test.ts fails when the two lists drift.

/** Clerk route-matcher patterns for pages. A "(.*)" suffix means "and below". */
export const PUBLIC_PAGE_ROUTES: readonly string[] = [
  "/",
  "/dealer-site(.*)",
  "/marketplace(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/privacy",
  "/terms",
  "/contact",
];

/** proxy.ts entries that are not pages; named so the drift test can account for them. */
export const NON_PAGE_PUBLIC_ROUTES: readonly string[] = [
  "/manifest.webmanifest",
  "/api/health",
  "/clerk-webhook",
];

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

/** Scheme, host and port of an absolute http(s) URL, default port dropped; null otherwise. */
function originOf(url: string): string | null {
  const m =
    /^(https?:)\/\/([^/?#@]*@)?([^/?#:]+|\[[^\]]+\])(?::(\d*))?(?=[/?#]|$)/i.exec(
      url,
    );
  if (!m?.[1] || !m[3]) return null;
  const scheme = m[1].toLowerCase();
  const port = m[4] && m[4] !== DEFAULT_PORTS[scheme] ? `:${m[4]}` : "";
  return `${scheme}//${m[3].toLowerCase()}${port}`;
}

/**
 * True when absolute `href` has exactly the same scheme, host and port as
 * `origin`. A string prefix test is wrong: http://127.0.0.1:30001 starts with
 * http://127.0.0.1:3000. Written without `URL`, whose presence in Bombadil's
 * spec runtime is not documented.
 */
export function isSameOrigin(href: string, origin: string): boolean {
  const a = originOf(href);
  return a !== null && a === originOf(origin);
}

/** True when `pathname` is allowed for a signed-out visitor. */
export function isPublicPagePath(pathname: string): boolean {
  return PUBLIC_PAGE_ROUTES.some((pattern) => {
    if (pattern.endsWith("(.*)")) {
      return pathname.startsWith(pattern.slice(0, -"(.*)".length));
    }
    return pathname === pattern;
  });
}
