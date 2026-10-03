import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
const mutation = (identifier: string, fields: Record<string, unknown>) => ({
  identifier,
  functionType: "Mutation",
  args: { type: "object", value: fields },
});
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

/** A call the spec fully proves. */
const PROVEN =
  'import { useMutation } from "convex/react";\n' +
  "declare const api: { vehicles: { update: unknown } };\n" +
  "export const go = () => {\n" +
  "  const update = useMutation(api.vehicles.update);\n" +
  '  return update({ orgId: "o" });\n' +
  "};\n";

/** A value the type system cannot narrow: TYPE_UNKNOWN on `orgId`. */
const UNPROVEN =
  'import { useMutation } from "convex/react";\n' +
  "declare const api: { vehicles: { update: unknown } };\n" +
  "export const go = (v: unknown) => {\n" +
  "  const update = useMutation(api.vehicles.update);\n" +
  "  return update({ orgId: v });\n" +
  "};\n";

/** A key the deployed backend does not declare: a proven BREAKING finding. */
const SENDS_NOPE =
  'import { useMutation } from "convex/react";\n' +
  "declare const api: { vehicles: { update: unknown } };\n" +
  "export const go = () => {\n" +
  "  const update = useMutation(api.vehicles.update);\n" +
  '  return update({ orgId: "o", nope: "x" });\n' +
  "};\n";

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
    const deployed = specOf(mutation("vehicles.js:update", { orgId: required(str) }));
    const candidate = specOf(mutation("vehicles.js:update", { orgId: required(str), nope: required(str) }));
    const dir = scaffold({ client: SENDS_NOPE, spec: deployed, candidate });
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

describe("break / unknown precedence", () => {
  test("a proven break coexisting with UNKNOWN and drift still exits 7, not 9 or 10", () => {
    const deployed = specOf(mutation("vehicles.js:update", { orgId: required(str), tag: required(str) }));
    const current = specOf(mutation("vehicles.js:update", { orgId: required(str), tag: required(str), nope: required(str) }));
    const both =
      'import { useMutation } from "convex/react";\n' +
      "declare const api: { vehicles: { update: unknown } };\n" +
      "export const go = (v: unknown) => {\n" +
      "  const update = useMutation(api.vehicles.update);\n" +
      '  return update({ orgId: v, tag: "t", nope: "x" });\n' +
      "};\n";
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

describe("wording", () => {
  test("neither the CLI nor the workflow carries the unconditional 'No production skew detected'", () => {
    for (const file of ["scripts/contractSkew/cli.mjs", ".github/workflows/contract-skew.yml"]) {
      expect(fs.readFileSync(path.resolve(file), "utf8"), file).not.toMatch(FORBIDDEN_WORDING);
    }
  });
});
