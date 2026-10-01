import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * SCRUM-258 Gate B: the Bill of Sale print page in every economics state,
 * painted. EN and AR x 390px and 1280px (light), CASH-full and FINANCED in
 * dark at 1280px, and both again under print media at A4 width (794px).
 * Same method as `commission-notice.visual.spec.ts`: a vitest bridge renders
 * the REAL page with the REAL dictionaries (only data hooks mocked) and the
 * markup is styled with the app's compiled `globals.css`. The print page is a
 * standalone document (body gets `print-mode`), so it is NOT wrapped in the
 * dashboard shell. Limitations: Cairo/Inter not loaded, nothing interactive.
 *
 *   npx playwright test -c playwright.visual.config.ts bill-of-sale
 */
const ROOT = resolve(__dirname, "../..");
const RUN_STARTED_AT = Date.now();
const RUN_DIR = resolve(
  ROOT,
  "test-results/bill-of-sale-visual",
  `run-${new Date(RUN_STARTED_AT).toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
const FIXTURES = resolve(RUN_DIR, "fixtures");
const SHOTS = resolve(RUN_DIR, "shots");

const LOCALES = ["en", "ar"] as const;
type Locale = (typeof LOCALES)[number];
type Theme = "light" | "dark";

const STATES = [
  { name: "cash-full", printable: true },
  { name: "cash-consigned-direct", printable: true },
  { name: "financed", printable: true },
  { name: "financed-no-rate", printable: true },
  { name: "unavailable-default", printable: false },
  { name: "unavailable-not-completed", printable: false },
  { name: "load-failed", printable: false },
  { name: "loading", printable: false },
] as const;

type Variant = {
  state: (typeof STATES)[number];
  locale: Locale;
  theme: Theme;
  media: "screen" | "print";
  width: number;
  height: number;
  tag: string;
};

const VARIANTS: Variant[] = [];
for (const state of STATES) {
  for (const locale of LOCALES) {
    for (const width of [1280, 390]) {
      VARIANTS.push({ state, locale, theme: "light", media: "screen", width, height: width === 390 ? 844 : 900, tag: String(width) });
    }
  }
}
for (const state of STATES.filter((s) => s.name === "cash-full" || s.name === "financed")) {
  for (const locale of LOCALES) {
    VARIANTS.push({ state, locale, theme: "dark", media: "screen", width: 1280, height: 900, tag: "1280-dark" });
    VARIANTS.push({ state, locale, theme: "light", media: "print", width: 794, height: 1123, tag: "794-print" });
  }
}

let css = "";
const overflows: string[] = [];
const labels: Record<Locale, { print: string; back: string }> = { en: { print: "", back: "" }, ar: { print: "", back: "" } };
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(existsSync(RUN_DIR), `run directory already exists: ${RUN_DIR}`).toBe(false);
  mkdirSync(FIXTURES, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  execFileSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "components/sales/BillOfSaleVisualFixture.test.tsx"],
    {
      cwd: ROOT,
      env: { ...process.env, BILL_OF_SALE_VISUAL_FIXTURE: "1", BILL_OF_SALE_VISUAL_FIXTURE_DIR: FIXTURES },
      stdio: "inherit",
    },
  );
  for (const locale of LOCALES) {
    for (const state of STATES) {
      const file = resolve(FIXTURES, `${state.name}-${locale}.html`);
      expect(existsSync(file), `bridge did not write ${file}`).toBe(true);
      expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(RUN_STARTED_AT - 1_000);
    }
    labels[locale] = JSON.parse(readFileSync(resolve(FIXTURES, `labels-${locale}.json`), "utf8"));
    expect(labels[locale].print).toBeTruthy();
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

/** A standalone print document: `print-mode` on the body, no dashboard shell. */
function documentFor(v: Variant): string {
  const body = readFileSync(resolve(FIXTURES, `${v.state.name}-${v.locale}.html`), "utf8");
  const dir = v.locale === "ar" ? "rtl" : "ltr";
  return `<!doctype html>
<html dir="${dir}" lang="${v.locale}" class="${v.theme === "dark" ? "dark" : ""}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body class="print-mode ${v.locale === "ar" ? "font-cairo" : "font-inter"} antialiased">${body}</body></html>`;
}

