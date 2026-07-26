/// <reference types="jest" />

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";

const mockPush = jest.fn();

jest.mock("convex/react", () => ({
  useConvexAuth: jest.fn(),
  useMutation: jest.fn(),
  useQuery: jest.fn(),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { api, type MobileMarketplaceListing } from "../../convexApi";
import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import { MyListingsScreen } from "./MyListingsScreen";

const mockUseConvexAuth = useConvexAuth as jest.MockedFunction<typeof useConvexAuth>;
const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;

function makeListing(overrides: Partial<MobileMarketplaceListing>): MobileMarketplaceListing {
  return {
    _id: "listing1",
    sellerKind: "INDIVIDUAL",
    sellerDisplayName: "Ahmad",
    sellerPhone: "0790000000",
    make: "Toyota",
    model: "Camry",
    year: 2022,
    mileage: 30000,
    price: 12000,
    currency: "JOD",
    transmission: "Automatic",
    fuelType: "Gasoline",
    city: "Amman",
    description: "Great car",
    condition: "GOOD",
    imageIds: [],
    status: "LIVE",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    thumbnailUrl: null,
    ...overrides,
  };
}

function renderScreen() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <MyListingsScreen />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

describe("MyListingsScreen", () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockUseMutation.mockReturnValue(jest.fn() as unknown as ReturnType<typeof useMutation>);
  });

  test("prompts an anonymous visitor to sign in", async () => {
    mockUseConvexAuth.mockReturnValue({ isLoading: false, isAuthenticated: false, isRefreshing: false });
    mockUseQuery.mockReturnValue(undefined as unknown as ReturnType<typeof useQuery>);
    const { getByText } = await renderScreen();
    expect(getByText("سجّل الدخول لعرض إعلاناتك")).toBeTruthy();

    fireEvent.press(getByText("تسجيل الدخول"));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/sign-in?returnTo=marketplace"));
  });

  test("shows an empty state when the seller has no listings", async () => {
    mockUseConvexAuth.mockReturnValue({ isLoading: false, isAuthenticated: true, isRefreshing: false });
    mockUseQuery.mockReturnValue([] as unknown as ReturnType<typeof useQuery>);
    const { getByText } = await renderScreen();
    expect(getByText("لم تقم بإضافة أي سيارة بعد.")).toBeTruthy();
  });

  test("renders a LIVE listing with its own currency and a mark-sold action", async () => {
    mockUseConvexAuth.mockReturnValue({ isLoading: false, isAuthenticated: true, isRefreshing: false });
    mockUseQuery.mockImplementation(((queryRef: unknown) => {
      if (queryRef === api.marketplaceListings.getMyListings) {
        return [makeListing({ price: 9500, currency: "USD" })] as unknown as ReturnType<typeof useQuery>;
      }
      return undefined as unknown as ReturnType<typeof useQuery>;
    }) as unknown as typeof useQuery);
    const { getByText, queryByText } = await renderScreen();
    expect(getByText(/USD/)).toBeTruthy();
    expect(getByText("تعليم كمباعة")).toBeTruthy();
    expect(getByText("حذف")).toBeTruthy();
    // Never hardcode JOD — this listing's own currency is USD.
    expect(queryByText(/JOD/)).toBeNull();
  });

  test("does not show mark-sold for a PENDING_VERIFICATION listing", async () => {
    mockUseConvexAuth.mockReturnValue({ isLoading: false, isAuthenticated: true, isRefreshing: false });
    mockUseQuery.mockReturnValue([
      makeListing({ status: "PENDING_VERIFICATION" }),
    ] as unknown as ReturnType<typeof useQuery>);
    const { queryByText, getByText } = await renderScreen();
    expect(queryByText("تعليم كمباعة")).toBeNull();
    expect(getByText("قيد التحقق")).toBeTruthy();
  });

  test("shows the rejection reason for a REJECTED listing", async () => {
    mockUseConvexAuth.mockReturnValue({ isLoading: false, isAuthenticated: true, isRefreshing: false });
    mockUseQuery.mockReturnValue([
      makeListing({ status: "REJECTED", rejectionReason: "Photos unclear" }),
    ] as unknown as ReturnType<typeof useQuery>);
    const { getByText } = await renderScreen();
    expect(getByText(/سبب الرفض/)).toBeTruthy();
    expect(getByText(/Photos unclear/)).toBeTruthy();
  });
});
