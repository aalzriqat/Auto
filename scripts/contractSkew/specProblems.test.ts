import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { indexSpec, specProblems } from "./specIndex.mjs";
import { validatorProblems, validatorTree } from "./contractTree.mjs";

/**
 * SCRUM-178 v2 F5-1. The spec sanity check rejects only entries this control
 * cannot interpret; every entry kind `convex function-spec` legitimately emits is
 * accepted. A real spec carries `{functionType:"HttpAction", method, path}` for
 * each http.ts route, and refusing those made the monitor UNAVAILABLE on every
 * run.
 */
const callable = (identifier: string, functionType = "Mutation") => ({
  identifier,
  functionType,
  visibility: { kind: "public" },
  args: { type: "object", value: {} },
  returns: { type: "any" },
});
const http = (method: string, path: string) => ({ functionType: "HttpAction", method, path });

describe("specProblems: SPEC-1 (batch 3)", () => {
  const withArgs = (args: unknown) => ({ functions: [{ ...callable("a.js:b"), args }] });
  test("an ABSENT `args` key is a problem; `args: null` is not", () => {
    const { args: _drop, ...noArgs } = callable("a.js:b");
    expect(specProblems({ functions: [noArgs] })).toHaveLength(1);
    expect(specProblems({ functions: [{ ...noArgs, args: null }] })).toEqual([]);
  });
  test("nested malformed validators are problems at any depth", () => {
    expect(specProblems(withArgs({ type: "object", value: { x: { optional: false } } }))).not.toEqual([]);
    expect(
      specProblems(withArgs({ type: "object", value: { x: { fieldType: { type: "array", value: { type: "nope" } }, optional: false } } }))
    ).not.toEqual([]);
    expect(
      specProblems(withArgs({ type: "object", value: { x: { fieldType: { type: "record", keys: { type: "string" }, values: {} }, optional: false } } }))
    ).not.toEqual([]);
  });
  test("unknown functionType and visibility values are problems", () => {
    expect(specProblems({ functions: [{ ...callable("a.js:b"), functionType: "Banana" }] })).not.toEqual([]);
    expect(specProblems({ functions: [{ ...callable("a.js:b"), visibility: { kind: "private" } }] })).not.toEqual([]);
  });
  test("an empty union is a legitimate (unsatisfiable) validator, not a spec problem", () => {
    expect(specProblems(withArgs({ type: "object", value: { x: { fieldType: { type: "union", value: [] }, optional: false } } }))).toEqual([]);
  });
});

describe("L-1 (batch 4): `optional` must be a real boolean at every nesting level", () => {
  const field = (optional: unknown) => ({ fieldType: { type: "string" }, optional });
  const top = (optional: unknown) => ({ type: "object", value: { x: field(optional) } });
  const nested = (optional: unknown) => ({
    type: "object",
    value: { outer: { fieldType: { type: "array", value: { type: "object", value: { x: field(optional) } } }, optional: false } },
  });

  test.each(["false", "true", 0, 1, null, undefined, {}])("a top-level `optional: %j` is a spec problem", (optional) => {
    expect(validatorProblems(top(optional), "w")).not.toEqual([]);
  });
  test.each(["false", "true", 0, 1, null, undefined, {}])("a NESTED `optional: %j` is a spec problem", (optional) => {
    expect(validatorProblems(nested(optional), "w")).not.toEqual([]);
  });
  test("a real boolean is accepted at both levels (control)", () => {
    for (const b of [true, false]) {
      expect(validatorProblems(top(b), "w")).toEqual([]);
      expect(validatorProblems(nested(b), "w")).toEqual([]);
    }
  });
  test("validatorTree does not COERCE it: the string \"false\" must not become optional", () => {
    // Boolean("false") === true would silently turn a REQUIRED field optional, so
    // an omitted required field would stop being reported (a false PASS).
    const tree = validatorTree(top("false")) as { fields: Map<string, { optional: boolean }> };
    expect(tree.fields.get("x")?.optional).toBe(false);
  });
});

