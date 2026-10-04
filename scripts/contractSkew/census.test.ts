import { describe, expect, test, vi } from "vitest";

// Type-checking a program is slow; the default 5s is for unit tests.
vi.setConfig({ testTimeout: 180_000 });
import { readFileSync } from "node:fs";
import { createClientProgram, extractClientCalls } from "./clientPaths.mjs";
import { CLIENT_SURFACES, listSurfaceFiles } from "./clientFiles.mjs";
import { ENTRY_TABLE, runCensus, unclassifiedEntryPoints } from "./census.mjs";
import { inventoryConvexEntryPoints } from "./convexInventory.mjs";

/**
 * SCRUM-178 v2, D-24 CS-1(e): an independent census reconciled to the extractor
 * BY SITE IDENTITY.
 */
type Candidate = {
  siteId: string;
  file: string;
  line: number;
  roles: string[];
  disposition: "TRANSMISSION" | "NON_TRANSMISSION" | "UNRESOLVED" | "UNACCOUNTED";
  reason: string;
};
type Census = {
  candidates: Candidate[];
  totals: Record<string, number>;
  unresolved: Candidate[];
  unaccounted: Candidate[];
  orphans: { siteId: string; kind: string }[];
  incomplete: boolean;
};

const fixture = (name: string) => `scripts/contractSkew/__fixtures__/census/${name}.tsx`;
const lineOf = (name: string, needle: string) =>
  readFileSync(fixture(name), "utf8").split(/\r?\n/).findIndex((l) => l.includes(needle)) + 1;

// One type-checked program for every fixture: building a program is the slow
// part (~13s), and the census filters by file anyway.
const FIXTURES = [
  "realForms",
  "requestMaps",
  "escapes",
  "deferred",
  "unrelatedApi",
  "shorthand",
  "elementAccess",
  "aliasChain",
  "aliasChainB",
  "aliasChainRoot",
];
const fixtureFiles = FIXTURES.map(fixture);
let shared: ReturnType<typeof createClientProgram> | undefined;
const sharedProgram = () => (shared ??= createClientProgram(fixtureFiles, "tsconfig.json"));

const censusOf = (names: string[]): Census => {
  const files = names.map(fixture);
  const program = sharedProgram();
  const extraction = extractClientCalls(files, "tsconfig.json", { program });
  return runCensus({ program, files, extraction }) as unknown as Census;
};
const at = (census: Census, name: string, needle: string) =>
  census.candidates.filter((c) => c.file.endsWith(`${name}.tsx`) && c.line === lineOf(name, needle));

describe("the entry-point inventory is derived from the pinned convex package", () => {
  const inventory = inventoryConvexEntryPoints(process.cwd()) as {
    version: string;
    keys: Map<string, string>;
  };

  test("the scan finds the known entry points", () => {
    expect(inventory.keys.size).toBeGreaterThan(30);
    for (const key of ["useQuery", "useMutation", "useQueries", "ConvexReactClient.query", "fetchQuery"]) {
      expect(inventory.keys.has(key), `${key} missing from the d.ts scan`).toBe(true);
    }
  });

  test("every reference-taking export of the pinned package is classified in the census table", () => {
    expect(
      unclassifiedEntryPoints(inventory.keys.keys()),
      `convex@${inventory.version} exports reference-taking entry points the census does not classify`
    ).toEqual([]);
  });

  test("the check has teeth: an unclassified export is reported", () => {
    expect(unclassifiedEntryPoints([...inventory.keys.keys(), "useBrandNewHook"])).toEqual(["useBrandNewHook"]);
  });

  test("every table key is a recognised kind", () => {
    const kinds = new Set(["IMMEDIATE", "DEFERRED", "REQUEST_MAP", "LOCAL", "REFERENCE_CONSTRUCTOR", "SERVER_ONLY", "UNSUPPORTED"]);
    for (const [key, kind] of Object.entries(ENTRY_TABLE)) expect(kinds.has(kind as string), key).toBe(true);
  });
});

