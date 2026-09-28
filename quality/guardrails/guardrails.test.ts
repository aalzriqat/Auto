// @vitest-environment node
/**
 * SCRUM-426 — negative and positive controls for the blocking size + import
 * guardrails. Every fixture is a real throwaway git repository: the "target
 * branch" is a commit on `main`, and the PR is the working tree on top of it,
 * so the trust model (allowance read from the target via git, never from the
 * PR tree) is exercised end to end rather than mocked.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { resolveBaseRef, runGuardrails, writeBaseline } from "./check.mjs";
import { importViolations, parseConfig } from "./rules.mjs";

const TIMEOUT = 60_000;
const ZERO_SHA = "0".repeat(40);
const repos: string[] = [];

interface Entry {
  path: string;
  reason: string;
}
interface FixtureConfig {
  schemaVersion: number;
  maxLines: number;
  productionRoots: string[];
  extensions: string[];
  exemptions: Entry[];
  generated: Entry[];
  migrations: Entry[];
  nonDoors: Entry[];
}
interface Grandfather {
  rule: string;
  from: string;
  to: string;
}
interface FixtureBaseline {
  schemaVersion: number;
  sourceCommit: string;
  sizeCeilings: Record<string, number>;
  importGrandfather: Grandfather[];
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.email=guardrails@test", "-c", "user.name=guardrails", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

function remove(root: string, file: string): void {
  rmSync(path.join(root, file));
}

/** n statements; Prettier keeps exactly one non-blank line per statement. */
function lines(n: number, prefix = "v"): string {
  return Array.from({ length: n }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n") + "\n";
}

function baseConfig(): FixtureConfig {
  const reason = "fixture justification for this entry";
  return {
    schemaVersion: 1,
    maxLines: 600,
    productionRoots: ["components/", "convex/"],
    extensions: [".ts", ".tsx"],
    exemptions: [{ path: "convex/data.ts", reason }],
    generated: [{ path: "convex/_generated/server.ts", reason }],
    migrations: [{ path: "convex/migrateOld.ts", reason }],
    nonDoors: [{ path: "convex/schema.ts", reason }],
  };
}

function baseBaseline(): FixtureBaseline {
  return {
    schemaVersion: 1,
    sourceCommit: ZERO_SHA,
    sizeCeilings: { "convex/big.ts": 700 },
    importGrandfather: [
      { rule: "components-no-convex-utils", from: "components/Legacy.tsx", to: "convex/utils/money" },
    ],
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeConfig(root: string, config: FixtureConfig): void {
  write(root, "quality/guardrails/config.json", json(config));
}

function writeBaselineDoc(root: string, baseline: FixtureBaseline): void {
  write(root, "quality/guardrails/baseline.json", json(baseline));
}

/** A repo whose `main` commit is the trusted target, with guardrail files. */
function fixtureRepo({ withGuardrails = true } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "guardrails-"));
  repos.push(root);
  git(root, "init", "-q", "-b", "main");
  write(root, "convex/_generated/server.ts", "export const query = 1;\n");
  write(root, "convex/schema.ts", "export default {};\n");
  write(root, "convex/applications.ts", "export const door = 1;\n");
  write(root, "convex/utils/money.ts", "export const toMinor = (n: number) => n * 100;\n");
  write(root, "convex/big.ts", lines(700));
  write(root, "convex/data.ts", lines(900, "d"));
  write(root, "convex/migrateOld.ts", lines(800, "m"));
  write(root, "components/Legacy.tsx", 'import { toMinor } from "@/convex/utils/money";\nexport const x = toMinor(1);\n');
  if (withGuardrails) {
    writeConfig(root, baseConfig());
    writeBaselineDoc(root, baseBaseline());
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "target");
  return root;
}

async function check(root: string) {
  return runGuardrails({ cwd: root, env: {}, base: "main" });
}

function expectFailure(errors: string[], pattern: RegExp): void {
  expect(errors.some((e) => pattern.test(e)), `expected ${pattern} in:\n${errors.join("\n")}`).toBe(true);
}

afterEach(() => {
  while (repos.length) rmSync(repos.pop() as string, { recursive: true, force: true });
});

describe("file size", () => {
  test("positive control: the unchanged target tree and a new 600-line file pass", async () => {
    const root = fixtureRepo();
    write(root, "convex/newModule.ts", lines(600));
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("negative control: a new 601-line production file fails", async () => {
    const root = fixtureRepo();
    write(root, "convex/newModule.ts", lines(601));
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-NEW convex\/newModule\.ts: 601 lines > limit 600/);
  }, TIMEOUT);

  test("negative control: lines are counted after Prettier, so cramming statements onto one line does not evade", async () => {
    const root = fixtureRepo();
    write(root, "convex/crammed.ts", lines(601).replaceAll("\n", " ") + "\n");
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-NEW convex\/crammed\.ts: 601 lines/);
  }, TIMEOUT);

  test("negative control: a grandfathered file that grows by one line fails", async () => {
    const root = fixtureRepo();
    write(root, "convex/big.ts", lines(701));
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-GROWN convex\/big\.ts: 701 lines > grandfathered ceiling 700/);
  }, TIMEOUT);

  test("positive control: a grandfathered file that shrinks passes and is offered a lower ceiling", async () => {
    const root = fixtureRepo();
    write(root, "convex/big.ts", lines(650));
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.notices).toContain("ceiling can ratchet down: convex/big.ts 700 -> 650");
  }, TIMEOUT);

  test("tests, exemptions and listed migrations are not production files", async () => {
    const root = fixtureRepo();
    write(root, "convex/big.test.ts", lines(900));
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.measured?.counts.has("convex/data.ts")).toBe(false);
    expect(result.measured?.counts.has("convex/migrateOld.ts")).toBe(false);
  }, TIMEOUT);
});

