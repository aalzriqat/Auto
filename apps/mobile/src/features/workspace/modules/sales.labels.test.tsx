/// <reference types="jest" />

import { fireEvent, render } from "@testing-library/react-native";
import { usePaginatedQuery } from "convex/react";
import * as SecureStore from "expo-secure-store";
import type { MobileMyMembership, MobileSale } from "../../../convexApi";
import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { SalesModule } from "./sales";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(() => jest.fn()),
  usePaginatedQuery: jest.fn(),
  useQuery: jest.fn(),
}));

const sale: MobileSale = {
  _id: "sale_1",
  vehicleId: "car_1",
  customerId: "customer_1",
  salespersonId: "user_1",
  status: "PENDING",
  financingType: "LEASE",
  saleDate: Date.UTC(2026, 10, 22),
  salePrice: 12500,
  vehicleSummary: "Toyota Camry",
  vehicleVin: "VIN01234",
  customerName: "Test Customer",
  salespersonName: "Test Seller",
};

beforeEach(() => {
  jest.mocked(usePaginatedQuery).mockReturnValue({
    results: [sale],
    isLoading: false,
    status: "Exhausted",
    loadMore: jest.fn(),
  });
});

function renderSales(locale: "en" | "ar", permissions: string[]) {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(locale);
  const membership: MobileMyMembership = {
    _id: "member_1",
    userId: "user_1",
    roleId: "custom_role",
    roleName: "Custom role",
    permissions: ["view:sales", ...permissions],
  };
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <SalesModule myMembership={membership} orgId="org_1" />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

test("Arabic Sales labels a legacy lease in the list and detail, without offering writes to a reader", async () => {
  const view = await renderSales("ar", []);
  expect(view.getByText("تأجير")).toBeTruthy();
  const search = view.getByPlaceholderText("بحث المبيعات");
  await fireEvent.changeText(search, "تأجير");
  expect(view.getByText("Toyota Camry")).toBeTruthy();
  await fireEvent.changeText(search, "LEASE");
  expect(view.getByText("Toyota Camry")).toBeTruthy();
  const details = await view.findByRole("button", { name: "تفاصيل" });
  expect(view.queryByRole("button", { name: /^(مسودة|إتمام|إلغاء)$/ })).toBeNull();

  await fireEvent.press(details);
  expect(view.getAllByText("تأجير").length).toBeGreaterThan(1);
  expect(view.getByText("VIN01234")).toBeTruthy();
  expect(view.queryByText("PENDING")).toBeNull();
  expect(view.queryByRole("button", { name: /^(إتمام البيع|إلغاء البيع)$/ })).toBeNull();
});

test("English Sales preserves the write actions for a permitted operator", async () => {
  const view = await renderSales("en", ["create:sales", "edit:sales"]);
  expect(await view.findByText("Lease")).toBeTruthy();
  expect(view.getByRole("button", { name: "Draft" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Complete" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
});
