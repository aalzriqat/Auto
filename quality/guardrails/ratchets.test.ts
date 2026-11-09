// @vitest-environment node
/**
 * SCRUM-418 section 6, guardrail 8: type-escape ratchet. Production files may
 * not raise the REPOSITORY TOTAL of `any` keywords, `as unknown as` chains,
 * @ts-ignore or @ts-expect-error comments above what the trusted target tree
 * holds, both measured by the same code. Moving code between files changes no
 * total. Tests are out of scope. Migration and exempt files are excused from
 * the size rule only, so their escapes count.
 */
import { describe, expect, test } from "vitest";

import { analyzeSource } from "./ratchets.mjs";
import {
  TIMEOUT,
  baseConfig,
  baseBaseline,
  bootstrapCheck,
  check,
  expectFailure,
  fixtureRepo,
  git,
  remove,
  registerFixtureCleanup,
  write,
  writeBaselineDoc,
  writeConfig,
} from "./testkit";

registerFixtureCleanup();

type Kind = "any" | "as-unknown-as" | "ts-ignore" | "ts-expect-error";
const count = (kind: Kind, source: string, file = "lib/x.ts"): number => analyzeSource(file, source)[kind];

describe("type-escape counting is AST-based", () => {
  test("any: counts the keyword wherever a type can appear, not strings, comments or identifiers", () => {
    expect(count("any", "const a: any = 1;")).toBe(1);
    expect(count("any", "const b = x as any;")).toBe(1);
    expect(count("any", "const c = <any>x;")).toBe(1);
    expect(count("any", "type D = Array<any> | Record<string, any>;")).toBe(2);
    expect(count("any", "function f(a: any, ...r: any[]): any { return a; }")).toBe(3);
    expect(count("any", "interface I { m(a: any): void }")).toBe(1);
    expect(count("any", "const any = 1; const s = 'x: any'; const t = `as any`; // any\n/* as any */")).toBe(0);
    expect(count("any", "const x: unknown = 1; type N = { any: string };")).toBe(0);
  });

  test("any: also counts in .tsx and does not choke on JSX", () => {
    expect(count("any", "export const C = (p: any) => <div>{(p as any).x}</div>;", "components/C.tsx")).toBe(2);
  });

  test("as-unknown-as: counts the double-cast chain, not a single cast to unknown", () => {
    expect(count("as-unknown-as", "const a = x as unknown as Foo;")).toBe(1);
    expect(count("as-unknown-as", "const b = (x as unknown) as Foo;")).toBe(1);
    expect(count("as-unknown-as", "const c = <Foo>(<unknown>x);")).toBe(1);
    expect(count("as-unknown-as", "const d = f(x as unknown as Foo, y as unknown as Bar);")).toBe(2);
    expect(count("as-unknown-as", "const e = x as unknown; const f = x as Foo; const g = x as Foo as Bar;")).toBe(0);
    expect(count("as-unknown-as", "const s = 'x as unknown as Foo'; // x as unknown as Foo")).toBe(0);
  });

  test("ts-ignore and ts-expect-error: real directive comments only", () => {
    const src = [
      "// @ts-ignore",
      "const a = 1;",
      "/* @ts-ignore */",
      "const b = 2;",
      "/**",
      " * the compiler honours a block comment only on its last line:",
      " * @ts-ignore */",
      "const c = 3;",
      "const d = [",
      "  1,",
      "  // @ts-expect-error because",
      "  2,",
      "];",
      "function f() {",
      "  const x = 1;",
      "  // @ts-expect-error trailing own-line comment before the brace",
      "}",
    ].join("\n");
    expect(count("ts-ignore", src)).toBe(3);
    expect(count("ts-expect-error", src)).toBe(2);
  });

  test("ts-ignore: a mention inside a string, a template or prose is not a directive", () => {
    const src = [
      "const s = '// @ts-ignore';",
      "const t = `// @ts-expect-error`;",
      "// remember not to use @ts-ignore here",
      "const re = /@ts-ignore/;",
    ].join("\n");
    expect(count("ts-ignore", src)).toBe(0);
    expect(count("ts-expect-error", src)).toBe(0);
  });

  test("JavaScript files carry no type syntax and are measured without error", () => {
    expect(count("any", "const a = 1; // @ts-ignore\nmodule.exports = a;", "lib/x.js")).toBe(0);
    expect(count("ts-ignore", "const a = 1; // @ts-ignore\nmodule.exports = a;", "lib/x.js")).toBe(1);
  });
});

const TARGET = {
  "convex/a.ts": "export const a: any = 1;\nexport const b: any = 2;\n",
  "convex/b.ts": "export const b = 1;\n",
};

