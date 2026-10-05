import { describe, expect, it } from "vitest";
import { isConvexError } from "./convexError";

describe("isConvexError", () => {
  it("recognises the Symbol.for('ConvexError') marker", () => {
    expect(isConvexError({ [Symbol.for("ConvexError")]: true, data: "x" })).toBe(true);
  });

  it("recognises an error named ConvexError", () => {
    const error = Object.assign(new Error("refused"), { name: "ConvexError", data: "x" });
    expect(isConvexError(error)).toBe(true);
  });

  it("rejects a plain Error", () => {
    expect(isConvexError(new Error("Server Error"))).toBe(false);
  });

  it.each([null, undefined, "ConvexError", 42])("rejects %p", (value) => {
    expect(isConvexError(value)).toBe(false);
  });
});