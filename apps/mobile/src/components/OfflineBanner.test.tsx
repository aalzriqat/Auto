/// <reference types="jest" />

import { render, waitFor } from "@testing-library/react-native";

const mockConnectionState = jest.fn();

jest.mock("convex/react", () => ({
  useConvexConnectionState: () => mockConnectionState(),
}));

import { LocaleProvider } from "../providers/LocaleProvider";
import { ThemeProvider } from "../providers/ThemeProvider";
import { OfflineBanner } from "./OfflineBanner";

// Default locale is Arabic (DEFAULT_LOCALE = "ar").
const OFFLINE_TEXT = "أنت غير متصل — جاري إعادة الاتصال…";

function renderBanner() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <OfflineBanner />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

describe("OfflineBanner", () => {
  beforeEach(() => mockConnectionState.mockReset());

  test("warns once the socket drops after a successful connect", async () => {
    mockConnectionState.mockReturnValue({ isWebSocketConnected: false, hasEverConnected: true });

    const screen = await renderBanner();

    await waitFor(() => expect(screen.getByText(OFFLINE_TEXT)).toBeTruthy());
    // Announced to screen readers rather than being a purely visual cue.
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  test("stays hidden while connected", async () => {
    mockConnectionState.mockReturnValue({ isWebSocketConnected: true, hasEverConnected: true });

    const screen = await renderBanner();

    expect(screen.queryByText(OFFLINE_TEXT)).toBeNull();
  });

  test("stays hidden during the very first connect", async () => {
    // The socket is briefly down on a cold start; flashing "offline" at every
    // launch would train people to ignore the banner.
    mockConnectionState.mockReturnValue({ isWebSocketConnected: false, hasEverConnected: false });

    const screen = await renderBanner();

    expect(screen.queryByText(OFFLINE_TEXT)).toBeNull();
  });
});
