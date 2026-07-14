import {
  buildMarketplaceClientFingerprint,
  formatMoney,
  getBuyerIntentKey,
  getListingUrl,
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
    expect(parseOptionalPositiveNumber("12000")).toBe(12000);
    expect(parseOptionalPositiveNumber("-1")).toBeUndefined();
    expect(parseOptionalPositiveNumber("abc")).toBeUndefined();
    expect(parseOptionalWholeNumber("2024.8")).toBe(2024);
  });

  it("formats vehicle titles and listing URLs", () => {
    expect(getVehicleTitle({ year: 2024, make: "Toyota", model: "Camry", trim: "Hybrid" })).toBe(
      "2024 Toyota Camry Hybrid",
    );
    expect(getListingUrl({ siteUrl: "https://dealer.example/", slug: "camry hybrid" })).toBe(
      "https://dealer.example/inventory/camry%20hybrid",
    );
  });

  it("maps labels without leaking raw enum names into UI", () => {
    expect(getBuyerIntentKey("HOT")).toBe("marketplaceIntentHot");
    expect(formatMoney(12500, "en")).toContain("JOD");
  });

  it("parses Turnstile bridge messages defensively", () => {
    expect(parseTurnstileMessage(JSON.stringify({ type: "token", token: "abc" }))).toEqual({
      type: "token",
      token: "abc",
    });
    expect(parseTurnstileMessage(JSON.stringify({ type: "expired" }))).toEqual({ type: "expired" });
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
  });
});
