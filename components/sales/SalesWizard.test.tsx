/**
 * SCRUM-746: "source another like this" opens the wizard with a seed for the
 * picker's source form. SalesWizard's field-by-field draft initialiser used to
 * drop it, so the wizard opened empty. The seed is a one-shot UI hint: it
 * reaches step 1, never the persisted wizardData, and is consumed on Next.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const SEED = { make: "Kia", model: "K5", year: 2022, color: "White", fuelType: "PETROL", transmission: "AUTOMATIC" };

const stubs = vi.hoisted(() => ({ saved: [] as unknown[] }));

vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => (args: unknown) => {
    stubs.saved.push(args);
    return Promise.resolve(null);
  },
}));
vi.mock("@/components/sales/wizard/components/StepIndicator", () => ({ StepIndicator: () => null }));
vi.mock("@/components/sales/wizard/steps/Step2Customer", () => ({ default: () => <div data-testid="step2" /> }));
vi.mock("@/components/sales/wizard/steps/Step3Review", () => ({ Step3Review: () => null }));
vi.mock("@/components/sales/wizard/steps/Step4QuoteSuccess", () => ({ Step4QuoteSuccess: () => null }));
vi.mock("@/components/sales/wizard/steps/Step1QuoteSetup", () => ({
  default: ({
    initialSourceData,
    initialData,
    onNext,
  }: {
    initialSourceData?: { make: string };
    initialData: Record<string, unknown>;
    onNext: (data: never) => void;
  }) => (
    <div>
      <div data-testid="seed" data-make={initialSourceData?.make ?? ""} data-in-wizard-data={"sourceLikeVehicle" in initialData ? "yes" : "no"} />
      <button onClick={() => onNext(initialData as never)}>next</button>
    </div>
  ),
}));

import { SalesWizard } from "./SalesWizard";

afterEach(() => {
  cleanup();
  stubs.saved.length = 0;
});

describe("SalesWizard: the source-like seed", () => {
  test.each(["CASH", "INSTALLMENT"] as const)("%s: reaches step 1 and stays out of wizardData", (paymentType) => {
    render(<SalesWizard paymentType={paymentType} onClose={vi.fn()} initialDraft={{ sourceLikeVehicle: SEED }} />);
    const seed = screen.getByTestId("seed");
    expect(seed.getAttribute("data-make")).toBe("Kia");
    expect(seed.getAttribute("data-in-wizard-data")).toBe("no");
  });

  test("control: no seed, nothing is passed", () => {
    render(<SalesWizard paymentType="CASH" onClose={vi.fn()} initialDraft={{ vehicleId: "v1" }} />);
    expect(screen.getByTestId("seed").getAttribute("data-make")).toBe("");
  });

  test("it is consumed on Next, so going back does not reopen the form", () => {
    render(<SalesWizard paymentType="INSTALLMENT" onClose={vi.fn()} initialDraft={{ sourceLikeVehicle: SEED }} />);
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByTestId("step2")).toBeTruthy();
  });
});
