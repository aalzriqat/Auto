import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { breakKey } from "./compare.mjs";

/**
 * SCRUM-178 v2, D-24 CS-2: the exit policy, one subprocess test per table row.
 *
 * The exit code and the sentence the run prints ARE the behaviour under test, so
 * every case runs the real CLI. Projects are scaffolded under
 * `node_modules/.cache` INSIDE the repository so `convex/react` resolves exactly
 * as it does in the real tree; the independent census starts from that import
 * symbol and would otherwise see nothing.
 */
const cli = path.resolve("scripts/contractSkew/cli.mjs");
const cacheRoot = path.resolve("node_modules/.cache/skew-exit");

const FORBIDDEN_WORDING = /No production skew detected/;

const str = { type: "string" };
const required = (fieldType: unknown) => ({ fieldType, optional: false });
const fnOf = (functionType: "Query" | "Mutation") => (identifier: string, fields: Record<string, unknown>) => ({
  identifier,
  functionType,
  visibility: { kind: "public" },
  args: { type: "object", value: fields },
});
const mutation = fnOf("Mutation");
const query = fnOf("Query");
const specOf = (...functions: unknown[]) => ({ url: "https://x.convex.cloud", functions });

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    jsx: "preserve",
    noEmit: true,
    skipLibCheck: true,
  },
});

/** A client file that binds `useMutation(api.vehicles.update)` and calls it with `arg`. */
const CLIENT = (params: string, arg: string) =>
  'import { useMutation } from "convex/react";\n' +
  "declare const api: { vehicles: { update: unknown } };\n" +
  `export const go = (${params}) => {\n` +
  "  const update = useMutation(api.vehicles.update);\n" +
  `  return update(${arg});\n` +
  "};\n";

/** A call the spec fully proves. */
const PROVEN = CLIENT("", '{ orgId: "o" }');

/** A value the type system cannot narrow: TYPE_UNKNOWN on `orgId`. */
const UNPROVEN = CLIENT("v: unknown", "{ orgId: v }");

/** A key the deployed backend does not declare: a proven BREAKING finding. */
const SENDS_NOPE = CLIENT("", '{ orgId: "o", nope: "x" }');

/** A function reference nothing can resolve statically. */
const UNRESOLVABLE =
  'import { useQuery } from "convex/react";\n' +
  "declare const api: Record<string, Record<string, never>>;\n" +
  "export const go = (name: string) => useQuery(api.vehicles[name], {});\n";

type Project = {
  client?: string;
  spec?: unknown;
  extra?: Record<string, string>;
  baseline?: unknown | "absent" | "unreadable";
  current?: unknown;
  candidate?: unknown;
};

let counter = 0;
const scaffold = (p: Project) => {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const dir = path.join(cacheRoot, `p${process.pid}-${counter++}`);
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
  fs.writeFileSync(
    path.join(dir, "spec.json"),
    JSON.stringify(p.spec ?? specOf(mutation("vehicles.js:update", { orgId: required(str) })))
  );
  if (p.client !== undefined) fs.writeFileSync(path.join(dir, "app", "uses-convex.tsx"), p.client);
  for (const [name, text] of Object.entries(p.extra ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  if (p.baseline === "unreadable") fs.writeFileSync(path.join(dir, "baseline.json"), "{ not json");
  else if (p.baseline !== "absent") {
    fs.writeFileSync(
      path.join(dir, "baseline.json"),
      JSON.stringify(p.baseline ?? { version: 1, entries: [] })
    );
  }
  if (p.current) fs.writeFileSync(path.join(dir, "current.json"), JSON.stringify(p.current));
  if (p.candidate) fs.writeFileSync(path.join(dir, "candidate.json"), JSON.stringify(p.candidate));
  return dir;
};

const run = (dir: string, args: string[], env: Record<string, string> = {}) => {
  const base = { ...process.env };
  delete base.CONVEX_PROD_DEPLOYMENT;
  const out = spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...base, ...env },
    timeout: 240_000,
  });
  return {
    code: out.status ?? -1,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
    all: `${out.stdout ?? ""}\n${out.stderr ?? ""}`,
  };
};

const production = (dir: string, extra: string[] = []) =>
  run(dir, ["--mode", "production", "--spec", "spec.json", "--baseline", "baseline.json", "--json", "report.json", ...extra]);

const reportOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));

/** Build the baseline an owner would build: from the inspected report. */
const baselineFrom = (dir: string, patch: (e: Record<string, unknown>) => Record<string, unknown> = (e) => e) => {
  const probe = production(dir);
  const entries = (reportOf(dir).unproven as Record<string, unknown>[]).map((u) =>
    patch({ ...u, rationale: "reviewed in test", issue: "SCRUM-178", expires: "2999-12-31" })
  );
  expect(entries.length, `expected unproven findings to baseline (probe exit ${probe.code})`).toBeGreaterThan(0);
  fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify({ version: 1, entries }));
  return entries;
};

