import { describe, it, expect } from "vitest";
import { VEHICLE_MAKES, normalizeMake, normalizeModel, makesMatch, modelsMatch } from "./vehicleCatalog";

describe("vehicleCatalog", () => {
  it("folds Arabic and Latin spellings to the same canonical make", () => {
    expect(normalizeMake("تويوتا")).toBe("Toyota");
    expect(normalizeMake(" toyota ")).toBe("Toyota");
    expect(normalizeMake("TOYOTA")).toBe("Toyota");
    expect(normalizeMake("هيوندا")).toBe("Hyundai");
    expect(normalizeMake("مرسيدس")).toBe("Mercedes-Benz");
    expect(normalizeMake("mercedes")).toBe("Mercedes-Benz");
    expect(normalizeMake("بمو")).toBe("BMW");
    expect(normalizeMake("vw")).toBe("Volkswagen");
    expect(normalizeMake("رنج روفر")).toBe("Land Rover");
  });

  it("normalizes hamza variants, final-ya variants, and the definite article", () => {
    expect(normalizeMake("أودي")).toBe("Audi");
    expect(normalizeMake("اودى")).toBe("Audi");
    expect(normalizeMake("إيسوزو")).toBe("Isuzu");
  });

  it("returns null for unknown makes instead of guessing", () => {
    expect(normalizeMake("Xyzmobile")).toBeNull();
    expect(normalizeMake("")).toBeNull();
    expect(normalizeMake(undefined)).toBeNull();
    expect(normalizeMake(null)).toBeNull();
  });

  it("makesMatch crosses scripts, and falls back to token equality for unknown makes", () => {
    expect(makesMatch("تويوتا", "TOYOTA")).toBe(true);
    expect(makesMatch("هيونداي", "Hyundai")).toBe(true);
    expect(makesMatch("Toyota", "Kia")).toBe(false);
    // Both unknown but identical after trimming/casing — still a match.
    expect(makesMatch("Faraday", " faraday ")).toBe(true);
    expect(makesMatch("Faraday", "Toyota")).toBe(false);
    expect(makesMatch(undefined, "Toyota")).toBe(false);
  });

  it("folds Arabic model spellings to the canonical model", () => {
    expect(normalizeModel("كامري")).toBe("Camry");
    expect(normalizeModel("النترا")).toBe("Elantra");
    expect(normalizeModel("الانترا")).toBe("Elantra");
    expect(normalizeModel("لاندكروزر")).toBe("Land Cruiser");
    expect(modelsMatch("كامري", "Camry")).toBe(true);
    expect(modelsMatch("Camry", "camry ")).toBe(true);
    expect(modelsMatch("Camry", "Corolla")).toBe(false);
  });

  it("keeps unknown models comparable to themselves via token folding", () => {
    expect(modelsMatch("Some Rare Trim", "some  rare trim")).toBe(true);
    expect(modelsMatch("Some Rare Trim", "Another Trim")).toBe(false);
    expect(modelsMatch(undefined, "Camry")).toBe(false);
  });

  it("has unique canonical make names", () => {
    const names = VEHICLE_MAKES.map((make) => make.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
