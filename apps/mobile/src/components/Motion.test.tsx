/// <reference types="jest" />

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo, Text } from "react-native";

import { FadeSlideIn, PressableScale, useCountUp } from "./Motion";

type ReduceMotionListener = (enabled: boolean) => void;

/**
 * Drives the OS reduce-motion setting: `initial` is what the first read
 * resolves to, and the returned `emit` fires the change event the way the
 * platform does when the user flips the toggle mid-session.
 */
function mockReduceMotion(initial: boolean | Promise<boolean>) {
  const listeners: ReduceMotionListener[] = [];
  const remove = jest.fn(() => {
    listeners.length = 0;
  });

  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockReturnValue(
      typeof initial === "boolean" ? Promise.resolve(initial) : initial,
    );
  jest
    .spyOn(AccessibilityInfo, "addEventListener")
    .mockImplementation((event: string, handler: unknown) => {
      if (event === "reduceMotionChanged") {
        listeners.push(handler as ReduceMotionListener);
      }
      return { remove } as never;
    });

  return {
    remove,
    emit: async (enabled: boolean) => {
      await act(async () => {
        listeners.forEach((listener) => listener(enabled));
      });
    },
  };
}

function CountUpProbe({ target }: Readonly<{ target: number }>) {
  return <Text testID="count">{String(useCountUp(target))}</Text>;
}

/**
 * Lets the mocked `isReduceMotionEnabled` promise settle WITHOUT advancing any
 * clock. Anything asserted after this had to be reached by skipping the
 * animation, not by waiting one out.
 */
async function settleAccessibilityRead() {
  await act(async () => {});
}

/** Current numeric opacity of the single Animated.View FadeSlideIn renders. */
function renderedOpacity(json: unknown): number {
  const styles = (json as { props: { style: unknown } }).props.style;
  const flat = (Array.isArray(styles) ? styles : [styles]).filter(Boolean) as Array<
    Record<string, unknown>
  >;
  const opacity = flat.map((entry) => entry?.opacity).find((value) => value !== undefined);
  // Animated flattens its driven props to plain numbers in the test renderer.
  return typeof opacity === "number"
    ? opacity
    : (opacity as { __getValue: () => number }).__getValue();
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("PressableScale", () => {
  test("springs on press and fires onPress", async () => {
    const onPress = jest.fn();
    const { getByLabelText } = await render(
      <PressableScale accessibilityLabel="scale-target" onPress={onPress} scaleTo={0.94}>
        <Text>tap me</Text>
      </PressableScale>,
    );

    const target = getByLabelText("scale-target");
    await fireEvent(target, "pressIn");
    await fireEvent(target, "pressOut");
    await fireEvent.press(target);

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("renders a disabled instance with default props", async () => {
    const { getByText } = await render(
      <PressableScale disabled>
        <Text>static</Text>
      </PressableScale>,
    );

    expect(getByText("static")).toBeTruthy();
  });
});

describe("reduce motion", () => {
  test("FadeSlideIn snaps to fully visible without running the 420ms fade", async () => {
    mockReduceMotion(true);

    const view = await render(
      <FadeSlideIn>
        <Text testID="content">visible</Text>
      </FadeSlideIn>,
    );
    await settleAccessibilityRead();

    // Not merely "the child exists" — progress drives opacity, so skipping the
    // animation without setting the resting value would render it invisible.
    expect(renderedOpacity(view.toJSON())).toBe(1);
    expect(view.getByTestId("content")).toBeTruthy();
  });

  test("FadeSlideIn starts transparent and animates when reduce motion is off", async () => {
    mockReduceMotion(false);

    const view = await render(
      <FadeSlideIn>
        <Text testID="content">visible</Text>
      </FadeSlideIn>,
    );
    await settleAccessibilityRead();

    expect(renderedOpacity(view.toJSON())).toBeLessThan(1);
  });

  test("useCountUp jumps straight to the target instead of rolling up", async () => {
    mockReduceMotion(true);

    const { getByTestId } = await render(<CountUpProbe target={128} />);
    await settleAccessibilityRead();

    // No clock advanced: the only way to reach 128 here is skipping the count.
    expect(getByTestId("count").props.children).toBe("128");
  });

  test("useCountUp animates from zero when reduce motion is off", async () => {
    mockReduceMotion(false);

    const { getByTestId } = await render(<CountUpProbe target={128} />);
    await settleAccessibilityRead();

    // No clock advanced, so the roll-up is still far from the target.
    expect(Number(getByTestId("count").props.children)).toBeLessThan(128);
  });

  test("reacts to the setting being flipped mid-session, not just at mount", async () => {
    const control = mockReduceMotion(false);

    const { getByTestId } = await render(<CountUpProbe target={64} />);
    expect(getByTestId("count").props.children).toBe("0");

    await control.emit(true);

    expect(getByTestId("count").props.children).toBe("64");
  });

  test("unsubscribes on unmount", async () => {
    const control = mockReduceMotion(false);

    const view = await render(
      <FadeSlideIn>
        <Text>bye</Text>
      </FadeSlideIn>,
    );
    await act(async () => {
      view.unmount();
    });

    expect(control.remove).toHaveBeenCalled();
  });

  test("drops a read that resolves after unmount instead of setting state on a dead component", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    let resolveRead: (enabled: boolean) => void = () => undefined;
    mockReduceMotion(
      new Promise<boolean>((resolve) => {
        resolveRead = resolve;
      }),
    );

    const view = await render(<CountUpProbe target={7} />);
    await act(async () => {
      view.unmount();
    });

    // The platform read lands late — after the component is gone.
    await act(async () => {
      resolveRead(true);
    });

    // React would surface a state-update-after-unmount through console.error.
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("keeps motion enabled and logs when the setting cannot be read", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockReduceMotion(Promise.reject(new Error("no accessibility bridge")));

    const { getByTestId } = await render(<CountUpProbe target={99} />);

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to read the reduce-motion accessibility setting",
        expect.any(Error),
      );
    });
    // Failing to read the preference must not freeze the counter at its target.
    expect(getByTestId("count").props.children).toBe("0");
  });
});