describe("type-escape ratchet against the trusted target tree", () => {
  test("negative control: one more `any` than the target fails, with the per-file delta", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "convex/b.ts", "export const b: any = 1;\n");
    const result = await check(root);
    expectFailure(result.errors, /^TYPE-ESCAPE-GROWN any: 3 > target 2 \(\+1\)\n {2}convex\/b\.ts: 0 -> 1$/);
    expect(result.errors).toHaveLength(1);
  }, TIMEOUT);

  test.each([
    ["as-unknown-as", "export const v = 1 as unknown as string;\n"],
    ["ts-ignore", "// @ts-ignore\nexport const v: number = 'x';\n"],
    ["ts-expect-error", "// @ts-expect-error\nexport const v: number = 'x';\n"],
  ])("negative control: a new %s fails", async (kind, source) => {
    const root = fixtureRepo(TARGET);
    write(root, "convex/b.ts", source);
    const result = await check(root);
    expectFailure(result.errors, new RegExp(`^TYPE-ESCAPE-GROWN ${kind}: 1 > target 0 \\(\\+1\\)`));
  }, TIMEOUT);

  test("positive control: a compliant change (new typed file, no escapes) passes", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "convex/c.ts", "export const c: number = 3;\n");
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.ratchets?.pr.any).toBe(2);
    expect(result.ratchets?.target.any).toBe(2);
  }, TIMEOUT);

  test("positive control: moving escapes between files leaves the total unchanged and passes", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "convex/a.ts", "export const a: any = 1;\n");
    write(root, "convex/b.ts", "export const b: any = 2;\n");
    write(root, "convex/moved/c.ts", "export const m = 1;\n");
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("positive control: removing an escape passes and the notice offers the tighter total", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "convex/a.ts", "export const a: unknown = 1;\nexport const b: any = 2;\n");
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.notices.some((n) => n.startsWith("ratchet can tighten: any 2 -> 1"))).toBe(true);
  }, TIMEOUT);

  test("tests are not measured", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "convex/a.test.ts", "export const t: any = 1;\n");
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("negative control: an exempt or migration file is excused from the size limit only, so its new escape fails", async () => {
    for (const listed of ["convex/data.ts", "convex/migrateOld.ts"]) {
      const root = fixtureRepo(TARGET);
      write(root, listed, "export const d: any = 1;\n");
      const result = await check(root);
      expectFailure(result.errors, /^TYPE-ESCAPE-GROWN any: 3 > target 2 \(\+1\)/);
    }
  }, TIMEOUT);

  test("a deleted file's escapes count against nothing and an added file's against the total", async () => {
    const root = fixtureRepo(TARGET);
    remove(root, "convex/a.ts");
    write(root, "convex/d.ts", "export const d: any = 1;\nexport const e: any = 2;\nexport const f: any = 3;\n");
    const result = await check(root);
    expectFailure(result.errors, /^TYPE-ESCAPE-GROWN any: 3 > target 2 \(\+1\)/);
  }, TIMEOUT);
});

describe("the type-escape allowance cannot be raised from the PR tree", () => {
  test("negative control: a PR-side exemption cannot hide a new escape", async () => {
    const root = fixtureRepo(TARGET);
    const config = baseConfig();
    config.exemptions.push({ path: "convex/b.ts", reason: "attempting to exempt itself from the ratchet" });
    writeConfig(root, config);
    write(root, "convex/b.ts", "export const b: any = 1;\n");
    const result = await check(root);
    expectFailure(result.errors, /^TYPE-ESCAPE-GROWN any: 3 > target 2/);
  }, TIMEOUT);

  test("negative control: a PR-side config that removes the root cannot hide a new escape", async () => {
    const root = fixtureRepo({ ...TARGET, "convex/s.ts": "export const s = 1;\n" });
    writeConfig(root, { ...baseConfig(), productionRoots: ["components/"] });
    write(root, "convex/s.ts", "export const s: any = 1;\n");
    const result = await check(root);
    expectFailure(result.errors, /^TYPE-ESCAPE-GROWN any: 3 > target 2/);
  }, TIMEOUT);

  test("negative control: a stored allowance in the baseline document is rejected, not honoured", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "convex/b.ts", "export const b: any = 1;\n");
    writeBaselineDoc(root, { ...baseBaseline(), typeEscapes: { any: 99 } } as never);
    await expect(check(root)).rejects.toThrow(/unknown key "typeEscapes"/);
  }, TIMEOUT);

  test("negative control: bootstrap compares the PR tree with the target tree measured by the same code", async () => {
    const root = fixtureRepo(TARGET, { withGuardrails: false });
    const target = git(root, "rev-parse", "HEAD");
    writeConfig(root, baseConfig());
    writeBaselineDoc(root, { ...baseBaseline(), sourceCommit: target });
    write(root, "convex/b.ts", "export const b: any = 1;\n");
    const result = await bootstrapCheck(root);
    expect(result.bootstrap).toBe(true);
    expectFailure(result.errors, /^TYPE-ESCAPE-GROWN any: 3 > target 2 \(\+1\)/);
  }, TIMEOUT);

  test("positive control: bootstrap with no new escapes reports no ratchet error", async () => {
    const root = fixtureRepo(TARGET, { withGuardrails: false });
    const target = git(root, "rev-parse", "HEAD");
    writeConfig(root, baseConfig());
    writeBaselineDoc(root, { ...baseBaseline(), sourceCommit: target });
    const result = await bootstrapCheck(root);
    expect(result.errors.filter((e) => e.startsWith("TYPE-ESCAPE-GROWN"))).toEqual([]);
    expect(result.ratchets?.pr.any).toBe(2);
  }, TIMEOUT);
});
