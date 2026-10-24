import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { v } from "convex/values";
import { createClientProgram, extractClientCalls } from "./clientPaths.mjs";
import { CLIENT_SURFACES, listSurfaceFiles } from "./clientFiles.mjs";
import { compareNode, validatorTree } from "./contractTree.mjs";
import { openingAllocationValidator, openingAllocationResultValidator } from "@/convex/utils/openingAllocationValidators";

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
  effect?: "TYPE_CLAIM" | "NON_NULL_ERASURE";
  node?: Node;
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
  if (node.kind === "assertion") return pathsOf(node.node, prefix);
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
    while (cur?.kind === "assertion") cur = cur.node;
    const name = part.replace(/(\[\*\])+$/, "");
    const arrays = (part.length - name.length) / 3;
    if (!cur || cur.kind !== "object" || !cur.fields) return undefined;
    entry = cur.fields.get(name);
    if (!entry) return undefined;
    cur = entry.node;
    for (let i = 0; i < arrays; i += 1) {
      while (cur?.kind === "assertion") cur = cur.node;
      cur = cur?.kind === "array" ? cur.element : undefined;
    }
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

  test("CASE 3j: a BRANDED primitive resolves to a TABLE-QUALIFIED id, not to a bare string", () => {
    /**
     * ⚠️ THIS TEST USED TO ASSERT `scalar("string")`, AND THAT ASSERTION WAS
     * THE ERASURE.
     *
     * Resolving the brand to its primitive fixed an earlier defect — every
     * `Id<T>` argument was reading as unresolvable — but it threw away the one
     * dimension `v.id(table)` is about. Once `Id<"users">` and `Id<"vehicles">`
     * are both `string`, a client sending the wrong table reports CLEAN.
     *
     * The table is now preserved. A brand that is NOT a finite string-literal
     * domain still falls back to the old primitive behaviour, because an
     * unprovable table is not a table.
     */
    const call = forFn("vehicles:update").find((c) => entryAt(c.payload, "vehicleId"));
    expect(call).toBeDefined();
    const node = entryAt(call!.payload, "vehicleId")?.node as unknown as {
      kind: string;
      tables?: Set<string>;
    };
    expect(node?.kind).toBe("id");
    expect([...(node.tables ?? [])]).toEqual(["vehicles"]);
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

  test("CASE 8: an ArrayBuffer is extracted as an OBJECT node, not a scalar", () => {
    // ⚠️ THE PREMISE THE `v.bytes()` COMPARISON RESTS ON, pinned by measurement.
    //
    // `bytes` was mapped to the client type `"object"` on the assumption that an
    // ArrayBuffer arrives as `scalar("object")`. It does not: an ArrayBuffer
    // carries `ts.TypeFlags.Object`, so it never reaches the primitive branch
    // and is emitted as an object NODE. That made the table entry unreachable
    // and sent real byte payloads down the object branch as BREAKING.
    const call = forFn("vehicles:update").find((c) => c.payload?.fields?.has?.("blob"));
    expect(call, "the ArrayBuffer payload was not extracted at all").toBeDefined();
    const blob = call!.payload!.fields!.get("blob")!.node;
    expect(blob.kind).toBe("object");
    expect(blob.kind).not.toBe("scalar");
  });

  test("CASE 9: a heterogeneous tuple keeps EVERY member, not just the first", () => {
    // ⚠️ A FALSE PASS PRODUCED BY THE EXTRACTOR. `getElementType` returned
    // `args[0]`, so `[string, number]` became `array(scalar(string))` and the
    // `number` member was gone before the comparator ever ran. Against
    // `v.array(v.string())` that is a clean PASS on a payload Convex refuses.
    const call = forFn("vehicles:update").find((c) => c.payload?.fields?.has?.("pair"));
    expect(call, "the tuple payload was not extracted at all").toBeDefined();
    const pair = call!.payload!.fields!.get("pair")!.node;
    expect(pair.kind).toBe("array");
    // Both members must be reachable in the element node. They are different
    // shapes, so merging them yields variants — and the comparator requires
    // EVERY variant to satisfy the validator, which is the fail-closed answer.
    const element = pair.element!;
    const kinds = element.kind === "variants" ? element.nodes!.map((n) => n.type ?? n.kind) : [element.type ?? element.kind];
    expect(kinds.sort()).toEqual(["number", "string"]);
  });

  test("CASE 9b: an `as const` tuple keeps every literal — the reachable form", () => {
    // `["CASH","BANK_TRANSFER"] as const` is a TUPLE, not an array. Keeping only
    // `args[0]` asserted the client could send ONLY "CASH".
    const call = forFn("vehicles:update").find((c) => c.payload?.fields?.has?.("methods"));
    expect(call, "the as-const tuple payload was not extracted at all").toBeDefined();
    const methods = call!.payload!.fields!.get("methods")!.node;
    expect(methods.kind).toBe("array");
    expect([...(methods.element!.values ?? [])].sort()).toEqual(["BANK_TRANSFER", "CASH"]);
  });

  test("CASE 10: a NUMERIC index signature withdraws key completeness", () => {
    // The check asked about STRING index signatures only, so a numerically
    // keyed object claimed a PROVEN COMPLETE key set over an open domain.
    const call = forFn("vehicles:update").find((c) => c.payload?.fields?.has?.("byIndex"));
    expect(call, "the numeric-index payload was not extracted at all").toBeDefined();
    const byIndex = call!.payload!.fields!.get("byIndex")!.node;
    expect(byIndex.kind).toBe("object");
    expect(byIndex.keysComplete).toBe(false);
  });

  test("CASE 11: an unclassifiable tuple member is NOT absorbed by its readable neighbour", () => {
    // ⚠️ THE HALF THAT MAKES MEMBER-WISE MERGING SOUND. Preserving every member
    // is worthless if merging them then discards the uncertain one: the tuple
    // would report `scalar(string)` and read as fully determined. The readable
    // member must not speak for the one the checker could not classify.
    const call = forFn("vehicles:update").find((c) => c.payload?.fields?.has?.("mixed"));
    expect(call, "the mixed tuple payload was not extracted at all").toBeDefined();
    const mixed = call!.payload!.fields!.get("mixed")!.node;
    expect(mixed.kind).toBe("array");
    expect(mixed.element!.kind).toBe("unresolved");
    expect(mixed.element!.kind).not.toBe("scalar");
  });

  test("CASE 12: a bare OPTIONAL SCALAR keeps its type — the undefined-skip guard is load-bearing", () => {
    // ⚠️ PINS A GUARD THAT WAS DOCUMENTED AS REMOVABLE AND IS NOT.
    //
    // Under `strict`, `note?: string` is `string | undefined`. The union walk
    // skips the `undefined` branch; since `unresolved` became ABSORBING, not
    // skipping it collapses the field — and every optional field in the repo —
    // to `unresolved`. The comment beside that guard claimed removing it
    // "changes nothing", a proof that expired when the merge semantics changed.
    //
    // Reverting the guard fails this test plus CASE 3d, 3e, 3h and 4.
    const call = forFn("vehicles:update").find((c) => c.payload?.fields?.has?.("note"));
    expect(call, "the optional scalar payload was not extracted at all").toBeDefined();
    const note = call!.payload!.fields!.get("note")!.node;
    expect(note.kind).toBe("scalar");
    expect(note.kind).not.toBe("unresolved");
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

  test("diagnosticsCount is computed on demand, and still counts the program's semantic errors", () => {
    // SCRUM-752: a full semantic check was ~40 s of every whole-tree extraction
    // and nothing read it, so the field is a getter. Reading it must still run
    // the real check against the same program.
    const dir = mkdtempSync(path.join(tmpdir(), "skew-diagnostics-"));
    try {
      const file = path.join(dir, "broken.ts");
      writeFileSync(file, 'export const n: number = "not a number";\n');
      const extraction = extractClientCalls([file], "tsconfig.json");
      expect(typeof Object.getOwnPropertyDescriptor(extraction, "diagnosticsCount")?.get).toBe("function");
      expect(extraction.diagnosticsCount).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("SCRUM-711 native request-map proof controls", () => {
  const picker = readFileSync("components/sales/wizard/hooks/usePickerAvailability.ts", "utf8").replace(/\r\n/g, "\n");
  const replace = (from: string, to: string) => {
    expect(picker).toContain(from);
    return picker.replace(from, to);
  };
  const cases = [
    { name: "native", source: picker, extracts: true },
    { name: "native imported alias", source: picker.replace('import { useMemo }', 'import { useMemo as nativeMemo }').replaceAll('useMemo(', 'nativeMemo('), extracts: true },
    { name: "shadowed request factory", source: replace('  const queries = useMemo', '  const other = { useMemo: (_factory: unknown, _deps: unknown) => ({}) };\n  const queries = other.useMemo').replace('}, [orgId, chunks]);', '}, []);'), extracts: false },
    { name: "async request factory", source: replace('const queries = useMemo((): RequestForQueries =>', 'const queries = useMemo(async (): Promise<RequestForQueries> =>'), extracts: false },
    { name: "async producer factory", source: replace('useMemo(() => chunkVehicleIds(vehicleIds)', 'useMemo(async () => chunkVehicleIds(vehicleIds)'), extracts: false },
    { name: "async tuple callback", source: replace('chunks.map((chunk, index) => [', 'chunks.map(async (chunk, index) => ['), extracts: false },
    { name: "spoofed default library", source: 'import { Object } from "./lib.spoof";\n' + picker, extracts: false },
    { name: "direct eval writer", source: replace('  const queries = useMemo', '  eval("chunks.map = () => []");\n  const queries = useMemo'), extracts: false },
    ...["map", "push", "slice"].map((method) => ({ name: `explicit prototype ${method} writer`, source: replace('  const queries = useMemo', `  Array.prototype.${method} = () => [];\n  const queries = useMemo`), extracts: false })),
    { name: "shadowed Object", source: replace('  const idsKey = vehicleIds.join', '  const Object = { fromEntries: (_entries: unknown) => ({}) };\n  const idsKey = vehicleIds.join'), extracts: false },
    { name: "claimed Object binding", source: replace('  const idsKey = vehicleIds.join', '  const Object = globalThis.injected as ObjectConstructor;\n  const idsKey = vehicleIds.join'), extracts: false },
    { name: "overridden map", source: replace('  const queries = useMemo', '  chunks.map = () => [];\n  const queries = useMemo'), extracts: false },
    { name: "overridden push", source: replace('  for (let i = 0;', '  chunks.push = () => 0;\n  for (let i = 0;'), extracts: false },
    { name: "extra writer", source: replace('  return chunks;', '  chunks[0] = [];\n  return chunks;'), extracts: false },
    { name: "array alias", source: replace('  return chunks;', '  const alias = chunks;\n  return alias;'), extracts: false },
    { name: "shorthand escape", source: replace('  return chunks;', '  globalThis.escapedChunks = { chunks };\n  return chunks;'), extracts: false },
    { name: "escaped closure", source: replace('  return chunks;', '  globalThis.releaseChunks = () => chunks;\n  return chunks;'), extracts: false },
    { name: "unknown return", source: replace('  return chunks;', '  return ids.length ? chunks : ids;'), extracts: false },
    { name: "unknown map callee", source: replace('      chunks.map((chunk, index)', '      chunks.flatMap((chunk, index)'), extracts: false },
    { name: "claimed receiver", source: replace('  const chunks = useMemo(() => chunkVehicleIds(vehicleIds), [idsKey]);', '  const chunks = vehicleIds as unknown as string[][];'), extracts: false },
    { name: "shadowed useMemo", source: replace('  const idsKey = vehicleIds.join', '  const useMemo = (_factory: unknown, _deps: unknown) => [];\n  const idsKey = vehicleIds.join'), extracts: false },
    { name: "consumer array callback parameter", source: replace('chunks.forEach((chunk, index) => {', 'chunks.forEach((chunk, index, whole) => { whole.length = 0;'), extracts: false },
    { name: "consumer outer capture", source: replace('chunks.forEach((chunk, index) => {', 'chunks.forEach((chunk, index) => { chunks.length = 0;'), extracts: false },
    { name: "opaque slice value", source: replace('chunks.push(unique.slice(i, i + size))', 'chunks.push((unique.slice = () => undefined, unique.slice(i, i + size)))'), extracts: true },
    { name: "opaque element projection", source: replace('vehicleIds: chunk as Id<"vehicles">[]', 'vehicleIds: chunk.slice(0) as Id<"vehicles">[]'), extracts: true },
    { name: "invalid literal neighbor", source: replace('args: { orgId, vehicleIds:', 'args: { unexpectedField: 7, orgId, vehicleIds:'), extracts: true },
    { name: "undefined args alternative", source: replace('args: { orgId, vehicleIds:', 'args: index ? undefined : { orgId, vehicleIds:'), extracts: true },
    { name: "invalid args alternative", source: replace('args: { orgId, vehicleIds:', 'args: index ? 42 : { orgId, vehicleIds:'), extracts: true },
    { name: "undefined tuple value", source: replace('        {\n          query:', '        index ? undefined : {\n          query:'), extracts: false },
  ];
  const parent = path.resolve("scripts/contractSkew/__fixtures__");
  let dir: string | undefined;
  let files: string[] = [];
  afterAll(() => {
    if (!dir) return;
    if (path.dirname(dir) !== parent) throw new Error("Unexpected fixture directory");
    rmSync(dir, { recursive: true, force: true });
  });
  let extracted: ReturnType<typeof extractClientCalls> | undefined;
  let evalExtraction: ReturnType<typeof extractClientCalls> | undefined;
  const controls = () => {
    if (extracted) return extracted;
    dir = mkdtempSync(path.join(parent, "picker-proof-"));
    writeFileSync(path.join(dir, "lib.spoof.d.ts"), "export declare const Object: ObjectConstructor;\n");
    const fixtureDir = dir;
    files = cases.map((control, index) => {
      const file = path.join(fixtureDir, `control${index}.tsx`);
      writeFileSync(file, control.source);
      return file;
    });
    const sharedFiles = files.filter((_file, index) => cases[index].name !== "direct eval writer");
    return extracted = extractClientCalls(sharedFiles, "tsconfig.json", { program: createClientProgram(sharedFiles, "tsconfig.json") });
  };
  test.each(cases.map((control, index) => ({ ...control, index })))("$name preserves proof or refusal", (control) => {
    controls();
    const extraction = control.name === "direct eval writer"
      ? evalExtraction ??= extractClientCalls([files[control.index]], "tsconfig.json")
      : controls();
    const inFile = (file: string) => path.resolve(file) === files[control.index];
    const calls = extraction.calls.filter((call) => inFile(call.file) && call.identifier === "vehicleAvailability:pickerAvailability");
    expect(calls).toHaveLength(control.extracts ? 1 : 0);
    if (!control.extracts) {
      expect(extraction.unresolvedBinders.some((binder) => inFile(binder.file))).toBe(true);
      return;
    }
    const payload = calls[0].payload;
    if (!payload) throw new Error("Request payload not measured");
    const compared = compareNode(payload, validatorTree({ type: "object", value: {
      orgId: { fieldType: { type: "any" }, optional: false },
      vehicleIds: { fieldType: { type: "array", value: { type: "id", tableName: "vehicles" } }, optional: false },
    } }), "", { site: { identifier: calls[0].identifier, file: calls[0].file, line: calls[0].line } });
    if (control.name.endsWith("args alternative")) {
      expect(payload.kind).toBe("variants");
      if (payload.kind !== "variants") throw new Error("Invalid payload alternative was erased");
      const expected = control.name.startsWith("undefined") ? undefined : 42;
      expect(payload.nodes.some((node) => node.kind === "literal" && node.values.has(expected))).toBe(true);
      expect(compared.findings.some((finding) => finding.severity === "BREAKING")).toBe(true);
      return;
    }
    expect(payload?.kind).toBe("object");
    if (payload?.kind !== "object") throw new Error("Request payload not measured");
    const vehicles = payload.fields.get("vehicleIds")?.node;
    expect(vehicles?.kind).toBe("assertion");
    if (vehicles?.kind !== "assertion") throw new Error("Actual picker assertion was erased");
    expect(vehicles.node.kind).toBe("opaqueValue");
    expect(compared.findings.some((finding) => finding.severity === "SHAPE_UNKNOWN" && finding.path === "vehicleIds")).toBe(true);
    if (control.name === "invalid literal neighbor") {
      expect(payload.fields.get("unexpectedField")?.node).toMatchObject({ kind: "literal", values: new Set([7]) });
      expect(compared.findings.some((finding) => finding.severity === "BREAKING" && finding.path === "unexpectedField")).toBe(true);
    }
  }, 120_000);
});

describe("SCRUM-711 native primitive declaration provenance", () => {
  test.each([
    { scope: "focused", wholeProgram: false },
    { scope: "whole web", wholeProgram: true },
  ])("both actual opening routes measure their full allocation arrays against their registered native arguments ($scope)", async ({ wholeProgram }) => {
    const web = CLIENT_SURFACES.find((surface) => surface.name === "web");
    if (!web) throw new Error("Actual CLI web surface is unavailable");
    const card = "components/accounting/setup/OpeningBalanceCard.tsx";
    const files = wholeProgram ? listSurfaceFiles(process.cwd(), web) : [card];
    if (wholeProgram) {
      expect(files.map((file) => path.resolve(file))).toContain(path.resolve(card));
      expect(files.length).toBeGreaterThan(1);
    }
    const extraction = extractClientCalls(files, web.tsconfig);
    if (!("json" in openingAllocationValidator)) throw new Error("Native validator rendering is unavailable");
    const nativeArray = validatorTree({ type: "array", value: openingAllocationValidator.json });
    if (!("json" in openingAllocationResultValidator)) throw new Error("Native result-validator rendering is unavailable");
    const wrongReadbackOracle = validatorTree({ type: "array", value: openingAllocationResultValidator.json });
    const modulePath = path.resolve("convex/accountingCutover.ts");
    const registrations: unknown = await import(modulePath);
    if (!registrations || typeof registrations !== "object") throw new Error("Native registrations unavailable");
    const results = ["postOpeningBalanceDirect", "draftOpeningBalance"].map((name) => {
      const registration: unknown = Reflect.get(registrations, name);
      if (typeof registration !== "function" || !("exportArgs" in registration) || typeof registration.exportArgs !== "function") {
        throw new Error("Native registered argument export unavailable");
      }
      const rendered: unknown = registration.exportArgs();
      if (typeof rendered !== "string") throw new Error("Native argument export is not JSON text");
      const argumentTree = validatorTree(JSON.parse(rendered));
      if (argumentTree.kind !== "object") throw new Error("Native arguments are not an object validator");
      const registeredArray = argumentTree.fields.get("allocations")?.node;
      if (!registeredArray || registeredArray.kind !== "array") throw new Error("Native allocation argument unavailable");
      expect(registeredArray).toEqual(nativeArray);
      const identifier = `accountingCutover:${name}`;
      const calls = extraction.calls.filter((call) => call.identifier === identifier);
      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (call.payload?.kind !== "object") throw new Error("Opening payload was not measured");
      const allocations = call.payload.fields.get("allocations")?.node;
      if (!allocations) throw new Error("Actual allocation field was not measured");
      const site = { identifier, file: call.file, line: call.line };
      const compared = compareNode(allocations, registeredArray, "allocations", {
        site,
      });
      const wrongReadback = compareNode(allocations, wrongReadbackOracle, "allocations", { site });
      return { identifier, kind: allocations.kind, findings: compared.findings, wrongReadback };
    });
    expect(results.map((result) => result.findings)).toEqual([[], []]);
    expect(results.map((result) => result.kind)).toEqual(["array", "array"]);
    expect(results.every((result) => result.wrongReadback.findings.some((finding) => finding.severity === "BREAKING"))).toBe(true);
  }, 120_000);

  const cases = [
    { name: "Number", prefix: "", expression: "Number(input)", proven: true },
    { name: "String", prefix: "", expression: "String(input).length", proven: true },
    { name: "BigInt", prefix: "", expression: "Number(BigInt(input))", proven: true },
    { name: "Set", prefix: "", expression: "new Set([input]).size", proven: true },
    { name: "Date", prefix: "", expression: "new Date(Number(input)).getTime()", proven: true },
    { name: "Date global writer", prefix: "globalThis.Date = (() => ({})) as unknown as DateConstructor;", expression: "new Date(Number(input)).getTime()", proven: false },
    { name: "native Object freeze", prefix: "", expression: "Object.freeze({ amount: Number(input) }).amount", proven: true },
    { name: "Object global writer", prefix: "globalThis.Object = (() => ({})) as unknown as ObjectConstructor;", expression: "Object.freeze({ amount: Number(input) }).amount", proven: false },
    { name: "Object freeze writer", prefix: "Object.freeze = ((value: unknown) => value) as typeof Object.freeze;", expression: "Object.freeze({ amount: Number(input) }).amount", proven: false },
    { name: "erased Promise type annotation", prefix: "const typed = (): Promise<number> | number => 1;", expression: "Number(typed())", proven: true },
    { name: "metadata mode remains unproven", prefix: "const typed = (): Promise<number> | number => 1;", expression: "Number(typed())", proven: false },
    { name: "asserted helper result", prefix: 'const typed = (): number => ("bad" as unknown as number);', expression: "typed()", proven: false },
    { name: "runtime class heritage", prefix: 'const Ctor = ("bad" as unknown as new () => object); const typed = () => class extends Ctor {};', expression: "new (typed())() ? Number(input) : 0", proven: false },
    { name: "runtime parameter initializer", prefix: 'const typed = (amount = ("bad" as unknown as number)) => amount;', expression: "typed()", proven: false },
    { name: "satisfies operand", prefix: 'const typed = (() => ("bad" as unknown as number)) satisfies (() => number);', expression: "typed()", proven: false },
    { name: "nonnull operand", prefix: 'const typed = (() => ("bad" as unknown as number))!;', expression: "typed()", proven: false },
    { name: "uncaught literal Error guard", prefix: 'const typed = (input: string) => { if (!input) throw new Error("Missing context"); return Number(input); };', expression: "typed(input)", proven: true },
    { name: "caught Error guard", prefix: 'const typed = (input: string) => { try { throw new Error("Missing context"); } catch { return ("bad" as unknown as number); } };', expression: "typed(input)", proven: false },
    { name: "finally returns claimed data", prefix: 'const typed = (input: string) => { try { throw new Error("Missing context"); } finally { return ("bad" as unknown as number); } };', expression: "typed(input)", proven: false },
    { name: "assertion on successful return", prefix: 'const typed = (input: string) => { if (!input) throw new Error("Missing context"); return ("bad" as unknown as number); };', expression: "typed(input)", proven: false },
    { name: "throw operand mutates returned state", prefix: 'const state = { amount: 0 }; const typed = () => { try { throw new Error((state.amount = "bad" as unknown as number, "failure")); } catch {} return state.amount; };', expression: "typed()", proven: false },
    { name: "caller catches aliased throw mutation", prefix: 'const state = { amount: 0 }; function fail(box: { amount: number }) { throw new Error((box.amount = "bad" as unknown as number, "failure")); } const typed = () => { try { fail(state); } catch {} return state.amount; };', expression: "typed()", proven: false },
    { name: "Error global writer guard", prefix: 'globalThis.Error = (function () {}) as unknown as ErrorConstructor; const typed = (input: string) => { if (!input) throw new Error("Missing context"); return Number(input); };', expression: "typed(input)", proven: false },
    { name: "Error aliased global writer guard", prefix: 'const globals = globalThis; globals.Error = (function () {}) as unknown as ErrorConstructor; const typed = (input: string) => { if (!input) throw new Error("Missing context"); return Number(input); };', expression: "typed(input)", proven: false },
    { name: "nonliteral Error guard", prefix: 'const message = "Missing context"; const typed = (input: string) => { if (!input) throw new Error(message); return Number(input); };', expression: "typed(input)", proven: false },
    { name: "Error data value remains unproven", prefix: "", expression: "new Error(input).message.length", proven: false },
    { name: "Set global writer", prefix: "globalThis.Set = (() => ({})) as unknown as SetConstructor;", expression: "new Set([input]).size", proven: false },
    { name: "immutable undefined alias reset", prefix: 'let pending: string | undefined = undefined; pending = "changed";', expression: "input === undefined ? 0 : Number(input)", proven: true },
    { name: "shadowed mutable undefined", prefix: 'let undefined: unknown = "shadow"; undefined = 42;', expression: "undefined === null ? 0 : Number(input)", proven: false },
    { name: "shadowed mutable Number", prefix: "let Number = (_input: string): number => 0;", expression: "Number(input)", proven: false },
    { name: "reassigned Number", prefix: "Number = ((input: unknown) => input) as NumberConstructor;", expression: "Number(input)", proven: false },
    { name: "Number method writer", prefix: "Number.isSafeInteger = () => true;", expression: "Number(input)", proven: false },
    { name: "globalThis Number writer", prefix: "globalThis.Number = ((input: unknown) => input) as NumberConstructor;", expression: "Number(input)", proven: false },
    { name: "globalThis alias writer", prefix: "const globals = globalThis; globals.Number = ((input: unknown) => input) as NumberConstructor;", expression: "Number(input)", proven: false },
    { name: "constructor property alias writer", prefix: "const ctor = globalThis.Number; ctor.isSafeInteger = () => true;", expression: "Number(input)", proven: false },
    { name: "computed global Number writer", prefix: 'globalThis["Number"] = ((input: unknown) => input) as NumberConstructor;', expression: "Number(input)", proven: false },
    { name: "destructured constructor writer", prefix: "const { Number: ctor } = globalThis; ctor.isSafeInteger = () => true;", expression: "Number(input)", proven: false },
    { name: "direct eval native writer", prefix: 'eval("Number.isSafeInteger = () => true");', expression: "Number(input)", proven: false },
    { name: "constructor passed to writer", prefix: "function corrupt(ctor: NumberConstructor) { ctor.isSafeInteger = () => true; } corrupt(Number);", expression: "Number(input)", proven: false },
    { name: "spoofed native declaration", prefix: 'import { Number } from "./lib.spoof";', expression: "Number(input)", proven: false },
    { name: "asserted argument", prefix: "", expression: "Number(input as any)", proven: false },
  ];
  const parent = path.resolve("scripts/contractSkew/__fixtures__");
  let dir: string | undefined;
  const fixtureDirectory = () => {
    if (dir) return dir;
    dir = mkdtempSync(path.join(parent, "native-proof-"));
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "esnext", lib: ["ES2022"], types: [], strict: true }, include: ["*.ts"] }));
    writeFileSync(path.join(dir, "lib.spoof.d.ts"), "export declare var Number: NumberConstructor;\n");
    return dir;
  };
  afterAll(() => {
    if (!dir) return;
    if (path.dirname(dir) !== parent) throw new Error("Unexpected native fixture directory");
    rmSync(dir, { recursive: true, force: true });
  });
  test.each(cases)("$name retains native proof or source uncertainty", (control) => {
    if (control.name === "runtime class heritage") {
      expect(ts.transpileModule(control.prefix, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).toContain("class extends Ctor");
    }
    const fixtureDir = fixtureDirectory();
    const file = path.join(fixtureDir, `${control.name.replaceAll(/[^a-zA-Z]/g, "")}.ts`);
    writeFileSync(file, `export {};\n${control.prefix}\n
      declare function useMutation(fn: unknown): (args: unknown) => unknown;
      declare const api: Record<string, Record<string, unknown>>;
      function parse(input: string): number { return ${control.expression}; }
      export function send(input: string) {
        const mutate = useMutation(api.nativeProof.send);
        const amount = parse(input);
        return mutate({ amount, knownBad: null });
      }`);
    let config = path.join(fixtureDir, "tsconfig.json");
    if (control.name === "metadata mode remains unproven") {
      config = path.join(fixtureDir, "metadata-tsconfig.json");
      writeFileSync(config, JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } }));
    }
    const extraction = extractClientCalls([file], config);
    expect(extraction.calls).toHaveLength(1);
    const call = extraction.calls[0];
    const payload = call.payload;
    if (payload?.kind !== "object") throw new Error("Literal payload shape was lost");
    expect(payload.fields.get("amount")?.node.kind).toBe(control.proven ? "scalar" : "assertion");
    const compared = compareNode(payload, validatorTree({ type: "object", value: {
      amount: { fieldType: { type: "number" }, optional: false },
    } }), "", { site: { identifier: call.identifier, file: call.file, line: call.line } });
    expect(compared.findings.some((finding) => finding.severity === "BREAKING" && finding.path === "knownBad")).toBe(true);
    expect(compared.findings.some((finding) => finding.severity === "TYPE_UNKNOWN" && finding.path === "amount")).toBe(!control.proven);
  }, 120_000);
});

describe("SCRUM-711 object-union correlations", () => {
  const cases = [
    { name: "two valid shapes", type: "Good", breaking: false, unknown: false },
    { name: "wrong discriminator sibling", type: 'Good | { kind: "C"; amount: number }', breaking: true, unknown: false },
    { name: "crossed fields sibling", type: 'Good | { kind: "A"; label: string }', breaking: true, unknown: false },
    { name: "extra key sibling", type: 'Good | { kind: "A"; amount: number; extra: number }', breaking: true, unknown: false },
    { name: "null sibling", type: "Good | null", breaking: true, unknown: false },
    { name: "nullable required value sibling", type: 'Good | { kind: "A"; amount: number | null }', breaking: true, unknown: false },
    { name: "unknown sibling", type: "Good | T", breaking: false, unknown: true },
    { name: "unknown does not hide invalid sibling", type: 'Good | T | { kind: "C"; amount: number }', breaking: true, unknown: true },
  ];
  const native = v.object({ rows: v.array(v.union(
    v.object({ kind: v.literal("A"), amount: v.number() }),
    v.object({ kind: v.literal("B"), label: v.string() }),
  )) });
  if (!("json" in native)) throw new Error("Native closed union metadata unavailable");
  const validator = validatorTree(native.json);
  const parent = path.resolve("scripts/contractSkew/__fixtures__");
  let dir: string | undefined;
  let extracted: ReturnType<typeof extractClientCalls> | undefined;
  const controls = () => {
    if (extracted) return extracted;
    dir = mkdtempSync(path.join(parent, "union-proof-"));
    const config = path.join(dir, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "esnext", lib: ["ES2022"], types: [], strict: true }, include: ["*.ts"] }));
    const file = path.join(dir, "cases.ts");
    writeFileSync(file, `export {};
      declare function useMutation(fn: unknown): (args: unknown) => unknown;
      declare const api: Record<string, Record<string, unknown>>;
      type Good = { kind: "A"; amount: number } | { kind: "B"; label: string };
      ${cases.map((control, index) => `export function send${index}<T>(rows: (${control.type})[]) {
        const send = useMutation(api.unionProof.case${index}); return send({ rows });
      }`).join("\n")}`);
    return extracted = extractClientCalls([file], config);
  };
  afterAll(() => {
    if (!dir) return;
    if (path.dirname(dir) !== parent) throw new Error("Unexpected union fixture directory");
    rmSync(dir, { recursive: true, force: true });
  });
  test.each(cases.map((control, index) => ({ ...control, index })))("$name preserves every closed-union obligation", (control) => {
    const calls = controls().calls.filter((call) => call.identifier === `unionProof:case${control.index}`);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call.payload) throw new Error("Union payload not measured");
    const compared = compareNode(call.payload, validator, "", { site: { identifier: call.identifier, file: call.file, line: call.line } });
    expect(compared.findings.some((finding) => finding.severity === "BREAKING")).toBe(control.breaking);
    expect(compared.findings.some((finding) => finding.severity.endsWith("UNKNOWN"))).toBe(control.unknown);
    if (!control.breaking && !control.unknown) expect(compared.findings).toEqual([]);
  });
});

