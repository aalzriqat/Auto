import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { newContainedContext } from "../containedContext";

// Real opening components, synthetic SDK values, compiled app CSS. No app server or live finance data.
const ROOT = resolve(__dirname, "../..");
const STATES = ["entry", "review", "readback", "redacted", "prepaid-entry", "prepaid-review", "prepaid-readback",
  "stock-entry", "stock-review", "stock-readback", "remaining-entry", "remaining-review",
  "remaining-readback", "remaining-redacted"] as const;
let fixtureDirectory = "";
let css = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fixtureDirectory = mkdtempSync(resolve(tmpdir(), "autoflow-opening-paint-"));
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1",
    "components/accounting/setup/OpeningAllocationVisualFixture.test.tsx"], {
    cwd: ROOT, env: { ...process.env, OPENING_ALLOCATION_VISUAL_FIXTURE_DIR: fixtureDirectory },
    stdio: "inherit", timeout: 120_000,
  });
  const expected = STATES.flatMap((state) => ["en", "ar"].map((locale) => `${state}-${locale}.html`)).sort();
  expect(readdirSync(fixtureDirectory).sort()).toEqual(expected);
  for (const file of expected) expect(readFileSync(resolve(fixtureDirectory, file), "utf8").trim().length).toBeGreaterThan(0);
  const here = createRequire(__filename);
  const entry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(entry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(entry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input })).css;
  expect(css).toContain("--background");
});

const COPY = {
  entry: { en: "Historical allocations", ar: "التوزيعات الافتتاحية التاريخية" },
  review: { en: "Opening balance awaiting your approval", ar: "رصيد افتتاحي بانتظار موافقتك" },
  readback: { en: "Posted allocation readback", ar: "مراجعة التوزيعات المرحلة" },
  redacted: { en: "An employee advance or commission allocation is visible only to payroll-authorized roles.",
    ar: "توزيع سلفة أو عمولة موظف متاح فقط للأدوار المخولة بالرواتب." },
  "prepaid-entry": { en: "Unexpired service or benefit", ar: "الخدمة أو المنفعة غير المنتهية" },
  "prepaid-review": { en: "Opening balance awaiting your approval", ar: "رصيد افتتاحي بانتظار موافقتك" },
  "prepaid-readback": { en: "Posted allocation readback", ar: "مراجعة التوزيعات المرحلة" },
  "stock-entry": { en: "Imported opening vehicle", ar: "مركبة مخزون افتتاحي مستوردة" },
  "stock-review": { en: "SYNTHSTOCKVIN001", ar: "SYNTHSTOCKVIN001" },
  "stock-readback": { en: "SYNTHSTOCKVIN001", ar: "SYNTHSTOCKVIN001" },
  "remaining-entry": { en: "Historical obligation type", ar: "نوع الالتزام التاريخي" },
  "remaining-review": { en: "Opening balance awaiting your approval", ar: "رصيد افتتاحي بانتظار موافقتك" },
  "remaining-readback": { en: "Liability remains unallocated", ar: "يبقى الالتزام غير موزع" },
  "remaining-redacted": { en: "An employee advance or commission allocation is visible only to payroll-authorized roles.",
    ar: "توزيع سلفة أو عمولة موظف متاح فقط للأدوار المخولة بالرواتب." },
} as const;

test("opening allocation, review and posted readback paint in EN/AR at phone and desktop widths", async ({ browser }, info) => {
  test.setTimeout(180_000);
  for (const locale of ["en", "ar"] as const) {
    for (const width of [375, 1440]) {
      for (const state of STATES) {
        const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
        try {
          const page = await context.newPage();
          const body = readFileSync(resolve(fixtureDirectory, `${state}-${locale}.html`), "utf8");
          await page.setContent(`<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="antialiased">${body}</body></html>`);
          await expect(page.getByText(COPY[state][locale], { exact: true }).first()).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${state} ${locale} fits ${width}px`).toBe(true);
          if (state === "redacted" || state === "remaining-redacted") {
            await expect(page.getByText("Synthetic Employee")).toHaveCount(0);
            await expect(page.getByText(state === "redacted" ? "40.000" : "7.777")).toHaveCount(0);
          }
          if (state === "entry") await expect(page.getByRole("combobox")).toHaveCount(3);
          if (state === "stock-entry") await expect(page.getByRole("combobox", { name: COPY[state][locale] })).toHaveValue("vehicle-a");
          if (state === "remaining-readback" || state === "remaining-redacted") {
            await expect(page.getByText("Unassigned deposits", { exact: true })).toBeVisible();
            await expect(page.getByText("Unidentified receipts", { exact: true })).toBeVisible();
          }
          if (state === "prepaid-entry") {
            await expect(page.getByRole("checkbox", { name: locale === "ar"
              ? "أؤكد أن هذا المبلغ يمثل منفعة فعلية غير منتهية في تاريخ الافتتاح، وأن مستندها محفوظ لمراجعة الفريق المالي."
              : "I confirm this amount is a genuine unexpired benefit as of the opening date, with the supporting source retained for finance review." })).toBeChecked();
          }
          if (state === "review" || state === "prepaid-review" || state === "stock-review" || state === "remaining-review")
            await expect(page.getByTestId("opening-balance-approve")).toBeEnabled();
          await page.screenshot({ path: info.outputPath(`opening-${state}-${locale}-${width}.png`),
            fullPage: true, animations: "disabled" });
        } finally { await context.close(); }
      }
    }
  }
});
