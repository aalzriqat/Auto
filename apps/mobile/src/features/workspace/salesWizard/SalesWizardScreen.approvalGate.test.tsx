/// <reference types="jest" />

/**
 * SCRUM-260. The server honours an approval only for the exact terms it was
 * recorded for, so the mobile wizard must block again when the price moves off
 * an approved uplift. These tests render the real screen: a unit test of the
 * shared helper alone would stay green if the screen went back to its own
 * `uplift >= requestedProfit` formula.
 *
 * The screen renders in Arabic by default. List price 12,000, minimum uplift
 * 1,000, financed quote.
 */
import { fireEvent, render } from "@testing-library/react-native";
import { useMutation, useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
  useQueries: jest.fn(() => ({})),
  useQuery: jest.fn(),
}));
jest.mock("expo-print", () => ({ printToFileAsync: jest.fn() }));
jest.mock("expo-sharing", () => ({ shareAsync: jest.fn(), isAvailableAsync: jest.fn() }));

import { api, type MobileWizardDraft } from "../../../convexApi";
import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { SalesWizardScreen } from "./SalesWizardScreen";
import { upliftApprovedText } from "./minimumUpliftCopy";

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
  minimumProfit: 1000,
};

const BLOCKED_TITLE = "موافقة مطلوبة";
const APPROVED_NOTE = upliftApprovedText("ar");

let storedApproval: Record<string, unknown> | null = null;
// SCRUM-886: a role without view:cost_price gets the vehicle without `minimumProfit`.
let minimumWithheld = false;

function query(ref: unknown) {
  if (ref === api.vehicles.listAll) {
    if (!minimumWithheld) return [VEHICLE];
    const { minimumProfit: _withheld, ...withoutMinimum } = VEHICLE;
    return [withoutMinimum];
  }
  if (ref === api.approvals.profitApprovalStatus) {
    return { status: "REQUIRED", margin: 200, minimumProfit: VEHICLE.minimumProfit };
  }
  if (ref === api.wizardDrafts.getMyDraft) return null;
  if (ref === api.memberships.getMyMembership) return { permissions: [] };
  if (ref === api.approvals.checkPendingApproval) return storedApproval;
  return undefined;
}

beforeEach(() => {
  storedApproval = null;
  minimumWithheld = false;
  jest.mocked(useQueries).mockReturnValue({});
  mockUseQuery.mockImplementation(((ref: unknown, args: unknown) =>
    args === "skip" ? undefined : query(ref)) as unknown as typeof useQuery);
  mockUseMutation.mockImplementation((() => jest.fn()) as unknown as typeof useMutation);
});

async function openWithPrice(paymentType: "INSTALLMENT" | "CASH", price: string) {
  const view = await render(
    <ThemeProvider>
      <LocaleProvider>
        <SalesWizardScreen onClose={jest.fn()} orgId="org_1" paymentType={paymentType} />
      </LocaleProvider>
    </ThemeProvider>,
  );
  await fireEvent.press(view.getByText("اختر سيارة من المخزون"));
  await fireEvent.press(view.getAllByText("2024 Toyota Camry")[0]);
  // Selecting the vehicle fills the price with the list price.
  await fireEvent.changeText(view.getByDisplayValue("12000"), price);
  return view;
}

describe("SalesWizardScreen approval gate follows the server's exact-terms rule (SCRUM-260)", () => {
  test("no approval: a price below the minimum uplift is blocked", async () => {
    const view = await openWithPrice("INSTALLMENT", "12200");
    expect(view.queryByText(BLOCKED_TITLE)).not.toBeNull();
    expect(view.queryByText(APPROVED_NOTE)).toBeNull();
  });

  test("an approval for exactly this uplift and minimum unblocks", async () => {
    storedApproval = { status: "APPROVED", requestedProfit: 200, minimumProfit: 1000 };
    const view = await openWithPrice("INSTALLMENT", "12200");
    expect(view.queryByText(APPROVED_NOTE)).not.toBeNull();
    expect(view.queryByText(BLOCKED_TITLE)).toBeNull();
  });

  test("stale approval: +200 was approved, the price moved to +500, so it is blocked again", async () => {
    storedApproval = { status: "APPROVED", requestedProfit: 200, minimumProfit: 1000 };
    const view = await openWithPrice("INSTALLMENT", "12500");
    expect(view.queryByText(BLOCKED_TITLE)).not.toBeNull();
    expect(view.queryByText(APPROVED_NOTE)).toBeNull();
  });

  test("an approval that names no minimum is not trusted", async () => {
    storedApproval = { status: "APPROVED", requestedProfit: 200 };
    const view = await openWithPrice("INSTALLMENT", "12200");
    expect(view.queryByText(BLOCKED_TITLE)).not.toBeNull();
    expect(view.queryByText(APPROVED_NOTE)).toBeNull();
  });

  test("SCRUM-886: with the vehicle's minimum withheld, the server's verdict still blocks a price below it", async () => {
    minimumWithheld = true;
    const view = await openWithPrice("INSTALLMENT", "12200");
    expect(view.queryByText(BLOCKED_TITLE)).not.toBeNull();
  });

  test("SCRUM-886: with the vehicle's minimum withheld, an approval for exactly these terms still unblocks", async () => {
    minimumWithheld = true;
    storedApproval = { status: "APPROVED", requestedProfit: 200, minimumProfit: 1000 };
    const view = await openWithPrice("INSTALLMENT", "12200");
    expect(view.queryByText(APPROVED_NOTE)).not.toBeNull();
    expect(view.queryByText(BLOCKED_TITLE)).toBeNull();
  });

  test("a cash quote is exempt", async () => {
    const view = await openWithPrice("CASH", "12200");
    expect(view.queryByText(BLOCKED_TITLE)).toBeNull();
  });
});

