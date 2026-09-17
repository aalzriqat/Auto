import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CollectionsTab } from "./CollectionsTab";

let mockCustomerQueryArgs: any = null;
let mockVehicleQueryArgs: any = null;

// Mock data representing a record outside the first 1,000
const needleCustomer = {
  _id: "cust_needle_1001",
  firstName: "Needle",
  lastName: "Outside1000",
  phone: "+962790001001",
  email: "needle1001@example.com",
};

const needleVehicle = {
  _id: "veh_needle_1001",
  year: 2024,
  make: "AstonMartin",
  model: "VantageOutside1000",
  vin: "SCVAD293810019999",
  status: "AVAILABLE",
};

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_123" }),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
    isRtl: false,
    locale: "en",
  }),
}));

vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (val: number) => String(val),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: () => true,
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: any, args: any) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "collections:summary") {
        return {
          receivablesCount: 0,
          totalReceivables: 0,
          chequesCount: 0,
          totalCheques: 0,
        };
      }
      if (name === "customers:selectorOptions") {
        mockCustomerQueryArgs = args;
        if (args.search === "Outside1000") {
          return [needleCustomer];
        }
        return [];
      }
      if (name === "vehicles:selectorOptions") {
        mockVehicleQueryArgs = args;
        if (args.search === "Vantage") {
          return [needleVehicle];
        }
        return [];
      }
      if (name === "customers:get") {
        if (args.customerId === needleCustomer._id) return needleCustomer;
        return undefined;
      }
      if (name === "vehicles:get") {
        if (args.vehicleId === needleVehicle._id) return needleVehicle;
        return undefined;
      }
      return undefined;
    },
    usePaginatedQuery: () => ({
      results: [],
      status: "Done",
      loadMore: vi.fn(),
    }),
    useMutation: () => vi.fn().mockResolvedValue({}),
  };
});

describe("CollectionsTab Customer & Vehicle Searchable Selectors", () => {
  afterEach(() => {
    cleanup();
    mockCustomerQueryArgs = null;
    mockVehicleQueryArgs = null;
  });

  test("discovers and selects customer and vehicle outside first 1,000 via server-backed search", async () => {
    render(<CollectionsTab />);

    // Open New Receivable Dialog
    const newReceivableBtn = screen.getByText("NewReceivable");
    fireEvent.click(newReceivableBtn);

    // Dialog should open
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeDefined();

    // Find the customer selector trigger button within the dialog
    const customerSelectTrigger = dialog.querySelector("button span.line-clamp-1");
    expect(customerSelectTrigger?.textContent).toBe("Customer");
    fireEvent.click(customerSelectTrigger!);

    // Type search query into customer search input
    const searchInputs = screen.getAllByPlaceholderText("SearchCustomersPlaceholder");
    const customerSearchInput = searchInputs[0];
    fireEvent.change(customerSearchInput, { target: { value: "Outside1000" } });

    // Assert query was issued to server with the search string
    expect(mockCustomerQueryArgs).toEqual({
      orgId: "org_123",
      search: "Outside1000",
    });

    // The option outside the first 1,000 should appear in the dropdown
    await waitFor(() => {
      expect(screen.getByText("Needle Outside1000")).toBeDefined();
    });

    // Click to select the customer
    fireEvent.click(screen.getByText("Needle Outside1000"));

    // Now find and click vehicle selector trigger within dialog
    const triggers = dialog.querySelectorAll("button span.line-clamp-1");
    // Second SearchableSelect trigger has noneLabel="NoVehicle" when no vehicle is selected
    const vehicleSelectTrigger = Array.from(triggers).find((el) => el.textContent === "NoVehicle");
    expect(vehicleSelectTrigger).toBeDefined();
    fireEvent.click(vehicleSelectTrigger!);

    // Type search query into vehicle search input
    const vehicleSearchInputs = screen.getAllByPlaceholderText("SearchVehiclesPlaceholder");
    const vehicleSearchInput = vehicleSearchInputs[0];
    fireEvent.change(vehicleSearchInput, { target: { value: "Vantage" } });

    // Assert query was issued to server with the search string
    expect(mockVehicleQueryArgs).toEqual({
      orgId: "org_123",
      search: "Vantage",
    });

    // The vehicle outside the first 1,000 should appear
    await waitFor(() => {
      expect(screen.getByText("2024 AstonMartin VantageOutside1000")).toBeDefined();
    });

    // Click to select the vehicle
    fireEvent.click(screen.getByText("2024 AstonMartin VantageOutside1000"));

    // Verify selected values are visible on the form
    expect(screen.getByText("Needle Outside1000")).toBeDefined();
    expect(screen.getByText("2024 AstonMartin VantageOutside1000")).toBeDefined();
  });
});
