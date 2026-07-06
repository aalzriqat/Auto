import { afterEach, describe, expect, it } from "vitest";
import { isDealerWebsiteHost, normalizedHost } from "./dealerHost";

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (originalAppUrl === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
    return;
  }

  process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
});

describe("normalizedHost", () => {
  it("lowercases hosts and strips ports", () => {
    expect(normalizedHost("BloomCars.AutoFlowDealer.com:443")).toBe(
      "bloomcars.autoflowdealer.com",
    );
  });
});

describe("isDealerWebsiteHost", () => {
  it("recognizes AutoFlow dealer subdomains", () => {
    expect(isDealerWebsiteHost("bloomcars.autoflowdealer.com")).toBe(true);
  });

  it("recognizes custom dealer domains", () => {
    expect(isDealerWebsiteHost("premiumcarsjo.com")).toBe(true);
  });

  it("excludes platform, local, configured app, and Vercel hosts", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.autoflowdealer.com";

    expect(isDealerWebsiteHost("autoflowdealer.com")).toBe(false);
    expect(isDealerWebsiteHost("www.autoflowdealer.com")).toBe(false);
    expect(isDealerWebsiteHost("localhost:3000")).toBe(false);
    expect(isDealerWebsiteHost("127.0.0.1:3000")).toBe(false);
    expect(isDealerWebsiteHost("app.autoflowdealer.com")).toBe(false);
    expect(isDealerWebsiteHost("auto-preview.vercel.app")).toBe(false);
  });
});