describe("exit-code table: one subprocess test per row", () => {
  test("0 PASS — gap-free, empty baseline, every call accounted: scope stated as Convex argument contracts", () => {
    const dir = scaffold({ client: PROVEN });
    const r = production(dir);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/No skew detected in Convex argument contracts/);
    expect(r.all).not.toMatch(FORBIDDEN_WORDING);
    expect(reportOf(dir).verdict).toBe("PASS");
  }, 300_000);

  test("0 UNKNOWN — baselined debt only exits 0 and prints the exact sentence", () => {
    const dir = scaffold({ client: UNPROVEN });
    baselineFrom(dir);
    const r = production(dir);
    expect(r.code).toBe(0);
    expect(r.all).toContain(
      "No proven skew in accounted Convex argument calls; verdict UNKNOWN: 1 reviewed paths remain unverified."
    );
    expect(r.all).not.toMatch(FORBIDDEN_WORDING);
    expect(reportOf(dir).verdict).toBe("UNKNOWN");
  }, 300_000);

  test("2 USAGE — an unknown --mode", () => {
    const dir = scaffold({ client: PROVEN });
    const r = run(dir, ["--mode", "bogus"]);
    expect(r.code).toBe(2);
  }, 60_000);

  test("3 UNAVAILABLE — no deployment identity and no spec", () => {
    const dir = scaffold({ client: PROVEN });
    const r = run(dir, ["--mode", "production"]);
    expect(r.code).toBe(3);
    expect(r.all).not.toMatch(FORBIDDEN_WORDING);
  }, 60_000);

  test("3 UNAVAILABLE — a function whose spec args are not an object validator", () => {
    const dir = scaffold({
      client: PROVEN,
      spec: specOf({ identifier: "vehicles.js:update", functionType: "Mutation", args: { type: "string" } }),
    });
    expect(production(dir).code).toBe(3);
  }, 120_000);

  test("4 BLOCKED — release: an unproven path overlaps a path the candidate changes", () => {
    const dir = scaffold({
      client: UNPROVEN,
      candidate: specOf(mutation("vehicles.js:update", { orgId: required({ type: "number" }) })),
    });
    baselineFrom(dir);
    const r = run(dir, ["--mode", "release", "--spec", "spec.json", "--candidate", "candidate.json", "--baseline", "baseline.json"]);
    expect(r.code).toBe(4);
  }, 300_000);

  test("5 STANDING DEFECT — the client disagrees with a backend that is already live and current", () => {
    const deployed = specOf(mutation("vehicles.js:update", { orgId: required(str) }));
    const dir = scaffold({ client: SENDS_NOPE, spec: deployed, current: deployed });
    const r = production(dir, ["--current", "current.json"]);
    expect(r.code).toBe(5);
    expect(r.all).not.toMatch(FORBIDDEN_WORDING);
  }, 300_000);

  test("6 COVERAGE GAP — a client file outside every surface calls Convex", () => {
    const dir = scaffold({ client: PROVEN, extra: { "somewhere/Screen.tsx": "const x = useQuery(api.a.b, {});" } });
    expect(production(dir).code).toBe(6);
  }, 300_000);

  test("7 SKEW (supplied spec) — exits 7 with target-neutral wording and NO deploy instruction", () => {
    const deployed = specOf(mutation("vehicles.js:update", { orgId: required(str) }));
    const current = specOf(mutation("vehicles.js:update", { orgId: required(str), nope: required(str) }));
    const dir = scaffold({ client: SENDS_NOPE, spec: deployed, current });
    const r = production(dir, ["--current", "current.json"]);
    expect(r.code).toBe(7);
    expect(r.all).toMatch(/CONTRACT SKEW against the supplied spec \(spec\.json/);
    expect(r.all).not.toMatch(/Deploy the Convex backend|PRODUCTION SKEW/);
  }, 300_000);

  test("8 RELEASE BREAK — release: the candidate introduces a proven incompatibility", () => {
    // ⚠️ SCRUM-178 v2 batch 3 (R1): this USED to be a candidate that ADDED `nope`
    // while the client sent it — a FIX that the old code called a break. The
    // candidate now adds a REQUIRED argument the client never sends.
    const deployed = specOf(mutation("vehicles.js:update", { orgId: required(str) }));
    const candidate = specOf(mutation("vehicles.js:update", { orgId: required(str), extra: required(str) }));
    const dir = scaffold({ client: PROVEN, spec: deployed, candidate });
    const r = run(dir, ["--mode", "release", "--spec", "spec.json", "--candidate", "candidate.json", "--baseline", "baseline.json"]);
    expect(r.code).toBe(8);
    expect(r.all).not.toMatch(/Deploy the Convex backend/);
  }, 300_000);

  test("9 COVERAGE INCOMPLETE — an unresolvable function reference", () => {
    const dir = scaffold({ client: UNRESOLVABLE });
    const r = production(dir);
    expect(r.code).toBe(9);
    expect(r.all).toMatch(/COVERAGE INCOMPLETE/);
    expect(r.all).toMatch(/uses-convex\.tsx/);
    expect(r.all).not.toMatch(FORBIDDEN_WORDING);
  }, 300_000);

  test("9 COVERAGE INCOMPLETE — zero discovered calls must NOT pass", () => {
    const dir = scaffold({});
    const r = production(dir);
    expect(r.code).toBe(9);
    expect(r.all).toMatch(/no Convex call sites/i);
  }, 120_000);

  test("a Convex call in packages/shared is scanned (PASS), not an unscanned-file gap (6)", () => {
    const dir = scaffold({
      extra: {
        "packages/shared/tsconfig.json": TSCONFIG,
        "packages/shared/src/calls.tsx": PROVEN,
      },
    });
    const r = production(dir);
    expect(r.code).toBe(0);
    expect(reportOf(dir).scope.surfaces.find((s: { name: string }) => s.name === "shared").callSites).toBe(1);
  }, 300_000);

  test("10 EVIDENCE DRIFT — an unproven path with no baseline entry", () => {
    const dir = scaffold({ client: UNPROVEN });
    const r = production(dir);
    expect(r.code).toBe(10);
    expect(r.all).toMatch(/EVIDENCE DRIFT/);
    expect(r.all).not.toMatch(FORBIDDEN_WORDING);
  }, 300_000);
});

const releaseArgs = ["--mode", "release", "--spec", "spec.json", "--candidate", "candidate.json", "--baseline", "baseline.json"];
const releaseArgsJ = [...releaseArgs, "--json", "report.json"];
const DEPLOYED = specOf(mutation("vehicles.js:update", { orgId: required(str) }));

describe("SCRUM-178 v2 batch 3 R1: release mode compares the candidate, not just the deployed spec", () => {
  const release = (client: string, candidate: unknown, spec: unknown = DEPLOYED) => {
    const dir = scaffold({ client, spec, candidate });
    return { dir, r: run(dir, releaseArgsJ) };
  };

  test("candidate REMOVES a called function -> 8", () => {
    const { dir, r } = release(PROVEN, specOf(mutation("vehicles.js:other", {})));
    expect(r.code).toBe(8);
    expect(r.stderr).toMatch(/RELEASE BREAK/);
    expect(r.stderr).toMatch(/uses-convex\.tsx/);
    expect(reportOf(dir).causes.releaseBreaks).toBeGreaterThan(0);
  }, 300_000);

  test("candidate makes the called function INTERNAL -> 8", () => {
    const internal = { ...mutation("vehicles.js:update", { orgId: required(str) }), visibility: { kind: "internal" } };
    expect(release(PROVEN, specOf(internal)).r.code).toBe(8);
  }, 300_000);

  test("candidate turns the Mutation into a Query -> 8", () => {
    expect(release(PROVEN, specOf(query("vehicles.js:update", { orgId: required(str) }))).r.code).toBe(8);
  }, 300_000);

  test("an unproven value on a field of a function whose ONLY change is at <function> is BLOCKED (4)", () => {
    // The deployed spec has `update` as a Query, so the client's `useMutation` is
    // refused there (a deployed break, FIXED by the candidate) and the payload is
    // never walked against it. The candidate makes it a Mutation with the SAME
    // args: the only recorded change is TYPE_CHANGED at `<function>`, while the
    // client's unproven `orgId` (a field path) is what the candidate leaves
    // unverified. A change to the whole function touches every path on it.
    const asQuery = specOf(query("vehicles.js:update", { orgId: required(str) }));
    const asMutation = specOf(mutation("vehicles.js:update", { orgId: required(str) }));
    const { dir, r } = release(UNPROVEN, asMutation, asQuery);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/BLOCKED/);
    const report = reportOf(dir);
    expect(report.changedBreakdown).toEqual({ TYPE_CHANGED: 1 });
    expect(report.intersectingUnknowns).toHaveLength(1);
  }, 300_000);

  test("candidate adds a REQUIRED arg the client omits -> 8", () => {
    const { dir, r } = release(PROVEN, specOf(mutation("vehicles.js:update", { orgId: required(str), extra: required(str) })));
    expect(r.code).toBe(8);
    expect(reportOf(dir).release.breaks).toBeGreaterThan(0);
  }, 300_000);

  test("a break present against BOTH on an unchanged path is STANDING, not a release break", () => {
    const { dir, r } = release(SENDS_NOPE, DEPLOYED);
    expect(r.code).not.toBe(8);
    expect(r.code).toBe(0);
    expect(reportOf(dir).release.standingAgainstBoth).toBe(1);
    expect(r.stderr).toMatch(/\[STANDING\]/);
  }, 300_000);

  test("a candidate that FIXES a deployed break exits 0 and says so", () => {
    const { dir, r } = release(SENDS_NOPE, specOf(mutation("vehicles.js:update", { orgId: required(str), nope: required(str) })));
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/FIXED BY THIS CANDIDATE/);
    expect(reportOf(dir).release.fixedByCandidate).toBe(1);
  }, 300_000);

  test("a proven break AND an unproven value on a changed path -> 8, with BLOCKED also present", () => {
    const client =
      'import { useMutation } from "convex/react";\n' +
      "declare const api: { vehicles: { update: unknown } };\n" +
      "export const go = (v: unknown) => {\n" +
      "  const update = useMutation(api.vehicles.update);\n" +
      '  update({ orgId: "o" });\n' +
      "  return update({ orgId: v });\n" +
      "};\n";
    const { dir, r } = release(client, specOf(mutation("vehicles.js:update", { orgId: required({ type: "number" }) })));
    expect(r.code).toBe(8);
    expect(r.stderr).toMatch(/BLOCKED/);
    expect(r.stderr).toMatch(/ALSO PRESENT/);
    const causes = reportOf(dir).causes;
    expect(causes.releaseBreaks).toBeGreaterThan(0);
    expect(causes.releaseBlockers).toBeGreaterThan(0);
  }, 300_000);
});

