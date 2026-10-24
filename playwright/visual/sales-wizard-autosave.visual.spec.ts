import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { newContainedContext } from "../containedContext";

// Static paint of the real error handler and shared toaster, with a synthetic rejected SDK call.
test("autosave failure toast fits EN/AR phone and desktop", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const root = resolve(__dirname, "../..");
  const directory = mkdtempSync(resolve(tmpdir(), "autoflow-autosave-paint-"));
  execFileSync(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1",
    "components/sales/SalesWizard.test.tsx"], {
    cwd: root, env: { ...process.env, SALES_WIZARD_VISUAL_FIXTURE_DIR: directory },
    stdio: "inherit", timeout: 120_000,
  });
  expect(readdirSync(directory).sort()).toEqual(["autosave-ar.html", "autosave-en.html"]);
  const here = createRequire(__filename);
  const entry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(entry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(entry).resolve("postcss"));
  const input = resolve(root, "app/globals.css");
  const css = (await postcss([tailwind({ base: root })]).process(readFileSync(input, "utf8"), { from: input })).css;
  for (const locale of ["en", "ar"] as const) {
    for (const width of [375, 1440]) {
      const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        const html = readFileSync(resolve(directory, `autosave-${locale}.html`), "utf8");
        await page.setContent(`<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}">${html}</html>`);
        await page.addStyleTag({ content: css });
        const message = locale === "ar" ? "فشل الحفظ" : "Failed to save";
        await expect(page.getByText(message, { exact: true })).toBeVisible();
        await expect(page.getByText("Synthetic internal backend detail")).toHaveCount(0);
        const toast = page.locator("[data-sonner-toast]");
        await expect(toast).toHaveCount(1);
        const bounds = await toast.boundingBox();
        expect(bounds).not.toBeNull();
        if (!bounds) throw new Error("Toast bounds unavailable");
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await toast.screenshot({ path: info.outputPath(`autosave-${locale}-${width}.png`), animations: "disabled" });
      } finally { await context.close(); }
    }
  }
});
