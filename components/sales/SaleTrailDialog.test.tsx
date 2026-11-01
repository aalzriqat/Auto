/**
 * SCRUM-886 round 2: `sales.getSaleTrail` withholds `supplierPayable.amountDue` (the supplier's cost on a
 * consigned sale) from a caller without view:cost_price. The trail must then show who is owed and no amount,
 * never "undefined", "NaN" or a zero.
 */
import { describe, expect, test } from "vitest";
import { buildTrailSteps } from "./SaleTrailDialog";

type Trail = Parameters<typeof buildTrailSteps>[0];

function trail(supplierPayable: Record<string, unknown> | null): Trail {
  return {
    sale: { salePrice: 20_000, saleDate: 1, status: "COMPLETED" },
    vehicle: { year: 2023, make: "Kia", model: "Sportage" },
    customer: { firstName: "Buyer", lastName: "Synthetic" },
    salespersonName: "Sam",
    deposits: [],
    payments: [],
    saleJournalEntry: null,
    receivable: null,
    lead: null,
    supplierPayable,
  } as unknown as Trail;
}

const t = (key: string) => key;
const format = (amount: number) => `JD ${amount.toFixed(3)}`;
const supplierStep = (steps: ReturnType<typeof buildTrailSteps>) => steps.find((step) => step.label === "StepSupplierPayable");

describe("SaleTrailDialog supplier payable step", () => {
  test("shows the supplier and the amount when the server served the amount", () => {
    const steps = buildTrailSteps(
      trail({ sourcedFromName: "Zarqa Consignor", amountDue: 15_432.1, currency: "JOD", status: "PENDING" }),
      t,
      format
    );
    expect(supplierStep(steps)?.detail).toBe("Zarqa Consignor — JD 15432.100");
  });

  test("shows only the supplier when the server withheld the amount", () => {
    const steps = buildTrailSteps(
      trail({ sourcedFromName: "Zarqa Consignor", currency: "JOD", status: "PENDING" }),
      t,
      format
    );
    const detail = supplierStep(steps)?.detail;
    expect(detail).toBe("Zarqa Consignor");
    expect(detail).not.toMatch(/undefined|NaN|JD/);
  });

  test("adds no supplier step when there is no payable", () => {
    expect(supplierStep(buildTrailSteps(trail(null), t, format))).toBeUndefined();
  });
});
