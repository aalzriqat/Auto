import { describe, test, expect } from "vitest";
import { scoreVehicleAgainstRequest, MATCH_WEIGHTS } from "./marketplaceMatching";

const financeReq = {
  make: "Toyota",
  model: "Corolla",
  yearMin: 2020,
  yearMax: 2023,
  priceMin: 15000,
  priceMax: 22000,
  paymentType: "FINANCE" as const,
  monthlyBudget: 400,
};

describe("scoreVehicleAgainstRequest", () => {
  test("returns null when the buyer named a make the vehicle doesn't match", () => {
    const result = scoreVehicleAgainstRequest(
      financeReq,
      { make: "Honda", model: "Civic", year: 2021, price: 18000 },
      { financeAvailable: true }
    );
    expect(result).toBeNull();
  });

  test("a full match earns every applicable reason and the highest score", () => {
    const result = scoreVehicleAgainstRequest(
      financeReq,
      { make: "Toyota", model: "Corolla", year: 2021, price: 18000 },
      { monthlyEstimate: 350, financeAvailable: true }
    );
    expect(result).not.toBeNull();
    expect(result!.reasons).toEqual(
      expect.arrayContaining(["make_match", "model_exact", "year_in_range", "price_in_range", "within_monthly_budget", "finance_available"])
    );
    const expected =
      MATCH_WEIGHTS.MAKE + MATCH_WEIGHTS.MODEL_EXACT + MATCH_WEIGHTS.YEAR_IN_RANGE +
      MATCH_WEIGHTS.PRICE_IN_RANGE + MATCH_WEIGHTS.WITHIN_MONTHLY_BUDGET + MATCH_WEIGHTS.FINANCE_AVAILABLE;
    expect(result!.score).toBe(expected);
  });

  test("an exact model outranks a same-make different-model vehicle", () => {
    const exact = scoreVehicleAgainstRequest(
      financeReq,
      { make: "Toyota", model: "Corolla", year: 2021, price: 18000 },
      { financeAvailable: false }
    )!;
    const sameMake = scoreVehicleAgainstRequest(
      financeReq,
      { make: "Toyota", model: "Camry", year: 2021, price: 18000 },
      { financeAvailable: false }
    )!;
    expect(exact.score).toBeGreaterThan(sameMake.score);
    expect(exact.reasons).toContain("model_exact");
    expect(sameMake.reasons).not.toContain("model_exact");
  });

  test("a monthly estimate over budget earns no budget bonus", () => {
    const over = scoreVehicleAgainstRequest(
      financeReq,
      { make: "Toyota", model: "Corolla", year: 2021, price: 18000 },
      { monthlyEstimate: 500, financeAvailable: true }
    )!;
    expect(over.reasons).not.toContain("within_monthly_budget");
  });

  test("with no make named, any make is a candidate and still scores model/year/price", () => {
    const result = scoreVehicleAgainstRequest(
      { ...financeReq, make: undefined },
      { make: "Honda", model: "Corolla", year: 2021, price: 18000 },
      { financeAvailable: false }
    );
    expect(result).not.toBeNull();
    expect(result!.reasons).toContain("make_match");
  });

  test("year and price outside the requested range earn no bonus", () => {
    const result = scoreVehicleAgainstRequest(
      financeReq,
      { make: "Toyota", model: "Corolla", year: 2015, price: 30000 },
      { financeAvailable: false }
    )!;
    expect(result.reasons).not.toContain("year_in_range");
    expect(result.reasons).not.toContain("price_in_range");
  });
});
