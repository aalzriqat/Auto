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
const STATES = ["finalized","active","loading","empty"] as const;
let directory = "";
let css = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  directory = mkdtempSync(resolve(tmpdir(), "autoflow-rt11-custody-"));
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1",
    "components/applications/cockpit/Rt11CustodyVisualFixture.test.tsx"], {
    cwd: ROOT, env: { ...process.env, RT11_CUSTODY_FIXTURE_DIR: directory },
    stdio: "inherit", timeout: 120_000,
  });
  expect(readdirSync(directory).sort()).toEqual(
    ["en", "ar"].flatMap(locale => STATES.map(state => `custody-${locale}-${state}.html`)).sort());
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
    test(`RT11 custody · ${locale} · ${width}px`, async ({ browser }, info) => {
      const t = dictionaries[locale];
      const context = await newContainedContext(browser, { viewport: { width, height: 1100 } });
      try {
        const page = await context.newPage();
        for (const state of STATES) {
          const html = readFileSync(resolve(directory, `custody-${locale}-${state}.html`), "utf8");
          await page.setContent(`<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="antialiased">${html}</body></html>`);
          await page.evaluate(() => document.fonts.ready);
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(page.locator("html")).toHaveCSS("direction", locale === "ar" ? "rtl" : "ltr");
          await expect(page.locator("main")).toHaveCSS("direction", locale === "ar" ? "rtl" : "ltr");
          const overflow = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            body: document.body.scrollWidth - document.documentElement.clientWidth,
          }));
          console.log(`RT11 custody ${locale} ${width} ${state}: ${JSON.stringify(overflow)}`);
          expect.soft(overflow.page, `${state} page overflow`).toBeLessThanOrEqual(0);
          expect.soft(overflow.body, `${state} body overflow`).toBeLessThanOrEqual(0);

        if (state === "finalized") {
          const open = page.getByTestId("custody-record-custody-open");
          const closed = page.getByTestId("custody-record-custody-closed");
          const reimburse = open.getByRole("button", { name: t.CustodyReimburse, exact: true });
          await expect.soft(reimburse).toBeDisabled();
          await expect.soft(reimburse).toHaveAttribute("title", t.ServerError_CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED);
          await expect.soft(open.getByText(t.ServerError_CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED, { exact: true })).toBeVisible();
          await expect.soft(open.getByRole("button", { name: t.CustodyReverse, exact: true })).toHaveCount(0);
          const reopen = closed.getByRole("button", { name: t.CustodyReopen, exact: true });
          await expect.soft(reopen).toBeDisabled();
          await expect.soft(reopen).toHaveAttribute("title", t.ServerError_CUSTODY_REOPEN_PILOT_DISABLED);
          await expect.soft(closed.getByText(t.ServerError_CUSTODY_REOPEN_PILOT_DISABLED, { exact: true })).toBeVisible();
          // The log is expanded and populated: absence of Reverse cannot pass on an unmounted log.
          await expect(page.getByTestId("custody-movements")).toHaveCount(2);
          await expect(open.getByTestId("custody-movements")).toBeVisible();
          await expect(open.getByTestId("custody-movements")).toContainText(t.CustodyKindIssued);
        } else if (state === "active") {
          const open = page.getByTestId("custody-record-custody-open");
          await expect(open.getByRole("button", { name: t.CustodyIssueMore, exact: true })).toBeEnabled();
          await expect(open.getByRole("button", { name: t.CustodyReimburse, exact: true })).toBeEnabled();
          await expect(open.getByRole("button", { name: t.CustodyReverse, exact: true })).toBeEnabled();
        } else {
          await expect(page.getByText(state === "loading" ? t.Loading : t.CustodyNone, { exact: true })).toBeVisible();
          await expect(page.locator('[data-testid^="custody-record-"]')).toHaveCount(0);
        }
          const output = process.env.RT11_SHOT_DIR || info.outputPath("shots");
          mkdirSync(output, { recursive: true });
          await page.screenshot({ path: resolve(output, `rt11-custody-${locale}-${width}-${state}.png`), fullPage: true, animations: "disabled" });
        }
      } finally { await context.close(); }
    });
  }
}

