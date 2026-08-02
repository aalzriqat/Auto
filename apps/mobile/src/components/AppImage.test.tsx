/// <reference types="jest" />

type ExpoImageBehavior = "ok" | "module-throws" | "no-export" | "view-throws";

let mockBehavior: ExpoImageBehavior = "ok";

// A getter, so a test can make the module throw on ACCESS — which is how a
// binary without the native module actually fails.
jest.mock("expo-image", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Image } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    get Image() {
      if (mockBehavior === "module-throws") {
        throw new Error("Cannot find native module 'ExpoImage'");
      }
      if (mockBehavior === "no-export") {
        return undefined;
      }
      if (mockBehavior === "view-throws") {
        return () => {
          throw new Error("ExpoImage view is not registered");
        };
      }
      return (props: { testID?: string }) =>
        React.createElement(Image, { ...props, testID: props.testID ?? "expo-image" });
    },
  };
});

import { fireEvent, render } from "@testing-library/react-native";

import { AppImage, resetExpoImageCache, resolveExpoImage } from "./AppImage";

beforeEach(() => {
  mockBehavior = "ok";
  resetExpoImageCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("AppImage", () => {
  test("renders only the placeholder when there is no uri", async () => {
    const { getByTestId, queryByTestId } = await render(<AppImage testID="thumb" />);

    expect(getByTestId("thumb")).toBeTruthy();
    expect(queryByTestId("thumb-placeholder")).toBeNull();
  });

  test("holds a placeholder under the image until it finishes loading", async () => {
    const view = await render(<AppImage testID="thumb" uri="https://example.com/a.jpg" />);

    // A raw <Image> showed a blank rectangle here, with no way to tell a slow
    // load from a dead URL.
    expect(view.getByTestId("thumb-placeholder")).toBeTruthy();

    await fireEvent(view.getByTestId("thumb"), "loadEnd");
    expect(view.queryByTestId("thumb-placeholder")).toBeNull();
  });

  test("keeps the placeholder and reports the failure when the image errors", async () => {
    const onError = jest.fn();
    const view = await render(
      <AppImage onError={onError} testID="thumb" uri="https://example.com/gone.jpg" />,
    );

    await fireEvent(view.getByTestId("thumb"), "error");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("thumb-placeholder")).toBeTruthy();
    // The broken image is dropped, so no torn frame is left behind.
    expect(view.queryByTestId("thumb")).toBeNull();
  });

  test("survives an error with no onError handler and no testID", async () => {
    const view = await render(<AppImage uri="https://example.com/gone.jpg" />);

    await fireEvent(view.getByTestId("expo-image"), "error");
    expect(view.toJSON()).toBeTruthy();
  });

  test("falls back to the platform renderer when expo-image is not in the binary", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockBehavior = "module-throws";
    resetExpoImageCache();

    const view = await render(<AppImage testID="thumb" uri="https://example.com/a.jpg" />);

    // The OTA case: JavaScript shipped to a binary predating the native module.
    expect(view.getByTestId("thumb")).toBeTruthy();
    expect(consoleError).toHaveBeenCalledWith(
      "expo-image is unavailable in this build",
      expect.any(Error),
    );
  });

  test("falls back when the module resolves but exports no Image", async () => {
    mockBehavior = "no-export";
    resetExpoImageCache();

    const view = await render(<AppImage testID="thumb" uri="https://example.com/a.jpg" />);

    expect(view.getByTestId("thumb")).toBeTruthy();
    // The fallback carries the same placeholder lifecycle as the fast path.
    expect(view.getByTestId("thumb-placeholder")).toBeTruthy();
    await fireEvent(view.getByTestId("thumb"), "loadEnd");
    expect(view.queryByTestId("thumb-placeholder")).toBeNull();
  });

  test("falls back when the native view throws while rendering", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockBehavior = "view-throws";
    resetExpoImageCache();

    const view = await render(<AppImage testID="thumb" uri="https://example.com/a.jpg" />);

    // The error boundary is why an old binary degrades instead of white-screening
    // on the first vehicle photo it meets.
    expect(view.getByTestId("thumb")).toBeTruthy();
    expect(consoleError).toHaveBeenCalledWith(
      "Falling back to the platform image renderer",
      expect.any(Error),
    );
  });

  test("resolves the module only once", async () => {
    expect(resolveExpoImage()).toBeTruthy();
    mockBehavior = "module-throws";
    // No reset: the cached component stands, so a later render does not re-pay
    // the resolution cost or re-log.
    expect(resolveExpoImage()).toBeTruthy();
  });

  test("passes through fit, label and testID", async () => {
    const view = await render(
      <AppImage
        accessibilityLabel="Vehicle photo"
        contentFit="contain"
        testID="thumb"
        uri="https://example.com/a.jpg"
      />,
    );

    expect(view.getByTestId("thumb").props.contentFit).toBe("contain");
    expect(view.getByLabelText("Vehicle photo")).toBeTruthy();
  });
});
