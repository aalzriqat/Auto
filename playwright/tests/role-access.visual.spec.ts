import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type TestInfo } from "@playwright/test";
import { newContainedContext } from "../containedContext";
import { captureWithDiagnostics } from "../visual/browserCaptureDiagnostics";

// Actual component markup and compiled app CSS. No authentication, app shell,
// hydration or backend is claimed. Live role replays remain separate tests.
const ROOT = resolve(__dirname, "../..");
const STATES = ["denied-expenses", "deposit-loading", "deposit-empty", "lead-source", "sales-empty", "quote-choice", "lead-reader", "lead-reader-detail", "marketplace-reply", "lead-source-loading", "quote-status-loading", "marketplace-default"] as const;
type State = typeof STATES[number];
let fixtures = "", css = "";
test.beforeAll(async () => {
  // The fixture child has its own 120s deadline; allow CSS compilation and
  // inventory checks to finish within a separate, bounded hook deadline.
  test.setTimeout(180_000);
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
  "lead-reader-detail": { en: "Synthetic Buyer", ar: "Synthetic Buyer" },
  "marketplace-reply": { en: "Not available", ar: "غير متوفرة" },
  "lead-source-loading": { en: "Lead Source", ar: "مصدر العميل المحتمل" },
  "quote-status-loading": { en: "Loading customer statuses…", ar: "جارٍ تحميل حالات العميل…" },
  "marketplace-default": { en: "I have something similar", ar: "عندي سيارة مشابهة" },
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
          if (state === "lead-reader-detail") {
            await expect(page.getByRole("heading", { name: "Synthetic Buyer", exact: true })).toBeVisible();
            await expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(0);
          }
          if (state === "marketplace-reply") {
            await expect(page.getByRole("button", { name: locale === "en" ? "Send reply" : "إرسال الرد", exact: true })).toBeEnabled();
            await expect(page.getByRole("combobox")).toHaveCount(1);
          }
          if (state === "lead-source-loading") {
            await expect(page.getByRole("listbox")).toBeVisible();
            await expect(page.getByRole("option")).toHaveCount(0);
            // Radix hides the surrounding dialog from assistive technology
            // while its select portal owns focus; the dialog is still painted.
            await expect(page.getByRole("dialog", { includeHidden: true })).toBeVisible();
          }
          if (state === "quote-status-loading") {
            await expect(page.getByText(locale === "en" ? "No customer statuses configured yet — set them up in Finance Settings." : "لم يتم تكوين حالات العميل بعد — قم بإعدادها في إعدادات التمويل.", { exact: true })).toHaveCount(0);
          }
          if (state === "marketplace-default") {
            await expect(page.getByRole("combobox").first()).toHaveText(COPY[state][locale]);
          }
          if (state === "lead-source") {
            await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
            await expect(page.getByRole("combobox", { name: locale === "en" ? "Lead Source" : "مصدر العميل المحتمل" })).toHaveText("Synthetic configured channel");
            await expect(page.getByRole("listbox")).toHaveCount(0);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${state} fits ${width}px`).toBe(true);
          await captureWithDiagnostics(page, {
            path: info.outputPath(`role-access-${state}-${locale}-${width}.png`), fullPage: true, animations: "disabled",
          }, () => info.outputPath(`role-access-${state}-${locale}-${width}-capture-failure.json`));
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
test("PR screen paint does not invent lead choices while loading", async ({ browser }, info) => {
  await paint(browser, info, ["lead-source-loading"]);
});
test("PR screen paint distinguishes quote status loading from empty", async ({ browser }, info) => {
  await paint(browser, info, ["quote-status-loading"]);
});
test("PR screen paint gives inventory-free responders a non-vehicle default", async ({ browser }, info) => {
  await paint(browser, info, ["marketplace-default"]);
});

test("PR screen paint opens a lead detail for a reader without edit pickers", async ({ browser }, info) => {
  await paint(browser, info, ["lead-reader-detail"]);
});
