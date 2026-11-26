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

/** True when `pathname` is allowed for a signed-out visitor. */
export function isPublicPagePath(pathname: string): boolean {
  return PUBLIC_PAGE_ROUTES.some((pattern) => {
    if (pattern.endsWith("(.*)")) {
      return pathname.startsWith(pattern.slice(0, -"(.*)".length));
    }
    return pathname === pattern;
  });
}
