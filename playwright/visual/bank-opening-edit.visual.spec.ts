import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { newContainedContext } from "../containedContext";

// SCRUM-945: real mounted bank opening panel, table and edit dialog with the compiled app CSS; synthetic rows only.
const ROOT = resolve(__dirname, "../..");
const COPY_DIRECTORY = resolve(ROOT, "test-results/scrum945-visual");
const STATES = ["table", "dialog", "error"] as const;
const WIDTHS = [375, 1440] as const;
const LABELS = {
  en: { edit: "Edit opening balance", amount: "Stated opening balance", save: "Save", date: "Opening Balance Date" },
  ar: { edit: "تعديل الرصيد الافتتاحي", amount: "الرصيد الافتتاحي المصرّح به", save: "حفظ", date: "تاريخ الرصيد الافتتاحي" },
} as const;
let fixtureDirectory = "";
let css = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fixtureDirectory = mkdtempSync(resolve(tmpdir(), "autoflow-bank-opening-paint-"));
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1",
    "components/accounting/bankAccounts/BankOpeningEditVisualFixture.test.tsx"], {
    cwd: ROOT, env: { ...process.env, BANK_OPENING_EDIT_VISUAL_FIXTURE_DIR: fixtureDirectory },
    stdio: "inherit", timeout: 120_000,
  });
  const expected = ["en", "ar"].flatMap((l) => STATES.map((s) => `bank-opening-${l}-${s}.html`)).sort();
  expect(readdirSync(fixtureDirectory).sort()).toEqual(expected);
  const here = createRequire(__filename);
  const entry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(entry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(entry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input })).css;
  expect(css).toContain("--background");
  mkdirSync(COPY_DIRECTORY, { recursive: true });
});

async function paint(page: Page, locale: "en" | "ar", state: (typeof STATES)[number]) {
  const body = readFileSync(resolve(fixtureDirectory, `bank-opening-${locale}-${state}.html`), "utf8");
  await page.setContent(`<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="antialiased">${body}</body></html>`);
}

async function insideViewport(page: Page, locator: ReturnType<Page["locator"]>, what: string) {
  await expect(locator, `${what} visible`).toBeVisible();
  const box = await locator.boundingBox();
  const width = await page.evaluate(() => innerWidth);
  const height = await page.evaluate(() => innerHeight);
  expect(box, `${what} has a box`).not.toBeNull();
  expect(box!.x, `${what} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what} right edge`).toBeLessThanOrEqual(width);
  expect(box!.y, `${what} top edge`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${what} bottom edge`).toBeLessThanOrEqual(height);
}

for (const state of STATES) {
  test(`bank opening edit: ${state} paints in EN/AR at phone and desktop widths`, async ({ browser }, info) => {
    test.setTimeout(180_000);
    for (const locale of ["en", "ar"] as const) {
      for (const width of WIDTHS) {
        const labels = LABELS[locale];
        const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
        try {
          const page = await context.newPage();
          await paint(page, locale, state);
          if (state === "table") {
            const edit = page.getByRole("button", { name: labels.edit }).first();
            await expect(edit).toContainText(labels.edit);
            await expect(page.getByRole("dialog")).toHaveCount(0);
            // The cell scrolls inside its frame on a phone; the control must be reachable there.
            await edit.scrollIntoViewIfNeeded();
            await expect(edit).toBeVisible();
          } else {
            const dialog = page.getByRole("dialog");
            await expect(dialog).toContainText(labels.amount);
            await expect(dialog).toContainText(labels.date);
            const amount = page.locator("#stated-opening-amount");
            await expect(amount).toHaveAttribute("dir", "ltr");
            await expect(amount).toHaveAttribute("inputmode", "decimal");
            await insideViewport(page, amount, "amount input");
            await insideViewport(page, dialog.getByRole("button", { name: labels.save }), "Save button");
            if (state === "dialog") {
              await expect(amount).toHaveValue("4100.000");
              await expect(page.getByRole("alert")).toHaveCount(0);
            } else {
              await expect(amount).toHaveValue("1.2345");
              await expect(page.getByRole("alert")).toHaveCount(1);
              await expect(dialog.getByRole("button", { name: labels.save })).toBeDisabled();
            }
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `bank opening ${state} ${locale} fits ${width}px`).toBe(true);
          const shot = info.outputPath(`bank-opening-${locale}-${state}-${width}.png`);
          await page.screenshot({ path: shot, fullPage: true, animations: "disabled" });
          copyFileSync(shot, resolve(COPY_DIRECTORY, `bank-opening-${locale}-${state}-${width}.png`));
        } finally { await context.close(); }
      }
    }
  });
}
