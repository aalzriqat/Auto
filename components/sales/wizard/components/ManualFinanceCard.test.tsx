import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
    locale: "en",
  }),
}));

vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => ({ currency: "JOD" }) }));

import { ManualFinanceCard } from "./ManualFinanceCard";

afterEach(cleanup);

describe("ManualFinanceCard financing-term authority", () => {
  test("an invalid term is reported consistently instead of being misreported as missing execution fees", () => {
    render(
      <ManualFinanceCard
        vehiclePrice={12_000}
        downPayment={1_000}
        termMonths={0}
        selected={false}
        profitRate={5}
        insuranceRate={0}
        onChangeProfitRate={() => {}}
        onChangeInsuranceRate={() => {}}
        executionCommission={0}
        onChangeExecutionCommission={() => {}}
        executionFees={100}
        onChangeExecutionFees={() => {}}
        includesCommissionInDebt={false}
        onChangeIncludesCommissionInDebt={() => {}}
        onSelect={() => {}}
      />
    );

    expect(screen.getAllByText("Invalid financing term")).toHaveLength(2);
    expect(screen.queryByText("ExecutionFeesRequired")).toBeNull();
  });

  test("SCRUM-452: money inputs accept exact fils (step 0.001), rate inputs keep 0.01", () => {
    const { container } = render(
      <ManualFinanceCard
        vehiclePrice={12_000}
        downPayment={1_000}
        termMonths={60}
        selected={false}
        profitRate={5}
        insuranceRate={0}
        onChangeProfitRate={() => {}}
        onChangeInsuranceRate={() => {}}
        executionCommission={0}
        onChangeExecutionCommission={() => {}}
        executionFees={100}
        onChangeExecutionFees={() => {}}
        includesCommissionInDebt={false}
        onChangeIncludesCommissionInDebt={() => {}}
        onSelect={() => {}}
      />
    );
    const steps = Array.from(container.querySelectorAll('input[type="number"]')).map((i) => i.getAttribute("step"));
    expect(steps).toEqual(["0.01", "0.01", "0.001", "0.001"]);
  });
});
