// @vitest-environment node
import { describe, expect, test } from "vitest";
import { buildSmartReplyText, calculateFinancingEstimate } from "./smartReplyBuilder";

// Characterization of the financing intent. The expected strings are the
// output of the code before the calculation was extracted into its own
// function; they must not change when it is.

const VEHICLE = {
  model: "Camry",
  year: 2022,
  sellingPrice: 100000,
  status: "AVAILABLE" as const,
  mileage: 30000,
  color: "White",
  fuelType: "Petrol" as const,
  transmission: "Automatic" as const,
};

const FINANCE_COMPANY = {
  isActive: true,
  profitRate: 5,
  maxTermMonths: 60,
  gracePeriodMonths: 0,
  adminFees: 500,
  commission: 0,
  insuranceRate: 0,
};

const CALCULATED_ORG = {
  smartReplyFinancingMode: "calculated" as const,
  currencySymbol: "SAR",
};

describe("smart reply financing characterization", () => {
  test("calculated, English", () => {
    expect(
      buildSmartReplyText({
        intent: "financing",
        vehicle: VEHICLE,
        orgSettings: CALCULATED_ORG,
        financeCompany: FINANCE_COMPANY,
        locale: "en",
      }),
    ).toBe(
      "Financing is available for Camry (2022) — estimated monthly payments start from 1677 SAR/month, subject to approval.",
    );
  });

  test("calculated, Arabic", () => {
    expect(
      buildSmartReplyText({
        intent: "financing",
        vehicle: VEHICLE,
        orgSettings: CALCULATED_ORG,
        financeCompany: FINANCE_COMPANY,
        locale: "ar",
      }),
    ).toBe(
      "التمويل متاح لسيارة Camry (2022) — تبدأ الأقساط الشهرية التقديرية من 1677 SAR/شهرياً، حسب الموافقة.",
    );
  });

  test("calculated with a custom template", () => {
    expect(
      buildSmartReplyText({
        intent: "financing",
        vehicle: VEHICLE,
        orgSettings: {
          ...CALCULATED_ORG,
          smartReplyCustomTemplatesEn: JSON.stringify({
            financingCalculated: "About {monthlyAmount} {currency} a month for the {model} {year}",
          }),
        },
        financeCompany: FINANCE_COMPANY,
        locale: "en",
      }),
    ).toBe("About 1677 SAR a month for the Camry 2022");
  });

  test("generic when the mode is not calculated, English and Arabic", () => {
    const base = {
      intent: "financing" as const,
      vehicle: VEHICLE,
      orgSettings: { smartReplyFinancingMode: "generic" as const, currencySymbol: "SAR" },
      financeCompany: FINANCE_COMPANY,
    };
    expect(buildSmartReplyText({ ...base, locale: "en" })).toBe(
      "Financing is available for Camry (2022). Message us and a sales rep will share your personalized monthly rate.",
    );
    expect(buildSmartReplyText({ ...base, locale: "ar" })).toBe(
      "التمويل متاح لسيارة Camry (2022). راسلنا وسيقوم أحد مندوبي المبيعات بإرسال القسط الشهري المناسب لك.",
    );
  });

  test("generic with a custom template", () => {
    expect(
      buildSmartReplyText({
        intent: "financing",
        vehicle: VEHICLE,
        orgSettings: {
          smartReplyFinancingMode: "generic",
          smartReplyCustomTemplatesEn: JSON.stringify({ financingGeneric: "Ask us about {model}" }),
        },
        financeCompany: null,
        locale: "en",
      }),
    ).toBe("Ask us about Camry");
  });

  test("generic when the vehicle is not available, the finance company is inactive, or the term is invalid", () => {
    const generic =
      "Financing is available for Camry (2022). Message us and a sales rep will share your personalized monthly rate.";
    const call = (
      vehicle: typeof VEHICLE | (Omit<typeof VEHICLE, "status"> & { status: "SOLD" }),
      financeCompany: typeof FINANCE_COMPANY,
    ) =>
      buildSmartReplyText({
        intent: "financing",
        vehicle,
        orgSettings: CALCULATED_ORG,
        financeCompany,
        locale: "en",
      });
    expect(call({ ...VEHICLE, status: "SOLD" }, FINANCE_COMPANY)).toBe(generic);
    expect(call(VEHICLE, { ...FINANCE_COMPANY, isActive: false })).toBe(generic);
    expect(call(VEHICLE, { ...FINANCE_COMPANY, maxTermMonths: 0 })).toBe(generic);
  });

  test("calculateFinancingEstimate returns the numbers the reply states", () => {
    expect(
      calculateFinancingEstimate({ vehicle: VEHICLE, orgSettings: CALCULATED_ORG, financeCompany: FINANCE_COMPANY }),
    ).toEqual({ monthlyAmount: 1677, termMonths: 60, downPaymentPercent: 20 });
    expect(
      calculateFinancingEstimate({
        vehicle: VEHICLE,
        orgSettings: { ...CALCULATED_ORG, smartReplyDefaultDownPaymentPercent: 50 },
        financeCompany: FINANCE_COMPANY,
      }),
    ).toEqual({ monthlyAmount: 1052, termMonths: 60, downPaymentPercent: 50 });
  });

  test("calculateFinancingEstimate is null when no number may be stated", () => {
    const args = { vehicle: VEHICLE, orgSettings: CALCULATED_ORG, financeCompany: FINANCE_COMPANY };
    expect(calculateFinancingEstimate({ ...args, orgSettings: { smartReplyFinancingMode: "generic" } })).toBeNull();
    expect(calculateFinancingEstimate({ ...args, orgSettings: null })).toBeNull();
    expect(calculateFinancingEstimate({ ...args, financeCompany: null })).toBeNull();
    expect(calculateFinancingEstimate({ ...args, vehicle: { ...VEHICLE, status: "SOLD" } })).toBeNull();
  });

  test("the down payment percent from the settings changes the monthly amount", () => {
    const text = buildSmartReplyText({
      intent: "financing",
      vehicle: VEHICLE,
      orgSettings: { ...CALCULATED_ORG, smartReplyDefaultDownPaymentPercent: 50 },
      financeCompany: FINANCE_COMPANY,
      locale: "en",
    });
    expect(text).toBe(
      "Financing is available for Camry (2022) — estimated monthly payments start from 1052 SAR/month, subject to approval.",
    );
  });
});
