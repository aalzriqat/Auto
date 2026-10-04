import { describe, expect, test } from "vitest";
import { compareCodeUnits } from "./compareCodeUnits.mjs";
import { unclassifiedEntryPoints } from "./census.mjs";

describe("compareCodeUnits", () => {
  const samples = ["b", "a", "B", "A", "a1", "a10", "a9", "_x", "$x", "é", "e", "z", "Z", "\u{1F600}", "￿", "", "ab", "a"];

  test("orders identically to the comparator-less default sort for strings", () => {
    expect([...samples].sort(compareCodeUnits)).toEqual([...samples].sort());
  });

  test("is locale-independent: uppercase sorts before lowercase, unlike localeCompare", () => {
    expect(["a", "B"].sort(compareCodeUnits)).toEqual(["B", "a"]);
    expect(["a", "B"].sort((a, b) => a.localeCompare(b))).toEqual(["a", "B"]);
  });

  test("compares surrogate halves by code unit, not by code point", () => {
    // U+1F600 is the surrogate pair D83D DE00; U+FFFF is a single unit above
    // D83D, so by code unit the emoji sorts FIRST (by code point it sorts last).
    expect(["￿", "\u{1F600}"].sort(compareCodeUnits)).toEqual(["\u{1F600}", "￿"]);
  });

  test("returns -1, 0, 1", () => {
    expect(compareCodeUnits("a", "b")).toBe(-1);
    expect(compareCodeUnits("b", "a")).toBe(1);
    expect(compareCodeUnits("a", "a")).toBe(0);
  });

  test("compares non-strings as String(x), exactly as the default sort does", () => {
    const mixed = [10, 9, 1, "2", 100];
    expect([...mixed].sort(compareCodeUnits)).toEqual([...mixed].sort());
    expect([...mixed].sort(compareCodeUnits)).toEqual([1, 10, 100, "2", 9]);
  });
});

describe("unclassifiedEntryPoints ordering", () => {
  test("lists unknown keys sorted by code unit and omits classified ones", () => {
    expect(unclassifiedEntryPoints(["zeta", "Alpha", "known", "beta"], { known: "SERVER_ONLY" } as never)).toEqual([
      "Alpha",
      "beta",
      "zeta",
    ]);
  });

  test("empty when everything is classified", () => {
    expect(unclassifiedEntryPoints(["known"], { known: "SERVER_ONLY" } as never)).toEqual([]);
  });
});
