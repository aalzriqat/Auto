/// <reference types="jest" />

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useConvexAuth, useMutation } from "convex/react";

const mockPush = jest.fn();

jest.mock("convex/react", () => ({
  useConvexAuth: jest.fn(),
  useMutation: jest.fn(),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock("../../permissions/mediaPermissions", () => ({
  ensurePhotoLibraryPermission: jest.fn().mockResolvedValue({ granted: true }),
}));

import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import { SellCarScreen } from "./SellCarScreen";

const mockUseConvexAuth = useConvexAuth as jest.MockedFunction<typeof useConvexAuth>;
const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;

function renderScreen() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <SellCarScreen />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

describe("SellCarScreen", () => {
  beforeEach(() => {
    mockPush.mockReset();
    // mockReset (not mockReturnValue alone) so a per-test mockImplementation
    // can't leak into the next test and starve it of its mutations.
    mockUseMutation.mockReset();
    mockUseMutation.mockReturnValue(jest.fn() as unknown as ReturnType<typeof useMutation>);
  });

  test("shows a loading state while auth is resolving", async () => {
    mockUseConvexAuth.mockReturnValue({ isLoading: true, isAuthenticated: false, isRefreshing: false });
    const { getByText } = await renderScreen();
    expect(getByText(/جاري التحميل/)).toBeTruthy();
  });

  test("prompts an anonymous visitor to sign in rather than showing the form", async () => {
    mockUseConvexAuth.mockReturnValue({ isLoading: false, isAuthenticated: false, isRefreshing: false });
    const { getByText, queryByText } = await renderScreen();
    expect(getByText("سجّل الدخول لإضافة سيارتك")).toBeTruthy();
    // The create-listing form (e.g. the submit button) must not render for a signed-out visitor.
    expect(queryByText("إرسال الإعلان")).toBeNull();

    fireEvent.press(getByText("تسجيل الدخول"));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/sign-in?returnTo=marketplace"));
  });

  test("renders the create-listing form for a signed-in seller", async () => {
    mockUseConvexAuth.mockReturnValue({ isLoading: false, isAuthenticated: true, isRefreshing: false });
    const { getByText } = await renderScreen();
    expect(getByText("إرسال الإعلان")).toBeTruthy();
    expect(getByText("من البائع؟")).toBeTruthy();
  });

});
