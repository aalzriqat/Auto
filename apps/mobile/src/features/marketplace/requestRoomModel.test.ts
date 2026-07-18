import type { MobileBuyerOffer, MobileBuyerRoom } from "../../convexApi";
import {
  buildTimeline,
  computeCompareHighlights,
  computeOfferExpiry,
  getOfferKindLabelKey,
  isOfferActionable,
} from "./requestRoomModel";

function offer(overrides: Partial<MobileBuyerOffer> = {}): MobileBuyerOffer {
  return {
    responseId: overrides.responseId ?? "r1",
    dealerName: "Bloom Cars",
    dealerBadges: [],
    dealerAvgResponseMinutes: null,
    kind: "HAVE_MATCH",
    cashPriceJod: null,
    financeOffer: null,
    sourcingRange: null,
    vehicle: null,
    note: null,
    expiresAt: null,
    isExpired: false,
    buyerAction: null,
    contactUnlocked: false,
    createdAt: 1000,
    ...overrides,
  };
}

function room(overrides: Partial<MobileBuyerRoom> = {}): MobileBuyerRoom {
  return {
    publicId: "token",
    status: "MATCHED",
    createdAt: 100,
    buyerCity: "Amman",
    paymentType: "FINANCE",
    matchedCount: 0,
    respondedCount: 0,
    offers: [],
    ...overrides,
  };
}

describe("buildTimeline", () => {
  it("shows searching (no matches yet, no offers)", () => {
    const steps = buildTimeline(room({ status: "OPEN", matchedCount: 0, offers: [] }));
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ["received", "done"],
      ["notified", "active"],
      ["firstOffer", "pending"],
      ["accepted", "pending"],
    ]);
  });

  it("marks notified done with the matched count and firstOffer active while waiting", () => {
    const steps = buildTimeline(room({ status: "MATCHED", matchedCount: 3, offers: [] }));
    expect(steps[1]).toMatchObject({ id: "notified", state: "done", count: 3 });
    expect(steps[2]).toMatchObject({ id: "firstOffer", state: "active" });
  });

  it("marks firstOffer done with the responded count once an offer arrives", () => {
    const steps = buildTimeline(
      room({ status: "OFFERS_RECEIVED", matchedCount: 3, respondedCount: 2, offers: [offer({ createdAt: 500 }), offer({ responseId: "r2", createdAt: 800 })] })
    );
    expect(steps[2]).toMatchObject({ id: "firstOffer", state: "done", count: 2, at: 500 });
    expect(steps[3]).toMatchObject({ id: "accepted", state: "pending" });
  });

  it("marks accepted done when the request is ACCEPTED", () => {
    const steps = buildTimeline(room({ status: "ACCEPTED", matchedCount: 1, respondedCount: 1, offers: [offer()] }));
    expect(steps[3]).toMatchObject({ id: "accepted", state: "done" });
  });

  it("marks accepted done when an offer carries the ACCEPTED buyer action even before status catches up", () => {
    const steps = buildTimeline(room({ status: "OFFERS_RECEIVED", matchedCount: 1, respondedCount: 1, offers: [offer({ buyerAction: "ACCEPTED" })] }));
    expect(steps[3].state).toBe("done");
  });

  it("labels firstOffer as done even when only one dealer replied", () => {
    const steps = buildTimeline(room({ status: "OFFERS_RECEIVED", matchedCount: 2, respondedCount: 1, offers: [offer({ createdAt: 700 })] }));
    expect(steps[2]).toMatchObject({ id: "firstOffer", state: "done", count: 1, at: 700 });
  });

  it("still marks notified done from offers when the match rows were never recorded", () => {
    // Defensive: an offer exists but matchedCount is 0 (match row missing).
    const steps = buildTimeline(room({ status: "OFFERS_RECEIVED", matchedCount: 0, respondedCount: 1, offers: [offer()] }));
    expect(steps[1]).toMatchObject({ id: "notified", state: "done" });
    expect(steps[1].count).toBeUndefined();
  });
});

