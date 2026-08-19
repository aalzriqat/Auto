import { describe, expect, test } from "vitest";

import { canonicalVin, hasNonCanonicalVinCharacters } from "./vin";

/**
 * VIN identity, unit-level.
 *
 * `canonicalVin` decides whether two differently-written strings are the same
 * car. A key it returns EMPTY is worse than a wrong key: an empty canonical form
 * is skipped when the collision map is built, so the stored car becomes
 * invisible to the guard and a later import inserts a second vehicle and posts a
 * second acquisition for it.
 */
describe("canonicalVin", () => {
  test("strips formatting so a punctuated VIN matches its plain spelling", () => {
    expect(canonicalVin("1HGCM826-33A0043")).toBe("1HGCM82633A0043");
    expect(canonicalVin(" 1hgcm826 33a0043 ")).toBe("1HGCM82633A0043");
    expect(canonicalVin("1HGCM826.33A0043")).toBe("1HGCM82633A0043");
  });

  test("NFKC folds a fullwidth VIN onto the ASCII spelling it is a presentation form of", () => {
    // Without NFKC this stored value canonicalized to "" and vanished from the
    // collision map, so an ASCII import of the same car posted a second
    // acquisition.
    expect(canonicalVin("ＡＢＣ１２３４５")).toBe("ABC12345");
    expect(canonicalVin("ＡＢＣ１２３４５")).toBe(canonicalVin("ABC12345"));
  });

  test("NON-ASCII DIGITS KEEP A NON-EMPTY KEY — they must never collapse to nothing", () => {
    // NFKC does NOT map Arabic-Indic digits to ASCII, so an implementation that
    // stripped "everything that is not [A-Z0-9]" produced "" here. That is the
    // hole: an empty key is dropped from the map and the stored car stops being
    // protected. Keeping letters and numbers of any script gives it a key of its
    // own instead.
    const arabicIndic = canonicalVin("١٢٣٤٥");
    expect(arabicIndic).not.toBe("");
    expect(arabicIndic).toHaveLength(5);
  });

  test("and are NOT treated as equivalent to their ASCII counterparts", () => {
    // They are different strings and nothing proves they are the same car.
    expect(canonicalVin("١٢٣٤٥")).not.toBe(canonicalVin("12345"));
  });

  test("a VIN with no alphanumeric content at all is still empty, and is meant to be", () => {
    expect(canonicalVin("---")).toBe("");
    expect(canonicalVin("")).toBe("");
    expect(canonicalVin(undefined)).toBe("");
  });
});

describe("hasNonCanonicalVinCharacters — admissibility on the path that POSTS", () => {
  test("accepts plain alphanumeric", () => {
    expect(hasNonCanonicalVinCharacters("1HGCM82633A0043")).toBe(false);
  });

  test("refuses punctuation, spaces and non-ASCII scripts alike", () => {
    expect(hasNonCanonicalVinCharacters("1HGCM826-33A0043")).toBe(true);
    expect(hasNonCanonicalVinCharacters("1HGCM826 33A0043")).toBe(true);
    // Fail closed: whatever a fullwidth or Arabic-Indic VIN may canonically
    // MEAN, it is not a plain-alphanumeric identifier, and the posting path
    // refuses it rather than guessing.
    expect(hasNonCanonicalVinCharacters("ＡＢＣ１２３４５")).toBe(true);
    expect(hasNonCanonicalVinCharacters("١٢٣٤٥")).toBe(true);
  });

  test("an absent or blank VIN is not 'malformed' — that is missingVin's job", () => {
    expect(hasNonCanonicalVinCharacters(undefined)).toBe(false);
    expect(hasNonCanonicalVinCharacters("   ")).toBe(false);
  });
});
