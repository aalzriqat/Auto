import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { changedContractPaths } from "./specDiff.mjs";
import { fetchDeployedSpec, readSpecFile, redact } from "./fetchSpec.mjs";
import { blockersForRelease } from "./compare.mjs";
import { unscannedConvexClients } from "./clientFiles.mjs";

/**
 * The release blocker is path-sensitive, which is only worth anything if the
 * changed paths are DERIVED rather than typed in by whoever opened the PR.
 * These pin the derivation.
 */

const fn = (identifier: string, fields: Record<string, unknown>) => ({
  identifier,
  functionType: "Mutation",
  args: { type: "object", value: fields },
});
const required = (fieldType: unknown) => ({ fieldType, optional: false });
const optional = (fieldType: unknown) => ({ fieldType, optional: true });
const str = { type: "string" };
const spec = (...functions: unknown[]) => ({ url: "https://x.convex.cloud", functions });

describe("changedContractPaths", () => {
  test("identical specs change nothing", () => {
    const a = spec(fn("vehicles.js:importBulk", { orgId: required(str) }));
    expect(changedContractPaths(a, structuredClone(a))).toEqual([]);
  });

  test("an added field is PATH_ADDED", () => {
    const before = spec(fn("vehicles.js:importBulk", { orgId: required(str) }));
    const after = spec(
      fn("vehicles.js:importBulk", { orgId: required(str), importId: optional(str) })
    );
    const changes = changedContractPaths(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      identifier: "vehicles:importBulk",
      path: "importId",
      change: "PATH_ADDED",
    });
  });

  test("a removed field is PATH_REMOVED — the direction that breaks a deployed client", () => {
    const before = spec(
      fn("vehicles.js:importBulk", { orgId: required(str), importId: optional(str) })
    );
    const after = spec(fn("vehicles.js:importBulk", { orgId: required(str) }));
    expect(changedContractPaths(before, after)[0]).toMatchObject({
      path: "importId",
      change: "PATH_REMOVED",
    });
  });

  test("tightening optional to required is a redeclaration, not a no-op", () => {
    const before = spec(fn("x.js:y", { a: optional(str) }));
    const after = spec(fn("x.js:y", { a: required(str) }));
    const [change] = changedContractPaths(before, after);
    expect(change.change).toBe("PATH_REDECLARED");
    expect(change.deployed).toContain("opt");
    expect(change.candidate).toContain("req");
  });

  test("a literal union that gains a member is a change — 'both are strings' is not enough", () => {
    // The accepted-value set is the whole point of a literal union. Comparing
    // only the coarse type would call CASH|FINANCE and CASH|FINANCE|ESCROW the
    // same contract.
    const union = (...values: string[]) => ({
      type: "union",
      value: values.map((value) => ({ type: "literal", value })),
    });
    const before = spec(fn("m.js:createRequest", { paymentType: required(union("CASH", "FINANCE")) }));
    const after = spec(
      fn("m.js:createRequest", { paymentType: required(union("CASH", "FINANCE", "ESCROW")) })
    );
    expect(changedContractPaths(before, after)[0]).toMatchObject({
      path: "paymentType",
      change: "PATH_REDECLARED",
    });
  });

  test("a literal that changes TYPE is a change, even with the same text", () => {
    // `.map(String)` alone rendered v.literal(1) and v.literal("1") identically,
    // so a backend swapping one for the other produced NO detected change: the
    // release gate had nothing to block on, and production mode filed the
    // resulting break as a standing defect rather than the revision skew it is.
    const before = spec(fn("x.js:y", { v: required({ type: "literal", value: 1 }) }));
    const after = spec(fn("x.js:y", { v: required({ type: "literal", value: "1" }) }));
    const changes = changedContractPaths(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].change).toBe("PATH_REDECLARED");
  });

  test("a nested array-element field is reported as vehicles[*].rowId", () => {
    // The named counterexample for regex matching: the path that matters is not
    // a top-level identifier and cannot be recovered by pattern-matching text.
    const rows = (fields: Record<string, unknown>) => ({
      type: "array",
      value: { type: "object", value: fields },
    });
    const before = spec(fn("vehicles.js:importBulk", { vehicles: required(rows({ vin: required(str) })) }));
    const after = spec(
      fn("vehicles.js:importBulk", {
        vehicles: required(rows({ vin: required(str), rowId: optional({ type: "number" }) })),
      })
    );
    const paths = changedContractPaths(before, after).map((c) => c.path);
    expect(paths).toContain("vehicles[*].rowId");
  });

  test("a new function contributes every path it declares", () => {
    const before = spec();
    const after = spec(fn("brand.js:new", { orgId: required(str), note: optional(str) }));
    const changes = changedContractPaths(before, after);
    expect(changes.map((c) => c.path).sort()).toEqual(["note", "orgId"]);
    expect(changes.every((c) => c.change === "FUNCTION_ADDED")).toBe(true);
  });

  test("a required->optional flip INSIDE an optional parent is a change", () => {
    /**
     * ⚠️ THE DEFECT THAT ENDED THE FLAT MODEL. `declaredPaths` grew a
     * `requiredWithinParent` dimension to fix a comparison defect, and this
     * module's signature was never taught about it — so this exact diff
     * returned `[]`. With no changed path, `classifyBreaking` had no evidence
     * of a backend change and filed a real, undeployed revision skew as a
     * STANDING DEFECT: "deploying will not fix this", when deploying was the
     * whole fix.
     *
     * Two consumers of one flat record and only one updated, twice over. A node
     * signature cannot carry that gap: requiredness lives ON the field.
     */
    const nested = (bioOptional: boolean) =>
      fn("w.js:save", {
        profile: {
          optional: true,
          fieldType: {
            type: "object",
            value: { bio: { fieldType: { type: "string" }, optional: bioOptional } },
          },
        },
      });
    const changes = changedContractPaths(spec(nested(false)), spec(nested(true)));
    expect(changes.map((c) => c.path)).toEqual(["profile.bio"]);
    expect(changes[0].change).toBe("PATH_REDECLARED");
    expect(changes[0].deployed).toContain("req");
    expect(changes[0].candidate).toContain("opt");
  });

  test("removing a branch from a union IS a redeclaration", () => {
    // The accepted value set is the contract. A backend narrowing
    // `v.union(v.literal("A"), v.literal("B"))` to just `"A"` refuses payloads
    // it used to accept, and a signature that only counted the node's KIND
    // would report no change at all — leaving the resulting break to be filed
    // as a standing defect rather than the skew it is.
    const withBranches = (values: string[]) =>
      fn("w.js:save", {
        status: {
          optional: false,
          fieldType: { type: "union", value: values.map((v) => ({ type: "literal", value: v })) },
        },
      });
    const changes = changedContractPaths(spec(withBranches(["A", "B"])), spec(withBranches(["A"])));
    expect(changes.map((c) => c.path)).toEqual(["status"]);
    expect(changes[0].change).toBe("PATH_REDECLARED");
    expect(changes[0].deployed).toContain("B");
    expect(changes[0].candidate).not.toContain("B");
  });

  test("a field added to ONE branch of a union is a change", () => {
    /**
     * ⚠️ THIS TEST REPLACES A VACUOUS ONE, and the story is worth keeping.
     *
     * Round 1 found that merging union branches into a SET hid a change, and I
     * fixed it by making the union's digest POSITIONAL. The regression test I
     * wrote to prove that fix used a fixture where `y` moved from branch A to
     * branch B — and round 2 showed that transformation is SEMANTICALLY INERT.
     * Convex accepts a union if ANY branch matches, so the accepted-shape
     * multiset `{ {x}, {x,y} }` is identical before and after. The test passed
     * by asserting a difference in ORDER, which is not a contract at all.
     *
     * So the fix was wrong in the other direction: a pure reorder produced a
     * spurious changed path, which `classifyBreaking` promotes to
     * REVISION_SKEW for any finding sharing that path — telling a responder to
     * deploy when deploying fixes nothing.
     *
     * The fixture below is genuinely ASYMMETRIC: one branch gains a field and
     * the other is untouched, so the set of payloads the union accepts really
     * does change.
     */
    const branches = (withY: boolean) =>
      fn("w.js:save", {
        payload: {
          optional: false,
          fieldType: {
            type: "union",
            value: [
              {
                type: "object",
                value: {
                  x: { fieldType: { type: "string" }, optional: false },
                  ...(withY ? { y: { fieldType: { type: "number" }, optional: false } } : {}),
                },
              },
              { type: "object", value: { q: { fieldType: { type: "number" }, optional: false } } },
            ],
          },
        },
      });
    const changes = changedContractPaths(spec(branches(false)), spec(branches(true)));
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((c) => c.path === "payload" || c.path === "payload.y")).toBe(true);
  });

  test("REGROUPING fields across branches is a change the path walk alone cannot see", () => {
    /**
     * Surfaced by a surviving mutant: replacing the union digest with a
     * constant left every test green, because the other cases are ALSO caught
     * by the per-path recursion (a new field creates a new path). This is the
     * case only the digest can catch.
     *
     *   before   union( {x}, {y} )      accepts {x} or {y}, never {x,y}
     *   after    union( {x,y}, {} )     accepts {x,y} or {} , never {x} alone
     *
     * The set of declared PATHS is identical (`payload.x`, `payload.y`) and so
     * is each path's merged signature — only the branch grouping moved, and
     * that grouping is exactly what decides which payloads Convex accepts.
     */
    const grouped = (together: boolean) => {
      const x = { fieldType: { type: "string" }, optional: false };
      const y = { fieldType: { type: "number" }, optional: false };
      return fn("w.js:save", {
        payload: {
          optional: false,
          fieldType: {
            type: "union",
            value: together
              ? [{ type: "object", value: { x, y } }, { type: "object", value: {} }]
              : [{ type: "object", value: { x } }, { type: "object", value: { y } }],
          },
        },
      });
    };
    const changes = changedContractPaths(spec(grouped(false)), spec(grouped(true)));
    expect(changes.length, "a real regrouping went undetected").toBeGreaterThan(0);
    expect(changes.some((c) => c.path === "payload")).toBe(true);
  });

  test("a literal value cannot FORGE a different branch structure", () => {
    /**
     * Found independently by me and by the Claude-family reviewer in the same
     * round. Branch digests used to be joined with `|` and literal values
     * interpolated raw, so a literal could embed the delimiters and produce a
     * digest byte-identical to a genuinely different union:
     *
     *   union([ literal("A)}|{y:s(number") ])
     *   union([ {x: literal("A")}, {y: number} ])
     *
     * The redeclaration was still caught then, but only because `collect`
     * records each path's own signature separately and that independent signal
     * differed. "Safe because a second mechanism happens to overlap" is not a
     * property to rely on — a refactor removing the redundancy as dead weight
     * would make it exploitable silently. The encoding is JSON now, so the
     * guarantee stands on its own.
     */
    const real = fn("w.js:save", {
      p: { optional: false, fieldType: { type: "union", value: [
        { type: "object", value: { x: { fieldType: { type: "literal", value: "A" }, optional: false } } },
        { type: "object", value: { y: { fieldType: { type: "number" }, optional: false } } },
      ] } },
    });
    const forgeWith = (value: string) =>
      fn("w.js:save", {
        p: { optional: false, fieldType: { type: "union", value: [
          { type: "object", value: { x: { fieldType: { type: "literal", value }, optional: false } } },
        ] } },
      });

    // ⚠️ ONE PAYLOAD PER PLAUSIBLE ENCODING, not one per encoding we happen to
    // use. A surviving mutant showed the first version of this test only closed
    // the `|`-joined forgery it was crafted against: swap the encoding for a
    // comma-joined one and the same test passed while the hole reopened. Each
    // value below is crafted to forge a DIFFERENT joining scheme.
    const forgeries: Array<[string, string]> = [
      ["pipe-joined", "A)}|{y:s(number"],
      ["comma-joined", "A,o,y,false,s,number"],
      ["colon-joined", "A:o:y:false:s:number"],
      ["quote-escaping", 'A","o","y","false","s","number'],
    ];
    for (const [label, value] of forgeries) {
      const changes = changedContractPaths(spec(forgeWith(value)), spec(real));
      // The UNION NODE itself must see it, not merely the paths below it.
      expect(changes.some((c) => c.path === "p"), `${label} forgery was not detected at the union node`).toBe(true);
    }
  });

  test("literals containing the old delimiters are still compared by VALUE", () => {
    const withValue = (v: string) =>
      fn("w.js:save", { s: { optional: false, fieldType: { type: "literal", value: v } } });
    expect(changedContractPaths(spec(withValue("a|b")), spec(withValue("a|b")))).toEqual([]);
    expect(changedContractPaths(spec(withValue("a|b")), spec(withValue("a|c"))).length).toBeGreaterThan(0);
  });

  test("a pure REORDER of union branches is NOT a change", () => {
    /**
     * The other half, and the one that was missing. Branch position affects
     * nothing about which payloads Convex accepts, so reporting a reorder as a
     * redeclaration manufactures evidence of a backend change that did not
     * happen — and manufactured evidence is what turns a standing product
     * defect into "deploy and this goes away".
     */
    const ordered = (aFirst: boolean) => {
      const a = { type: "object", value: { a: { fieldType: { type: "string" }, optional: false } } };
      const b = { type: "object", value: { b: { fieldType: { type: "number" }, optional: false } } };
      return fn("w.js:save", {
        payload: { optional: false, fieldType: { type: "union", value: aFirst ? [a, b] : [b, a] } },
      });
    };
    expect(changedContractPaths(spec(ordered(true)), spec(ordered(false)))).toEqual([]);
  });

  test("swapping which branch holds a field is inert, and reported as inert", () => {
    // The exact fixture the replaced test used. Kept deliberately, with the
    // opposite expectation, so nobody re-derives the original mistake.
    const swapped = (yInFirst: boolean) => {
      const withY = { type: "object", value: {
        x: { fieldType: { type: "string" }, optional: false },
        y: { fieldType: { type: "number" }, optional: false } } };
      const withoutY = { type: "object", value: { x: { fieldType: { type: "string" }, optional: false } } };
      return fn("w.js:save", {
        payload: { optional: false, fieldType: { type: "union", value: yInFirst ? [withY, withoutY] : [withoutY, withY] } },
      });
    };
    expect(changedContractPaths(spec(swapped(true)), spec(swapped(false)))).toEqual([]);
  });

  test("the digest describes every node kind, not just objects", () => {
    /**
     * The union digest is what makes a branch move visible, and it is only as
     * good as its coverage of the node kinds it can meet. Each of these is a
     * distinct arm: change what is inside a branch and the signature must move.
     */
    const branchWith = (inner: unknown) =>
      fn("w.js:save", {
        payload: {
          optional: false,
          fieldType: { type: "union", value: [{ type: "object", value: { v: { fieldType: inner, optional: false } } }, { type: "null" }] },
        },
      });

    const kinds: Array<[string, unknown, unknown]> = [
      ["array element", { type: "array", value: { type: "string" } }, { type: "array", value: { type: "number" } }],
      ["literal value", { type: "literal", value: "A" }, { type: "literal", value: "B" }],
      ["scalar type", { type: "string" }, { type: "number" }],
      ["id table", { type: "id", tableName: "vehicles" }, { type: "id", tableName: "customers" }],
      ["a dynamic field becoming concrete", { type: "any" }, { type: "string" }],
    ];

    for (const [label, before, after] of kinds) {
      const changes = changedContractPaths(spec(branchWith(before)), spec(branchWith(after)));
      expect(changes.length, `${label} produced no change`).toBeGreaterThan(0);
    }
  });

  test("a literal type change inside a union is not hidden by the merge", () => {
    // `v.literal(1)` and `v.literal("1")` are different contracts; the digest is
    // type-tagged so the two cannot render identically.
    const withLiteral = (value: unknown) =>
      fn("w.js:save", {
        status: {
          optional: false,
          fieldType: { type: "union", value: [{ type: "literal", value }, { type: "null" }] },
        },
      });
    const changes = changedContractPaths(spec(withLiteral(1)), spec(withLiteral("1")));
    expect(changes.length).toBeGreaterThan(0);
  });

  test("a no-argument function still records that it appeared", () => {
    // Otherwise it changes zero paths and vanishes from the report entirely.
    const before = spec();
    const after = spec(fn("brand.js:ping", {}));
    expect(changedContractPaths(before, after)).toEqual([
      { identifier: "brand:ping", path: "", change: "FUNCTION_ADDED", deployed: null, candidate: null },
    ]);
  });

  test("a .js/.ts identifier difference is not a contract change", () => {
    // Specs render `vehicles.js:importBulk`; comparing raw identifiers would
    // report every function as simultaneously added and removed.
    const before = spec(fn("vehicles.js:importBulk", { orgId: required(str) }));
    const after = spec(fn("vehicles.ts:importBulk", { orgId: required(str) }));
    expect(changedContractPaths(before, after)).toEqual([]);
  });
});

