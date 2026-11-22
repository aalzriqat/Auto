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
import { useMutation, useQuery } from "convex/react";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
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
  const customer = { _id: "customer_1", firstName: "Test", lastName: "Customer" };
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

  async function renderSavedCashQuote(customerPage: () => "loading" | "found" | "missing") {
    mockUseQuery.mockImplementation(((ref: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      if (ref === api.wizardDrafts.getMyDraft) return reviewDraft;
      if (ref === api.customers.list) {
        const state = customerPage();
        if (state === "loading") return undefined;
        return { page: state === "found" ? [customer] : [{ ...customer, _id: "customer_2" }] };
      }
      if (ref === api.memberships.getMyMembership) {
        return { roleName: "OWNER", permissions: ["view:sales"] };
      }
      return query(ref);
    }) as unknown as typeof useQuery);
    mockUseMutation.mockImplementation(((ref: unknown) =>
      jest.fn(async () => ref === api.quotes.saveQuote ? "quote_1" : null)) as unknown as typeof useMutation);
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

  test("restores the customer and allows a quote-only operator to request a deposit", async () => {
    let page: "loading" | "found" = "loading";
    const { view, refresh } = await renderSavedCashQuote(() => page);
    const resumeName = "استئناف المسودة";
    expect(await view.findByRole("button", { name: resumeName, disabled: true })).toBeTruthy();
    page = "found";
    await refresh();
    await fireEvent.press(view.getByRole("button", { name: resumeName, disabled: false }));
    await fireEvent.press(await view.findByRole("button", { name: "إنشاء العرض" }));
    expect(await view.findByRole("button", { name: "طلب تسجيل عربون" })).toBeTruthy();
    expect(view.getByRole("button", { name: "تسجيل مشاركة العرض مع العميل" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "إتمام البيع النقدي" })).toBeNull();
  });

  test("returns to the customer step when the saved customer is unavailable", async () => {
    const { view } = await renderSavedCashQuote(() => "missing");
    await fireEvent.press(await view.findByRole("button", { name: "استئناف المسودة" }));
    expect(view.queryByRole("button", { name: "إنشاء العرض" })).toBeNull();
    await fireEvent.press(view.getByText("Test Customer"));
    const removeCustomer = view.getByRole("button", { name: "إزالة العميل المحدد" });
    await fireEvent.press(removeCustomer);
    expect(view.queryByRole("button", { name: "إزالة العميل المحدد" })).toBeNull();
  });
});
