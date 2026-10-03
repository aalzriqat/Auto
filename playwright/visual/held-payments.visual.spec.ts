import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";

/**
 * SCRUM-571 S1 — the held-payments section and the Expire-link confirmation,
 * painted. EN and AR x 390px and 1280px.
 *
 * jsdom proves the strings and the wiring; it cannot prove the seven-column
 * table scrolls inside its frame at 390px instead of pushing the page sideways,
 * that the Resolve and Expire dialogs fit a phone, or that the section mirrors
 * under RTL. The markup comes from `HeldPaymentsVisualFixture.test.tsx` (the real
 * `PaymentLinksPanel`, real dictionaries) and is painted under the app's own
 * compiled `globals.css`.
 *
 * Asserted (observable, oracle-independent): the hand-written EN/AR literals
 * below paint for the title and the state under test; the page never scrolls
 * sideways; the direction computed is the one asked for. A screenshot per
 * combination is written to `test-results/held-payments-visual/` for a human to
 * judge the rest.
 *
 * Limits: Next fonts are not loaded (system fallbacks paint), the app shell is
 * not reproduced (the panel sits in a bare padded container, dialogs in their
 * own fixed overlay), and the page is static.
 */

const ROOT = resolve(__dirname, "../..");
const OUT_DIR = resolve(ROOT, "test-results/held-payments-visual");
const FIXTURES = resolve(OUT_DIR, "fixtures");

const LOCALES = ["en", "ar"] as const;
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
] as const;

/** Hand-written literals (from lib/i18n/domains/common.ts): independent of the render. */
const LITERAL = {
  title: { en: "Payments held for review", ar: "دفعات محتجزة للمراجعة" },
  empty: { en: "No payments are being held for review.", ar: "لا توجد دفعات محتجزة للمراجعة." },
  error: {
    en: "Held payments could not be loaded. Refresh the page to try again.",
    ar: "تعذّر تحميل الدفعات المحتجزة. حدّث الصفحة وحاول مجدداً.",
  },
  resolveTitle: { en: "Resolve this held payment?", ar: "هل تريد إغلاق مراجعة هذه الدفعة المحتجزة؟" },
  expireTitle: { en: "Expire this payment link?", ar: "هل تريد إنهاء صلاحية رابط الدفع هذا؟" },
  rawMinor: { en: "987654 XYZ (smallest unit)", ar: "987654 XYZ (أصغر وحدة)" },
  reasonUnknown: { en: "Unknown payment reference", ar: "مرجع دفع غير معروف" },
} as const;

type Literal = keyof typeof LITERAL;

const STATES: ReadonlyArray<{ name: string; shows: readonly Literal[]; absent?: readonly Literal[] }> = [
  { name: "held-rows", shows: ["title", "rawMinor", "reasonUnknown"], absent: ["empty", "error"] },
  { name: "held-empty", shows: ["title", "empty"], absent: ["error"] },
  { name: "held-error", shows: ["title", "error"], absent: ["empty"] },
  { name: "resolve-dialog", shows: ["resolveTitle"] },
  { name: "expire-dialog", shows: ["expireTitle"] },
];

let css = "";

test.beforeAll(async () => {
  mkdirSync(FIXTURES, { recursive: true });
  execFileSync(
    process.execPath,
    [
      resolve(ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      "components/accounting/collections/HeldPaymentsVisualFixture.test.tsx",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, HELD_PAYMENTS_VISUAL_FIXTURE: "1", HELD_PAYMENTS_VISUAL_FIXTURE_DIR: FIXTURES },
      stdio: "inherit",
    },
  );
  const here = createRequire(__filename);
  const tailwindEntry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(tailwindEntry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(tailwindEntry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input })).css;
  expect(css).toContain("--background");
});

function documentFor(name: string, locale: (typeof LOCALES)[number]): string {
  const file = resolve(FIXTURES, `${name}-${locale}.html`);
  expect(existsSync(file), `bridge did not write ${file}`).toBe(true);
  const body = readFileSync(file, "utf8");
  const dir = locale === "ar" ? "rtl" : "ltr";
  return `<!doctype html>
<html dir="${dir}" lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body class="${locale === "ar" ? "font-cairo" : "font-inter"} antialiased"><main class="p-3 sm:p-4 md:p-6" data-testid="surface">${body}</main></body></html>`;
}

for (const locale of LOCALES) {
  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      test(`${state.name} · ${locale} · ${viewport.name}px`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        const page = await context.newPage();
        try {
          const file = resolve(FIXTURES, `page-${state.name}-${locale}-${viewport.name}.html`);
          writeFileSync(file, documentFor(state.name, locale));
          await page.goto(`file:///${file.replace(/\\/g, "/")}`);

          const dir = locale === "ar" ? "rtl" : "ltr";
          expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(dir);
          expect(await page.evaluate(() => document.documentElement.dir)).toBe(dir);

          for (const key of state.shows) {
            await expect(page.getByText(LITERAL[key][locale], { exact: true }).first(), `${key} paints`).toBeVisible();
          }
          for (const key of state.absent ?? []) {
            await expect(page.getByText(LITERAL[key][locale], { exact: true }), `${key} is absent`).toHaveCount(0);
          }
          // Let the dialog's enter animation finish before measuring or shooting.
          await page.waitForTimeout(500);

          // Nothing paints sideways: the document does not scroll horizontally.
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, "sideways scroll").toBeLessThanOrEqual(0);

          await page.screenshot({
            path: resolve(OUT_DIR, `shot-${state.name}-${locale}-${viewport.name}.png`),
            fullPage: true,
          });
        } finally {
          await context.close();
        }
      });
    }
  }
}
