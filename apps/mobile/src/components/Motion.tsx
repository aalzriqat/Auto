import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, type StyleProp, type ViewStyle } from "react-native";

/**
 * Live "Reduce Motion" state from the OS accessibility settings.
 *
 * Reads the current value on mount AND subscribes to changes: a user can flip
 * the setting from Control Center / quick settings while the app is foregrounded,
 * and a read-once implementation would keep animating for the rest of the session.
 * Any failure to read the setting leaves motion enabled — the setting is a
 * preference, and losing it must not blank the UI.
 */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let subscribed = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (subscribed) {
          setReduceMotion(Boolean(enabled));
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to read the reduce-motion accessibility setting", error);
      });

    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      setReduceMotion(Boolean(enabled));
    });

    return () => {
      subscribed = false;
      subscription?.remove();
    };
  }, []);

  return reduceMotion;
}

/** Where FadeSlideIn ends up. Used directly when motion is reduced. */
const RESTING_FADE_SLIDE = { opacity: 1, transform: [{ translateY: 0 }] } as const;

export function FadeSlideIn({
  children,
  delay = 0,
  style,
}: Readonly<{
  children: ReactNode;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}>) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (reduceMotion) {
      return;
    }

    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 420,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [delay, progress, reduceMotion]);

  return (
    <Animated.View
      style={[
        style,
        // Reduce motion swaps the driven style for the resting one outright,
        // rather than jumping the Animated.Value: `progress` drives opacity, so
        // anything that skips the animation without also replacing the style
        // renders every list and screen in the app permanently invisible.
        reduceMotion
          ? RESTING_FADE_SLIDE
          : {
            opacity: progress,
            transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
          },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Tactile press feedback: springs the content down slightly on press-in and
 * back on release. Core Animated (native driver) — no reanimated, ships OTA.
 * This is the "premium feel" primitive used on tappable cards/tiles.
 */
export function PressableScale({
  accessibilityLabel,
  accessibilityRole = "button",
  children,
  disabled,
  onPress,
  scaleTo = 0.97,
  style,
  testID,
}: Readonly<{
  accessibilityLabel?: string;
  accessibilityRole?: "button" | "link";
  children: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}>) {
  const scale = useRef(new Animated.Value(1)).current;
  const springTo = (toValue: number) => {
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      friction: 7,
      tension: 140,
    }).start();
  };

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      disabled={disabled}
      testID={testID}
      onPress={onPress}
      onPressIn={() => springTo(scaleTo)}
      onPressOut={() => springTo(1)}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

export function useCountUp(target: number, duration = 700): number {
  const [display, setDisplay] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    // The final number is the information; the roll-up is decoration.
    if (reduceMotion) {
      setDisplay(target);
      return;
    }

    progress.setValue(0);
    const listenerId = progress.addListener(({ value }) => {
      setDisplay(Math.round(value * target));
    });
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => {
      animation.stop();
      progress.removeListener(listenerId);
    };
  }, [target, duration, progress, reduceMotion]);

  return display;
}
