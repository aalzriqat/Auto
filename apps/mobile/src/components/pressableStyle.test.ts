/// <reference types="jest" />

import { makeButtonStyle } from "./pressableStyle";

const base = { flex: 1 };
const pressedStyle = { opacity: 0.8 };
const disabledStyle = { opacity: 0.6 };

describe("makeButtonStyle", () => {
  test("applies only the base style at rest", () => {
    expect(makeButtonStyle(base, pressedStyle, disabledStyle)({ pressed: false })).toEqual([
      base,
      null,
      null,
    ]);
  });

  test("adds the pressed style while a touch is down", () => {
    expect(makeButtonStyle(base, pressedStyle, disabledStyle)({ pressed: true })).toEqual([
      base,
      pressedStyle,
      null,
    ]);
  });

  test("adds the disabled style when disabled", () => {
    expect(makeButtonStyle(base, pressedStyle, disabledStyle, true)({ pressed: false })).toEqual([
      base,
      null,
      disabledStyle,
    ]);
  });

  test("can be both pressed and disabled", () => {
    // Reachable in practice: a control can be disabled mid-gesture.
    expect(makeButtonStyle(base, pressedStyle, disabledStyle, true)({ pressed: true })).toEqual([
      base,
      pressedStyle,
      disabledStyle,
    ]);
  });

  test("tolerates a button with no disabled variant", () => {
    expect(makeButtonStyle(base, pressedStyle, undefined, true)({ pressed: false })).toEqual([
      base,
      null,
      null,
    ]);
  });
});