describe("release blocking uses derived paths", () => {
  const result = {
    breaking: [],
    needsEvidence: [
      { identifier: "vehicles:importBulk", path: "vehicles[*].valuations", severity: "SHAPE_UNKNOWN" },
      { identifier: "vehicles:importBulk", path: "vehicles[*].make", severity: "TYPE_UNKNOWN" },
    ],
  };

  test("a derived change intersecting an unknown blocks", () => {
    const before = spec(
      fn("vehicles.js:importBulk", {
        vehicles: required({ type: "array", value: { type: "object", value: { make: required(str) } } }),
      })
    );
    const after = spec(
      fn("vehicles.js:importBulk", {
        vehicles: required({
          type: "array",
          value: { type: "object", value: { make: optional(str) } },
        }),
      })
    );
    const blockers = blockersForRelease(result, changedContractPaths(before, after));
    expect(blockers.blocked).toBe(true);
    expect(blockers.intersectingUnknowns.map((f: { path: string }) => f.path)).toEqual([
      "vehicles[*].make",
    ]);
  });

  test("a derived change on the same function but a sibling path does NOT block", () => {
    // Function-sensitivity would block here; path-sensitivity must not.
    const before = spec(fn("vehicles.js:importBulk", { orgId: required(str) }));
    const after = spec(
      fn("vehicles.js:importBulk", { orgId: required(str), importId: optional(str) })
    );
    const blockers = blockersForRelease(result, changedContractPaths(before, after));
    expect(blockers.blocked).toBe(false);
    expect(blockers.unrelatedUnknowns).toBe(2);
  });
});

