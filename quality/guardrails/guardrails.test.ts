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
import { BOOTSTRAP_POLICY, LEGACY_MIGRATIONS, importViolations, parseConfig } from "./rules.mjs";

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

/** The fixture's own scope stands in for the pinned owner policy on bootstrap. */
const FIXTURE_POLICY = {
  maxLines: 600,
  productionRoots: ["components/", "convex/"],
  extensions: [".ts", ".tsx"],
  nonDoors: ["convex/schema.ts"],
};

async function bootstrapCheck(root: string) {
  return runGuardrails({ cwd: root, env: {}, base: "main", bootstrapPolicy: FIXTURE_POLICY });
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
    expect(resolveBaseRef({ GITHUB_EVENT_NAME: "push", GUARDRAILS_PUSH_BEFORE: "a".repeat(40) }, undefined)).toBe("a".repeat(40));
    expect(resolveBaseRef({}, undefined)).toBe("origin/main");
    expect(resolveBaseRef({ GITHUB_BASE_REF: "main" }, "abc123")).toBe("abc123");
  });

  test("bootstrap: a target without guardrail files trusts only a baseline equal to the recomputation", async () => {
    const root = fixtureRepo({ withGuardrails: false });
    const target = git(root, "rev-parse", "HEAD");
    writeConfig(root, baseConfig());
    await writeBaseline(root, target, "main");
    const good = await bootstrapCheck(root);
    expect(good.bootstrap).toBe(true);
    expect(good.errors).toEqual([]);

    const tampered = { ...baseBaseline(), sourceCommit: target, sizeCeilings: { "convex/big.ts": 900 } };
    writeBaselineDoc(root, tampered);
    const bad = await bootstrapCheck(root);
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

describe("round-1 review findings (Sol S426-01..04, Codex 426-1..3)", () => {
  test("negative control (Codex 426-3): a root added by the PR is size-checked in the same PR", async () => {
    const root = fixtureRepo();
    const config = baseConfig();
    config.productionRoots.push("lib/");
    writeConfig(root, config);
    write(root, "lib/big.ts", lines(700));
    write(root, "lib/small.ts", lines(10));
    const result = await check(root);
    expect(result.errors).toEqual(["SIZE-NEW lib/big.ts: 700 lines > limit 600 (not grandfathered)"]);
  }, TIMEOUT);

  test("scope adoption: an UNCHANGED oversized file brought into scope may carry a ceiling; a changed one may not", async () => {
    const root = fixtureRepo();
    write(root, "lib/legacy.ts", lines(700, "l"));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "legacy outside scope");
    const config = baseConfig();
    config.productionRoots.push("lib/");
    writeConfig(root, config);
    writeBaselineDoc(root, { ...baseBaseline(), sizeCeilings: { "convex/big.ts": 700, "lib/legacy.ts": 700 } });
    const adopted = await check(root);
    expect(adopted.errors).toEqual([]);
    expect(adopted.notices).toContain("SCOPE-ADOPTED lib/legacy.ts: 700 lines, unchanged from the target");

    write(root, "lib/legacy.ts", lines(701, "l"));
    writeBaselineDoc(root, { ...baseBaseline(), sizeCeilings: { "convex/big.ts": 700, "lib/legacy.ts": 701 } });
    const grown = await check(root);
    expectFailure(grown.errors, /^SIZE-NEW lib\/legacy\.ts: 701 lines/);
    expectFailure(grown.errors, /^RATCHET new size ceiling for lib\/legacy\.ts/);
  }, TIMEOUT);

  test("negative control (S426-low): removing a ceiling from a still-oversized file fails now, not on the next run", async () => {
    const root = fixtureRepo();
    writeBaselineDoc(root, { ...baseBaseline(), sizeCeilings: {} });
    const result = await check(root);
    expectFailure(result.errors, /^MISSING-CEILING convex\/big\.ts: 700 lines > 600/);
  }, TIMEOUT);

  test("negative control (S426-04): list entries must match independent discovery in both directions", async () => {
    const root = fixtureRepo();
    const config = baseConfig();
    config.generated.push({ path: "convex/applications.ts", reason: "not actually generated code" });
    config.migrations.push({ path: "convex/utils/money.ts", reason: "not actually a migration file" });
    config.nonDoors.push({ path: "convex/utils/money.ts", reason: "not a top-level convex module" });
    writeConfig(root, config);
    const result = await check(root);
    expectFailure(result.errors, /^UNDISCOVERED-GENERATED convex\/applications\.ts/);
    expectFailure(result.errors, /^UNDISCOVERED-MIGRATION convex\/utils\/money\.ts/);
    expectFailure(result.errors, /^INVALID-NONDOOR convex\/utils\/money\.ts/);
  }, TIMEOUT);

  test("pinned legacy migrations and the bootstrap policy are the reviewed values", () => {
    expect([...LEGACY_MIGRATIONS]).toEqual([
      "convex/accountingMigration.ts",
      "convex/migrations.ts",
      "convex/seedDocuments.ts",
    ]);
    expect(BOOTSTRAP_POLICY).toEqual({
      maxLines: 600,
      productionRoots: ["app/", "apps/", "components/", "convex/", "dealer-worker/src/", "hooks/", "lib/", "packages/"],
      extensions: [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"],
      nonDoors: ["convex/schema.ts"],
    });
  });


  test("negative control (S426-02 / Codex 426-1): bootstrap cannot raise the limit, narrow scope, or exempt a new file", async () => {
    const root = fixtureRepo({ withGuardrails: false });
    const target = git(root, "rev-parse", "HEAD");
    const config = baseConfig();
    config.maxLines = 5000;
    config.productionRoots = ["convex/"];
    config.exemptions.push({ path: "convex/newModule.ts", reason: "exempting its own new file" });
    writeConfig(root, config);
    write(root, "convex/newModule.ts", lines(700));
    await writeBaseline(root, target, "main");
    const result = await bootstrapCheck(root);
    expect(result.bootstrap).toBe(true);
    expectFailure(result.errors, /^BOOTSTRAP-POLICY maxLines 5000 > pinned 600/);
    expectFailure(result.errors, /^BOOTSTRAP-POLICY productionRoots: "components\/" missing/);
    expectFailure(result.errors, /^BOOTSTRAP-NEW-ALLOWANCE exemptions: "convex\/newModule\.ts" does not exist on the target/);
  }, TIMEOUT);

  test("negative control (S426-02): bootstrap formats with the TARGET's Prettier options, not the PR's", async () => {
    const root = fixtureRepo({ withGuardrails: false });
    const target = git(root, "rev-parse", "HEAD");
    writeConfig(root, baseConfig());
    write(root, ".prettierrc", json({ printWidth: 1000000 }));
    const items = Array.from({ length: 700 }, (_, i) => `"item-number-${i}"`).join(", ");
    write(root, "convex/wide.ts", `export const wide = [${items}];\n`);
    await writeBaseline(root, target, "main");
    const result = await bootstrapCheck(root);
    expectFailure(result.errors, /^SIZE-NEW convex\/wide\.ts/);
  }, TIMEOUT);

  test("positive control: a faithful bootstrap still passes under the pinned policy", async () => {
    const root = fixtureRepo({ withGuardrails: false });
    const target = git(root, "rev-parse", "HEAD");
    writeConfig(root, baseConfig());
    await writeBaseline(root, target, "main");
    const result = await bootstrapCheck(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("negative control (S426-03): a push is judged against the pre-push SHA, not HEAD^", async () => {
    const root = fixtureRepo();
    const before = git(root, "rev-parse", "HEAD");
    writeConfig(root, { ...baseConfig(), maxLines: 5000 });
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "A: raise allowance");
    write(root, "convex/newModule.ts", lines(700));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "B: add debt");
    const result = await runGuardrails({ cwd: root, env: { GITHUB_EVENT_NAME: "push", GUARDRAILS_PUSH_BEFORE: before } });
    expect(result.baseCommit).toBe(before);
    expectFailure(result.errors, /^SIZE-NEW convex\/newModule\.ts: 700 lines > limit 600/);
  }, TIMEOUT);

  test("a push without a usable pre-push SHA, or a non-fast-forward push, fails closed", async () => {
    expect(() => resolveBaseRef({ GITHUB_EVENT_NAME: "push" }, undefined)).toThrow(/pre-push SHA/);
    expect(() => resolveBaseRef({ GITHUB_EVENT_NAME: "push", GUARDRAILS_PUSH_BEFORE: ZERO_SHA }, undefined)).toThrow(/pre-push SHA/);
    const root = fixtureRepo();
    git(root, "checkout", "-q", "-b", "side");
    write(root, "convex/side.ts", "export const s = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "side");
    const side = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");
    await expect(
      runGuardrails({ cwd: root, env: { GITHUB_EVENT_NAME: "push", GUARDRAILS_PUSH_BEFORE: side } }),
    ).rejects.toThrow(/not an ancestor/);
  }, TIMEOUT);
});

describe("round-2 review findings (Sol S426-05, Codex 426-1 r2)", () => {
  test("negative control (S426-05): a root added with its own exemption is still size-checked", async () => {
    const root = fixtureRepo();
    const config = baseConfig();
    config.productionRoots.push("lib/");
    config.exemptions.push({ path: "lib/new.ts", reason: "exempting a file in the root it adds" });
    writeConfig(root, config);
    write(root, "lib/new.ts", lines(700));
    const result = await check(root);
    expect(result.errors).toEqual(["SIZE-NEW lib/new.ts: 700 lines > limit 600 (not grandfathered)"]);
  }, TIMEOUT);

  test("negative control (S426-05): an extension added with its own exemption is still size-checked", async () => {
    const root = fixtureRepo();
    const config = baseConfig();
    config.extensions.push(".js");
    config.exemptions.push({ path: "convex/newScript.js", reason: "exempting a file of the extension it adds" });
    writeConfig(root, config);
    write(root, "convex/newScript.js", lines(700));
    const result = await check(root);
    expect(result.errors).toEqual(["SIZE-NEW convex/newScript.js: 700 lines > limit 600 (not grandfathered)"]);
  }, TIMEOUT);

  test("control (S426-05): an exemption in trusted scope is still not effective in its own PR, and trusted exemptions still hold", async () => {
    const root = fixtureRepo();
    const config = baseConfig();
    config.exemptions.push({ path: "convex/newModule.ts", reason: "exempting its own new file" });
    writeConfig(root, config);
    write(root, "convex/newModule.ts", lines(700));
    const result = await check(root);
    // convex/data.ts (900 lines, trusted exemption) produces nothing.
    expect(result.errors).toEqual(["SIZE-NEW convex/newModule.ts: 700 lines > limit 600 (not grandfathered)"]);
  }, TIMEOUT);

  test("positive control (S426-05): removing a trusted exemption still adopts the unchanged file with its exact ceiling", async () => {
    const root = fixtureRepo();
    const config = baseConfig();
    config.exemptions = [];
    writeConfig(root, config);
    writeBaselineDoc(root, { ...baseBaseline(), sizeCeilings: { "convex/big.ts": 700, "convex/data.ts": 900 } });
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.notices).toContain("SCOPE-ADOPTED convex/data.ts: 900 lines, unchanged from the target");
  }, TIMEOUT);

  test("negative control (Codex 426-1 r2): bootstrap cannot exempt a target file and change it in the same PR", async () => {
    const root = fixtureRepo({ withGuardrails: false });
    const target = git(root, "rev-parse", "HEAD");
    const config = baseConfig();
    config.exemptions.push({ path: "convex/big.ts", reason: "exempting a file this PR enlarges" });
    writeConfig(root, config);
    write(root, "convex/big.ts", lines(900));
    await writeBaseline(root, target, "main");
    const result = await bootstrapCheck(root);
    expectFailure(result.errors, /^BOOTSTRAP-CHANGED-ALLOWANCE exemptions: "convex\/big\.ts" differs from the target/);
  }, TIMEOUT);

  test("negative control (Codex 426-1 r2): bootstrap nonDoors are the pinned reviewed set", async () => {
    const root = fixtureRepo({ withGuardrails: false });
    const target = git(root, "rev-parse", "HEAD");
    const config = baseConfig();
    config.nonDoors.push({ path: "convex/applications.ts", reason: "a real door mislabelled as a non-door" });
    writeConfig(root, config);
    await writeBaseline(root, target, "main");
    const result = await bootstrapCheck(root);
    expect(result.errors).toEqual([
      'BOOTSTRAP-POLICY nonDoors: "convex/applications.ts" is not a pinned reviewed non-door',
    ]);
  }, TIMEOUT);
});

describe("CodeRabbit review on #356 (CR-1..3)", () => {
  /** A target whose history has an OLDER commit, `old`, and the tip `main`. */
  function repoWithHistory(atOld: (root: string) => void, atTarget: (root: string) => void) {
    const root = fixtureRepo({ withGuardrails: false });
    atOld(root);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "old");
    const old = git(root, "rev-parse", "HEAD");
    atTarget(root);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "target");
    writeConfig(root, baseConfig());
    return { root, old };
  }

  test("negative control (CR-1): bootstrap from an older commit cannot carry a ceiling above the target's size", async () => {
    const { root, old } = repoWithHistory(
      (r) => write(r, "convex/big.ts", lines(1000)),
      (r) => write(r, "convex/big.ts", lines(700)),
    );
    await writeBaseline(root, old, "main");
    const result = await bootstrapCheck(root);
    expectFailure(result.errors, /^BOOTSTRAP-STALE-SOURCE convex\/big\.ts: ceiling 1000 exceeds the target's 700/);
  }, TIMEOUT);

  test("negative control (CR-1): a file deleted on the target cannot come back under the old ceiling", async () => {
    const { root, old } = repoWithHistory(
      (r) => write(r, "convex/gone.ts", lines(900, "g")),
      (r) => remove(r, "convex/gone.ts"),
    );
    await writeBaseline(root, old, "main");
    write(root, "convex/gone.ts", lines(900, "g"));
    const result = await bootstrapCheck(root);
    expectFailure(result.errors, /^BOOTSTRAP-STALE-SOURCE convex\/gone\.ts: ceiling 900 exceeds the target's none/);
  }, TIMEOUT);

  test("negative control (CR-1): an import removed on the target cannot come back grandfathered", async () => {
    const legacy = 'import { toMinor } from "@/convex/utils/money";\nexport const y = toMinor(3);\n';
    const { root, old } = repoWithHistory(
      (r) => write(r, "components/Old.tsx", legacy),
      (r) => remove(r, "components/Old.tsx"),
    );
    await writeBaseline(root, old, "main");
    write(root, "components/Old.tsx", legacy);
    const result = await bootstrapCheck(root);
    expectFailure(
      result.errors,
      /^BOOTSTRAP-STALE-SOURCE import \[components-no-convex-utils\] components\/Old\.tsx -> convex\/utils\/money/,
    );
  }, TIMEOUT);

  test("positive control (CR-1/CR-2): an older source whose allowances equal the target's passes, even when its Prettier options differed", async () => {
    const items = Array.from({ length: 700 }, (_, i) => `"item-number-${i}"`).join(", ");
    const { root, old } = repoWithHistory(
      (r) => {
        write(r, ".prettierrc", json({ printWidth: 1000000 }));
        write(r, "convex/wide.ts", `export const wide = [${items}];\n`);
      },
      (r) => remove(r, ".prettierrc"),
    );
    await writeBaseline(root, old, "main");
    const result = await bootstrapCheck(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("negative control (CR-3): a prettier-ignore pragma does not let a crammed file evade the size limit", async () => {
    const root = fixtureRepo();
    const items = Array.from({ length: 700 }, (_, i) => `"item-number-${i}"`).join(", ");
    write(root, "convex/crammed.ts", `// prettier-ignore\nexport const crammed = [${items}];\n`);
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-NEW convex\/crammed\.ts/);
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

  test("negative control (S426-01 / Codex 426-2): an equivalent alias spelling is judged as the file it resolves to", () => {
    const config = parseConfig(json(baseConfig()), "fixture");
    const to = (from: string, spec: string) =>
      importViolations(from, `import { x } from "${spec}";\nexport const y = x;\n`, config).map((v: Grandfather) => `${v.rule} ${v.to}`);
    expect(to("components/A.tsx", "@/convex/./utils/money")).toEqual(["components-no-convex-utils convex/utils/money"]);
    expect(to("components/A.tsx", "@/convex/x/../utils/money")).toEqual(["components-no-convex-utils convex/utils/money"]);
    expect(to("convex/domains/d/commands/c.ts", "@/convex/./applications")).toEqual(["domains-no-door convex/applications"]);
    expect(to("convex/domains/d/policy/p.ts", "@/convex/_generated/./server")).toEqual(["policy-no-generated-server convex/_generated/server"]);
    expect(to("convex/domains/d/policy/p.ts", "../../../../node_modules/react")).toEqual(["policy-no-react react"]);
    // Controls: the canonical form is unchanged, and an alias escaping the repo is not a repo module.
    expect(to("components/A.tsx", "@/convex/utils/money")).toEqual(["components-no-convex-utils convex/utils/money"]);
    expect(to("components/A.tsx", "@/../outside/convex/utils/money")).toEqual([]);
  });

  test("negative control (Codex 426-2 r2): a doubled alias slash resolves to the same module and is judged as it", () => {
    const config = parseConfig(json(baseConfig()), "fixture");
    const to = (from: string, spec: string) =>
      importViolations(from, `import { x } from "${spec}";\nexport const y = x;\n`, config).map((v: Grandfather) => `${v.rule} ${v.to}`);
    expect(to("components/A.tsx", "@//convex/utils/money")).toEqual(["components-no-convex-utils convex/utils/money"]);
    expect(to("convex/domains/d/commands/c.ts", "@///convex/applications")).toEqual(["domains-no-door convex/applications"]);
    // Control: stripping the slashes must not let an escape pass as a repo path.
    expect(to("components/A.tsx", "@//../outside/convex/utils/money")).toEqual([]);
  });

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
