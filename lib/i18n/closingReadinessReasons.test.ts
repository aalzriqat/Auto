import { describe, expect, test } from "vitest";
import { salesAr, salesEn } from "./domains/sales";
import { CLOSING_READINESS_REASON_CODES, closingReasonMessageKey } from "../closingReadinessReasonCodes";

/**
 * SCRUM-414: every closing-readiness reason code the server can emit is
 * translated in BOTH locales, with the same placeholders — so the Arabic panel
 * never shows an untranslated code, and never a `{param}` it was not given.
 */
const en = salesEn as Record<string, string | undefined>;
const ar = salesAr as Record<string, string | undefined>;
const ARABIC = /[؀-ۿ]/;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("closing-readiness reason codes", () => {
  test.each(CLOSING_READINESS_REASON_CODES.map((code) => [code]))("%s has an English and an Arabic translation", (code) => {
    const key = closingReasonMessageKey(code);
    const english = en[key];
    const arabic = ar[key];
    expect(english, `${key} (en)`).toEqual(expect.any(String));
    expect(arabic, `${key} (ar)`).toEqual(expect.any(String));
    expect(english!.trim()).not.toBe("");
    expect(arabic).toMatch(ARABIC);
    expect(placeholders(arabic!)).toEqual(placeholders(english!));
  });

  test("the list names each code once", () => {
    expect(new Set(CLOSING_READINESS_REASON_CODES).size).toBe(CLOSING_READINESS_REASON_CODES.length);
  });
});
