import type { Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";
import { EGRESS_CONTEXT_OPTIONS } from "../scripts/intelligence/browserEgressLaunch.mjs";

/**
 * The only way a spec may build its own browser context (SCRUM-350 G4 M-1).
 *
 * `browser.newContext()` inherits the browser-wide proxy launch arguments but
 * NOT the project's context options, so without this a manual context carrying
 * saved QA storageState could register a service worker, which is a path around
 * the egress proxy. The containment options are applied last so a caller's
 * options can never switch them off. `scripts/intelligence/playwrightContainedContext.test.ts` fails if
 * a spec calls `browser.newContext(` directly.
 */
export function newContainedContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  return browser.newContext({ ...options, ...EGRESS_CONTEXT_OPTIONS });
}