async function paint(page: Page, v: Variant) {
  const file = resolve(RUN_DIR, `page-${v.state.name}-${v.locale}-${v.tag}.html`);
  writeFileSync(file, documentFor(v));
  await page.goto(`file:///${file.replace(/\\/g, "/")}`);
  await page.locator("#printable-area, .animate-spin").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

for (const v of VARIANTS) {
  test(`bill-of-sale · ${v.state.name} · ${v.locale} · ${v.tag}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      colorScheme: v.theme,
    });
    const page = await context.newPage();
    try {
      await page.emulateMedia({ media: v.media, colorScheme: v.theme });
      await paint(page, v);

      // dir matches the locale (the printable area carries it explicitly when the sale is loaded).
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe(
        v.locale === "ar" ? "rtl" : "ltr",
      );
      const area = page.locator("#printable-area");
      if ((await area.count()) > 0) {
        expect(await area.getAttribute("dir")).toBe(v.locale === "ar" ? "rtl" : "ltr");
      }

      // The print button lives in the screen-only header; it is hidden under print media.
      if (v.media === "screen") {
        const button = page.getByRole("button", { name: labels[v.locale].print });
        await expect(button).toBeVisible();
        if (v.state.printable) await expect(button).toBeEnabled();
        else await expect(button).toBeDisabled();
      }

      const bodyText = await page.evaluate(() => document.body.innerText);
      expect(bodyText, "APR must never appear on a Bill of Sale").not.toMatch(/\bAPR\b/i);

      const metrics = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const wide = Array.from(document.querySelectorAll<HTMLElement>("body *"))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > vw + 1 || r.left < -1);
          })
          .slice(0, 5)
          .map((el) => `${el.tagName}.${String(el.className).slice(0, 60)}@${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)}`);
        const scrolled = Array.from(document.querySelectorAll<HTMLElement>("body *"))
          .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
          .slice(0, 5)
          .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)} sw=${el.scrollWidth} cw=${el.clientWidth}`);
        const totals = Array.from(document.querySelectorAll<HTMLElement>("#printable-area table td.text-end"));
        const rows = totals.map((td) => {
          const th = td.parentElement?.querySelector("th");
          const a = td.getBoundingClientRect();
          const l = th?.getBoundingClientRect();
          return { amount: { l: a.left, r: a.right }, label: l ? { l: l.left, r: l.right } : null, text: td.innerText };
        });
        const last = totals[totals.length - 1];
        const lr = last?.getBoundingClientRect();
        return {
          docScroll: document.documentElement.scrollWidth - vw,
          wide,
          scrolled,
          totalRows: totals.length,
          rows,
          lastAmount: last ? { text: last.innerText, l: lr.left, r: lr.right, textAlign: getComputedStyle(last).textAlign } : null,
          docHeight: document.documentElement.scrollHeight,
        };
      });
      console.log(`METRICS ${v.state.name} ${v.locale} ${v.tag}: ${JSON.stringify(metrics)}`);
      // Shoot first so an overflow failure still leaves the picture to look at.
      await page.screenshot({ path: resolve(SHOTS, `${v.state.name}-${v.locale}-${v.tag}.png`), fullPage: true });
      // Totals geometry: the label starts at the reading edge, the figure sits in its own column at
      // the opposite edge, and the two never overlap or touch (the AR bug glued them together).
      for (const row of metrics.rows) {
        expect(row.label, `no label cell beside ${row.text}`).not.toBeNull();
        if (v.locale === "ar") expect(row.amount.r, `AR: "${row.text}" must lie left of its label`).toBeLessThanOrEqual(row.label!.l);
        else expect(row.amount.l, `EN: "${row.text}" must lie right of its label`).toBeGreaterThanOrEqual(row.label!.r);
      }
      // Recorded, not asserted here: a failing test would restart the worker and split the run
      // directory. The `overflow summary` test below fails the run with every offender listed.
      if (metrics.docScroll > 0 || metrics.wide.length > 0) {
        overflows.push(`${v.state.name} ${v.locale} ${v.tag}: docScroll=${metrics.docScroll} wide=${JSON.stringify(metrics.wide)} scrolled=${JSON.stringify(metrics.scrolled)}`);
      }
    } finally {
      await context.close();
    }
  });
}

test("bill-of-sale · overflow summary (no horizontal overflow in any shot)", () => {
  expect(overflows, `horizontal overflow in ${overflows.length} shot(s):\n${overflows.join("\n")}`).toEqual([]);
});
