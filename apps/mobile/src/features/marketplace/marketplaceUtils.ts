import type {
  MobileBuyerIntent,
  MobileMarketplaceRequestStatus,
  MobileMarketplaceResponseKind,
  MobileMarketplaceVehicle,
  MobilePaymentType,
  MobileTradeInCondition,
  MobileTradeInStatus,
} from "../../convexApi";

export type MarketplaceStringKey =
  | "marketplaceIntentCold"
  | "marketplaceIntentWarm"
  | "marketplaceIntentHot"
  | "marketplacePaymentCash"
  | "marketplacePaymentFinance"
  | "marketplacePaymentEither"
  | "marketplaceResponseHaveMatch"
  | "marketplaceResponseHaveSimilar"
  | "marketplaceResponseCanSource"
  | "marketplaceResponseNotAvailable"
  | "marketplaceRequestStatusOpen"
  | "marketplaceRequestStatusMatched"
  | "marketplaceRequestStatusOffersReceived"
  | "marketplaceRequestStatusAccepted"
  | "marketplaceRequestStatusCompleted"
  | "marketplaceRequestStatusFulfilled"
  | "marketplaceRequestStatusExpired"
  | "marketplaceRequestStatusSpam"
  | "marketplaceTradeInPending"
  | "marketplaceTradeInOffered"
  | "marketplaceTradeInAccepted"
  | "marketplaceTradeInDeclined"
  | "marketplaceConditionExcellent"
  | "marketplaceConditionGood"
  | "marketplaceConditionFair"
  | "marketplaceConditionPoor";

export function trimOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseOptionalPositiveNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return parsed;
}

export function parseOptionalWholeNumber(value: string): number | undefined {
  const parsed = parseOptionalPositiveNumber(value);
  if (parsed === undefined) return undefined;
  return Math.floor(parsed);
}

export function buildMarketplaceClientFingerprint(args: {
  visitorId: string;
  locale: string;
  timeZone: string;
  platform: string;
  screenSize: string;
}): string {
  return [
    args.visitorId.trim(),
    args.locale.trim() || "unknown",
    args.timeZone.trim() || "unknown",
    args.platform.trim() || "native",
    args.screenSize.trim() || "unknown",
  ]
    .filter(Boolean)
    .join(":")
    .slice(0, 256);
}

export type TurnstileMessage =
  | { type: "token"; token: string }
  | { type: "expired" }
  | { type: "error"; code?: string };