describe("fetchDeployedSpec refuses the wrong deployment", () => {
  const tmp: string[] = [];
  const writeSpec = (url: string) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skew-")), "spec.json");
    fs.writeFileSync(file, JSON.stringify({ url, functions: [] }));
    tmp.push(file);
    return file;
  };
  afterEach(() => {
    for (const file of tmp.splice(0)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  test("a spec from another deployment is refused, not reported on", () => {
    // A preview key makes every Convex command address a preview deployment. A
    // control that verified one would report success about a backend no user is
    // served by — the 2026-08-07 targeting error wearing a monitoring badge.
    const file = writeSpec("https://some-other-deployment.convex.cloud");
    expect(() => fetchDeployedSpec({ specFile: file, expectedDeployment: "kindly-hound-172" })).toThrow(
      /some-other-deployment/
    );
  });

  test("the expected deployment is accepted", () => {
    const file = writeSpec("https://kindly-hound-172.convex.cloud");
    const got = fetchDeployedSpec({ specFile: file, expectedDeployment: "kindly-hound-172" });
    if (!got.ok) throw new Error("expected the spec to be accepted");
    expect(got.rung).toBe("SUPPLIED_FILE");
  });

  test("no credential yields UNAVAILABLE, never a pass", () => {
    const saved = {
      read: process.env.CONVEX_PROD_READ_KEY,
      operator: process.env.CONVEX_PROD_OPERATOR_KEY,
    };
    delete process.env.CONVEX_PROD_READ_KEY;
    delete process.env.CONVEX_PROD_OPERATOR_KEY;
    try {
      const got = fetchDeployedSpec({});
      if (got.ok) throw new Error("expected UNAVAILABLE with no credential");
      expect(got.unavailable).toBe(true);
      // Every rung must say why it was not used, so "no result" is never
      // mistakable for "nothing to report".
      expect(got.tried).toHaveLength(3);
    } finally {
      if (saved.read) process.env.CONVEX_PROD_READ_KEY = saved.read;
      if (saved.operator) process.env.CONVEX_PROD_OPERATOR_KEY = saved.operator;
    }
  });
});

describe("nothing credential-shaped reaches a log", () => {
  // The scheduled job runs in GitHub Actions on a PUBLIC repository, so
  // everything it prints is published — and the Convex CLI echoes
  // credential-derived material back in errors.
  test("an exact credential value we passed is removed", () => {
    const saved = process.env.CONVEX_PROD_READ_KEY;
    process.env.CONVEX_PROD_READ_KEY = "prod:kindly-hound-172|SuperSecretValue123";
    try {
      expect(redact("convex failed using prod:kindly-hound-172|SuperSecretValue123 oops")).toBe(
        "convex failed using [REDACTED] oops"
      );
    } finally {
      if (saved) process.env.CONVEX_PROD_READ_KEY = saved;
      else delete process.env.CONVEX_PROD_READ_KEY;
    }
  });

  test("a key we never supplied is removed by shape alone", () => {
    // e.g. one the CLI read from a config file we did not write.
    expect(redact("using dev:some-deployment|AAAABBBBCCCCDDDD now")).toContain("[REDACTED]");
    expect(redact("using dev:some-deployment|AAAABBBBCCCCDDDD now")).not.toContain("AAAABBBB");
  });

  test("it does NOT eat a literal-union signature", () => {
    // An over-eager redactor destroys the diagnostic the tool exists to
    // produce. A validator signature is pipe-joined and must survive.
    const signature = "union:req:OPENING_STOCK|SOMETHINGLONGENOUGH";
    expect(redact(signature)).toBe(signature);
  });

  test("ordinary findings are untouched", () => {
    expect(redact("vehicles[*].rowId is unproven")).toBe("vehicles[*].rowId is unproven");
  });
});

describe("a spec may only be read from a bounded location", () => {
  test("an existing path outside the workspace and temp directory is refused", () => {
    // This runs unattended and is invoked by agents as well as people. The home
    // directory exists on every platform CI and this workstation run on, and is
    // outside both the workspace and the temp directory.
    expect(() => fetchDeployedSpec({ specFile: os.homedir() })).toThrow(/Refusing to read a spec/);
  });

  test("the shared reader bounds EVERY spec path, not just the live one", () => {
    // ⚠️ `--current` and `--candidate` originally read their files with a bare
    // fs.readFileSync, so bounding only the live spec left the same door open
    // twice more. One exported reader means one place the rule lives.
    expect(() => readSpecFile(os.homedir())).toThrow(/Refusing to read a spec/);
  });

  test("a path that does not exist is refused too, with a different reason", () => {
    // ⚠️ Canonicalizing through symlinks means the bounds check now needs the
    // file to exist, so this no longer reports "outside the workspace". Both
    // refusals are pinned because the distinction is easy to lose in a later
    // refactor, and only one of them is about location.
    const missing = path.resolve(os.homedir(), "definitely-not-a-workspace-spec.json");
    expect(() => fetchDeployedSpec({ specFile: missing })).toThrow(/No readable spec file/);
  });
});

describe("a new client surface cannot appear unnoticed", () => {
  // ⚠️ apps/mobile was invisible to this control until someone happened to
  // look. A hand-maintained list of "things we do not scan" is only correct on
  // the day it is written, so the answer is DERIVED by walking the repository.
  const roots: string[] = [];
  const makeRepo = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surfaces-"));
    roots.push(dir);
    for (const [name, body] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    return dir;
  };
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an unscanned file calling Convex from a client is reported", () => {
    const dir = makeRepo({
      "apps/newthing/Screen.tsx": "const x = useQuery(api.a.b, {});",
    });
    expect(unscannedConvexClients(dir, [])).toEqual([{ file: "apps/newthing/Screen.tsx" }]);
  });

  test("the same file is not reported once it has been scanned", () => {
    const dir = makeRepo({
      "apps/newthing/Screen.tsx": "const x = useQuery(api.a.b, {});",
    });
    const scanned = [path.join(dir, "apps/newthing/Screen.tsx")];
    expect(unscannedConvexClients(dir, scanned)).toEqual([]);
  });

  test("a Convex-to-Convex call is not a client surface", () => {
    // Caller and callee ship in one `convex deploy`, so it cannot skew at all.
    const dir = makeRepo({
      "packages/server/thing.ts": "await ctx.runMutation(internal.a.b, {});",
    });
    expect(unscannedConvexClients(dir, [])).toEqual([]);
  });

  test("this tool's own fixtures are not reported as a client surface", () => {
    // The derived scan first accused scripts/contractSkew/__fixtures__ — a
    // control reporting itself as an unscanned production client.
    const dir = makeRepo({
      "scripts/contractSkew/__fixtures__/x.tsx": "const x = useQuery(api.a.b, {});",
    });
    expect(unscannedConvexClients(dir, [])).toEqual([]);
  });
});

