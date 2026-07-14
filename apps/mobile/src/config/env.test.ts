/// <reference types="jest" />

import { getMobileEnv, validateMobileEnv } from "./env";

const PUBLIC_ENV_KEYS = [
  "EXPO_PUBLIC_CONVEX_URL",
  "EXPO_PUBLIC_CONVEX_SITE_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_APP_SCHEME",
  "EXPO_PUBLIC_APP_URL",
  "EXPO_PUBLIC_TURNSTILE_SITE_KEY",
] as const;

type PublicEnvKey = (typeof PUBLIC_ENV_KEYS)[number];
type PublicEnvSnapshot = Record<PublicEnvKey, string | undefined>;

function snapshotPublicEnv(): PublicEnvSnapshot {
  return PUBLIC_ENV_KEYS.reduce<PublicEnvSnapshot>((snapshot, key) => {
    snapshot[key] = process.env[key];
    return snapshot;
  }, {} as PublicEnvSnapshot);
}

function restorePublicEnv(snapshot: PublicEnvSnapshot): void {
  for (const key of PUBLIC_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

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

  test("loads public Expo config from the process environment", () => {
    const snapshot = snapshotPublicEnv();

    try {
      process.env.EXPO_PUBLIC_CONVEX_URL = "https://build.convex.cloud";
      delete process.env.EXPO_PUBLIC_CONVEX_SITE_URL;
      process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_build";
      delete process.env.EXPO_PUBLIC_APP_SCHEME;
      delete process.env.EXPO_PUBLIC_APP_URL;
      delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;

      expect(validateMobileEnv()).toEqual({
        success: true,
        data: {
          convexUrl: "https://build.convex.cloud",
          convexSiteUrl: undefined,
          clerkPublishableKey: "pk_live_build",
          appScheme: "autoflow",
          appUrl: undefined,
          turnstileSiteKey: undefined,
        },
      });
    } finally {
      restorePublicEnv(snapshot);
    }
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

  test("separates missing values from invalid values", () => {
    const missingOnly = validateMobileEnv({
      EXPO_PUBLIC_APP_SCHEME: "autoflow",
    });
    const invalidOnly = validateMobileEnv({
      EXPO_PUBLIC_CONVEX_URL: "ftp://example.convex.cloud",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_123",
      EXPO_PUBLIC_APP_SCHEME: "autoflow",
    });

    expect(missingOnly).toEqual({
      success: false,
      message: "Missing: EXPO_PUBLIC_CONVEX_URL, EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    });
    expect(invalidOnly).toEqual({
      success: false,
      message: "Invalid: EXPO_PUBLIC_CONVEX_URL",
    });
  });

  test("throws a clean configuration error when required public config is missing", () => {
    expect(() =>
      getMobileEnv({
        EXPO_PUBLIC_CONVEX_URL: "",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      }),
    ).toThrow("Missing: EXPO_PUBLIC_CONVEX_URL, EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
  });
});
