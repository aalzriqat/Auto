import type {
  MobileBuyerOffer,
  MobileBuyerRoom,
  MobileMarketplaceResponseKind,
} from "../../convexApi";

/**
 * Pure, render-free logic for the buyer's Request Room. Kept out of the screen
 * so the timeline, expiry countdown, and compare highlights are unit-testable
 * without React Native. Every value here maps to a real backend fact — no
 * invented progress or fake dealer counts (house design rule: real state only).
 */

export type TimelineStepId =
  | "received"
  | "notified"
  | "firstOffer"
  | "accepted";

export type TimelineStepState = "done" | "active" | "pending";

export interface TimelineStep {
  id: TimelineStepId;
  state: TimelineStepState;
  /** Dealer/offer count for steps that render one; omitted otherwise. */
  count?: number;
  /** Timestamp the step became true, when known. */
  at?: number;
}

/** Earliest createdAt among offers. Callers only invoke this with a non-empty list. */
function earliestOfferTime(offers: readonly MobileBuyerOffer[]): number {
  return offers.reduce((min, offer) => Math.min(min, offer.createdAt), offers[0].createdAt);
}

/**
 * Builds the Request Room timeline from the room feed. Steps are always
 * returned in order; each carries a state so the UI can render done/active/
 * pending without deciding business logic itself.
 */
export function buildTimeline(room: Pick<MobileBuyerRoom, "status" | "createdAt" | "matchedCount" | "respondedCount" | "offers">): TimelineStep[] {
  const hasOffers = room.offers.length > 0;
  const accepted =
    room.status === "ACCEPTED" ||
    room.status === "COMPLETED" ||
    room.offers.some((offer) => offer.buyerAction === "ACCEPTED");

  const received: TimelineStep = { id: "received", state: "done", at: room.createdAt };

  let notified: TimelineStep;
  if (room.matchedCount > 0) {
    notified = { id: "notified", state: "done", count: room.matchedCount, at: room.createdAt };
  } else {
    // No dealers matched yet — the search step is the live one.
    notified = { id: "notified", state: hasOffers ? "done" : "active" };
  }

  let firstOffer: TimelineStep;
  if (hasOffers) {
    firstOffer = {
      id: "firstOffer",
      state: "done",
      count: room.respondedCount,
      at: earliestOfferTime(room.offers),
    };
  } else {
    firstOffer = { id: "firstOffer", state: room.matchedCount > 0 ? "active" : "pending" };
  }

  const acceptedStep: TimelineStep = {
    id: "accepted",
    state: accepted ? "done" : "pending",
  };

  return [received, notified, firstOffer, acceptedStep];
}

export type OfferExpiry =
  | { expired: true }
  | { expired: false; unit: "days" | "hours" | "minutes"; value: number };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Turns a finance-offer expiry timestamp into a coarse countdown, choosing the
 * largest sensible unit. Returns null when the offer has no expiry at all.
 */
export function computeOfferExpiry(expiresAt: number | null | undefined, now: number): OfferExpiry | null {
  if (expiresAt == null) return null;
  const remaining = expiresAt - now;
  if (remaining <= 0) return { expired: true };
  if (remaining >= DAY_MS) return { expired: false, unit: "days", value: Math.floor(remaining / DAY_MS) };
  if (remaining >= HOUR_MS) return { expired: false, unit: "hours", value: Math.floor(remaining / HOUR_MS) };
  return { expired: false, unit: "minutes", value: Math.max(1, Math.floor(remaining / MINUTE_MS)) };
}

export interface CompareHighlights {
  lowestMonthly: Set<string>;
  lowestTotal: Set<string>;
  lowestDown: Set<string>;
}

function collectMinima(
  offers: readonly MobileBuyerOffer[],
  pick: (offer: MobileBuyerOffer) => number | null | undefined
): Set<string> {
  const withValue = offers
    .map((offer) => ({ id: offer.responseId, value: pick(offer) }))
    .filter((entry): entry is { id: string; value: number } => typeof entry.value === "number");
  if (withValue.length === 0) return new Set();

  const min = withValue.reduce((acc, entry) => Math.min(acc, entry.value), withValue[0].value);
  return new Set(withValue.filter((entry) => entry.value === min).map((entry) => entry.id));
}

/**
 * Flags which of the compared offers win on each axis (lowest monthly / total /
 * down payment). Ties flag every offer at the minimum — there is deliberately
 * no single "best" crown (house design rule).
 */
export function computeCompareHighlights(offers: readonly MobileBuyerOffer[]): CompareHighlights {
  return {
    lowestMonthly: collectMinima(offers, (offer) => offer.financeOffer?.monthlyInstallment),
    lowestTotal: collectMinima(offers, (offer) => offer.financeOffer?.totalContractValue ?? offer.cashPriceJod),
    lowestDown: collectMinima(offers, (offer) => offer.financeOffer?.downPayment),
  };
}

export type OfferKindLabelKey =
  | "marketplaceOfferKindMatch"
  | "marketplaceOfferKindSimilar"
  | "marketplaceOfferKindSource";

/** Consumer-facing label for a dealer reply kind (NOT_AVAILABLE never reaches the buyer). */
export function getOfferKindLabelKey(kind: MobileMarketplaceResponseKind): OfferKindLabelKey {
  switch (kind) {
    case "HAVE_MATCH":
      return "marketplaceOfferKindMatch";
    case "HAVE_SIMILAR":
      return "marketplaceOfferKindSimilar";
    case "CAN_SOURCE":
    case "NOT_AVAILABLE":
      return "marketplaceOfferKindSource";
  }
}

/** True when the offer can be shortlisted/compared/accepted (not declined or expired). */
export function isOfferActionable(offer: Pick<MobileBuyerOffer, "isExpired" | "buyerAction">): boolean {
  return !offer.isExpired && offer.buyerAction !== "DECLINED";
}