describe("computeOfferExpiry", () => {
  const now = 10_000_000;

  it("returns null when there is no expiry", () => {
    expect(computeOfferExpiry(null, now)).toBeNull();
    expect(computeOfferExpiry(undefined, now)).toBeNull();
  });

  it("flags an already-passed expiry as expired", () => {
    expect(computeOfferExpiry(now - 1, now)).toEqual({ expired: true });
  });

  it("chooses the largest sensible unit", () => {
    expect(computeOfferExpiry(now + 3 * 24 * 60 * 60 * 1000, now)).toEqual({ expired: false, unit: "days", value: 3 });
    expect(computeOfferExpiry(now + 5 * 60 * 60 * 1000, now)).toEqual({ expired: false, unit: "hours", value: 5 });
    expect(computeOfferExpiry(now + 20 * 60 * 1000, now)).toEqual({ expired: false, unit: "minutes", value: 20 });
  });

  it("never shows zero minutes for a still-live offer", () => {
    expect(computeOfferExpiry(now + 30 * 1000, now)).toEqual({ expired: false, unit: "minutes", value: 1 });
  });
});

describe("computeCompareHighlights", () => {
  const cheapMonthly = offer({
    responseId: "cheap",
    financeOffer: { vehiclePrice: 18000, downPayment: 5000, termMonths: 60, monthlyInstallment: 250, totalContractValue: 22000, totalProfit: 3000, insuranceAmount: 1000, commission: 200, processingFees: 100 },
  });
  const cheapTotal = offer({
    responseId: "total",
    financeOffer: { vehiclePrice: 17000, downPayment: 3000, termMonths: 48, monthlyInstallment: 300, totalContractValue: 20000, totalProfit: 2500, insuranceAmount: 900, commission: 200, processingFees: 100 },
  });

  it("flags the lowest monthly, total, and down independently", () => {
    const highlights = computeCompareHighlights([cheapMonthly, cheapTotal]);
    expect([...highlights.lowestMonthly]).toEqual(["cheap"]);
    expect([...highlights.lowestTotal]).toEqual(["total"]);
    expect([...highlights.lowestDown]).toEqual(["total"]);
  });

  it("marks every offer at a tie, never a single crown", () => {
    const a = offer({ responseId: "a", financeOffer: { vehiclePrice: 1, downPayment: 1000, termMonths: 12, monthlyInstallment: 200, totalContractValue: 5000, totalProfit: 1, insuranceAmount: 1, commission: 1, processingFees: 1 } });
    const b = offer({ responseId: "b", financeOffer: { vehiclePrice: 1, downPayment: 1000, termMonths: 12, monthlyInstallment: 200, totalContractValue: 6000, totalProfit: 1, insuranceAmount: 1, commission: 1, processingFees: 1 } });
    const highlights = computeCompareHighlights([a, b]);
    expect(highlights.lowestMonthly).toEqual(new Set(["a", "b"]));
  });

  it("falls back to cash price for total when there is no finance offer", () => {
    const cash = offer({ responseId: "cash", cashPriceJod: 15000 });
    const highlights = computeCompareHighlights([cash, cheapTotal]);
    expect([...highlights.lowestTotal]).toEqual(["cash"]);
  });

  it("returns empty highlight sets when no offer carries a comparable number", () => {
    const bare = offer({ responseId: "bare", financeOffer: null, cashPriceJod: null });
    const highlights = computeCompareHighlights([bare]);
    expect(highlights.lowestMonthly.size).toBe(0);
    expect(highlights.lowestTotal.size).toBe(0);
    expect(highlights.lowestDown.size).toBe(0);
  });
});

describe("offer kind + actionability", () => {
  it("maps reply kinds to consumer labels", () => {
    expect(getOfferKindLabelKey("HAVE_MATCH")).toBe("marketplaceOfferKindMatch");
    expect(getOfferKindLabelKey("HAVE_SIMILAR")).toBe("marketplaceOfferKindSimilar");
    expect(getOfferKindLabelKey("CAN_SOURCE")).toBe("marketplaceOfferKindSource");
    // NOT_AVAILABLE never reaches the buyer, but the mapping stays total.
    expect(getOfferKindLabelKey("NOT_AVAILABLE")).toBe("marketplaceOfferKindSource");
  });

  it("treats declined or expired offers as not actionable", () => {
    expect(isOfferActionable({ isExpired: false, buyerAction: null })).toBe(true);
    expect(isOfferActionable({ isExpired: true, buyerAction: null })).toBe(false);
    expect(isOfferActionable({ isExpired: false, buyerAction: "DECLINED" })).toBe(false);
  });
});
