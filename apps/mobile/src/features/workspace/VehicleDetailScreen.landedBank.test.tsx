/// <reference types="jest" />
import { fireEvent, render } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { useMutation, useQuery } from "convex/react";

jest.mock("convex/react", () => ({ useMutation: jest.fn(), useQuery: jest.fn() }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("@clerk/expo", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));
jest.mock("./modules/moduleShared", () => {
  const actual = jest.requireActual("./modules/moduleShared");
  return {
    ...actual,
    SelectField: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => {
      const { TextInput } = jest.requireActual("react-native");
      return <TextInput testID={`select-${label}`} value={value} onChangeText={onChange} />;
    },
  };
});

import { api } from "../../convexApi";
import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import { VehicleDetailScreen } from "./VehicleDetailScreen";

const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;
const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockGetItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
const upsert = jest.fn();
let landedItems: Array<{ label: string; amount: number; paymentMethod: "CASH" | "BANK_TRANSFER"; bankAccountId?: string }>;
let landedCostsResponse: { items: typeof landedItems; total: number };
const bankOptions = { banks: [{ _id: "bank_1", name: "Operating", currency: "JOD" }], truncated: false };

beforeEach(() => {
  landedItems = [{ label: "Repair", amount: 50, paymentMethod: "BANK_TRANSFER" }];
  landedCostsResponse = { items: landedItems, total: 50 };
  upsert.mockReset();
  upsert.mockResolvedValue({ total: 50 });
  mockGetItem.mockResolvedValue("en");
  mockUseQuery.mockImplementation(((ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === api.memberships.getMyMembership) return { permissions: ["view:vehicle_info", "edit:vehicles"] };
    if (ref === api.vehicles.get) return { _id: "veh_1", sourceType: "STOCK", year: 2024, make: "Toyota", model: "Camry", status: "AVAILABLE", sellingPrice: 20000, mileage: 1000, color: "White", fuelType: "PETROL", transmission: "AUTOMATIC", vin: "VIN1" };
    if (ref === api.vehicles.getLandedCosts) return landedCostsResponse;
    if (ref === api.vehicles.listAcquisitionBankOptions) return bankOptions;
    return undefined;
  }) as unknown as typeof useQuery);
  mockUseMutation.mockImplementation(((ref: unknown) => ref === api.vehicles.upsertLandedCosts ? upsert : jest.fn()) as unknown as typeof useMutation);
});

test("legacy bank-funded landed cost blocks mobile editing", async () => {
  const view = await render(<ThemeProvider><LocaleProvider><VehicleDetailScreen orgId="org_1" vehicleId="veh_1" /></LocaleProvider></ThemeProvider>);
  await fireEvent.press(view.getByText("Landed cost"));
  expect(view.getByText(/Finance must review its original payment/)).toBeTruthy();
  await fireEvent.press(view.getByRole("button", { name: "Save landed cost" }));
  expect(upsert).not.toHaveBeenCalled();
});

test("new bank-funded landed cost sends the chosen physical bank", async () => {
  landedItems = [{ label: "Repair", amount: 50, paymentMethod: "CASH" }];
  landedCostsResponse = { items: landedItems, total: 50 };
  const view = await render(<ThemeProvider><LocaleProvider><VehicleDetailScreen orgId="org_1" vehicleId="veh_1" /></LocaleProvider></ThemeProvider>);
  await fireEvent.press(view.getByText("Landed cost"));
  await fireEvent.changeText(view.getByTestId("select-Payment method"), "BANK_TRANSFER");
  expect(view.getByRole("button", { name: "Save landed cost" }).props.accessibilityState?.disabled).toBe(true);
  await fireEvent.changeText(view.getByTestId("select-Bank account paid from"), "bank_1");
  await fireEvent.press(view.getByRole("button", { name: "Save landed cost" }));
  expect(upsert).toHaveBeenCalledWith({ orgId: "org_1", vehicleId: "veh_1", items: [{ label: "Repair", amount: 50, paymentMethod: "BANK_TRANSFER", bankAccountId: "bank_1" }] });
});
