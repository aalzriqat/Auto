export interface MobileEnv {
  clerkPublishableKey: string;
  convexSiteUrl?: string;
  convexUrl: string;
  appScheme: string;
  appUrl?: string;
  turnstileSiteKey?: string;
}

export type EnvValidationResult =
  | { success: true; data: MobileEnv }
  | { success: false; message: string };

type RawEnv = Record<string, string | undefined>;

function getBuildEnv(): RawEnv {
  return {
    EXPO_PUBLIC_CONVEX_URL: process.env.EXPO_PUBLIC_CONVEX_URL,
    EXPO_PUBLIC_CONVEX_SITE_URL: process.env.EXPO_PUBLIC_CONVEX_SITE_URL,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
    EXPO_PUBLIC_APP_SCHEME: process.env.EXPO_PUBLIC_APP_SCHEME,
    EXPO_PUBLIC_APP_URL: process.env.EXPO_PUBLIC_APP_URL,
    EXPO_PUBLIC_TURNSTILE_SITE_KEY: process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*$/i.test(value);
}

export function validateMobileEnv(raw: RawEnv = getBuildEnv()): EnvValidationResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const convexUrl = raw.EXPO_PUBLIC_CONVEX_URL?.trim();
  const convexSiteUrl = raw.EXPO_PUBLIC_CONVEX_SITE_URL?.trim() || undefined;
  const clerkPublishableKey = raw.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  const appScheme = raw.EXPO_PUBLIC_APP_SCHEME?.trim() || "autoflow";
  const appUrl = raw.EXPO_PUBLIC_APP_URL?.trim() || undefined;
  const turnstileSiteKey = raw.EXPO_PUBLIC_TURNSTILE_SITE_KEY?.trim() || undefined;

  if (!convexUrl) missing.push("EXPO_PUBLIC_CONVEX_URL");
  if (!clerkPublishableKey) missing.push("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
  if (convexUrl && !isHttpUrl(convexUrl)) invalid.push("EXPO_PUBLIC_CONVEX_URL");
  if (convexSiteUrl && !isHttpUrl(convexSiteUrl)) invalid.push("EXPO_PUBLIC_CONVEX_SITE_URL");
  if (appUrl && !isHttpUrl(appUrl)) invalid.push("EXPO_PUBLIC_APP_URL");
  if (!isSafeScheme(appScheme)) invalid.push("EXPO_PUBLIC_APP_SCHEME");

  if (missing.length || invalid.length) {
    const parts = [
      missing.length ? `Missing: ${missing.join(", ")}` : "",
      invalid.length ? `Invalid: ${invalid.join(", ")}` : "",
    ].filter(Boolean);

    return {
      success: false,
      message: parts.join(". "),
    };
  }

  return {
    success: true,
    data: {
      convexUrl: convexUrl as string,
      convexSiteUrl,
      clerkPublishableKey: clerkPublishableKey as string,
      appScheme,
      appUrl,
      turnstileSiteKey,
    },
  };
}

export function getMobileEnv(raw?: RawEnv): MobileEnv {
  const result = validateMobileEnv(raw);
  if (!result.success) {
    throw new Error(result.message);
  }

  return result.data;
}

export function getMobileAppUrl(raw: RawEnv = getBuildEnv()): string | undefined {
  const appUrl = raw.EXPO_PUBLIC_APP_URL?.trim() || undefined;
  return appUrl && isHttpUrl(appUrl) ? appUrl : undefined;
}
