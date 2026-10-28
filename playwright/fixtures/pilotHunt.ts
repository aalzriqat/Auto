import type { BrowserContext, Page } from "@playwright/test";

/** G8 web hunt scope. These are entry points, never evidence of execution. */
export const PILOT_HUNT_LOCALES = ["en", "ar"] as const;
export const PILOT_HUNT_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 320, height: 812 },
] as const;
export const PILOT_EXPLORER_ROUTES = ["deals", "sales", "accounting"] as const;

/** Each chain identifies a mounted subview, not just its surrounding shell. */
export const PILOT_ACCOUNTING_VIEWS = [
  { section: "overview", tabs: [] },
  { section: "receivables", tabs: ["claims"] },
  { section: "receivables", tabs: ["collections", "receivables"] },
  { section: "receivables", tabs: ["collections", "cheques"] },
  { section: "receivables", tabs: ["collections", "paymentLinks"] },
  { section: "receivables", tabs: ["collections", "cashDrawer"] },
  { section: "receivables", tabs: ["collections", "payments"] },
  { section: "receivables", tabs: ["collections", "reports"] },
  { section: "receivables", tabs: ["collections", "approvals"] },
  { section: "cash", tabs: [] },
  { section: "journal", tabs: ["register"] },
  { section: "journal", tabs: ["manual"] },
  { section: "reconcile", tabs: [] },
  { section: "statements", tabs: ["trialBalance"] },
  { section: "statements", tabs: ["incomeStatement"] },
  { section: "statements", tabs: ["balanceSheet"] },
  { section: "statements", tabs: ["vatReturn"] },
  { section: "assets", tabs: ["fixedAssets"] },
  { section: "assets", tabs: ["prepaid"] },
  { section: "assets", tabs: ["equity"] },
  { section: "settings", tabs: [] },
] as const;

export function pilotExplorerStarts() {
  return PILOT_HUNT_LOCALES.flatMap(locale => PILOT_HUNT_VIEWPORTS.flatMap(viewport =>
    PILOT_EXPLORER_ROUTES.map(route => ({ locale, viewport, route }))));
}

/**
 * Runs one locale/viewport cell on its own page from the caller's (already
 * authenticated) context, with exactly one locale init script installed.
 *
 * Playwright documents that the evaluation order of multiple init scripts on a
 * page is not defined (Page.addInitScript), so calling addInitScript once per
 * cell on a shared page makes the locale under test non-deterministic: every
 * earlier locale's script still runs on each navigation. A fresh page per cell
 * from BrowserContext.newPage shares the context's cookies and storage state
 * but carries no earlier scripts, routes or listeners. The page is closed when
 * the cell ends, so nothing leaks into the next cell.
 */
export async function withLocalePage<T>(
  context: BrowserContext,
  locale: (typeof PILOT_HUNT_LOCALES)[number],
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<T>,
  onPageError?: (message: string) => void,
): Promise<T> {
  const page = await context.newPage();
  try {
    if (onPageError) page.on("pageerror", error => onPageError(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(language => localStorage.setItem("autoflow-locale", language), locale);
    return await run(page);
  } finally {
    await page.close();
  }
}
