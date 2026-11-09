// @vitest-environment node
/**
 * SCRUM-418 section 6, guardrail 4: count pins become enumerated sets. A test
 * file may not assert a literal count of 10 or more on `.length`, `.size`,
 * `Object.keys(...).length` or `toHaveLength` more often than the trusted target
 * tree's copy of the same file does. Skip-listed frozen lists (read from the
 * target config) and `toBeGreaterThan` floors are out of scope.
 */
import { describe, expect, test } from "vitest";

import { findCountPins, markerProblems } from "./countPins.mjs";
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
    git(root, "checkout", "-q", "-b", "pr");
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
describe("inline exemption marker for fixture counts", () => {
  const MARK = "// guardrail-4-fixture:";
  const withBody = (body: string): string => `import { expect, test } from 'vitest';\ntest('t', () => {\n${body}\n});\n`;

  test("negative control: an unmarked new pin fails, and the message names both fixes", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/clean.test.ts", withBody("  expect([].length).toBe(12);"));
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-GROWN lib\/clean\.test\.ts: 1 > target 0/);
    expectFailure(
      result.errors,
      /convert the pin to set equality in both directions, or mark it `\/\/ guardrail-4-fixture: <reason>` if it is a fixture count/,
    );
  }, TIMEOUT);

  test("positive control: a marker with a reason on the line above exempts the pin", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/clean.test.ts", withBody(`  ${MARK} the fixture seeds exactly 12 rows\n  expect([].length).toBe(12);`));
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.countPins).toEqual({ pr: 1, target: 1 });
  }, TIMEOUT);

  test("positive control: a marker with a reason at the end of the same line exempts the pin", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/clean.test.ts", withBody(`  expect([].length).toBe(12); ${MARK} the fixture seeds exactly 12 rows`));
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("a marker exempts exactly one assertion", async () => {
    const root = fixtureRepo(TARGET);
    write(
      root,
      "lib/clean.test.ts",
      withBody(`  ${MARK} the fixture seeds exactly 12 rows\n  expect([].length).toBe(12);\n  expect([].length).toBe(13);`),
    );
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-GROWN lib\/clean\.test\.ts: 1 > target 0 \(\+1\)[^\n]*\n {2}line 5: toBe\(13\)$/);
  }, TIMEOUT);

  test("negative control: a marker with no reason fails, bare or with only a colon", async () => {
    for (const bare of ["// guardrail-4-fixture:", "// guardrail-4-fixture", "// guardrail-4-fixture:   "]) {
      const root = fixtureRepo(TARGET);
      write(root, "lib/clean.test.ts", withBody(`  ${bare}\n  expect([].length).toBe(12);`));
      const result = await check(root);
      expectFailure(result.errors, /^COUNT-PIN-MARKER-NO-REASON lib\/clean\.test\.ts:3\b/);
    }
  }, TIMEOUT);

  test("negative control: a stray marker that exempts nothing fails", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/clean.test.ts", withBody(`  ${MARK} nothing here is pinned\n  expect([].length).toBe(9);`));
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-MARKER-UNUSED lib\/clean\.test\.ts:3\b/);
  }, TIMEOUT);

  test("negative control: a marker two lines above its pin does not reach it", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "lib/clean.test.ts", withBody(`  ${MARK} too far away\n  const a = 1;\n  expect([].length).toBe(12);`));
    const result = await check(root);
    expectFailure(result.errors, /^COUNT-PIN-MARKER-UNUSED lib\/clean\.test\.ts:3\b/);
    expectFailure(result.errors, /^COUNT-PIN-GROWN lib\/clean\.test\.ts: 1 > target 0/);
  }, TIMEOUT);

  test("positive control: the marker text inside a string is not a marker", () => {
    expect(markerProblems("lib/x.test.ts", "const s = '// guardrail-4-fixture:';")).toEqual([]);
  });
});

describe("801-01: every expect root and modifier is normalised before the subject is classified", () => {
  test("positive control: expect.soft, resolves, rejects and expect.poll pins are found", () => {
    expect(pinned("expect.soft(list).toHaveLength(12);")).toBe(1);
    expect(pinned("expect.soft(list.length).toBe(12);")).toBe(1);
    expect(pinned("await expect(p).resolves.toHaveLength(12);")).toBe(1);
    expect(pinned("await expect(p).rejects.toHaveLength(12);")).toBe(1);
    expect(pinned("await expect.poll(() => list.length).toBe(12);")).toBe(1);
    expect(pinned("await expect.poll(() => list).toHaveLength(12);")).toBe(1);
    expect(pinned("await expect.poll(() => { return list.length; }).toBe(12);")).toBe(1);
  });

  test("negative control: the .not variant of each form is not a pin", () => {
    expect(pinned("expect.soft(list).not.toHaveLength(12);")).toBe(0);
    expect(pinned("expect.soft(list.length).not.toBe(12);")).toBe(0);
    expect(pinned("await expect(p).resolves.not.toHaveLength(12);")).toBe(0);
    expect(pinned("await expect(p).rejects.not.toHaveLength(12);")).toBe(0);
    expect(pinned("await expect.poll(() => list.length).not.toBe(12);")).toBe(0);
  });

  test("negative control: a poll callback that does not directly return the subject is not a pin", () => {
    expect(pinned("await expect.poll(() => { const n = list.length; return n; }).toBe(12);")).toBe(0);
    expect(pinned("await expect.poll(source).toHaveLength(12);")).toBe(0);
    expect(pinned("expect.extend(list).toHaveLength(12);")).toBe(0);
  });
});

