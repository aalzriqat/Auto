/// <reference types="jest" />

/**
 * SCRUM-55 (Codex SCRUM-55-1). The mobile quote wizard showed "Cost" =
 * purchasePrice and "Margin" = price − purchasePrice. The books cost an owned
 * vehicle at purchase + landed cost + capitalized net expenses, so a 10,000
 * purchase with 1,000 landed cost quoted at 12,000 read 2,000 on screen and
 * 1,000 in the ledger. The wizard must not derive a cost or margin figure.
 */
import { fireEvent, render } from "@testing-library/react-native";
import { useMutation, useQuery } from "convex/react";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
  useQuery: jest.fn(),
}));
jest.mock("expo-print", () => ({ printToFileAsync: jest.fn() }));
jest.mock("expo-sharing", () => ({ shareAsync: jest.fn(), isAvailableAsync: jest.fn() }));

import { api } from "../../../convexApi";
import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { SalesWizardScreen, type WizardPaymentType } from "./SalesWizardScreen";

const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;

const VEHICLE = {
  _id: "veh_1",
  year: 2024,
  make: "Toyota",
  model: "Camry",
  vin: "VIN1",
  status: "AVAILABLE",
  sellingPrice: 12000,
  purchasePrice: 10000,
  landedCostTotal: 1000,
  minimumProfit: 0,
};

function query(ref: unknown) {
  if (ref === api.vehicles.listAll) return [VEHICLE];
  if (ref === api.wizardDrafts.getMyDraft) return null;
  if (ref === api.memberships.getMyMembership) return { permissions: [] };
  return undefined;
}

function tree(paymentType: WizardPaymentType) {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <SalesWizardScreen onClose={jest.fn()} orgId="org_1" paymentType={paymentType} />
      </LocaleProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  mockUseQuery.mockImplementation(((ref: unknown, args: unknown) =>
    args === "skip" ? undefined : query(ref)) as unknown as typeof useQuery);
  mockUseMutation.mockImplementation((() => jest.fn()) as unknown as typeof useMutation);
});

describe.each<WizardPaymentType>(["CASH", "INSTALLMENT"])(
  "SalesWizardScreen (%s) shows no derived cost or margin (SCRUM-55)",
  (paymentType) => {
    test("a selected vehicle with a cost price shows neither Cost nor Margin", async () => {
      const view = await render(tree(paymentType));
      await fireEvent.press(view.getByText("اختر سيارة من المخزون"));
      await fireEvent.press(view.getAllByText("2024 Toyota Camry")[0]);

      // Control: the vehicle really is selected, so the panel would have rendered.
      expect(view.queryByText("اختر سيارة من المخزون")).toBeNull();
      expect(view.getAllByText("2024 Toyota Camry").length).toBeGreaterThan(0);

      expect(view.queryByText("الهامش")).toBeNull();
      expect(view.queryByText("التكلفة")).toBeNull();
    });
  },
);
