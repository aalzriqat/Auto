/// <reference types="jest" />

import type { ReactNode } from "react";

jest.mock("expo-font", () => ({
  useFonts: jest.fn(),
}));

jest.mock("expo-splash-screen", () => ({
  hideAsync: jest.fn(async () => undefined),
  preventAutoHideAsync: jest.fn(async () => undefined),
}));

jest.mock("@clerk/expo", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: jest.fn(),
}));

jest.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
}));

jest.mock("convex/react", () => ({
  ConvexReactClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("convex/react-clerk", () => ({
  ConvexProviderWithClerk: ({ children }: { children: ReactNode }) => children,
}));

// The push gate is a side-effect wrapper pulling in native modules
// (expo-notifications/router). This suite covers font loading, so stub it to a
// passthrough; its own logic is tested via pushLink.test.ts and on-device.
jest.mock("../notifications/PushNotificationsGate", () => ({
  PushNotificationsGate: ({ children }: { children: ReactNode }) => children,
}));

jest.mock("../updates/OtaUpdateGate", () => ({
  OtaUpdateGate: ({ children }: { children: ReactNode }) => children,
}));

jest.mock("../updates/NativeUpdateGate", () => ({
  NativeUpdateGate: ({ children }: { children: ReactNode }) => children,
}));

jest.mock("react-native-safe-area-context", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    SafeAreaProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(View, { testID: "safe-area-provider" }, children),
  };
});

jest.mock("../config/env", () => ({
  validateMobileEnv: () => ({
    success: true,
    data: {
      appScheme: "autoflow",
      clerkPublishableKey: "pk_test_mock",
      convexUrl: "https://example.convex.cloud",
    },
  }),
}));

import { render, waitFor } from "@testing-library/react-native";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { Text } from "react-native";

import { AppProviders, useAppFontState } from "./AppProviders";

const mockUseFonts = useFonts as jest.MockedFunction<typeof useFonts>;
const mockHideAsync = SplashScreen.hideAsync as jest.MockedFunction<typeof SplashScreen.hideAsync>;

function FontProbe() {
  const { fontsLoaded } = useAppFontState();
  return <Text testID="font-state">{fontsLoaded ? "fonts-loaded" : "system-fonts"}</Text>;
}

describe("AppProviders font loading", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    mockUseFonts.mockReset();
    mockUseFonts.mockReturnValue([true, null]);
    mockHideAsync.mockClear();
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test("renders with bundled fonts once they load", async () => {
    const { getByTestId } = await render(
      <AppProviders>
        <FontProbe />
      </AppProviders>,
    );

    expect(getByTestId("font-state").props.children).toBe("fonts-loaded");
    await waitFor(() => expect(mockHideAsync).toHaveBeenCalledTimes(1));
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("falls back to system fonts when font loading fails", async () => {
    const fontError = new Error("font pack unavailable");
    mockUseFonts.mockReturnValueOnce([false, fontError]);

    const { getByTestId } = await render(
      <AppProviders>
        <FontProbe />
      </AppProviders>,
    );

    expect(getByTestId("font-state").props.children).toBe("system-fonts");
    await waitFor(() => {
      expect(mockHideAsync).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith("Failed to load AutoFlow mobile fonts", fontError);
    });
  });
});
