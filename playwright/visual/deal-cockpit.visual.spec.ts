import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 * app's OWN compiled `globals.css`, inside the SAME shell geometry the
 * dashboard gives the screen — looked at in a real engine.
 *
 * The shell is reproduced from `app/(dashboard)/[orgId]/layout.tsx`,
 * `components/layout/Sidebar.tsx` and `components/layout/TopNav.tsx` with their
 * production classes: the `h-screen` flex row on the light/dark shell
 * background, the `md:` 16rem sidebar, the remaining flex column with the
 * top bar, and `<main>` as the constrained SCROLL CONTAINER with the responsive
 * padding the cockpit's sticky header sizes its negative margins to. The first
 * run of this gate measured a full-width document instead, so at 1280px it
 * painted the cockpit 256px wider than the product does and measured overflow
 * against the document, which never scrolls here at all — `main` does.
 *
 * What it asserts is deliberately narrow and deliberately observable:
 *   - `main` does not scroll sideways at 390px or 1280px, and nothing inside
 *     it paints outside main's own box;
 *   - the header, the headline figure and the stage rail are painted on
 *     screen, and the header sits above (never over) the essentials row;
 *   - every stage's OWNER label is painted with a non-zero box, and reads
 *     exactly the hand-written literal the bridge expects for that stage's
 *     owner, in EN and in AR — an oracle independent of the dictionaries the
 *     render itself uses;
 *   - the theme actually took: the shell paints its production background for
 *     the theme asked for, the body paints the `--background` token, and light
 *     and dark differ;
 *   - the direction actually took: `direction: rtl` is computed for Arabic,
 *     and the back arrow's `rtl:rotate-180` mirrored it.
 * A screenshot of every combination is written beside the run for a human to
 * judge the rest — hierarchy, rhythm, whether it reads as AutoFlow.
 *
 * Limitations, stated rather than hidden: the Next `font-cairo` / `font-inter`
 * faces are not loaded (system fallbacks paint the text), the sidebar and top
 * bar are empty boxes of the production size (their contents need queries),
 * the page is static (no queries, no dialogs, no interaction), and the fixture
 * is one financed deal. Everything real-data or interactive stays with the E2E
 * suite.
 */

const ROOT = resolve(__dirname, "../..");
/**
 * A FRESH directory per run, never reused. The bridge writes the fixtures into
 * it, and only files that exist there — created after this run began — count.
 * A fixed path would let markup left behind by yesterday's run make today's
 * failed bridge look green.
 */
const RUN_STARTED_AT = Date.now();
const RUN_DIR = resolve(
  ROOT,
  "test-results/deal-cockpit-visual",
  `run-${new Date(RUN_STARTED_AT).toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
const FIXTURES = resolve(RUN_DIR, "fixtures");

const LOCALES = ["en", "ar"] as const;
const THEMES = ["light", "dark"] as const;
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
] as const;

/** The desktop sidebar (`w-64`) at the default 16px root font size. */
const SIDEBAR_WIDTH_PX = 256;
/** Tailwind's `md` breakpoint, where the sidebar appears. */
const MD_BREAKPOINT_PX = 768;

let css = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // 0. A directory that did not exist before this run.
  expect(existsSync(RUN_DIR), `run directory already exists: ${RUN_DIR}`).toBe(false);
  mkdirSync(FIXTURES, { recursive: true });

  // 1. The markup, from the vitest bridge. Spawned here so one command runs
  //    the whole gate; the bridge is skipped in the ordinary suite. The bridge
  //    is told exactly where to write, and generation is opted into with the
  //    literal "1".
  execFileSync(
    process.execPath,
    [
      resolve(ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      "components/applications/cockpit/DealCockpitVisualFixture.test.tsx",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DEAL_COCKPIT_VISUAL_FIXTURE: "1",
        DEAL_COCKPIT_VISUAL_FIXTURE_DIR: FIXTURES,
      },
      stdio: "inherit",
    },
  );
  for (const locale of LOCALES) {
    for (const name of [`deal-cockpit-${locale}.html`, `deal-cockpit-${locale}.expected.json`]) {
      const file = resolve(FIXTURES, name);
      expect(existsSync(file), `bridge did not write ${file}`).toBe(true);
      expect(
        statSync(file).mtimeMs,
        `${file} predates this run — a stale artifact, not this bridge's output`,
      ).toBeGreaterThanOrEqual(RUN_STARTED_AT - 1_000);
    }
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
});

function expectedFor(locale: (typeof LOCALES)[number]): { stageOwners: string[] } {
  return JSON.parse(readFileSync(resolve(FIXTURES, `deal-cockpit-${locale}.expected.json`), "utf8"));
}

