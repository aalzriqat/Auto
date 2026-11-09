// @vitest-environment node
/**
 * SCRUM-418 section 6, guardrail 4: count pins become enumerated sets. A test
 * file may not assert a literal count of 10 or more on `.length`, `.size`,
 * `Object.keys(...).length` or `toHaveLength` more often than the trusted target
 * tree's copy of the same file does. Skip-listed frozen lists (read from the
 * target config) and `toBeGreaterThan` floors are out of scope.
 */
import { describe, expect, test } from "vitest";

import { findCountPins } from "./countPins.mjs";
import {
  TIMEOUT,
  baseConfig,
  check,
  expectFailure,
  fixtureRepo,
  git,
  registerFixtureCleanup,
  write,
  writeConfig,
} from "./testkit";

registerFixtureCleanup();

const pinned = (source: string): number => findCountPins("lib/x.test.ts", source).length;

describe("count pin detection is AST-based", () => {
  test("negative control: every literal count of 10 or more on a size is a pin", () => {
    expect(pinned("expect(x.length).toBe(12);")).toBe(1);
    expect(pinned("expect(x).toHaveLength(12);")).toBe(1);
    expect(pinned("expect(set.size).toBe(12);")).toBe(1);
    expect(pinned("expect(Object.keys(o).length).toBe(12);")).toBe(1);
    expect(pinned("expect(x.length).toEqual(10);")).toBe(1);
    expect(pinned("expect(x.length).toStrictEqual(10);")).toBe(1);
    expect(pinned("expect(new Set(a).size).toBe(1_2);")).toBe(1);
    expect(pinned("expect(x.length).toBe(12);\nexpect(y).toHaveLength(13);")).toBe(2);
  });

  test("the pin reports its line, matcher and value", () => {
    expect(findCountPins("lib/x.test.ts", "\n\nexpect(x.length).toBe(12);")).toEqual([
      { line: 3, matcher: "toBe", value: 12 },
    ]);
  });

  test("positive control: below the threshold, floors and non-count assertions pass", () => {
    expect(pinned("expect(x.length).toBe(9);")).toBe(0);
    expect(pinned("expect(x).toHaveLength(9);")).toBe(0);
    expect(pinned("expect(x.length).toBeGreaterThan(12);")).toBe(0);
    expect(pinned("expect(x.length).toBeGreaterThanOrEqual(12);")).toBe(0);
    expect(pinned("expect(total).toBe(12);")).toBe(0);
    expect(pinned("expect(x.length).not.toBe(12);")).toBe(0);
    expect(pinned("expect(x.length).toBe(EXPECTED);")).toBe(0);
    expect(pinned("expect(x.length).toBe(12.5);")).toBe(0);
  });

  test("positive control: a mention in a string, template or comment is not a pin", () => {
    expect(pinned("const s = 'expect(x.length).toBe(12)';")).toBe(0);
    expect(pinned("const t = `expect(x).toHaveLength(12)`;")).toBe(0);
    expect(pinned("// expect(x.length).toBe(12);")).toBe(0);
  });
});

const PIN = "import { expect, test } from 'vitest';\ntest('t', () => {\n  expect([].length).toBe(12);\n});\n";
const NO_PIN = "import { expect, test } from 'vitest';\ntest('t', () => {\n  expect([].length).toBe(0);\n});\n";
const TARGET = { "lib/pinned.test.ts": PIN, "lib/clean.test.ts": NO_PIN };

describe("count pin ratchet against the trusted target tree", () => {
  test("negative control: a reintroduced pin in a clean test file fails, with its line", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/clean.test.ts", PIN);
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-GROWN lib\/clean\.test\.ts: 1 > target 0 \(\+1\)[^\n]*\n {2}line 3: toBe\(12\)$/);
    expect(result.errors).toHaveLength(1);
  }, TIMEOUT);

  test("negative control: a pin in a new test file fails", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/new.test.ts", PIN);
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-GROWN lib\/new\.test\.ts: 1 > target 0/);
  }, TIMEOUT);

  test("negative control: moving a pin to another file does not hide it", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/pinned.test.ts", NO_PIN);
    write(root, "lib/moved.test.ts", PIN);
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-GROWN lib\/moved\.test\.ts: 1 > target 0/);
  }, TIMEOUT);

  test("negative control: a second pin in an already pinned file fails", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/pinned.test.ts", `${PIN}expect([].length).toHaveLength(20);\n`);
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-GROWN lib\/pinned\.test\.ts: 2 > target 1 \(\+1\)/);
  }, TIMEOUT);

  test("positive control: an unchanged pinned file passes", async () => {
    const root = fixtureRepo(TARGET);
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.countPins).toEqual({ pr: 1, target: 1 });
  }, TIMEOUT);

  test("positive control: converting a pin passes and the notice offers the tighter count", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/pinned.test.ts", NO_PIN);
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.notices).toContain("count pins can tighten: lib/pinned.test.ts 1 -> 0");
  }, TIMEOUT);

  test("positive control: a toBeGreaterThan floor and a small count pass", async () => {
    const root = fixtureRepo(TARGET);
    write(
      root,
      "lib/clean.test.ts",
      "import { expect, test } from 'vitest';\ntest('t', () => {\n  expect([].length).toBeGreaterThan(12);\n  expect([].length).toBe(9);\n});\n",
    );
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);
});

