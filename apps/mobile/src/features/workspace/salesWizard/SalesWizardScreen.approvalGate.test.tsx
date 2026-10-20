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

import { api } from "../../../convexApi";
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

function query(ref: unknown) {
  if (ref === api.vehicles.listAll) return [VEHICLE];
  if (ref === api.wizardDrafts.getMyDraft) return null;
  if (ref === api.memberships.getMyMembership) return { permissions: [] };
  if (ref === api.approvals.checkPendingApproval) return storedApproval;
  return undefined;
}

beforeEach(() => {
  storedApproval = null;
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

  test("a cash quote is exempt", async () => {
    const view = await openWithPrice("CASH", "12200");
    expect(view.queryByText(BLOCKED_TITLE)).toBeNull();
  });
});
