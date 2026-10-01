/// <reference types="jest" />

/**
 * SCRUM-469 coverage: (1) the reconciliation notice names a failed FORFEIT when the
 * operator then tries a REFUND; (2) a vehicle's reservation identity is minted once,
 * reused on retry after a failure and retired only on success; (3) the "idempotency
 * key reused with different request content" refusal is explained plainly.
 */
import { fireEvent, render } from "@testing-library/react-native";
import { Alert } from "react-native";
import * as SecureStore from "expo-secure-store";
import { useMutation, useQuery } from "convex/react";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
  useQuery: jest.fn(),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("@clerk/expo", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));
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
const mockGetItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

const releaseDeposit = jest.fn();
const createReservation = jest.fn();

function query(ref: unknown) {
  if (ref === api.memberships.getMyMembership) {
    return { permissions: ["view:vehicle_info", "approve:requests", "edit:vehicles", "view:customers"] };
  }
  if (ref === api.vehicles.get) {
    return { _id: "veh_1", year: 2024, make: "Toyota", model: "Camry", status: "AVAILABLE", sellingPrice: 20000, mileage: 1000, color: "White", fuelType: "PETROL", transmission: "AUTOMATIC", vin: "VIN1" };
  }
  if (ref === api.deposits.listByVehicle) {
    return [{ _id: "dep_1", amount: 1000, status: "HELD", releaseCount: 0 }];
  }
  if (ref === api.customers.list) {
    return { page: [{ _id: "cust_1", name: "Sam" }], isDone: true, continueCursor: "" };
  }
  if (ref === api.vehicles.getReservationHistory) return [];
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

type AlertButton = { text?: string; onPress?: () => void };
let alertSpy: jest.SpyInstance;

beforeEach(() => {
  releaseDeposit.mockReset();
  createReservation.mockReset();
  mockGetItem.mockResolvedValue(null);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  mockUseQuery.mockImplementation(((ref: unknown, args: unknown) =>
    args === "skip" ? undefined : query(ref)) as unknown as typeof useQuery);
  mockUseMutation.mockImplementation(((ref: unknown) => {
    if (ref === api.deposits.release) return releaseDeposit;
    if (ref === api.vehicles.createReservation) return createReservation;
    return jest.fn();
  }) as unknown as typeof useMutation);
});
afterEach(() => jest.restoreAllMocks());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const pressAlertButton = async (text: string) => {
  const buttons = alertSpy.mock.calls.at(-1)![2] as AlertButton[];
  buttons.find((button) => button.text === text)!.onPress!();
  await settle();
};

describe.each([
  { locale: "en", forfeit: "Forfeit", refund: "Refund", method: "Refund method", attempt: "Earlier attempt: Forfeit" },
  { locale: "ar", forfeit: "مصادرة", refund: "استرداد", method: "طريقة الاسترداد", attempt: "المحاولة السابقة: مصادرة" },
])("reconciliation notice after a failed forfeit ($locale)", ({ locale, forfeit, refund, method, attempt }) => {
  test("a refund after an unconfirmed forfeit is not sent and the notice names the forfeit", async () => {
    mockGetItem.mockResolvedValue(locale);
    releaseDeposit.mockRejectedValue(new Error("lost"));
    const view = await render(tree());
    await view.findByRole("button", { name: refund });

    await fireEvent.press(view.getByRole("button", { name: forfeit }));
    await pressAlertButton(forfeit);
    expect(releaseDeposit).toHaveBeenCalledTimes(1);
    expect(releaseDeposit.mock.calls[0]![0].resolution).toBe("FORFEITED");

    await fireEvent.changeText(view.getByTestId(`select-${method}`), "CASH");
    await fireEvent.press(view.getByRole("button", { name: refund }));
    await pressAlertButton(refund);

    expect(releaseDeposit).toHaveBeenCalledTimes(1);
    expect(String(alertSpy.mock.calls.at(-1)![1])).toContain(attempt);
  });
});

describe("reservation create identity", () => {
  const CREATE = "Create reservation";
  const IDEMPOTENCY_MESSAGE =
    "An earlier attempt to create this reservation may already have gone through. Check the vehicle's reservations, or re-enter the same customer, deposit and payment method as before.";

  const openForm = async () => {
    mockGetItem.mockResolvedValue("en");
    const view = await render(tree());
    await fireEvent.press(await view.findByRole("button", { name: "Reservations" }));
    await fireEvent.changeText(await view.findByTestId("select-Customer"), "cust_1");
    return view;
  };
  const create = async (view: Awaited<ReturnType<typeof render>>) => {
    await fireEvent.press(view.getByRole("button", { name: CREATE }));
    await settle();
  };
  const alertTitles = () => alertSpy.mock.calls.map((call) => call[0]);

  test("a retry after a failure reuses the key; a success retires it so the next create mints a new one", async () => {
    createReservation.mockRejectedValueOnce(new Error("network")).mockResolvedValue(undefined);
    const view = await openForm();

    await create(view); // fails
    await fireEvent.changeText(view.getByTestId("select-Customer"), "cust_1");
    await create(view); // retry succeeds
    await fireEvent.changeText(view.getByTestId("select-Customer"), "cust_1");
    await create(view); // a fresh reservation

    expect(createReservation).toHaveBeenCalledTimes(3);
    const keys = createReservation.mock.calls.map((call) => call[0].idempotencyKey as string);
    expect(keys[0]).toMatch(/^vehicle-reservation:/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toMatch(/^vehicle-reservation:/);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test("an Error carrying the idempotency refusal shows the plain 'may already have gone through' alert", async () => {
    createReservation.mockRejectedValue(new Error("Idempotency key reused with different request content"));
    const view = await openForm();
    await create(view);

    expect(alertSpy).toHaveBeenCalledWith(IDEMPOTENCY_MESSAGE);
    expect(alertTitles()).not.toContain("Could not save");
  });

  test("a ConvexError-like non-Error with string data triggers the same alert", async () => {
    createReservation.mockRejectedValue({ data: "Idempotency key reused with different request content" });
    const view = await openForm();
    await create(view);

    expect(alertSpy).toHaveBeenCalledWith(IDEMPOTENCY_MESSAGE);
    expect(alertTitles()).not.toContain("Could not save");
  });

  test("a generic failure reports the generic error and not the idempotency alert", async () => {
    createReservation.mockRejectedValue(new Error("boom"));
    const view = await openForm();
    await create(view);

    expect(alertSpy).not.toHaveBeenCalledWith(IDEMPOTENCY_MESSAGE);
    expect(alertTitles()).toContain("Could not save");
  });
});
