import { describe, expect, test } from "vitest";
import { normalizeNameKey, normalizeTaxIdKey, normalizeTaxJurisdiction } from "./supplierNames";

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
});
