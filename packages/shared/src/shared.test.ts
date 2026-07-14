import { describe, expect, test } from "vitest";
import {
  buildWhatsAppDeepLink,
  isRtlLocale,
  nativeRoutes,
  normalizeLocale,
} from ".";

describe("shared helpers", () => {
  test("normalizes supported locales", () => {
    expect(normalizeLocale("ar-JO")).toBe("ar");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBe("ar");
    expect(isRtlLocale("ar")).toBe(true);
  });

  test("exposes native route constants", () => {
    expect(nativeRoutes.home).toBe("/");
    expect(nativeRoutes.signIn).toBe("/sign-in");
  });

  test("builds WhatsApp human-send links", () => {
    expect(buildWhatsAppDeepLink("+962 7 9999 0000", "Hello AutoFlow")).toBe(
      "https://wa.me/962799990000?text=Hello%20AutoFlow",
    );
  });
});
