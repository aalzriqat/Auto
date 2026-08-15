import { test, expect, type Page } from "@playwright/test";
import { APPROVER_AUTH_FILE, USER_AUTH_FILE } from "../utils";
import { buildDealWithRecordedEconomics } from "../fixtures/financedDeal";

/**
 * The deal cockpit's reading measure, in a real engine, in both languages, at
 * both widths.
 *
 * The owner had to zoom a browser to 50% to read one deal. That was never a font
 * problem: `justify-between` on an unbounded row put a label at one edge of a
 * 1780px monitor and the figure it names at the other, and halving the font size
 * halves that distance without adding a word of information. So this measures
 * the distance rather than looking at it. A screenshot cannot be asserted on and
 * jsdom has no layout at all.
 *
 * **This gate builds its own deal.** An earlier version opened whichever
 * application happened to be first in the list, which made it depend on data it
 * did not create, could pass vacuously against a deal with no economics on it,
 * and — worst — pointed automation at rows somebody else owns. The production
 * deal carrying the only real correction override is READ-ONLY for automation,
 * permanently. Every run here creates a disposable deal through the same screens
 * an operator uses and measures that.
 *
 * It runs in CI like any other spec. It used to be hand-run behind
 * `RUN_DESIGN_GATE` against a shared dev deployment, which meant it never
 * actually ran — a gate nobody can execute is not a gate. Owner ruling on
 * SCRUM-78: build it as a permanent self-contained CI gate rather than waive it.
 */

/**
 * The comfortable reading measure this layout is capped to.
 *
 * The widest cap in play is `max-w-2xl` (42rem = 672px); the derived-economics
 * cells are capped at `max-w-sm`. A little headroom over the widest, because the
 * assertion is "adjacent enough to read as a pair", not the identity of a
 * Tailwind class.
 */
const MAX_LABEL_TO_FIGURE_PX = 700;

