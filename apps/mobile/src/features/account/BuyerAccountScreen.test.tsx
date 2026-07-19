/// <reference types="jest" />

import { fireEvent, render } from "@testing-library/react-native";

const mockPush = jest.fn();
let mockIsSignedIn: boolean;

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ isSignedIn: mockIsSignedIn }),
}));

import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import { BuyerAccountScreen } from "./BuyerAccountScreen";

function renderScreen() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <BuyerAccountScreen />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

describe("BuyerAccountScreen", () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockIsSignedIn = false;
  });

  // Default locale is Arabic (DEFAULT_LOCALE = "ar").
  test("sends an anonymous visitor to dealer sign in", async () => {
    const { getByLabelText, getByText } = await renderScreen();
    // Build line present (marketplace-first Account tab rendered).
    expect(getByText(/الإصدار/)).toBeTruthy();
    fireEvent.press(getByLabelText("دخول التاجر"));
    expect(mockPush).toHaveBeenCalledWith("/sign-in");
  });

  test("sends a signed-in dealer to their workspaces", async () => {
    mockIsSignedIn = true;
    const { getByLabelText } = await renderScreen();
    fireEvent.press(getByLabelText("افتح مساحة عمل التاجر"));
    expect(mockPush).toHaveBeenCalledWith("/workspaces");
  });
});