describe("SCRUM-178 v2 batch 3 R2 + SPEC-1: every spec role is validated, recursively", () => {
  const fnWith = (patch: Record<string, unknown>) => ({ ...mutation("vehicles.js:update", { orgId: required(str) }), ...patch });
  const { args: _omit, ...noArgs } = mutation("vehicles.js:update", {});
  const bad: Record<string, unknown> = {
    "absent args key": noArgs,
    "object field without fieldType": fnWith({ args: { type: "object", value: { orgId: { optional: false } } } }),
    "unknown validator type": fnWith({ args: { type: "object", value: { orgId: required({ type: "nope" }) } } }),
    "unknown functionType": fnWith({ functionType: "Banana" }),
    "unknown visibility": fnWith({ visibility: { kind: "private" } }),
    "record with an invalid value validator": fnWith({
      args: { type: "object", value: { orgId: required({ type: "record", keys: { type: "string" }, values: {} }) } },
    }),
    // SCRUM-178 v2 batch 4 (F-1): ValidatorJSON has no `int64` and no `float64`;
    // v.int64() renders `bigint` and v.float64() renders `number`.
    "the fictional int64 validator type": fnWith({ args: { type: "object", value: { orgId: required({ type: "int64" }) } } }),
    "the fictional float64 validator type": fnWith({ args: { type: "object", value: { orgId: required({ type: "float64" }) } } }),
    // SCRUM-178 v2 batch 4 (L-1): `optional` must be a real boolean, at any depth.
    'a top-level `optional: "false"`': fnWith({ args: { type: "object", value: { orgId: { fieldType: str, optional: "false" } } } }),
    'a nested `optional: "false"`': fnWith({
      args: {
        type: "object",
        value: {
          orgId: required({ type: "object", value: { inner: { fieldType: str, optional: "false" } } }),
        },
      },
    }),
  };

  for (const [name, entry] of Object.entries(bad)) {
    test(`${name}: exit 3 naming the role (deployed, current, candidate)`, () => {
      const broken = specOf(entry);
      const roles: Array<[string, Project, string[]]> = [
        ["deployed", { client: PROVEN, spec: broken }, ["--mode", "production", "--spec", "spec.json", "--baseline", "baseline.json"]],
        ["current", { client: PROVEN, current: broken }, ["--mode", "production", "--spec", "spec.json", "--current", "current.json", "--baseline", "baseline.json"]],
        ["candidate", { client: PROVEN, candidate: broken }, ["--mode", "release", "--spec", "spec.json", "--candidate", "candidate.json", "--baseline", "baseline.json"]],
      ];
      for (const [role, project, args] of roles) {
        const r = run(scaffold(project), args);
        expect(r.code, `${name} as ${role}`).toBe(3);
        expect(r.stderr, `${name} as ${role}`).toContain(role);
      }
    }, 300_000);
  }

  test("a call to an `args: null` function is an unwaivable gap: exit 9 with file:line", () => {
    const nullArgs = { ...mutation("vehicles.js:update", {}), args: null };
    const dir = scaffold({ client: PROVEN, spec: specOf(nullArgs) });
    const r = production(dir);
    expect(r.code).toBe(9);
    expect(r.stderr).toMatch(/uses-convex\.tsx/);
    expect(reportOf(dir).causes.coverageIncomplete.join(" ")).toMatch(/cannot compare/);
  }, 300_000);

  test("an UNCALLED `args: null` function costs nothing", () => {
    const nullArgs = { ...mutation("vehicles.js:neverCalled", {}), args: null };
    const dir = scaffold({ client: PROVEN, spec: specOf(mutation("vehicles.js:update", { orgId: required(str) }), nullArgs) });
    expect(production(dir).code).toBe(0);
  }, 300_000);

  test("a record-typed arg the client reaches is a gap (9), never a pass", () => {
    const rec = mutation("vehicles.js:update", { orgId: required({ type: "record", keys: { type: "string" }, values: required(str) }) });
    const dir = scaffold({ client: PROVEN, spec: specOf(rec) });
    expect(production(dir).code).toBe(9);
  }, 300_000);

  test("an empty union the client reaches is a gap (9), never `any`", () => {
    const empty = mutation("vehicles.js:update", { orgId: required({ type: "union", value: [] }) });
    const dir = scaffold({ client: PROVEN, spec: specOf(empty) });
    expect(production(dir).code).toBe(9);
  }, 300_000);

  test("release: a candidate that turns the called function's args into null is BLOCKED (4)", () => {
    const nullArgs = { ...mutation("vehicles.js:update", {}), args: null };
    const dir = scaffold({ client: PROVEN, spec: DEPLOYED, candidate: specOf(nullArgs) });
    const r = run(dir, releaseArgsJ);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/BLOCKED/);
  }, 300_000);
});

describe("SCRUM-178 v2 batch 3 R3: exit, stderr and JSON come from one cause list", () => {
  test("a skew break + a standing defect + an unscanned file: primary 7, the other two ALSO PRESENT in stderr and JSON", () => {
    const client =
      'import { useMutation } from "convex/react";\n' +
      "declare const api: { vehicles: { update: unknown; other: unknown } };\n" +
      "export const go = () => {\n" +
      "  const update = useMutation(api.vehicles.update);\n" +
      "  const other = useMutation(api.vehicles.other);\n" +
      '  update({ orgId: "o", nope: "x" });\n' +
      '  return other({ orgId: "o", bad: "x" });\n' +
      "};\n";
    const deployed = specOf(
      mutation("vehicles.js:update", { orgId: required(str) }),
      mutation("vehicles.js:other", { orgId: required(str) })
    );
    const current = specOf(
      mutation("vehicles.js:update", { orgId: required(str), nope: required(str) }),
      mutation("vehicles.js:other", { orgId: required(str) })
    );
    const dir = scaffold({
      client,
      spec: deployed,
      current,
      extra: { "somewhere/Screen.tsx": "const x = useQuery(api.a.b, {});" },
    });
    const r = production(dir, ["--current", "current.json"]);
    expect(r.code).toBe(7);
    expect(r.stderr).toMatch(/ALSO PRESENT: .*STANDING/);
    expect(r.stderr).toMatch(/ALSO PRESENT: .*(COVERAGE GAP|unscanned)/i);
    const causes = reportOf(dir).causes;
    expect(causes.provenBreaks).toBe(1);
    expect(causes.standingDefects).toBe(1);
    expect(causes.unscannedClientFiles).toBeGreaterThanOrEqual(1);
  }, 300_000);
});

