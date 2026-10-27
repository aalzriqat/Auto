import { describe, expect, test } from "vitest";
import {
  ISO_3166_1_ALPHA_2,
  codeUnitCompare,
  isValidTaxJurisdiction,
  normalizeNameKey,
  normalizeTaxIdKey,
  normalizeTaxJurisdiction,
} from "./supplierNames";

/**
 * SCRUM-868 S1 test 11. The key is used for candidate lookup only (design 3.3):
 * it must put one supplier written several ways on one key, and must not put two
 * different names on one key.
 */
describe("supplier name and tax normalisation", () => {
  test("whitespace and case fold to one name key", () => {
    const keys = ["Al Nour Motors", "  al   nour\tmotors ", "AL NOUR MOTORS"].map(normalizeNameKey);
    expect(new Set(keys)).toEqual(new Set(["al nour motors"]));
  });

  test("NFKC folds full-width and compatibility forms into the plain form", () => {
    expect(normalizeNameKey("ＡＢＣ Motors")).toBe("abc motors");
    expect(normalizeNameKey("ﬁnance house")).toBe("finance house");
  });

  test("Arabic diacritics and tatweel do not change the key", () => {
    expect(normalizeNameKey("مُحَمَّد")).toBe(normalizeNameKey("محمد"));
    expect(normalizeNameKey("مـــحمد")).toBe(normalizeNameKey("محمد"));
  });

  test("alef variants fold to one letter", () => {
    const keys = ["أحمد", "إحمد", "آحمد", "ٱحمد", "احمد"].map(normalizeNameKey);
    expect(new Set(keys).size).toBe(1);
  });

  test("ya and alef-maqsura variants fold to one letter", () => {
    const keys = ["علي", "على", "علی"].map(normalizeNameKey);
    expect(new Set(keys).size).toBe(1);
  });

  test("different names keep different keys", () => {
    expect(normalizeNameKey("محمد")).not.toBe(normalizeNameKey("محمود"));
    expect(normalizeNameKey("Al Nour Motors")).not.toBe(normalizeNameKey("Al Noor Motors"));
  });

  test("a name made only of ignorable marks has an empty key", () => {
    expect(normalizeNameKey("   ")).toBe("");
    expect(normalizeNameKey("ـــ")).toBe("");
  });

  test("invisible format characters do not change the key, and a name made only of them has an empty key", () => {
    const RLM = "‏";
    const LRM = "‎";
    expect(normalizeNameKey(`محمد${RLM}`)).toBe(normalizeNameKey("محمد"));
    expect(normalizeNameKey(`${LRM}Al Nour${RLM}`)).toBe("al nour");
    expect(normalizeNameKey("Al​Nour")).toBe("alnour");
    expect(normalizeNameKey("Al­Nour")).toBe("alnour");
    expect(normalizeNameKey("Al﻿Nour")).toBe("alnour");
    expect(normalizeNameKey("می‌خواهم")).toBe(normalizeNameKey("میخواهم"));
    // One code point from each class: default-ignorable but not Cf (CGJ), and Cf but not default-ignorable.
    expect(normalizeNameKey("Al͏Nour")).toBe("alnour");
    expect(normalizeNameKey("Al؀Nour")).toBe("alnour");
    expect(normalizeNameKey(RLM)).toBe("");
    expect(normalizeNameKey(`  ${RLM}${LRM}​ `)).toBe("");
  });

  test("full case folding puts sharp s, final sigma and ordinary case on one key", () => {
    expect(normalizeNameKey("Straße GmbH")).toBe(normalizeNameKey("STRASSE GMBH"));
    expect(normalizeNameKey("οδυσσευς")).toBe(normalizeNameKey("οδυσσευσ"));
    expect(normalizeNameKey("ΟΔΥΣΣΕΥΣ")).toBe(normalizeNameKey("οδυσσευσ"));
    expect(normalizeNameKey("Straße")).not.toBe(normalizeNameKey("Strase"));
  });

  test("tax ids drop separators, fold Arabic-Indic digits and upper-case letters", () => {
    expect(normalizeTaxIdKey("12-345 678")).toBe("12345678");
    expect(normalizeTaxIdKey("٠١٢٣٤٥")).toBe("012345");
    expect(normalizeTaxIdKey("۰۱۲۳")).toBe("0123");
    expect(normalizeTaxIdKey("ab-12/c")).toBe("AB12C");
    expect(normalizeTaxIdKey("--  ")).toBe("");
  });

  test("tax jurisdiction is trimmed and upper-cased", () => {
    expect(normalizeTaxJurisdiction(" jo ")).toBe("JO");
    expect(normalizeTaxJurisdiction("sa")).toBe("SA");
  });

  // M2 (PR 687 Seat 1): free text defeats "one legal identity per organization", because tax id 123
  // under "JO" and under "JOR" would be two identities. Only ISO 3166 codes are accepted.
  test("tax jurisdiction accepts only an assigned ISO 3166-1 alpha-2 code; no subdivision suffix", () => {
    for (const ok of ["JO", "jo", " sa ", "SA", "US", "GB", "AE", "ＪＯ"]) {
      expect(isValidTaxJurisdiction(normalizeTaxJurisdiction(ok)), ok).toBe(true);
    }
    // A subdivision suffix is refused: "JO", "JO-AM" and an invented "JO-XYZ" would be three legal identities.
    for (const bad of ["JO-AM", "us-ca", "CA-ON", "JO-XYZ", "JO-1", "JOR", "J.O.", "jordan", "Jordan", "XX", "ZZ", "UK", "EU", "J", "", "J0", "JO-", "JO-ABCD", "JO AM", "JO_AM", "AA", "JO-A.M"]) {
      expect(isValidTaxJurisdiction(normalizeTaxJurisdiction(bad)), bad).toBe(false);
    }
  });

  test("the embedded country list is the 249 officially assigned ISO 3166-1 alpha-2 codes", () => {
    expect(ISO_3166_1_ALPHA_2.size).toBe(249);
    for (const code of ISO_3166_1_ALPHA_2) expect(code).toMatch(/^[A-Z]{2}$/);
  });
});

