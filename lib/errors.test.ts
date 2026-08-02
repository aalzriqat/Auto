/**
 * The bug these guard: `toast.error(error)` handed sonner v2 a raw Error object
 * where it expects a ReactNode, so a failed mutation rendered no toast at all.
 * The fix is only useful if the string that replaces it is (a) never empty,
 * (b) never a stack trace, and (c) actually the message the server meant.
 *
 * The wrapper strings below are the real shape produced by
 * `createHybridErrorStacktrace` in convex/browser — prefix, request id, the
 * `Uncaught ...:` line, V8 frames, then the `Called by client` marker.
 */
import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { getErrorMessage, GENERIC_ERROR_MESSAGE } from "./errors";

/** Mirrors what the browser client hands a `catch` block for a server throw. */
function convexWrapped(inner: string, kind: "Error" | "ConvexError" = "Error"): string {
  return [
    `[CONVEX M(sales:create)] [Request ID: abc123] Server Error`,
    `Uncaught ${kind}: ${inner}`,
    `    at handler (../convex/sales.ts:120:5)`,
    `    at async invokeMutation (../convex/_deps/node_modules/convex.js:44:9)`,
    `  Called by client`,
  ].join("\n");
}

describe("getErrorMessage — ConvexError payloads", () => {
  it("uses string .data from a real ConvexError instance", () => {
    expect(getErrorMessage(new ConvexError("Vehicle already sold"))).toBe("Vehicle already sold");
  });

  it("uses .data.message when the server threw a structured payload", () => {
    const error = new ConvexError({ code: "SOLD", message: "Vehicle already sold" });
    expect(getErrorMessage(error)).toBe("Vehicle already sold");
  });

  it("detects a ConvexError from another copy of the package via its symbol marker", () => {
    // pnpm can resolve two copies of `convex` (one per peer set), so
    // `instanceof` is not reliable. The symbol is how Convex itself identifies
    // these, and it must keep working on a cross-realm object.
    const foreign = {
      [Symbol.for("ConvexError")]: true,
      data: "Insufficient permissions",
      message: convexWrapped("Insufficient permissions"),
    };
    expect(getErrorMessage(foreign)).toBe("Insufficient permissions");
  });

  it("detects a ConvexError by name when the symbol is absent", () => {
    const shaped = { name: "ConvexError", data: "Branch is closed", message: "irrelevant" };
    expect(getErrorMessage(shaped)).toBe("Branch is closed");
  });

  it("falls through to the wrapped message when .data carries no usable message", () => {
    // data is an object with no `message` key — the readable text is still
    // sitting inside the transport wrapper, so it must not be discarded.
    const error = new ConvexError({ code: "SOLD" });
    error.message = convexWrapped("Vehicle already sold", "ConvexError");
    expect(getErrorMessage(error)).toBe("Vehicle already sold");
  });

  it("falls back to generic when .data is unusable and the wrapper has no inner message", () => {
    const error = new ConvexError({ code: "SOLD" });
    error.message = "[CONVEX M(sales:create)] [Request ID: abc123] Server Error";
    expect(getErrorMessage(error)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("ignores an empty or whitespace-only .data payload", () => {
    const error = new ConvexError("   ");
    error.message = "[CONVEX M(x)] [Request ID: y] Server Error";
    expect(getErrorMessage(error)).toBe(GENERIC_ERROR_MESSAGE);
  });
});

describe("getErrorMessage — stripping the Convex transport wrapper", () => {
  it("returns only the inner message from an `Uncaught Error:` wrapper", () => {
    expect(getErrorMessage(new Error(convexWrapped("Vehicle already sold")))).toBe(
      "Vehicle already sold"
    );
  });

  it("handles the `Uncaught ConvexError:` variant", () => {
    expect(getErrorMessage(new Error(convexWrapped("Not enough stock", "ConvexError")))).toBe(
      "Not enough stock"
    );
  });

  it("leaks no request id, stack frame, source path or transport prefix", () => {
    const result = getErrorMessage(new Error(convexWrapped("Vehicle already sold")));
    expect(result).not.toContain("Request ID");
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("[CONVEX");
    expect(result).not.toContain("Server Error");
    expect(result).not.toContain("at handler");
    expect(result).not.toContain("convex/sales.ts");
    expect(result).not.toContain("Called by client");
    expect(result).not.toContain("\n");
  });

  it("strips `Called by client` even when no stack frames are present", () => {
    const message = [
      "[CONVEX M(sales:create)] [Request ID: abc123] Server Error",
      "Uncaught Error: Vehicle already sold",
      "  Called by client",
    ].join("\n");
    expect(getErrorMessage(new Error(message))).toBe("Vehicle already sold");
  });

  it("falls back to generic when the wrapper has no recognisable inner message", () => {
    // ArgumentValidationError names schema fields — exactly what must not reach
    // the UI, and there is no `Uncaught ...:` line to extract.
    const message = [
      "[CONVEX M(sales:create)] [Request ID: abc123] Server Error",
      "ArgumentValidationError: Object is missing the required field `vehicleId`.",
      "  Called by client",
    ].join("\n");
    const result = getErrorMessage(new Error(message));
    expect(result).toBe(GENERIC_ERROR_MESSAGE);
    expect(result).not.toContain("vehicleId");
  });

  it("falls back to generic when the inner message is empty", () => {
    const message = [
      "[CONVEX M(sales:create)] [Request ID: abc123] Server Error",
      "Uncaught Error: ",
      "    at handler (../convex/sales.ts:120:5)",
    ].join("\n");
    expect(getErrorMessage(new Error(message))).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("never returns a bare stack trace", () => {
    const message = [
      "[CONVEX M(sales:create)] [Request ID: abc123] Server Error",
      "    at handler (../convex/sales.ts:120:5)",
    ].join("\n");
    expect(getErrorMessage(new Error(message))).toBe(GENERIC_ERROR_MESSAGE);
  });
});

describe("getErrorMessage — plain errors, strings and junk", () => {
  it("returns a plain client-side Error's message untouched", () => {
    expect(getErrorMessage(new Error("Please pick a customer first"))).toBe(
      "Please pick a customer first"
    );
  });

  it("accepts an Error-shaped object from another realm", () => {
    expect(getErrorMessage({ message: "Network request failed" })).toBe("Network request failed");
  });

  it("returns a thrown string as-is", () => {
    expect(getErrorMessage("Something specific went wrong")).toBe("Something specific went wrong");
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only string", "   \n  "],
    ["an Error with an empty message", new Error("")],
  ])("falls back to generic for %s", (_label, input) => {
    expect(getErrorMessage(input)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 500],
    ["a plain object", { status: 500 }],
    ["an array", ["boom"]],
    ["a boolean", false],
  ])("falls back to generic for %s", (_label, input) => {
    expect(getErrorMessage(input)).toBe(GENERIC_ERROR_MESSAGE);
  });
});

describe("getErrorMessage — totality", () => {
  it("never throws when the thrown value's getters throw", () => {
    const hostile = {
      get message(): string {
        throw new Error("getter exploded");
      },
      get data(): string {
        throw new Error("getter exploded");
      },
      name: "ConvexError",
    };
    expect(() => getErrorMessage(hostile)).not.toThrow();
    expect(getErrorMessage(hostile)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("never throws on a Proxy that rejects property access", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("proxy trap");
        },
        has() {
          throw new Error("proxy trap");
        },
      }
    );
    expect(() => getErrorMessage(hostile)).not.toThrow();
    expect(getErrorMessage(hostile)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it.each([
    ["a ConvexError", new ConvexError("x")],
    ["a wrapped Error", new Error(convexWrapped("x"))],
    ["a plain Error", new Error("x")],
    ["a string", "x"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
  ])("always returns a non-empty string for %s", (_label, input) => {
    const result = getErrorMessage(input);
    expect(typeof result).toBe("string");
    expect(result.trim().length).toBeGreaterThan(0);
  });
});
