/// <reference types="jest" />

import { getMobileFoundationString } from "@autoflow/shared";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { AppState, Linking, Text } from "react-native";

const mockSignOut = jest.fn(async () => undefined);
let mockAuth: { isSignedIn: boolean; signOut: jest.Mock };

jest.mock("@clerk/expo", () => ({
  useAuth: () => mockAuth,
}));

const mockIsArmed = jest.fn(async () => true);
const mockUnlock = jest.fn(
  async (_prompts?: unknown) => ({ ok: true }) as { ok: true } | { ok: false; reason: string },
);

jest.mock("./biometricUnlock", () => ({
  isBiometricUnlockArmed: () => mockIsArmed(),
  unlockWithBiometrics: (prompts: unknown) => mockUnlock(prompts as never),
}));

import { LocaleProvider } from "../providers/LocaleProvider";
import { ThemeProvider } from "../providers/ThemeProvider";
import { BiometricLockGate } from "./BiometricLockGate";

// The app defaults to Arabic, so that is what the gate renders under test.
const ar = (key: Parameters<typeof getMobileFoundationString>[1]) =>
  getMobileFoundationString("ar", key);

const CHILD = "the-protected-app";

type AppStateHandler = (state: string) => void;
let appStateHandler: AppStateHandler;
let removeSubscription: jest.Mock;

async function renderGate() {
  const utils = await render(
    <ThemeProvider>
      <LocaleProvider>
        <BiometricLockGate>
          <Text>{CHILD}</Text>
        </BiometricLockGate>
      </LocaleProvider>
    </ThemeProvider>,
  );

  // Let the armed check and the automatic unlock attempt settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return utils;
}