describe("break / unknown precedence", () => {
  test("a proven break coexisting with UNKNOWN and drift still exits 7, not 9 or 10", () => {
    const deployed = specOf(mutation("vehicles.js:update", { orgId: required(str), tag: required(str) }));
    const current = specOf(mutation("vehicles.js:update", { orgId: required(str), tag: required(str), nope: required(str) }));
    const both = CLIENT("v: unknown", '{ orgId: v, tag: "t", nope: "x" }');
    const dir = scaffold({ client: both, spec: deployed, current });
    const r = production(dir, ["--current", "current.json"]);
    expect(r.code).toBe(7);
  }, 300_000);

  test("a coverage gap outranks drift: 6, not 10", () => {
    const dir = scaffold({ client: UNPROVEN, extra: { "somewhere/Screen.tsx": "const x = useQuery(api.a.b, {});" } });
    expect(production(dir).code).toBe(6);
  }, 300_000);
});

describe("the needs-evidence baseline", () => {
  test("a NEW finding (not in the baseline) is drift", () => {
    const dir = scaffold({ client: UNPROVEN });
    expect(production(dir).code).toBe(10);
  }, 300_000);

  test("a REMOVED finding (baseline entry with no finding) is drift", () => {
    const dir = scaffold({ client: UNPROVEN });
    baselineFrom(dir);
    fs.writeFileSync(path.join(dir, "app", "uses-convex.tsx"), PROVEN);
    const r = production(dir);
    expect(r.code).toBe(10);
    expect(r.all).toMatch(/no longer reported|removed/i);
  }, 300_000);

  test("a DUPLICATED baseline entry is drift", () => {
    const dir = scaffold({ client: UNPROVEN });
    const entries = baselineFrom(dir);
    fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify({ version: 1, entries: [...entries, entries[0]] }));
    const r = production(dir);
    expect(r.code).toBe(10);
    expect(r.all).toMatch(/duplicate/i);
  }, 300_000);

  test("an EXPIRED entry is drift", () => {
    const dir = scaffold({ client: UNPROVEN });
    baselineFrom(dir, (e) => ({ ...e, expires: "2000-01-01" }));
    const r = production(dir);
    expect(r.code).toBe(10);
    expect(r.all).toMatch(/expired/i);
  }, 300_000);

  test("a MALFORMED entry (no rationale) is drift", () => {
    const dir = scaffold({ client: UNPROVEN });
    baselineFrom(dir, (e) => ({ ...e, rationale: "" }));
    const r = production(dir);
    expect(r.code).toBe(10);
    expect(r.all).toMatch(/malformed/i);
  }, 300_000);

  test("a CONTRACT CHANGE on the baselined path invalidates the entry", () => {
    const dir = scaffold({ client: UNPROVEN });
    baselineFrom(dir);
    // Same finding, but the validator at `orgId` is no longer the one that was reviewed.
    fs.writeFileSync(
      path.join(dir, "spec.json"),
      JSON.stringify(specOf(mutation("vehicles.js:update", { orgId: required({ type: "number" }) })))
    );
    const r = production(dir);
    expect(r.code).toBe(10);
    expect(r.all).toMatch(/contract.*changed|changed.*contract/i);
  }, 300_000);

  test("an ABSENT baseline file is drift, never a silent empty one", () => {
    const dir = scaffold({ client: PROVEN, baseline: "absent" });
    const r = production(dir);
    expect(r.code).toBe(10);
    expect(r.all).toMatch(/baseline/i);
  }, 300_000);

  test("an UNREADABLE baseline file is drift", () => {
    const dir = scaffold({ client: PROVEN, baseline: "unreadable" });
    expect(production(dir).code).toBe(10);
  }, 300_000);

  test("the monitor never writes the baseline", () => {
    const dir = scaffold({ client: UNPROVEN });
    production(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "baseline.json"), "utf8"))).toEqual({ version: 1, entries: [] });
  }, 300_000);

  test("the committed baseline is EMPTY", () => {
    const committed = JSON.parse(
      fs.readFileSync(path.resolve("scripts/contractSkew/needs-evidence-baseline.json"), "utf8")
    );
    expect(committed.entries).toEqual([]);
  });
});

describe("CS2-3 / D-26: baseline drift blocks a RELEASE too (exit 10, never a warning)", () => {
  const same = () => specOf(mutation("vehicles.js:update", { orgId: required(str) }));

  test("a clean release (empty baseline, everything proven) exits 0", () => {
    const dir = scaffold({ client: PROVEN, candidate: same() });
    const r = run(dir, releaseArgs);
    expect(r.code).toBe(0);
  }, 300_000);

  test("an ABSENT baseline exits 10 in release mode", () => {
    const dir = scaffold({ client: PROVEN, candidate: same(), baseline: "absent" });
    const r = run(dir, releaseArgs);
    expect(r.code).toBe(10);
    expect(r.all).toMatch(/EVIDENCE DRIFT/);
    expect(r.all).toMatch(/baseline/i);
  }, 300_000);

  test("a CHANGED baseline (a reviewed entry went malformed) exits 10 in release mode", () => {
    const dir = scaffold({ client: UNPROVEN, candidate: same() });
    baselineFrom(dir, (e) => ({ ...e, rationale: "" }));
    const r = run(dir, releaseArgs);
    expect(r.code).toBe(10);
    expect(r.all).toMatch(/malformed/i);
  }, 300_000);

  test("baselined-only debt that this release does not touch exits 0 with the UNKNOWN wording", () => {
    const dir = scaffold({ client: UNPROVEN, candidate: same() });
    baselineFrom(dir);
    const r = run(dir, releaseArgs);
    expect(r.code).toBe(0);
    expect(r.all).toContain(
      "No proven skew in accounted Convex argument calls; verdict UNKNOWN: 1 reviewed paths remain unverified."
    );
    expect(r.all).not.toMatch(FORBIDDEN_WORDING);
  }, 300_000);
});

describe("D-26 exit precedence: the code names one cause, the output names ALL of them", () => {
  const BREAK_AND_UNRESOLVED =
    'import { useMutation, useQuery } from "convex/react";\n' +
    "declare const api: { vehicles: { update: unknown } } & Record<string, Record<string, never>>;\n" +
    "export const go = () => {\n" +
    "  const update = useMutation(api.vehicles.update);\n" +
    '  return update({ orgId: "o", nope: "x" });\n' +
    "};\n" +
    "export const dynamic = (name: string) => useQuery(api.vehicles[name], {});\n";

  test("a proven break plus an unresolved call site exits 7 AND names the coverage gap", () => {
    const dir = scaffold({ client: BREAK_AND_UNRESOLVED });
    const r = production(dir);
    expect(r.code).toBe(7);
    expect(r.stderr).toMatch(/COVERAGE INCOMPLETE/);
    expect(r.stderr).toMatch(/ALSO PRESENT/);
    const causes = reportOf(dir).causes;
    expect(causes.provenBreaks).toBeGreaterThan(0);
    expect(causes.coverageIncomplete.length).toBeGreaterThan(0);
  }, 300_000);

  test("a coverage gap plus drift exits 6 AND names the drift", () => {
    const dir = scaffold({ client: UNPROVEN, extra: { "somewhere/Screen.tsx": "const x = useQuery(api.a.b, {});" } });
    const r = production(dir);
    expect(r.code).toBe(6);
    expect(r.stderr).toMatch(/EVIDENCE DRIFT/);
    expect(reportOf(dir).causes.evidenceDrift.length).toBeGreaterThan(0);
  }, 300_000);
});