function documentFor(locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number]): string {
  const body = readFileSync(resolve(FIXTURES, `deal-cockpit-${locale}.html`), "utf8");
  const dir = locale === "ar" ? "rtl" : "ltr";
  // `<html dir lang class>` and `<body class>` as `app/layout.tsx` and the
  // LanguageProvider set them (the body's background comes from the
  // `@layer base` rule in `globals.css`, as in production, not from a class).
  // The shell markup and classes are copied VERBATIM from
  // `app/(dashboard)/[orgId]/layout.tsx`, `Sidebar.tsx` and `TopNav.tsx`; the
  // sidebar and top bar are empty because their contents need live queries,
  // and only their geometry matters to what is measured here.
  return `<!doctype html>
<html dir="${dir}" lang="${locale}" class="${theme === "dark" ? "dark" : ""}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body class="${locale === "ar" ? "font-cairo" : "font-inter"} antialiased">
<div class="flex h-screen w-full overflow-hidden bg-slate-50 dark:bg-zinc-950/40" data-testid="shell">
  <aside class="hidden md:flex flex-col w-64 border-e border-slate-200/50 bg-white shadow-sm shrink-0" data-testid="shell-sidebar"></aside>
  <div class="flex flex-col flex-1 w-full overflow-hidden">
    <header class="sticky top-0 z-30 w-full border-b border-slate-200/50 bg-white/95 backdrop-blur shadow-sm shrink-0" data-testid="shell-topnav"><div class="h-14 md:h-16 flex w-full items-center justify-between gap-2 px-3 md:px-6"></div></header>
    <main class="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 lg:p-8 relative pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-8" data-testid="shell-main">${body}</main>
  </div>
</div>
<div id="probe" style="background: var(--background); position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none"></div>
</body></html>`;
}