export function parseTurnstileMessage(rawMessage: string): TurnstileMessage | null {
  try {
    const parsed: unknown = JSON.parse(rawMessage);
    if (!parsed || typeof parsed !== "object") return null;

    const payload = parsed as Record<string, unknown>;
    if (payload.type === "token" && typeof payload.token === "string" && payload.token.trim()) {
      return { type: "token", token: payload.token };
    }

    if (payload.type === "expired") {
      return { type: "expired" };
    }

    if (payload.type === "error") {
      return {
        type: "error",
        code: typeof payload.code === "string" ? payload.code : undefined,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function formatNumber(value: number, locale: "en" | "ar"): string {
  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-US", {
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return Math.round(value).toString();
  }
}

export function formatMoney(value: number | null | undefined, locale: "en" | "ar"): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${formatNumber(value, locale)} JOD`;
}

export function getVehicleTitle(vehicle: Pick<MobileMarketplaceVehicle, "year" | "make" | "model" | "trim">): string {
  return [vehicle.year || null, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");
}

export function getListingUrl(vehicle: Pick<MobileMarketplaceVehicle, "siteUrl" | "slug">): string | null {
  if (!vehicle.siteUrl) return null;
  return `${vehicle.siteUrl.replace(/\/$/u, "")}/inventory/${encodeURIComponent(vehicle.slug)}`;
}

/** Digits-only phone (drops spaces, dashes, parentheses, and a leading +). Returns null when nothing dialable remains. */
export function normalizePhoneDigits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/gu, "");
  return digits.length > 0 ? digits : null;
}

/** `tel:` deep-link preserving a leading + so the dialer keeps the country code. Null when the number has no digits. */
export function buildTelUrl(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = normalizePhoneDigits(phone);
  if (!digits) return null;
  return phone.trim().startsWith("+") ? `tel:+${digits}` : `tel:${digits}`;
}

/** `wa.me` deep-link (international digits only, no +) with an optional prefilled message. Null when the number has no digits. */
export function buildWhatsappUrl(phone: string | null | undefined, message?: string): string | null {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return null;
  const base = `https://wa.me/${digits}`;
  const text = message?.trim();
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/** How many days a car is flagged "New" in the marketplace after being listed. */
export const RECENTLY_LISTED_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True when the car was listed within the last {@link RECENTLY_LISTED_DAYS} days. Null/future timestamps are treated as not-new. */
export function isRecentlyListed(listedAt: number | null | undefined, now: number = Date.now()): boolean {
  if (listedAt == null) return false;
  const ageMs = now - listedAt;
  return ageMs >= 0 && ageMs <= RECENTLY_LISTED_DAYS * DAY_MS;
}

export function getBuyerIntentKey(intent: MobileBuyerIntent): MarketplaceStringKey {
  switch (intent) {
    case "HOT":
      return "marketplaceIntentHot";
    case "WARM":
      return "marketplaceIntentWarm";
    case "COLD":
      return "marketplaceIntentCold";
  }
}

export function getPaymentTypeKey(paymentType: MobilePaymentType): MarketplaceStringKey {
  switch (paymentType) {
    case "CASH":
      return "marketplacePaymentCash";
    case "FINANCE":
      return "marketplacePaymentFinance";
    case "EITHER":
      return "marketplacePaymentEither";
  }
}

export function getResponseKindKey(kind: MobileMarketplaceResponseKind): MarketplaceStringKey {
  switch (kind) {
    case "HAVE_MATCH":
      return "marketplaceResponseHaveMatch";
    case "HAVE_SIMILAR":
      return "marketplaceResponseHaveSimilar";
    case "CAN_SOURCE":
      return "marketplaceResponseCanSource";
    case "NOT_AVAILABLE":
      return "marketplaceResponseNotAvailable";
  }
}

export function getRequestStatusKey(status: MobileMarketplaceRequestStatus): MarketplaceStringKey {
  switch (status) {
    case "OPEN":
      return "marketplaceRequestStatusOpen";
    case "MATCHED":
      return "marketplaceRequestStatusMatched";
    case "OFFERS_RECEIVED":
      return "marketplaceRequestStatusOffersReceived";
    case "ACCEPTED":
      return "marketplaceRequestStatusAccepted";
    case "COMPLETED":
      return "marketplaceRequestStatusCompleted";
    case "FULFILLED":
      return "marketplaceRequestStatusFulfilled";
    case "EXPIRED":
      return "marketplaceRequestStatusExpired";
    case "SPAM":
      return "marketplaceRequestStatusSpam";
  }
}

export function getTradeInStatusKey(status: MobileTradeInStatus): MarketplaceStringKey {
  switch (status) {
    case "PENDING":
      return "marketplaceTradeInPending";
    case "OFFERED":
      return "marketplaceTradeInOffered";
    case "ACCEPTED":
      return "marketplaceTradeInAccepted";
    case "DECLINED":
      return "marketplaceTradeInDeclined";
  }
}

export function getTradeInConditionKey(condition: MobileTradeInCondition): MarketplaceStringKey {
  switch (condition) {
    case "EXCELLENT":
      return "marketplaceConditionExcellent";
    case "GOOD":
      return "marketplaceConditionGood";
    case "FAIR":
      return "marketplaceConditionFair";
    case "POOR":
      return "marketplaceConditionPoor";
  }
}