describe("CS-3: a Convex hook result that escapes through a shorthand property is not silently dropped", () => {
  const SHORTHAND =
    'import { useMutation } from "convex/react";\n' +
    "declare const api: { vehicles: { update: unknown } };\n" +
    "export function useVehicleActions() {\n" +
    "  const update = useMutation(api.vehicles.update);\n" +
    "  return { update };\n" +
    "}\n";

  test("the control (a proven call alone) exits 0", () => {
    const dir = scaffold({ client: PROVEN });
    expect(production(dir).code).toBe(0);
  }, 300_000);

  test("a proven call beside `return { update }` exits 9 and names the shorthand site", () => {
    const dir = scaffold({ client: PROVEN, extra: { "app/actions.tsx": SHORTHAND } });
    const r = production(dir);
    expect(r.code).toBe(9);
    expect(r.stderr).toMatch(/actions\.tsx/);
    expect(r.stderr).toMatch(/census UNRESOLVED/);
  }, 300_000);
});

describe("CS2-1: an SDK call through an element access is both counted and compared", () => {
  const BRACKET =
    'import type { ConvexReactClient } from "convex/react";\n' +
    "declare const api: { vehicles: { list: unknown } };\n" +
    "declare const client: ConvexReactClient;\n" +
    'export const go = () => client["query"](api.vehicles.list, { orgId: "o" });\n';
  const listSpec = (fields: Record<string, unknown>) => specOf(query("vehicles.js:list", fields));
  const twoSurfaces = (spec: unknown) =>
    scaffold({
      client: PROVEN,
      spec: specOf(mutation("vehicles.js:update", { orgId: required(str) }), ...(spec as { functions: unknown[] }).functions),
      extra: { "packages/shared/tsconfig.json": TSCONFIG, "packages/shared/src/bracket.tsx": BRACKET },
    });

  test("the bracket call is extracted on its surface and compared: matching spec exits 0", () => {
    const dir = twoSurfaces(listSpec({ orgId: required(str) }));
    const r = production(dir);
    expect(r.code).toBe(0);
    const surfaces = reportOf(dir).scope.surfaces as Array<{ name: string; callSites: number }>;
    expect(surfaces.find((s) => s.name === "shared")?.callSites).toBe(1);
  }, 300_000);

  test("an altered spec (the field the client sends is no longer declared) exits 7", () => {
    const dir = twoSurfaces(listSpec({}));
    const r = production(dir);
    expect(r.code).toBe(7);
  }, 300_000);
});

describe("entry points clientPaths does not extract fail CLOSED (exit 9), never silently pass", () => {
  // Names absent from compare's EXPECTED_FUNCTION_TYPE (see functionTypeCoverage.test.ts).
  // clientPaths extracts none of them, so the census holds a site the extractor has
  // no record for and records it UNACCOUNTED -> COVERAGE_INCOMPLETE.
  // createMutation and useQueriesHelper are not exported from any public `convex`
  // subpath, so they are imported by relative path to the package's declarations
  // (a public import does not resolve, the census sees no symbol, and exit is 0).
  const HEAD = 'declare const api: { vehicles: { update: unknown } };\n';
  const CASES: Array<[string, string]> = [
    [
      "useQuery_experimental",
      'import { useQuery_experimental } from "convex/react";\n' + HEAD +
        "export const go = () => useQuery_experimental(api.vehicles.update, {});\n",
    ],
    [
      "usePaginatedQuery_experimental",
      'import { usePaginatedQuery_experimental } from "convex/react";\n' + HEAD +
        "export const go = () => usePaginatedQuery_experimental(api.vehicles.update, {}, { initialNumItems: 1 });\n",
    ],
    [
      "createMutation",
      'import { createMutation, type ConvexReactClient } from "../../../../convex/dist/esm-types/react/client.js";\n' + HEAD +
        "declare const client: ConvexReactClient;\n" +
        "export const go = () => createMutation(api.vehicles.update, client);\n",
    ],
    [
      "useQueriesHelper",
      'import { useQueriesHelper } from "../../../../convex/dist/esm-types/react/use_queries.js";\n' + HEAD +
        "export const go = () => useQueriesHelper({ a: { query: api.vehicles.update, args: {} } }, undefined as never);\n",
    ],
    [
      "onPaginatedUpdate_experimental",
      'import type { ConvexClient } from "convex/browser";\n' + HEAD +
        "declare const client: ConvexClient;\n" +
        "export const go = () => client.onPaginatedUpdate_experimental(api.vehicles.update, {}, { initialNumItems: 1 }, () => {});\n",
    ],
  ];

  test.each(CASES)("%s exits 9 and names the site", (name, source) => {
    const dir = scaffold({ client: PROVEN, extra: { [`app/unextracted-${name}.tsx`]: source } });
    const r = production(dir);
    expect(r.code).toBe(9);
    expect(r.stderr).toContain(`unextracted-${name}.tsx`);
  }, 300_000);
});

describe("CS2-2: the spec is validated before it is trusted", () => {
  const route = { functionType: "HttpAction", method: "GET", path: "/health" };
  const base = () => mutation("vehicles.js:update", { orgId: required(str) });

  test("a hybrid HttpAction entry carrying an identifier exits 3", () => {
    const dir = scaffold({ client: PROVEN, spec: specOf(base(), { ...route, identifier: "vehicles.js:update" }) });
    expect(production(dir).code).toBe(3);
  }, 120_000);

  test("duplicate normalized identifiers exit 3", () => {
    const dir = scaffold({ client: PROVEN, spec: specOf(base(), mutation("vehicles.ts:update", {})) });
    expect(production(dir).code).toBe(3);
  }, 120_000);

  test("a real route entry beside the function is accepted (control)", () => {
    const dir = scaffold({ client: PROVEN, spec: specOf(base(), route) });
    expect(production(dir).code).toBe(0);
  }, 300_000);

  test("a client call to an INTERNAL function is a proven break (7)", () => {
    const internal = { ...base(), visibility: { kind: "internal" } };
    const dir = scaffold({ client: PROVEN, spec: specOf(internal) });
    const r = production(dir);
    expect(r.code).toBe(7);
    expect(r.all).toMatch(/not public/);
  }, 300_000);

  test("a query hook calling a mutation is a proven break (7)", () => {
    const wrongKind =
      'import { useQuery } from "convex/react";\n' +
      "declare const api: { vehicles: { update: unknown } };\n" +
      'export const go = () => useQuery(api.vehicles.update, { orgId: "o" });\n';
    const dir = scaffold({ client: wrongKind });
    const r = production(dir);
    expect(r.code).toBe(7);
    expect(r.all).toMatch(/calls a Query/);
  }, 300_000);
});

