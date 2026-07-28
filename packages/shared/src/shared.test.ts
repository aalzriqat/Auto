import { describe, expect, test } from "vitest";
import {
  buildWhatsAppDeepLink,
  isRtlLocale,
  nativeRoutes,
  normalizeLocale,
} from ".";
import { mobileFoundationStringEntriesForTest } from "./i18n";

describe("i18n string table", () => {
  test("rejects duplicate string keys", () => {
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    mobileFoundationStringEntriesForTest.forEach(([key], index) => {
      if (seen.has(key)) {
        duplicates.push(`"${key}" (index ${seen.get(key)} overridden by index ${index})`);
      } else {
        seen.set(key, index);
      }
    });
    // Object.fromEntries lets the LAST entry win, so a duplicate silently
    // replaces an earlier string with an unrelated one. TypeScript can't catch
    // it in an array of tuples — this test is the only guard.
    expect(duplicates).toEqual([]);
  });

  test("every key has a non-empty English and Arabic string", () => {
    const bad = mobileFoundationStringEntriesForTest
      .filter(([, en, ar]) => !en?.trim() || !ar?.trim())
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });
});

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
    expect(nativeRoutes.orgHome).toBe("/org/[orgId]/home");
    expect(nativeRoutes.orgModule).toBe("/org/[orgId]/module/[moduleId]");
  });

  test("builds WhatsApp human-send links", () => {
    expect(buildWhatsAppDeepLink("+962 7 9999 0000", "Hello AutoFlow")).toBe(
      "https://wa.me/962799990000?text=Hello%20AutoFlow",
    );
  });
});
