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

jest.mock("./MarketplaceHomeScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
  return { MarketplaceHomeScreen: () => React.createElement(Text, { testID: "buyer-home" }, "home") };
});

jest.mock("../financing/FinancingScreen", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
  return { FinancingScreen: () => React.createElement(Text, { testID: "buyer-financing" }, "financing") };
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
  test("exposes five buyer tabs", () => {
    expect(BUYER_SHELL_TABS.map((tab) => tab.value)).toEqual([
      "home",
      "cars",
      "favorites",
      "financing",
      "account",
    ]);
  });

  // Default locale is Arabic.
  test("defaults to Home and switches across every tab", async () => {
    const { getByLabelText, getByTestId } = await renderShell();

    expect(getByTestId("buyer-home")).toBeTruthy();

    fireEvent.press(getByLabelText("السيارات")); // Cars
    await waitFor(() => expect(getByTestId("marketplace-screen").props.children).toBe("variant:browse"));

    fireEvent.press(getByLabelText("المفضلة")); // Favorites
    await waitFor(() => expect(getByTestId("buyer-saved")).toBeTruthy());

    fireEvent.press(getByLabelText("التمويل")); // Financing
    await waitFor(() => expect(getByTestId("buyer-financing")).toBeTruthy());

    fireEvent.press(getByLabelText("حسابي")); // Account
    await waitFor(() => expect(getByTestId("buyer-account")).toBeTruthy());

    fireEvent.press(getByLabelText("الرئيسية")); // Home
    await waitFor(() => expect(getByTestId("buyer-home")).toBeTruthy());
  });

  test("hands a Cars trade-in off to the Request takeover", async () => {
    const { getByLabelText, getByTestId } = await renderShell();

    // Open the Cars tab, whose browse variant passes onRequestTradeIn.
    fireEvent.press(getByLabelText("السيارات"));
    await waitFor(() => expect(getByTestId("marketplace-screen").props.children).toBe("variant:browse"));

    // Triggering it opens the Request takeover.
    fireEvent.press(getByLabelText("trigger-tradein"));
    await waitFor(() => expect(getByTestId("marketplace-screen").props.children).toBe("variant:request"));
  });
});
