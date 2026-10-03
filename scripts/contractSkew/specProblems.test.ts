import { describe, expect, test } from "vitest";
import { indexSpec, specProblems } from "./specIndex.mjs";

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
