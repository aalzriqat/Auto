/// <reference types="jest" />

import * as SecureStore from "expo-secure-store";

const mockHasHardware = jest.fn(async () => true);
const mockIsEnrolled = jest.fn(async () => true);
const mockSupportedTypes = jest.fn(async () => [1] as number[]);
const mockAuthenticate = jest.fn(
  async () => ({ success: true }) as { success: true } | { success: false; error: string },
);
let mockModuleAvailable = true;

jest.mock("expo-local-authentication", () => {
  if (!mockModuleAvailable) {
    // How an OTA'd bundle sees a native module that is not in the binary.
    throw new Error("Cannot find native module 'ExpoLocalAuthentication'");
  }

  return {
    hasHardwareAsync: mockHasHardware,
    isEnrolledAsync: mockIsEnrolled,
    supportedAuthenticationTypesAsync: mockSupportedTypes,
    authenticateAsync: mockAuthenticate,
    AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  };
});

import {
  armBiometricUnlock,
  biometricKindFromTypes,
  classifyLocalAuthError,
  classifySecureStoreError,
  disarmBiometricUnlock,
  getBiometricAvailability,
  isBiometricUnlockArmed,
  loadLocalAuthentication,
  resetLocalAuthenticationCache,
  unlockWithBiometrics,
} from "./biometricUnlock";

const getItemAsync = SecureStore.getItemAsync as jest.Mock;
const setItemAsync = SecureStore.setItemAsync as jest.Mock;
const deleteItemAsync = SecureStore.deleteItemAsync as jest.Mock;

const ARMED_KEY = "autoflow-mobile-biometric-armed";
const GATE_KEY = "autoflow-mobile-biometric-gate";
const GATE_SERVICE = "autoflow-biometric-gate";

const PROMPTS = { face: "Unlock with your face", fingerprint: "Unlock with your fingerprint" };
const ARM_OPTIONS = { prompts: PROMPTS, cancelLabel: "Cancel", fallbackLabel: "Use password" };

let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockModuleAvailable = true;
  resetLocalAuthenticationCache();

  mockHasHardware.mockReset().mockResolvedValue(true);
  mockIsEnrolled.mockReset().mockResolvedValue(true);
  mockSupportedTypes.mockReset().mockResolvedValue([1]);
  mockAuthenticate.mockReset().mockResolvedValue({ success: true });

  getItemAsync.mockReset().mockResolvedValue(null);
  setItemAsync.mockReset().mockResolvedValue(undefined);
  deleteItemAsync.mockReset().mockResolvedValue(undefined);

  consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("classifyLocalAuthError", () => {
  test("maps every cancellation shape onto one message", () => {
    for (const error of ["user_cancel", "app_cancel", "system_cancel", "user_fallback"]) {
      expect(classifyLocalAuthError(error)).toBe("cancelled");
    }
  });

  test("maps the remaining documented errors", () => {
    expect(classifyLocalAuthError("lockout")).toBe("lockout");
    expect(classifyLocalAuthError("not_enrolled")).toBe("notEnrolled");
    expect(classifyLocalAuthError("passcode_not_set")).toBe("notEnrolled");
    expect(classifyLocalAuthError("not_available")).toBe("noHardware");
  });

  test("anything unrecognised is a failure, never a pass", () => {
    expect(classifyLocalAuthError("authentication_failed")).toBe("failed");
    expect(classifyLocalAuthError("something_new_in_expo_58")).toBe("failed");
  });
});

