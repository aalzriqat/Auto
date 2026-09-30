import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * SCRUM-390 (OR-17) Gate B: the commission settings page with the margin
 * notice and relabelled base, painted. EN and AR x light and dark x 390px and
 * 1280px. Same method as `fc-cheque.visual.spec.ts`: a vitest bridge renders
 * the REAL page with the REAL dictionaries (only data hooks mocked); it is
 * styled with the app's compiled `globals.css` inside the dashboard shell's
 * geometry. Limitations: Cairo/Inter not loaded, sidebar/top bar are empty
 * boxes, nothing is interactive.
 *
 *   npx playwright test -c playwright.visual.config.ts commission-notice
 */
const ROOT = resolve(__dirname, "../..");
const RUN_STARTED_AT = Date.now();
const RUN_DIR = resolve(
  ROOT,
  "test-results/commission-notice-visual",
  `run-${new Date(RUN_STARTED_AT).toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
const FIXTURES = resolve(RUN_DIR, "fixtures");
const SHOTS = resolve(RUN_DIR, "shots");

const LOCALES = ["en", "ar"] as const;
const THEMES = ["light", "dark"] as const;
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
] as const;

let css = "";
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(existsSync(RUN_DIR), `run directory already exists: ${RUN_DIR}`).toBe(false);
  mkdirSync(FIXTURES, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  execFileSync(
    process.execPath,
    [
      resolve(ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      "components/settings/CommissionNoticeVisualFixture.test.tsx",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, COMMISSION_NOTICE_VISUAL_FIXTURE: "1", COMMISSION_NOTICE_VISUAL_FIXTURE_DIR: FIXTURES },
      stdio: "inherit",
    },
  );
  for (const locale of LOCALES) {
    const file = resolve(FIXTURES, `commission-page-${locale}.html`);
    expect(existsSync(file), `bridge did not write ${file}`).toBe(true);
    expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(RUN_STARTED_AT - 1_000);
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

function documentFor(locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number]): string {
  const body = readFileSync(resolve(FIXTURES, `commission-page-${locale}.html`), "utf8");
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

async function paint(page: Page, locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number]) {
  const file = resolve(RUN_DIR, `page-${locale}-${theme}.html`);
  writeFileSync(file, documentFor(locale, theme));
  await page.goto(`file:///${file.replace(/\\/g, "/")}`);
  // Painted = the notice is in the DOM and the web fonts have settled.
  await page.locator('[role="alert"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`commission-notice · ${locale} · ${theme} · ${viewport.name}px`, async ({ browser }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme,
        });
        const page = await context.newPage();
        try {
          await paint(page, locale, theme);
          expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe(
            locale === "ar" ? "rtl" : "ltr",
          );

          const metrics = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>('[data-testid="shell-main"]')!;
            const alert = document.querySelector<HTMLElement>('[role="alert"]')!;
            const svg = alert.querySelector<SVGElement>("svg")!;
            const title = alert.querySelector<HTMLElement>("h5")!;
            const desc = alert.querySelector<HTMLElement>("h5 + div")!;
            const ar = alert.getBoundingClientRect();
            const sr = svg.getBoundingClientRect();
            const tr = title.getBoundingClientRect();
            const dr = desc.getBoundingClientRect();
            const cs = getComputedStyle(alert);
            const bgOf = (el: Element) => getComputedStyle(el).backgroundColor;
            const vw = document.documentElement.clientWidth;
            const wide = Array.from(document.querySelectorAll<HTMLElement>("body *"))
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && (r.right > vw + 1 || r.left < -1);
              })
              .slice(0, 5)
              .map((el) => `${el.tagName}.${String(el.className).slice(0, 60)}`);
            const clipped = Array.from(alert.querySelectorAll<HTMLElement>("*")).some(
              (el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible",
            );
            return {
              mainScroll: main.scrollWidth - main.clientWidth,
              docScroll: document.documentElement.scrollWidth - vw,
              wide,
              clipped,
              alert: { l: ar.left, r: ar.right, w: ar.width, h: ar.height },
              icon: { l: sr.left, r: sr.right, t: sr.top },
              title: { l: tr.left, r: tr.right, textAlign: getComputedStyle(title).textAlign },
              desc: { l: dr.left, r: dr.right, h: dr.height, textAlign: getComputedStyle(desc).textAlign, lineHeight: getComputedStyle(desc).lineHeight },
              iconOverlapsText: !(sr.right <= Math.min(tr.left, dr.left) + 0.5 || sr.left >= Math.max(tr.right, dr.right) - 0.5) && sr.bottom > tr.top && sr.top < dr.bottom,
              alertBg: cs.backgroundColor,
              alertBorder: cs.borderColor,
              alertColor: cs.color,
              mainBg: bgOf(main),
              shellBg: bgOf(document.querySelector('[data-testid="shell"]')!),
              role: alert.getAttribute("role"),
            };
          });
          console.log(`METRICS ${locale} ${theme} ${viewport.name}: ${JSON.stringify(metrics)}`);
          expect(metrics.mainScroll, `main scrolls sideways ${JSON.stringify(metrics.wide)}`).toBeLessThanOrEqual(0);
          expect(metrics.wide).toEqual([]);

          // Whole-page shot (scroll the shell's main to render all of it).
          const height = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>('[data-testid="shell-main"]')!;
            return main.scrollHeight + 80;
          });
          await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.min(height, 2600)) });
          // Wait for the resized viewport to lay out (two frames) instead of a fixed delay.
          await page.evaluate(
            () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
          );
          await page.screenshot({ path: resolve(SHOTS, `page-${locale}-${theme}-${viewport.name}.png`) });
          // Close-up of the notice.
          await page.locator('[role="alert"]').screenshot({ path: resolve(SHOTS, `notice-${locale}-${theme}-${viewport.name}.png`) });
        } finally {
          await context.close();
        }
      });
    }
  }
}
