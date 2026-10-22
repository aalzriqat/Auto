import { test, expect } from "@playwright/test";
import { dismissAuditNavigation } from "../role-audit/readiness";

// SCRUM-760: run39818759069 had green phone cells whose screenshots were still
// covered by navigation. Synthetic browser controls need no identity or backend.
test.use({ storageState: { cookies: [], origins: [] } });

test("phone capture waits until the closing navigation overlay is gone", async ({ page }) => {
  await page.setContent(`<main><button>Ready page action</button></main><div role="dialog" aria-modal="true">Navigation</div>
    <script>document.addEventListener('keydown', event => {
      if (event.key === 'Escape') setTimeout(() => document.querySelector('[role=dialog]').remove(), 300);
    });</script>`);
  await dismissAuditNavigation(page, 1_000);
  // Independent observation at the screenshot boundary, not another wait.
  expect(await page.getByRole("dialog").count()).toBe(0);
});

test("phone capture refuses navigation that remains open after Escape", async ({ page }) => {
  await page.setContent('<main><button>Ready page action</button></main><div role="dialog" aria-modal="true">Navigation</div>');
  await expect(dismissAuditNavigation(page, 200)).rejects.toThrow(/toHaveCount/);
  expect(await page.getByRole("dialog").count()).toBe(1);
});