describe("SCRUM-178 v2 batch 4", () => {
  const upd = (fields: Record<string, unknown>) => mutation("vehicles.js:update", fields);
  const other = mutation("vehicles.js:other", {});
  const ORG = { orgId: required(str) };
  const DEPLOY_ADVICE = /Deploy the Convex backend|PRODUCTION SKEW|CONTRACT SKEW/;
  const withTag = CLIENT("", '{ orgId: "o", tag: "x" }');
  const current = (dir: string) => production(dir, ["--current", "current.json"]);

  describe("F-2: --current classifies each deployed break by break identity", () => {
    test("current ADDS the called function -> 7 (REVISION_SKEW)", () => {
      const dir = scaffold({ client: PROVEN, spec: specOf(other), current: specOf(upd(ORG), other) });
      const r = current(dir);
      expect(r.code).toBe(7);
      const causes = reportOf(dir).causes;
      expect(causes.provenBreaks).toBeGreaterThan(0);
      expect(causes.standingDefects).toBe(0);
    }, 300_000);

    test("internal -> public in current -> 7", () => {
      const internal = { ...upd(ORG), visibility: { kind: "internal" } };
      const dir = scaffold({ client: PROVEN, spec: specOf(internal), current: specOf(upd(ORG)) });
      const r = current(dir);
      expect(r.code).toBe(7);
      expect(reportOf(dir).causes.provenBreaks).toBeGreaterThan(0);
    }, 300_000);

    test("the same break on both -> 5, never skew", () => {
      const spec = specOf(upd(ORG));
      const dir = scaffold({ client: SENDS_NOPE, spec, current: spec });
      const r = current(dir);
      expect(r.code).toBe(5);
      const causes = reportOf(dir).causes;
      expect(causes.standingDefects).toBeGreaterThan(0);
      expect(causes.provenBreaks).toBe(0);
    }, 300_000);

    test("the path CHANGED but the client still breaks on both -> 5 with 'will not fix' wording", () => {
      const dir = scaffold({
        client: withTag,
        spec: specOf(upd({ ...ORG, tag: required({ type: "number" }) })),
        current: specOf(upd({ ...ORG, tag: required({ type: "boolean" }) })),
      });
      const r = current(dir);
      expect(r.code).toBe(5);
      expect(r.stderr).toMatch(/will not fix/i);
      expect(r.stderr).not.toMatch(DEPLOY_ADVICE);
      const causes = reportOf(dir).causes;
      expect(causes.standingDefects).toBeGreaterThan(0);
      expect(causes.provenBreaks).toBe(0);
    }, 300_000);

    test("current `args: null` on the called function -> 9 with no deploy advice (no deployed break)", () => {
      const nullArgs = { identifier: "vehicles.js:update", functionType: "Mutation", visibility: { kind: "public" }, args: null };
      const dir = scaffold({ client: PROVEN, spec: specOf(upd(ORG)), current: specOf(nullArgs) });
      const r = current(dir);
      expect(r.code).toBe(9);
      expect(r.stderr).toMatch(/COVERAGE INCOMPLETE/);
      expect(r.stderr).not.toMatch(DEPLOY_ADVICE);
    }, 300_000);

    test("a deployed break whose path current cannot compare is 9, not 7, and offers no deploy advice", () => {
      const nullArgs = { identifier: "vehicles.js:update", functionType: "Mutation", visibility: { kind: "public" }, args: null };
      const dir = scaffold({ client: SENDS_NOPE, spec: specOf(upd(ORG)), current: specOf(nullArgs) });
      const r = current(dir);
      expect(r.code).toBe(9);
      expect(r.stderr).not.toMatch(DEPLOY_ADVICE);
      const rep = reportOf(dir);
      expect(rep.causes.provenBreaks).toBe(0);
      expect(rep.causes.coverageIncomplete.length).toBeGreaterThan(0);
    }, 300_000);
  });

  describe("F-3: a candidate that changes the path of an existing break is a RELEASE BREAK", () => {
    test("deployed number, candidate boolean, client string: the SAME breakKey, exit 8", () => {
      const dir = scaffold({
        client: PROVEN,
        spec: specOf(upd({ orgId: required({ type: "number" }) })),
        candidate: specOf(upd({ orgId: required({ type: "boolean" }) })),
      });
      const r = run(dir, releaseArgsJ);
      expect(r.code).toBe(8);
      const m = r.stderr.match(/::error file=([^,]+),line=(\d+)::\[RELEASE BREAK\] (\S+) (\S+) — .* \[(\w+)\]/);
      expect(m, r.stderr).not.toBeNull();
      const deployedBreak = (reportOf(dir).breaking as Array<Record<string, unknown>>).find((b) => b.identifier === m![3]);
      expect(deployedBreak, "the deployed comparison must hold the same break").toBeDefined();
      const candidateBreak = { ...deployedBreak, file: m![1], line: Number(m![2]), identifier: m![3], path: m![4], dimension: m![5] };
      expect(breakKey(candidateBreak)).toBe(breakKey(deployedBreak));
      expect(reportOf(dir).causes.releaseBreaks).toBe(1);
    }, 300_000);
  });

  describe("L-2: a break the candidate fixes is counted separately and is not a proven break", () => {
    test("the candidate fixes the sole deployed break -> exit 0, releaseFixed 1, no FAIL", () => {
      const dir = scaffold({ client: SENDS_NOPE, spec: specOf(upd(ORG)), candidate: specOf(upd({ ...ORG, nope: required(str) })) });
      const r = run(dir, releaseArgsJ);
      expect(r.code).toBe(0);
      const rep = reportOf(dir);
      expect(rep.causes.releaseFixed).toBe(1);
      expect(rep.causes.releaseBreaks).toBe(0);
      expect(rep.causes.provenBreaks).toBe(0);
      expect(rep.verdict).not.toBe("FAIL");
      // Batch 5 (B4-2): the control for "UNPROVEN is not fixed" - a candidate that
      // truly accepts the call is a PASS, not merely "not a FAIL".
      expect(rep.verdict).toBe("PASS");
      expect(r.stderr).toMatch(/1 deployed break\(s\) FIXED BY THIS CANDIDATE/);
    }, 300_000);
  });

  describe("L-4: ALSO PRESENT only when there is a primary cause", () => {
    test("a sole non-exit cause (a standing defect in a release) is printed without the prefix", () => {
      const spec = specOf(upd(ORG));
      const dir = scaffold({ client: SENDS_NOPE, spec, candidate: spec });
      const r = run(dir, releaseArgsJ);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/STANDING CONTRACT DEFECT/);
      expect(r.stderr).not.toMatch(/ALSO PRESENT/);
    }, 300_000);
  });
});

