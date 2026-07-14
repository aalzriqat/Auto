/// <reference types="jest" />

import { DEFAULT_LOCALE, getMobileFoundationString, isRtlLocale } from "@autoflow/shared";
import * as SecureStore from "expo-secure-store";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import { LocaleProvider, useLocale } from "./LocaleProvider";

const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
const setItemAsync = SecureStore.setItemAsync as jest.MockedFunction<typeof SecureStore.setItemAsync>;

function LocaleProbe() {
  const { locale, setLocale, t, textDirection } = useLocale();

  return (
    <>
      <Text testID="locale-state">{`${locale}:${textDirection}:${t("home")}`}</Text>
      <Pressable
        accessibilityLabel="set-arabic"
        accessibilityRole="button"
        onPress={() => {
          void setLocale("ar");
        }}
      >
        <Text>Set Arabic</Text>
      </Pressable>
    </>
  );
}

describe("mobile locale provider", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockResolvedValue(undefined);
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test("provides the default locale when no preference is stored", async () => {
    const { getByTestId } = await render(
      <LocaleProvider>
        <LocaleProbe />
      </LocaleProvider>,
    );

    await waitFor(() => {
      const direction = isRtlLocale(DEFAULT_LOCALE) ? "rtl" : "ltr";
      expect(getByTestId("locale-state").props.children).toBe(
        `${DEFAULT_LOCALE}:${direction}:${getMobileFoundationString(DEFAULT_LOCALE, "home")}`,
      );
    });
  });

  test("loads and normalizes a stored LTR locale", async () => {
    getItemAsync.mockResolvedValueOnce("en-US");
    const { getByTestId } = await render(
      <LocaleProvider>
        <LocaleProbe />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(getByTestId("locale-state").props.children).toBe(
        `en:ltr:${getMobileFoundationString("en", "home")}`,
      );
    });
  });

  test("persists locale changes and reports storage failures safely", async () => {
    setItemAsync.mockRejectedValueOnce(new Error("secure store unavailable"));
    const { getByLabelText, getByTestId } = await render(
      <LocaleProvider>
        <LocaleProbe />
      </LocaleProvider>,
    );

    await fireEvent.press(getByLabelText("set-arabic"));

    await waitFor(() => {
      expect(getByTestId("locale-state").props.children).toBe(
        `ar:rtl:${getMobileFoundationString("ar", "home")}`,
      );
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to save mobile locale preference",
        expect.any(Error),
      );
    });
  });

  test("keeps the default locale when loading the stored preference fails", async () => {
    getItemAsync.mockRejectedValueOnce(new Error("secure store unavailable"));
    const { getByTestId } = await render(
      <LocaleProvider>
        <LocaleProbe />
      </LocaleProvider>,
    );

    await waitFor(() => {
      const direction = isRtlLocale(DEFAULT_LOCALE) ? "rtl" : "ltr";
      expect(getByTestId("locale-state").props.children).toBe(
        `${DEFAULT_LOCALE}:${direction}:${getMobileFoundationString(DEFAULT_LOCALE, "home")}`,
      );
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to load mobile locale preference",
        expect.any(Error),
      );
    });
  });

  test("requires consumers to render inside the provider", async () => {
    function ConsumerWithoutProvider() {
      useLocale();
      return null;
    }

    await expect(render(<ConsumerWithoutProvider />)).rejects.toThrow(
      "useLocale must be used within LocaleProvider",
    );
  });
});
