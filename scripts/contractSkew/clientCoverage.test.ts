import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { extractClientCalls } from "./clientPaths.mjs";
import { CLIENT_SURFACES, listSurfaceFiles } from "./clientFiles.mjs";

/**
 * SCRUM-178 v2, Codex CS-1 / D-24 (1): shipped Convex calls the v1 extractor
 * never saw. Each case is a call form that exists in the real tree.
 *
 * ⚠️ These ran RED against the unfixed extractor first (see the commit
 * message): `useQueries` was in no hook set, a const function-reference alias
 * was not followed, and binding a hook result to a simple name suppressed the
 * record for a reference nobody resolved.
 */
type ClientNode = {
  kind: string;
  fields?: Map<string, { node: ClientNode }>;
  element?: ClientNode;
  node?: ClientNode;
};
type Call = {
  identifier: string;
  file: string;
  line: number;
  payload: ClientNode | null;
  skipped?: boolean;
  via?: string;
  siteId?: string;
};
type Unresolved = { identifier: string; file: string; line: number; cause: string; siteId?: string };
type ProvedSkip = { file: string; line: number; reason: string; siteId?: string };
type Extraction = {
  calls: Call[];
  unresolvedBinders: Unresolved[];
  provedSkips?: ProvedSkip[];
};

const fixture = (name: string) => `scripts/contractSkew/__fixtures__/census/${name}.tsx`;
const extract = (name: string) => extractClientCalls([fixture(name)], "tsconfig.json") as unknown as Extraction;
const lineOf = (name: string, needle: string) =>
  readFileSync(fixture(name), "utf8").split(/\r?\n/).findIndex((l) => l.includes(needle)) + 1;

const pathsOf = (node: ClientNode | null | undefined, prefix = ""): string[] => {
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

describe("the two shipped forms the v1 detector never saw", () => {
  const out = extract("realForms");

  test("useQueries inside useMemo yields a call with identifier, line and payload paths", () => {
    const call = out.calls.find((c) => c.identifier === "applications:getClosingReadiness");
    expect(call, "the useQueries entry was never extracted").toBeDefined();
    expect(call!.via).toBe("useQueries");
    expect(call!.file.endsWith("realForms.tsx")).toBe(true);
    expect(call!.line).toBe(lineOf("realForms", "readiness: { query:"));
    expect(pathsOf(call!.payload)).toEqual(expect.arrayContaining(["orgId", "applicationId"]));
  });

  test("a const function-reference alias behind `as unknown as` resolves to its identifier", () => {
    const call = out.calls.find((c) => c.identifier === "search:globalSearch");
    expect(call, "the aliased reference was never extracted").toBeDefined();
    expect(call!.via).toBe("useQuery");
    expect(call!.line).toBe(lineOf("realForms", "return useQuery("));
    expect(pathsOf(call!.payload)).toEqual(expect.arrayContaining(["orgId", "query"]));
  });

  test("neither form is left as an unresolved record once it is followed", () => {
    expect(out.unresolvedBinders).toEqual([]);
  });
});

describe("useQueries request maps", () => {
  const out = extract("requestMaps");
  const at = (needle: string) => lineOf("requestMaps", needle);

  test("several entries each become a call", () => {
    const ids = out.calls.map((c) => c.identifier);
    expect(ids).toEqual(expect.arrayContaining(["vehicles:get", "organizations:listMine"]));
    const get = out.calls.find((c) => c.identifier === "vehicles:get")!;
    expect(pathsOf(get.payload)).toEqual(expect.arrayContaining(["orgId", "vehicleId"]));
    expect(get.line).toBe(at("first: { query:"));
  });

  test("an empty map is a PROVED skip, not a call and not unresolved", () => {
    const line = at("return useQueries({});");
    expect(out.provedSkips?.some((s) => s.line === line)).toBe(true);
    expect(out.calls.some((c) => c.line === line)).toBe(false);
    expect(out.unresolvedBinders.some((u) => u.line === line)).toBe(false);
  });

  test("an empty branch beside a real entry still accounts for both", () => {
    const line = at("on ? {} :");
    expect(out.calls.some((c) => c.identifier === "vehicles:list")).toBe(true);
    expect(out.provedSkips?.some((s) => s.line === line)).toBe(true);
  });

  test("a dynamic map is unresolved at its file:line", () => {
    const line = at("return useQueries(requests);");
    const record = out.unresolvedBinders.find((u) => u.line === line);
    expect(record, "a dynamic request map was silently dropped").toBeDefined();
    expect(record!.file.endsWith("requestMaps.tsx")).toBe(true);
  });

  test("a dynamic entry reference is unresolved at its file:line", () => {
    const line = at("api.vehicles[name]");
    expect(out.unresolvedBinders.some((u) => u.line === line)).toBe(true);
  });
});

describe("a binder bound to a simple name never suppresses an unresolved reference", () => {
  const out = extract("escapes");

  test("useQuery(<call>) bound with `const rows =` is still recorded", () => {
    const line = lineOf("escapes", "const rows = useQuery(");
    const record = out.unresolvedBinders.find((u) => u.line === line);
    expect(record, "binding to a simple name hid the unresolved reference").toBeDefined();
    expect(record!.identifier).toBe("<unresolved>");
  });

  test("an alias that is not a literal api path is recorded, not dropped", () => {
    const line = lineOf("escapes", "return useQuery(ref, {});");
    expect(out.unresolvedBinders.some((u) => u.line === line)).toBe(true);
  });
});

describe("packages/shared is a shipped client surface", () => {
  test("it is declared with its own tsconfig", () => {
    const shared = CLIENT_SURFACES.find((s) => s.name === "shared");
    expect(shared, "packages/shared/src is not a client surface").toBeDefined();
    expect(shared!.dirs).toContain("packages/shared/src");
    expect(shared!.tsconfig).toBe("packages/shared/tsconfig.json");
  });

  test("discovery lists its source files", () => {
    const shared = CLIENT_SURFACES.find((s) => s.name === "shared");
    const files = shared ? listSurfaceFiles(process.cwd(), shared) : [];
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => !/\.test\.tsx?$/.test(f))).toBe(true);
  });
});
