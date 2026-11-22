import { describe, expect, test } from "vitest";
import { writeBaseline } from "./check.mjs";
import { countNonBlank, measureLines } from "./rules.mjs";
import { TIMEOUT, check, expectFailure, fixtureRepo, git, registerFixtureCleanup, write } from "./testkit";

registerFixtureCleanup();

describe("line measurement with Prettier", () => {
  test("negative control: a prettier-ignore pragma does not let a crammed file evade the size limit", async () => {
    const root = fixtureRepo();
    const items = Array.from({ length: 700 }, (_, i) => `"item-number-${i}"`).join(", ");
    write(root, "convex/crammed.ts", `// prettier-ignore\nexport const crammed = [${items}];\n`);
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-NEW convex\/crammed\.ts/);
  }, TIMEOUT);

  test("negative control: a JSX prettier-ignore comment does not let a crammed file evade the size limit", async () => {
    const root = fixtureRepo();
    const items = Array.from({ length: 700 }, (_, i) => `"item-number-${i}"`).join(", ");
    write(root, "components/Crammed.tsx", `export const C = () => (\n  <div>\n    {/* prettier-ignore */}\n    <span>{[${items}]}</span>\n  </div>\n);\n`);
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-NEW components\/Crammed\.tsx/);
  }, TIMEOUT);

  test("positive control: the literal text prettier-ignore in ordinary strings does not inflate the count", async () => {
    const root = fixtureRepo();
    const declarations = Array.from({ length: 151 }, (_, i) =>
      `export const x${String(i).padStart(3, "0")} = ["prettier-ignore", "prettier-ignore", "prettier-ignore"];`);
    write(root, "convex/literals.ts", `${declarations.join("\n")}\n`);
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("positive control: across the wrap boundary, ordinary prettier-ignore text is counted exactly as Prettier lays it out", async () => {
    const prettier = await import("prettier");
    // Identifier widths 1..30 carry each declaration across printWidth 80.
    const source = Array.from({ length: 30 }, (_, i) =>
      `export const ${"v".repeat(i + 1)} = ["prettier-ignore", "prettier-ignore", "x"];`).join("\n") + "\n";
    const expected = countNonBlank(await prettier.format(source, { filepath: "a.ts" }));
    expect(await measureLines("a.ts", source, {}, prettier)).toEqual({ lines: expected });
  }, TIMEOUT);

  test("negative control: prettier-ignore as ordinary code is counted as Prettier lays it out, never below", async () => {
    // `prettier-ignore` here is subtraction, which Prettier widens to
    // `prettier - ignore`; turning it into one identifier measured 153, not 757.
    const root = fixtureRepo();
    const declarations = Array.from({ length: 151 }, (_, i) =>
      `export const xxxxxxx${String(i).padStart(3, "0")} = [prettier-ignore, prettier-ignore, prettier-ignore];`);
    write(root, "convex/expressions.ts", `const prettier = 1;\nconst ignore = 1;\n${declarations.join("\n")}\n`);
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-NEW convex\/expressions\.ts: 757 lines/);
  }, TIMEOUT);

  test("negative control: an inline GraphQL ignore comment cannot hide a crammed query", async () => {
    // `query Q { # prettier-ignore` is honoured mid-line; a line-start grammar
    // missed it and measured 601 lines as 7. No grammar is trusted any more.
    const root = fixtureRepo();
    const args = Array.from({ length: 593 }, (_, i) => `a${i}: "v${i}"`).join(", ");
    write(
      root,
      "convex/inlineGql.ts",
      `const gql = (parts: TemplateStringsArray) => parts[0];\nexport const q = gql\`\n  query Q { # prettier-ignore\n    field(${args}) }\n\`;\n`,
    );
    const result = await check(root);
    expectFailure(result.errors, /^SIZE-NEW convex\/inlineGql\.ts/);
  }, TIMEOUT);

  test("negative control: a decoy mention before a real pragma does not shield the pragma", async () => {
    const prettier = await import("prettier");
    const items = Array.from({ length: 60 }, (_, i) => `"item-${i}"`).join(", ");
    const source = `export const note = "prettier-ignore";\n// prettier-ignore\nexport const crammed = [${items}];\n`;
    const unignored = countNonBlank(
      await prettier.format(source.replaceAll("prettier-ignore", "prettier_ignore"), { filepath: "a.ts" }),
    );
    expect(unignored).toBeGreaterThan(countNonBlank(await prettier.format(source, { filepath: "a.ts" })));
    expect(await measureLines("a.ts", source, {}, prettier)).toEqual({ lines: unignored });
  }, TIMEOUT);

  test("negative control: a count Prettier cannot produce fails closed, in either pass", async () => {
    const plainFails = { format: async () => { throw new RangeError("Maximum call stack size exceeded"); } };
    const neutralisedFails = {
      format: async (text: string) => {
        if (text.includes("prettier_ignore")) throw new RangeError("Maximum call stack size exceeded");
        return text;
      },
    };
    const source = "// prettier-ignore\nexport const x = 1;\n";
    await expect(measureLines("lib/a.ts", source, {}, plainFails)).rejects.toThrow(/^COUNT-UNAVAILABLE lib\/a\.ts/);
    await expect(measureLines("lib/a.ts", source, {}, neutralisedFails)).rejects.toThrow(/^COUNT-UNAVAILABLE lib\/a\.ts/);
  }, TIMEOUT);

  test("negative control: a count-unavailable error names the file and position, never its source", async () => {
    const prettier = await import("prettier");
    const source = 'const internalSecret = "SENTINEL_SECRET_426";\nexport const = ;\n';
    const error = await measureLines("convex/broken.ts", source, {}, prettier).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/^COUNT-UNAVAILABLE convex\/broken\.ts: Prettier could not format it \(line 2, column \d+\)$/);
    expect(error?.message).not.toContain("SENTINEL_SECRET_426");
    expect(error?.message).not.toContain("export const");
  }, TIMEOUT);

  test("negative control: malformed or hostile error positions never reach the message", async () => {
    const SECRET = "SENTINEL_SECRET_426";
    const throwing = (value: unknown) => ({ format: async () => { throw value; } });
    const hostileLoc = Object.defineProperty(new Error(SECRET), "loc", {
      get() { throw new Error(SECRET); },
    });
    const cases: unknown[] = [
      Object.assign(new Error(SECRET), { loc: { start: { line: 2, column: SECRET } } }),
      Object.assign(new Error(SECRET), { loc: { start: { line: SECRET, column: 3 } } }),
      hostileLoc,
      SECRET,
    ];
    for (const thrown of cases) {
      const message = await measureLines("convex/broken.ts", "x\n", {}, throwing(thrown)).then(
        () => "resolved",
        (e: Error) => e.message,
      );
      expect(message).toBe("COUNT-UNAVAILABLE convex/broken.ts: Prettier could not format it");
    }
    const numeric = Object.assign(new Error(SECRET), { loc: { start: { line: 2, column: 14 } } });
    await expect(measureLines("convex/broken.ts", "x\n", {}, throwing(numeric))).rejects.toThrow(
      /^COUNT-UNAVAILABLE convex\/broken\.ts: Prettier could not format it \(line 2, column 14\)$/,
    );
  }, TIMEOUT);

  test("negative control: an unformattable file blocks the check and the baseline writer, never a notice", async () => {
    const root = fixtureRepo();
    write(root, "convex/broken.ts", "export const = ;\n");
    await expect(check(root)).rejects.toThrow(/COUNT-UNAVAILABLE convex\/broken\.ts/);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "broken");
    await expect(writeBaseline(root, git(root, "rev-parse", "HEAD"), "main")).rejects.toThrow(
      /COUNT-UNAVAILABLE convex\/broken\.ts/,
    );
  }, TIMEOUT);

  test("the pragma grammar: every form Prettier honours is neutralised; forms it ignores change nothing", async () => {
    const prettier = await import("prettier");
    const items = Array.from({ length: 60 }, (_, i) => `"item-${i}"`).join(", ");
    const code = `export const crammed = [${items}];`;
    const jsx = (pragma: string) => `export const C = () => (\n  <div>\n    ${pragma}\n    <span>{[${items}]}</span>\n  </div>\n);\n`;
    // Each form below was observed to be honoured by Prettier 3.8.4.
    const honoured: Array<[string, string]> = [
      ["a.ts", `// prettier-ignore\n${code}\n`],
      ["a.ts", `//prettier-ignore\n${code}\n`],
      ["a.ts", `/* prettier-ignore */\n${code}\n`],
      ["a.ts", `/*prettier-ignore*/\n${code}\n`],
      ["a.ts", `/*\n prettier-ignore\n*/\n${code}\n`],
      ["a.tsx", jsx("{/* prettier-ignore */}")],
      ["a.tsx", jsx("{\n      // prettier-ignore\n    }")],
      ["a.ts", "export const q = gql`\n  # prettier-ignore\n  query Q { a { b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee ff } }\n`;\n"],
      ["a.ts", "export const h = html`\n  <!-- prettier-ignore -->\n  <div><span>a</span><span>b</span><span>c</span><span>d</span><span>e</span><span>f</span><span>g</span></div>\n`;\n"],
    ];
    for (const [file, source] of honoured) {
      const plain = countNonBlank(await prettier.format(source, { filepath: file }));
      const unignored = countNonBlank(
        await prettier.format(source.replaceAll("prettier-ignore", "prettier_ignore"), { filepath: file }),
      );
      expect(unignored, source).toBeGreaterThan(plain);
      expect(await measureLines(file, source, {}, prettier), source).toEqual({ lines: unignored });
    }
    const ignored = [
      `// prettier-ignore because\n${code}\n`,
      `/** prettier-ignore */\n${code}\n`,
      `export const a = 1; // prettier-ignore\n${code}\n`,
      `export const s = "// prettier-ignore";\n${code}\n`,
    ];
    for (const source of ignored) {
      const plain = countNonBlank(await prettier.format(source, { filepath: "a.ts" }));
      expect(await measureLines("a.ts", source, {}, prettier), source).toEqual({ lines: plain });
    }
  }, TIMEOUT);
});
