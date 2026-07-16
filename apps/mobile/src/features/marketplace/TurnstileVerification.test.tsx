/// <reference types="jest" />

import { getMobileFoundationString } from "@autoflow/shared";
import * as SecureStore from "expo-secure-store";
import { act, render, waitFor } from "@testing-library/react-native";

import { LocaleProvider } from "../../providers/LocaleProvider";
import { TurnstileVerification } from "./TurnstileVerification";

type MockWebViewProps = {
  onError: () => void;
  onLoadStart: () => void;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  source: {
    baseUrl?: string;
    html?: string;
  };
};

const mockWebViewProps: MockWebViewProps[] = [];

jest.mock("react-native-webview", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    WebView: (props: MockWebViewProps) => {
      mockWebViewProps.push(props);
      return React.createElement(View, { testID: "turnstile-webview" });
    },
  };
});

const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

function setValidPublicEnv(appUrl?: string): void {
  process.env.EXPO_PUBLIC_CONVEX_URL = "https://example.convex.cloud";
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_123";
  process.env.EXPO_PUBLIC_APP_SCHEME = "autoflow";
  if (appUrl === undefined) {
    delete process.env.EXPO_PUBLIC_APP_URL;
  } else {
    process.env.EXPO_PUBLIC_APP_URL = appUrl;
  }
}

async function renderVerification(options: {
  omitSiteKey?: boolean;
  onTokenChange?: jest.Mock<void, [string | null]>;
  siteKey?: string;
} = {}) {
  const onTokenChange = options.onTokenChange ?? jest.fn<void, [string | null]>();
  const siteKey = options.omitSiteKey ? undefined : options.siteKey ?? "site-key";

  return {
    onTokenChange,
    ...(await render(
      <LocaleProvider>
        <TurnstileVerification onTokenChange={onTokenChange} resetKey={1} siteKey={siteKey} />
      </LocaleProvider>,
    )),
  };
}

function getLastWebViewProps(): MockWebViewProps {
  const props = mockWebViewProps.at(-1);
  if (!props) {
    throw new Error("Expected the Turnstile WebView to render.");
  }
  return props;
}

describe("Turnstile verification", () => {
  beforeEach(() => {
    mockWebViewProps.length = 0;
    getItemAsync.mockReset();
    getItemAsync.mockResolvedValue("en");
    setValidPublicEnv("https://mobile.example/");
  });

  test("shows a localized notice when verification is not configured", async () => {
    const { getByText } = await renderVerification({ omitSiteKey: true });

    expect(getByText(getMobileFoundationString("en", "marketplaceVerificationMissing"))).toBeTruthy();
    expect(mockWebViewProps).toHaveLength(0);
  });

  test("renders a Turnstile WebView with safe HTML and configured base URL", async () => {
    await renderVerification({ siteKey: "<site-key" });
    const props = getLastWebViewProps();

    expect(props.source.baseUrl).toBe("https://mobile.example/");
    expect(props.source.html).toContain("\\u003csite-key");
    expect(props.source.html).toContain('"en"');
  });

  test("falls back to the default base URL when app URL config is absent or invalid", async () => {
    setValidPublicEnv("");
    await renderVerification();
    expect(getLastWebViewProps().source.baseUrl).toBe("https://www.autoflowdealer.com/");

    delete process.env.EXPO_PUBLIC_CONVEX_URL;
    await renderVerification();
    expect(getLastWebViewProps().source.baseUrl).toBe("https://www.autoflowdealer.com/");
  });

  test("renders Arabic Turnstile HTML when the stored locale is Arabic", async () => {
    getItemAsync.mockResolvedValueOnce("ar");
    await renderVerification();

    await waitFor(() => {
      expect(getLastWebViewProps().source.html).toContain('<html lang="ar">');
      expect(getLastWebViewProps().source.html).toContain('"ar"');
    });
  });

  test("clears tokens during load and handles valid token messages", async () => {
    const { getByText, onTokenChange } = await renderVerification();
    const props = getLastWebViewProps();

    await act(async () => {
      props.onLoadStart();
    });
    expect(onTokenChange).toHaveBeenLastCalledWith(null);

    await act(async () => {
      props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "token", token: "token-123" }) } });
    });

    expect(onTokenChange).toHaveBeenLastCalledWith("token-123");
    expect(getByText(getMobileFoundationString("en", "marketplaceVerificationComplete"))).toBeTruthy();
  });

  test("handles expired, error, invalid, and WebView error states", async () => {
    const { getByText, onTokenChange } = await renderVerification();
    const props = getLastWebViewProps();

    await act(async () => {
      props.onMessage({ nativeEvent: { data: "not-json" } });
    });
    expect(onTokenChange).not.toHaveBeenCalled();

    await act(async () => {
      props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "expired" }) } });
    });
    expect(onTokenChange).toHaveBeenLastCalledWith(null);
    expect(getByText(getMobileFoundationString("en", "marketplaceVerificationExpired"))).toBeTruthy();

    await act(async () => {
      props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "error", code: "load-timeout" }) } });
    });
    expect(onTokenChange).toHaveBeenLastCalledWith(null);
    expect(getByText(getMobileFoundationString("en", "marketplaceVerificationFailed"))).toBeTruthy();

    await act(async () => {
      props.onError();
    });
    expect(onTokenChange).toHaveBeenLastCalledWith(null);
    expect(getByText(getMobileFoundationString("en", "marketplaceVerificationFailed"))).toBeTruthy();
  });
});
