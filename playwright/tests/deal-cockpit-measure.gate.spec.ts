/**
 * The rendered gate for SCRUM-78's layout half.
 *
 * The owner had to zoom a browser to 50% to read one deal. That is not a font
 * problem — `justify-between` on an unbounded row put a label at one edge of a
 * 1780px monitor and the figure it names at the other, and halving the font size
 * simply halves that distance. So this measures the distance, in a real engine,
 * in both locales, at both widths. A screenshot cannot be asserted on and a
 * jsdom test has no layout at all; only a real browser can answer this.
 *
 * Run by hand as the design gate, against a deployment carrying a financed deal.
 *
 * `RUN_DESIGN_GATE` is the ONLY thing keeping it out of CI, and the `.gate`
 * segment in the filename is decorative — an earlier version of this comment
 * claimed `testMatch` excluded it, which is false and was disproved by
 * `playwright test --list --project=chromium`: the default matcher is
 * `**\/*.@(spec|test).?(c|m)[jt]s?(x)`, the file still ends in `.spec.ts`, and
 * all four cases are collected and then skipped.
 *
 * That distinction matters to whoever reads this next. Setting
 * `RUN_DESIGN_GATE` broadly — a repo-wide env, a workflow-level `env:` block —
 * would make these four execute inside the ordinary chromium run, against an
 * ephemeral CI deployment with no seeded financed deal, and they would fail on
 * the "no pairs were laid out" assertion below. Enable it for a run you are
 * pointing at real data, never as a default.
 */
import { test, expect, type Page } from "@playwright/test";

/**
 * The comfortable reading measure this layout is capped to.
 *
 * 2xl is 42rem = 672px, and the derived-economics cells are capped at sm
 * (24rem). A little headroom over the widest cap, because the assertion is
 * about "adjacent enough to read as a pair", not about a specific utility.
 */
const MAX_LABEL_TO_FIGURE_PX = 700;

async function setLocale(page: Page, locale: "en" | "ar") {
  await page.addInitScript((value) => {
    window.localStorage.setItem("autoflow-locale", value);
  }, locale);
}

/** Opens the first financed deal's cockpit from the applications list. */
async function openADealCockpit(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/[^/]+\/(dashboard|sales)/, { timeout: 60_000 });
  const orgId = new URL(page.url()).pathname.split("/")[1];
  await page.goto(`/${orgId}/applications`);
  const dealLink = page.locator('a[href$="/deal"]').first();
  await expect(dealLink).toBeVisible({ timeout: 60_000 });
  await dealLink.click();
  await page.waitForURL(/\/deal$/, { timeout: 60_000 });
}

/**
 * The widest horizontal gap between any `<dt>` and the `<dd>` it names.
 *
 * Measured from rectangles rather than read off the class list: the point is
 * what the engine actually laid out, and a cap that is overridden by a parent's
 * flex behaviour would still have the right class on it.
 *
 * Direction-agnostic on purpose — in Arabic the label is on the right and the
 * figure on the left, so a signed distance would report RTL as fine while it was
 * just as far apart.
 */
async function measureLabelToFigureGaps(
  page: Page
): Promise<{ widest: number; measured: number }> {
  return page.evaluate(() => {
    let widest = 0;
    let measured = 0;
    for (const dt of Array.from(document.querySelectorAll("dt"))) {
      const dd = dt.parentElement?.querySelector("dd");
      if (!dd) continue;
      const a = dt.getBoundingClientRect();
      const b = dd.getBoundingClientRect();
      if (a.width === 0 || b.width === 0) continue;
      // Same visual row only; a stacked pair is not a reading-distance problem.
      if (Math.abs(a.top - b.top) > 24) continue;
      measured += 1;
      const gap = Math.max(b.left - a.right, a.left - b.right);
      if (gap > widest) widest = gap;
    }
    return { widest, measured };
  });
}

const VIEWPORTS = [
  { name: "desktop-1780", width: 1780, height: 1000 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

test.describe("the deal cockpit's reading measure", () => {
  /**
   * Gated on an ENV VAR, never on a file.
   *
   * `test.skip()` at describe level runs during suite DISCOVERY, so a condition
   * that depends on something the setup project creates is evaluated before that
   * project has run — which is how a suite skips permanently behind a green
   * check. An env var is present at discovery and says plainly that this gate is
   * driven by hand against a dev deployment carrying a real financed deal.
   */
  test.skip(
    !process.env.RUN_DESIGN_GATE,
    "The rendered design gate is run by hand against a dev deployment with a financed deal on it. Set RUN_DESIGN_GATE=1 to drive it.",
  );

  for (const locale of ["en", "ar"] as const) {
  for (const viewport of VIEWPORTS) {
    test(`${locale} @ ${viewport.name}: a figure stays beside the label that names it`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await setLocale(page, locale);
      await openADealCockpit(page);

      // The direction really did flip, so an "RTL" run that silently rendered
      // LTR cannot pass as one.
      const dir = await page.evaluate(() => document.documentElement.dir);
      expect(dir).toBe(locale === "ar" ? "rtl" : "ltr");

      const { widest, measured } = await measureLabelToFigureGaps(page);
      await page.screenshot({
        path: `playwright/.gate/deal-cockpit-${locale}-${viewport.name}.png`,
        fullPage: true,
      });

      // Asserted BEFORE the distance, because a widest-gap of zero is what a
      // deal with no economics rows on it produces — and "nothing to measure"
      // would otherwise read as "everything measured well". The gate has to
      // fail when it is pointed at a deal that cannot exercise it.
      expect(
        measured,
        "no label/figure pairs were laid out on this deal — point the gate at one carrying recorded economics",
      ).toBeGreaterThan(0);
      expect(widest).toBeLessThan(MAX_LABEL_TO_FIGURE_PX);

      // Nothing may push the page sideways at 390px — a horizontal scrollbar on
      // a phone is how a figure ends up off screen entirely.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
  }
});
