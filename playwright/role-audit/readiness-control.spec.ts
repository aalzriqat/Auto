import { test, expect } from "@playwright/test";
import { requireReadyScreen } from "./readiness";

// Synthetic DOM controls use no application identity or backend.
test.use({ storageState: { cookies: [], origins: [] } });

test("screen readiness refuses permanent English, Arabic and spinner loading states", async ({ page }) => {
  for (const loading of [
    "<p>Loading customers...</p>",
    "<p>جاري تحميل العملاء...</p>",
    '<div class="animate-spin">Pending</div>',
    '<div aria-busy="true"><table><tbody><tr><td>Old row</td></tr></tbody></table></div>',
  ]) {
    // Stale rows plus a heading must not hide the ongoing loading state.
    await page.setContent(`<main><h2>Customers</h2><table><tbody><tr><td>Old row</td></tr></tbody></table>${loading}</main>`);
    await expect(requireReadyScreen(page, 200)).rejects.toThrow();
  }
  await page.setContent("<main><h2>Customers</h2></main>");
  await expect(requireReadyScreen(page, 200)).rejects.toThrow();
});

test("screen readiness accepts resolved rows and a recognized empty table", async ({ page }) => {
  for (const content of ["<tr><td>QA TEST customer</td></tr>", "<tr><td>No customers found</td></tr>"]) {
    await page.setContent(`<main><h2>Customers</h2><table><tbody>${content}</tbody></table></main>`);
    await requireReadyScreen(page, 200);
  }
});