describe("801-02: a marker pairs with the pin's whole line span", () => {
  const body = (lines: string[]): string => `import { expect, test } from 'vitest';\ntest('t', () => {\n${lines.join("\n")}\n});\n`;
  const NOTE = "// guardrail-4-fixture: page size";

  test("positive control: a trailing marker on the closing line of spread-out arguments exempts the pin", () => {
    const text = body(["  expect(", "    rows,", `  ).toHaveLength(200); ${NOTE}`]);
    expect(findCountPins("lib/x.test.ts", text)).toEqual([]);
    expect(markerProblems("lib/x.test.ts", text)).toEqual([]);
  });

  test("positive control: a trailing marker when the matcher is on the next line exempts the pin", () => {
    const text = body(["  expect(rows)", `    .toHaveLength(200); ${NOTE}`]);
    expect(findCountPins("lib/x.test.ts", text)).toEqual([]);
    expect(markerProblems("lib/x.test.ts", text)).toEqual([]);
  });

  test("positive control: the line above the pin's first line still pairs", () => {
    const text = body([`  ${NOTE}`, "  expect(rows)", "    .toHaveLength(200);"]);
    expect(findCountPins("lib/x.test.ts", text)).toEqual([]);
    expect(markerProblems("lib/x.test.ts", text)).toEqual([]);
  });

  test("negative control: a marker on the line after the span's end exempts nothing and is unused", () => {
    const text = body(["  expect(rows)", "    .toHaveLength(200);", `  ${NOTE}`, "  expect(1).toBe(1);"]);
    expect(findCountPins("lib/x.test.ts", text)).toHaveLength(1);
    expect(markerProblems("lib/x.test.ts", text)).toEqual([{ code: "COUNT-PIN-MARKER-UNUSED", line: 5 }]);
  });

  test("the pin still reports its start line, matcher and value only", () => {
    expect(findCountPins("lib/x.test.ts", body(["  expect(rows)", "    .toHaveLength(200);"]))).toEqual([
      { line: 3, matcher: "toHaveLength", value: 200 },
    ]);
  });
});

describe("801-03: every comment is enumerated with a full scanner pass", () => {
  const UNUSED = (line: number) => [{ code: "COUNT-PIN-MARKER-UNUSED", line }];
  const STRAY = "// guardrail-4-fixture: nothing to exempt";

  test("negative control: a stray marker directly before a closing } is seen", () => {
    expect(markerProblems("lib/x.test.ts", `test('t', () => {\n  ${STRAY}\n});\n`)).toEqual(UNUSED(2));
  });

  test("negative control: a stray marker directly before a closing ) is seen", () => {
    expect(markerProblems("lib/x.test.ts", `foo(\n  a,\n  ${STRAY}\n);\n`)).toEqual(UNUSED(3));
  });

  test("negative control: a stray marker directly before a closing ] is seen", () => {
    expect(markerProblems("lib/x.test.ts", `const a = [\n  1,\n  ${STRAY}\n];\n`)).toEqual(UNUSED(3));
  });

  test("negative control: a bare marker before a closing } gets NO-REASON", () => {
    const text = "test('t', () => {\n  // guardrail-4-fixture\n});\n";
    expect(markerProblems("lib/x.test.ts", text)).toEqual([{ code: "COUNT-PIN-MARKER-NO-REASON", line: 2 }]);
  });

  test("positive control: marker text in a string, template literal or regex literal is not a marker", () => {
    const texts = [
      "const s = '// guardrail-4-fixture: x';",
      'const s = "// guardrail-4-fixture: x";',
      "const t = `// guardrail-4-fixture: x`;",
      "const t = `a ${b} // guardrail-4-fixture: x ${c} d`;",
      "const t = `a ${`// guardrail-4-fixture: x ${d}`} e`;",
      "const t = `a ${ {k: 1}.k } // guardrail-4-fixture: x`;",
      "const r = /\\/\\/ guardrail-4-fixture: x/;",
      "const r = x.split(/\\/\\/ guardrail-4-fixture: x/);",
      "const n = a / b; const t = `// guardrail-4-fixture: x`;",
    ];
    for (const text of texts) expect(markerProblems("lib/x.test.ts", text), text).toEqual([]);
  });

  test("a real marker after a template literal and a regex literal is still seen", () => {
    const text = `const t = \`a \${b}\`;\nconst r = /x\\//;\n${STRAY}\nfoo();\n`;
    expect(markerProblems("lib/x.test.ts", text)).toEqual(UNUSED(3));
  });
});