describe("classifySecureStoreError", () => {
  test("separates Android's permanent lockout from its temporary one", () => {
    // expo-secure-store builds these prefixes itself, from a fixed English enum
    // in AuthenticationPrompt.convertErrorCode — they are not localized OS text.
    expect(
      classifySecureStoreError(new Error("Lockout permanent. Too many attempts.")),
    ).toBe("lockoutPermanent");
    expect(classifySecureStoreError(new Error("Lockout. Try again later."))).toBe("lockout");
  });

  test("recognises cancellation on both platforms", () => {
    expect(
      classifySecureStoreError(new Error("User canceled the authentication. Cancelled")),
    ).toBe("cancelled");
    // iOS surfaces OSStatus instead: -128 is errSecUserCanceled.
    expect(classifySecureStoreError(new Error("KeyChainException: -128"))).toBe("cancelled");
  });

  test("recognises the capability failures expo-secure-store raises itself", () => {
    expect(classifySecureStoreError(new Error("No biometrics are currently enrolled"))).toBe(
      "notEnrolled",
    );
    expect(
      classifySecureStoreError(
        new Error("No hardware available for biometric authentication."),
      ),
    ).toBe("noHardware");
    expect(classifySecureStoreError(new Error("Hardware not present."))).toBe("noHardware");
  });

  test("unknown rejections fail closed", () => {
    expect(classifySecureStoreError(new Error("boom"))).toBe("failed");
    expect(classifySecureStoreError("boom")).toBe("failed");
    expect(classifySecureStoreError(null)).toBe("failed");
    expect(classifySecureStoreError(undefined)).toBe("failed");
  });
});

describe("biometricKindFromTypes", () => {
  const types = { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 };

  test("prefers face wording whenever the phone can do face or iris", () => {
    expect(biometricKindFromTypes([2], types)).toBe("face");
    expect(biometricKindFromTypes([3], types)).toBe("face");
    expect(biometricKindFromTypes([1, 2], types)).toBe("face");
  });

  test("falls back to fingerprint wording, including with nothing reported", () => {
    expect(biometricKindFromTypes([1], types)).toBe("fingerprint");
    expect(biometricKindFromTypes([], types)).toBe("fingerprint");
    expect(biometricKindFromTypes(null, types)).toBe("fingerprint");
    expect(biometricKindFromTypes(undefined, types)).toBe("fingerprint");
  });
});

describe("loadLocalAuthentication", () => {
  test("resolves the native module once", () => {
    expect(loadLocalAuthentication()).not.toBeNull();
    mockModuleAvailable = false;
    // No reset: the cached module stands rather than re-resolving per unlock.
    expect(loadLocalAuthentication()).not.toBeNull();
  });

  test("reports null on a binary that predates the module", () => {
    mockModuleAvailable = false;
    resetLocalAuthenticationCache();
    jest.resetModules();

    expect(loadLocalAuthentication()).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      "expo-local-authentication is unavailable in this build",
      expect.any(Error),
    );
  });
});

