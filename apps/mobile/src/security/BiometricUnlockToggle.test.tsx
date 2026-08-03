/// <reference types="jest" />

import { getMobileFoundationString } from "@autoflow/shared";
import { act, fireEvent, render } from "@testing-library/react-native";

let mockAuth: { isSignedIn: boolean };

jest.mock("@clerk/expo", () => ({
  useAuth: () => mockAuth,
}));

type Availability =
  | { available: true; kind: "face" | "fingerprint" }
  | { available: false; reason: string };

const mockIsArmed = jest.fn(async () => false);
const mockAvailability = jest.fn(
  async () => ({ available: true, kind: "fingerprint" }) as Availability,
);
const mockArm = jest.fn(
  async (_options?: unknown) => ({ ok: true }) as { ok: true } | { ok: false; reason: string },
);
const mockDisarm = jest.fn(async () => undefined);

jest.mock("./biometricUnlock", () => ({
  isBiometricUnlockArmed: () => mockIsArmed(),
  getBiometricAvailability: () => mockAvailability(),
  armBiometricUnlock: (options: unknown) => mockArm(options as never),
  disarmBiometricUnlock: () => mockDisarm(),
}));

import { LocaleProvider } from "../providers/LocaleProvider";
import { ThemeProvider } from "../providers/ThemeProvider";
import { BiometricUnlockToggle } from "./BiometricUnlockToggle";

const ar = (key: Parameters<typeof getMobileFoundationString>[1]) =>
  getMobileFoundationString("ar", key);

async function renderToggle() {
  const utils = await render(
    <ThemeProvider>
      <LocaleProvider>
        <BiometricUnlockToggle />
      </LocaleProvider>
    </ThemeProvider>,
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return utils;
}

beforeEach(() => {
  mockAuth = { isSignedIn: true };
  mockIsArmed.mockReset().mockResolvedValue(false);
  mockAvailability.mockReset().mockResolvedValue({ available: true, kind: "fingerprint" });
  mockArm.mockReset().mockResolvedValue({ ok: true });
  mockDisarm.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("BiometricUnlockToggle", () => {
  test("is absent for a signed-out user — there is no session to gate", async () => {
    mockAuth = { isSignedIn: false };

    const { queryByText } = await renderToggle();

    expect(queryByText(ar("biometricSettingTitle"))).toBeNull();
  });

  test("is absent on a phone with no sensor, and on a binary without the module", async () => {
    mockAvailability.mockResolvedValue({ available: false, reason: "noHardware" });
    const noSensor = await renderToggle();
    expect(noSensor.queryByText(ar("biometricSettingTitle"))).toBeNull();

    mockAvailability.mockResolvedValue({ available: false, reason: "unsupported" });
    const oldBinary = await renderToggle();
    expect(oldBinary.queryByText(ar("biometricSettingTitle"))).toBeNull();
  });

  test("explains a missing enrolment instead of hiding the setting", async () => {
    mockAvailability.mockResolvedValue({ available: false, reason: "notEnrolled" });

    const { getByText, queryByLabelText } = await renderToggle();

    expect(getByText(ar("biometricErrorNotEnrolled"))).toBeTruthy();
    expect(queryByLabelText(ar("biometricSettingEnable"))).toBeNull();
  });

  test("opting in arms the gate and flips the control", async () => {
    const { getByLabelText, getByText, queryByText } = await renderToggle();

    expect(queryByText(ar("biometricSettingOn"))).toBeNull();
    await fireEvent.press(getByLabelText(ar("biometricSettingEnable")));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockArm).toHaveBeenCalledWith(
      expect.objectContaining({
        prompts: {
          face: ar("biometricPromptFace"),
          fingerprint: ar("biometricPromptFingerprint"),
        },
        cancelLabel: ar("biometricPromptCancel"),
        fallbackLabel: ar("biometricPromptFallback"),
      }),
    );
    expect(getByText(ar("biometricSettingOn"))).toBeTruthy();
    expect(getByLabelText(ar("biometricSettingDisable"))).toBeTruthy();
  });

  test("a refused opt-in says why and leaves the setting off", async () => {
    mockArm.mockResolvedValue({ ok: false, reason: "lockout" });

    const { getByLabelText, getByText, queryByText } = await renderToggle();
    await fireEvent.press(getByLabelText(ar("biometricSettingEnable")));
    await act(async () => {
      await Promise.resolve();
    });

    expect(getByText(ar("biometricErrorLockout"))).toBeTruthy();
    expect(queryByText(ar("biometricSettingOn"))).toBeNull();
    expect(getByLabelText(ar("biometricSettingEnable"))).toBeTruthy();
  });

  test("opting out clears the keystore marker, not just the preference", async () => {
    mockIsArmed.mockResolvedValue(true);

    const { getByLabelText, queryByText } = await renderToggle();
    await fireEvent.press(getByLabelText(ar("biometricSettingDisable")));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockDisarm).toHaveBeenCalled();
    expect(queryByText(ar("biometricSettingOn"))).toBeNull();
    expect(getByLabelText(ar("biometricSettingEnable"))).toBeTruthy();
  });

  test("an armed user keeps their off switch even after the phone stops qualifying", async () => {
    // Otherwise removing every fingerprint would make the setting impossible to
    // turn off from inside the app.
    mockIsArmed.mockResolvedValue(true);
    mockAvailability.mockResolvedValue({ available: false, reason: "notEnrolled" });

    const { getByLabelText } = await renderToggle();

    expect(getByLabelText(ar("biometricSettingDisable"))).toBeTruthy();
  });

  test("clears a previous error when the user tries again", async () => {
    mockArm.mockResolvedValueOnce({ ok: false, reason: "cancelled" });

    const { getByLabelText, getByText, queryByText } = await renderToggle();
    await fireEvent.press(getByLabelText(ar("biometricSettingEnable")));
    await act(async () => {
      await Promise.resolve();
    });
    expect(getByText(ar("biometricErrorCancelled"))).toBeTruthy();

    await fireEvent.press(getByLabelText(ar("biometricSettingEnable")));
    await act(async () => {
      await Promise.resolve();
    });

    expect(queryByText(ar("biometricErrorCancelled"))).toBeNull();
    expect(getByText(ar("biometricSettingOn"))).toBeTruthy();
  });

  test("shows a spinner and refuses a second tap while the OS prompt is open", async () => {
    let release: (value: { ok: true }) => void = () => undefined;
    mockArm.mockReturnValueOnce(
      new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      }),
    );

    const { getByLabelText } = await renderToggle();
    const button = getByLabelText(ar("biometricSettingEnable"));

    await fireEvent.press(button);
    await fireEvent.press(button);
    expect(mockArm).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ ok: true });
      await Promise.resolve();
    });
  });
});