describe("the skip list", () => {
  const SKIPPED = { ...TARGET, "lib/frozen.test.ts": PIN };

  test("positive control: a skip-listed file in the TARGET config may grow", async () => {
    // The target commit already carries the config, so commit the skip there.
    const config = { ...baseConfig(), countPinSkips: [{ path: "lib/frozen.test.ts", reason: "frozen list of 12 entries" }] };
    const root = fixtureRepo(SKIPPED, { config });
    write(root, "lib/frozen.test.ts", `${PIN}expect([].length).toBe(13);\n`);
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("negative control: a skip the PR adds to its own config is not honoured", async () => {
    const root = fixtureRepo(SKIPPED);
    writeConfig(root, { ...baseConfig(), countPinSkips: [{ path: "lib/frozen.test.ts", reason: "frozen list of 12 entries" }] });
    write(root, "lib/frozen.test.ts", `${PIN}expect([].length).toBe(13);\n`);
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-GROWN lib\/frozen\.test\.ts: 2 > target 1/);
    expect(result.notices.some((n) => /ALLOWANCE-CHANGE countPinSkips \+ "lib\/frozen\.test\.ts"/.test(n))).toBe(true);
  }, TIMEOUT);

  test("negative control: a skip entry for a file that no longer exists is stale", async () => {
    const config = { ...baseConfig(), countPinSkips: [{ path: "lib/gone.test.ts", reason: "frozen list of 12 entries" }] };
    const root = fixtureRepo(SKIPPED, { config });
    const result = await check(root);
    expectFailure(result.errors, /^STALE-ENTRY countPinSkips: "lib\/gone\.test\.ts"/);
  }, TIMEOUT);

  test("negative control: a skip entry needs a reason", async () => {
    const config = { ...baseConfig(), countPinSkips: [{ path: "lib/frozen.test.ts", reason: "x" }] };
    const root = fixtureRepo(SKIPPED, { config });
    await expect(check(root)).rejects.toThrow(/needs a one-line justification/);
  }, TIMEOUT);

  test("a config without the countPinSkips key still parses (target written before guardrail 4)", async () => {
    const root = fixtureRepo(TARGET);
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);
});

describe("a rename is compared with the old path's target count", () => {
  // Enough unchanged lines that git's rename detection (50% similarity) still pairs the files.
  const FILLER = Array.from({ length: 30 }, (_, i) => `// filler line ${i}`).join("\n");
  const BIG = `${PIN}${FILLER}\n`;
  const renameAndCommit = (root: string, edited?: string): void => {
    git(root, "mv", "lib/pinned.test.ts", "lib/renamed.test.ts");
    if (edited !== undefined) write(root, "lib/renamed.test.ts", edited);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "rename");
  };

  test("positive control: a rename with no change to its pins passes", async () => {
    const root = fixtureRepo({ ...TARGET, "lib/pinned.test.ts": BIG });
    renameAndCommit(root);
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("negative control: a rename that adds a pin fails against the old path's count", async () => {
    const root = fixtureRepo({ ...TARGET, "lib/pinned.test.ts": BIG });
    renameAndCommit(root, `${BIG}expect([].length).toHaveLength(20);\n`);
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-GROWN lib\/renamed\.test\.ts: 2 > target 1 \(\+1\)/);
  }, TIMEOUT);

  test("positive control: a rename that removes its pin passes and offers the tighter count", async () => {
    const root = fixtureRepo({ ...TARGET, "lib/pinned.test.ts": BIG });
    renameAndCommit(root, BIG.replace("toBe(12)", "toBe(0)"));
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.notices).toContain("count pins can tighten: lib/renamed.test.ts 1 -> 0");
  }, TIMEOUT);
});