import { describe, expect, it } from "vitest";
import {
  supportedCurrencyScale as uiSupportedScale,
  scaleForCurrency as uiScaleForCurrency,
} from "./AccountingTabShared";

describe("Frontend accounting shared utils — currency scale contract", () => {
  it("resolves supported JOD to scale 3", () => {
    expect(uiSupportedScale("JOD")).toBe(3);
    expect(uiScaleForCurrency("JOD")).toBe(3);
  });

  it("resolves supported USD to scale 2", () => {
    expect(uiSupportedScale("USD")).toBe(2);
    expect(uiScaleForCurrency("USD")).toBe(2);
  });

  it("resolves JPY to scale 0", () => {
    expect(uiSupportedScale("JPY")).toBe(0);
    expect(uiScaleForCurrency("JPY")).toBe(0);
  });

  it("handles lowercase / normalised forms safely", () => {
    expect(uiSupportedScale("jod")).toBe(3);
    expect(uiScaleForCurrency("jod")).toBe(3);
    expect(uiSupportedScale(" usd ")).toBe(2);
    expect(uiScaleForCurrency(" usd ")).toBe(2);
  });

  it("returns null for unsupported or invalid currency codes without guessing 2", () => {
    expect(uiSupportedScale("XYZ")).toBeNull();
    expect(uiSupportedScale("UNKNOWN")).toBeNull();
    expect(uiSupportedScale("INVALID")).toBeNull();
    expect(() => uiScaleForCurrency("XYZ")).toThrowError(/Unsupported or unrecognised currency code/);
    expect(() => uiScaleForCurrency("UNKNOWN")).toThrowError(/Unsupported or unrecognised currency code/);
  });

  it("handles empty, whitespace, and corrupt currency strings by failing closed", () => {
    expect(uiSupportedScale("")).toBeNull();
    expect(uiSupportedScale("   ")).toBeNull();
    expect(uiSupportedScale("\t\n")).toBeNull();
    expect(uiSupportedScale(null)).toBeNull();
    expect(uiSupportedScale(undefined)).toBeNull();
    expect(() => uiScaleForCurrency("")).toThrowError(/Unsupported or unrecognised currency code/);
    expect(() => uiScaleForCurrency("   ")).toThrowError(/Unsupported or unrecognised currency code/);
  });
});
