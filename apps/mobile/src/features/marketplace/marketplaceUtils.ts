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
