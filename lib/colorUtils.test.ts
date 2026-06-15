import { describe, it, expect } from "vitest";
import { hexToHslString } from "./colorUtils";

describe("hexToHslString", () => {
  it("converts pure red #ff0000", () => {
    expect(hexToHslString("#ff0000")).toBe("0 100% 50%");
  });

  it("converts pure green #00ff00", () => {
    expect(hexToHslString("#00ff00")).toBe("120 100% 50%");
  });

  it("converts pure blue #0000ff", () => {
    expect(hexToHslString("#0000ff")).toBe("240 100% 50%");
  });

  it("converts white #ffffff", () => {
    expect(hexToHslString("#ffffff")).toBe("0 0% 100%");
  });

  it("converts black #000000", () => {
    expect(hexToHslString("#000000")).toBe("0 0% 0%");
  });

  it("expands 3-char shorthand #rgb", () => {
    // #f00 expands to #ff0000
    expect(hexToHslString("#f00")).toBe("0 100% 50%");
  });

  it("expands 3-char shorthand #0f0", () => {
    expect(hexToHslString("#0f0")).toBe("120 100% 50%");
  });

  it("returns null for invalid hex string", () => {
    expect(hexToHslString("#zzzzzz")).toBeNull();
  });

  it("returns null for wrong length", () => {
    expect(hexToHslString("#12345")).toBeNull();
    expect(hexToHslString("#1234567")).toBeNull();
  });

  it("converts a mid-range gray", () => {
    // #808080 → H=0, S=0%, L=50%
    expect(hexToHslString("#808080")).toBe("0 0% 50%");
  });

  it("handles hex without hash prefix (empty after replace)", () => {
    // 'ff0000' without # — after replace, cleaned = 'ff0000', length 6 → valid
    expect(hexToHslString("ff0000")).toBe("0 100% 50%");
  });
});
