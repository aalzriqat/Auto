import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type TestInfo } from "@playwright/test";
import { newContainedContext } from "../containedContext";

// Actual component markup and compiled app CSS. No authentication, app shell,
// hydration or backend is claimed. Live role replays remain separate tests.
const ROOT = resolve(__dirname, "../..");
const STATES = ["denied-expenses", "deposit-loading", "deposit-empty", "lead-source", "sales-empty", "quote-choice", "lead-reader", "marketplace-reply"] as const;
type State = typeof STATES[number];
let fixtures = "", css = "";
test.beforeAll(async () => {
  fixtures = mkdtempSync(resolve(tmpdir(), "autoflow-role-paint-"));
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1",
    "components/auth/RoleAccessVisualFixture.test.tsx"], {
    cwd: ROOT, env: { ...process.env, ROLE_ACCESS_VISUAL_FIXTURE_DIR: fixtures }, stdio: "inherit", timeout: 120_000,
  });
  const expected = STATES.flatMap(state => ["en", "ar"].map(locale => `${state}-${locale}.html`)).sort();
  expect(readdirSync(fixtures).sort()).toEqual(expected);
  for (const file of expected) expect(readFileSync(resolve(fixtures, file), "utf8").trim().length).toBeGreaterThan(0);
  const here = createRequire(__filename), entry = here.resolve("@tailwindcss/postcss"), tailwindModule = here(entry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(entry).resolve("postcss")), input = resolve(ROOT, "app/globals.css");
  css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input })).css;
  expect(css).toContain("--background");
});

// Literals are written independently of the markup and dictionary producer.
const COPY = {
  "denied-expenses": { en: "Access Not Allowed", ar: "الوصول غير مسموح" },
  "deposit-empty": { en: "No deposits are waiting for confirmation.", ar: "لا توجد عربونات بانتظار التأكيد." },
  "sales-empty": { en: "No sales found.", ar: "لم يتم العثور على مبيعات." },
  "lead-source": { en: "Synthetic configured channel", ar: "Synthetic configured channel" },
  "quote-choice": { en: "Synthetic eligibility", ar: "Synthetic eligibility" },
  "lead-reader": { en: "No leads found.", ar: "لم يتم العثور على عملاء محتملين." },
  "marketplace-reply": { en: "Not available", ar: "غير متوفرة" },
} as const;

async function paint(browser: Parameters<typeof newContainedContext>[0], info: TestInfo, states: readonly State[]) {
  for (const locale of ["en", "ar"] as const) {
    for (const width of [375, 1440]) {
      for (const state of states) {
        const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
        try {
          const page = await context.newPage(), body = readFileSync(resolve(fixtures, `${state}-${locale}.html`), "utf8");
          await page.setContent(`<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="antialiased">${body}</body></html>`);
          expect(await page.locator("body").evaluate(node => getComputedStyle(node).direction)).toBe(locale === "ar" ? "rtl" : "ltr");
          if (state === "deposit-loading") {
            await expect(page.getByTestId("pending-deposit-loading")).toBeVisible();
            await expect(page.getByTestId("pending-deposit-loading")).toHaveAttribute("aria-busy", "true");
            await expect(page.getByTestId("pending-deposit-empty")).toHaveCount(0);
          } else {
            // Responsive sales markup includes a hidden counterpart; require
            // the actual painted copy rather than choosing the first DOM node.
            await expect(page.getByText(COPY[state][locale], { exact: true }).filter({ visible: true }).first()).toBeVisible();
          }
          if (state === "deposit-empty") await expect(page.getByTestId("pending-deposit-loading")).toHaveCount(0);
          if (state === "sales-empty") await expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(0);
          if (state === "lead-reader") {
            await expect(page.getByRole("button", { name: locale === "en" ? "Add Lead" : "إضافة عميل محتمل" })).toHaveCount(0);
            await expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(0);
          }
          if (state === "marketplace-reply") {
            await expect(page.getByRole("button", { name: locale === "en" ? "Send reply" : "إرسال الرد", exact: true })).toBeEnabled();
            await expect(page.getByRole("combobox")).toHaveCount(1);
          }
          if (state === "lead-source") {
            await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
            await expect(page.getByRole("combobox", { name: locale === "en" ? "Lead Source" : "مصدر العميل المحتمل" })).toHaveText("Synthetic configured channel");
            await expect(page.getByRole("listbox")).toHaveCount(0);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${state} fits ${width}px`).toBe(true);
          await page.screenshot({ path: info.outputPath(`role-access-${state}-${locale}-${width}.png`), fullPage: true, animations: "disabled" });
        } finally { await context.close(); }
      }
    }
  }
}

test("PR screen paint refuses expenses before protected subscriptions", async ({ browser }, info) => {
  await paint(browser, info, ["denied-expenses"]);
});
test("PR screen paint distinguishes loading and empty deposit queues", async ({ browser }, info) => {
  await paint(browser, info, ["deposit-loading", "deposit-empty"]);
});
test("PR screen paint preserves Reception configured lead sources", async ({ browser }, info) => {
  await paint(browser, info, ["lead-source"]);
});
test("PR screen paint preserves accountant sales and quote choices", async ({ browser }, info) => {
  await paint(browser, info, ["sales-empty", "quote-choice"]);
});
test("PR screen paint keeps lead readers out of create actions", async ({ browser }, info) => {
  await paint(browser, info, ["lead-reader"]);
});
test("PR screen paint opens a marketplace-only non-vehicle reply", async ({ browser }, info) => {
  await paint(browser, info, ["marketplace-reply"]);
});
