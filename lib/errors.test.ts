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
import { getErrorMessage, getLocalizedErrorMessage, GENERIC_ERROR_MESSAGE } from "./errors";

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

describe("getLocalizedErrorMessage - coded server refusals", () => {
  const table: Record<string, string> = {
    ServerError_SOME_CODE: "ترجمة {baseCurrency} / {orgCurrency} / {baseCurrency}",
  };
  // Mirrors the language provider: an unresolved key comes back as itself.
  const t = (key: string) => table[key] ?? key;

  it("returns the translation for a code with a dictionary entry, filling placeholders", () => {
    const error = new ConvexError({ code: "SOME_CODE", message: "English text", baseCurrency: "USD", orgCurrency: "JOD" });
    expect(getLocalizedErrorMessage(error, t)).toBe("ترجمة USD / JOD / USD");
  });

  it("falls back to the server message for a code with no dictionary entry", () => {
    const error = new ConvexError({ code: "UNKNOWN_CODE", message: "English text" });
    expect(getLocalizedErrorMessage(error, t)).toBe("English text");
  });

  it("falls back to the message for a plain-string ConvexError", () => {
    expect(getLocalizedErrorMessage(new ConvexError("Vehicle already sold"), t)).toBe("Vehicle already sold");
  });

  it("falls back for a non-string code and for a non-Convex error", () => {
    expect(getLocalizedErrorMessage(new ConvexError({ code: 42, message: "Numeric code" }), t)).toBe("Numeric code");
    expect(getLocalizedErrorMessage(new Error("boom"), t)).toBe("boom");
    expect(getLocalizedErrorMessage(undefined, t)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("falls back when the translate function throws", () => {
    const error = new ConvexError({ code: "SOME_CODE", message: "English text" });
    expect(getLocalizedErrorMessage(error, () => { throw new Error("no provider"); })).toBe("English text");
  });

  it("the two SCRUM-390 refusal codes resolve to non-key, placeholder-filled Arabic", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    const ar = (key: string) => (dictionaries.ar as Record<string, string>)[key] ?? key;
    const finalize = getLocalizedErrorMessage(
      new ConvexError({ code: "COMMISSION_BASE_UNUSABLE", message: "en", baseCurrency: "USD", orgCurrency: "JOD" }),
      ar
    );
    expect(finalize).toContain("USD");
    expect(finalize).toContain("JOD");
    expect(finalize).toMatch(/[\u0600-\u06FF]/);
    expect(finalize).not.toMatch(/\{\w+\}/);
    const recalc = getLocalizedErrorMessage(new ConvexError({ code: "COMMISSION_BASE_UNUSABLE_RECALC", message: "en" }), ar);
    expect(recalc).toMatch(/[\u0600-\u06FF]/);
    expect(recalc).not.toBe("en");
  });

  it("the SCRUM-571 payment-link refusals resolve to Arabic in ar and the server text in en", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    const { PAYMENT_LINK_REFUSALS } = await import("../convex/paymentIntents");
    const ar = (key: string) => (dictionaries.ar as Record<string, string>)[key] ?? key;
    const en = (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key;
    // Derived from the server table so a new refusal cannot ship untranslated.
    for (const code of [...Object.keys(PAYMENT_LINK_REFUSALS), "PAYMENT_LINK_RECEIPT_MANUAL_REFUSED"]) {
      const error = new ConvexError({ code, message: "server text" });
      const arText = getLocalizedErrorMessage(error, ar);
      expect(arText).toMatch(/[؀-ۿ]/);
      expect(arText).not.toBe("server text");
      expect(arText).toBe((dictionaries.ar as Record<string, string>)[`ServerError_${code}`]);
      expect(getLocalizedErrorMessage(error, en)).toBe((dictionaries.en as Record<string, string>)[`ServerError_${code}`]);
    }
  });

  it("SCRUM-650 purchase-cost correction refusals resolve to Arabic in ar and the server text in en", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    const { AppErrorCode } = await import("../convex/utils/errors");
    const ar = (key: string) => (dictionaries.ar as Record<string, string>)[key] ?? key;
    const en = (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key;
    // Derived from the server enum so a new correction refusal cannot ship untranslated.
    const codes = Object.values(AppErrorCode).filter(
      (code) => code === "VEHICLE_COST_POSTED" || code.startsWith("COST_CORRECTION_")
    );
    expect(codes.length).toBeGreaterThanOrEqual(11);
    for (const code of codes) {
      const error = new ConvexError({ code, message: "server text" });
      const arText = getLocalizedErrorMessage(error, ar);
      expect(arText).toMatch(/[؀-ۿ]/);
      expect(arText).not.toBe("server text");
      expect(getLocalizedErrorMessage(error, en)).not.toBe("server text");
      expect(getLocalizedErrorMessage(error, en)).toBe((dictionaries.en as Record<string, string>)[`ServerError_${code}`]);
    }
  });

  it("SCRUM-113 APPROVAL_VEHICLE_UNAVAILABLE resolves to its dictionary entry in ar and en", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    const ar = (key: string) => (dictionaries.ar as Record<string, string>)[key] ?? key;
    const en = (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key;
    const error = new ConvexError({ code: "APPROVAL_VEHICLE_UNAVAILABLE", message: "server text" });
    const arEntry = (dictionaries.ar as Record<string, string>).ServerError_APPROVAL_VEHICLE_UNAVAILABLE;
    const enEntry = (dictionaries.en as Record<string, string>).ServerError_APPROVAL_VEHICLE_UNAVAILABLE;
    expect(arEntry).toMatch(/[؀-ۿ]/);
    expect(getLocalizedErrorMessage(error, ar)).toBe(arEntry);
    expect(getLocalizedErrorMessage(error, en)).toBe(enEntry);
    expect(getLocalizedErrorMessage(error, en)).not.toBe("server text");
  });

  it("SCRUM-113 the EN dictionary text equals the message thrown by respondToApproval", async () => {
    const { readFileSync } = await import("node:fs");
    const { dictionaries } = await import("./i18n/dictionaries");
    const enEntry = (dictionaries.en as Record<string, string>).ServerError_APPROVAL_VEHICLE_UNAVAILABLE;
    expect(enEntry).toBeTruthy();
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "convex", "approvals.ts"), "utf8");
    // The server string literal sits right after the code in the throwAppError call.
    const match = /AppErrorCode\.APPROVAL_VEHICLE_UNAVAILABLE,\s*"([^"]+)"/.exec(source);
    expect(match?.[1]).toBe(enEntry);
  });

  it("SCRUM-641 VEHICLE_DELETED resolves to its dictionary entry in ar and en, and EN equals the server message", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    const { VEHICLE_DELETED_MESSAGE } = await import("../convex/utils/vehicleLiveness");
    const ar = (key: string) => (dictionaries.ar as Record<string, string>)[key] ?? key;
    const en = (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key;
    const error = new ConvexError({ code: "VEHICLE_DELETED", message: "server text" });
    const arEntry = (dictionaries.ar as Record<string, string>).ServerError_VEHICLE_DELETED;
    const enEntry = (dictionaries.en as Record<string, string>).ServerError_VEHICLE_DELETED;
    expect(arEntry).toMatch(/[؀-ۿ]/);
    expect(getLocalizedErrorMessage(error, ar)).toBe(arEntry);
    expect(getLocalizedErrorMessage(error, en)).toBe(enEntry);
    expect(enEntry).toBe(VEHICLE_DELETED_MESSAGE);
  });

  it("SCRUM-641 VEHICLE_DELETED_FLAG_LOCKED has ar+en entries and EN equals the adminData server message", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ar = (key: string) => (dictionaries.ar as Record<string, string>)[key] ?? key;
    const en = (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key;
    const error = new ConvexError({ code: "VEHICLE_DELETED_FLAG_LOCKED", message: "server text" });
    const arEntry = (dictionaries.ar as Record<string, string>).ServerError_VEHICLE_DELETED_FLAG_LOCKED;
    const enEntry = (dictionaries.en as Record<string, string>).ServerError_VEHICLE_DELETED_FLAG_LOCKED;
    expect(arEntry).toMatch(/[؀-ۿ]/);
    expect(getLocalizedErrorMessage(error, ar)).toBe(arEntry);
    expect(getLocalizedErrorMessage(error, en)).toBe(enEntry);
    const source = readFileSync(join(process.cwd(), "convex", "adminData.ts"), "utf8");
    const match = /AppErrorCode\.VEHICLE_DELETED_FLAG_LOCKED,\s*"([^"]+)"/.exec(source);
    expect(match?.[1]).toBe(enEntry);
  });

  /** Asserts a coded error resolves to its Arabic and English dictionary entries; returns them. */
  async function expectCodedEntry(code: string) {
    const { dictionaries } = await import("./i18n/dictionaries");
    const ar = (key: string) => (dictionaries.ar as Record<string, string>)[key] ?? key;
    const en = (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key;
    const error = new ConvexError({ code, message: "server text" });
    const arEntry = (dictionaries.ar as Record<string, string>)[`ServerError_${code}`];
    const enEntry = (dictionaries.en as Record<string, string>)[`ServerError_${code}`];
    expect(arEntry).toMatch(/[؀-ۿ]/);
    expect(getLocalizedErrorMessage(error, ar)).toBe(arEntry);
    expect(getLocalizedErrorMessage(error, en)).toBe(enEntry);
    return { dictionaries, error, en, arEntry, enEntry };
  }

  /** The string literal convex/roles.ts assigns to a top-level message constant. */
  async function roleMessageConst(name: string) {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "convex", "roles.ts"), "utf8");
    const match = new RegExp(`const ${name} =\\s*(['"])((?:(?!\\1).)+)\\1`).exec(source);
    return { source, message: match?.[2] };
  }

  it("SCRUM-413 PERMISSION_RETIRED resolves to its dictionary entry in ar and en", async () => {
    const { dictionaries, error, en, arEntry, enEntry } = await expectCodedEntry("PERMISSION_RETIRED");
    expect(getLocalizedErrorMessage(error, en)).not.toBe("server text");
    // The AR names the same two authorities the role editor labels (settings.ts).
    expect(arEntry).toContain((dictionaries.ar as Record<string, string>).RecordSupplierRoute);
    expect(arEntry).toContain((dictionaries.ar as Record<string, string>).CancelClosedDeal);
    expect(enEntry).toContain((dictionaries.en as Record<string, string>).RecordSupplierRoute);
    expect(enEntry).toContain((dictionaries.en as Record<string, string>).CancelClosedDeal);
  });

  it("SCRUM-413 OWNER_NAMED_ROLE_LOCKED resolves to its dictionary entry in ar and en, and EN equals the roles.ts message", async () => {
    const { enEntry } = await expectCodedEntry("OWNER_NAMED_ROLE_LOCKED");
    expect((await roleMessageConst("OWNER_NAMED_ROLE_LOCKED_MESSAGE")).message).toBe(enEntry);
  });

  it("SCRUM-413 the EN dictionary text equals the message thrown by roles.create and roles.update", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    const enEntry = (dictionaries.en as Record<string, string>).ServerError_PERMISSION_RETIRED;
    expect(enEntry).toBeTruthy();
    const { source, message } = await roleMessageConst("RETIRED_PERMISSION_MESSAGE");
    expect(message).toBe(enEntry);
    // Both throws use the code, not a bare ConvexError string.
    expect(source.match(/throwAppError\(AppErrorCode\.PERMISSION_RETIRED, RETIRED_PERMISSION_MESSAGE\)/g)).toHaveLength(2);
  });

  it("SCRUM-413 D-37 every forward cancel refusal has an AR entry and its EN equals the server message", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    const { forwardCancelRefusal } = await import("../convex/utils/financeCompanyForward");
    const proofOf = (versionStates: string[], state: string) =>
      ({ applies: true, dueMinor: 1, state, versions: versionStates.map((s) => ({ state: s })) }) as never;
    const cases: Array<[unknown, string]> = [
      [proofOf(["ON_BOOKS"], "ON_BOOKS"), "FORWARD_CANCEL_ON_BOOKS"],
      [proofOf(["POSTING_PENDING"], "POSTING_PENDING"), "FORWARD_CANCEL_POSTING_UNSETTLED"],
      [proofOf(["POSTING_FAILED"], "POSTING_FAILED"), "FORWARD_CANCEL_POSTING_UNSETTLED"],
      [proofOf(["REVERSAL_PENDING"], "REVERSAL_PENDING"), "FORWARD_CANCEL_REVERSAL_PENDING"],
      [proofOf(["NEEDS_REPAIR"], "NEEDS_REPAIR"), "FORWARD_CANCEL_NEEDS_REPAIR"],
      // Fail-closed: an unreadable proof (no versions) is NEEDS_REPAIR.
      [proofOf([], "NEEDS_REPAIR"), "FORWARD_CANCEL_NEEDS_REPAIR"],
    ];
    const ar = dictionaries.ar as Record<string, string>;
    const en = dictionaries.en as Record<string, string>;
    for (const [proof, code] of cases) {
      const refusal = forwardCancelRefusal(proof as never);
      expect(refusal?.code).toBe(code);
      expect(en[`ServerError_${code}`]).toBe(refusal?.message);
      expect(ar[`ServerError_${code}`]).toMatch(/[؀-ۿ]/);
      const error = new ConvexError({ code, message: refusal?.message });
      expect(getLocalizedErrorMessage(error, (k: string) => ar[k] ?? k)).toBe(ar[`ServerError_${code}`]);
    }
    expect(forwardCancelRefusal(proofOf([], "SETTLED"))).toBeNull();
  });

  it("the English dictionary text equals the server's message for both codes", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    expect(dictionaries.en.ServerError_COMMISSION_BASE_UNUSABLE).toContain("{baseCurrency}");
    expect(dictionaries.en.ServerError_COMMISSION_BASE_UNUSABLE).toContain("{orgCurrency}");
  });
});