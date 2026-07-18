import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, type StyleProp, type ViewStyle } from "react-native";

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

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 420,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [delay, progress]);

  return (
    <Animated.View
      style={[
        style,
        {
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

  useEffect(() => {
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
  }, [target, duration, progress]);

  return display;
}