const VIEWPORTS = [
  { name: "desktop-1780", width: 1780, height: 1000 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

/**
 * The widest horizontal gap between any `<dt>` and the `<dd>` it names, and how
 * many pairs were actually laid out.
 *
 * Measured from rectangles rather than read off a class list: the point is what
 * the engine laid out, and a cap overridden by a parent's flex behaviour would
 * still have the right class on it.
 *
 * Direction-agnostic on purpose. In Arabic the label is on the right and the
 * figure on the left, so a signed distance would report RTL as fine while it was
 * exactly as far apart.
 */
async function measureLabelToFigureGaps(
  page: Page,
): Promise<{ widest: number; measured: number; economics: number }> {
  return page.evaluate(() => {
    // The cap applies to every label/figure pair on the deal, so `widest` still
    // sweeps the whole page. `economics` counts the DECISION-CARD split rows —
    // funded by the finance company, not financed, dealership contribution.
    //
    // Those are pairs behind the original complaint: at 1780px they sat at
    // opposite edges of the card, and in Arabic the label and its figure ended
    // up on opposite sides of the screen.
    //
    // PART of it, not all of it. The same commit capped `DecisionRow` — the
    // approved-purchase, appraisal and quotation rows — which was equally part
    // of the zoom-to-50% bug. Those render as <p>, not <dt>/<dd>, so this sweep
    // cannot see them at all and a regression that dropped their cap would pass
    // here silently. Recorded rather than quietly widened: SCRUM-89.
    //
    // Counted separately because the anti-vacuity guard used to ask only whether
    // ANY dt/dd had laid out, and several blocks render their own. It could not
    // distinguish "measured the rows that matter" from "measured whatever was
    // on screen" — and it was passing on these rows by accident rather than by
    // intent.
    //
    // Counted by ROW KIND, not by the enclosing list. The same list also renders
    // Applied LTV, and every row in it is independently nullable, so a count of
    // the list would have been satisfied by that lone percentage with all three
    // money figures missing — the identical vacuity one level in. Only the three
    // money rows count, and the caller asserts there are exactly three.
    const SPLIT_ROWS = ["funded", "unfinanced", "contribution"];
    let widest = 0;
    let measured = 0;
    let economics = 0;
    for (const dt of Array.from(document.querySelectorAll("dt"))) {
      const row = dt.parentElement;
      const dd = row?.querySelector("dd");
      if (!dd) continue;
      const a = dt.getBoundingClientRect();
      const b = dd.getBoundingClientRect();
      if (a.width === 0 || b.width === 0) continue;
      // Same visual row only; a stacked pair is not a reading-distance problem.
      if (Math.abs(a.top - b.top) > 24) continue;
      measured += 1;
      const kind = row?.getAttribute("data-row-kind");
      if (kind !== null && kind !== undefined && SPLIT_ROWS.includes(kind)) {
        economics += 1;
      }
      const gap = Math.max(b.left - a.right, a.left - b.right);
      if (gap > widest) widest = gap;
    }
    return { widest, measured, economics };
  });
}

test.describe.configure({ mode: "serial", timeout: 600_000 });
test.use({ actionTimeout: 25_000 });

test.describe("the deal cockpit's reading measure", () => {
  /**
   * Gated on the CREDENTIALS, for the reason the sibling spec documents at
   * length: a describe-level skip is evaluated at DISCOVERY, so gating on a file
   * the setup project creates makes the suite skip forever behind a green check.
   *
   * Recording the approved amount needs the second identity — the server refuses
   * the deal's own salesperson — and without it there are no derived economics
   * to measure.
   */
  test.skip(
    !process.env.E2E_APPROVER_USER || !process.env.E2E_APPROVER_PASSWORD,
    "No approver identity is provisioned (E2E_APPROVER_USER / E2E_APPROVER_PASSWORD), so the approved amount cannot be recorded and there are no derived economics to measure.",
  );

  /**
   * One deal for all four cases.
   *
   * Serial and shared rather than four deals: building one costs a wizard, two
   * sign-ins and a credit decision, and the four cases differ only in how the
   * SAME deal is rendered. Four identical deals would quadruple the slowest part
   * of this spec to prove nothing extra.
   */
  let dealUrl = "";

  test.beforeAll(async ({ browser }) => {
    // Both storage states are passed explicitly. `browser.newContext()` does
    // NOT inherit the project's `storageState` — that reaches the built-in
    // fixtures only, and `beforeAll` has none — so omitting it opens an
    // anonymous browser that fails at the sign-in redirect.
    const salesContext = await browser.newContext({ storageState: USER_AUTH_FILE });
    const approverContext = await browser.newContext({
      storageState: APPROVER_AUTH_FILE,
    });
    try {
      dealUrl = await buildDealWithRecordedEconomics(
        await salesContext.newPage(),
        await approverContext.newPage(),
        "MEASURE",
      );
    } finally {
      await salesContext.close();
      await approverContext.close();
    }
  });

  for (const locale of ["en", "ar"] as const) {
    for (const viewport of VIEWPORTS) {
      test(`${locale} @ ${viewport.name}: a figure stays beside the label that names it`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          storageState: USER_AUTH_FILE,
          viewport: { width: viewport.width, height: viewport.height },
        });
        try {
          const page = await context.newPage();
          // Set before the app boots. `LanguageProvider` reads this on mount and
          // defaults to Arabic on an empty store, so setting it afterwards would
          // measure whichever direction happened to render first.
          await page.addInitScript((value) => {
            window.localStorage.setItem("autoflow-locale", value);
          }, locale);

          await page.goto(dealUrl);
          await expect(page.getByTestId("deal-next-step")).toBeVisible();

          // The direction really did flip, so an "ar" case that quietly rendered
          // LTR cannot pass as one.
          await expect
            .poll(() => page.evaluate(() => document.documentElement.dir))
            .toBe(locale === "ar" ? "rtl" : "ltr");

          // The split rows arrive on their OWN query, not the one that renders
          // the next-step card, so `deal-next-step` being visible says nothing
          // about whether there is anything to measure yet. CI caught this: one
          // Arabic attempt measured 0 pairs and only passed on retry — a gate
          // that depends on a retry is not a gate, and the same race could
          // equally have measured a half-laid-out row and passed it.
          //
          // Polled rather than slept: the wait ends when the rows are actually
          // there, and the anti-vacuity assertion below still fails honestly if
          // they never arrive.
          await expect
            .poll(async () => (await measureLabelToFigureGaps(page)).economics, {
              message: "the decision card's split rows never laid out",
            })
            .toBeGreaterThan(0);

          const { widest, measured, economics } = await measureLabelToFigureGaps(page);
          await page.screenshot({
            path: `playwright/.gate/deal-cockpit-${locale}-${viewport.name}.png`,
            fullPage: true,
          });

          // Asserted BEFORE the distance, because a widest-gap of zero is what a
          // page with no rows produces — and "nothing to measure" would
          // otherwise read as "everything measured well".
          //
          // EXACTLY three, not merely more than none. This fixture always
          // records a funded portion, an unfinanced portion and a dealership
          // contribution, so all three must be on screen; "at least one" would
          // let two of them disappear and still pass, which is the same vacuity
          // this assertion exists to remove.
          expect(
            economics,
            "the decision card's three funding-split rows were not all laid out — the reading cap measured something else",
          ).toBe(3);
          // Logged, not asserted: the run then shows how many of the measured
          // pairs were the rows under test, so a future reader can see at a
          // glance that the two counts are not the same thing. They are not
          // equal — the same list also carries Applied LTV, which is a
          // percentage rather than one of the money figures under test.
          console.log(
            `[measure] ${locale} @ ${viewport.name}: ${economics} funding-split rows of ${measured} pairs measured`,
          );
          expect(
            widest,
            `a label and its figure are ${Math.round(widest)}px apart in ${locale} at ${viewport.width}px`,
          ).toBeLessThan(MAX_LABEL_TO_FIGURE_PX);

          // Nothing may push the page sideways at 390px — a horizontal
          // scrollbar on a phone is how a figure ends up off screen entirely.
          const overflow = await page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          );
          expect(overflow, "the page scrolls horizontally").toBeLessThanOrEqual(1);
        } finally {
          await context.close();
        }
      });
    }
  }
});
