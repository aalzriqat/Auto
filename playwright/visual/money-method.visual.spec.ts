import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";

/**
 * SCRUM-469 — the money-method surfaces, painted. EN and AR x 390px and 1280px.
 *
 * Every refund / disbursement picker starts EMPTY, says why the action is
 * refused, and only then shows the chosen state. jsdom proves the strings and
 * the disabled flag; it cannot prove the placeholder is legible, that the
 * required-method message wraps inside a 390px card, or that `HeldDepositActions`
 * mirrors under RTL. The markup comes from `MoneyMethodVisualFixture.test.tsx`
 * (real components, real dictionaries, real Radix select) and is painted under
 * the app's own compiled `globals.css`.
 *
 * Asserted (observable, oracle-independent): the empty state paints the
 * hand-written required-method literal, the chosen state does not; the page
 * never scrolls sideways; the direction computed is the one asked for; and the
 * placeholder is painted in the trigger. A screenshot per combination is written
 * for a human to judge the rest.
 *
 * Limits: Next fonts are not loaded (system fallbacks paint), the app shell is
 * not reproduced (each surface sits in a bare padded container, dialogs in their
 * own fixed overlay), and the page is static.
 */

const ROOT = resolve(__dirname, "../..");
const RUN_DIR = resolve(ROOT, "test-results/money-method-visual", `run-${Date.now()}-${process.pid}`);
const FIXTURES = resolve(RUN_DIR, "fixtures");

const LOCALES = ["en", "ar"] as const;
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
] as const;

/** Hand-written literals: an oracle independent of the dictionaries the render used. */
const LITERAL = {
  refundRequired: {
    en: "Choose how the refund is being paid (cash, bank transfer, card or cheque) to continue.",
    ar: "اختر طريقة رد المبلغ (نقداً أو تحويل بنكي أو بطاقة أو شيك) للمتابعة.",
  },
  moneyRequired: {
    en: "Choose the payment method the money actually moved by to continue.",
    ar: "اختر طريقة الدفع التي تحرّك بها المبلغ فعلاً للمتابعة.",
  },
  refundPlaceholder: { en: "How is it being refunded?", ar: "كيف سيتم الرد؟" },
} as const;

const SURFACES: ReadonlyArray<{
  name: string;
  required: keyof typeof LITERAL | null;
  placeholder: keyof typeof LITERAL | null;
}> = [
  { name: "held", required: "refundRequired", placeholder: "refundPlaceholder" },
  { name: "stopped", required: "refundRequired", placeholder: "refundPlaceholder" },
  { name: "approval", required: "refundRequired", placeholder: "refundPlaceholder" },
  { name: "custody", required: "moneyRequired", placeholder: null },
];

let css = "";

test.beforeAll(async () => {
  mkdirSync(FIXTURES, { recursive: true });
  execFileSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "components/payments/MoneyMethodVisualFixture.test.tsx"],
    {
      cwd: ROOT,
      env: { ...process.env, MONEY_METHOD_VISUAL_FIXTURE: "1", MONEY_METHOD_VISUAL_FIXTURE_DIR: FIXTURES },
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
    for (const surface of SURFACES) {
      for (const state of ["empty", "chosen"] as const) {
        test(`${surface.name} · ${state} · ${locale} · ${viewport.name}px`, async ({ browser }) => {
          const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
          const page = await context.newPage();
          try {
            const file = resolve(RUN_DIR, `page-${surface.name}-${state}-${locale}-${viewport.name}.html`);
            writeFileSync(file, documentFor(`${surface.name}-${state}`, locale));
            await page.goto(`file:///${file.replace(/\\/g, "/")}`);

            const dir = locale === "ar" ? "rtl" : "ltr";
            expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(dir);
            // Nothing paints sideways: the document does not scroll horizontally.
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, "sideways scroll").toBeLessThanOrEqual(0);

            if (surface.required) {
              const literal = LITERAL[surface.required][locale];
              const message = page.getByText(literal, { exact: true });
              if (state === "empty") {
                await expect(message).toBeVisible();
                const box = await message.boundingBox();
                expect(box!.x).toBeGreaterThanOrEqual(0);
                expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
              } else {
                await expect(message).toHaveCount(0);
              }
            }
            if (surface.placeholder && state === "empty") {
              await expect(page.getByText(LITERAL[surface.placeholder][locale], { exact: true }).first()).toBeVisible();
            }
            await page.screenshot({
              path: resolve(RUN_DIR, `shot-${surface.name}-${state}-${locale}-${viewport.name}.png`),
              fullPage: true,
            });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
}

test("custody server refusal state is painted in both languages", async ({ browser }) => {
  for (const locale of LOCALES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      try {
        const file = resolve(RUN_DIR, `page-custody-error-${locale}-${viewport.name}.html`);
        writeFileSync(file, documentFor("custody-error", locale));
        await page.goto(`file:///${file.replace(/\\/g, "/")}`);
        await expect(page.getByText(LITERAL.moneyRequired[locale], { exact: true }).first()).toBeVisible();
        await page.screenshot({
          path: resolve(RUN_DIR, `shot-custody-error-${locale}-${viewport.name}.png`),
          fullPage: true,
        });
      } finally {
        await context.close();
      }
    }
  }
});
