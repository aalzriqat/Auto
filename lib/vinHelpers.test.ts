import { describe, it, expect, vi, afterEach } from "vitest";
import { decodeVinYear, toCarBrand, cleanMfrName, hasInvalidVinCharacters, validateVinChecksum } from "./vinHelpers";

afterEach(() => {
  vi.useRealTimers();
});

describe("decodeVinYear", () => {
  it("returns the 30-year cycle value when it fits within now+2", () => {
    // Pin year to 2026. A=1980, +30=2010, 2010 <= 2028 → 2010
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01"));
    expect(decodeVinYear("A")).toBe(2010);
  });

  it("returns the base value when the 30-year cycle exceeds now+2", () => {
    // Pin year to 2026. Y=2000, +30=2030, 2030 > 2028 → 2000
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01"));
    expect(decodeVinYear("Y")).toBe(2000);
  });

  it("handles digit characters", () => {
    // '1'=2001, +30=2031, 2031 > 2028 → 2001
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01"));
    expect(decodeVinYear("1")).toBe(2001);
    expect(decodeVinYear("9")).toBe(2009);
  });

  it("is case-insensitive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01"));
    expect(decodeVinYear("a")).toBe(decodeVinYear("A"));
  });

  it("returns null for an invalid character", () => {
    expect(decodeVinYear("I")).toBeNull(); // I is not in VIN alphabet
    expect(decodeVinYear("O")).toBeNull(); // O is not in VIN alphabet
    expect(decodeVinYear("Q")).toBeNull(); // Q is not in VIN alphabet
    expect(decodeVinYear("0")).toBeNull(); // 0 is not a digit code
  });

  it("returns null for empty string", () => {
    expect(decodeVinYear("")).toBeNull();
  });
});

describe("toCarBrand", () => {
  it("keeps ≤3-char words as ALL CAPS", () => {
    expect(toCarBrand("BMW")).toBe("BMW");
    expect(toCarBrand("KIA")).toBe("KIA");
    expect(toCarBrand("BYD")).toBe("BYD");
  });

  it("title-cases longer words", () => {
    expect(toCarBrand("TOYOTA")).toBe("Toyota");
    expect(toCarBrand("honda")).toBe("Honda");
  });

  it("handles multi-word brands", () => {
    expect(toCarBrand("GREAT WALL")).toBe("Great Wall");
    expect(toCarBrand("general motors")).toBe("General Motors");
  });

  it("trims leading and trailing whitespace", () => {
    expect(toCarBrand("  BMW  ")).toBe("BMW");
  });

  it("mixed short and long words", () => {
    expect(toCarBrand("KIA MOTORS")).toBe("KIA Motors");
  });
});

describe("cleanMfrName", () => {
  it("strips CORP / CO / LTD suffixes", () => {
    expect(cleanMfrName("BYD AUTO CO., LTD")).toBe("BYD");
  });

  it("strips MOTOR / MOTORS", () => {
    const result = cleanMfrName("HONDA MOTOR CO.");
    expect(result).toBe("HONDA");
  });

  it("strips CORPORATION", () => {
    expect(cleanMfrName("TOYOTA MOTOR CORPORATION")).toBe("TOYOTA");
  });

  it("strips MANUFACTURING", () => {
    expect(cleanMfrName("FORD MOTOR MANUFACTURING")).toBe("FORD");
  });

  it("handles already clean names", () => {
    expect(cleanMfrName("HONDA")).toBe("HONDA");
  });

  it("falls back to first word when all tokens stripped", () => {
    // Edge case: only stop-words left
    const result = cleanMfrName("CORP LTD INC");
    // cleaned string would be empty, fallback: first word of original
    expect(result).toBe("CORP");
  });
});

describe("hasInvalidVinCharacters", () => {
  it("flags I, O, and Q", () => {
    expect(hasInvalidVinCharacters("1HGCM82633A00435I")).toBe(true);
    expect(hasInvalidVinCharacters("1HGCM82633A00435O")).toBe(true);
    expect(hasInvalidVinCharacters("1HGCM82633A00435Q")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasInvalidVinCharacters("1hgcm82633a00435i")).toBe(true);
  });

  it("returns false for a VIN with none of those letters", () => {
    expect(hasInvalidVinCharacters("1HGCM82633A004352")).toBe(false);
  });
});

describe("validateVinChecksum", () => {
  it("validates a known-good NA VIN checksum", () => {
    expect(validateVinChecksum("1HGCM82633A004352")).toBe(true);
  });

  it("rejects a VIN with a typo'd digit", () => {
    expect(validateVinChecksum("1HGCM82633A004353")).toBe(false);
  });

  it("rejects VINs with invalid characters or wrong length", () => {
    expect(validateVinChecksum("1HGCM82633A00435I")).toBe(false);
    expect(validateVinChecksum("SHORT")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(validateVinChecksum("1hgcm82633a004352")).toBe(true);
  });
});
