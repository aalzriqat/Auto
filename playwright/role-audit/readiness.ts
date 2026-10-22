import { expect, type Page } from "@playwright/test";

/** Visible screen readiness only; never proves data completeness or accounting. */
export async function requireReadyScreen(page: Page, timeout = 15_000, expectedPath?: string): Promise<void> {
  if (expectedPath !== undefined) {
    await expect(page).toHaveURL((url) => url.pathname === expectedPath, { timeout });
  }
  const main = page.locator("main");
  await expect(main).toBeVisible({ timeout });
  await expect(main).not.toHaveAttribute("aria-busy", "true", { timeout });
  await expect(main).not.toHaveAttribute("data-loading", "true", { timeout });
  // These states are rendered by the audited pages and their shared guards.
  // Their absence measures visible loading completion, not query completeness.
  await expect(main.locator('[aria-busy="true"], [data-loading="true"], .animate-spin, .animate-pulse, [data-slot="skeleton"]'))
    .toHaveCount(0, { timeout });
  // textContent can concatenate a preceding table cell with this message, so
  // a leading word boundary would miss "Old rowLoading customers...".
  await expect(main).not.toContainText(/(?:Loading|Searching|Fetching|Checking readiness)\b|Please wait|جار(?:ي|ٍ)\s+(?:تحميل|التحميل|البحث|فحص)/iu, { timeout });
  await expect(main).not.toHaveText(/^\s*$/, { timeout });
  // A heading alone is insufficient: require content or an actionable/empty
  // state surface, rather than only the shell around an unresolved query.
  await expect(main.locator('table, form, button, input, select, textarea, a[href], [role="tablist"], [data-testid]'))
    .not.toHaveCount(0, { timeout });
  expect(await main.innerText()).not.toMatch(/\bNaN\b|\bundefined\b|\[object Object\]|Something went wrong|Application error|حدث خطأ ما/);
  if (expectedPath !== undefined) {
    await expect(page).toHaveURL((url) => url.pathname === expectedPath, { timeout });
  }
}
