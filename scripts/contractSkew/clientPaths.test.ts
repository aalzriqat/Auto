import { describe, expect, test } from "vitest";
import { extractClientCalls } from "./clientPaths.mjs";

/**
 * Direct tests for the extractor.
 *
 * ⚠️ These exist because `clientPaths.mjs` had NO unit tests while the rest of
 * the detector had twenty. A syntax error in it survived a fully green suite —
 * the tests imported `compare.mjs` and `declaredPaths.mjs` and never loaded the
 * file doing the hardest work. Coverage that stops at the easy modules is the
 * same false assurance this whole ticket is about.
 *
 * Each case pins a defect that only a whole-repo run exposed.
 */
type Node = {
  kind: string;
  fields?: Map<string, { node: Node; provenance: string }>;
  element?: Node;
  keysComplete?: boolean;
};
type Call = {
  identifier: string;
  file?: string;
  line: number;
  payload: Node | null;
  skipped?: boolean;
  unknowns: string[];
  casts: string[];
  via?: string;
};

/**
 * ⚠️ PATHS ARE A READING OF THE TREE, NOT THE TREE.
 *
 * The extractor now emits a structure; these helpers flatten it so the
 * assertions stay as readable as they were against the old path map. Producing
 * the path here rather than in the extractor is the point of the redesign — the
 * comparator never sees these strings.
 */
const pathsOf = (node: Node | null | undefined, prefix = ""): string[] => {
  if (!node) return [];
  if (node.kind === "object" && node.fields) {
    return [...node.fields].flatMap(([name, entry]) => {
      const at = prefix ? `${prefix}.${name}` : name;
      return [at, ...pathsOf(entry.node, at)];
    });
  }
  if (node.kind === "array") return pathsOf(node.element, `${prefix}[*]`);
  return [];
};

/** The field entry a dotted/bracketed path names, or undefined. */
const entryAt = (node: Node | null | undefined, path: string) => {
  let cur: Node | undefined = node ?? undefined;
  let entry: { node: Node; provenance: string } | undefined;
  for (const part of path.split(".")) {
    const name = part.replace(/(\[\*\])+$/, "");
    const arrays = (part.length - name.length) / 3;
    if (!cur || cur.kind !== "object" || !cur.fields) return undefined;
    entry = cur.fields.get(name);
    if (!entry) return undefined;
    cur = entry.node;
    for (let i = 0; i < arrays; i += 1) cur = cur?.kind === "array" ? cur.element : undefined;
  }
  return entry;
};

const FIXTURE = "scripts/contractSkew/__fixtures__/clientCases.tsx";

let cached: Call[] | null = null;
function calls(): Call[] {
  if (!cached) {
    cached = extractClientCalls([FIXTURE], "tsconfig.json").calls as unknown as Call[];
  }
  return cached;
}
const forFn = (identifier: string) => calls().filter((c) => c.identifier === identifier);

