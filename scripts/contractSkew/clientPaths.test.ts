import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { extractClientCalls } from "./clientPaths.mjs";

/**
 * Direct tests for the extractor.
 *
 * ⚠️ These exist because `clientPaths.mjs` had NO unit tests while the rest of
 * the detector had twenty. A syntax error in it survived a fully green suite —
 * the tests imported `compare.mjs` and `specIndex.mjs` and never loaded the
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
  values?: Set<unknown>;
  nodes?: Node[];
  empty?: boolean;
  type?: string;
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

/** 1-based line of the first fixture line containing `needle`. */
const lineOf = (needle: string) =>
  readFileSync(FIXTURE, "utf8").split(/\r?\n/).findIndex((l) => l.includes(needle)) + 1;

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

  test("CASE 3c: the SENTINEL is removed from a ternary payload, the args are kept", () => {
    // ⚠️ The idiom that actually occurs — 283 times, against zero occurrences
    // of the bare literal. The payload type is `{...} | "skip"`, so without
    // removing the sentinel the client "sends a string" to every skippable
    // query: 269 fabricated BREAKING findings in one whole-repo run.
    const [call] = forFn("vehicles:list").filter((c) => c.line === lineOf("ready ? { orgId"));
    expect(call).toBeDefined();
    expect(call.skipped).toBeFalsy();
    expect(call.payload?.kind).toBe("object");
    expect(pathsOf(call.payload).sort()).toEqual(["includeSold", "orgId"]);
  });

  test("CASE 3d: `cond ? undefined : \"skip\"` RUNS, with no arguments", () => {
    // Dropping this as "never runs" cost three real call sites. It transmits an
    // empty payload, which is knowable — and which is exactly what lets the
    // other direction notice a backend that started requiring an argument.
    const [call] = forFn("organizations:listMine");
    expect(call).toBeDefined();
    expect(call.skipped).toBeFalsy();
    expect(call.payload?.kind).toBe("object");
    expect(call.payload?.keysComplete).toBe(true);
    expect(pathsOf(call.payload)).toEqual([]);
  });

  test("CASE 3e: a MAPPED TYPE's members resolve, rather than reading as opaque", () => {
    // `Partial<Record<K, V>>` has no valueDeclaration for any member, so the
    // declaration-based lookup returns nothing. Recording that as "unresolved"
    // let seven real values pass as compatible without ever being read.
    const [call] = forFn("customers:mergeCustomers");
    expect(call).toBeDefined();
    const overrides = entryAt(call.payload, "fieldOverrides");
    expect(overrides?.node.kind).toBe("object");
    expect(pathsOf(call.payload).sort()).toEqual([
      "fieldOverrides",
      "fieldOverrides.email",
      "fieldOverrides.phone",
      "orgId",
    ]);
    expect(entryAt(call.payload, "fieldOverrides.email")?.node.kind).toBe("scalar");
  });

  test("CASE 3f: an INDEX SIGNATURE costs key completeness, so nothing is demanded of it", () => {
    // `keysComplete` is the whole basis of the missing-required-field
    // direction. An object that accepts arbitrary keys may already carry the
    // field under a name we cannot see, so it must not be demanded — and the
    // fact has to live ON the node, because that is the only place both
    // directions of the comparison can read it.
    const wizardDataNodes = forFn("wizardDrafts:saveDraft").map(
      (c) => entryAt(c.payload, "wizardData")?.node
    );
    // One call sends a resolved literal; the other sends a Record<string, T>.
    expect(wizardDataNodes.map((n) => n?.keysComplete).sort()).toEqual([false, true]);
  });

  test("CASE 3g: a NULL branch of a client union survives as a value", () => {
    // `undefined` means "not transmitted"; `null` means "transmitted, as null".
    // Collapsing the two discards a value the backend may refuse.
    const [call] = forFn("vehicles:update");
    expect(call).toBeDefined();
    const status = entryAt(call.payload, "inspectionStatus")?.node;
    expect(status?.kind).toBe("literal");
    expect([...(status?.values ?? [])].map(String).sort()).toEqual(["SELF_REPORTED", "null"]);
  });

  test("CASE 3g: a null branch beside a WIDENED scalar is kept as a variant", () => {
    // `string | null` cannot collapse to one node: the string half is unprovable
    // and the null half is exactly provable. Both facts have to survive.
    const [call] = forFn("vehicles:update");
    const notes = entryAt(call.payload, "notes")?.node;
    expect(notes?.kind).toBe("variants");
    const kinds = (notes?.nodes ?? []).map((n: { kind: string }) => n.kind).sort();
    expect(kinds).toEqual(["literal", "scalar"]);
  });

  test("CASE 3h: `undefined` is absence, so an OPTIONAL literal union stays enumerable", () => {
    /**
     * Surfaced by a surviving mutant. The null fix changed a predicate with two
     * halves, and only the null half had coverage — so `undefined` could have
     * silently become a value with every test still green. It is not a value:
     * an optional enum must remain an exact, provable domain, or every optional
     * enum in the app degrades to "not verified" at once.
     */
    const call = forFn("vehicles:update").find((c) => entryAt(c.payload, "status"));
    expect(call).toBeDefined();
    const status = entryAt(call!.payload, "status")?.node;
    expect(status?.kind).toBe("literal");
    expect([...(status?.values ?? [])].sort()).toEqual(["AVAILABLE", "SOLD"]);
    expect([...(status?.values ?? [])]).not.toContain(undefined);
  });

  test("CASE 3i: an EMPTY array literal is marked empty, not unresolved", () => {
    /**
     * Surfaced by a surviving mutant: the model-level control built the empty
     * node by hand, so nothing proved the EXTRACTOR produces it from real
     * source. Neutering that line left every test green while restoring the
     * fabricated-BREAKING defect the review found.
     */
    // Two fixtures call importBulk; select the empty-literal one BY SOURCE LINE
    // rather than by the property being asserted, which would be circular.
    const call = forFn("vehicles:importBulk").find((c) => c.line === lineOf("vehicles: [] }"));
    expect(call).toBeDefined();
    const vehicles = entryAt(call!.payload, "vehicles")?.node;
    expect(vehicles?.kind).toBe("array");
    expect(vehicles?.empty).toBe(true);
  });

  test("CASE 3j: a BRANDED primitive resolves to its primitive, not to unresolved", () => {
    // Without this, every Convex `Id<T>` argument reads as unresolvable and the
    // honest-unknown fix turns 808 verified values into noise.
    const call = forFn("vehicles:update").find((c) => entryAt(c.payload, "vehicleId"));
    expect(call).toBeDefined();
    const node = entryAt(call!.payload, "vehicleId")?.node;
    expect(node?.kind).toBe("scalar");
    expect(node?.type).toBe("string");
  });

  test("CASE 6c: a `__`-prefixed field is NOT silently dropped", () => {
    // A field skipped for any reason must be VISIBLE - kept, or recorded as
    // unknown with key completeness withdrawn. Silence is the one thing it
    // cannot be, because silence plus keysComplete:true is an assertion.
    const call = forFn("vehicles:update").find((c) => entryAt(c.payload, "__legacyFlag"));
    expect(call, "the __-prefixed field vanished from the payload entirely").toBeDefined();
    // `boolean` is `true | false` in TypeScript, so it resolves to an exact
    // value set rather than a widened scalar - which is more precise, not less.
    const node = entryAt(call!.payload, "__legacyFlag")?.node;
    expect(node?.kind).toBe("literal");
    expect([...(node?.values ?? [])].sort()).toEqual([false, true]);
    expect(pathsOf(call!.payload).sort()).toEqual(["__legacyFlag", "orgId"]);
  });

  test("CASE 7: an unresolvable SPREAD withdraws key completeness", () => {
    // Fail-open otherwise: both comparison directions read `keysComplete`, so a
    // false claim of completeness fabricates findings in one direction and
    // hides them in the other.
    const call = forFn("vehicles:update").find((c) =>
      c.unknowns.some((u: string) => u.includes("unresolvable spread"))
    );
    expect(call, "the unresolvable spread was not recorded at all").toBeDefined();
    expect(call!.payload?.keysComplete).toBe(false);
  });

  test("a tsconfig that cannot be read REFUSES, rather than degrading to defaults", () => {
    // `createProgram` succeeds regardless, because rootFiles supplies the root
    // names — but without the project's paths/jsx/lib/strict the type
    // resolution collapses and every payload becomes an UNKNOWN. A wall of
    // unknowns reads like honest uncertainty and is actually a broken
    // toolchain, so the only honest answer is to refuse loudly.
    expect(() => extractClientCalls([FIXTURE], "does-not-exist-tsconfig.json")).toThrow(/Cannot read/);
  });

  test("CASE 4: an optional parent makes its required child UNPROVEN, not proven", () => {
    // `sourceLikeVehicle` is optional and unset, so `sourceLikeVehicle.make` is
    // never transmitted even though it is required within that object. Without
    // inheritance the child read as TYPE_REQUIRED and produced eight fabricated
    // BREAKING findings.
    // Two fixtures call this mutation; take the one whose payload was resolved.
    const call = forFn("wizardDrafts:saveDraft").find(
      (c) => entryAt(c.payload, "wizardData")?.node.keysComplete
    )!;
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

  test("CASE 5a: the DIRECT invocation form is resolved like a hook call", () => {
    const call = forFn("vehicles:update").find((c) => c.line === lineOf("convex.mutation(api.vehicles.update"));
    expect(call).toBeDefined();
    expect(pathsOf(call!.payload).sort()).toEqual(["orgId", "status"]);
  });

  test("CASE 5b: a SPREAD contributes its fields", () => {
    const call = forFn("vehicles:update").find((c) => c.line === lineOf("...rest }"));
    expect(call).toBeDefined();
    const paths = pathsOf(call!.payload).sort();
    expect(paths).toContain("notes");
    expect(paths).toContain("mileage");
    expect(paths).toContain("orgId");
  });

  test("CASE 5c: a COMPUTED KEY costs key completeness and is recorded", () => {
    const call = forFn("vehicles:update").find((c) => c.line === lineOf("[key]: \"whatever\""));
    expect(call).toBeDefined();
    expect(call!.payload?.keysComplete).toBe(false);
    expect(call!.unknowns.join(" ")).toContain("[computed]");
  });

  test("CASE 5d: a POPULATED array literal keeps its element fields", () => {
    const call = forFn("vehicles:importBulk").find((c) => c.line === lineOf("[{ vin: \"V1\""));
    expect(call).toBeDefined();
    const paths = pathsOf(call!.payload);
    expect(paths).toContain("vehicles[*].vin");
    expect(paths).toContain("vehicles[*].make");
  });

  test("CASE 5e: an unfollowable binder is a reported COVERAGE GAP, with a cause", () => {
    // Never silently skipped: a binder we cannot follow is this control's own
    // failure mode one level up, so each one denies PASS and says why.
    const binders = extractClientCalls([FIXTURE], "tsconfig.json").unresolvedBinders;
    const causes = new Set(binders.map((b: { cause: string }) => b.cause));
    expect(binders.length).toBeGreaterThan(0);
    expect(causes.has("DESTRUCTURED_BINDING") || causes.has("WRAPPER_RETURN")).toBe(true);
    expect(causes.has("DYNAMIC_IDENTITY")).toBe(true);
  });

  test("CASE 5f: an `any` value is opaque, and recorded as an unknown", () => {
    const call = forFn("vehicles:update").find((c) => c.line === lineOf("notes: blob"));
    expect(call).toBeDefined();
    expect(entryAt(call!.payload, "notes")?.node.kind).toBe("opaqueValue");
    expect(call!.unknowns).toContain("notes");
  });

  test("CASE 6a: a TUPLE resolves its element like an array does", () => {
    const call = forFn("vehicles:update").find((c) => c.line === lineOf("tags: pair"));
    expect(call).toBeDefined();
    const tags = entryAt(call!.payload, "tags")?.node;
    expect(tags?.kind).toBe("array");
    expect(tags?.element?.kind).toBe("scalar");
  });

  test("CASE 6b: nesting past the depth limit records an unknown, not a shallow answer", () => {
    // The walk has to stop somewhere. Stopping silently would let a payload we
    // only half-read report as fully understood.
    const call = forFn("vehicles:update").find((c) => entryAt(c.payload, "a"));
    expect(call).toBeDefined();
    expect(call!.unknowns.join(" ")).toContain("max depth");
  });

  test("the fixture file loads at all — the module is syntactically valid", () => {
    // Blunt on purpose. A syntax error in clientPaths.mjs once survived a fully
    // green suite because nothing imported it.
    expect(calls().length).toBeGreaterThan(0);
  });
});
