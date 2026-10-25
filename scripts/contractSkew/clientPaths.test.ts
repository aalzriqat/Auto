import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { convexToJson, v } from "convex/values";
import { mutationGeneric } from "convex/server";
import { extractClientCalls } from "./clientPaths.mjs";
import { CLIENT_SURFACES, listSurfaceFiles } from "./clientFiles.mjs";
import { compareNode, validatorTree } from "./contractTree.mjs";
import { assertRegisteredOpeningProof } from "../../test-utils/contractSkew/registeredOpeningProof";

/** Compiler inputs only: never materialize them inside source/coverage discovery.
 * Delegate real imports and default-library files to the installed native host.
 * https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API */
function virtualProgram(sources: ReadonlyMap<string, string>, overrides?: ts.CompilerOptions,
  rootNames: readonly string[] = [...sources.keys()]): ts.Program {
  const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  }));
  const options = { ...(overrides ?? parsed.options), noEmit: true };
  const key = (file: string) => {
    const absolute = path.resolve(file);
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  };
  const virtual = new Map([...sources].map(([file, text]) => [key(file), text]));
  const directories = new Set<string>();
  for (const file of sources.keys()) {
    let directory = path.dirname(path.resolve(file));
    while (!directories.has(key(directory))) {
      directories.add(key(directory));
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const host = ts.createCompilerHost(options);
  const { readFile, fileExists, directoryExists, getSourceFile } = host;
  host.readFile = (file) => virtual.get(key(file)) ?? readFile(file);
  host.fileExists = (file) => virtual.has(key(file)) || fileExists(file);
  host.directoryExists = (directory) => directories.has(key(directory)) || Boolean(directoryExists?.(directory));
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = virtual.get(key(file));
    return text === undefined ? getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(file, text, languageVersion, true);
  };
  host.writeFile = () => { throw new Error("Virtual compiler controls must never emit files"); };
  return ts.createProgram({ rootNames, options, host });
}

const isolatedCompilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  lib: ["lib.es2022.d.ts"], types: [], strict: true,
};

