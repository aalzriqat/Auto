import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, type StyleProp, type ViewStyle } from "react-native";

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