// L1 (PR 687 Seat 1): keys only find candidates, so folding more is the safe direction.
describe("supplier name key folds (L1)", () => {
  test("teh marbuta folds to heh (as Lucene's ArabicNormalizer does)", () => {
    expect(normalizeNameKey("شركة النور")).toBe(normalizeNameKey("شركه النور"));
    expect(normalizeNameKey("مؤسسة")).toBe(normalizeNameKey("مؤسسه"));
  });

  test("Arabic-Indic and Extended Arabic-Indic digits map to ASCII digits", () => {
    expect(normalizeNameKey("مصنع ٢٠٢٥")).toBe(normalizeNameKey("مصنع 2025"));
    expect(normalizeNameKey("Depot ۱۲۳")).toBe("depot 123");
    expect(normalizeNameKey("Depot ٠١٢٣٤٥٦٧٨٩")).toBe("depot 0123456789");
    expect(normalizeNameKey("Depot ۰۱۲۳۴۵۶۷۸۹")).toBe("depot 0123456789");
  });

  test("punctuation is whitespace, so spelling variants of one trade name share a key", () => {
    expect(normalizeNameKey("Al-Noor Co.")).toBe(normalizeNameKey("Al Noor Co"));
    expect(normalizeNameKey("Al-Noor Co.")).toBe("al noor co");
    expect(normalizeNameKey("Gulf,Parts (Amman)")).toBe("gulf parts amman");
    expect(normalizeNameKey("النور، للسيارات.")).toBe(normalizeNameKey("النور للسيارات"));
    expect(normalizeNameKey("---")).toBe("");
    expect(normalizeNameKey(" . - ، ")).toBe("");
  });

  test("the folds do not merge different names", () => {
    expect(normalizeNameKey("Al Noor Co")).not.toBe(normalizeNameKey("Alnoor Co"));
    expect(normalizeNameKey("Depot 12")).not.toBe(normalizeNameKey("Depot 21"));
    expect(normalizeNameKey("مدرسة")).not.toBe(normalizeNameKey("مدرس"));
  });

  test("the tax id key normaliser is unchanged: it still drops separators and keeps its own digit fold", () => {
    expect(normalizeTaxIdKey("12-345 678")).toBe("12345678");
    expect(normalizeTaxIdKey("٠١٢٣٤٥")).toBe("012345");
    expect(normalizeTaxIdKey("ab-12/c")).toBe("AB12C");
    // A teh marbuta is a letter in a tax id: no fold to heh.
    expect(normalizeTaxIdKey("ة1")).toBe("ة1");
  });
});

describe("codeUnitCompare", () => {
  // Inputs where code-unit order, locale order and code-point order all differ: upper and lower
  // case, an underscore, a non-ASCII letter, a surrogate pair (U+1F600, units D83D DE00) and U+FB01.
  const input = ["b", "B", "a", "\u00e9", "Z", "_x", "A", "\u{1F600}", "\uFB01"];
  const codeUnitOrder = ["A", "B", "Z", "_x", "a", "b", "\u00e9", "\u{1F600}", "\uFB01"];

  test("orders by UTF-16 code unit, the order a bare sort gives, and not by locale", () => {
    expect([...input].sort(codeUnitCompare)).toEqual(codeUnitOrder);
    // The thing it must not be: the locale order ranks "a" before "B".
    expect([...input].sort((a, b) => a.localeCompare(b))).not.toEqual(codeUnitOrder);
  });

  test("returns 0 for equal strings and is antisymmetric", () => {
    expect(codeUnitCompare("abc", "abc")).toBe(0);
    expect(Math.sign(codeUnitCompare("B", "a"))).toBe(-1);
    expect(Math.sign(codeUnitCompare("a", "B"))).toBe(1);
  });
});
