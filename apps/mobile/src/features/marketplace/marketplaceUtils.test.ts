import {
  buildMarketplaceClientFingerprint,
  buildTelUrl,
  buildWhatsappUrl,
  formatNumber,
  formatMoney,
  getBuyerIntentKey,
  getListingUrl,
  normalizePhoneDigits,
  getPaymentTypeKey,
  getRequestStatusKey,
  getResponseKindKey,
  getTradeInConditionKey,
  getTradeInStatusKey,
  getVehicleTitle,
  parseOptionalPositiveNumber,
  parseOptionalWholeNumber,
  parseTurnstileMessage,
  trimOrUndefined,
} from "./marketplaceUtils";

describe("marketplace mobile helpers", () => {
  it("normalizes optional text and positive numbers", () => {
    expect(trimOrUndefined("  Toyota ")).toBe("Toyota");
    expect(trimOrUndefined("   ")).toBeUndefined();
    expect(parseOptionalPositiveNumber("   ")).toBeUndefined();
    expect(parseOptionalPositiveNumber("12000")).toBe(12000);
    expect(parseOptionalPositiveNumber("0")).toBe(0);
    expect(parseOptionalPositiveNumber("-1")).toBeUndefined();
    expect(parseOptionalPositiveNumber("abc")).toBeUndefined();
    expect(parseOptionalWholeNumber("2024.8")).toBe(2024);
    expect(parseOptionalWholeNumber("abc")).toBeUndefined();
  });

  it("formats vehicle titles and listing URLs", () => {
    expect(getVehicleTitle({ year: 2024, make: "Toyota", model: "Camry", trim: "Hybrid" })).toBe(
      "2024 Toyota Camry Hybrid",
    );
    expect(getVehicleTitle({ year: 0, make: "Toyota", model: "Camry", trim: null })).toBe("Toyota Camry");
    expect(getListingUrl({ siteUrl: "https://dealer.example/", slug: "camry hybrid" })).toBe(
      "https://dealer.example/inventory/camry%20hybrid",
    );
    expect(getListingUrl({ siteUrl: null, slug: "camry" })).toBeNull();
  });

  it("builds tel: and wa.me contact deep-links from dealer numbers", () => {
    expect(normalizePhoneDigits("+962 79 000 0001")).toBe("962790000001");
    expect(normalizePhoneDigits("  ")).toBeNull();
    expect(normalizePhoneDigits(null)).toBeNull();

    // tel: keeps the leading + when the source number had one.
    expect(buildTelUrl("+962 79-000-0001")).toBe("tel:+962790000001");
    expect(buildTelUrl("079 000 0001")).toBe("tel:0790000001");
    expect(buildTelUrl(null)).toBeNull();
    // Truthy but digit-less input passes the first guard, fails the second.
    expect(buildTelUrl("+")).toBeNull();

    // wa.me uses international digits with no +, and prefills the message.
    expect(buildWhatsappUrl("+962790000002")).toBe("https://wa.me/962790000002");
    expect(buildWhatsappUrl("+962790000002", "Hi there")).toBe(
      "https://wa.me/962790000002?text=Hi%20there",
    );
    expect(buildWhatsappUrl(undefined)).toBeNull();
  });

  it("formats localized money values and rejects missing amounts", () => {
    expect(formatMoney(12500, "en")).toContain("JOD");
    expect(formatMoney(12500, "ar")).toContain("JOD");
    expect(formatMoney(null, "en")).toBeNull();
    expect(formatMoney(undefined, "en")).toBeNull();
    expect(formatMoney(Number.NaN, "en")).toBeNull();
  });

  it("falls back to rounded strings when number formatting is unavailable", () => {
    const numberFormat = Intl.NumberFormat;

    try {
      Object.defineProperty(Intl, "NumberFormat", {
        configurable: true,
        value: function ThrowingNumberFormat() {
          throw new Error("Intl unavailable");
        },
      });

      expect(formatNumber(12500.8, "en")).toBe("12501");
    } finally {
      Object.defineProperty(Intl, "NumberFormat", {
        configurable: true,
        value: numberFormat,
      });
    }
  });

  it("parses Turnstile bridge messages defensively", () => {
    expect(parseTurnstileMessage(JSON.stringify({ type: "token", token: "abc" }))).toEqual({
      type: "token",
      token: "abc",
    });
    expect(parseTurnstileMessage(JSON.stringify({ type: "expired" }))).toEqual({ type: "expired" });
    expect(parseTurnstileMessage(JSON.stringify({ type: "error", code: "load-timeout" }))).toEqual({
      type: "error",
      code: "load-timeout",
    });
    expect(parseTurnstileMessage(JSON.stringify({ type: "error", code: 500 }))).toEqual({
      type: "error",
      code: undefined,
    });
    expect(parseTurnstileMessage(JSON.stringify(null))).toBeNull();
    expect(parseTurnstileMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseTurnstileMessage("not-json")).toBeNull();
    expect(parseTurnstileMessage(JSON.stringify({ type: "token", token: "" }))).toBeNull();
  });

  it("builds bounded marketplace fingerprints", () => {
    const fingerprint = buildMarketplaceClientFingerprint({
      visitorId: "visitor",
      locale: "ar",
      timeZone: "Asia/Amman",
      platform: "android",
      screenSize: "1080x1920@3",
    });

    expect(fingerprint).toBe("visitor:ar:Asia/Amman:android:1080x1920@3");
    expect(fingerprint.length).toBeLessThanOrEqual(256);

    const fallbackFingerprint = buildMarketplaceClientFingerprint({
      visitorId: "   ",
      locale: "   ",
      timeZone: " ",
      platform: "",
      screenSize: "",
    });

    expect(fallbackFingerprint).toBe("unknown:unknown:native:unknown");
    expect(
      buildMarketplaceClientFingerprint({
        visitorId: "visitor",
        locale: "en",
        timeZone: "Asia/Amman",
        platform: "ios",
        screenSize: "x".repeat(300),
      }),
    ).toHaveLength(256);
  });

  it.each([
    ["COLD", "marketplaceIntentCold"],
    ["WARM", "marketplaceIntentWarm"],
    ["HOT", "marketplaceIntentHot"],
  ] as const)("maps buyer intent %s to a mobile string key", (intent, expected) => {
    expect(getBuyerIntentKey(intent)).toBe(expected);
  });

  it.each([
    ["CASH", "marketplacePaymentCash"],
    ["FINANCE", "marketplacePaymentFinance"],
    ["EITHER", "marketplacePaymentEither"],
  ] as const)("maps payment type %s to a mobile string key", (paymentType, expected) => {
    expect(getPaymentTypeKey(paymentType)).toBe(expected);
  });

  it.each([
    ["HAVE_MATCH", "marketplaceResponseHaveMatch"],
    ["HAVE_SIMILAR", "marketplaceResponseHaveSimilar"],
    ["CAN_SOURCE", "marketplaceResponseCanSource"],
    ["NOT_AVAILABLE", "marketplaceResponseNotAvailable"],
  ] as const)("maps response kind %s to a mobile string key", (kind, expected) => {
    expect(getResponseKindKey(kind)).toBe(expected);
  });

  it.each([
    ["OPEN", "marketplaceRequestStatusOpen"],
    ["MATCHED", "marketplaceRequestStatusMatched"],
    ["OFFERS_RECEIVED", "marketplaceRequestStatusOffersReceived"],
    ["ACCEPTED", "marketplaceRequestStatusAccepted"],
    ["COMPLETED", "marketplaceRequestStatusCompleted"],
    ["FULFILLED", "marketplaceRequestStatusFulfilled"],
    ["EXPIRED", "marketplaceRequestStatusExpired"],
    ["SPAM", "marketplaceRequestStatusSpam"],
  ] as const)("maps request status %s to a mobile string key", (status, expected) => {
    expect(getRequestStatusKey(status)).toBe(expected);
  });

  it.each([
    ["PENDING", "marketplaceTradeInPending"],
    ["OFFERED", "marketplaceTradeInOffered"],
    ["ACCEPTED", "marketplaceTradeInAccepted"],
    ["DECLINED", "marketplaceTradeInDeclined"],
  ] as const)("maps trade-in status %s to a mobile string key", (status, expected) => {
    expect(getTradeInStatusKey(status)).toBe(expected);
  });

  it.each([
    ["EXCELLENT", "marketplaceConditionExcellent"],
    ["GOOD", "marketplaceConditionGood"],
    ["FAIR", "marketplaceConditionFair"],
    ["POOR", "marketplaceConditionPoor"],
  ] as const)("maps trade-in condition %s to a mobile string key", (condition, expected) => {
    expect(getTradeInConditionKey(condition)).toBe(expected);
  });
});
