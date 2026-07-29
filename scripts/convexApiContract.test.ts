/**
 * The mobile → backend contract, enforced in CI.
 *
 * `apps/**` is excluded from the root lint, typecheck, and test runs, so a
 * mobile call to a backend function that does not exist has no gate anywhere
 * between the editor and a user's phone. This test closes that: it lives under
 * `scripts/`, which the root vitest run does cover, and reads both sides.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { findBrokenReferences, referencePaths, checkReference } from "./convexApiContract";

const REPO_ROOT = path.resolve(__dirname, "..");
const CONVEX_ROOT = path.join(REPO_ROOT, "convex");
const CONTRACT = path.join(REPO_ROOT, "apps", "mobile", "src", "convexApi.ts");

/**
 * Pinned so a future change to the extraction cannot quietly shrink what is
 * checked. The previous regex silently covered only 123 of these. If a real
 * change moves this number, update it in the same commit — deliberately.
 */
const EXPECTED_REFERENCE_COUNT = 193;

describe("mobile convexApi contract extraction", () => {
  test("reads the reference out of a multi-line declaration with nested generics", () => {
    const source = `
    acceptOfferByPublicId: makeFunctionReference<
      "mutation",
      BuyerTradeInStatusArgs,
      Record<string, Array<{ id: string }>>
    >("marketplaceTradeIns:acceptOfferByPublicId"),
`;
    expect(referencePaths(source)).toEqual(["marketplaceTradeIns:acceptOfferByPublicId"]);
  });

  test("reads a single-line declaration", () => {
    const source = `saveQuote: makeFunctionReference<"mutation", QuoteSaveArgs, string>("quotes:saveQuote"),`;
    expect(referencePaths(source)).toEqual(["quotes:saveQuote"]);
  });

  test("reports a function that does not exist on the backend", () => {
    expect(checkReference(CONVEX_ROOT, "marketplaceTradeIns:noSuchFunction")).toEqual({
      reference: "marketplaceTradeIns:noSuchFunction",
      reason: "export-missing",
      expectedModule: "convex/marketplaceTradeIns.ts",
    });
  });

  test("reports a module that does not exist on the backend", () => {
    expect(checkReference(CONVEX_ROOT, "noSuchModule:anything")).toEqual({
      reference: "noSuchModule:anything",
      reason: "module-missing",
      expectedModule: "convex/noSuchModule.ts",
    });
  });

  test("accepts a function that does exist", () => {
    expect(checkReference(CONVEX_ROOT, "quotes:saveQuote")).toBeNull();
  });

  // Both of these would otherwise resolve to a real export and pass while the
  // mobile binding is broken: split(":") drops the trailing segment, and an
  // unescaped function segment goes straight into a RegExp.
  test.each(["quotes:saveQuote:stale", "quotes:.+", "quotes:", ":saveQuote", "quotes"])(
    "rejects the malformed reference %s",
    (reference) => {
      expect(checkReference(CONVEX_ROOT, reference)).toMatchObject({
        reference,
        reason: "malformed-reference",
      });
    }
  );
});

describe("every backend function the mobile app declares exists", () => {
  const contractSource = fs.readFileSync(CONTRACT, "utf8");

  test("the whole contract surface is covered, not a subset of it", () => {
    expect(referencePaths(contractSource)).toHaveLength(EXPECTED_REFERENCE_COUNT);
  });

  test("no mobile screen calls a function that is not on the backend", () => {
    const broken = findBrokenReferences(contractSource, CONVEX_ROOT);
    const report = broken.map((b) => `  ${b.reference} → ${b.reason} (${b.expectedModule})`).join("\n");
    expect(broken, `Mobile declares backend functions that do not exist:\n${report}`).toEqual([]);
  });
});