describe("local const primitive fallthrough proof", () => {
  test("a direct negative typeof guard proves the transmitted primitive against native metadata", () => {
    const file = path.resolve("components/__virtual_contract_controls__/typeof/direct.ts");
    const source = `declare function useMutation(fn: unknown): (args: unknown) => unknown;
      declare const api: Record<string, Record<string, unknown>>;
      declare function read(): unknown;
      const send = useMutation(api.guardProof.direct);
      export async function run() {
        const value = read();
        if (typeof value !== "string") { return; }
        await send({ value });
      }`;
    const extracted = extractClientCalls([file], "tsconfig.json", {
      program: virtualProgram(new Map([[file, source]]), isolatedCompilerOptions),
    });
    expect(extracted.calls).toHaveLength(1);
    const call = extracted.calls[0];
    if (!call.payload) throw new Error("Primitive payload not extracted");
    const native = v.object({ value: v.string() });
    if (!("json" in native)) throw new Error("Native validator metadata unavailable");
    const compared = compareNode(call.payload, validatorTree(native.json), "", { site: { identifier: call.identifier, file: call.file, line: call.line } });
    expect(compared.findings).toEqual([]);
  });

  const cases = [
    { name: "explicit property and returning message block", clean: true, body: 'const value = read(); if (typeof value !== "string") { note(); return; } send({ value: value });' },
    { name: "OR leaves and first awaited try call", clean: true, body: 'const value = read(); const other = read(); if ((typeof value !== "string") || typeof other !== "number" || false) return; try { await send({ value }); } catch {}' },
    { name: "number is broad only", clean: true, number: true, body: 'const value = read(); if (typeof value !== "number") return; await send({ value });' },
    { name: "intervening unknown effects cannot change const", clean: true, body: 'const value = read(); if (typeof value !== "string") return; await note(); try { await send({ value }); } catch {}' },
    { name: "OR ignores unrelated non-type leaves", clean: true, body: 'const value = read(); if (typeof value !== "string" || !value.length || (false && true)) return; try { await send({ value }); } catch {}' },
    { name: "caught guard cannot resume into proof", wrong: true, values: [17], body: 'const value = read(); try { if (typeof value !== "string") { throw new Error("bad"); } } catch {} await send({ value });' },
    { name: "caught return expression", wrong: true, values: [17], body: 'const value = read(); try { if (typeof value !== "string") return fail(); } catch {} await send({ value });' },
    { name: "finally overrides guard return", wrong: true, values: [17], body: 'const value = read(); try { if (typeof value !== "string") return; } finally { await send({ value }); }' },
    { name: "call in catch", body: 'const value = read(); if (typeof value !== "string") return; try { fail(); } catch { await send({ value }); }' },
    { name: "call in finally", body: 'const value = read(); if (typeof value !== "string") return; try {} finally { await send({ value }); }' },
    { name: "shadowed value", wrong: true, values: ["safe", 17], body: 'const value = read(); if (typeof value !== "string") return; { const value = read(); await send({ value }); }' },
    { name: "let reassignment", wrong: true, values: ["safe", 17], body: 'let value = read(); if (typeof value !== "string") return; value = read(); await send({ value });' },
    { name: "imported binding", body: 'if (typeof foreign !== "string") return; await send({ value: foreign });' },
    { name: "repeated getter", wrong: true, values: ["safe", 17], body: 'const box = { get value() { return read(); } }; if (typeof box.value !== "string") return; await send({ value: box.value });' },
    { name: "copied earlier payload", wrong: true, values: ["safe", 17], body: 'const value = read(); const payload = { value: read() }; if (typeof value !== "string") return; await send(payload);' },
    { name: "overwritten payload", wrong: true, values: ["safe", 17], body: 'const value = read(); const payload = { value }; if (typeof value !== "string") return; payload.value = read(); await send(payload);' },
    { name: "nested transmitted call", body: 'const value = read(); if (typeof value !== "string") return; await wrap(send({ value }));' },
    { name: "AND is not OR fallthrough", wrong: true, values: [17], body: 'const value = read(); if (typeof value !== "string" && false) return; await send({ value });' },
    { name: "nested callback", body: 'const value = read(); if (typeof value !== "string") return; await wrap(async () => { await send({ value }); });' },
    { name: "nonfirst try call", body: 'const value = read(); if (typeof value !== "string") return; try { note(); await send({ value }); } catch {}' },
    { name: "asserted initializer", body: 'const value = read() as string; if (typeof value !== "string") return; await send({ value });' },
    { name: "non-null asserted initializer", body: 'const value = read()!; if (typeof value !== "string") return; await send({ value });' },
    { name: "ambient declaration is not a runtime const", wrong: true, body: 'declare const value: unknown = read(); if (typeof value !== "string") return; erase(); await send({ value });' },
    { name: "asserted transmitted expression", body: 'const value = read(); if (typeof value !== "string") return; await send({ value: value as string });' },
    { name: "duplicate property", wrong: true, values: ["safe", 17], body: 'const value = read(); if (typeof value !== "string") return; await send({ value, value: read() });' },
    { name: "spread literal", body: 'const value = read(); if (typeof value !== "string") return; await send({ value, ...extra() });' },
    { name: "computed property", body: 'const value = read(); if (typeof value !== "string") return; await send({ ["value"]: value });' },
    { name: "literal getter", wrong: true, values: ["safe", 17], body: 'const value = read(); if (typeof value !== "string") return; await send({ get value() { return read(); } });' },
    { name: "nonexiting guard", wrong: true, values: [17], body: 'const value = read(); if (typeof value !== "string") { note(); } await send({ value });' },
    { name: "conflicting primitive facts", body: 'const value = read(); if (typeof value !== "string" || typeof value !== "number") return; await send({ value });' },
    { name: "dynamic eval", body: 'const value = read(); if (typeof value !== "string") return; eval(""); await send({ value });' },
    { name: "guard checks a different value symbol", wrong: true, values: [17, "safe"], body: 'const value = read(); const other = read(); if (typeof other !== "string") return; await send({ value });' },
    { name: "negated positive condition", body: 'const value = read(); if (!(typeof value === "string")) return; await send({ value });' },
  ];
  const file = path.resolve("components/__virtual_contract_controls__/typeof/adversarial.ts");
  const foreignFile = path.resolve("components/__virtual_contract_controls__/typeof/foreign.ts");
  const source = `import { foreign } from "./foreign";
    declare function useMutation(fn: unknown): (args: unknown) => unknown;
    declare const api: Record<string, Record<string, unknown>>;
    declare function read(): unknown;
    declare function note(): void;
    declare function fail(): never;
    declare function wrap(value: unknown): unknown;
    declare function extra(): Record<string, unknown>;
    declare function erase(): void;
    ${cases.map((control, index) => `const send${index} = useMutation(api.guardProof.case${index});
      export async function run${index}() { ${control.body.replaceAll('send(', `send${index}(`)} }`).join("\n")}`;
  let observed: ReturnType<typeof extractClientCalls> | undefined;
  const calls = () => observed ??= extractClientCalls([file], "tsconfig.json", {
    program: virtualProgram(new Map([[file, source], [foreignFile, 'declare function read(): unknown; export const foreign = read();']]), isolatedCompilerOptions),
  });
  test.each(cases.map((control, index) => ({ ...control, index })))("$name retains the exact primitive boundary", control => {
    const matches = calls().calls.filter(call => call.identifier === `guardProof:case${control.index}`);
    expect(matches).toHaveLength(1);
    const call = matches[0];
    if (!call.payload) throw new Error("Adversarial payload not measured");
    const native = v.object({ value: control.number ? v.number() : v.string() });
    if (!("json" in native)) throw new Error("Native primitive metadata unavailable");
    const findings = compareNode(call.payload, validatorTree(native.json), "", { site: { identifier: call.identifier, file: call.file, line: call.line } }).findings;
    if (control.clean) expect(findings).toEqual([]);
    else expect(findings.some(finding => finding.severity.endsWith("UNKNOWN") || finding.severity === "BREAKING")).toBe(true);
    if (control.clean && !control.number) {
      for (const stronger of [v.id("users"), v.literal("ONLY_ALLOWED")]) {
        const domain = v.object({ value: stronger });
        if (!("json" in domain)) throw new Error("Native stronger metadata unavailable");
        expect(compareNode(call.payload, validatorTree(domain.json), "", { site: { identifier: call.identifier, file: call.file, line: call.line } }).findings.length).toBeGreaterThan(0);
      }
    }
  });
  test.each(cases.filter(control => control.wrong))("$name actually transmits a wrong runtime primitive", async control => {
    const sent: Array<{ value: unknown }> = [];
    const values = [...(control.values ?? [])];
    let ambientValue: unknown = "safe";
    const code = ts.transpileModule(`(async () => { ${control.body} })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    await runInNewContext(code, { read: () => values.shift(), send: (value: { value: unknown }) => { sent.push(value); },
      note: () => {}, fail: () => { throw new Error("Caught failure"); }, wrap: (value: unknown) => value,
      get value() { return ambientValue; }, erase: () => { ambientValue = 17; } });
    expect(sent).toHaveLength(1);
    expect(typeof sent[0].value).not.toBe("string");
  });
});

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
    const file = path.resolve("components/__virtual_contract_controls__/broken.ts");
    const program = virtualProgram(new Map([[file, 'export const n: number = "not a number";\n']]));
    const extraction = extractClientCalls([file], "tsconfig.json", { program });
    expect(typeof Object.getOwnPropertyDescriptor(extraction, "diagnosticsCount")?.get).toBe("function");
    expect(extraction.diagnosticsCount).toBeGreaterThanOrEqual(1);
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
    { name: "native imported alias", source: replace('import { useMemo }', 'import { useMemo as nativeMemo }').replaceAll('useMemo(', 'nativeMemo('), extracts: true },
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
  const parent = path.resolve("components/__virtual_contract_controls__/picker");
  const files = cases.map((_control, index) => path.join(parent, `control${index}.tsx`));
  const spoof = path.join(parent, "lib.spoof.d.ts");
  const sources = new Map([[spoof, "export declare const Object: ObjectConstructor;\n"],
    ...cases.map((control, index): [string, string] => [files[index], control.source])]);
  let extracted: ReturnType<typeof extractClientCalls> | undefined;
  let evalExtraction: ReturnType<typeof extractClientCalls> | undefined;
  let controlProgram: ts.Program | undefined;
  const controls = () => {
    if (extracted) return extracted;
    const sharedFiles = files.filter((_file, index) => cases[index].name !== "direct eval writer");
    controlProgram = virtualProgram(new Map([...sources].filter(([file]) => file === spoof || sharedFiles.includes(file))));
    return extracted = extractClientCalls(sharedFiles, "tsconfig.json", { program: controlProgram });
  };
  test("compiler controls leave the production and covered-source inventories unchanged", () => {
    const web = CLIENT_SURFACES.find((surface) => surface.name === "web");
    if (!web) throw new Error("Actual CLI web surface is unavailable");
    // The extended inventory also covers scripts/**/*.ts, the native coverage
    // producer's scope that previously captured deleted picker-proof sources.
    const covered = { ...web, dirs: [...web.dirs, "scripts"] };
    const before = [listSurfaceFiles(process.cwd(), web), listSurfaceFiles(process.cwd(), covered)];
    controls();
    expect([listSurfaceFiles(process.cwd(), web), listSurfaceFiles(process.cwd(), covered)]).toEqual(before);
    expect(files.every((file) => !existsSync(file))).toBe(true);
    expect(existsSync(spoof)).toBe(false);
    if (!controlProgram) throw new Error("Virtual compiler controls were not constructed");
    const spoofSource = controlProgram.getSourceFile(spoof);
    if (!spoofSource) throw new Error("Virtual spoof module was not resolved");
    expect(spoofSource.isDeclarationFile).toBe(true);
    expect(controlProgram.isSourceFileDefaultLibrary(spoofSource)).toBe(false);
    expect(controlProgram.getSourceFiles().some((source) => source.fileName.endsWith("lib.es5.d.ts") &&
      controlProgram?.isSourceFileDefaultLibrary(source))).toBe(true);
  }, 120_000);
  test.each(cases.map((control, index) => ({ ...control, index })))("$name preserves proof or refusal", (control) => {
    controls();
    const extraction = control.name === "direct eval writer"
      ? evalExtraction ??= extractClientCalls([files[control.index]], "tsconfig.json", {
        program: virtualProgram(new Map([[files[control.index], control.source]])),
      })
      : controls();
    const inFile = (file: string) => path.resolve(file) === files[control.index];
    const calls = extraction.calls.filter((call) => inFile(call.file) && call.identifier === "vehicleAvailability:pickerAvailability");
    expect(calls).toHaveLength(control.extracts ? 1 : 0);
    if (!control.extracts) {
      const source = ts.createSourceFile(files[control.index], control.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const requestMap = ts.forEachChild(source, function find(node): ts.Expression | undefined {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useQueries") {
          return node.arguments[0];
        }
        return ts.forEachChild(node, find);
      });
      if (!requestMap) throw new Error("Actual useQueries request map is unavailable");
      const at = source.getLineAndCharacterOfPosition(requestMap.getStart(source));
      const mapSiteId = `${path.relative(process.cwd(), files[control.index]).replaceAll("\\", "/")}:${at.line + 1}:${at.character + 1}`;
      expect(extraction.unresolvedBinders.filter((binder) => inFile(binder.file)).map(({ cause, mapSiteId }) => ({ cause, mapSiteId })))
        .toEqual([{ cause: "DYNAMIC_REQUEST_MAP", mapSiteId }]);
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
  test("both actual opening routes measure their full allocation arrays against their registered native arguments (focused)", async () => {
    const web = CLIENT_SURFACES.find((surface) => surface.name === "web");
    if (!web) throw new Error("Actual CLI web surface is unavailable");
    const files = ["components/accounting/setup/OpeningBalanceCard.tsx"];
    const extraction = extractClientCalls(files, web.tsconfig);
    await assertRegisteredOpeningProof(extraction, files, false);
  }, 120_000);

  const cases = [
    { name: "Number", prefix: "", expression: "Number(input)", proven: true },
    { name: "immutable native alias", prefix: "const convert = Number;", expression: "convert(input)", proven: true },
    { name: "initialized typed callable", prefix: "const convert: (input: string) => number = input => Number(input);", expression: "convert(input)", proven: true },
    { name: "implemented overload", prefix: "function convert(input: string): number; function convert(input: string) { return Number(input); }", expression: "convert(input)", proven: true },
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
  const parent = path.resolve("components/__virtual_contract_controls__/native");
  test.each(cases)("$name retains native proof or source uncertainty", (control) => {
    if (control.name === "runtime class heritage") {
      expect(ts.transpileModule(control.prefix, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).toContain("class extends Ctor");
    }
    const file = path.join(parent, `${control.name.replaceAll(/[^a-zA-Z]/g, "")}.ts`);
    const source = `export {};\n${control.prefix}\n
      declare function useMutation(fn: unknown): (args: unknown) => unknown;
      declare const api: Record<string, Record<string, unknown>>;
      function parse(input: string): number { return ${control.expression}; }
      export function send(input: string) {
        const mutate = useMutation(api.nativeProof.send);
        const amount = parse(input);
        return mutate({ amount, knownBad: null });
      }`;
    const program = virtualProgram(new Map([
      [file, source], [path.join(parent, "lib.spoof.d.ts"), "export declare var Number: NumberConstructor;\n"],
    ]), { ...isolatedCompilerOptions, ...(control.name === "metadata mode remains unproven"
      ? { experimentalDecorators: true, emitDecoratorMetadata: true } : {}) });
    const extraction = extractClientCalls([file], "tsconfig.json", { program });
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

describe("SCRUM-711 declaration-only callable returns", () => {
  const declarations = [
    { name: "constSignature", declaration: "export declare const convert: (input: string) => number;", expression: "shim.convert('bad')" },
    { name: "ambientFunction", declaration: "export declare function convert(input: string): number;", expression: "shim.convert('bad')" },
    { name: "typeAlias", declaration: "type Convert = (input: string) => number; export declare const convert: Convert;", expression: "shim.convert('bad')" },
    { name: "interfaceCallable", declaration: "interface Convert { (input: string): number } export declare const convert: Convert;", expression: "shim.convert('bad')" },
    { name: "method", declaration: "export declare const service: { convert(input: string): number };", expression: "shim.service.convert('bad')" },
    { name: "readonlyCallable", declaration: "export declare const service: { readonly convert: (input: string) => number };", expression: "shim.service.convert('bad')" },
    { name: "immutableAlias", declaration: "export declare const convert: (input: string) => number;", expression: "(() => { const copied = shim.convert; return copied('bad'); })()" },
    { name: "ambientFactory", declaration: "export declare function factory(): (input: string) => number;", expression: "shim.factory()('bad')" },
    { name: "objectWrapper", declaration: "export declare const convert: (input: string) => number;", expression: "(() => { const wrapped = { convert: shim.convert }; return wrapped.convert('bad'); })()" },
  ];
  test.each(declarations)("$name cannot certify a lying declaration's runtime value", (control) => {
    const directory = path.resolve("components/__virtual_contract_controls__/callable", control.name);
    const file = path.join(directory, "caller.ts");
    const program = virtualProgram(new Map([
      [path.join(directory, "shim.d.ts"), control.declaration],
      [file, `import * as shim from './shim';
        declare function useMutation(fn: unknown): (args: unknown) => unknown;
        declare const api: { callable: { send: unknown } };
        const send = useMutation(api.callable.send);
        send({ amount: ${control.expression}, knownBad: null });`],
    ]), isolatedCompilerOptions);
    const runtime: unknown = runInNewContext("(() => { const shim = { convert: () => null, service: { convert: () => null }, factory: () => () => null }; return " + control.expression + "; })()");
    expect(runtime).toBeNull();
    if (runtime !== null) throw new Error("Counterexample runtime did not produce null");
    expect(convexToJson({ amount: runtime })).toEqual({ amount: null });
    const native = mutationGeneric({ args: { amount: v.number() }, handler: (_ctx, args) => args.amount });
    if (!("exportArgs" in native) || typeof native.exportArgs !== "function") throw new Error("Native numeric argument export unavailable");
    const rendered: unknown = native.exportArgs();
    if (typeof rendered !== "string") throw new Error("Native numeric argument export is not JSON text");
    const validator = validatorTree(JSON.parse(rendered));
    const extraction = extractClientCalls([file], "tsconfig.json", { program });
    expect(extraction.calls).toHaveLength(1);
    const call = extraction.calls[0];
    if (!call.payload) throw new Error("Callable payload was not measured");
    const compared = compareNode(call.payload, validator, "", { site: { identifier: call.identifier, file: call.file, line: call.line } });
    expect(compared.findings.some((finding) => finding.path === "knownBad" && finding.severity === "BREAKING")).toBe(true);
    expect(compared.findings.some((finding) => finding.path === "amount" && finding.severity === "TYPE_UNKNOWN")).toBe(true);
  });

  test.each([
    { name: "any return", contract: "Reader", wide: "any", unknown: true },
    { name: "unknown return", contract: "Reader", wide: "unknown", unknown: true },
    { name: "unchanged number return", contract: "Reader", wide: "number", unknown: false },
    { name: "outer generic constraint", contract: "Constrained", wide: "any", unknown: true },
    { name: "outer generic default", contract: "Defaulted", wide: "any", unknown: true },
    { name: "missing runtime companion", contract: "Reader", wide: "number", unknown: true, missing: true },
    { name: "runtime implementation contradicts declaration", contract: "Reader", wide: "number", unknown: true, runtime: "export const convert = () => null;" },
    { name: "runtime alias with effects", contract: "Reader", wide: "number", unknown: true, runtime: 'import { reader } from "convex/server"; export const convert = reader; Reflect.set(convert, "changed", true);' },
    { name: "factory laundering", contract: "Reader", wide: "number", unknown: true, missing: true, expression: "(() => { const factory = () => convert; return factory()(); })()" },
    { name: "object laundering", contract: "Reader", wide: "number", unknown: true, missing: true, expression: "(() => { const box = { read: convert }; return box.read(); })()" },
  ])("immutable dependency output contract: $name", (control) => {
    const directory = path.resolve("components/__virtual_contract_controls__/generic", control.name);
    const file = path.join(directory, "caller.ts"), runtime = path.join(directory, "shim.js");
    const options: ts.CompilerOptions = { ...isolatedCompilerOptions, allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler, preserveSymlinks: true };
    const resolved = ts.resolveModuleName("convex/server", runtime, options, ts.sys).resolvedModule;
    if (!resolved) throw new Error("Actual dependency location unavailable");
    // Controlled dependency interface at a real installed module location. The
    // compiler computes external ownership; no SourceFile flags are forged.
    const sources = new Map([
      [resolved.resolvedFileName, `export interface Reader<T> { (): T }
        export interface Constrained<C> { <T extends C>(): T }
        export interface Defaulted<C> { <T=C>(): T }
        export declare const reader: ${control.contract}<${control.wide}>;`],
      [path.join(directory, "shim.d.ts"), `import type { ${control.contract} } from "convex/server"; export declare const convert: ${control.contract}<number>;`],
      [file, `import {convert} from './shim'; declare function useMutation(fn:unknown):(args:unknown)=>unknown;
        declare const api:{callable:{send:unknown}}; const send=useMutation(api.callable.send); send({amount:${control.expression ?? "convert()"}});`],
    ]);
    if (!control.missing) sources.set(runtime, control.runtime ?? 'import { reader } from "convex/server"; export const convert = reader;');
    const program = virtualProgram(sources, options, control.missing ? [file] : [file, runtime]);
    const dependency = program.getSourceFile(resolved.resolvedFileName);
    if (!dependency) throw new Error("Controlled dependency interface missing");
    expect(program.isSourceFileFromExternalLibrary(dependency)).toBe(true);
    const checker = program.getTypeChecker(), owned = program.getSourceFile(path.join(directory, "shim.d.ts"));
    if (!owned) throw new Error("Owned declaration missing");
    const importedModule = checker.getSymbolAtLocation(dependency), ownedModule = checker.getSymbolAtLocation(owned);
    if (!importedModule || !ownedModule) throw new Error("Callable module identity missing");
    const imported = checker.getExportsOfModule(importedModule).find((symbol) => symbol.name === "reader");
    const declared = checker.getExportsOfModule(ownedModule).find((symbol) => symbol.name === "convert");
    if (!imported || !declared) throw new Error("Callable exports missing");
    const actualSignatures = checker.getTypeOfSymbolAtLocation(imported, dependency).getCallSignatures();
    const declaredSignatures = checker.getTypeOfSymbolAtLocation(declared, owned).getCallSignatures();
    expect(actualSignatures).toHaveLength(1); expect(declaredSignatures).toHaveLength(1);
    expect(actualSignatures[0].getDeclaration()).toBe(declaredSignatures[0].getDeclaration());
    const call = extractClientCalls([file], "tsconfig.json", { program }).calls[0];
    if (!call?.payload) throw new Error("Generic alias call missing");
    const native = v.object({ amount: v.number() });
    if (!("json" in native)) throw new Error("Native numeric validator rendering unavailable");
    const compared = compareNode(call.payload, validatorTree(native.json), "", { site: { identifier: call.identifier, file: call.file, line: call.line } });
    expect(compared.findings.some((finding) => finding.path === "amount" && finding.severity === "TYPE_UNKNOWN")).toBe(control.unknown);
    if (!control.unknown) expect(compared.findings).toEqual([]);
  });

  test.each(["paths alias", "virtual package", "linked workspace", "module augmentation", "re-export"])("$0 stays source-owned", (kind) => {
    const directory = path.resolve("components/__virtual_contract_controls__/ownership", kind);
    const file = path.join(directory, "caller.ts");
    const options: ts.CompilerOptions = { ...isolatedCompilerOptions, moduleResolution: ts.ModuleResolutionKind.Bundler, preserveSymlinks: true };
    let specifier = "owned-callable", fixture = path.join(directory, "owned.d.ts");
    let declaration = "export declare const convert: (input: string) => number;", expression = "convert('bad')";
    let prefix = "", exported = "convert";
    if (kind === "paths alias") options.paths = { "owned-callable": [fixture] };
    if (kind === "virtual package") { specifier = "__virtual_owned_callable__"; fixture = path.resolve("node_modules", specifier, "index.d.ts"); }
    if (kind === "linked workspace") {
      specifier = "@autoflow/shared";
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      if (!resolved) throw new Error("Actual linked workspace unavailable");
      fixture = resolved.resolvedFileName;
    }
    if (kind === "module augmentation") {
      specifier = "react"; exported = "ownedConverter";
      declaration = 'import "react"; declare module "react" { export function ownedConverter(input: string): number; }';
    }
    if (kind === "re-export") {
      specifier = "./owned"; declaration = 'export { getFunctionName as convert } from "convex/server";';
      prefix = 'import { makeFunctionReference } from "convex/server";';
      expression = "convert(makeFunctionReference('probe:read'))";
    }
    const program = virtualProgram(new Map([[fixture, declaration], [file, `${prefix}
      import { ${exported} as convert } from '${specifier}';
      declare function useMutation(fn:unknown):(args:unknown)=>unknown;
      declare const api:{callable:{send:unknown}}; const send=useMutation(api.callable.send); send({amount:${expression}});`]]),
    options, kind === "module augmentation" ? [file, fixture] : [file]);
    const source = program.getSourceFile(fixture);
    if (!source) throw new Error("Ownership input missing");
    if (kind === "virtual package" || kind === "linked workspace") expect(program.isSourceFileFromExternalLibrary(source)).toBe(true);
    const call = extractClientCalls([file], "tsconfig.json", { program }).calls[0];
    if (!call?.payload) throw new Error("Ownership call missing");
    const native = v.object({ amount: kind === "re-export" ? v.string() : v.number() });
    if (!("json" in native)) throw new Error("Native ownership validator rendering unavailable");
    const compared = compareNode(call.payload, validatorTree(native.json), "", { site: { identifier: call.identifier, file: call.file, line: call.line } });
    expect(compared.findings.some((finding) => finding.path === "amount" && finding.severity === "TYPE_UNKNOWN")).toBe(true);
  });

  test("package exports cannot substitute a decoy declaration-side runtime alias", () => {
    const directory = path.resolve("components/__virtual_contract_controls__/exports"), file = path.join(directory, "caller.ts");
    const packageRoot = path.resolve("node_modules/__virtual_owned_exports__"), declaration = path.join(packageRoot, "types/index.d.ts");
    const decoy = path.join(packageRoot, "types/index.js"), actual = path.join(packageRoot, "runtime/evil.js");
    const options: ts.CompilerOptions = { ...isolatedCompilerOptions, allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler, preserveSymlinks: true };
    const resolved = ts.resolveModuleName("convex/server", file, options, ts.sys).resolvedModule;
    if (!resolved) throw new Error("Actual dependency location unavailable");
    const sources = new Map([
      [resolved.resolvedFileName, "export interface Reader<T> { (): T } export declare const reader: Reader<number>;"],
      [path.join(packageRoot, "package.json"), JSON.stringify({ type: "module", exports: { ".": {
        types: "./types/index.d.ts", default: "./runtime/evil.js",
      } } })],
      [declaration, 'import type {Reader} from "convex/server"; export declare const convert: Reader<number>;'],
      [decoy, 'import {reader} from "convex/server"; export const convert=reader;'],
      [actual, "export const convert=()=>null;"],
      [file, `import {convert} from '__virtual_owned_exports__';
        declare function useMutation(fn:unknown):(args:unknown)=>unknown;
        declare const api:{callable:{send:unknown}}; const send=useMutation(api.callable.send); send({amount:convert()});`],
    ]);
    const program = virtualProgram(sources, options, [file, decoy, actual]);
    expect(program.getSourceFile(declaration)).toBeDefined();
    expect(runInNewContext("(() => null)()")).toBeNull();
    const call = extractClientCalls([file], "tsconfig.json", { program }).calls[0];
    if (!call?.payload) throw new Error("Package export call missing");
    const native = v.object({ amount: v.number() });
    if (!("json" in native)) throw new Error("Native numeric validator rendering unavailable");
    const compared = compareNode(call.payload, validatorTree(native.json), "", { site: { identifier: call.identifier, file: call.file, line: call.line } });
    expect(compared.findings.some((finding) => finding.path === "amount" && finding.severity === "TYPE_UNKNOWN")).toBe(true);
  });
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
  let extracted: ReturnType<typeof extractClientCalls> | undefined;
  const controls = () => {
    if (extracted) return extracted;
    const file = path.resolve("components/__virtual_contract_controls__/union/cases.ts");
    const source = `export {};
      declare function useMutation(fn: unknown): (args: unknown) => unknown;
      declare const api: Record<string, Record<string, unknown>>;
      type Good = { kind: "A"; amount: number } | { kind: "B"; label: string };
      ${cases.map((control, index) => `export function send${index}<T>(rows: (${control.type})[]) {
        const send = useMutation(api.unionProof.case${index}); return send({ rows });
      }`).join("\n")}`;
    return extracted = extractClientCalls([file], "tsconfig.json", {
      program: virtualProgram(new Map([[file, source]]), isolatedCompilerOptions),
    });
  };
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
