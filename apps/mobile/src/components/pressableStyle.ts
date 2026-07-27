import type { StyleProp, ViewStyle } from "react-native";

/**
 * Builds the `style` callback a `Pressable` expects, resolving the pressed and
 * disabled variants of a button.
 *
 * Extracted because the inline form —
 * `({ pressed }) => [base, pressed && pressedStyle, isDisabled && disabledStyle]`
 * — was repeated on every button and could not be covered by tests: React
 * Native resolves the callback internally, so `pressed: true` is never
 * reachable from `fireEvent`. As a plain function it is directly unit-testable,
 * and the call sites lose a chunk of duplication.
 */
export function makeButtonStyle(
  base: StyleProp<ViewStyle>,
  pressedStyle: StyleProp<ViewStyle>,
  disabledStyle?: StyleProp<ViewStyle>,
  isDisabled = false,
) {
  return ({ pressed }: { pressed: boolean }): StyleProp<ViewStyle> => [
    base,
    pressed ? pressedStyle : null,
    isDisabled ? disabledStyle ?? null : null,
  ];
}
