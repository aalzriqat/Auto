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

/**
 * S414-R2-SKEW-1: the same deal on its closing step with the readiness read
 * failed — the close withheld with its own reason. The reason is checked
 * against a hand-written literal, not the dictionary the render used.
 */
const READINESS_UNREADABLE = "-readiness-unreadable";
const FINALIZE_WAITS_LITERAL: Readonly<Record<(typeof LOCALES)[number], string>> = {
  en: "Closing readiness could not be checked right now, so the deal can't be closed yet. Try again shortly.",
  ar: "تعذّر فحص جاهزية الإغلاق الآن، لذا لا يمكن إغلاق الصفقة بعد. حاول مجددًا بعد قليل.",
};

/**
 * S414-R3-1: the same closing step for a custom closer who may close but not
 * read the finance application — no readiness panel, the close withheld with
 * the reason naming the missing access. Hand-written literal, as above.
 */
const READINESS_ACCESS = "-readiness-access";
const FINALIZE_NEEDS_ACCESS_LITERAL: Readonly<Record<(typeof LOCALES)[number], string>> = {
  en: "Your role can close deals but cannot view finance applications, so this deal's closing readiness can't be checked for you. Ask an administrator to add finance-application view access to your role.",
  ar: "دورك يسمح بإغلاق الصفقات لكنه لا يسمح بعرض طلبات التمويل، لذا لا يمكن فحص جاهزية إغلاق هذه الصفقة لك. اطلب من المسؤول إضافة صلاحية عرض طلبات التمويل إلى دورك.",
};

/** The withheld-close states painted below: each reason, and whether a readiness panel is expected. */
const WITHHELD_CLOSE_VARIANTS: ReadonlyArray<{
  suffix: string;
  title: string;
  literal: Readonly<Record<(typeof LOCALES)[number], string>>;
  panelTestId: string | null;
}> = [
  {
    suffix: READINESS_UNREADABLE,
    title: "readiness unreadable withholds the close with its reason",
    literal: FINALIZE_WAITS_LITERAL,
    panelTestId: "closing-readiness-service-unavailable",
  },
  {
    suffix: READINESS_ACCESS,
    title: "no readiness access withholds the close and names the missing access",
    literal: FINALIZE_NEEDS_ACCESS_LITERAL,
    panelTestId: null,
  },
];

/**
 * SCRUM-417 UX4 (O2/O3): the sub-step checklist on the LIVE step (Settlement), and the
 * read-only view of a past and of a future step (what `?stage=` or a rail click
 * opens). `mode` is what the view card must declare; `checklist` whether the
 * live card must list sub-steps.
 */
const UX4_VARIANTS: ReadonlyArray<{
  suffix: string;
  title: string;
  mode: "past" | "future" | null;
  stage: string | null;
}> = [
  { suffix: "-ux4-settlement-checklist", title: "the live Settlement card lists its closing gates, one current", mode: null, stage: null },
  { suffix: "-ux4-view-past", title: "a past step opens read-only with a way back", mode: "past", stage: "APPLICATION" },
  { suffix: "-ux4-view-future", title: "a future step says what it needs and who acts", mode: "future", stage: "SETTLEMENT" },
];

/**
 * SCRUM-417 UX5 (O4): below `md` the stage rail is folded behind a disclosure
 * (`deal-mobile-rail-toggle`). The page is static markup with no hydration, so
 * opening it is APPLIED to the DOM the way the handler does it: aria-expanded
 * on the toggle and the folded wrapper's `hidden` class removed. At `md` and
 * above the rail is always shown, so this is a no-op there.
 */
async function openMobileRail(page: Page, width: number) {
  if (width >= MD_BREAKPOINT_PX) return;
  const toggle = page.getByTestId("deal-mobile-rail-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => {
    document.querySelector('[data-testid="deal-mobile-rail-toggle"]')?.setAttribute("aria-expanded", "true");
    document.getElementById("deal-stage-rail-panel")?.classList.remove("hidden");
  });
}
/**
 * SCRUM-417 UX5 (S7/O4): the cockpit with a step just recorded -- the
 * persistent "Recorded. Next: ..." line -- and, below `md`, the compact step
 * bar with the rail folded, then the same page with the rail opened. Suffixes
 * deliberately do not contain `-ux4-`: the CI frame count for UX4 stays 24.
 */
