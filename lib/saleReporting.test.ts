import { describe, expect, test } from "vitest";
import {
  recognizedRevenueOf,
  sumRecognizedRevenue,
  sumReportedCost,
  sumReportedProfit,
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