describe("clientPaths extractor", () => {
  test("CASE 1: `as any` strips to the transmitted expression, so nested paths still resolve", () => {
    // The real #235 call site is `vehicles: chunk as any`. Asking the checker
    // for that argument's type yields `any`, so a purely type-driven extractor
    // reports UNKNOWN for the single most important call site in the codebase.
    const [call] = forFn("vehicles:importBulk");
    expect(call).toBeDefined();
    expect(pathsOf(call.payload)).toContain("vehicles[*].rowId");
    expect(pathsOf(call.payload)).toContain("vehicles[*].make");
    // The cast is reported rather than silently compensated for: `as any` at a
    // Convex boundary disables the compiler's own contract check.
    expect(call.casts.join(" ")).toMatch(/as any/);
  });

  test("CASE 2: symbol identity beats identifier text — a useState setter is not a Convex call", () => {
    // Keyed by name, `setValues({ a: "b" })` in one component was attributed to
    // api.orgCustomFields.setValues declared in another. `setX` beside
    // `const [x, setX] = useState()` is ordinary React, so this misfired widely.
    const attributed = forFn("orgCustomFields:setValues");
    expect(attributed).toHaveLength(1);
    // The one real call sends orgId/entityId; the React state update sent {a}.
    const keys = pathsOf(attributed[0].payload).sort();
    expect(keys).toEqual(["entityId", "orgId"]);
    expect(keys).not.toContain("a");
  });

  test("CASE 3: a query's payload is read at the hook call itself", () => {
    // useMutation returns something you call later; useQuery sends its args at
    // the hook call and returns data. Conflating them made every
    // `const { results } = usePaginatedQuery(...)` look unresolvable.
    const [call] = forFn("vehicles:list").filter((c) => pathsOf(c.payload).length > 0);
    expect(call).toBeDefined();
    expect(pathsOf(call.payload).sort()).toEqual(["includeSold", "orgId"]);
  });

  test("CASE 3b: a skipped query transmits nothing", () => {
    // ⚠️ NOT an unknown, and not an empty payload either. `useQuery(fn, "skip")`
    // provably never runs, so neither direction of the comparison applies — but
    // the call site is still counted, because dropping it would be exactly the
    // silent coverage hole this control exists to detect.
    const skipped = forFn("vehicles:list").filter((c) => c.skipped);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].payload).toBeNull();
  });

  test("CASE 4: an optional parent makes its required child UNPROVEN, not proven", () => {
    // `sourceLikeVehicle` is optional and unset, so `sourceLikeVehicle.make` is
    // never transmitted even though it is required within that object. Without
    // inheritance the child read as TYPE_REQUIRED and produced eight fabricated
    // BREAKING findings.
    const [call] = forFn("wizardDrafts:saveDraft");
    expect(call).toBeDefined();
    const parent = entryAt(call.payload, "wizardData.sourceLikeVehicle");
    const child = entryAt(call.payload, "wizardData.sourceLikeVehicle.make");
    expect(parent?.provenance).toBe("TYPE_OPTIONAL");
    expect(child?.provenance).toBe("TYPE_OPTIONAL");
    // The genuinely-present sibling stays proven, so the rule does not simply
    // weaken everything.
    expect(entryAt(call.payload, "wizardData.vehicleId")?.provenance).not.toBe("TYPE_OPTIONAL");
  });

  test("CASE 5: paginated queries are tagged so the comparator can exempt framework arguments", () => {
    // usePaginatedQuery injects paginationOpts; the caller never passes it.
    // Demanding it produced 159 BREAKING findings in one run.
    const [call] = forFn("transactions:list");
    expect(call).toBeDefined();
    expect(call.via).toBe("usePaginatedQuery");
    expect(pathsOf(call.payload)).not.toContain("paginationOpts");
  });

  test("CASE 6: the scan stays inside the declared client files", () => {
    // `program.getSourceFiles()` returns everything the compiler pulled in, not
    // the files that were asked for. That silently pulled `convex/*.ts` into a
    // scan advertised as covering the client: 263 of a reported 934 "client call
    // sites" were backend code, and six unproven paths pointed a reader at
    // `convex/marketplaceRequests.ts:150` to explain a client problem.
    //
    // A Convex-to-Convex call cannot skew at all — caller and callee ship in one
    // `convex deploy` — so those sites were not merely mislabelled, they were
    // structurally incapable of the failure being counted.
    const escaped = calls().filter((c) => /serverLike/.test(String((c as { file?: string }).file)));
    expect(escaped).toHaveLength(0);
    // And the field only that module sends must appear nowhere.
    const everySentPath = calls().flatMap((c) => pathsOf(c.payload));
    expect(everySentPath).not.toContain("serverOnlyField");
  });

  test("the fixture file loads at all — the module is syntactically valid", () => {
    // Blunt on purpose. A syntax error in clientPaths.mjs once survived a fully
    // green suite because nothing imported it.
    expect(calls().length).toBeGreaterThan(0);
  });
});
