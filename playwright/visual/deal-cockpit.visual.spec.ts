import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * The deal cockpit, painted. EN and AR × light and dark × 390px and 1280px.
 *
 * `DealCockpitView.test.tsx` renders into jsdom, which applies no stylesheet:
 * it can prove the Arabic strings and the `dir` attribute are there, and it
 * cannot prove a single pixel — not that the `.dark` tokens took, not that a
 * logical margin mirrored, not that a 390px phone has no sideways scroll. The
 * full E2E suite can, but it needs a built app, two Clerk identities and a
 * provisioned deal. This gate is the cheap middle: the SAME server-shaped
 * fixture, rendered by React to markup through a vitest bridge, under the
 * app's OWN compiled `globals.css`, inside the same `<main>` padding the
 * dashboard shell gives the screen — looked at in a real engine.
 *
 * What it asserts is deliberately narrow and deliberately observable:
 *   - the page does not scroll sideways at 390px or 1280px;
 *   - the header, the headline figure and the stage rail are painted on
 *     screen;
 *   - the theme actually took: the body background is the `--background`
 *     token of the theme asked for, and light and dark differ;
 *   - the direction actually took: `direction: rtl` is computed for Arabic,
 *     and the back arrow's `rtl:rotate-180` mirrored it.
 * A screenshot of every combination is written beside the run for a human to
 * judge the rest — hierarchy, rhythm, whether it reads as AutoFlow.
 *
 * Limitations, stated rather than hidden: the Next `font-cairo` / `font-inter`
 * faces are not loaded (system fallbacks paint the text), the page is static
 * (no queries, no dialogs, no interaction), and the fixture is one financed
 * deal. Everything real-data or interactive stays with the E2E suite.
 */

const ROOT = resolve(__dirname, "../..");
const OUT = resolve(ROOT, "test-results/deal-cockpit-visual");
const FIXTURES = resolve(OUT, "fixtures");

const LOCALES = ["en", "ar"] as const;
const THEMES = ["light", "dark"] as const;
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
] as const;

let css = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // 1. The markup, from the vitest bridge. Spawned here so one command runs
  //    the whole gate; the bridge is skipped in the ordinary suite.
  execFileSync(
    process.execPath,
    [
      resolve(ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      "components/applications/cockpit/DealCockpitVisualFixture.test.tsx",
    ],
    { cwd: ROOT, env: { ...process.env, DEAL_COCKPIT_VISUAL_FIXTURE: "1" }, stdio: "inherit" },
  );
  for (const locale of LOCALES) {
    expect(existsSync(resolve(FIXTURES, `deal-cockpit-${locale}.html`))).toBe(true);
  }

  // 2. The stylesheet, compiled exactly as the app compiles it: PostCSS with
  //    `@tailwindcss/postcss` over `app/globals.css`, so the tokens, the
  //    `dark` custom variant and the utilities are the production ones.
  // `postcss` is not a root dependency under pnpm's strict layout; it is
  // resolved from where `@tailwindcss/postcss` — which IS one — finds it, so
  // the gate compiles with exactly the PostCSS the app's build uses.
  const here = createRequire(__filename);
  const tailwindEntry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(tailwindEntry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(tailwindEntry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  const result = await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), {
    from: input,
  });
  css = result.css;
  expect(css).toContain("--background");
  mkdirSync(OUT, { recursive: true });
});

function documentFor(locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number]): string {
  const body = readFileSync(resolve(FIXTURES, `deal-cockpit-${locale}.html`), "utf8");
  const dir = locale === "ar" ? "rtl" : "ltr";
  // `<html dir lang class>` and `<body class>` as `app/layout.tsx` and the
  // LanguageProvider set them; `<main>` as `app/(dashboard)/[orgId]/layout.tsx`
  // pads it, because the sticky header's negative margins are sized to
  // exactly that padding.
  return `<!doctype html>
<html dir="${dir}" lang="${locale}" class="${theme === "dark" ? "dark" : ""}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body class="${locale === "ar" ? "font-cairo" : "font-inter"} antialiased bg-background text-foreground">
<main class="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 lg:p-8 relative">${body}</main>
<div id="probe" style="background: var(--background); position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none"></div>
</body></html>`;
}

