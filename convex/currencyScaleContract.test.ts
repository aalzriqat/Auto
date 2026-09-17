import { describe, expect, it } from "vitest";
import {
  supportedCurrencyScale as convexSupportedScale,
  scaleForCurrency as convexScaleForCurrency,
} from "./utils/money";

describe("Currency scale contract — financial-truth scale resolution", () => {
  describe("Convex backend money utils", () => {
    it("resolves supported JOD to scale 3", () => {
      expect(convexSupportedScale("JOD")).toBe(3);
      expect(convexScaleForCurrency("JOD")).toBe(3);
    });

    it("resolves supported USD to scale 2", () => {
      expect(convexSupportedScale("USD")).toBe(2);
      expect(convexScaleForCurrency("USD")).toBe(2);
    });

    it("resolves JPY to scale 0", () => {
      expect(convexSupportedScale("JPY")).toBe(0);
      expect(convexScaleForCurrency("JPY")).toBe(0);
    });

    it("handles lowercase / normalised forms safely", () => {
      expect(convexSupportedScale("jod")).toBe(3);
      expect(convexScaleForCurrency("jod")).toBe(3);
      expect(convexSupportedScale(" usd ")).toBe(2);
      expect(convexScaleForCurrency(" usd ")).toBe(2);
    });

    it("returns null for unsupported or invalid currency codes without guessing 2", () => {
      expect(convexSupportedScale("XYZ")).toBeNull();
      expect(convexSupportedScale("UNKNOWN")).toBeNull();
      expect(convexSupportedScale("INVALID")).toBeNull();
      expect(() => convexScaleForCurrency("XYZ")).toThrowError(/Unsupported or unrecognised currency code/);
      expect(() => convexScaleForCurrency("UNKNOWN")).toThrowError(/Unsupported or unrecognised currency code/);
    });

    it("handles empty, whitespace, and corrupt currency strings by failing closed", () => {
      expect(convexSupportedScale("")).toBeNull();
      expect(convexSupportedScale("   ")).toBeNull();
      expect(convexSupportedScale("\t\n")).toBeNull();
      expect(convexSupportedScale(null)).toBeNull();
      expect(convexSupportedScale(undefined)).toBeNull();
      expect(() => convexScaleForCurrency("")).toThrowError(/Unsupported or unrecognised currency code/);
      expect(() => convexScaleForCurrency("   ")).toThrowError(/Unsupported or unrecognised currency code/);
    });
  });
});
