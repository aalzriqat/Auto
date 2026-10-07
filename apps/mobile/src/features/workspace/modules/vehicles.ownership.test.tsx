/// <reference types="jest" />

/**
 * SCRUM-717 (D-45): a NEW vehicle on mobile carries an explicit ownership decision.
 * These tests drive the real `VehiclesModule` create wizard and pin the inline
 * validation that stops an unanswered or inconsistent ownership from reaching the
 * server (which re-validates every one of these), plus the wire shape of the two
 * ownership kinds. Messages come from the shared locale helpers, not new copy.
 */
import { act, fireEvent, render } from "@testing-library/react-native";
import { Alert } from "react-native";
import * as SecureStore from "expo-secure-store";
import { useMutation, usePaginatedQuery } from "convex/react";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
  usePaginatedQuery: jest.fn(),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("./moduleShared", () => {
  const actual = jest.requireActual("./moduleShared");
  return {
    ...actual,
    // The real SelectField opens a searchable modal; a plain input keeps the test on
    // the form logic. The error is surfaced so a refusal on the select is observable.
    SelectField: ({ label, value, onChange, error }: { label: string; value: string; onChange: (v: string) => void; error?: string }) => {
      const { Text: Label, TextInput: Input } = jest.requireActual("react-native");
      return (
        <>
          <Input testID={`select-${label}`} value={value} onChangeText={onChange} />
          {error ? <Label testID={`select-${label}-error`}>{error}</Label> : null}
        </>
      );
    },
  };
});

import { api } from "../../../convexApi";
import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { invalidNumberMessage, requiredFieldMessage, requiredSelectionMessage } from "./moduleShared";
import { VehiclesModule } from "./vehicles";

const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockUsePaginatedQuery = usePaginatedQuery as jest.MockedFunction<typeof usePaginatedQuery>;
const mockGetItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

const createVehicle = jest.fn();
const updateVehicle = jest.fn();
const VALID_VIN = "1HGCM82633A004352";

beforeEach(() => {
  createVehicle.mockReset();
  updateVehicle.mockReset();
  updateVehicle.mockResolvedValue(null);
  createVehicle.mockResolvedValue("veh_new");
  mockGetItem.mockResolvedValue("en");
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  mockUsePaginatedQuery.mockReturnValue({
    results: [],
    status: "Exhausted",
    loadMore: jest.fn(),
    isLoading: false,
  } as unknown as ReturnType<typeof usePaginatedQuery>);
  // Only the create mutation is observed; every other mutation is an inert stub.
  mockUseMutation.mockImplementation(((ref: unknown) => (ref === api.vehicles.create ? createVehicle : ref === api.vehicles.update ? updateVehicle : jest.fn())) as unknown as typeof useMutation);
});
afterEach(() => jest.restoreAllMocks());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type View = Awaited<ReturnType<typeof render>>;

async function openWizard(): Promise<View> {
  const view = await render(
    <ThemeProvider>
      <LocaleProvider>
        <VehiclesModule orgId="org_1" permissions={["edit:vehicles"]} />
      </LocaleProvider>
    </ThemeProvider>,
  );
  await fireEvent.press(await view.findByRole("button", { name: "Add" }));
  return view;
}

const next = async (view: View) => fireEvent.press(await view.findByRole("button", { name: "Next" }));

/** Fills the vehicle basics (steps 1-2 of 3) and leaves the wizard on step 2 with ownership untouched. */
async function fillBasics(view: View) {
  await fireEvent.changeText(view.getByLabelText("VIN"), VALID_VIN);
  await fireEvent.changeText(view.getByTestId("select-Make"), "Honda");
  await fireEvent.changeText(view.getByLabelText("Model"), "Accord");
  await fireEvent.changeText(view.getByLabelText("Year"), "2022");
  await next(view);
  await fireEvent.changeText(view.getByLabelText("Mileage"), "12000");
  await fireEvent.changeText(view.getByLabelText("Selling price"), "20000");
}

/** Advances to the review step and presses save. */
async function save(view: View) {
  await next(view);
  await fireEvent.press(await view.findByRole("button", { name: "Save vehicle" }));
  await settle();
}

const required = requiredFieldMessage("en");
const invalidNumber = invalidNumberMessage("en");
const chooseOption = requiredSelectionMessage("en");

describe("mobile new-vehicle ownership validation", () => {
  test("refuses to save with no ownership choice and returns the operator to the question", async () => {
    const view = await openWizard();
    await fillBasics(view);
    // Nothing is pre-selected: the neutral hint is shown until a choice is made.
    expect(view.getByText("Choose consignment or owned to continue.")).toBeTruthy();

    await save(view);

    expect(createVehicle).not.toHaveBeenCalled();
    // The ownership questions live on step 2, so the refusal walks back to it.
    expect(view.getByText(chooseOption)).toBeTruthy();
    expect(view.getByRole("button", { name: "Next" })).toBeTruthy();
  });

  test("consignment needs a supplier and a positive cost", async () => {
    const view = await openWizard();
    await fillBasics(view);
    await fireEvent.press(view.getByText("Consignment"));
    expect(view.getByText("The supplier's car, on sale for them. Nothing is paid now.")).toBeTruthy();
    await fireEvent.changeText(view.getByLabelText("Supplier cost"), "0");

    await save(view);

    expect(createVehicle).not.toHaveBeenCalled();
    expect(view.getByText(required)).toBeTruthy();
    expect(view.getByText(invalidNumber)).toBeTruthy();
  });

  test("an owned car with an entered price must have a positive one", async () => {
    const view = await openWizard();
    await fillBasics(view);
    await fireEvent.press(view.getByText("Owned"));
    expect(view.getByText("The dealership bought this car. Enter the price and how it was paid.")).toBeTruthy();
    await fireEvent.changeText(view.getByLabelText("Purchase price"), "0");

    await save(view);

    expect(createVehicle).not.toHaveBeenCalled();
    expect(view.getByText(invalidNumber)).toBeTruthy();
  });

  test("an owned car with a price must say how it was paid", async () => {
    const view = await openWizard();
    await fillBasics(view);
    await fireEvent.press(view.getByText("Owned"));
    await fireEvent.changeText(view.getByLabelText("Purchase price"), "15000");

    await save(view);

    expect(createVehicle).not.toHaveBeenCalled();
    expect(view.getByTestId("select-Payment method-error").props.children).toBe(chooseOption);
  });

  test("paying on account names the supplier owed", async () => {
    const view = await openWizard();
    await fillBasics(view);
    await fireEvent.press(view.getByText("Owned"));
    await fireEvent.changeText(view.getByLabelText("Purchase price"), "15000");
    await fireEvent.changeText(view.getByTestId("select-Payment method"), "ON_ACCOUNT");

    await save(view);

    expect(createVehicle).not.toHaveBeenCalled();
    expect(view.getByText(required)).toBeTruthy();
  });
});