describe("trusted target-branch allowance", () => {
  test("negative control: a PR-side threshold edit is ignored — the target's 600 applies — and itself fails", async () => {
    const root = fixtureRepo();
    writeConfig(root, { ...baseConfig(), maxLines: 5000 });
    write(root, "convex/newModule.ts", lines(601));
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-NEW convex\/newModule\.ts: 601 lines > limit 600/);
    expectFailure(result.errors, /^RATCHET maxLines raised 600 -> 5000/);
  }, TIMEOUT);

  test("negative control: a PR-side ceiling raise is ignored and fails the ratchet", async () => {
    const root = fixtureRepo();
    writeBaselineDoc(root, { ...baseBaseline(), sizeCeilings: { "convex/big.ts": 800 } });
    write(root, "convex/big.ts", lines(750));
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-GROWN convex\/big\.ts: 750 lines > grandfathered ceiling 700/);
    expectFailure(result.errors, /^RATCHET ceiling raised for convex\/big\.ts: 700 -> 800/);
  }, TIMEOUT);

  test("negative control: a PR-side exemption for its own oversized file is not effective", async () => {
    const root = fixtureRepo();
    const config = baseConfig();
    config.exemptions.push({ path: "convex/newModule.ts", reason: "attempting to exempt itself" });
    writeConfig(root, config);
    write(root, "convex/newModule.ts", lines(700));
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-NEW convex\/newModule\.ts: 700 lines/);
    expect(result.notices.some((n) => n.startsWith('ALLOWANCE-CHANGE exemptions + "convex/newModule.ts"'))).toBe(true);
  }, TIMEOUT);

  test("an unresolvable target ref throws instead of falling back to the PR tree", async () => {
    const root = fixtureRepo();
    await expect(runGuardrails({ cwd: root, env: {}, base: "origin/nope" })).rejects.toThrow(/does not resolve/);
  }, TIMEOUT);

  test("the base ref comes from CI context: PR target, push parent, local origin/main", () => {
    expect(resolveBaseRef({ GITHUB_BASE_REF: "main", GITHUB_EVENT_NAME: "pull_request" }, undefined)).toBe("origin/main");
    expect(resolveBaseRef({ GITHUB_EVENT_NAME: "push" }, undefined)).toBe("HEAD^");
    expect(resolveBaseRef({}, undefined)).toBe("origin/main");
    expect(resolveBaseRef({ GITHUB_BASE_REF: "main" }, "abc123")).toBe("abc123");
  });

  test("bootstrap: a target without guardrail files trusts only a baseline equal to the recomputation", async () => {
    const root = fixtureRepo({ withGuardrails: false });
    const target = git(root, "rev-parse", "HEAD");
    writeConfig(root, baseConfig());
    await writeBaseline(root, target, "main");
    const good = await check(root);
    expect(good.bootstrap).toBe(true);
    expect(good.errors).toEqual([]);

    const tampered = { ...baseBaseline(), sourceCommit: target, sizeCeilings: { "convex/big.ts": 900 } };
    writeBaselineDoc(root, tampered);
    const bad = await check(root);
    expectFailure(bad.errors, /^BOOTSTRAP baseline does not equal the recomputation/);
  }, TIMEOUT);
});

