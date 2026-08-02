/// <reference types="jest" />

const mockImpactAsync = jest.fn(async () => undefined);
const mockNotificationAsync = jest.fn(async () => undefined);
let mockAvailable = true;

jest.mock("expo-haptics", () => {
  if (!mockAvailable) {
    throw new Error("Cannot find native module 'ExpoHaptics'");
  }

  return {
    impactAsync: mockImpactAsync,
    notificationAsync: mockNotificationAsync,
    ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
    NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  };
});

import {
  hapticImpact,
  hapticSelection,
  hapticSuccess,
  hapticWarning,
  loadHaptics,
  resetHapticsCache,
} from "./haptics";

beforeEach(() => {
  mockAvailable = true;
  mockImpactAsync.mockClear();
  mockNotificationAsync.mockClear();
  mockImpactAsync.mockResolvedValue(undefined);
  mockNotificationAsync.mockResolvedValue(undefined);
  resetHapticsCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("haptics", () => {
  test("maps each moment to its own feedback type", () => {
    hapticSuccess();
    expect(mockNotificationAsync).toHaveBeenCalledWith("success");

    hapticWarning();
    expect(mockNotificationAsync).toHaveBeenCalledWith("warning");

    hapticImpact();
    expect(mockImpactAsync).toHaveBeenCalledWith("medium");

    hapticSelection();
    expect(mockImpactAsync).toHaveBeenCalledWith("light");
  });

  test("resolves the native module only once", () => {
    expect(loadHaptics()).not.toBeNull();
    mockAvailable = false;
    // No reset: the cached module stands rather than re-resolving per buzz.
    expect(loadHaptics()).not.toBeNull();
  });

  test("does nothing when the binary predates the native module", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockAvailable = false;
    resetHapticsCache();
    // The module registry caches the factory result, so it has to be dropped
    // for the "native module missing" factory to run at all.
    jest.resetModules();

    // This is the OTA case. A missing haptic must never take an action down.
    expect(() => hapticSuccess()).not.toThrow();
    expect(mockNotificationAsync).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "expo-haptics is unavailable in this build",
      expect.any(Error),
    );
  });

  test("swallows a rejected haptic instead of surfacing it", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockNotificationAsync.mockRejectedValueOnce(new Error("no vibrator"));

    expect(() => hapticSuccess()).not.toThrow();
    // Let the rejection settle; an unhandled one would fail the run.
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith("Haptic feedback failed", expect.any(Error));
  });

  test("swallows a synchronous throw from the native call", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockImpactAsync.mockImplementationOnce(() => {
      // How a native-module proxy fails when its backing module is gone: it
      // throws on access, before any promise exists.
      throw new Error("bridge is gone");
    });

    expect(() => hapticImpact()).not.toThrow();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith("Haptic feedback failed", expect.any(Error));
  });
});