describe("mobile new-vehicle ownership wire shape", () => {
  test("a valid owned car carries its price and settlement and no consignment supplier", async () => {
    const view = await openWizard();
    await fillBasics(view);
    await fireEvent.press(view.getByText("Owned"));
    await fireEvent.changeText(view.getByLabelText("Purchase price"), "15000");
    await fireEvent.changeText(view.getByTestId("select-Payment method"), "CASH");

    await save(view);

    expect(createVehicle).toHaveBeenCalledTimes(1);
    const args = createVehicle.mock.calls[0]![0];
    expect(args).toMatchObject({ sourceType: "STOCK", purchasePrice: 15000, purchasePaymentMethod: "CASH", sellingPrice: 20000 });
    expect(args).not.toHaveProperty("sourcedFromName");
    expect(args).not.toHaveProperty("purchaseSupplierName");
  });

  test("an owned car paid on account also carries the trimmed supplier", async () => {
    const view = await openWizard();
    await fillBasics(view);
    await fireEvent.press(view.getByText("Owned"));
    await fireEvent.changeText(view.getByLabelText("Purchase price"), "15000");
    await fireEvent.changeText(view.getByTestId("select-Payment method"), "ON_ACCOUNT");
    await fireEvent.changeText(view.getByLabelText("Supplier owed on account"), "  Gulf Motors ");

    await save(view);

    expect(createVehicle).toHaveBeenCalledTimes(1);
    expect(createVehicle.mock.calls[0]![0]).toMatchObject({
      sourceType: "STOCK",
      purchasePaymentMethod: "ON_ACCOUNT",
      purchaseSupplierName: "Gulf Motors",
    });
  });

  test("an owned car may be entered unpriced", async () => {
    const view = await openWizard();
    await fillBasics(view);
    await fireEvent.press(view.getByText("Owned"));

    await save(view);

    expect(createVehicle).toHaveBeenCalledTimes(1);
    const args = createVehicle.mock.calls[0]![0];
    expect(args.sourceType).toBe("STOCK");
    expect(args.purchasePrice).toBeUndefined();
    expect(args).not.toHaveProperty("purchasePaymentMethod");
  });

  test("a valid consignment car carries its supplier and cost and never a purchase price", async () => {
    const view = await openWizard();
    await fillBasics(view);
    await fireEvent.press(view.getByText("Consignment"));
    await fireEvent.changeText(view.getByLabelText("Supplier name"), " Al Noor ");
    await fireEvent.changeText(view.getByLabelText("Supplier cost"), "9000");

    await save(view);

    expect(createVehicle).toHaveBeenCalledTimes(1);
    const args = createVehicle.mock.calls[0]![0];
    expect(args).toMatchObject({ sourceType: "SOURCED", sourcedFromName: "Al Noor", sourceCost: 9000 });
    expect(args).not.toHaveProperty("purchasePrice");
    expect(args).not.toHaveProperty("purchasePaymentMethod");
  });
});

describe("editing an existing vehicle", () => {
  test("is not asked an ownership question and sends the update, not a create", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        {
          _id: "veh_1", vin: VALID_VIN, make: "Honda", model: "Accord", year: 2022, mileage: 12000,
          color: "Black", fuelType: "Petrol", transmission: "Automatic", sellingPrice: 20000,
          purchasePrice: 15000, status: "AVAILABLE",
        },
      ],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    } as unknown as ReturnType<typeof usePaginatedQuery>);
    const view = await render(
      <ThemeProvider>
        <LocaleProvider>
          <VehiclesModule orgId="org_1" permissions={["edit:vehicles"]} />
        </LocaleProvider>
      </ThemeProvider>,
    );

    await fireEvent.press(await view.findByRole("button", { name: "More options" }));
    const buttons = alertSpy.mock.calls.at(-1)![2] as Array<{ text?: string; onPress?: () => void }>;
    await act(async () => buttons.find((button) => button.text === "Edit")!.onPress!());

    await next(view);
    // Edit mode shows the plain purchase-price field and no ownership chooser.
    expect(view.queryByText("Vehicle ownership")).toBeNull();
    await next(view);
    await fireEvent.press(await view.findByRole("button", { name: "Save vehicle" }));
    await settle();

    expect(createVehicle).not.toHaveBeenCalled();
    expect(updateVehicle).toHaveBeenCalledTimes(1);
    expect(updateVehicle.mock.calls[0]![0]).toMatchObject({ vehicleId: "veh_1", purchasePrice: 15000, sellingPrice: 20000 });
  });
});