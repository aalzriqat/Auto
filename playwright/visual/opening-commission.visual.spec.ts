import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { newContainedContext } from "../containedContext";

// Real mounted component, providers and compiled app CSS; synthetic SDK rows only.
const ROOT = resolve(__dirname, "../..");
let fixtureDirectory = "";
let css = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fixtureDirectory = mkdtempSync(resolve(tmpdir(), "autoflow-opening-commission-paint-"));
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1",
    "components/commissions/OpeningCommissionLiabilitiesVisualFixture.test.tsx"], {
    cwd: ROOT, env: { ...process.env, OPENING_COMMISSION_VISUAL_FIXTURE_DIR: fixtureDirectory },
    stdio: "inherit", timeout: 120_000,
  });
  expect(readdirSync(fixtureDirectory).sort()).toEqual(["opening-commission-ar.html", "opening-commission-en.html"]);
  const here = createRequire(__filename);
  const entry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(entry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(entry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input })).css;
  expect(css).toContain("--background");
});

test("opening commission owed, future and unavailable rows paint in EN/AR at phone and desktop widths", async ({ browser }, info) => {
  test.setTimeout(180_000);
  for (const locale of ["en", "ar"] as const) {
    for (const width of [375, 1440]) {
      const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        const body = readFileSync(resolve(fixtureDirectory, `opening-commission-${locale}.html`), "utf8");
        await page.setContent(`<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="antialiased">${body}</body></html>`);
        const owed = page.getByRole("row").filter({ hasText: "Synthetic owed employee" });
        const future = page.getByRole("row").filter({ hasText: "Synthetic future employee" });
        const unavailable = page.getByRole("row").filter({ hasText: "Synthetic unavailable employee" });
        await expect(owed).toContainText(locale === "ar" ? "ما زال مستحقًا" : "Still owed");
        await expect(future).toContainText(locale === "ar" ? "لم يحن تاريخ الاستحقاق بعد" : "Not yet effective");
        await expect(future).not.toContainText(locale === "ar" ? "تمت تسويته عبر الرواتب" : "Settled in payroll");
        await expect(unavailable).toContainText(locale === "ar" ? "المصدر غير متاح — يلزم مراجعة مالية" : "Source unavailable — finance review required");
        await expect(unavailable.getByRole("cell").nth(1)).toHaveText("—");
        await expect(unavailable.getByRole("cell").nth(2)).toHaveText("—");
        await expect(owed).toContainText("100.003 JOD");
        await expect(page.getByRole("button")).toHaveCount(0);
        await expect(page.getByRole("link")).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `opening commission ${locale} fits ${width}px`).toBe(true);
        await page.screenshot({ path: info.outputPath(`opening-commission-${locale}-${width}.png`),
          fullPage: true, animations: "disabled" });
      } finally { await context.close(); }
    }
  }
});
