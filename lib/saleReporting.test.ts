import { describe, expect, test } from "vitest";
import {
  countUnknownMargin,
  marginIsUnknown,
  performanceMarginIsIncomplete,
  recognizedRevenueOf,
  sumRecognizedRevenue,
  sumReportedCost,
  sumReportedProfit,
  unknownMarginCountOf,
} from "./saleReporting";

/**
 * The reports page re-sums its rows locally so the totals follow the
 * salesperson filter. That makes it a second place that decides what "revenue"
 * means, and it answered `salePrice` — the sticker price of a car the
 * dealership never owned. The revenue card showed 12,500 of turnover beside a
 * cost column reading 0, because the backend had already stopped counting the
 * cost of a consigned car while the client still counted its price.
 */

const AGENT_SALE = { salePrice: 12_500, recognizedRevenue: 3_000, totalCost: 0, netProfit: 3_000 };
const OWNED_SALE = { salePrice: 8_000, recognizedRevenue: 8_000, totalCost: 6_000, netProfit: 2_000 };

describe("what the client counts as revenue", () => {
  test("a consigned sale contributes its margin, not the car's price", () => {
    expect(recognizedRevenueOf(AGENT_SALE)).toBe(3_000);
  });

  test("an owned sale contributes the price, which is the same thing for it", () => {
    expect(recognizedRevenueOf(OWNED_SALE)).toBe(8_000);
  });

  test("a filtered total matches what the backend would report unfiltered", () => {
    // 3,000 of commission plus 8,000 of vehicle revenue — not 20,500.
    expect(sumRecognizedRevenue([AGENT_SALE, OWNED_SALE])).toBe(11_000);
  });

  test("revenue less cost still equals profit, so the three cards agree", () => {
    const rows = [AGENT_SALE, OWNED_SALE];
    expect(sumRecognizedRevenue(rows) - sumReportedCost(rows)).toBe(sumReportedProfit(rows));
  });
});

describe("rows that do not carry the field", () => {
  test("a client running ahead of the backend falls back to the price", () => {
    // Better the old number than a blank card. For owned stock — everything
    // that existed before consigned accounting — the two are identical anyway.
    expect(recognizedRevenueOf({ salePrice: 8_000 })).toBe(8_000);
  });

  test("missing and non-finite values contribute nothing rather than NaN", () => {
    // One bad row must not blank the whole card. Convex accepts NaN as a
    // v.number(), so this is reachable rather than defensive.
    expect(recognizedRevenueOf({})).toBe(0);
    expect(recognizedRevenueOf({ salePrice: null })).toBe(0);
    expect(recognizedRevenueOf({ recognizedRevenue: NaN, salePrice: 8_000 })).toBe(8_000);
    expect(sumRecognizedRevenue([AGENT_SALE, {}, { salePrice: NaN }])).toBe(3_000);
  });

  test("an absent list is zero, not a crash", () => {
    expect(sumRecognizedRevenue(undefined)).toBe(0);
    expect(sumReportedCost(null)).toBe(0);
    expect(sumReportedProfit([])).toBe(0);
  });
});

/**
 * SCRUM-30 — a withheld figure and a missing one are not the same row.
 *
 * The backend now answers `null` when it cannot establish what a deal earned: a
 * financed sale settled directly with the supplier whose recorded margin is
 * gone. The fallback directly above exists for the OTHER case — a field the
 * backend has not started sending yet — and applying it to a withheld value
 * would answer with the sale price, which on exactly these rows is the largest
 * wrong number available. A deliberate refusal would have become 20,000.
 */
describe("a figure the backend withheld", () => {
  const WITHHELD = { salePrice: 20_000, recognizedRevenue: null, totalCost: 0, netProfit: null };

  test("is recognized as unknown rather than as an old row", () => {
    expect(marginIsUnknown(WITHHELD)).toBe(true);
    // The genuinely-old row, which must keep its fallback.
    expect(marginIsUnknown({ salePrice: 8_000 })).toBe(false);
  });

  test("contributes nothing, and never the sale price", () => {
    expect(recognizedRevenueOf(WITHHELD)).toBe(0);
    expect(recognizedRevenueOf(WITHHELD)).not.toBe(20_000);
  });

  test("is excluded from the filtered totals the cards are drawn from", () => {
    expect(sumRecognizedRevenue([AGENT_SALE, WITHHELD])).toBe(3_000);
    expect(sumReportedProfit([AGENT_SALE, WITHHELD])).toBe(3_000);
  });

  test("is counted, so an understated total is never shown as complete", () => {
    expect(countUnknownMargin([AGENT_SALE, WITHHELD, OWNED_SALE])).toBe(1);
    expect(countUnknownMargin([AGENT_SALE, OWNED_SALE])).toBe(0);
    expect(countUnknownMargin(undefined)).toBe(0);
  });
});

/**
 * The same absent-versus-withheld distinction, on the salesperson table.
 *
 * `main` auto-deploys the FRONTEND; the Convex backend deploy is manual. So
 * there is a guaranteed window in which this page runs against a server that
 * has never heard of `marginComplete` or `unknownMarginSaleCount`, and every
 * row arrives with both absent.
 *
 * Read as a falsy boolean, absent means "incomplete": every salesperson is
 * marked as having uncounted deals, and `String(undefined)` renders the literal
 * text "undefined not counted" — "undefined غير محتسبة" in Arabic — beside each
 * one, while the notice above the table says zero, because it already defaults
 * with `?? 0`. The rows and the summary contradict each other on the same
 * screen.
 *
 * Absent is a server that has not deployed yet. Only an explicit `false` is the
 * server saying it could not count something.
 */
describe("a performance row from a backend that predates these fields", () => {
  test("is treated as complete, not as incomplete", () => {
    expect(performanceMarginIsIncomplete({})).toBe(false);
    expect(performanceMarginIsIncomplete({ marginComplete: undefined })).toBe(false);
    expect(performanceMarginIsIncomplete({ marginComplete: true })).toBe(false);
    // Only the explicit refusal counts as incomplete.
    expect(performanceMarginIsIncomplete({ marginComplete: false })).toBe(true);
  });

  test("never renders a count of 'undefined'", () => {
    expect(unknownMarginCountOf({})).toBe(0);
    expect(unknownMarginCountOf({ unknownMarginSaleCount: undefined })).toBe(0);
    expect(String(unknownMarginCountOf({}))).not.toBe("undefined");
    expect(unknownMarginCountOf({ unknownMarginSaleCount: 3 })).toBe(3);
  });
});