describe("resuming a native cash quote", () => {
  const customer = {
    _id: "customer_1",
    firstName: "Saved",
    lastName: "Customer",
  } satisfies FunctionReturnType<typeof api.customers.get>;
  const picker = {
    page: [{ _id: "customer_2", firstName: "Another", lastName: "Customer" }],
    isDone: false,
    continueCursor: "next-page",
  } satisfies FunctionReturnType<typeof api.customers.list>;
  const membership = {
    _id: "member_1",
    userId: "user_1",
    roleId: "role_1",
    roleName: "OWNER",
    permissions: ["view:sales", "view:customers"],
  } satisfies FunctionReturnType<typeof api.memberships.getMyMembership>;
  const reviewDraft: MobileWizardDraft = {
    paymentType: "CASH",
    currentStep: 3,
    selectedCustomerId: customer._id,
    savedAt: Date.UTC(2026, 10, 22),
    wizardData: {
      vehicleId: VEHICLE._id,
      vehiclePrice: VEHICLE.sellingPrice,
      desiredProfit: 0,
      downPayment: 0,
      termMonths: 0,
    },
  };

  async function renderSavedCashQuote(selectedCustomer: () => typeof customer | Error | undefined) {
    mockUseQuery.mockImplementation((ref, args?: unknown) => {
      if (args === "skip") return undefined;
      if (ref === api.wizardDrafts.getMyDraft) return reviewDraft;
      if (ref === api.customers.list) return picker;
      if (ref === api.memberships.getMyMembership) return membership;
      return query(ref);
    });
    jest.mocked(useQueries).mockImplementation((queries) => {
      if (!queries.customer) return {};
      expect(queries.customer).toEqual({
        query: api.customers.get,
        args: { orgId: "org_1", customerId: reviewDraft.selectedCustomerId },
      });
      return { customer: selectedCustomer() };
    });
    const quoteId = "quote_1" satisfies FunctionReturnType<typeof api.quotes.saveQuote>;
    const clearedDraft = null satisfies FunctionReturnType<typeof api.wizardDrafts.clearDraft>;
    mockUseMutation.mockImplementation((ref) =>
      Object.assign(jest.fn(async () => {
        if (ref === api.quotes.saveQuote) return quoteId;
        if (ref === api.wizardDrafts.clearDraft || ref === api.wizardDrafts.saveDraft) return clearedDraft;
        throw new Error("Unexpected Sales Wizard mutation");
      }), { withOptimisticUpdate: jest.fn() }),
    );
    const wizard = () => (
      <ThemeProvider>
        <LocaleProvider>
          <SalesWizardScreen onClose={jest.fn()} orgId="org_1" paymentType="CASH" />
        </LocaleProvider>
      </ThemeProvider>
    );
    const view = await render(wizard());
    return { view, refresh: () => view.rerender(wizard()) };
  }

  test("restores a customer outside the picker page and keeps the quote-only actions", async () => {
    let savedCustomer: typeof customer | Error | undefined;
    const { view, refresh } = await renderSavedCashQuote(() => savedCustomer);
    const resumeName = "استئناف المسودة";
    expect(await view.findByRole("button", { name: resumeName, disabled: true })).toBeTruthy();
    savedCustomer = new Error("connection interrupted");
    await refresh();
    expect(view.getByRole("button", { name: resumeName, disabled: true })).toBeTruthy();
    expect(view.getByRole("alert")).toBeTruthy();
    savedCustomer = customer;
    await refresh();
    await fireEvent.press(view.getByRole("button", { name: resumeName, disabled: false }));
    expect(view.getByText("Saved Customer")).toBeTruthy();
    await fireEvent.press(await view.findByRole("button", { name: "إنشاء العرض" }));
    expect(await view.findByRole("button", { name: "طلب تسجيل عربون" })).toBeTruthy();
    expect(view.getByRole("button", { name: "تسجيل مشاركة العرض مع العميل" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "إتمام البيع النقدي" })).toBeNull();
  });

  test("returns to the customer step when the saved customer is unavailable", async () => {
    const missingCustomer = new ConvexError("Customer not found in this organization.");
    const { view } = await renderSavedCashQuote(() => missingCustomer);
    await fireEvent.press(await view.findByRole("button", { name: "استئناف المسودة" }));
    expect(view.queryByRole("button", { name: "إنشاء العرض" })).toBeNull();
    await fireEvent.press(view.getByText("Another Customer"));
    const removeCustomer = view.getByRole("button", { name: "إزالة العميل المحدد" });
    await fireEvent.press(removeCustomer);
    expect(view.queryByRole("button", { name: "إزالة العميل المحدد" })).toBeNull();
  });
});