async function paint(page: Page, locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number]) {
  const file = resolve(OUT, `page-${locale}-${theme}.html`);
  writeFileSync(file, documentFor(locale, theme));
  await page.goto(`file:///${file.replace(/\\/g, "/")}`);
  await expect(page.getByTestId("deal-header")).toBeVisible();
}

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`${locale} · ${theme} · ${viewport.name}px: paints on-screen, in theme, in direction, without sideways scroll`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme,
        });
        const page = await context.newPage();
        try {
          await paint(page, locale, theme);

          // Direction took — computed, not read back off the attribute.
          const header = page.getByTestId("deal-header");
          expect(await header.evaluate((el) => getComputedStyle(el).direction)).toBe(
            locale === "ar" ? "rtl" : "ltr",
          );
          // The back arrow mirrors under RTL (`rtl:rotate-180`), and only
          // there. Tailwind v4 emits the standalone `rotate` property, not a
          // `transform` matrix — the first run of this gate asserted the wrong
          // property and reported a mirrored arrow as unmirrored.
          const arrow = page.getByRole("link", { name: /.+/ }).first().locator("svg");
          const rotate = await arrow.evaluate((el) => getComputedStyle(el).rotate);
          expect(rotate).toBe(locale === "ar" ? "180deg" : "none");

          // Theme took — the body paints the token the theme defines, and
          // the token is not the same colour in both themes.
          const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
          const tokenBg = await page.evaluate(
            () => getComputedStyle(document.getElementById("probe")!).backgroundColor,
          );
          expect(bodyBg).toBe(tokenBg);
          expect(bodyBg).not.toBe("rgba(0, 0, 0, 0)");
          const isDarkPaint = await page.evaluate(() => {
            const [r, g, b] = getComputedStyle(document.body)
              .backgroundColor.match(/\d+/g)!
              .map(Number);
            return (r + g + b) / 3 < 128;
          });
          expect(isDarkPaint).toBe(theme === "dark");

          // The sticky header sits IN the flow at scroll 0 and does not cover
          // the essentials row under it (its negative margins are sized to the
          // shell padding; one step wrong and it overlaps or overflows).
          const headerBox = await header.boundingBox();
          const essentialsBox = await page.getByRole("definition").first().locator("..").locator("..").boundingBox();
          expect(headerBox).not.toBeNull();
          expect(essentialsBox).not.toBeNull();
          expect(headerBox!.y).toBeGreaterThanOrEqual(0);
          expect(
            headerBox!.y + headerBox!.height,
            `header ${JSON.stringify(headerBox)} covers essentials ${JSON.stringify(essentialsBox)}`,
          ).toBeLessThanOrEqual(essentialsBox!.y + 0.5);

          // Painted on screen: header, headline figure, stage rail.
          await expect(page.locator(".text-3xl").first()).toBeVisible();
          await expect(page.getByTestId("deal-stage-rail")).toBeVisible();
          const headline = await page.locator(".text-3xl").first().boundingBox();
          expect(headline).not.toBeNull();
          expect(headline!.x).toBeGreaterThanOrEqual(0);
          expect(headline!.x + headline!.width).toBeLessThanOrEqual(viewport.width);

          // No sideways scroll. A horizontal scrollbar on a phone is how a
          // figure ends up off screen entirely.
          const overflow = await page.evaluate(() => {
            const clientWidth = document.documentElement.clientWidth;
            // Named so a failure says WHICH block leaked, not just that one did.
            const culprits = Array.from(document.querySelectorAll<HTMLElement>("body *"))
              .map((el) => ({ el, rect: el.getBoundingClientRect() }))
              .filter(({ rect }) => rect.width > 0 && (rect.left < -1 || rect.right > clientWidth + 1))
              .slice(0, 8)
              .map(({ el, rect }) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
            return { scrollWidth: document.documentElement.scrollWidth, clientWidth, culprits };
          });
          expect(
            overflow.scrollWidth,
            `document scrolls sideways at ${viewport.width}px (${JSON.stringify(overflow)})`,
          ).toBeLessThanOrEqual(overflow.clientWidth);

          await page.screenshot({
            path: resolve(OUT, `deal-cockpit-${locale}-${theme}-${viewport.name}.png`),
            fullPage: true,
          });
        } finally {
          await context.close();
        }
      });
    }
  }
}
