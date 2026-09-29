import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * SCRUM-447 Gate B: the finance-company cheque lineage UI, painted.
 * EN and AR x light and dark x 390px and 1280px, for
 *   - the FcChequePanel in every state (unattested, unattested read-only,
 *     attested/correctable, re-registrable) and its two dialogs,
 *   - the Collections cheques table with FC rows beside an ordinary row,
 *   - the SaleDialog on a financed sale (Cancel withheld, deal link) and on a
 *     cash sale (Cancel still offered).
 *
 * Same method as `deal-cockpit.visual.spec.ts`: a vitest bridge renders the
 * REAL components with the REAL dictionaries to markup, and it is styled here
 * with the app's own compiled `globals.css` inside the dashboard shell's
 * geometry. Limitations, stated: Cairo/Inter faces are not loaded (system
 * fallbacks paint the text), the sidebar and top bar are empty boxes of the
 * production size, and nothing here is interactive beyond what the bridge
 * opened. The React Native mobile screen is NOT rendered by this gate.
 *
 *   npx playwright test -c playwright.visual.config.ts fc-cheque
 */
const ROOT = resolve(__dirname, "../..");
const RUN_STARTED_AT = Date.now();
const RUN_DIR = resolve(
  ROOT,
  "test-results/fc-cheque-visual",
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
const SCENARIOS = [
  "panel-unattested",
  "panel-unattested-readonly",
  "panel-attested",
  "panel-reregister",
  "panel-none",
  "attest-dialog",
  "correct-dialog",
  "collections",
  "saledialog-financed",
  "saledialog-cash",
] as const;
/** Scenarios whose surface is a modal: it, not `main`, is what must fit the viewport. */
const MODALS = new Set<string>(["attest-dialog", "correct-dialog", "saledialog-financed", "saledialog-cash"]);
const TOUCH_TARGET_PX = 44;

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
      "components/applications/cockpit/FcChequeVisualFixture.test.tsx",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, FC_CHEQUE_VISUAL_FIXTURE: "1", FC_CHEQUE_VISUAL_FIXTURE_DIR: FIXTURES },
      stdio: "inherit",
    },
  );
  for (const locale of LOCALES) {
    for (const scenario of SCENARIOS) {
      const file = resolve(FIXTURES, `fc-${scenario}-${locale}.html`);
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

function documentFor(locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number], scenario: string): string {
  const body = readFileSync(resolve(FIXTURES, `fc-${scenario}-${locale}.html`), "utf8");
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

async function paint(page: Page, locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number], scenario: string) {
  const file = resolve(RUN_DIR, `page-${scenario}-${locale}-${theme}.html`);
  writeFileSync(file, documentFor(locale, theme, scenario));
  await page.goto(`file:///${file.replace(/\\/g, "/")}`);
  // The dialog's open animation must have finished before it is judged.
  await page.waitForTimeout(450);
}

for (const scenario of SCENARIOS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        test(`${scenario} · ${locale} · ${theme} · ${viewport.name}px`, async ({ browser }) => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: theme,
          });
          const page = await context.newPage();
          try {
            await paint(page, locale, theme, scenario);
            expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe(
              locale === "ar" ? "rtl" : "ltr",
            );

            // Nothing scrolls sideways: `main` for page surfaces, the viewport for modals.
            const overflow = await page.evaluate(() => {
              const main = document.querySelector<HTMLElement>('[data-testid="shell-main"]')!;
              const vw = document.documentElement.clientWidth;
              const wide = Array.from(document.querySelectorAll<HTMLElement>("body *"))
                .filter((el) => {
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && (r.right > vw + 1 || r.left < -1) && !el.closest("[data-scrollable]");
                })
                .slice(0, 5)
                .map((el) => `${el.tagName}.${String(el.className).slice(0, 60)}`);
              return { mainScroll: main.scrollWidth - main.clientWidth, docScroll: document.documentElement.scrollWidth - vw, wide };
            });
            // The Collections page's own seven-tab strip is wider than a phone
            // (present on origin/main, untouched by SCRUM-447): it is reported, not
            // asserted, so it cannot mask what THIS change adds. The cheques table
            // sits in its own `overflow-x-auto` wrapper and is judged by screenshot.
            if (scenario === "collections") console.log(`PAGE-SCROLL collections ${locale} ${theme} ${viewport.name}: ${overflow.mainScroll}`);
            else expect(overflow.mainScroll, `main scrolls sideways ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(0);
            if (MODALS.has(scenario)) {
              expect(overflow.wide, `modal paints outside the viewport ${JSON.stringify(overflow)}`).toEqual([]);
            }

            // Touch targets (mobile only): every visible control of the surface.
            if (viewport.width < 768) {
              const small = await page.evaluate((min) => {
                const scope = document.querySelector('[role="dialog"]') ?? document.querySelector('[data-testid="shell-main"]')!;
                return Array.from(scope.querySelectorAll<HTMLElement>("button, a[href], [role=tab], input, textarea, [role=combobox]"))
                  .filter((el) => el.getBoundingClientRect().width > 0)
                  .map((el) => ({ name: (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
                  .filter((b) => b.h < min);
              }, TOUCH_TARGET_PX);
              test.info().annotations.push({ type: "small-targets", description: JSON.stringify(small) });
              console.log(`TARGETS ${scenario} ${locale} ${theme} 390: ${JSON.stringify(small)}`);
            }

            // Page surfaces are cropped to their content so the pixels a reviewer looks
            // at are the surface, not an empty shell; modals are shown whole.
            const contentBottom = MODALS.has(scenario)
              ? viewport.height
              : await page.evaluate(() => {
                  const main = document.querySelector<HTMLElement>('[data-testid="shell-main"]')!;
                  const last = main.lastElementChild as HTMLElement | null;
                  return Math.ceil((last?.getBoundingClientRect().bottom ?? 120) + 24);
                });
            await page.screenshot({
              path: resolve(SHOTS, `${scenario}-${locale}-${theme}-${viewport.name}.png`),
              clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, Math.max(contentBottom, 140)) },
            });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
}