describe("specProblems", () => {
  test("a spec with valid HttpAction route entries is accepted", () => {
    const spec = { url: "https://x.convex.cloud", functions: [callable("a.js:b"), http("GET", "/health"), http("POST", "/webhook")] };
    expect(specProblems(spec)).toEqual([]);
  });

  test("every callable kind (Query, Mutation, Action) is accepted", () => {
    const spec = { functions: [callable("a.js:q", "Query"), callable("a.js:m", "Mutation"), callable("a.js:x", "Action")] };
    expect(specProblems(spec)).toEqual([]);
  });

  test("an HttpAction missing `method` or `path` is still a problem", () => {
    expect(specProblems({ functions: [{ functionType: "HttpAction", path: "/x" }] })).toHaveLength(1);
    expect(specProblems({ functions: [{ functionType: "HttpAction", method: "GET" }] })).toHaveLength(1);
    expect(specProblems({ functions: [{ functionType: "HttpAction", method: 7, path: "/x" }] })).toHaveLength(1);
  });

  test("a non-HTTP entry with no `identifier` is still a problem", () => {
    expect(specProblems({ functions: [{ functionType: "Mutation", args: { type: "object", value: {} } }] })).toHaveLength(1);
    expect(specProblems({ functions: [{ method: "GET", path: "/x" }] })).toHaveLength(1);
    expect(specProblems({ functions: [null] })).toHaveLength(1);
  });

  test("a callable entry with a non-object args validator is still a problem", () => {
    const bad = { ...callable("a.js:b"), args: { type: "string" } };
    expect(specProblems({ functions: [bad] })).toHaveLength(1);
  });

  test("CS2-2: a hybrid HttpAction entry carrying an identifier or args is a problem", () => {
    expect(specProblems({ functions: [{ ...http("GET", "/x"), identifier: "a.js:b" }] })).toHaveLength(1);
    expect(specProblems({ functions: [{ ...http("GET", "/x"), args: { type: "object", value: {} } }] })).toHaveLength(1);
  });

  test("CS2-2: a real route entry beside callables stays accepted (control)", () => {
    expect(specProblems({ functions: [callable("a.js:b"), http("GET", "/x")] })).toEqual([]);
  });

  test("CS2-2: duplicate normalized identifiers are a problem", () => {
    expect(specProblems({ functions: [callable("a.js:b"), callable("a.ts:b")] })).toHaveLength(1);
    expect(specProblems({ functions: [callable("a.js:b"), callable("a.js:c")] })).toEqual([]);
  });

  test("CS2-2 (L-1): an entry without visibility makes the document malformed", () => {
    const { visibility: _omit, ...noVisibility } = callable("a.js:b");
    expect(specProblems({ functions: [noVisibility] })).toHaveLength(1);
  });

  test("CS2-2 (M-1): only PUBLIC Query/Mutation/Action entries are indexed", () => {
    const internal = { ...callable("a.js:hidden"), visibility: { kind: "internal" } };
    const index = indexSpec({ functions: [callable("a.js:shown", "Query"), internal, http("GET", "/h")] });
    expect([...index.keys()]).toEqual(["a.js:shown"]);
  });

  test("HttpAction entries are excluded from the argument-contract index", () => {
    const index = indexSpec({ functions: [callable("a.js:b"), http("GET", "/health")] });
    expect([...index.keys()]).toEqual(["a.js:b"]);
  });
});

describe("validatorProblems accepts every validator kind the comparator handles (drift guard)", () => {
  // One node per kind `convex function-spec` renders: EXACTLY the `type` strings of
  // the pinned SDK's `ValidatorJSON` union (validators.ts), read from the installed
  // package below so a kind Convex adds cannot go uncovered. `v.int64()` is
  // rendered `bigint` and `v.float64()` is rendered `number` (VInt64.json /
  // VFloat64.json); there is no `int64` and no `float64` spec type, so those two
  // names are NOT fixtures here and are refused as unknown below (SCRUM-178 v2
  // batch 4, F-1). A kind `validatorTree` / `compareNode` learns to handle that
  // `validatorProblems` does not know would turn every real spec into exit 3.
  const str = { type: "string" };
  const KINDS: Record<string, unknown> = {
    null: { type: "null" },
    number: { type: "number" },
    bigint: { type: "bigint" },
    boolean: { type: "boolean" },
    string: str,
    bytes: { type: "bytes" },
    any: { type: "any" },
    literal: { type: "literal", value: "A" },
    id: { type: "id", tableName: "vehicles" },
    array: { type: "array", value: str },
    object: { type: "object", value: { a: { fieldType: str, optional: false } } },
    record: { type: "record", keys: str, values: { fieldType: str, optional: false } },
    union: { type: "union", value: [str, { type: "null" }] },
  };

  for (const [kind, node] of Object.entries(KINDS)) {
    test(`${kind} is accepted, alone and nested`, () => {
      expect(validatorProblems(node, kind)).toEqual([]);
      expect(validatorProblems({ type: "array", value: node }, kind)).toEqual([]);
      expect(validatorTree(node).kind).toBeDefined();
    });
  }

  test("every fixture kind is a validator type validatorTree names (no stale fixture)", () => {
    for (const [kind, node] of Object.entries(KINDS)) {
      const tree = validatorTree(node) as { kind: string; type?: string };
      // Anything not structural falls to a scalar carrying its own type name.
      if (tree.kind === "scalar") expect(tree.type, kind).toBe((node as { type: string }).type);
    }
  });

  test("a type outside the set is still refused", () => {
    expect(validatorProblems({ type: "decimal128" }, "x")).toEqual(['x: unknown validator type "decimal128"']);
  });

  test("the fixtures cover EVERY ValidatorJSON kind of the pinned convex SDK, no more and no fewer", () => {
    const source = fs.readFileSync(path.resolve("node_modules/convex/src/values/validators.ts"), "utf8");
    const start = source.indexOf("export type ValidatorJSON");
    const end = source.indexOf("export type RecordKeyValidatorJSON");
    expect(start, "ValidatorJSON not found in the pinned SDK").toBeGreaterThan(-1);
    expect(end, "RecordKeyValidatorJSON not found in the pinned SDK").toBeGreaterThan(start);
    const emitted = [...new Set([...source.slice(start, end).matchAll(/type: "([A-Za-z0-9]+)"/g)].map((m) => m[1]))].sort();
    expect(emitted.length).toBeGreaterThan(10);
    expect(Object.keys(KINDS).sort()).toEqual(emitted);
  });

  test.each(["int64", "float64"])("`%s` is not a ValidatorJSON type, so a spec carrying it is a spec problem", (type) => {
    expect(validatorProblems({ type }, "x")).toEqual([`x: unknown validator type "${type}"`]);
    expect(specProblems({ functions: [{ ...callable("a.js:b"), args: { type: "object", value: { n: { fieldType: { type }, optional: false } } } }] })).not.toEqual([]);
  });
});