describe("enumerated lists against independent discovery", () => {
  test("negative control: a stale exemption entry fails", async () => {
    const root = fixtureRepo();
    remove(root, "convex/data.ts");
    const result = await check(root);
    expectFailure(result.errors, /^STALE-ENTRY exemptions: "convex\/data\.ts" no longer exists/);
  }, TIMEOUT);

  test("negative control: an unlisted generated file fails", async () => {
    const root = fixtureRepo();
    write(root, "convex/_generated/extra.ts", "export const y = 1;\n");
    const result = await check(root);
    expectFailure(result.errors, /^UNLISTED-GENERATED convex\/_generated\/extra\.ts/);
  }, TIMEOUT);

  test("negative control: an unlisted migration file fails", async () => {
    const root = fixtureRepo();
    write(root, "convex/migrateNew.ts", "export const z = 1;\n");
    const result = await check(root);
    expectFailure(result.errors, /^UNLISTED-MIGRATION convex\/migrateNew\.ts/);
  }, TIMEOUT);

  test("negative control: a stale size ceiling fails", async () => {
    const root = fixtureRepo();
    write(root, "convex/big.ts", lines(10));
    const result = await check(root);
    expectFailure(result.errors, /^STALE-CEILING convex\/big\.ts: 10 lines is within 600/);
  }, TIMEOUT);
});

describe("import boundaries", () => {
  test("negative control: a new components -> convex/utils import fails; the grandfathered one passes", async () => {
    const root = fixtureRepo();
    write(root, "components/NewWidget.tsx", 'import { toMinor } from "../convex/utils/money";\nexport const w = toMinor(2);\n');
    const result = await check(root);
    expect(result.errors).toEqual([
      "IMPORT-NEW [components-no-convex-utils] components/NewWidget.tsx -> convex/utils/money",
    ]);
  }, TIMEOUT);

  test("negative control: a grandfathered import that no longer exists must be removed from the list", async () => {
    const root = fixtureRepo();
    write(root, "components/Legacy.tsx", "export const x = 1;\n");
    const result = await check(root);
    expectFailure(result.errors, /^STALE-GRANDFATHER \[components-no-convex-utils\] components\/Legacy\.tsx/);
  }, TIMEOUT);

  test("negative control: policy -> convex/_generated/server fails", async () => {
    const root = fixtureRepo();
    write(root, "convex/domains/deals/policy/canClose.ts", 'import type { QueryCtx } from "../../../_generated/server";\nexport type C = QueryCtx;\n');
    const result = await check(root);
    expect(result.errors).toEqual([
      "IMPORT-NEW [policy-no-generated-server] convex/domains/deals/policy/canClose.ts -> convex/_generated/server",
    ]);
  }, TIMEOUT);

  test("negative control: policy -> React and domain -> door fail; domain -> utils and schema pass", async () => {
    const root = fixtureRepo();
    write(root, "convex/domains/deals/policy/view.ts", 'import { useMemo } from "react";\nexport const u = useMemo;\n');
    write(
      root,
      "convex/domains/deals/commands/close.ts",
      'import { door } from "@/convex/applications";\nimport { toMinor } from "../../../utils/money";\nimport schema from "../../../schema";\nexport const c = [door, toMinor, schema];\n',
    );
    const result = await check(root);
    expect(result.errors).toEqual([
      "IMPORT-NEW [domains-no-door] convex/domains/deals/commands/close.ts -> convex/applications",
      "IMPORT-NEW [policy-no-react] convex/domains/deals/policy/view.ts -> react",
    ]);
  }, TIMEOUT);

  test("import detection covers re-exports, dynamic import and require, but not comments or strings", () => {
    const config = parseConfig(json(baseConfig()), "fixture");
    const source = [
      '// import { a } from "@/convex/utils/commented";',
      'const s = "import x from \'@/convex/utils/inString\'";',
      'export { b } from "@/convex/utils/reexport";',
      'const lazy = () => import("@/convex/utils/dynamic");',
      'const c = require("@/convex/utils/required");',
    ].join("\n");
    const found = importViolations("components/A.tsx", source, config).map((v: Grandfather) => v.to).sort();
    expect(found).toEqual(["convex/utils/dynamic", "convex/utils/reexport", "convex/utils/required"]);
  });
});