describe("SCRUM-178 v2 batch 5 (D-30): acceptance is per call, absence is not acceptance", () => {
  const upd = (fields: Record<string, unknown>) => mutation("vehicles.js:update", fields);
  const ORG = { orgId: required(str) };
  const nullArgs = { identifier: "vehicles.js:update", functionType: "Mutation", visibility: { kind: "public" }, args: null };
  const current = (dir: string) => production(dir, ["--current", "current.json"]);
  const HEAD =
    'import { useMutation } from "convex/react";\n' +
    "declare const api: { vehicles: { update: unknown } };\n";
  /** Two calls to the SAME function on ONE source line: distinct columns, distinct siteIds. */
  const sameLine = (params: string, a: string, b: string) =>
    HEAD +
    `export const go = (${params}) => {\n` +
    "  const update = useMutation(api.vehicles.update);\n" +
    `  update(${a}); update(${b});\n` +
    "};\n";

  describe("B4-1: siteId is part of the identity", () => {
    test("deployed rejects A, current accepts A and rejects B (same line, function, path, dimension) -> 7 REVISION_SKEW, not 5", () => {
      const dir = scaffold({
        client: sameLine("", '{ orgId: "o", tag: 1 }', '{ orgId: "o", tag: "s" }'),
        spec: specOf(upd({ ...ORG, tag: required(str) })),
        current: specOf(upd({ ...ORG, tag: required({ type: "number" }) })),
      });
      const r = current(dir);
      expect(r.code, r.stderr).toBe(7);
      const causes = reportOf(dir).causes;
      expect(causes.provenBreaks).toBe(1);
      expect(causes.standingDefects).toBe(0);
      // Q3-3: current accepts A and rejects B, but B is not a deployed break, so
      // nothing here is "refused by current as well".
      expect(reportOf(dir).classification.rejectedByCurrent).toBe(0);
    }, 300_000);

    test("two same-line gaps stay two: distinct in stderr and in the JSON report", () => {
      const dir = scaffold({
        client: sameLine("", '{ orgId: "o" }', '{ orgId: "p" }'),
        spec: specOf(nullArgs),
      });
      const r = production(dir);
      expect(r.code).toBe(9);
      expect(r.stderr.match(/\[coverage gap\]/g) ?? []).toHaveLength(2);
      const gaps = reportOf(dir).gaps as Array<{ siteId: string }>;
      expect(gaps).toHaveLength(2);
      expect(new Set(gaps.map((g) => g.siteId)).size).toBe(2);
    }, 300_000);
  });

  describe("B4-2 / N-1: one acceptance rule for production --current and release", () => {
    test("two-site isolation (CLI): an unknown at site B on the same path leaves site A's skew at 7", () => {
      const dir = scaffold({
        client: sameLine("v: unknown", '{ orgId: "o", tag: 1 }', "{ orgId: \"o\", tag: v }"),
        spec: specOf(upd({ ...ORG, tag: required(str) })),
        current: specOf(upd({ ...ORG, tag: required({ type: "number" }) })),
      });
      const r = current(dir);
      expect(r.code, r.stderr).toBe(7);
      const rep = reportOf(dir);
      expect(rep.causes.provenBreaks).toBe(1);
      expect(rep.classification.coverageIncomplete).toBe(0);
    }, 300_000);

    test("REJECTED_OTHER: current still rejects the call at another path -> stays 7, names the current break, no fix claim", () => {
      // Deployed does not declare `nope`; current declares it as a number and the
      // client sends a string. The call is refused by BOTH, for different reasons.
      const dir = scaffold({
        client: SENDS_NOPE,
        spec: specOf(upd(ORG)),
        current: specOf(upd({ ...ORG, nope: required({ type: "number" }) })),
      });
      const r = current(dir);
      expect(r.code, r.stderr).toBe(7);
      expect(r.stderr).toMatch(/current spec (ALSO )?(still )?rejects this call at nope/i);
      expect(r.stderr).toMatch(/will not (make|fix)/i);
      expect(r.stderr).not.toMatch(/Deploy the Convex backend/);
      const rep = reportOf(dir);
      expect(rep.classification.rejectedByCurrent).toBe(1);
      const entry = (rep.breaking as Array<{ acceptance: string; currentRejects: unknown[] }>)[0];
      expect(entry.acceptance).toBe("REJECTED_OTHER");
      expect(entry.currentRejects[0]).toMatchObject({ path: "nope", dimension: "VALUE" });
      expect(rep.alert.summary).not.toMatch(/behind the current one/);
      expect(JSON.stringify(rep)).not.toMatch(/Deploy the Convex backend/);
    }, 300_000);

    test("release (Codex B4-2): deployed rejects `nope`, candidate has `args: null` -> releaseFixed 0, indeterminate listed, exit 4", () => {
      const dir = scaffold({ client: SENDS_NOPE, spec: specOf(upd(ORG)), candidate: specOf(nullArgs) });
      const r = run(dir, releaseArgsJ);
      expect(r.code, r.stderr).toBe(4);
      const rep = reportOf(dir);
      expect(rep.causes.releaseFixed).toBe(0);
      expect(rep.release.fixedByCandidate).toBe(0);
      expect(rep.release.indeterminate).toBe(1);
      expect(rep.causes.releaseIndeterminate).toBe(1);
      expect(r.stderr).not.toMatch(/FIXED BY THIS CANDIDATE/);
      expect(r.stderr).toMatch(/INDETERMINATE/);
      expect(rep.verdict).not.toBe("PASS");
    }, 300_000);

    test("release control: a candidate that truly accepts -> releaseFixed 1, exit 0, PASS", () => {
      const dir = scaffold({ client: SENDS_NOPE, spec: specOf(upd(ORG)), candidate: specOf(upd({ ...ORG, nope: required(str) })) });
      const r = run(dir, releaseArgsJ);
      expect(r.code, r.stderr).toBe(0);
      const rep = reportOf(dir);
      expect(rep.causes.releaseFixed).toBe(1);
      expect(rep.release.indeterminate).toBe(0);
      expect(rep.verdict).toBe("PASS");
    }, 300_000);
  });

  describe("Q3 (batch 6): CLI wiring of the per-call identity", () => {
    test("release, two calls on one line: deployed rejects A, candidate rejects B -> 8, releaseFixed 1, releaseBreaks 1", () => {
      const dir = scaffold({
        client: sameLine("", '{ orgId: "o", tag: 1 }', '{ orgId: "o", tag: "s" }'),
        spec: specOf(upd({ ...ORG, tag: required(str) })),
        candidate: specOf(upd({ ...ORG, tag: required({ type: "number" }) })),
      });
      const r = run(dir, releaseArgsJ);
      expect(r.code, r.stderr).toBe(8);
      const causes = reportOf(dir).causes;
      expect(causes.releaseFixed).toBe(1);
      expect(causes.releaseBreaks).toBe(1);
    }, 300_000);

    test("production --current: a current UNKNOWN at site A on the cited path -> 9, not 7", () => {
      const dir = scaffold({
        client: CLIENT("v: unknown", "{ orgId: \"o\", tag: v }"),
        spec: specOf(upd(ORG)),
        current: specOf(upd({ ...ORG, tag: required(str) })),
      });
      const r = current(dir);
      expect(r.code, r.stderr).toBe(9);
      expect(r.stderr).not.toMatch(/Deploy the Convex backend/);
      expect(reportOf(dir).causes.provenBreaks).toBe(0);
    }, 300_000);
  });

  describe("batch 8 (D-31): every call count is distinct call sites, and callOutcomes is wired", () => {
    const TWO_BREAKS_ONE_CALL = CLIENT("", '{ orgId: "o", nope: "x", other: "y" }');
    const num = { type: "number" };

    test("U-3 (N7-2): --spec + --current, two breaks at ONE call both REJECTED_OTHER -> callOutcomes {0,1,0} and '1 of these call(s)'", () => {
      const dir = scaffold({
        client: TWO_BREAKS_ONE_CALL,
        spec: specOf(upd(ORG)),
        current: specOf(upd({ ...ORG, nope: required(num), other: required(num) })),
      });
      const r = current(dir);
      expect(r.code, r.stderr).toBe(7);
      const rep = reportOf(dir);
      expect(rep.causes.provenBreaks).toBe(2);
      expect(rep.classification.rejectedByCurrent).toBe(2);
      expect(rep.classification.callOutcomes).toEqual({ fixed: 0, stillFails: 1, unproven: 0 });
      expect(r.stderr).toMatch(/will not make 1 of these call\(s\) succeed/);
      expect(r.stderr).not.toMatch(/2 of these call\(s\)/);
      expect(r.stderr).toMatch(/2 proven, 0 unclassified/);
      // The alert summary counts the same distinct call.
      expect(rep.alert.summary).toMatch(/\b1 call\(s\) the deployed backend refuses/);
    }, 300_000);

    test("U-1: release, two breaks at one call -> '1 call(s)'; two calls -> '2 call(s)' (never the break count)", () => {
      const one = scaffold({
        client: TWO_BREAKS_ONE_CALL,
        spec: specOf(upd({ ...ORG, nope: required(str), other: required(str) })),
        candidate: specOf(upd({ ...ORG, nope: required(num), other: required(num) })),
      });
      const r1 = run(one, releaseArgsJ);
      expect(r1.code, r1.stderr).toBe(8);
      expect(reportOf(one).causes.releaseBreaks).toBe(2);
      expect(r1.stderr).toMatch(/RELEASE BREAK - 1 call\(s\) this candidate would introduce/);
      const two = scaffold({
        client: sameLine("", '{ orgId: "o", tag: "s" }', '{ orgId: "o", tag: "t" }'),
        spec: specOf(upd({ ...ORG, tag: required(str) })),
        candidate: specOf(upd({ ...ORG, tag: required(num) })),
      });
      const r2 = run(two, releaseArgsJ);
      expect(r2.code, r2.stderr).toBe(8);
      expect(reportOf(two).causes.releaseBreaks).toBe(2);
      expect(r2.stderr).toMatch(/RELEASE BREAK - 2 call\(s\) this candidate would introduce/);
    }, 300_000);

    test("U-6 (N7-5): in release mode the JSON callOutcomes is null (release has its own facts), and the exit is still 8", () => {
      const dir = scaffold({
        client: PROVEN,
        spec: specOf(upd({ orgId: required(num) })),
        candidate: specOf(upd({ orgId: required({ type: "boolean" }) })),
      });
      const r = run(dir, releaseArgsJ);
      expect(r.code, r.stderr).toBe(8);
      const rep = reportOf(dir);
      expect(rep.classification.callOutcomes).toBeNull();
      expect(rep.causes.releaseBreaks).toBe(1);
    }, 300_000);

    test("U-1: no break count is worded as 'call path(s)' in the release standing sentences", () => {
      const spec = specOf(upd(ORG));
      const dir = scaffold({ client: TWO_BREAKS_ONE_CALL, spec, candidate: spec });
      const r = run(dir, releaseArgsJ);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/\(2 break\(s\) refused by the deployed backend and the candidate alike/);
      expect(r.stderr).not.toMatch(/call path\(s\)/);
    }, 300_000);
  });

  describe("M-1 (batch 6): an UNCLASSIFIED skew is not worded as a proven deploy fix", () => {
    // ⚠️ `--spec` is the SUPPLIED_FILE rung, which never gives deploy advice at
    // all, and the credential-ladder rungs cannot run offline. So the CLI tests pin
    // the exit and the unclassified breaks, and that no PROVEN-fix instruction
    // leaks out; the "likely remedy, not proven" wording on the production rung is
    // pinned at the skewSummary level (skewWording.test.ts).
    test("no evidence at all: still exit 7 with UNCLASSIFIED breaks and no proven-deploy instruction", () => {
      const dir = scaffold({ client: SENDS_NOPE, spec: specOf(upd(ORG)) });
      const r = production(dir);
      expect(r.code, r.stderr).toBe(7);
      expect(reportOf(dir).classification.unclassified).toBeGreaterThan(0);
      expect(r.stderr).toMatch(/\[UNCLASSIFIED\]/);
      expect(r.stderr).toMatch(/0 proven, 1 unclassified/);
      expect(r.stderr).not.toMatch(/Deploy the Convex backend at this commit\./);
    }, 300_000);

    test("--deployed-sha that cannot be resolved: same - exit 7, UNCLASSIFIED, no proven-deploy instruction", () => {
      const dir = scaffold({ client: SENDS_NOPE, spec: specOf(upd(ORG)) });
      const r = production(dir, ["--deployed-sha", "0000000000000000000000000000000000000000"]);
      expect(r.code, r.stderr).toBe(7);
      expect(r.stderr).toMatch(/0 proven, 1 unclassified/);
      expect(r.stderr).not.toMatch(/Deploy the Convex backend at this commit\./);
    }, 300_000);
  });

  describe("N-3: a release with only a standing break says so", () => {
    const sameSpec = () => specOf(upd(ORG));

    test("standing-only: verdict STANDING, exit 0, the sentence names a known standing break, never '0 reviewed paths remain unverified'", () => {
      const dir = scaffold({ client: SENDS_NOPE, spec: sameSpec(), candidate: sameSpec() });
      const r = run(dir, releaseArgsJ);
      expect(r.code, r.stderr).toBe(0);
      expect(reportOf(dir).verdict).toBe("STANDING");
      expect(r.stderr).toMatch(/known standing break/i);
      expect(r.stderr).not.toMatch(/UNKNOWN: 0 reviewed paths remain unverified/);
    }, 300_000);

    test("V-1: the STANDING CONTRACT DEFECT line counts 'break(s)', not 'path(s)'", () => {
      const dir = scaffold({ client: SENDS_NOPE, spec: sameSpec(), candidate: sameSpec() });
      const r = run(dir, releaseArgsJ);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/STANDING CONTRACT DEFECT — 1 break\(s\)\. The current backend/);
      expect(r.stderr).not.toMatch(/STANDING CONTRACT DEFECT — \d+ path\(s\)/);
    }, 300_000);

    test("a standing break AND baselined unknown debt keeps both facts", () => {
      const client = CLIENT("v: unknown", '{ orgId: v, nope: "x" }');
      const dir = scaffold({ client, spec: sameSpec(), candidate: sameSpec() });
      baselineFrom(dir);
      const r = run(dir, releaseArgsJ);
      expect(r.code, r.stderr).toBe(0);
      expect(reportOf(dir).verdict).toBe("UNKNOWN");
      expect(r.stderr).toMatch(/known standing break/i);
      expect(r.stderr).toContain("verdict UNKNOWN: 1 reviewed paths remain unverified");
    }, 300_000);
  });

  describe("N-4: every gap says which spec it came from", () => {
    test("identical gaps against deployed and current stay two, attributed to each role", () => {
      const dir = scaffold({ client: PROVEN, spec: specOf(nullArgs), current: specOf(nullArgs) });
      const r = current(dir);
      expect(r.code).toBe(9);
      const gaps = reportOf(dir).gaps as Array<{ spec: string }>;
      expect(gaps.map((g) => g.spec).sort()).toEqual(["current", "deployed"]);
      expect(r.stderr).toMatch(/\[coverage gap\].*\[spec: deployed\]/);
      expect(r.stderr).toMatch(/\[coverage gap\].*\[spec: current\]/);
    }, 300_000);

    test("L-4: the coverage line counts distinct CALLS: one args:null call seen through two specs is '1 call(s)'", () => {
      const dir = scaffold({ client: PROVEN, spec: specOf(nullArgs), current: specOf(nullArgs) });
      const r = current(dir);
      expect(r.code).toBe(9);
      // The per-spec rows stay listed, each with its tag...
      expect((reportOf(dir).gaps as unknown[]).length).toBe(2);
      // ...but it is ONE call.
      const line = (reportOf(dir).causes.coverageIncomplete as string[]).join(" ");
      expect(line).toMatch(/\b1 call\(s\) into a validator this control cannot compare/);
    }, 300_000);

    test("a candidate's gap is attributed to the candidate", () => {
      const dir = scaffold({ client: PROVEN, spec: DEPLOYED, candidate: specOf(nullArgs) });
      const r = run(dir, releaseArgsJ);
      expect(r.code).toBe(4);
      expect((reportOf(dir).gaps as Array<{ spec: string }>).map((g) => g.spec)).toEqual(["candidate"]);
      expect(r.stderr).toMatch(/\[spec: candidate\]/);
    }, 300_000);
  });
});

describe("wording", () => {
  test("neither the CLI nor the workflow carries the unconditional 'No production skew detected'", () => {
    for (const file of ["scripts/contractSkew/cli.mjs", ".github/workflows/contract-skew.yml"]) {
      expect(fs.readFileSync(path.resolve(file), "utf8"), file).not.toMatch(FORBIDDEN_WORDING);
    }
  });
});