beforeEach(() => {
  mockSignOut.mockReset().mockResolvedValue(undefined);
  mockAuth = { isSignedIn: true, signOut: mockSignOut };
  mockIsArmed.mockReset().mockResolvedValue(true);
  mockUnlock.mockReset().mockResolvedValue({ ok: true });

  removeSubscription = jest.fn();
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation(((_event: string, handler: AppStateHandler) => {
      appStateHandler = handler;
      return { remove: removeSubscription };
    }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("BiometricLockGate", () => {
  test("never locks a signed-out app — there is no session to protect", async () => {
    mockAuth = { isSignedIn: false, signOut: mockSignOut };

    const { getByText } = await renderGate();

    expect(getByText(CHILD)).toBeTruthy();
    expect(mockUnlock).not.toHaveBeenCalled();
  });

  test("does not lock a user who never opted in", async () => {
    mockIsArmed.mockResolvedValue(false);

    const { getByText } = await renderGate();

    expect(getByText(CHILD)).toBeTruthy();
    expect(mockUnlock).not.toHaveBeenCalled();
  });

  test("asks for the biometric on launch and reveals the app once it passes", async () => {
    const { getByText } = await renderGate();

    expect(mockUnlock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getByText(CHILD)).toBeTruthy());
  });

  test("keeps the app hidden and explains a cancelled check", async () => {
    mockUnlock.mockResolvedValue({ ok: false, reason: "cancelled" });

    const { getByText, queryByText, getByLabelText } = await renderGate();

    expect(queryByText(CHILD)).toBeNull();
    expect(getByText(ar("biometricErrorCancelled"))).toBeTruthy();
    // Recoverable, so a retry is offered alongside the escape hatch.
    expect(getByLabelText(ar("biometricLockUnlock"))).toBeTruthy();
    expect(getByLabelText(ar("biometricLockUsePassword"))).toBeTruthy();
  });

  test("a changed enrolment hides the pointless retry but keeps the escape hatch", async () => {
    mockUnlock.mockResolvedValue({ ok: false, reason: "enrolmentChanged" });

    const { getByText, queryByLabelText, getByLabelText } = await renderGate();

    expect(getByText(ar("biometricErrorEnrolmentChanged"))).toBeTruthy();
    expect(queryByLabelText(ar("biometricLockUnlock"))).toBeNull();
    // The state a user is most likely to land in by accident must never be a
    // dead end.
    expect(getByLabelText(ar("biometricLockUsePassword"))).toBeTruthy();
  });

  test("offers the phone's settings when nothing is enrolled", async () => {
    mockUnlock.mockResolvedValue({ ok: false, reason: "notEnrolled" });
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);

    const { getByLabelText } = await renderGate();
    await fireEvent.press(getByLabelText(ar("biometricOpenSettings")));

    expect(openSettings).toHaveBeenCalled();
  });

  test("reports a settings shortcut that will not open instead of crashing", async () => {
    mockUnlock.mockResolvedValue({ ok: false, reason: "notEnrolled" });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(Linking, "openSettings").mockRejectedValue(new Error("no settings activity"));

    const { getByLabelText } = await renderGate();
    await fireEvent.press(getByLabelText(ar("biometricOpenSettings")));
    await act(async () => {
      await Promise.resolve();
    });

    expect(consoleError).toHaveBeenCalledWith(
      "Could not open the phone's settings",
      expect.any(Error),
    );
  });

  test("hides the settings shortcut for failures the phone's settings cannot fix", async () => {
    mockUnlock.mockResolvedValue({ ok: false, reason: "lockoutPermanent" });

    const { queryByLabelText, getByText } = await renderGate();

    expect(getByText(ar("biometricErrorLockoutPermanent"))).toBeTruthy();
    expect(queryByLabelText(ar("biometricOpenSettings"))).toBeNull();
  });

  test("the password escape hatch drops the session and clears the lock", async () => {
    mockUnlock.mockResolvedValue({ ok: false, reason: "lockout" });

    const { getByLabelText, getByText } = await renderGate();
    await fireEvent.press(getByLabelText(ar("biometricLockUsePassword")));

    expect(mockSignOut).toHaveBeenCalled();
    // Without clearing the lock, the sign-in screen would render behind it.
    await waitFor(() => expect(getByText(CHILD)).toBeTruthy());
  });

  test("signing back in after the password route does not re-lock immediately", async () => {
    // The loop this prevents: sensor locked out -> password route -> sign in ->
    // re-lock -> same lockout. A user in that state could never reach the app.
    mockUnlock.mockResolvedValue({ ok: false, reason: "lockout" });

    const { getByLabelText, rerender, getByText } = await renderGate();
    await fireEvent.press(getByLabelText(ar("biometricLockUsePassword")));

    // signOut() lands, then the real Clerk sign-in brings the session back.
    for (const isSignedIn of [false, true]) {
      mockAuth = { isSignedIn, signOut: mockSignOut };
      mockUnlock.mockClear();
      await act(async () => {
        rerender(
          <ThemeProvider>
            <LocaleProvider>
              <BiometricLockGate>
                <Text>{CHILD}</Text>
              </BiometricLockGate>
            </LocaleProvider>
          </ThemeProvider>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(getByText(CHILD)).toBeTruthy();
    expect(mockUnlock).not.toHaveBeenCalled();
  });

  test("a long background trip re-locks even after the password route", async () => {
    mockUnlock.mockResolvedValue({ ok: false, reason: "lockout" });

    const { getByLabelText, queryByText } = await renderGate();
    await fireEvent.press(getByLabelText(ar("biometricLockUsePassword")));

    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(0);
    await act(async () => {
      appStateHandler("background");
      await Promise.resolve();
    });

    now.mockReturnValue(90_000);
    await act(async () => {
      appStateHandler("active");
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(queryByText(CHILD)).toBeNull());
  });

  test("retrying runs another check and can succeed", async () => {
    mockUnlock.mockResolvedValueOnce({ ok: false, reason: "failed" });

    const { getByLabelText, getByText } = await renderGate();

    mockUnlock.mockResolvedValue({ ok: true });
    await fireEvent.press(getByLabelText(ar("biometricLockUnlock")));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockUnlock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(getByText(CHILD)).toBeTruthy());
  });

  test("a second tap while the OS prompt is open does not fire a second check", async () => {
    mockUnlock.mockResolvedValueOnce({ ok: false, reason: "cancelled" });
    let release: (value: { ok: true }) => void = () => undefined;
    mockUnlock.mockReturnValueOnce(
      new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      }),
    );

    const { getByLabelText } = await renderGate();
    const unlockButton = getByLabelText(ar("biometricLockUnlock"));

    await fireEvent.press(unlockButton);
    await fireEvent.press(unlockButton);
    await act(async () => {
      await Promise.resolve();
    });

    // One automatic attempt plus one tap, not two taps.
    expect(mockUnlock).toHaveBeenCalledTimes(2);

    await act(async () => {
      release({ ok: true });
      await Promise.resolve();
    });
  });

  test("re-locks after a long trip to the background", async () => {
    const { getByText, queryByText } = await renderGate();
    expect(getByText(CHILD)).toBeTruthy();

    mockUnlock.mockResolvedValue({ ok: false, reason: "cancelled" });
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(0);
    await act(async () => {
      appStateHandler("background");
      await Promise.resolve();
    });

    now.mockReturnValue(90_000);
    await act(async () => {
      appStateHandler("active");
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(queryByText(CHILD)).toBeNull());
  });

  test("does not re-lock for a quick tab-out", async () => {
    const { getByText } = await renderGate();

    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(0);
    await act(async () => {
      appStateHandler("inactive");
      await Promise.resolve();
    });

    now.mockReturnValue(5_000);
    await act(async () => {
      appStateHandler("active");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByText(CHILD)).toBeTruthy();
  });

  test("ignores a foreground event that never followed a background one", async () => {
    const { getByText } = await renderGate();

    await act(async () => {
      appStateHandler("active");
      await Promise.resolve();
    });

    expect(getByText(CHILD)).toBeTruthy();
  });

  test("does not re-lock a user who has since opted out", async () => {
    const { getByText } = await renderGate();

    mockIsArmed.mockResolvedValue(false);
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(0);
    await act(async () => {
      appStateHandler("background");
      await Promise.resolve();
    });

    now.mockReturnValue(90_000);
    await act(async () => {
      appStateHandler("active");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByText(CHILD)).toBeTruthy();
  });

  test("stops listening for app-state changes when unmounted", async () => {
    const { unmount } = await renderGate();

    await act(async () => {
      unmount();
    });

    expect(removeSubscription).toHaveBeenCalled();
  });
});
