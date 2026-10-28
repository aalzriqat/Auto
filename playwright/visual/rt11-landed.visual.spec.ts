import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect as playwrightExpect, test } from "@playwright/test";
import { dictionaries } from "../../lib/i18n/dictionaries";
import { newContainedContext } from "../containedContext";

// SCRUM-760 c23862 / SCRUM-761 permanent screen replay. Real component markup,
// synthetic SDK rows, compiled app CSS; no app server or backend connection.
// W3C reflow: https://www.w3.org/WAI/WCAG22/Understanding/reflow.html
// Disabled controls: https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#focusabilityofdisabledcontrols
// Assertions: https://playwright.dev/docs/test-assertions
const ROOT = resolve(__dirname, "../..");
// These pages are already static; a missing control cannot arrive from a network response.
const expect = playwrightExpect.configure({ timeout: 500 });
const STATES = ["paid","negative","positive","loading","empty"] as const;
let directory = "";
let css = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  directory = mkdtempSync(resolve(tmpdir(), "autoflow-rt11-landed-"));
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1",
    "components/vehicles/Rt11LandedCostsVisualFixture.test.tsx"], {
    cwd: ROOT, env: { ...process.env, RT11_LANDED_FIXTURE_DIR: directory },
    stdio: "inherit", timeout: 120_000,
  });
  expect(readdirSync(directory).sort()).toEqual(
    ["en", "ar"].flatMap(locale => STATES.map(state => `landed-${locale}-${state}.html`)).sort());
  const here = createRequire(__filename);
  const entry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(entry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(entry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input })).css;
  expect(css).toContain("--background");
});

for (const locale of ["en", "ar"] as const) {
  for (const width of [375, 1440]) {
    test(`RT11 landed · ${locale} · ${width}px`, async ({ browser }, info) => {
      const t = dictionaries[locale];
      const context = await newContainedContext(browser, { viewport: { width, height: 1100 } });
      try {
        const page = await context.newPage();
        for (const state of STATES) {
          const html = readFileSync(resolve(directory, `landed-${locale}-${state}.html`), "utf8");
          await page.setContent(`<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="antialiased">${html}</body></html>`);
          await page.evaluate(() => document.fonts.ready);
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(page.locator("html")).toHaveCSS("direction", locale === "ar" ? "rtl" : "ltr");
          await expect(page.locator("[role=dialog]")).toHaveCSS("direction", locale === "ar" ? "rtl" : "ltr");
          const overflow = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            body: document.body.scrollWidth - document.documentElement.clientWidth,
          }));
          console.log(`RT11 landed ${locale} ${width} ${state}: ${JSON.stringify(overflow)}`);
          expect.soft(overflow.page, `${state} page overflow`).toBeLessThanOrEqual(0);
          expect.soft(overflow.body, `${state} body overflow`).toBeLessThanOrEqual(0);

        const section = page.locator("section").filter({ has: page.getByRole("heading", { name: t.LandedCost, exact: true }) });
        // The dialog scrolls internally. Capture the changed form, rather than
        // the unrelated expenses/valuations panels above it.
        await section.scrollIntoViewIfNeeded();
        await expect(section.getByRole("button", { name: t.AddCostItem, exact: true })).toBeEnabled();
        if (state === "paid" || state === "negative" || state === "positive") {
          const explanation = section.getByText(t.ServerError_PAID_LANDED_COST_CHANGE_PILOT_DISABLED, { exact: true });
          await expect.soft(explanation).toBeVisible();
          await expect.soft(explanation).toBeInViewport({ ratio: 1 });
          const paidLabel = section.getByRole("textbox").first();
          await expect(paidLabel).toHaveValue("Synthetic paid cost");
          await expect.soft(paidLabel).toBeDisabled();
          await expect.soft(section.getByRole("spinbutton").first()).toBeDisabled();
          await expect.soft(section.getByRole("combobox").first()).toBeDisabled();
          await expect.soft(section.getByTitle(t.Remove, { exact: true })).toHaveCount(state === "paid" ? 0 : 1);
          if (state !== "paid") {
            const added = section.getByRole("spinbutton").last();
            await expect(added).toBeEnabled();
            await expect.soft(added).toHaveValue(state === "negative" ? "0" : "25");
            await expect(section.getByRole("button", { name: t.SaveLandedCost, exact: true })).toBeEnabled();
          }
        } else if (state === "empty") {
          await expect(section.getByText(t.NoLandedCosts, { exact: true })).toBeVisible();
          await expect(section.getByRole("spinbutton")).toHaveCount(0);
        } else {
          await expect(section.locator('[data-slot="skeleton"], .animate-pulse')).toHaveCount(1);
          await expect(section.getByRole("spinbutton")).toHaveCount(0);
        }
          const output = process.env.RT11_SHOT_DIR || info.outputPath("shots");
          mkdirSync(output, { recursive: true });
          await page.screenshot({ path: resolve(output, `rt11-landed-${locale}-${width}-${state}.png`), fullPage: true, animations: "disabled" });
        }
      } finally { await context.close(); }
    });
  }
}