describe("REAL TypeChecker -> extractor -> comparator, at a v.id() path", () => {
  /**
   * ⚠️ THE DIRECT COMPARATOR FIXTURES CANNOT PROVE THIS ON THEIR OWN.
   *
   * `contractTree.test.ts` builds `variants([literal(null), scalar(string)])`
   * BY HAND and asserts the verdict. That proves the rule, not that the
   * extractor ever produces the shape the rule was written for. This block runs
   * the real TypeScript program over a real `!` call site and feeds whatever
   * comes out into the real comparator, so the two halves are joined by
   * evidence rather than by assumption.
   */
  const idField = (fieldType: unknown) => ({
    type: "object",
    value: { orgId: { fieldType, optional: false } },
  });
  const callOf = (identifier: string) => {
    const call = forFn(identifier)[0];
    expect(call, `fixture call ${identifier} did not extract`).toBeDefined();
    return call;
  };
  const beginCount = () => callOf("cashDrawer:beginCount");
  const compareFor = (identifier: string, validatorSpec: unknown) => {
    const call = callOf(identifier);
    expect(call.payload, `${identifier} resolved no payload`).not.toBeNull();
    const payload = call.payload as unknown as Parameters<typeof compareNode>[0];
    return compareNode(payload, validatorTree(validatorSpec), "", {
      site: { identifier: call.identifier, file: call.file ?? "", line: call.line },
    });
  };
  const compareCall = (validatorSpec: unknown) => {
    const call = beginCount();
    // The fixture always resolves a payload; assert it rather than coerce, so a
    // future fixture change fails loudly instead of comparing against nothing.
    expect(call.payload, "CASE 13 resolved no payload").not.toBeNull();
    // The `Node` shim at the top of this file is deliberately looser than the
    // comparator's `ClientNode` (it exists to poke at extracted trees), so the
    // two have to be bridged. The VALUE is the real extractor output either way.
    const payload = call.payload as unknown as Parameters<typeof compareNode>[0];
    // `file` is optional on the shim but required on a Finding — a finding
    // nobody can locate is not usable, which is why the real type demands it.
    expect(call.file, "CASE 13 produced a call with no file").toBeTruthy();
    return compareNode(payload, validatorTree(validatorSpec), "", {
      site: { identifier: call.identifier, file: call.file ?? "", line: call.line },
    });
  };

  test("the extractor keeps `!` uncertainty on only the erased alternative and keeps the table", () => {
    // ⚠️ THE CONTROL FOR EVERYTHING BELOW. If `!` were honoured the payload
    // would be a plain id, the verdict tests would pass for the wrong reason,
    // and the rule under test would never be exercised. If the node were not
    // MARKED, the same shape would be BREAKING instead of UNKNOWN.
    const orgId = entryAt(beginCount().payload, "orgId");
    expect(orgId, "orgId did not resolve").toBeDefined();
    const node = orgId!.node as unknown as {
      kind: string;
      nodes: { kind: string; effect?: string; node?: Node; tables?: Set<string>; values?: Set<unknown> }[];
    };
    expect(node.kind).toBe("variants");
    const erased = node.nodes.find((n) => n.kind === "assertion" && n.effect === "NON_NULL_ERASURE");
    expect(erased, "the `!` was not recorded on the erased alternative").toBeDefined();
    expect([...(erased?.node?.values ?? [])]).toContain(null);
    expect(node.nodes.some((n) => n.kind === "id" && [...(n.tables ?? [])].includes("organizations"))).toBe(true);
  });

  test("a PROVEN SAME-TABLE id is clean through the real extractor", () => {
    // The baseline. Without it, "cross-table is BREAKING" below could pass
    // simply because every id was being refused.
    const result = compareFor("cashDrawer:approveVariance", {
      type: "object",
      value: { orgId: { fieldType: { type: "id", tableName: "organizations" }, optional: false } },
    });
    expect(result.findings).toHaveLength(0);
  });

  test("a PROVEN CROSS-TABLE id is BREAKING through the real extractor", () => {
    const result = compareFor("collections:depositCheque", {
      type: "object",
      value: { orgId: { fieldType: { type: "id", tableName: "organizations" }, optional: false } },
    });
    const breaking = result.findings.filter((f) => f.severity === "BREAKING");
    expect(breaking).toHaveLength(1);
    expect(breaking[0].detail).toContain("different table");
  });

  test("`raw as OrgId` is NOT promoted to table-qualified proof", () => {
    // ⚠️ An assertion changes TypeScript's view, not the transmitted value. If
    // the extractor took the ASSERTED type it would read this as a proven
    // organizations id and report CLEAN — manufacturing provenance out of a
    // cast.
    const result = compareFor("collections:clearCheque", {
      type: "object",
      value: { orgId: { fieldType: { type: "id", tableName: "organizations" }, optional: false } },
    });
    expect(result.findings.filter((f) => f.severity === "BREAKING")).toHaveLength(0);
    expect(result.findings, "an asserted id must not go silent").toHaveLength(1);
    expect(result.findings[0].severity).toBe("TYPE_UNKNOWN");
    expect(result.findings[0].detail).toContain("NOT verified");
  });

  test("against a BARE v.id() it is UNKNOWN — no fabricated outage, no false pass", () => {
    const result = compareCall(idField({ type: "id", tableName: "organizations" }));
    expect(result.findings.filter((f) => f.severity === "BREAKING")).toHaveLength(0);
    expect(result.findings.length, "silence here would be the false PASS").toBeGreaterThan(0);
    expect(result.findings[0].severity).toBe("TYPE_UNKNOWN");
  });

  test("against v.union(v.id(), v.null()) it is CLEAN", () => {
    const result = compareCall(
      idField({ type: "union", value: [{ type: "id", tableName: "organizations" }, { type: "null" }] })
    );
    expect(result.findings).toHaveLength(0);
  });
});