async function paint(page: Page, locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number]) {
  const file = resolve(RUN_DIR, `page-${locale}-${theme}.html`);
  writeFileSync(file, documentFor(locale, theme));
  await page.goto(`file:///${file.replace(/\\/g, "/")}`);
  await expect(page.getByTestId("deal-header")).toBeVisible();
}

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`${locale} · ${theme} · ${viewport.name}px: paints on-screen, in theme, in direction, in the shell, without sideways scroll`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme,
        });
        const page = await context.newPage();
        try {
          await paint(page, locale, theme);

          // The shell geometry is the production one: at `md` and above the
          // sidebar takes its 16rem and `main` gets the rest; below it, `main`
          // has the whole width. Measured, so a broken shell fails here rather
          // than quietly relaxing every assertion below.
          const main = page.getByTestId("shell-main");
          const sidebar = page.getByTestId("shell-sidebar");
          const mainBox = await main.boundingBox();
          expect(mainBox).not.toBeNull();
          const desktop = viewport.width >= MD_BREAKPOINT_PX;
          const sidebarBox = await sidebar.boundingBox();
          if (desktop) {
            expect(sidebarBox?.width).toBe(SIDEBAR_WIDTH_PX);
            expect(mainBox!.width).toBe(viewport.width - SIDEBAR_WIDTH_PX);
          } else {
            expect(sidebarBox).toBeNull();
            expect(mainBox!.width).toBe(viewport.width);
          }
          // `main` is the scroll container, not the document.
          expect(await main.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");

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

          // Theme took, twice over. The body paints the `--background` token
          // the theme defines, and the token is not the same colour in both
          // themes; the shell paints its own production background over it —
          // opaque `slate-50` in light, a translucent `zinc-950/40` in dark.
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
          // Tailwind v4 emits these as oklch / color-mix, which Chromium reports
          // back in that space, so the colour is resolved to 8-bit sRGB by
          // painting one pixel of it, and judged as lightness and alpha.
          const shellRgba = await page.getByTestId("shell").evaluate((el) => {
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = getComputedStyle(el).backgroundColor;
            ctx.fillRect(0, 0, 1, 1);
            return Array.from(ctx.getImageData(0, 0, 1, 1).data);
          });
          const [sr, sg, sb, sa] = shellRgba;
          if (theme === "dark") {
            expect(sa, `dark shell alpha ${JSON.stringify(shellRgba)}`).toBeGreaterThanOrEqual(96);
            expect(sa, `dark shell alpha ${JSON.stringify(shellRgba)}`).toBeLessThanOrEqual(108);
            expect((sr + sg + sb) / 3, `dark shell paint ${JSON.stringify(shellRgba)}`).toBeLessThan(40);
          } else {
            expect(sa, `light shell alpha ${JSON.stringify(shellRgba)}`).toBe(255);
            expect((sr + sg + sb) / 3, `light shell paint ${JSON.stringify(shellRgba)}`).toBeGreaterThan(240);
          }

          // The sticky header sits IN the flow at scroll 0, spans main's full
          // width (its negative margins are sized to the shell padding; one
          // step wrong and it overlaps or overflows), and does not cover the
          // essentials row under it.
          const headerBox = await header.boundingBox();
          const essentialsBox = await page
            .getByRole("definition")
            .first()
            .locator("..")
            .locator("..")
            .boundingBox();
          expect(headerBox).not.toBeNull();
          expect(essentialsBox).not.toBeNull();
          expect(headerBox!.y).toBeGreaterThanOrEqual(mainBox!.y);
          expect(Math.abs(headerBox!.x - mainBox!.x)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(headerBox!.width - mainBox!.width)).toBeLessThanOrEqual(0.5);
          expect(
            headerBox!.y + headerBox!.height,
            `header ${JSON.stringify(headerBox)} covers essentials ${JSON.stringify(essentialsBox)}`,
          ).toBeLessThanOrEqual(essentialsBox!.y + 0.5);

          // Painted on screen: header, headline figure, stage rail — inside
          // main's box, not merely inside the viewport.
          await expect(page.locator(".text-3xl").first()).toBeVisible();
          await expect(page.getByTestId("deal-stage-rail")).toBeVisible();
          const headline = await page.locator(".text-3xl").first().boundingBox();
          expect(headline).not.toBeNull();
          expect(headline!.x).toBeGreaterThanOrEqual(mainBox!.x);
          expect(headline!.x + headline!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width);

          // Every stage's owner is PAINTED — visible, with a real box — and
          // reads exactly the literal the bridge wrote as the expectation for
          // that stage. jsdom's visibility is a style lookup; this is layout.
          const owners = page.getByTestId("deal-stage-owner");
          // The oracle is a hand-written literal list in the bridge, NOT a
          // dictionary lookup; the positive control is its exact length —
          // the financed rail's eight stages — so an empty or truncated
          // expectation can never make the loop below vacuous.
          const expectedOwners = expectedFor(locale).stageOwners;
          expect(expectedOwners).toHaveLength(8);
          await expect(owners).toHaveCount(expectedOwners.length);
          for (const [index, expected] of expectedOwners.entries()) {
            const owner = owners.nth(index);
            await expect(owner, `stage ${index + 1} owner`).toBeVisible();
            await expect(owner, `stage ${index + 1} owner`).toHaveText(expected);
            const box = await owner.boundingBox();
            expect(box, `stage ${index + 1} owner has no box`).not.toBeNull();
            expect(box!.width, `stage ${index + 1} owner width`).toBeGreaterThan(0);
            expect(box!.height, `stage ${index + 1} owner height`).toBeGreaterThan(0);
            expect(box!.x).toBeGreaterThanOrEqual(mainBox!.x - 0.5);
            expect(box!.x + box!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 0.5);
          }

          // No sideways scroll IN MAIN. A horizontal scrollbar on a phone is
          // how a figure ends up off screen entirely; the document itself is
          // `overflow-hidden` in the shell and can never scroll, so measuring
          // it would prove nothing.
          const overflow = await main.evaluate((el) => {
            const box = el.getBoundingClientRect();
            // Named so a failure says WHICH block leaked, not just that one did.
            const culprits = Array.from(el.querySelectorAll<HTMLElement>("*"))
              .map((node) => ({ node, rect: node.getBoundingClientRect() }))
              .filter(
                ({ rect }) => rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1),
              )
              .slice(0, 8)
              .map(
                ({ node, rect }) =>
                  `${node.tagName.toLowerCase()}.${String(node.className).split(" ").slice(0, 4).join(".")} [${Math.round(rect.left)}..${Math.round(rect.right)}]`,
              );
            return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, culprits };
          });
          expect(
            overflow.scrollWidth,
            `main scrolls sideways at ${viewport.width}px (${JSON.stringify(overflow)})`,
          ).toBeLessThanOrEqual(overflow.clientWidth);
          expect(overflow.culprits, `blocks painted outside main at ${viewport.width}px`).toEqual([]);

          // Two frames per combination: what the operator sees on arrival, and
          // the foot of the cockpit once `main` — not the document, which is
          // `h-screen overflow-hidden` — is scrolled to its end.
          await page.screenshot({
            path: resolve(RUN_DIR, `deal-cockpit-${locale}-${theme}-${viewport.name}-top.png`),
          });
          await main.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
          await page.screenshot({
            path: resolve(RUN_DIR, `deal-cockpit-${locale}-${theme}-${viewport.name}-bottom.png`),
          });
        } finally {
          await context.close();
        }
      });
    }
  }
}