describe("getBiometricAvailability", () => {
  test("reports the enrolled kind when the phone can do this", async () => {
    mockSupportedTypes.mockResolvedValue([2]);
    await expect(getBiometricAvailability()).resolves.toEqual({ available: true, kind: "face" });
  });

  test("distinguishes no sensor from nothing enrolled", async () => {
    mockHasHardware.mockResolvedValue(false);
    await expect(getBiometricAvailability()).resolves.toEqual({
      available: false,
      reason: "noHardware",
    });

    mockHasHardware.mockResolvedValue(true);
    mockIsEnrolled.mockResolvedValue(false);
    await expect(getBiometricAvailability()).resolves.toEqual({
      available: false,
      reason: "notEnrolled",
    });
  });

  test("reports unsupported when the module is missing from the binary", async () => {
    mockModuleAvailable = false;
    resetLocalAuthenticationCache();
    jest.resetModules();

    await expect(getBiometricAvailability()).resolves.toEqual({
      available: false,
      reason: "unsupported",
    });
  });

  test("a throwing capability probe is unsupported, not available", async () => {
    mockHasHardware.mockRejectedValue(new Error("bridge is gone"));

    await expect(getBiometricAvailability()).resolves.toEqual({
      available: false,
      reason: "unsupported",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to read biometric capabilities",
      expect.any(Error),
    );
  });
});

describe("isBiometricUnlockArmed", () => {
  test("only the exact stored flag counts as armed", async () => {
    getItemAsync.mockResolvedValue("1");
    await expect(isBiometricUnlockArmed()).resolves.toBe(true);

    getItemAsync.mockResolvedValue(null);
    await expect(isBiometricUnlockArmed()).resolves.toBe(false);
  });

  test("an unreadable preference means not armed", async () => {
    getItemAsync.mockRejectedValue(new Error("keystore unavailable"));
    await expect(isBiometricUnlockArmed()).resolves.toBe(false);
  });
});

describe("disarmBiometricUnlock", () => {
  test("clears the keystore marker as well as the preference", async () => {
    await disarmBiometricUnlock();

    expect(deleteItemAsync).toHaveBeenCalledWith(GATE_KEY, { keychainService: GATE_SERVICE });
    expect(deleteItemAsync).toHaveBeenCalledWith(ARMED_KEY);
  });

  test("still clears the preference when the marker cannot be deleted", async () => {
    deleteItemAsync.mockRejectedValueOnce(new Error("key already gone"));

    await expect(disarmBiometricUnlock()).resolves.toBeUndefined();
    expect(deleteItemAsync).toHaveBeenCalledWith(ARMED_KEY);
  });

  test("never throws, even if both deletes fail", async () => {
    deleteItemAsync.mockRejectedValue(new Error("keystore unavailable"));
    await expect(disarmBiometricUnlock()).resolves.toBeUndefined();
  });
});

describe("armBiometricUnlock", () => {
  test("binds the gate to a keystore key that the OS must authenticate", async () => {
    await expect(armBiometricUnlock(ARM_OPTIONS)).resolves.toEqual({ ok: true });

    expect(setItemAsync).toHaveBeenCalledWith(GATE_KEY, "armed", {
      requireAuthentication: true,
      keychainService: GATE_SERVICE,
      authenticationPrompt: PROMPTS.fingerprint,
    });
    expect(setItemAsync).toHaveBeenCalledWith(ARMED_KEY, "1");
  });

  test("uses the face wording on a phone that does face unlock", async () => {
    mockSupportedTypes.mockResolvedValue([2]);

    await armBiometricUnlock(ARM_OPTIONS);

    expect(mockAuthenticate).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: PROMPTS.face }),
    );
  });

  test("refuses to arm before the user has proved they can pass the check", async () => {
    mockAuthenticate.mockResolvedValue({ success: false, error: "user_cancel" });

    await expect(armBiometricUnlock(ARM_OPTIONS)).resolves.toEqual({
      ok: false,
      reason: "cancelled",
    });
    // Nothing was written: no marker, no preference.
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  test("a throwing prompt is a failure, not an arm", async () => {
    mockAuthenticate.mockRejectedValue(new Error("activity is gone"));

    await expect(armBiometricUnlock(ARM_OPTIONS)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  test("cannot arm on a binary that predates the native module", async () => {
    mockModuleAvailable = false;
    resetLocalAuthenticationCache();
    jest.resetModules();

    await expect(armBiometricUnlock(ARM_OPTIONS)).resolves.toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  test("propagates a capability failure without prompting at all", async () => {
    mockIsEnrolled.mockResolvedValue(false);

    await expect(armBiometricUnlock(ARM_OPTIONS)).resolves.toEqual({
      ok: false,
      reason: "notEnrolled",
    });
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  test("does NOT fall back to a JavaScript-only gate when the keystore refuses", async () => {
    // The OEM/Class-2/no-passcode case. Arming anyway would look identical to
    // the user while silently losing enrolment-change invalidation.
    setItemAsync.mockRejectedValueOnce(new Error("Lockout permanent. Too many attempts."));

    await expect(armBiometricUnlock(ARM_OPTIONS)).resolves.toEqual({
      ok: false,
      reason: "lockoutPermanent",
    });
    expect(setItemAsync).not.toHaveBeenCalledWith(ARMED_KEY, "1");
  });

  test("rolls back the marker if the preference cannot be saved", async () => {
    setItemAsync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"));

    await expect(armBiometricUnlock(ARM_OPTIONS)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(deleteItemAsync).toHaveBeenCalledWith(GATE_KEY, { keychainService: GATE_SERVICE });
  });
});

describe("unlockWithBiometrics", () => {
  test("unlocks when the OS hands the keystore marker back", async () => {
    getItemAsync.mockResolvedValue("armed");

    await expect(unlockWithBiometrics(PROMPTS)).resolves.toEqual({ ok: true });
  });

  test("the read that unlocks IS the authenticated one", async () => {
    getItemAsync.mockResolvedValue("armed");

    await unlockWithBiometrics(PROMPTS);

    expect(getItemAsync).toHaveBeenCalledWith(GATE_KEY, {
      requireAuthentication: true,
      keychainService: GATE_SERVICE,
      authenticationPrompt: PROMPTS.fingerprint,
    });
  });

  test("shows exactly one OS prompt — the keystore read, not a second check", async () => {
    getItemAsync.mockResolvedValue("armed");

    await unlockWithBiometrics(PROMPTS);

    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(getItemAsync).toHaveBeenCalledTimes(1);
  });

  test("a changed biometric enrolment invalidates the gate instead of being trusted", async () => {
    // expo-secure-store RESOLVES null (it does not reject) once the Android
    // keystore key has been invalidated by a new fingerprint enrolment.
    getItemAsync.mockResolvedValue(null);

    await expect(unlockWithBiometrics(PROMPTS)).resolves.toEqual({
      ok: false,
      reason: "enrolmentChanged",
    });
    // And the gate disarms itself rather than asking again next launch.
    expect(deleteItemAsync).toHaveBeenCalledWith(GATE_KEY, { keychainService: GATE_SERVICE });
    expect(deleteItemAsync).toHaveBeenCalledWith(ARMED_KEY);
  });

  test("removing every biometric from the phone also disarms the gate", async () => {
    mockIsEnrolled.mockResolvedValue(false);

    await expect(unlockWithBiometrics(PROMPTS)).resolves.toEqual({
      ok: false,
      reason: "notEnrolled",
    });
    expect(deleteItemAsync).toHaveBeenCalledWith(ARMED_KEY);
  });

  test("an older binary stays locked but keeps the gate armed", async () => {
    // Downgrading the app must not silently drop a security setting the user
    // chose; it just cannot be satisfied until the module is back.
    mockModuleAvailable = false;
    resetLocalAuthenticationCache();
    jest.resetModules();

    await expect(unlockWithBiometrics(PROMPTS)).resolves.toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(deleteItemAsync).not.toHaveBeenCalled();
  });

  test("a phone that lost its sensor stays locked and keeps the gate armed", async () => {
    mockHasHardware.mockResolvedValue(false);

    await expect(unlockWithBiometrics(PROMPTS)).resolves.toEqual({
      ok: false,
      reason: "noHardware",
    });
    expect(deleteItemAsync).not.toHaveBeenCalled();
  });

  test("classifies a rejected read and keeps a recoverable gate armed", async () => {
    getItemAsync.mockRejectedValue(new Error("Lockout. Too many attempts. Try again later."));

    await expect(unlockWithBiometrics(PROMPTS)).resolves.toEqual({ ok: false, reason: "lockout" });
    expect(deleteItemAsync).not.toHaveBeenCalled();
  });

  test("disarms when the rejection says the enrolment is gone", async () => {
    getItemAsync.mockRejectedValue(new Error("No biometrics are currently enrolled"));

    await expect(unlockWithBiometrics(PROMPTS)).resolves.toEqual({
      ok: false,
      reason: "notEnrolled",
    });
    expect(deleteItemAsync).toHaveBeenCalledWith(ARMED_KEY);
  });

  test("uses the face prompt wording on a face-unlock phone", async () => {
    mockSupportedTypes.mockResolvedValue([3]);
    getItemAsync.mockResolvedValue("armed");

    await unlockWithBiometrics(PROMPTS);

    expect(getItemAsync).toHaveBeenCalledWith(
      GATE_KEY,
      expect.objectContaining({ authenticationPrompt: PROMPTS.face }),
    );
  });
});
