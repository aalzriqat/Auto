import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * SCRUM-694 Gate B: the Deals list, painted. EN and AR x light and dark x
 * 390 / 768 / 1280 / 1440px, the queue and the "All deals" register.
 *
 * Same method as `commission-notice.visual.spec.ts`: a vitest bridge renders
 * the REAL view with the REAL dictionaries; it is styled with the app's
 * compiled `globals.css` inside the dashboard shell's geometry (16rem sidebar
 * from `md`, `main` as the scroll container with its responsive padding).
 *
 * What it asserts, because production showed the opposite at 723px (every
 * cell wrapping to 2-4 lines, a Latin month in an Arabic list):
 *   - `main` never scrolls sideways and nothing paints outside the viewport;
 *   - no row of the list is taller than two text lines' worth plus the
 *     vehicle mark (a wrapped cell makes a row ~100px);
 *   - every money run, status pill and date stays on one line;
 *   - an Arabic list paints no English month name.
 * Limitations: Cairo/Inter not loaded, sidebar/top bar are empty boxes,
 * nothing is interactive (the "All deals" view is clicked in the bridge).
 *
 *   npx playwright test -c playwright.visual.config.ts deals-list
 */
const ROOT = resolve(__dirname, "../..");
const RUN_STARTED_AT = Date.now();
const RUN_DIR = resolve(
  ROOT,
  "test-results/deals-list-visual",
  `run-${new Date(RUN_STARTED_AT).toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
const FIXTURES = resolve(RUN_DIR, "fixtures");
const SHOTS = resolve(RUN_DIR, "shots");

const LOCALES = ["en", "ar"] as const;
const THEMES = ["light", "dark"] as const;
const VIEWS = ["needs", "all"] as const;
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 900 },
  { name: "1440", width: 1440, height: 900 },
] as const;

/** Two text lines + padding, or the 40px vehicle mark + padding — whichever is taller, with slack. */
const MAX_ROW_HEIGHT = 96;
/** A phone card: name, vehicle, reason, owner/date — four lines and padding. */
const MAX_CARD_HEIGHT = 136;
const LATIN_MONTH = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

let css = "";
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(existsSync(RUN_DIR), `run directory already exists: ${RUN_DIR}`).toBe(false);
  mkdirSync(FIXTURES, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  execFileSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "components/deals/DealsListVisualFixture.test.tsx"],
    {
      cwd: ROOT,
      env: { ...process.env, DEALS_LIST_VISUAL_FIXTURE: "1", DEALS_LIST_VISUAL_FIXTURE_DIR: FIXTURES },
      stdio: "inherit",
    },
  );
  for (const locale of LOCALES) {
    for (const view of VIEWS) {
      const file = resolve(FIXTURES, `deals-${view}-${locale}.html`);
      expect(existsSync(file), `bridge did not write ${file}`).toBe(true);
      expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(RUN_STARTED_AT - 1_000);
    }
  }
  const here = createRequire(__filename);
  const tailwindEntry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(tailwindEntry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(tailwindEntry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  const result = await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input });
  css = result.css;
  expect(css).toContain("--background");
});

function documentFor(
  locale: (typeof LOCALES)[number],
  theme: (typeof THEMES)[number],
  view: (typeof VIEWS)[number],
): string {
  const body = readFileSync(resolve(FIXTURES, `deals-${view}-${locale}.html`), "utf8");
  const dir = locale === "ar" ? "rtl" : "ltr";
  return `<!doctype html>
<html dir="${dir}" lang="${locale}" class="${theme === "dark" ? "dark" : ""}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body class="${locale === "ar" ? "font-cairo" : "font-inter"} antialiased">
<div class="flex h-screen w-full overflow-hidden bg-slate-50 dark:bg-zinc-950/40" data-testid="shell">
  <aside class="hidden md:flex flex-col w-64 border-e border-slate-200/50 bg-white shadow-sm shrink-0"></aside>
  <div class="flex flex-col flex-1 w-full overflow-hidden">
    <header class="sticky top-0 z-30 w-full border-b border-slate-200/50 bg-white/95 backdrop-blur shadow-sm shrink-0"><div class="h-14 md:h-16 flex w-full items-center justify-between gap-2 px-3 md:px-6"></div></header>
    <main class="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 lg:p-8 relative pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-8" data-testid="shell-main">${body}</main>
  </div>
</div>
</body></html>`;
}

async function paint(
  page: Page,
  locale: (typeof LOCALES)[number],
  theme: (typeof THEMES)[number],
  view: (typeof VIEWS)[number],
) {
  const file = resolve(RUN_DIR, `page-${view}-${locale}-${theme}.html`);
  writeFileSync(file, documentFor(locale, theme, view));
  await page.goto(`file:///${file.replace(/\\/g, "/")}`);
  await page.locator('[role="tablist"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

for (const view of VIEWS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        test(`deals-list · ${view} · ${locale} · ${theme} · ${viewport.name}px`, async ({ browser }) => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: theme,
          });
          const page = await context.newPage();
          try {
            await paint(page, locale, theme, view);
            expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe(
              locale === "ar" ? "rtl" : "ltr",
            );

            const metrics = await page.evaluate(() => {
              const main = document.querySelector<HTMLElement>('[data-testid="shell-main"]')!;
              const vw = document.documentElement.clientWidth;
              const isShown = (el: Element) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              };
              // Text cut by a `truncate` ancestor overflows its own box by design;
              // only content that actually PAINTS outside the viewport counts.
              const clippedByAncestor = (el: HTMLElement) => {
                for (let p = el.parentElement; p && p !== main; p = p.parentElement) {
                  if (getComputedStyle(p).overflowX !== "visible") {
                    const r = p.getBoundingClientRect();
                    if (r.left >= -1 && r.right <= vw + 1) return true;
                  }
                }
                return false;
              };
              const wide = Array.from(document.querySelectorAll<HTMLElement>("body *"))
                .filter((el) => {
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && (r.right > vw + 1 || r.left < -1) && !clippedByAncestor(el);
                })
                .slice(0, 5)
                .map((el) => `${el.tagName}.${String(el.className).slice(0, 60)}`);
              // The painted entries: table body rows from `sm`, cards below it.
              const rowsShown = Array.from(document.querySelectorAll<HTMLElement>("tbody tr")).filter(isShown);
              const cardsShown = Array.from(
                document.querySelectorAll<HTMLElement>('[data-testid="deals-cards"] > li'),
              ).filter(isShown);
              const tallest = (els: HTMLElement[]) => Math.max(0, ...els.map((el) => el.getBoundingClientRect().height));
              // Runs that must never wrap: money and dates (inline, so a wrap is a
              // second line box) and status pills (a wrap doubles their height).
              // Bidi splits one line of mixed Arabic and digits into several
              // rects at the same height; a wrap is rects on different lines.
              const lineCount = (el: HTMLElement) =>
                new Set(Array.from(el.getClientRects()).map((r) => Math.round(r.top / 4))).size;
              const list = document.querySelector<HTMLElement>('[data-testid="deals-cards"]')!.parentElement!;
              const wrapped = [
                ...Array.from(list.querySelectorAll<HTMLElement>("bdi")).filter(
                  (el) => isShown(el) && lineCount(el) > 1 && !el.closest(".truncate"),
                ),
                ...Array.from(list.querySelectorAll<HTMLElement>("td .whitespace-nowrap, li .whitespace-nowrap")).filter(
                  (el) => isShown(el) && el.getBoundingClientRect().height > 30,
                ),
              ]
                .slice(0, 5)
                .map((el) => el.textContent);
              // The table's own scroll box: a column clipped inside it never
              // reaches the viewport, so `wide` cannot see it.
              const tableBox = document.querySelector<HTMLElement>("table")?.parentElement;
              const tableScroll =
                tableBox && isShown(tableBox) ? tableBox.scrollWidth - tableBox.clientWidth : 0;
              return {
                mainScroll: main.scrollWidth - main.clientWidth,
                tableScroll,
                wide,
                entries: rowsShown.length + cardsShown.length,
                tallestRow: tallest(rowsShown),
                tallestCard: tallest(cardsShown),
                wrapped,
                text: main.innerText,
              };
            });
            console.log(
              `METRICS ${view} ${locale} ${theme} ${viewport.name}: ${JSON.stringify({ ...metrics, text: undefined })}`,
            );
            expect(metrics.mainScroll, `main scrolls sideways ${JSON.stringify(metrics.wide)}`).toBeLessThanOrEqual(0);
            expect(metrics.wide).toEqual([]);
            expect(metrics.tableScroll, "the table scrolls inside its own box").toBeLessThanOrEqual(1);
            expect(metrics.entries).toBeGreaterThan(0);
            expect(metrics.tallestRow, "a deal row wrapped").toBeLessThanOrEqual(MAX_ROW_HEIGHT);
            expect(metrics.tallestCard, "a deal card grew past its four lines").toBeLessThanOrEqual(MAX_CARD_HEIGHT);
            expect(metrics.wrapped, "a one-line run wrapped").toEqual([]);
            if (locale === "ar") expect(metrics.text).not.toMatch(LATIN_MONTH);

            const height = await page.evaluate(
              () => document.querySelector<HTMLElement>('[data-testid="shell-main"]')!.scrollHeight + 80,
            );
            await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.min(height, 2600)) });
            await page.evaluate(
              () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
            );
            await page.screenshot({ path: resolve(SHOTS, `deals-${view}-${locale}-${theme}-${viewport.name}.png`) });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
}
