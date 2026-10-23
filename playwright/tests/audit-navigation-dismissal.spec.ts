import { test, expect } from "@playwright/test";
import { dismissAuditNavigation } from "../role-audit/readiness";

// SCRUM-760: run39818759069 had green phone cells whose screenshots were still
// covered by navigation. Synthetic browser controls need no identity or backend.
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 375, height: 812 } });
test.beforeEach(({ page }) => {
  expect(page.viewportSize()).toEqual({ width: 375, height: 812 });
});

test("phone capture waits until the closing navigation overlay is gone", async ({ page }) => {
  await page.setContent(`<main><button>Ready page action</button></main><div role="dialog" aria-modal="true">Navigation</div>
    <script>document.addEventListener('keydown', event => {
      if (event.key === 'Escape') setTimeout(() => document.querySelector('[role=dialog]').remove(), 300);
    });</script>`);
  await dismissAuditNavigation(page, 1_000);
  // Independent observation at the screenshot boundary, not another wait.
  expect(await page.locator('[role="dialog"]').count()).toBe(0);
});

test("phone capture refuses navigation that remains open after Escape", async ({ page }) => {
  await page.setContent('<main><button>Ready page action</button></main><div role="dialog" aria-modal="true">Navigation</div>');
  await expect(dismissAuditNavigation(page, 200)).rejects.toThrow(/toHaveCount/);
  expect(await page.locator('[role="dialog"]').count()).toBe(1);
});

test("phone capture refuses an absent navigation drawer before Escape", async ({ page }) => {
  await page.setContent(`<main><button>Ready page action</button></main>
    <script>document.body.dataset.escapeCount = '0'; document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.body.dataset.escapeCount = '1';
    });</script>`);
  await expect(dismissAuditNavigation(page, 200)).rejects.toThrow(/toBeVisible/);
  expect(await page.locator("body").getAttribute("data-escape-count")).toBe("0");
});

test("phone capture refuses navigation hidden only from accessibility", async ({ page }) => {
  await page.setContent(`<main><button>Ready page action</button></main>
    <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white">Navigation</div>
    <script>document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.querySelector('[role=dialog]').setAttribute('aria-hidden', 'true');
    });</script>`);
  let refusal: unknown;
  try { await dismissAuditNavigation(page, 200); } catch (error) { refusal = error; }
  // Accessibility removal does not remove the visible, obstructing DOM node.
  expect(await page.getByRole("dialog").count()).toBe(0);
  expect(await page.locator('[role="dialog"]').count()).toBe(1);
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toMatch(/toHaveCount/);
});
