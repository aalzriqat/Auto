/// <reference types="jest" />

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { StyleProp, ViewStyle } from "react-native";

jest.mock("react-native-safe-area-context", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    SafeAreaView: ({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) =>
      React.createElement(View, { style }, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

jest.mock("./MarketplaceScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Pressable, Text } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    MarketplaceScreen: ({ variant, onRequestTradeIn }: { variant?: string; onRequestTradeIn?: () => void }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, { testID: "marketplace-screen" }, `variant:${variant}`),
        onRequestTradeIn
          ? React.createElement(
              Pressable,
              { accessibilityLabel: "trigger-tradein", accessibilityRole: "button", onPress: onRequestTradeIn },
              React.createElement(Text, null, "x"),
            )
          : null,
      ),
  };
});

jest.mock("../account/BuyerSavedScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
  return { BuyerSavedScreen: () => React.createElement(Text, { testID: "buyer-saved" }, "saved") };
});

jest.mock("../account/BuyerAccountScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
  return { BuyerAccountScreen: () => React.createElement(Text, { testID: "buyer-account" }, "account") };
});

import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import { BUYER_SHELL_TABS, BuyerShell } from "./BuyerShell";

function renderShell() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <BuyerShell />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

describe("BuyerShell", () => {
  test("exposes four buyer tabs", () => {
    expect(BUYER_SHELL_TABS.map((tab) => tab.value)).toEqual(["browse", "request", "saved", "account"]);
  });

  // Default locale is Arabic.
  test("defaults to Browse and switches across every tab", async () => {
    const { getByLabelText, getByTestId } = await renderShell();

    expect(getByTestId("marketplace-screen").props.children).toBe("variant:browse");

    fireEvent.press(getByLabelText("اطلب")); // Request
    await waitFor(() => expect(getByTestId("marketplace-screen").props.children).toBe("variant:request"));

    fireEvent.press(getByLabelText("المحفوظة")); // Saved
    await waitFor(() => expect(getByTestId("buyer-saved")).toBeTruthy());

    fireEvent.press(getByLabelText("الحساب")); // Account
    await waitFor(() => expect(getByTestId("buyer-account")).toBeTruthy());

    fireEvent.press(getByLabelText("تصفّح")); // Browse
    await waitFor(() => expect(getByTestId("marketplace-screen").props.children).toBe("variant:browse"));
  });

  test("hands a Browse trade-in off to the Request tab", async () => {
    const { getByLabelText, getByTestId } = await renderShell();
    // Browse passes onRequestTradeIn; triggering it should switch to Request.
    fireEvent.press(getByLabelText("trigger-tradein"));
    await waitFor(() => expect(getByTestId("marketplace-screen").props.children).toBe("variant:request"));
  });
});
