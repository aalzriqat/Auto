import { expect, test, describe } from "vitest";
import { parseUserAgent, isLikelyBot } from "./userAgent";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const DESKTOP_FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0";
const DESKTOP_CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FACEBOOK_CRAWLER = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const CURL_UA = "curl/8.4.0";

describe("parseUserAgent", () => {
  test("parses iPhone Safari", () => {
    expect(parseUserAgent(IPHONE_SAFARI)).toEqual({
      deviceType: "mobile",
      browserName: "Safari",
      osName: "iOS",
    });
  });

  test("parses Android Chrome", () => {
    expect(parseUserAgent(ANDROID_CHROME)).toEqual({
      deviceType: "mobile",
      browserName: "Chrome",
      osName: "Android",
    });
  });

  test("parses desktop Firefox on Windows", () => {
    expect(parseUserAgent(DESKTOP_FIREFOX)).toEqual({
      deviceType: "desktop",
      browserName: "Firefox",
      osName: "Windows",
    });
  });

  test("parses desktop Chrome on macOS", () => {
    expect(parseUserAgent(DESKTOP_CHROME_MAC)).toEqual({
      deviceType: "desktop",
      browserName: "Chrome",
      osName: "macOS",
    });
  });

  test("returns Other/unknown for a missing UA", () => {
    expect(parseUserAgent(undefined)).toEqual({
      deviceType: "unknown",
      browserName: "Other",
      osName: "Other",
    });
  });
});

describe("isLikelyBot", () => {
  test("flags a known crawler UA", () => {
    expect(isLikelyBot(FACEBOOK_CRAWLER)).toBe(true);
  });

  test("flags curl", () => {
    expect(isLikelyBot(CURL_UA)).toBe(true);
  });

  test("does not flag a normal desktop browser", () => {
    expect(isLikelyBot(DESKTOP_CHROME_MAC)).toBe(false);
  });

  test("does not flag a normal mobile browser", () => {
    expect(isLikelyBot(IPHONE_SAFARI)).toBe(false);
  });

  test("does not flag a missing UA", () => {
    expect(isLikelyBot(undefined)).toBe(false);
  });
});
