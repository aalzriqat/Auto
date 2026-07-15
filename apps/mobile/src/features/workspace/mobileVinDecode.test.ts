/// <reference types="jest" />

import {
  cleanMobileMfrName,
  decodeMobileVinYear,
  getFirstNhtsaResult,
  getFirstNhtsaWmiName,
  getMobileVinReadiness,
  hasInvalidMobileVinCharacters,
  mapFuelType,
  mapNhtsaVinPayload,
  normalizeVinInput,
  toMobileCarBrand,
  validateMobileVinChecksum,
} from "./mobileVinDecode";

describe("mobile VIN decode helpers", () => {
  test("normalizes VIN entry and reports readiness", () => {
    expect(normalizeVinInput(" 1hgcm-82633a004352 ")).toBe("1HGCM82633A004352");
    expect(getMobileVinReadiness("")).toBe("empty");
    expect(getMobileVinReadiness("1HG")).toBe("incomplete");
    expect(getMobileVinReadiness("1HGCM82633A00435I")).toBe("invalid-characters");
    expect(getMobileVinReadiness("1HGCM82633A004353")).toBe("checksum-warning");
    expect(getMobileVinReadiness("1HGCM82633A004352")).toBe("ready");
  });

  test("decodes VIN years and validates advisory checksums", () => {
    expect(decodeMobileVinYear("A")).toBeUndefined();
    expect(decodeMobileVinYear("Y")).toBeUndefined();
    expect(decodeMobileVinYear("9")).toBe(2009);
    expect(decodeMobileVinYear("I")).toBeUndefined();
    expect(hasInvalidMobileVinCharacters("IOQ")).toBe(true);
    expect(hasInvalidMobileVinCharacters("AAAAAAAAAAAAAAAA*")).toBe(true);
    expect(validateMobileVinChecksum("1HGCM82633A004352")).toBe(true);
    expect(validateMobileVinChecksum("1HGCM82633A004353")).toBe(false);
    expect(validateMobileVinChecksum("SHORT")).toBe(false);
    expect(validateMobileVinChecksum("1HGCM82633A00435I")).toBe(false);
    expect(validateMobileVinChecksum("AAAAAAAAAAAAAAAA*")).toBe(false);
    expect(validateMobileVinChecksum("1HGCM826X3A004350")).toBe(true);
  });

  test("formats manufacturer and fuel labels for mobile selects", () => {
    expect(cleanMobileMfrName("HONDA MOTOR CO., LTD.")).toBe("HONDA");
    expect(cleanMobileMfrName("MOTOR")).toBe("MOTOR");
    expect(cleanMobileMfrName("  ")).toBe("");
    expect(toMobileCarBrand("honda motor")).toBe("Honda Motor");
    expect(toMobileCarBrand("bmw")).toBe("BMW");
    expect(toMobileCarBrand(" ")).toBe("");
    expect(mapFuelType("Gasoline / Petrol")).toBe("Gasoline");
    expect(mapFuelType("Diesel fuel")).toBe("Diesel");
    expect(mapFuelType("Battery Electric Vehicle")).toBe("Electric");
    expect(mapFuelType("Hybrid Electric")).toBe("Hybrid");
    expect(mapFuelType("Hybrid")).toBe("Hybrid");
    expect(mapFuelType(undefined)).toBeUndefined();
    expect(mapFuelType("Unknown")).toBeUndefined();
  });

  test("extracts NHTSA payloads without trusting unknown shapes", () => {
    expect(getFirstNhtsaResult(null)).toEqual({});
    expect(getFirstNhtsaResult([])).toEqual({});
    expect(getFirstNhtsaResult({ Results: [{ Make: "Toyota" }] })).toEqual({ Make: "Toyota" });
    expect(getFirstNhtsaResult({ Results: [null] })).toEqual({});
    expect(getFirstNhtsaWmiName({ Results: [{ Name: "Toyota Motor Corporation" }] })).toBe(
      "Toyota Motor Corporation",
    );
    expect(getFirstNhtsaWmiName({ Results: [{}] })).toBe("");
    expect(getFirstNhtsaWmiName({ Results: [{ Name: 42 }] })).toBe("");
  });

  test("maps NHTSA decode values into native vehicle fields", () => {
    expect(
      mapNhtsaVinPayload({
        vin: "1hgcm82633a004352",
        wmiName: "HONDA MOTOR CO., LTD.",
        vinValues: {
          Make: "Ignored",
          Model: "accord",
          ModelYear: "2003",
          Trim: "EX",
          FuelTypePrimary: "Gasoline",
        },
      }),
    ).toEqual({
      vin: "1HGCM82633A004352",
      make: "Honda",
      model: "Accord",
      trim: "EX",
      year: 2003,
      fuelType: "Gasoline",
    });

    expect(
      mapNhtsaVinPayload({
        vin: "WBA3A5C50DF356752",
        vinValues: {
          Make: "BMW",
          Series: "3-series",
          ModelYear: "",
          FuelTypePrimary: "Petrol",
        },
      }),
    ).toMatchObject({
      make: "BMW",
      model: "3-series",
      fuelType: "Gasoline",
      year: undefined,
    });

    expect(
      mapNhtsaVinPayload({
        vin: "JTDKN3DU0A0043521",
        vinValues: {
          Make: "",
          Model: "",
          Series: "",
          ModelYear: "not-a-year",
          FuelTypePrimary: "",
        },
      }),
    ).toEqual({
      vin: "JTDKN3DU0A0043521",
      make: undefined,
      model: undefined,
      trim: undefined,
      year: undefined,
      fuelType: undefined,
    });

    expect(
      mapNhtsaVinPayload({
        vin: "short",
        vinValues: { ModelYear: "not-a-year" },
      }),
    ).toEqual({
      vin: "SHORT",
      make: undefined,
      model: undefined,
      trim: undefined,
      year: undefined,
      fuelType: undefined,
    });
  });
});
