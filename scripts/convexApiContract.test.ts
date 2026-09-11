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
import os from "node:os";
import {
  findBrokenReferences,
  referencePaths,
  checkReference,
  findDuplicateReferences,
} from "./convexApiContract";

const REPO_ROOT = path.resolve(__dirname, "..");
const CONVEX_ROOT = path.join(REPO_ROOT, "convex");
const CONTRACT = path.join(REPO_ROOT, "apps", "mobile", "src", "convexApi.ts");

/**
 * Pinned so a future change to the extraction cannot quietly shrink what is
 * checked. The previous regex silently covered only 123 of these. If a real
 * change moves this number, update it in the same commit — deliberately.
 */
// Moved 193→194 by `tasks:softDelete`, the mobile binding for the new task
// delete path. Coverage going up: one more real reference is now checked
// against the backend, and nothing moved out of the extraction.
//
// Moved 194→195 by `search:globalSearch`, bound into the mobile contract for
// the dealer home screen's workspace search. Same story: the query already
// existed in `convex/search.ts`, so this is one more real reference now
// checked against the backend, with nothing dropped from the extraction.
//
// Moved 195→192 by SCRUM-53 stage 53-A, which retires the mobile client's
// `transactions:add`, `transactions:update` and `transactions:remove`
// references. This is the one direction the pin usually guards against — a
// count going DOWN — so it is deliberate and it is the point of the change:
// `transactions` is the operational cash-movement projection, not the General
// Ledger, and a phone must not hold a write reference to it. The backend still
// exports all three during 53-A for installed-client compatibility; 53-B
// retires those. Measured by running this suite, not by subtracting three.
const EXPECTED_REFERENCE_COUNT = 192;

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

  test("reads a wrapped declaration whose argument carries a trailing comma", () => {
    // Prettier's output for any declaration long enough to wrap. 70 of the 193
    // real ones look like this, and all 70 were being skipped.
    const source = `
    isSuperAdmin: makeFunctionReference<"query", Record<string, never>, boolean>(
      "adminAuth:isSuperAdmin",
    ),
    getMe: makeFunctionReference<"query", Record<string, never>, MobileUser>("users:getMe"),
`;
    expect(referencePaths(source)).toEqual(["adminAuth:isSuperAdmin", "users:getMe"]);
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

  test("accepts the LAST export in a module", () => {
    // Regression: a `\Z` lookahead (not a thing in JS) meant the final export in
    // a file never matched and was reported missing.
    expect(checkReference(CONVEX_ROOT, "marketplaceTradeIns:declineOfferByPublicId")).toBeNull();
  });

  test("rejects an export that is only present inside a block comment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convex-contract-"));
    fs.writeFileSync(
      path.join(dir, "ghost.ts"),
      ["/*", "export const ghostFn = query({});", "*/", "export const realFn = query({});", ""].join("\n")
    );
    expect(checkReference(dir, "ghost:ghostFn")).toMatchObject({ reason: "export-missing" });
    expect(checkReference(dir, "ghost:realFn")).toBeNull();
  });

  test("rejects a reference to an internal-only function", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convex-contract-"));
    fs.writeFileSync(
      path.join(dir, "priv.ts"),
      ["export const hidden = internalMutation({});", "export const open = mutation({});", ""].join("\n")
    );
    // Exists and is exported, but no client can call it — it would fail on a device.
    expect(checkReference(dir, "priv:hidden")).toMatchObject({ reason: "not-client-reachable" });
    expect(checkReference(dir, "priv:open")).toBeNull();
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

  // The count alone is not enough. The extractor's real failure mode is
  // duplication, not loss: a declaration whose own argument is skipped picks up
  // the next one's string, so the length stays exactly right while a third of
  // the surface goes unchecked. That is precisely what shipped.
  test("every declaration yields its own reference, with no duplicates", () => {
    const references = referencePaths(contractSource);
    expect(findDuplicateReferences(references)).toEqual([]);
    expect(new Set(references).size).toBe(EXPECTED_REFERENCE_COUNT);
  });

  test("no mobile screen calls a function that is not on the backend", () => {
    const broken = findBrokenReferences(contractSource, CONVEX_ROOT);
    const report = broken.map((b) => `  ${b.reference} → ${b.reason} (${b.expectedModule})`).join("\n");
    expect(broken, `Mobile declares backend functions that do not exist:\n${report}`).toEqual([]);
  });
});

/**
 * SCRUM-53 stage 53-A deliberately leaves the two sides asymmetric for one
 * release: the client stops asking, the backend keeps answering. An installed
 * APK addresses Convex by string name, so retiring the backend mutations in the
 * same release would break every phone that has not yet taken the read-only
 * build. This asserts the asymmetry in both directions, so neither half can
 * drift out of the staged order unnoticed.
 */
describe("SCRUM-53 stage 53-A — client retired the cashbook writes, backend has not", () => {
  const contractSource = fs.readFileSync(CONTRACT, "utf8");
  const backendSource = fs.readFileSync(path.join(CONVEX_ROOT, "transactions.ts"), "utf8");

  test.each(["transactions:add", "transactions:update", "transactions:remove"])(
    "the mobile contract emits no %s reference",
    (reference) => {
      // The string is what a build actually sends, so the source string — not
      // only the typed surface — has to be gone.
      expect(contractSource).not.toContain(reference);
    },
  );

  test("the mobile contract keeps the read projection", () => {
    expect(referencePaths(contractSource)).toContain("transactions:list");
  });

  test.each(["add", "update", "remove"])(
    "the backend still exports transactions:%s for installed clients",
    (name) => {
      // If this fails because the export is gone, 53-B landed before the
      // read-only client shipped. The ordering is the defect, not this test.
      expect(checkReference(CONVEX_ROOT, `transactions:${name}`)).toBeNull();
      expect(backendSource).toMatch(new RegExp(`^export const ${name} = mutation\\(`, "m"));
    },
  );
});
