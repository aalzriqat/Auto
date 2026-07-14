/// <reference types="jest" />

import { getMobileEnv, validateMobileEnv } from "./env";

describe("mobile env validation", () => {
  test("accepts valid public Expo config", () => {
    expect(
      getMobileEnv({
        EXPO_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
        EXPO_PUBLIC_CONVEX_SITE_URL: "https://example.convex.site",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_123",
        EXPO_PUBLIC_APP_SCHEME: "autoflow",
        EXPO_PUBLIC_APP_URL: "https://autoflowdealer.com",
        EXPO_PUBLIC_TURNSTILE_SITE_KEY: "site_key",
      }),
    ).toEqual({
      convexUrl: "https://example.convex.cloud",
      convexSiteUrl: "https://example.convex.site",
      clerkPublishableKey: "pk_test_123",
      appScheme: "autoflow",
      appUrl: "https://autoflowdealer.com",
      turnstileSiteKey: "site_key",
    });
  });

  test("reports missing and invalid values without exposing secrets", () => {
    const result = validateMobileEnv({
      EXPO_PUBLIC_CONVEX_URL: "not-a-url",
      EXPO_PUBLIC_CONVEX_SITE_URL: "not-a-url",
      EXPO_PUBLIC_APP_SCHEME: "bad scheme",
      EXPO_PUBLIC_APP_URL: "not-a-url",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
      expect(result.message).toContain("EXPO_PUBLIC_CONVEX_URL");
      expect(result.message).toContain("EXPO_PUBLIC_CONVEX_SITE_URL");
      expect(result.message).toContain("EXPO_PUBLIC_APP_SCHEME");
      expect(result.message).toContain("EXPO_PUBLIC_APP_URL");
    }
  });
});