const UX5_SUFFIX = "-ux5-recorded";
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
    for (const name of [
      `deal-cockpit-${locale}.html`,
      `deal-cockpit-${locale}.expected.json`,
      `deal-focus-states-${locale}.html`,
    ]) {
      const file = resolve(FIXTURES, name);
      expect(existsSync(file), `bridge did not write ${file}`).toBe(true);
      expect(
        statSync(file).mtimeMs,
        `${file} predates this run — a stale artifact, not this bridge's output`,
      ).toBeGreaterThanOrEqual(RUN_STARTED_AT - 1_000);
    }
    for (const { suffix } of UX4_VARIANTS) {
      const variantFile = resolve(FIXTURES, `deal-cockpit-${locale}${suffix}.html`);
      expect(existsSync(variantFile), `bridge did not write ${variantFile}`).toBe(true);
      expect(statSync(variantFile).mtimeMs).toBeGreaterThanOrEqual(RUN_STARTED_AT - 1_000);
    }
    const ux5File = resolve(FIXTURES, `deal-cockpit-${locale}${UX5_SUFFIX}.html`);
    expect(existsSync(ux5File), `bridge did not write ${ux5File}`).toBe(true);
    expect(statSync(ux5File).mtimeMs).toBeGreaterThanOrEqual(RUN_STARTED_AT - 1_000);
    for (const { suffix } of WITHHELD_CLOSE_VARIANTS) {
      const variantFile = resolve(FIXTURES, `deal-cockpit-${locale}${suffix}.html`);
      expect(existsSync(variantFile), `bridge did not write ${variantFile}`).toBe(true);
      expect(statSync(variantFile).mtimeMs).toBeGreaterThanOrEqual(RUN_STARTED_AT - 1_000);
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

function documentFor(
  locale: (typeof LOCALES)[number],
  theme: (typeof THEMES)[number],
  variant = "",
  fixture: "deal-cockpit" | "deal-focus-states" = "deal-cockpit",
): string {
  const body = readFileSync(resolve(FIXTURES, `${fixture}-${locale}${variant}.html`), "utf8");
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

async function paint(page: Page, locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number], variant = "") {
  const file = resolve(RUN_DIR, `page-${locale}-${theme}${variant}.html`);
  writeFileSync(file, documentFor(locale, theme, variant));
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

          // SCRUM-417 UX3 (O1): what the operator sees on arrival. The live step
          // (Documents) has its panel directly under the next-step card, painted
          // and reachable, and the rest of the deal sits in a COLLAPSED record.
          // Adjacency is asserted at every width. "Within the first screen" is
          // asserted where it is true (desktop) and MEASURED at 390px, where the
          // sticky header, identity strip and 8-node rail above the card (rail
          // and identity are outside O1) take ~690px of an 844px screen; the
          // measurement is recorded on the test so it is visible, not hidden.
          const nextStepBox = await page.getByTestId("deal-next-step").boundingBox();
          const workbenchBox = await page.locator('[data-zone="workbench"]').first().boundingBox();
          expect(nextStepBox).not.toBeNull();
          expect(workbenchBox).not.toBeNull();
          expect(workbenchBox!.y, "the workbench sits under the next-step card").toBeGreaterThanOrEqual(
            nextStepBox!.y + nextStepBox!.height - 0.5,
          );
          expect(workbenchBox!.y - (nextStepBox!.y + nextStepBox!.height), "gap between step and panel").toBeLessThan(40);
          test.info().annotations.push({
            type: "workbench-first-screen",
            description: `next-step y=${Math.round(nextStepBox!.y)} workbench y=${Math.round(workbenchBox!.y)} viewport=${viewport.height}`,
          });
          if (desktop) {
            expect(
              workbenchBox!.y,
              `workbench starts at ${workbenchBox!.y}, below the first screen (${viewport.height})`,
            ).toBeLessThan(viewport.height);
          }
          await expect(page.getByTestId("deal-lower-tabs")).toBeVisible();
          const toggle = page.getByTestId("deal-details-toggle");
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          // Hidden, not removed: every record wrapper is in the document.
          expect(await page.locator('[data-zone="record"]:not([hidden])').count()).toBe(0);
          expect(await page.locator('[data-zone="record"][hidden]').count()).toBeGreaterThan(0);
          await expect(page.getByTestId("deal-details-toggle")).toBeVisible();
          // Collapsed means hidden, not removed: the money is in the record and
          // is not painted until it is opened.
          await expect(page.getByTestId("deal-money")).toBeHidden();
          // Opus L1: with the record collapsed the grid ends at the toggle. The
          // row template that keeps the working cards together (N3) belongs to
          // the EXPANDED record; applied while collapsed it left ~120-144px of
          // blank rows under the toggle at desktop widths.
          if (viewport.width >= 1280) {
            const collapsedEnd = await page.evaluate(() => {
              const wrapper = document.querySelector('[data-zone="toggle"]') as HTMLElement;
              const grid = wrapper.parentElement as HTMLElement;
              return {
                gridBottom: grid.getBoundingClientRect().bottom,
                toggleBottom: wrapper.getBoundingClientRect().bottom,
              };
            });
            expect(
              collapsedEnd.gridBottom - collapsedEnd.toggleBottom,
              `blank space under the collapsed toggle: ${JSON.stringify(collapsedEnd)}`,
            ).toBeLessThanOrEqual(0.5);
          }
          await page.screenshot({
            path: resolve(RUN_DIR, `deal-cockpit-${locale}-${theme}-${viewport.name}-top.png`),
          });
          // STATIC EXPANDED-LAYOUT COVERAGE, not an interaction test. The page is
          // server-rendered markup with no hydration, so nothing here proves the
          // toggle works in a browser: the collapsed state above is what the markup
          // renders, and the expanded state below is APPLIED to the DOM by this
          // script so the layout can be measured and shot. The jsdom suite
          // (DealCockpitVisualFixture.test.tsx) covers only that the toggle is a
          // native button, that Enter/Space are not cancelled, and that a click
          // toggles it; real keyboard activation needs a hydrated browser test
          // (follow-up SCRUM-465).
          // Open it. The page is static markup (no React handlers), so the toggle
          // is applied to the DOM the way its handler does: aria-expanded and the
          // `hidden` attribute of every record wrapper. The handler itself is
          // exercised in the jsdom suite (DealCockpitVisualFixture.test.tsx).
          await page.evaluate(() => {
            document.querySelector('[data-testid="deal-details-toggle"]')?.setAttribute("aria-expanded", "true");
            document.querySelectorAll('[data-zone="record"]').forEach((el) => ((el as HTMLElement).hidden = false));
          });
          await expect(page.getByTestId("deal-money")).toBeVisible();

          // SCRUM-417 UX3 N3: the money column spans the working panels beside it.
          // When the money is far TALLER than they are, the working cards must stay
          // one gap apart (24px), not be pushed apart by the spanning item.
          if (viewport.width >= 1280) {
            await page.evaluate(() => {
              const spacer = document.createElement("div");
              spacer.style.height = "2600px";
              spacer.setAttribute("data-n3-spacer", "");
              document.querySelector('[data-testid="deal-money"]')?.appendChild(spacer);
            });
            const tops = await page.evaluate(() =>
              Array.from(document.querySelectorAll('[data-zone="record"]:not(#deal-record-money)')).map((el) => {
                // The panel itself, not its grid cell: a stretched cell would hide the gap.
                const box = (el.firstElementChild ?? el).getBoundingClientRect();
                return { top: box.top, bottom: box.bottom };
              })
            );
            expect(tops.length).toBeGreaterThan(1);
            for (let i = 1; i < tops.length; i += 1) {
              expect(tops[i].top - tops[i - 1].bottom, `gap between record panel ${i - 1} and ${i} with a tall money column`).toBeCloseTo(24, 0);
            }
            // The spacer only existed to measure: take it out so the bottom
            // screenshot shows the real page, not 2600px of nothing.
            await page.evaluate(() => document.querySelectorAll("[data-n3-spacer]").forEach((el) => el.remove()));
            expect(await page.locator("[data-n3-spacer]").count()).toBe(0);
          }

          // Painted on screen: header, headline figure, stage rail — inside
          // main's box, not merely inside the viewport.
          await expect(page.locator(".text-3xl").first()).toBeVisible();
          await openMobileRail(page, viewport.width);
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

          // Frames per combination: what the operator sees on arrival (the
          // collapsed record, taken above), the same screen with Deal details
          // opened, and the foot of the cockpit once `main` — not the document,
          // which is `h-screen overflow-hidden` — is scrolled to its end.
          await page.screenshot({
            path: resolve(RUN_DIR, `deal-cockpit-${locale}-${theme}-${viewport.name}-expanded-top.png`),
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

/**
 * SCRUM-417 UX5, painted. At 390px: the compact "Step N of M" bar is shown and
 * the rail is folded until the disclosure opens it; the step card comes before
 * Deal details; nothing leaks sideways. At 1280px: the bar is absent and the
 * rail is as before. The "Recorded. Next:" line is painted in both.
 */
for (const locale of LOCALES) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`${locale} · ${theme} · ${viewport.name}px: UX5 recorded line and mobile step bar`, async ({ browser }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme,
        });
        const page = await context.newPage();
        try {
          await paint(page, locale, theme, UX5_SUFFIX);
          const main = page.getByTestId("shell-main");
          const mainBox = await main.boundingBox();
          expect(mainBox).not.toBeNull();
          const mobile = viewport.width < MD_BREAKPOINT_PX;

          const recorded = page.getByTestId("deal-recorded-feedback");
          await expect(recorded).toBeVisible();
          const recordedBox = await recorded.boundingBox();
          expect(recordedBox!.x).toBeGreaterThanOrEqual(mainBox!.x - 0.5);
          expect(recordedBox!.x + recordedBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 0.5);
          await expect(page.getByTestId("deal-recorded-feedback-dismiss")).toBeVisible();

          const bar = page.getByTestId("deal-mobile-stepbar");
          const rail = page.getByTestId("deal-stage-rail");
          if (mobile) {
            await expect(bar).toBeVisible();
            // Position text: the current step never exceeds the total (SCRUM-468).
            const nums = await page
              .getByTestId("deal-mobile-step-position")
              .locator("bdi")
              .allInnerTexts();
            expect(nums).toHaveLength(2);
            expect(Number(nums[0])).toBeGreaterThanOrEqual(1);
            expect(Number(nums[0])).toBeLessThanOrEqual(Number(nums[1]));
            expect(await bar.evaluate((el) => getComputedStyle(el).direction)).toBe(locale === "ar" ? "rtl" : "ltr");
            // Folded: the rail is not painted until the disclosure opens it.
            await expect(rail).toBeHidden();
            // The step card comes before Deal details, and starts on the first screen.
            const nextStepBox = await page.getByTestId("deal-next-step").boundingBox();
            const identityBox = await page.getByTestId("deal-identity").boundingBox();
            expect(nextStepBox).not.toBeNull();
            expect(identityBox).not.toBeNull();
            expect(nextStepBox!.y, "the step card sits above Deal details").toBeLessThan(identityBox!.y);
            expect(nextStepBox!.y, "the step card starts inside the first screen").toBeLessThan(viewport.height);
            // Reading order = visual order: the identity strip follows the step in
            // the DOM too, so Tab and a screen reader meet the step first.
            const domOrder = await page.evaluate(() => {
              const step = document.querySelector('[data-testid="deal-next-step"]')!;
              const identity = document.querySelector('[data-testid="deal-identity"]')!;
              return Boolean(step.compareDocumentPosition(identity) & Node.DOCUMENT_POSITION_FOLLOWING);
            });
            expect(domOrder, "identity follows the step in the DOM on a phone").toBe(true);
            test.info().annotations.push({
              type: "cta-first-screen",
              description: `next-step y=${Math.round(nextStepBox!.y)} h=${Math.round(nextStepBox!.height)} viewport=${viewport.height}`,
            });
          } else {
            await expect(bar).toBeHidden();
            await expect(rail).toBeVisible();
            // Desktop keeps its placement even though the DOM order changed: the
            // identity strip is still above the workbench, by CSS order alone.
            const identityBox = await page.getByTestId("deal-identity").boundingBox();
            const nextStepBox = await page.getByTestId("deal-next-step").boundingBox();
            expect(identityBox!.y, "desktop: identity strip stays above the step").toBeLessThan(nextStepBox!.y);
          }

          const overflow = await main.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
          expect(overflow.scrollWidth, `main scrolls sideways at ${viewport.width}px`).toBeLessThanOrEqual(
            overflow.clientWidth,
          );
          await page.screenshot({
            path: resolve(RUN_DIR, `deal-cockpit-${locale}-${theme}-${viewport.name}${UX5_SUFFIX}.png`),
          });

          if (mobile) {
            await openMobileRail(page, viewport.width);
            await expect(rail).toBeVisible();
            expect(await rail.getByRole("button").count()).toBe(8);
            await page.screenshot({
              path: resolve(RUN_DIR, `deal-cockpit-${locale}-${theme}-${viewport.name}-ux5-rail-open.png`),
            });
          }
        } finally {
          await context.close();
        }
      });
    }
  }
}
/**
 * SCRUM-417 — the next-step states the wizard added, painted in the same shell.
 * The viewport is tall so the whole gallery is on screen at once and `main`
 * never needs scrolling for the frame. Asserted: every state's row is painted
 * inside main, its one primary button (where it has one) has a real box and
 * sits inside main, and nothing scrolls sideways — the Arabic note and the
 * secondary link are the likeliest to push a 390px row wide.
 */