describe("census reconciliation, by site identity", () => {
  test("the two shipped forms reconcile to extractor transmission records", () => {
    const census = censusOf(["realForms"]);
    const map = at(census, "realForms", "return useQueries(queries)");
    expect(map.map((c) => c.disposition)).toEqual(["TRANSMISSION"]);
    const entry = at(census, "realForms", "readiness: { query:");
    expect(entry.map((c) => c.disposition)).toEqual(["TRANSMISSION"]);
    const alias = at(census, "realForms", "globalSearchQuery,");
    expect(alias.map((c) => c.disposition)).toEqual(["TRANSMISSION"]);
    expect(census.unaccounted).toEqual([]);
    expect(census.orphans).toEqual([]);
  });

  test("request maps: entries transmit, an empty map is a proved non-transmission, dynamic ones are unresolved", () => {
    const census = censusOf(["requestMaps"]);
    const dispositionAt = (needle: string) => at(census, "requestMaps", needle).map((c) => c.disposition);
    expect(dispositionAt("return useQueries({")).toEqual(["TRANSMISSION"]);
    expect(dispositionAt("return useQueries({});")).toEqual(["NON_TRANSMISSION"]);
    expect(dispositionAt("return useQueries(requests);")).toEqual(["UNRESOLVED"]);
    const dynamicEntry = at(census, "requestMaps", "api.vehicles[name]").filter((c) => c.roles.includes("reference"));
    expect(dynamicEntry.map((c) => c.disposition)).toEqual(["UNRESOLVED"]);
    expect(census.unaccounted).toEqual([]);
  }, 120_000);

  test("escapes are explicit unresolved records with file:line, never silence", () => {
    const census = censusOf(["escapes"]);
    expect(at(census, "escapes", "const rows = useQuery(").map((c) => c.disposition)).toEqual(["UNRESOLVED"]);
    expect(at(census, "escapes", "return useQuery(ref, {});").map((c) => c.disposition)).toEqual(["UNRESOLVED"]);
    const handedOn = at(census, "escapes", "return create;");
    expect(handedOn.map((c) => c.disposition)).toEqual(["UNRESOLVED"]);
    expect(census.incomplete).toBe(true);
    for (const u of census.unresolved) expect(u.line).toBeGreaterThan(0);
  });

  test("deferred bindings: an invocation transmits, a dependency array does not, a hand-off is unresolved", () => {
    const census = censusOf(["deferred"]);
    expect(at(census, "deferred", "() => create({ orgId })").map((c) => c.disposition)).toContain("TRANSMISSION");
    expect(at(census, "deferred", "[create, orgId]").map((c) => c.disposition)).toContain("NON_TRANSMISSION");
    expect(at(census, "deferred", "return [remove];").map((c) => c.disposition)).toEqual(["UNRESOLVED"]);
    expect(at(census, "deferred", "convex.query(api.vehicles.list").map((c) => c.disposition)).toEqual(["TRANSMISSION"]);
    expect(at(census, "deferred", "getFunctionName(").map((c) => c.disposition)).toEqual(["NON_TRANSMISSION"]);
  });

  test("a `typeof binding` type reference and a non-reference SDK call are not candidates (real-tree false positives)", () => {
    // Both were UNRESOLVED / UNACCOUNTED on the real tree before: team/page.tsx
    // `Awaited<ReturnType<typeof syncRolePermissions>>` and every `useConvexAuth()`.
    const census = censusOf(["deferred"]);
    expect(at(census, "deferred", "Parameters<typeof update>")).toEqual([]);
    expect(at(census, "deferred", "useConvexAuth()")).toEqual([]);
    expect(census.unaccounted).toEqual([]);
  });

  test("L-b: a 14-link alias chain ending in an invoked mutation is accounted, not capped at 12 passes", () => {
    const census = censusOf(["aliasChain"]);
    expect(at(census, "aliasChain", "return create({ orgId").map((c) => c.disposition)).toEqual(["TRANSMISSION"]);
    expect(at(census, "aliasChain", "const create = useMutation(t14)").map((c) => c.disposition)).toEqual(["NON_TRANSMISSION"]);
    expect(at(census, "aliasChain", "const t1 = api").map((c) => c.disposition)).toEqual(["NON_TRANSMISSION"]);
    expect(census.unaccounted).toEqual([]);
  });

  test("L-b: the same chain ending in a hand-off is UNRESOLVED (exit 9), never silent", () => {
    const census = censusOf(["aliasChain"]);
    const ends = at(census, "aliasChain", "return e14;");
    expect(ends.map((c) => c.disposition)).toEqual(["UNRESOLVED"]);
    expect(census.incomplete).toBe(true);
  });

  test("L-b: a cross-file 14-link chain is followed to its root", () => {
    const census = censusOf(["aliasChainB", "aliasChainRoot"]);
    expect(at(census, "aliasChainB", "return create({ orgId").map((c) => c.disposition)).toEqual(["TRANSMISSION"]);
    expect(census.unaccounted).toEqual([]);
  });

  test("an unrelated local `api` object is not a candidate", () => {
    const census = censusOf(["unrelatedApi"]);
    expect(census.candidates).toEqual([]);
  });

  test("a census candidate the extractor missed is UNACCOUNTED, not clean", () => {
    const files = [fixture("deferred")];
    const program = sharedProgram();
    const blank = { calls: [], unresolvedBinders: [], provedSkips: [], diagnosticsCount: 0 };
    const census = runCensus({ program, files, extraction: blank as never }) as unknown as Census;
    expect(census.unaccounted.length).toBeGreaterThan(0);
    expect(census.incomplete).toBe(true);
  });
});

