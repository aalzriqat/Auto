// @vitest-environment node
// SCRUM-1011: the real rules behind the `sonar-lint` preflight step. Each `error`-class rule (a Sonar BUG or
// VULNERABILITY) must fire on a minimal bad example and stay silent on the fixed one, using ESLint's Node API
// and the repository's own eslint.preflight.config.mjs. A warn-class rule must be present at severity "warn".
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..");
// An existing TypeScript file inside the root tsconfig: typed rules need a path the project service knows. Its on-disk
// text is replaced by the fixture string, so nothing here depends on what that file contains.
const FIXTURE_PATH = path.join(root, "lib", "colorUtils.ts");

interface Hit { ruleId: string | null; severity: number; line: number }

// Plain JavaScript has no tsconfig of its own; the preflight config types it through tsconfig.preflight.json.
const JS_FIXTURE_PATH = path.join(root, "scripts", "preflight", "apiDtsCheck.mjs");

// typescript-eslint infers a "single run" (programs built once from the files on disk) when CI=true or when the process is the
// eslint bin, and then ignores the text passed to lintText for a file's first parse. These tests lint text that differs from the
// file on disk, so they turn the inference off; the real step lints files on disk, where single-run mode is correct.
// https://typescript-eslint.io/packages/parser/ (disallowAutomaticSingleRunInference)
const NO_SINGLE_RUN = [{ languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } } }];

async function lint(code: string, filePath = FIXTURE_PATH): Promise<Hit[]> {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, "eslint.preflight.config.mjs"), overrideConfig: NO_SINGLE_RUN });
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId?.startsWith("sonarjs/")).map((m) => ({ ruleId: m.ruleId, severity: m.severity, line: m.line }));
}

const ERROR_RULES: Array<{ rule: string; sonar: string; bad: string; fixed: string }> = [
  {
    rule: "sonarjs/no-alphabetical-sort", sonar: "S2871",
    bad: "const xs: number[] = [10, 9, 1];\nexport const sorted = xs.sort();\n",
    fixed: "const xs: number[] = [10, 9, 1];\nexport const sorted = xs.sort((a, b) => a - b);\n",
  },
  {
    rule: "sonarjs/different-types-comparison", sonar: "S3403",
    bad: 'const n: number = Number(process.argv[2]);\nconst s: string = "1";\nexport const same = n === s;\n',
    fixed: 'const n: number = Number(process.argv[2]);\nconst s: string = "1";\nexport const same = String(n) === s;\n',
  },
  {
    rule: "sonarjs/no-os-command-from-path", sonar: "S4036",
    bad: 'import { execFileSync } from "node:child_process";\nexport const out = execFileSync("git", ["status"]);\n',
    fixed: 'import { execFileSync } from "node:child_process";\nexport const out = execFileSync(process.execPath, ["--version"]);\n',
  },
  {
    rule: "sonarjs/slow-regex", sonar: "S5852",
    bad: "export const hit = (s: string) => /(a+)+$/.test(s);\n",
    fixed: "export const hit = (s: string) => /a+$/.test(s);\n",
  },
];

describe("sonar-lint error-class rules fire on a minimal bad example and are silent on the fixed one", () => {
  it.each(ERROR_RULES)("$rule ($sonar)", async ({ rule, bad, fixed }) => {
    const hits = await lint(bad);
    expect(hits.some((h) => h.ruleId === rule && h.severity === 2), JSON.stringify(hits)).toBe(true);
    const clean = await lint(fixed);
    expect(clean.filter((h) => h.ruleId === rule)).toEqual([]);
  }, 120_000);
});

describe("typed error-class rules also work on plain JavaScript (.mjs), where the Sonar S2871 / S3403 findings were", () => {
  it("S2871 no-alphabetical-sort fires on an .mjs file and is silent once a compare function is given", async () => {
    const hits = await lint("export const sorted = [10, 9, 1].sort();\n", JS_FIXTURE_PATH);
    expect(hits.some((h) => h.ruleId === "sonarjs/no-alphabetical-sort" && h.severity === 2), JSON.stringify(hits)).toBe(true);
    const clean = await lint("export const sorted = [10, 9, 1].sort((a, b) => a - b);\n", JS_FIXTURE_PATH);
    expect(clean.filter((h) => h.ruleId === "sonarjs/no-alphabetical-sort")).toEqual([]);
  }, 120_000);

  it("S3403 different-types-comparison fires on an .mjs file (JSDoc types) and is silent on the fixed one", async () => {
    const bad = '/** @param {number} n */\nexport const same = (n) => n === "1";\n';
    const hits = await lint(bad, JS_FIXTURE_PATH);
    expect(hits.some((h) => h.ruleId === "sonarjs/different-types-comparison" && h.severity === 2), JSON.stringify(hits)).toBe(true);
    const fixed = '/** @param {number} n */\nexport const same = (n) => String(n) === "1";\n';
    expect((await lint(fixed, JS_FIXTURE_PATH)).filter((h) => h.ruleId === "sonarjs/different-types-comparison")).toEqual([]);
  }, 120_000);
});

describe("sonar-lint warn-class rules are enabled at warning severity", () => {
  const WARN_RULES = [
    "sonarjs/cognitive-complexity", "sonarjs/no-nested-conditional", "sonarjs/no-nested-template-literals", "sonarjs/prefer-read-only-props",
    "sonarjs/no-unused-vars", "sonarjs/no-dead-store", "sonarjs/no-misleading-array-reverse", "sonarjs/prefer-regexp-exec", "sonarjs/super-linear-regex",
  ];

  it("reports each configured warn rule as severity 1 in the resolved config", async () => {
    const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, "eslint.preflight.config.mjs") });
    const resolved = (await eslint.calculateConfigForFile(FIXTURE_PATH)) as { rules: Record<string, unknown[]> };
    for (const rule of WARN_RULES) expect(resolved.rules[rule]?.[0], rule).toBe(1);
  }, 120_000);

  it("nested ternaries are reported as a warning, not an error", async () => {
    const hits = await lint("export const f = (a: number) => (a > 1 ? 'x' : a > 0 ? 'y' : 'z');\n");
    const h = hits.find((x) => x.ruleId === "sonarjs/no-nested-conditional");
    expect(h?.severity).toBe(1);
  }, 120_000);

  it("does not enable the whole sonarjs recommended set", async () => {
    const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, "eslint.preflight.config.mjs") });
    const resolved = (await eslint.calculateConfigForFile(FIXTURE_PATH)) as { rules: Record<string, unknown[]> };
    const sonar = Object.keys(resolved.rules).filter((r) => r.startsWith("sonarjs/") && resolved.rules[r]?.[0] !== 0 && resolved.rules[r]?.[0] !== "off");
    expect(sonar.length).toBeLessThanOrEqual(13);
  }, 120_000);
});
