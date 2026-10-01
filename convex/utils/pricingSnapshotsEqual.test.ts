/**
 * SCRUM-529. `pricingSnapshotsEqual` is the comparator behind the SCRUM-528 quote-economics anchor and the
 * Bill of Sale cross-check. Its compared keys are derived from `customerQuotePricingSnapshotValidator`, so a
 * field added to the validator is compared automatically. These tests fail if that ever stops being true:
 * a field the validator declares that the comparator ignores (or a sample that forgets a new field) breaks them.
 */
import { describe, expect, test } from "vitest";
import {
  customerQuotePricingSnapshotValidator,
  pricingSnapshotsEqual,
  type CustomerQuotePricingSnapshot,
} from "./financingEconomics";

/** Every validator field populated, including the optional one. A new validator field must be added here. */
const SAMPLE: CustomerQuotePricingSnapshot = {
  currency: "JOD",
  vehiclePrice: 12_000,
  downPayment: 1_000,
  termMonths: 48,
  executionFees: 100,
  commission: 50,
  profitRate: 5,
  insuranceRate: 1,
  gracePeriodMonths: 0,
  includesCommissionInDebt: false,
  totalFinancedAmount: 11_150,
  totalContractValue: 13_000,
  monthlyInstallment: 270,
  totalProfit: 1_850,
  takafulAmount: 40,
  companyRuleVersion: 3,
};

const validatorKeys = Object.keys(customerQuotePricingSnapshotValidator.fields).sort();

/** A value of the same type that is guaranteed to differ. */
const differentValue = (value: unknown): unknown =>
  typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : `${String(value)}-x`;

describe("pricingSnapshotsEqual", () => {
  test("the sample covers exactly the validator's fields (a new validator field must be added to SAMPLE)", () => {
    expect(Object.keys(SAMPLE).sort()).toEqual(validatorKeys);
  });

  test("identical snapshots are equal; an undefined counterpart is not", () => {
    expect(pricingSnapshotsEqual(SAMPLE, { ...SAMPLE })).toBe(true);
    expect(pricingSnapshotsEqual(SAMPLE, undefined)).toBe(false);
  });

  test.each(validatorKeys)("a difference in `%s` alone makes the snapshots unequal", (key) => {
    const other = { ...SAMPLE, [key]: differentValue(SAMPLE[key as keyof CustomerQuotePricingSnapshot]) };
    expect(pricingSnapshotsEqual(SAMPLE, other as CustomerQuotePricingSnapshot)).toBe(false);
    expect(pricingSnapshotsEqual(other as CustomerQuotePricingSnapshot, SAMPLE)).toBe(false);
  });

  test("an optional field is equal only when both are absent or both equal", () => {
    const { companyRuleVersion: _dropped, ...withoutVersion } = SAMPLE;
    expect(pricingSnapshotsEqual(withoutVersion, { ...withoutVersion })).toBe(true);
    expect(pricingSnapshotsEqual(withoutVersion, SAMPLE)).toBe(false);
    expect(pricingSnapshotsEqual(SAMPLE, withoutVersion)).toBe(false);
  });

  test("comparison is strict: 0 is not undefined and a numeric string is not a number", () => {
    expect(pricingSnapshotsEqual({ ...SAMPLE, companyRuleVersion: 0 }, { ...SAMPLE, companyRuleVersion: undefined })).toBe(false);
    expect(pricingSnapshotsEqual(SAMPLE, { ...SAMPLE, vehiclePrice: "12000" as unknown as number })).toBe(false);
  });
});