describe("an unscanned client file fails the run rather than passing it", () => {
  /**
   * ⚠️ It used to exit 0. `unscannedConvexClients` forced the verdict to
   * UNKNOWN and printed a `::warning::`, but the run still succeeded — so a
   * genuine incompatibility in a client surface nobody had added to
   * CLIENT_SURFACES produced a GREEN CI check. The call was never extracted, so
   * it yielded no finding, no BREAKING, and nothing to fail on.
   *
   * That is the same false assurance as UNAVAILABLE reporting success, and
   * quieter. Costs nothing today — the derived scan returns an empty list — and
   * exists so the day someone adds a client surface the control says so.
   *
   * Run as a subprocess because the exit code IS the behaviour under test.
   */
  const cli = path.resolve("scripts/contractSkew/cli.mjs");

  const runIn = (dir: string) => {
    try {
      execFileSync(process.execPath, [cli, "--mode", "production", "--spec", "spec.json"], {
        cwd: dir,
        stdio: "pipe",
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  };

  const scaffold = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covgap-"));
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
    fs.writeFileSync(
      path.join(dir, "spec.json"),
      JSON.stringify({ url: "https://x.convex.cloud", functions: [] })
    );
    return dir;
  };

  test("exit 0 with nothing unscanned, exit 6 once one file appears", () => {
    const dir = scaffold();
    try {
      expect(runIn(dir)).toBe(0);
      // Vary exactly one thing.
      fs.mkdirSync(path.join(dir, "somewhere"), { recursive: true });
      fs.writeFileSync(path.join(dir, "somewhere", "Screen.tsx"), "const x = useQuery(api.a.b, {});");
      expect(runIn(dir)).toBe(6);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("redaction covers what the process was handed", () => {
  test("any secret-named env value is removed by exact match", () => {
    // Widened from three named variables: a Convex or Node error can carry a
    // credential the original list never mentioned. Exact-value matching cannot
    // over-redact, which matters here.
    const saved = process.env.SOME_API_TOKEN;
    // ⚠️ Assembled at runtime, never written as a literal. A literal here is
    // indistinguishable from a real credential to a scanner: the first version
    // of this test tripped GitGuardian, and the rewrite then tripped gitleaks
    // on a DIFFERENT line and broke the required secret-scan check. Scanners
    // are right to flag key-shaped assignments; the fix is not to have one.
    const fakeValue = ["zzz", "not", "a", "real", "value"].join("-");
    process.env.SOME_API_TOKEN = fakeValue;
    try {
      expect(redact(`failed using ${fakeValue} here`)).toBe("failed using [REDACTED] here");
    } finally {
      if (saved) process.env.SOME_API_TOKEN = saved;
      else delete process.env.SOME_API_TOKEN;
    }
  });

  test("a Bearer token is removed by shape", () => {
    // ⚠️ Deliberately NOT JWT-shaped. A realistic-looking fixture tripped
    // GitGuardian's Bearer-token detector and blocked the commit — correctly,
    // since a scanner cannot tell a fixture from a leak. The redactor matches on
    // the keyword and length, so this exercises the same path.
    const fake = "Bearer " + "NOT-A-REAL-TOKEN-0000000000";
    expect(redact("Authorization: " + fake)).toBe("Authorization: Bearer [REDACTED]");
  });

  test("widening still does not eat diagnostics", () => {
    // The standing constraint: an over-eager redactor destroys the output this
    // tool exists to produce.
    const signature = "union:req:OPENING_STOCK|SOMETHINGLONGENOUGH";
    expect(redact(signature)).toBe(signature);
    expect(redact("vehicles[*].rowId is unproven")).toBe("vehicles[*].rowId is unproven");
  });
});
