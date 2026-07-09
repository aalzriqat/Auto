import { expect, test, describe } from "vitest";
import { classifyTrafficSource, extractClickId } from "./trafficSource";

describe("classifyTrafficSource", () => {
  test("fbclid wins over any referrer", () => {
    const result = classifyTrafficSource({
      referrerHost: "example.com",
      ownHosts: ["bloomcars.autoflowdealer.com"],
      clickIdType: "fbclid",
    });
    expect(result).toEqual({ label: "Facebook Ads", isInternal: false });
  });

  test("gclid is classified as Google Ads", () => {
    const result = classifyTrafficSource({ ownHosts: [], clickIdType: "gclid" });
    expect(result.label).toBe("Google Ads");
  });

  test("Instagram in-app browser with stripped referrer still classified via igshid", () => {
    const result = classifyTrafficSource({
      referrerHost: undefined,
      ownHosts: [],
      clickIdType: "igshid",
    });
    expect(result.label).toBe("Instagram");
  });

  test("explicit UTM source wins over referrer when no click-id present", () => {
    const result = classifyTrafficSource({
      referrerHost: "google.com",
      ownHosts: [],
      utmSource: "newsletter",
      utmMedium: "email",
    });
    expect(result.label).toBe("newsletter (email)");
  });

  test("own host referrer is classified as internal navigation", () => {
    const result = classifyTrafficSource({
      referrerHost: "bloomcars.autoflowdealer.com",
      ownHosts: ["bloomcars.autoflowdealer.com"],
    });
    expect(result).toEqual({ label: "Internal navigation", isInternal: true });
  });

  test("www prefix is normalized when matching own hosts", () => {
    const result = classifyTrafficSource({
      referrerHost: "www.bloomcars.autoflowdealer.com",
      ownHosts: ["bloomcars.autoflowdealer.com"],
    });
    expect(result.isInternal).toBe(true);
  });

  test("known search engine referrer is organic search", () => {
    const result = classifyTrafficSource({ referrerHost: "www.google.com", ownHosts: [] });
    expect(result.label).toBe("Google (organic search)");
  });

  test("known social referrer is classified by platform", () => {
    const result = classifyTrafficSource({ referrerHost: "m.facebook.com", ownHosts: [] });
    expect(result.label).toBe("Facebook");
  });

  test("no referrer and no UTM/click-id is Direct", () => {
    const result = classifyTrafficSource({ ownHosts: [] });
    expect(result).toEqual({ label: "Direct", isInternal: false });
  });

  test("unknown referrer falls back to a labeled referral", () => {
    const result = classifyTrafficSource({ referrerHost: "some-blog.example", ownHosts: [] });
    expect(result.label).toBe("Referral: some-blog.example");
  });
});

describe("extractClickId", () => {
  test("returns fbclid when present", () => {
    const params = new URLSearchParams("fbclid=abc123&utm_source=x");
    expect(extractClickId(params)).toEqual({ type: "fbclid", value: "abc123" });
  });

  test("returns gclid when present without fbclid", () => {
    const params = new URLSearchParams("gclid=xyz789");
    expect(extractClickId(params)).toEqual({ type: "gclid", value: "xyz789" });
  });

  test("returns empty object when no known click-id param is present", () => {
    const params = new URLSearchParams("utm_source=newsletter");
    expect(extractClickId(params)).toEqual({});
  });
});