describe("CS-3: a shorthand property is a use of the variable (symbol meaning, not spelling)", () => {
  const census = censusOf(["shorthand"]);
  const dispositions = (needle: string) => at(census, "shorthand", needle).map((c) => c.disposition);

  test("`return { update }` hands a bound mutation onward: UNRESOLVED at that site", () => {
    expect(dispositions("return { update };")).toEqual(["UNRESOLVED"]);
  });

  test("the explicit `{ update: update }` control is UNRESOLVED too (same meaning, same record)", () => {
    expect(dispositions("return { update: update };")).toEqual(["UNRESOLVED"]);
  });

  test("the generated `api` root named by shorthand is not silently skipped", () => {
    expect(dispositions("const holder = { api };")).toEqual(["UNRESOLVED"]);
  });

  test("L-6: an SDK method pulled off a client by shorthand destructure is recorded UNRESOLVED", () => {
    expect(dispositions("const { mutation } = client;")).toEqual(["UNRESOLVED"]);
  });
});

describe("CS2-1: element-access SDK calls are recognised by the resolved member", () => {
  const census = censusOf(["elementAccess"]);
  const dispositions = (needle: string) => at(census, "elementAccess", needle).map((c) => c.disposition);

  test("the dot form is a TRANSMISSION (control)", () => {
    expect(dispositions("client.query(api.vehicles.list")).toEqual(["TRANSMISSION"]);
  });

  test('`client["query"](api.…)` reconciles exactly like the dot form', () => {
    expect(dispositions('client["query"](api.vehicles.list')).toEqual(["TRANSMISSION"]);
  });

  test('`client["query"](unknownRef)` is not silent: a gap is recorded at the site', () => {
    const found = at(census, "elementAccess", 'client["query"](ref');
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) expect(["UNRESOLVED", "UNACCOUNTED"]).toContain(c.disposition);
  });

  test("a non-literal member on a Convex client type is UNRESOLVED", () => {
    expect(dispositions("client[method](ref")).toEqual(["UNRESOLVED"]);
  });

  test('`const q = client["query"]` (a method taken as a value) is UNRESOLVED', () => {
    expect(dispositions('const q = client["query"]')).toEqual(["UNRESOLVED"]);
  });

  test("makeFunctionReference outside the root declaration is UNRESOLVED, never dropped", () => {
    expect(dispositions('makeFunctionReference("vehicles:list")')).toEqual(["UNRESOLVED"]);
  });

  test("L-3: a BaseConvexClient string-name method is a coverage gap", () => {
    expect(dispositions('base.mutation("vehicles:update"')).toEqual(["UNRESOLVED"]);
    expect(ENTRY_TABLE["BaseConvexClient.mutation"]).toBe("UNSUPPORTED");
    expect(ENTRY_TABLE["BaseConvexClient.subscribe"]).toBe("UNSUPPORTED");
    expect(ENTRY_TABLE["BaseConvexClient.action"]).toBe("UNSUPPORTED");
  });
});

describe("tests, backend and generated code are outside the scanned set", () => {
  test("no surface lists a test file, a convex/ file or a generated file", () => {
    for (const surface of CLIENT_SURFACES) {
      for (const file of listSurfaceFiles(process.cwd(), surface) as string[]) {
        const posix = file.replace(/\\/g, "/");
        expect(posix).not.toMatch(/\.(test|spec)\.tsx?$/);
        expect(posix).not.toMatch(/\/convex\//);
        expect(posix).not.toMatch(/_generated/);
      }
    }
  });
});

describe("the whole tree", () => {
  test("every candidate carries exactly one disposition and every extractor record is a candidate", () => {
    let total = 0;
    for (const surface of CLIENT_SURFACES) {
      const files = listSurfaceFiles(process.cwd(), surface) as string[];
      if (!files.length) continue;
      const program = createClientProgram(files, surface.tsconfig);
      const extraction = extractClientCalls(files, surface.tsconfig, { program });
      const census = runCensus({ program, files, extraction }) as unknown as Census;
      const ids = new Set(census.candidates.map((c) => c.siteId));
      expect(ids.size, "candidate site ids must be unique").toBe(census.candidates.length);
      for (const c of census.candidates) {
        expect(["TRANSMISSION", "NON_TRANSMISSION", "UNRESOLVED", "UNACCOUNTED"]).toContain(c.disposition);
      }
      // By identity, not by count: every extractor record has a census candidate.
      expect(census.orphans, `${surface.name}: extractor records with no census candidate`).toEqual([]);
      total += census.candidates.length;
    }
    expect(total).toBeGreaterThan(0);
  }, 600_000);
});
