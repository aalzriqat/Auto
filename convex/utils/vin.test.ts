import { describe, expect, test } from "vitest";

import { hasNonCanonicalVinCharacters } from "./vin";

/**
 * VIN ADMISSIBILITY on the path that posts money — and nothing wider.
 *
 * There is no canonical-VIN function to test any more. Deciding whether a
 * historically stored, differently-written VIN is the same physical car was
 * attempted three times inside this import and introduced a new identity defect
 * every time; SCRUM-94 owns that problem in full. See the note at the bottom of
 * convex/utils/vin.ts.
 *
 * What is left is provable: a PURCHASE row must be plain [A-Z0-9], so among
 * accepted rows the exact by_org_vin match IS the identity rule — the same one
 * every other writer already uses.
 */
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
