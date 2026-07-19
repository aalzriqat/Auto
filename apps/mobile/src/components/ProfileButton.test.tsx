/// <reference types="jest" />

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

const pressAndSettle = (press: () => void) =>
  act(async () => {
    press();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const mockSignOut = jest.fn();
let mockAuth: { isSignedIn: boolean; signOut: jest.Mock };
let mockUser: { user: unknown };

jest.mock("@clerk/expo", () => ({
  useAuth: () => mockAuth,
  useUser: () => mockUser,
}));

import { LocaleProvider } from "../providers/LocaleProvider";
import { ThemeProvider } from "../providers/ThemeProvider";
import { OTA_UPDATE_NUMBER } from "../otaUpdateNumber";
import { ProfileButton, getProfilePressedStyle, resolveAccountIdentity } from "./ProfileButton";

// Track the current OTA build so bumping otaUpdateNumber.ts doesn't break these
// assertions (the build line renders `OTA_UPDATE_NUMBER`).
const buildLine = `AutoFlow · الإصدار ${OTA_UPDATE_NUMBER}`;
const buildLineRe = new RegExp(`الإصدار ${OTA_UPDATE_NUMBER}`);

function renderProfile() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <ProfileButton />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

describe("ProfileButton", () => {
  beforeEach(() => {
    mockSignOut.mockReset();
    mockAuth = { isSignedIn: true, signOut: mockSignOut };
    mockUser = {
      user: {
        fullName: "Jane Dealer",
        primaryEmailAddress: { emailAddress: "jane@dealer.com" },
        imageUrl: undefined,
      },
    };
  });

  test("resolveAccountIdentity covers every fallback branch", () => {
    expect(resolveAccountIdentity("Jane Dealer", "jane@dealer.com", "Account")).toEqual({
      name: "Jane Dealer",
      email: "jane@dealer.com",
    });
    // No name -> falls back to the email, which is then hidden (equals the name).
    expect(resolveAccountIdentity(undefined, "jane@dealer.com", "Account")).toEqual({
      name: "jane@dealer.com",
      email: null,
    });
    // Whitespace-only name -> same email fallback.
    expect(resolveAccountIdentity("   ", "jane@dealer.com", "Account")).toEqual({
      name: "jane@dealer.com",
      email: null,
    });
    // Neither name nor email -> account fallback label, no email row.
    expect(resolveAccountIdentity(undefined, "", "Account")).toEqual({
      name: "Account",
      email: null,
    });
  });

  test("computes pressed style", () => {
    expect(getProfilePressedStyle(false)).toBeNull();
    expect(getProfilePressedStyle(true)).not.toBeNull();
  });

  // The mobile app defaults to Arabic (DEFAULT_LOCALE = "ar") and SecureStore is
  // mocked to return no stored locale, so rendered strings are Arabic; the name,
  // email, and language endonyms stay stable across locales.
  test("renders nothing when signed out", async () => {
    mockAuth = { isSignedIn: false, signOut: mockSignOut };
    const { queryByTestId } = await renderProfile();
    expect(queryByTestId("account-avatar-button")).toBeNull();
  });

  test("opens the sheet, switches theme and language live, and shows the build number", async () => {
    const { getByLabelText, getByTestId, getByText, queryByText } = await renderProfile();

    // Sheet is closed until the avatar is tapped.
    expect(queryByText(buildLineRe)).toBeNull();

    fireEvent.press(getByTestId("account-avatar-button"));

    // Modal children mount a tick after opening (as in the FAB test).
    await waitFor(() => expect(getByText(buildLine)).toBeTruthy());

    // Identity + subtle build line (replaces the old red OTA banner).
    expect(getByText("Jane Dealer")).toBeTruthy();
    expect(getByText("jane@dealer.com")).toBeTruthy();

    // Each theme/language switch triggers a SecureStore persist; wrap every one
    // in act + a microtask flush so its state update and floating write settle
    // inside the test and never dangle into the next render.
    // Appearance starts on light; switch to dark, then back to light (both branches).
    await pressAndSettle(() => fireEvent.press(getByText("داكن")));
    await pressAndSettle(() => fireEvent.press(getByText("فاتح")));

    // Language endonyms stay stable across the switch; exercise both handlers.
    await pressAndSettle(() => fireEvent.press(getByText("English")));
    await pressAndSettle(() => fireEvent.press(getByText("العربية")));

    // Still open and coherent after the live switches.
    expect(getByText("English")).toBeTruthy();

    fireEvent.press(getByLabelText("إغلاق"));
    await waitFor(() => expect(queryByText(buildLineRe)).toBeNull());
  });

  test("hides the email row when it matches the display name", async () => {
    mockUser = {
      user: {
        fullName: undefined,
        primaryEmailAddress: { emailAddress: "jane@dealer.com" },
        imageUrl: "https://example.com/a.png",
      },
    };
    const { getByTestId, queryAllByText } = await renderProfile();
    fireEvent.press(getByTestId("account-avatar-button"));
    // Email appears once (as the name), not again as a separate email row.
    await waitFor(() => expect(queryAllByText("jane@dealer.com")).toHaveLength(1));
  });

  test("falls back to the account label when the Clerk user has not loaded", async () => {
    mockUser = { user: null };
    const { getByTestId, getByText, queryByText } = await renderProfile();
    fireEvent.press(getByTestId("account-avatar-button"));
    await waitFor(() => expect(getByText(buildLine)).toBeTruthy());
    // Name falls back to the localized "Account"; no email row and no crash.
    expect(getByText("الحساب")).toBeTruthy();
    expect(queryByText(/@/)).toBeNull();
  });

  test("signs out and closes the sheet", async () => {
    const { getByTestId, getByText, queryByText } = await renderProfile();
    fireEvent.press(getByTestId("account-avatar-button"));
    await waitFor(() => expect(getByText("تسجيل الخروج")).toBeTruthy());
    fireEvent.press(getByText("تسجيل الخروج"));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(queryByText(buildLineRe)).toBeNull());
  });

  test("closes via the close button without signing out", async () => {
    const { getByLabelText, getByTestId, queryByText } = await renderProfile();
    fireEvent.press(getByTestId("account-avatar-button"));
    await waitFor(() => expect(queryByText(buildLineRe)).not.toBeNull());
    fireEvent.press(getByLabelText("إغلاق"));
    await waitFor(() => expect(queryByText(buildLineRe)).toBeNull());
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
