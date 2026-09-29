/// <reference types="jest" />

/**
 * SCRUM-469 round 1 (SOL-01 / OPUS-F2). A refund method belongs to ONE payout:
 * a confirmed partial payout advances the deposit's `releaseCount`, and the
 * method chosen for the previous payout must not apply to the next one.
 */
import { fireEvent, render } from "@testing-library/react-native";
import { useMutation, useQuery } from "convex/react";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
  useQuery: jest.fn(),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("@clerk/expo", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));
// The real SelectField opens a searchable modal; a plain input keeps the test on
// the state under test (which method the screen holds), not on the picker UI.
jest.mock("./modules/moduleShared", () => {
  const actual = jest.requireActual("./modules/moduleShared");
  return {
    ...actual,
    SelectField: ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => {
      const { TextInput: Input } = jest.requireActual("react-native");
      return <Input testID={`select-${label}`} value={value} onChangeText={onChange} />;
    },
  };
});

import { api } from "../../convexApi";
import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import { VehicleDetailScreen } from "./VehicleDetailScreen";

const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;

const REFUND_LABEL = "طريقة الاسترداد";
const REFUND_BUTTON = "استرداد";

let releaseCount = 0;
const releaseDeposit = jest.fn();

function query(ref: unknown) {
  if (ref === api.memberships.getMyMembership) {
    return { permissions: ["view:vehicle_info", "approve:requests"] };
  }
  if (ref === api.vehicles.get) {
    return { _id: "veh_1", year: 2024, make: "Toyota", model: "Camry", status: "AVAILABLE", sellingPrice: 20000, mileage: 1000, color: "White", fuelType: "PETROL", transmission: "AUTOMATIC", vin: "VIN1" };
  }
  if (ref === api.deposits.listByVehicle) {
    return [{ _id: "dep_1", amount: 1000, status: "HELD", releaseCount }];
  }
  return undefined;
}

function tree() {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <VehicleDetailScreen orgId="org_1" vehicleId="veh_1" />
      </LocaleProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  releaseCount = 0;
  releaseDeposit.mockReset();
  mockUseQuery.mockImplementation(((ref: unknown, args: unknown) =>
    args === "skip" ? undefined : query(ref)) as unknown as typeof useQuery);
  mockUseMutation.mockImplementation(((ref: unknown) =>
    ref === api.deposits.release ? releaseDeposit : jest.fn()) as unknown as typeof useMutation);
});

describe("VehicleDetailScreen refund method is per payout (SCRUM-469 round 1)", () => {
  test("a partial payout (releaseCount advances) clears the method chosen for the previous payout", async () => {
    const view = await render(tree());
    await fireEvent.changeText(view.getByTestId(`select-${REFUND_LABEL}`), "CASH");
    expect(view.getByTestId(`select-${REFUND_LABEL}`).props.value).toBe("CASH");

    releaseCount = 1;
    await view.rerender(tree());

    expect(view.getByTestId(`select-${REFUND_LABEL}`).props.value).toBe("");
    expect(view.getByRole("button", { name: REFUND_BUTTON }).props.accessibilityState?.disabled ?? false).toBe(true);
  });

  test("control: the same generation keeps its method", async () => {
    const view = await render(tree());
    await fireEvent.changeText(view.getByTestId(`select-${REFUND_LABEL}`), "CASH");
    await view.rerender(tree());
    expect(view.getByTestId(`select-${REFUND_LABEL}`).props.value).toBe("CASH");
  });
});
