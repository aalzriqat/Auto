import { describe, expect, test } from "vitest";
import { salesAr, salesEn } from "./domains/sales";
import {
  CLOSING_READINESS_REASON_CODES,
  WITHHELD_CLOSING_READINESS_REASON_CODES,
  closingReasonMessageKey,
  closingReasonParamNames,
} from "../closingReadinessReasonCodes";

/**
 * SCRUM-414: every closing-readiness reason code the server can emit is
 * translated in BOTH locales, each with exactly the placeholders the code
 * declares (`CLOSING_READINESS_REASON_PARAMS`) — so the panel never shows an
 * untranslated code, never a `{param}` it was not given, and never drops one.
 */
const en = salesEn as Record<string, string | undefined>;
const ar = salesAr as Record<string, string | undefined>;
const ARABIC = /[؀-ۿ]/;
/** The distinct `{name}` placeholders of a message, sorted (a name may appear twice). */
const placeholders = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

describe("closing-readiness reason codes", () => {
  test.each(CLOSING_READINESS_REASON_CODES.map((code) => [code]))("%s has an English and an Arabic translation", (code) => {
    const key = closingReasonMessageKey(code);
    const english = en[key];
    const arabic = ar[key];
    expect(english, `${key} (en)`).toEqual(expect.any(String));
    expect(arabic, `${key} (ar)`).toEqual(expect.any(String));
    expect(english!.trim()).not.toBe("");
    expect(arabic).toMatch(ARABIC);
    const declared = [...closingReasonParamNames(code)].sort();
    expect(placeholders(english!), `${key} (en) placeholders`).toEqual(declared);
    expect(placeholders(arabic!), `${key} (ar) placeholders`).toEqual(declared);
  });

  test("the list names each code once", () => {
    expect(new Set(CLOSING_READINESS_REASON_CODES).size).toBe(CLOSING_READINESS_REASON_CODES.length);
  });

  test("a withheld code declares no params: below the finance tier nothing is interpolated", () => {
    for (const code of WITHHELD_CLOSING_READINESS_REASON_CODES) expect(closingReasonParamNames(code)).toEqual([]);
  });
});
