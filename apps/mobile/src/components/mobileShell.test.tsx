/// <reference types="jest" />

import { fireEvent, render } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { Text } from "react-native";

import { LocaleProvider } from "../providers/LocaleProvider";
import { getLocaleTogglePressedStyle, LocaleToggle } from "./LocaleToggle";
import { getRouteButtonPressedStyle, RouteErrorState, RouteLoadingState } from "./RouteState";
import { Screen } from "./Screen";

const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

describe("mobile shell components", () => {
  beforeEach(() => {
    getItemAsync.mockReset();
    getItemAsync.mockResolvedValue(null);
  });

  test("renders screen children inside the shared surface", async () => {
    const { getByText } = await render(
      <Screen>
        <Text>Inside shell</Text>
      </Screen>,
    );

    expect(getByText("Inside shell")).toBeTruthy();
  });

  test("renders loading and error states with retry behavior", async () => {
    const retry = jest.fn();
    const loading = await render(<RouteLoadingState label="Loading workspace" />);
    expect(loading.getByText("Loading workspace")).toBeTruthy();

    const fallbackError = await render(<RouteErrorState />);
    expect(fallbackError.getByText("An unexpected error occurred.")).toBeTruthy();

    const explicitError = await render(<RouteErrorState message="Could not load" onRetry={retry} />);
    const retryText = explicitError.getByText("Retry");

    expect(getRouteButtonPressedStyle(false)).toBeNull();
    expect(getRouteButtonPressedStyle(true)).not.toBeNull();
    await fireEvent(retryText, "pressIn");
    await fireEvent(retryText, "pressOut");
    await fireEvent.press(retryText);

    expect(explicitError.getByText("Could not load")).toBeTruthy();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("switches locale from Arabic to English in the compact locale toggle", async () => {
    const { getByLabelText, getByText } = await render(
      <LocaleProvider>
        <LocaleToggle />
      </LocaleProvider>,
    );

    const toggle = getByLabelText("Switch to English");
    expect(getLocaleTogglePressedStyle(false)).toBeNull();
    expect(getLocaleTogglePressedStyle(true)).not.toBeNull();
    await fireEvent(toggle, "pressIn");
    await fireEvent(toggle, "pressOut");
    await fireEvent.press(toggle);

    expect(getByText("AR")).toBeTruthy();
  });

  test("switches locale from English to Arabic in the compact locale toggle", async () => {
    getItemAsync.mockResolvedValueOnce("en");
    const { getByLabelText, getByText } = await render(
      <LocaleProvider>
        <LocaleToggle />
      </LocaleProvider>,
    );

    await fireEvent.press(getByLabelText("Switch to Arabic"));

    expect(getByText("EN")).toBeTruthy();
  });
});