const FOCUS_STATE_IDS = [
  "reconciliation-resolve",
  "reconciliation-no-permission",
  "appraisal-next",
  "gap-failed",
  "credit-documents-first",
  "credit-documents-no-authority",
  "delivery-documents-await-verifier",
  "delivery-documents-read-only-role",
  "handover-blocked",
  "held-deposit-link",
  "held-deposit-no-access",
  "credit-documents-need-read-access",
  "delivery-documents-need-read-access",
  "cash-handover",
  "cash-handover-no-permission",
  "cash-handover-needs-read-access",
  "cash-handover-deposit-decision",
] as const;
/** S4: states whose reason carries a link to another existing page. */
const WITH_LINK = new Set(["held-deposit-link", "cash-handover-deposit-decision"]);
const WITH_PRIMARY = new Set([
  "reconciliation-resolve",
  "appraisal-next",
  "gap-failed",
  "credit-documents-first",
  "cash-handover",
]);

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`focus states · ${locale} · ${theme} · ${viewport.name}px: every next step painted, one button each, no sideways scroll`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          // Tall enough for the whole gallery at 390px (13 states plus the
          // documents panel since round 2): `main` clips the screenshot to
          // its own box, so a shorter frame silently drops the last states.
          viewport: { width: viewport.width, height: 7600 },
          colorScheme: theme,
        });
        const page = await context.newPage();
        try {
          const file = resolve(RUN_DIR, `focus-${locale}-${theme}.html`);
          writeFileSync(file, documentFor(locale, theme, "", "deal-focus-states"));
          await page.goto(`file:///${file.replace(/\\/g, "/")}`);
          const main = page.getByTestId("shell-main");
          const mainBox = (await main.boundingBox())!;
          expect(mainBox).not.toBeNull();
          expect(
            await page.getByTestId("deal-focus-states").evaluate((el) => getComputedStyle(el).direction),
          ).toBe(locale === "ar" ? "rtl" : "ltr");

          for (const id of FOCUS_STATE_IDS) {
            const block = page.getByTestId(`focus-state-${id}`);
            await expect(block, id).toBeVisible();
            const buttons = block.getByTestId("deal-next-step-action");
            await expect(buttons, `${id} primary count`).toHaveCount(WITH_PRIMARY.has(id) ? 1 : 0);
            // S3/S4: a link only where the container gave one; never the passive
            // documents link for a caller who cannot act on documents.
            await expect(block.getByTestId("deal-next-step-link"), `${id} link count`).toHaveCount(WITH_LINK.has(id) ? 1 : 0);
            if (id === "delivery-documents-read-only-role" || id === "delivery-documents-await-verifier") {
              await expect(block.getByTestId("deal-go-to-documents"), `${id} passive link`).toHaveCount(0);
            }
            if (WITH_LINK.has(id)) {
              const linkBox = (await block.getByTestId("deal-next-step-link").boundingBox())!;
              expect(linkBox.height, `${id} link height`).toBeGreaterThanOrEqual(36);
              expect(linkBox.x).toBeGreaterThanOrEqual(mainBox.x - 0.5);
              expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 0.5);
            }
            if (WITH_PRIMARY.has(id)) {
              const box = (await buttons.boundingBox())!;
              expect(box.height, `${id} button height`).toBeGreaterThanOrEqual(36);
              expect(box.x).toBeGreaterThanOrEqual(mainBox.x - 0.5);
              expect(box.x + box.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 0.5);
            }
          }

          // Round 2 (S417-R2-5): the widest document row — View, Verify and the
          // replacement upload together — painted inside main, every control
          // with a real box.
          const panelRow = page.getByTestId("deal-document-d1");
          await expect(panelRow).toBeVisible();
          await expect(panelRow.locator("button, label")).toHaveCount(3);
          for (const control of await panelRow.locator("button, label").all()) {
            const box = (await control.boundingBox())!;
            expect(box.width, "document control width").toBeGreaterThan(0);
            expect(box.x).toBeGreaterThanOrEqual(mainBox.x - 0.5);
            expect(box.x + box.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 0.5);
          }

          // Round 3 (S417-R3-1): the "No longer required" history — each row
          // carries View and nothing else, inside main.
          const history = page.getByTestId("deal-documents-history");
          await expect(history).toBeVisible();
          for (const id of ["h1", "h2"]) {
            const row = history.getByTestId(`deal-document-history-${id}`);
            await expect(row).toBeVisible();
            await expect(row.locator("button, label, input")).toHaveCount(1);
            const box = (await row.locator("button").boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(mainBox.x - 0.5);
            expect(box.x + box.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 0.5);
          }

          const overflow = await main.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const culprits = Array.from(el.querySelectorAll<HTMLElement>("*"))
              .map((node) => ({ node, rect: node.getBoundingClientRect() }))
              .filter(({ rect }) => rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1))
              .slice(0, 8)
              .map(({ node, rect }) => `${node.tagName.toLowerCase()} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
            return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, culprits };
          });
          expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth);
          expect(overflow.culprits).toEqual([]);

          await page.getByTestId("deal-focus-states").screenshot({
            path: resolve(RUN_DIR, `deal-focus-states-${locale}-${theme}-${viewport.name}.png`),
          });
        } finally {
          await context.close();
        }
      });
    }
  }
}

/**
 * S414-R2-SKEW-1 and S414-R3-1, painted. The next-step block carries the
 * withheld close's own reason and NO button; the readiness panel names a failed
 * read, and is absent for a caller who cannot read it; nothing leaks sideways
 * at 390px or 1280px. Screenshotted at the next-step block (and the panel,
 * where there is one) so the reason's wrap and tone are judged in both
 * directions.
 */
for (const variant of WITHHELD_CLOSE_VARIANTS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        test(`${locale} · ${theme} · ${viewport.name}px: ${variant.title}`, async ({
          browser,
        }) => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: theme,
          });
          const page = await context.newPage();
          try {
            await paint(page, locale, theme, variant.suffix);
            const main = page.getByTestId("shell-main");
            const mainBox = await main.boundingBox();
            expect(mainBox).not.toBeNull();

            const nextStep = page.getByTestId("deal-next-step");
            await expect(nextStep).toBeVisible();
            // Withheld: no button in the block, and the reason reads exactly the literal.
            await expect(nextStep.getByRole("button")).toHaveCount(0);
            const reason = nextStep.getByText(variant.literal[locale], { exact: true });
            await expect(reason).toBeVisible();
            const reasonBox = await reason.boundingBox();
            expect(reasonBox).not.toBeNull();
            expect(reasonBox!.x).toBeGreaterThanOrEqual(mainBox!.x - 0.5);
            expect(reasonBox!.x + reasonBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 0.5);
            expect(await reason.evaluate((el) => getComputedStyle(el).direction)).toBe(
              locale === "ar" ? "rtl" : "ltr",
            );

            if (variant.panelTestId) {
              await expect(page.getByTestId(variant.panelTestId)).toBeVisible();
            } else {
              await expect(page.getByTestId("closing-readiness-service-unavailable")).toHaveCount(0);
            }

            const overflow = await main.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
            expect(
              overflow.scrollWidth,
              `main scrolls sideways at ${viewport.width}px (${JSON.stringify(overflow)})`,
            ).toBeLessThanOrEqual(overflow.clientWidth);

            await nextStep.scrollIntoViewIfNeeded();
            await page.screenshot({
              path: resolve(RUN_DIR, `deal-cockpit-${locale}-${theme}-${viewport.name}${variant.suffix}-next-step.png`),
            });
            if (variant.panelTestId) {
              await page.getByTestId(variant.panelTestId).scrollIntoViewIfNeeded();
              await page.screenshot({
                path: resolve(RUN_DIR, `deal-cockpit-${locale}-${theme}-${viewport.name}${variant.suffix}-panel.png`),
              });
            }
          } finally {
            await context.close();
          }
        });
      }
    }
  }
}

/**
 * SCRUM-417 UX4, painted. The checklist marks exactly one item current, every
 * rail node is a real keyboard-focusable button, a viewed step shows its
 * read-only card with a visible "back to current step" chip, the live step's
 * card stays on the page, and nothing leaks sideways.
 */
for (const variant of UX4_VARIANTS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        test(`${locale} · ${theme} · ${viewport.name}px: ${variant.title}`, async ({ browser }) => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: theme,
          });
          const page = await context.newPage();
          try {
            await paint(page, locale, theme, variant.suffix);
            const main = page.getByTestId("shell-main");
            const mainBox = await main.boundingBox();
            expect(mainBox).not.toBeNull();

            // The rail: eight real buttons, exactly one aria-current.
            await openMobileRail(page, viewport.width);
            const rail = page.getByTestId("deal-stage-rail");
            await expect(rail).toBeVisible();
            expect(await rail.getByRole("button").count()).toBe(8);
            expect(await rail.locator('[aria-current="step"]').count()).toBe(1);
            await rail.getByRole("button").first().focus();
            expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BUTTON");

            const nextStep = page.getByTestId("deal-next-step");
            await expect(nextStep).toBeVisible();

            if (variant.mode === null) {
              const list = page.getByTestId("deal-step-checklist");
              await expect(list).toBeVisible();
              expect(await list.locator('[data-status="current"]').count()).toBe(1);
              expect(await list.locator('[data-status="done"]').count()).toBeGreaterThan(0);
              // Settlement: the closing gates follow the server's order, so what
              // is not reached yet is pending, and the unpaid cost is the current one.
              expect(await list.locator('[data-status="pending"]').count()).toBeGreaterThan(0);
              await expect(list.getByTestId("deal-step-item-costs-paid")).toHaveAttribute("data-status", "current");
              await expect(list.getByTestId("deal-step-item-close-deal")).toHaveAttribute("data-status", "pending");
              await expect(page.getByTestId("deal-stage-view")).toHaveCount(0);
              const box = await list.boundingBox();
              expect(box!.x).toBeGreaterThanOrEqual(mainBox!.x - 0.5);
              expect(box!.x + box!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 0.5);
              await list.scrollIntoViewIfNeeded();
            } else {
              const view = page.getByTestId("deal-stage-view");
              await expect(view).toBeVisible();
              await expect(view).toHaveAttribute("data-mode", variant.mode);
              await expect(view).toHaveAttribute("data-stage", variant.stage!);
              const back = page.getByTestId("deal-stage-view-back");
              await expect(back).toBeVisible();
              const backBox = await back.boundingBox();
              expect(backBox!.x).toBeGreaterThanOrEqual(mainBox!.x - 0.5);
              expect(backBox!.x + backBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 0.5);
              await expect(page.getByTestId("deal-stage-view-owner")).toBeVisible();
              // Only the live step has sub-steps: a viewed one lists none.
              await expect(view.getByTestId("deal-step-checklist")).toHaveCount(0);
              if (variant.mode === "future") await expect(page.getByTestId("deal-stage-view-needs")).toBeVisible();
              // The live step is still the only aria-current node and card.
              expect(await rail.locator('[aria-current="step"]').count()).toBe(1);
              await view.scrollIntoViewIfNeeded();
            }
            expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(
              locale === "ar" ? "rtl" : "ltr",
            );

            const overflow = await main.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
            expect(
              overflow.scrollWidth,
              `main scrolls sideways at ${viewport.width}px (${JSON.stringify(overflow)})`,
            ).toBeLessThanOrEqual(overflow.clientWidth);

            await page.screenshot({
              path: resolve(RUN_DIR, `deal-cockpit-${locale}-${theme}-${viewport.name}${variant.suffix}.png`),
            });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
}