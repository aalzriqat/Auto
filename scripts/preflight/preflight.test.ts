// @vitest-environment node
// SCRUM-1007: the local pre-push preflight. These tests pin the four failure modes the command exists to
// catch before CI does (an api.d.ts entry out of order, a missing entry, a stale baseline entry, and a check
// that cannot run being reported as FAIL rather than skipped), plus the applicability and exit-code rules.
// Every fixture lives in a temp directory; nothing here touches the real convex/_generated/api.d.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkApiDts, expectedApiModules } from "./apiDtsCheck.mjs";
import { classifyChanges, exitCodeOf, runPreflight } from "./preflight.mjs";

interface CheckResult {
  id: string;
  title: string;
  status: "PASS" | "FAIL" | "NOT APPLICABLE";
  detail: string;
  fix: string[];
}
interface RunCall { id: string; command: string; args: string[] }
interface RunOutcome { status: number | null; stdout?: string; stderr?: string; error?: Error }
interface ApiCheck { ok: boolean; problems: Array<{ kind: string; block: string; module: string; message: string; fix: string }> }

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A throwaway repo root with convex/<module>.ts files and a generated api.d.ts in the given orders. */
function fixture(opts: { files: string[]; importOrder: string[]; fullApiOrder?: string[] }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  roots.push(root);
  const convex = path.join(root, "convex");
  fs.mkdirSync(path.join(convex, "_generated"), { recursive: true });
  for (const f of opts.files) {
    fs.mkdirSync(path.dirname(path.join(convex, f)), { recursive: true });
    fs.writeFileSync(path.join(convex, f), "export const x = 1;\n");
  }
  const id = (m: string) => m.replace(/[/-]/g, "_");
  const imports = opts.importOrder.map((m) => `import type * as ${id(m)} from "../${m}.js";`).join("\n");
  const entries = (opts.fullApiOrder ?? opts.importOrder).map((m) => `  "${m}": typeof ${id(m)};`).join("\n");
  fs.writeFileSync(
    path.join(convex, "_generated", "api.d.ts"),
    `/* eslint-disable */\n${imports}\n\ndeclare const fullApi: ApiFromModules<{\n${entries}\n}>;\n\nexport declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;\n`,
  );
  return root;
}

const FILES = ["accounting/postingRules.ts", "accountingLedger.ts", "deals.ts", "deals-extra.ts"];
// The order the Convex generator emits: a plain code-unit sort of the relative path WITH its extension.
const SORTED = ["accounting/postingRules", "accountingLedger", "deals-extra", "deals"];

describe("api.d.ts check", () => {
  it("passes when both blocks hold exactly the registerable modules in generator order", () => {
    const root = fixture({ files: FILES, importOrder: SORTED });
    const r = checkApiDts({ root }) as ApiCheck;
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("derives the registered set with the generator's own filters (tests, d.ts, schema, dotfiles, _generated, non-modules)", () => {
    const root = fixture({ files: [...FILES, "deals.test.ts", "types.d.ts", "schema.ts", ".hidden.ts", "notes.md", "empty.ts"], importOrder: SORTED });
    fs.writeFileSync(path.join(root, "convex", "empty.ts"), "// no import or export, so Convex skips it\n");
    expect(expectedApiModules(path.join(root, "convex"))).toEqual(SORTED);
  });

  it("(i) FAILS an import-block entry out of order and names the line to move", () => {
    const root = fixture({ files: FILES, importOrder: ["accounting/postingRules", "accountingLedger", "deals", "deals-extra"], fullApiOrder: SORTED });
    const r = checkApiDts({ root }) as ApiCheck;
    expect(r.ok).toBe(false);
    const order = r.problems.filter((p) => p.kind === "order");
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((p) => p.block === "import")).toBe(true);
    expect(order[0].message).toMatch(/deals/);
    expect(order[0].fix).toMatch(/deals-extra/);
  });

  it("(i) FAILS a fullApi-block entry out of order even when the import block is right", () => {
    const root = fixture({ files: FILES, importOrder: SORTED, fullApiOrder: ["accounting/postingRules", "deals-extra", "accountingLedger", "deals"] });
    const r = checkApiDts({ root }) as ApiCheck;
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.kind === "order" && p.block === "fullApi")).toBe(true);
    expect(r.problems.some((p) => p.block === "import")).toBe(false);
  });

  it("(ii) FAILS a module that exists on disk but is missing from the generated file, in either block", () => {
    const root = fixture({ files: FILES, importOrder: ["accounting/postingRules", "accountingLedger", "deals-extra"] });
    const r = checkApiDts({ root }) as ApiCheck;
    expect(r.ok).toBe(false);
    const missing = r.problems.filter((p) => p.kind === "missing");
    expect(missing.map((p) => p.block).sort()).toEqual(["fullApi", "import"]);
    expect(missing.every((p) => p.module === "deals")).toBe(true);
    expect(missing[0].fix).toMatch(/after .*deals-extra/);
  });

  it("(ii) FAILS an entry whose file no longer exists", () => {
    const root = fixture({ files: FILES.slice(0, 3), importOrder: SORTED });
    const r = checkApiDts({ root }) as ApiCheck;
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.kind === "extra" && p.module === "deals-extra")).toBe(true);
  });

  it("(iv) throws, rather than passing, when the generated file cannot be read", () => {
    const root = fixture({ files: FILES, importOrder: SORTED });
    fs.rmSync(path.join(root, "convex", "_generated", "api.d.ts"));
    expect(() => checkApiDts({ root })).toThrow(/api\.d\.ts/);
  });

  it("(iv) throws when the generated file has no recognisable fullApi block", () => {
    const root = fixture({ files: FILES, importOrder: SORTED });
    fs.writeFileSync(path.join(root, "convex", "_generated", "api.d.ts"), "// emptied\n");
    expect(() => checkApiDts({ root })).toThrow(/fullApi|import/);
  });
});

const NUL = "\0";
const status = (entries: Array<[string, string]>) => entries.map(([s, p]) => `${s}${NUL}${p}${NUL}`).join("");
const ok = (stdout = ""): RunOutcome => ({ status: 0, stdout, stderr: "" });
interface ApiStub { ok: boolean; problems: Array<{ message: string; fix: string }>; expectedCount?: number }
const okApi = (): ApiStub => ({ ok: true, problems: [], expectedCount: 1 });

const PIN_SOURCE = `const EXECUTION_INPUTS = [\n  {\n    "file": "package.json",\n    "hash": "aa"\n  },\n  {\n    "file": "tsconfig.json",\n    "hash": "bb"\n  }\n];\n\nfunction other() {}\n`;

interface Harness { calls: RunCall[]; results: CheckResult[]; code: number; out: string }
async function run(opts: {
  changed: Array<[string, string]>;
  untracked?: string[];
  outcomes?: Record<string, RunOutcome | (() => RunOutcome)>;
  existing?: (p: string) => boolean;
  api?: () => ApiStub;
  readText?: (p: string) => string;
  porcelain?: string;
  tests?: boolean;
}): Promise<Harness> {
  const calls: RunCall[] = [];
  const lines: string[] = [];
  const result = await runPreflight({
    root: "/repo",
    options: { tests: Boolean(opts.tests) },
    log: (l: string) => lines.push(l),
    deps: {
      git: (args: string[]) => {
        if (args[0] === "merge-base") return "0123456789abcdef0123456789abcdef01234567\n";
        if (args[0] === "diff") return status(opts.changed);
        if (args[0] === "ls-files") return (opts.untracked ?? []).map((p) => p + NUL).join("");
        if (args[0] === "rev-list") return "0\n";
        if (args[0] === "status") return opts.porcelain ?? "";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      run: (c: RunCall): RunOutcome => {
        calls.push(c);
        const o = opts.outcomes?.[c.id];
        return typeof o === "function" ? o() : (o ?? ok());
      },
      exists: opts.existing ?? (() => true),
      readText: opts.readText ?? (() => PIN_SOURCE),
      checkApiDts: opts.api ?? okApi,
      now: (() => { let t = 0; return () => (t += 5); })(),
    },
  });
  return { calls, results: result.results as CheckResult[], code: exitCodeOf(result.results), out: lines.join("\n") };
}
const byId = (h: Harness, id: string): CheckResult => {
  const r = h.results.find((x) => x.id === id);
  if (!r) throw new Error(`no result for ${id}: ${h.results.map((x) => x.id).join(",")}`);
  return r;
};

describe("change classification", () => {
  it("splits convex-side from app-side TypeScript and lintable files, ignoring deleted files for lint", () => {
    const c = classifyChanges([
      { status: "M", path: "convex/deals.ts" },
      { status: "A", path: "test-utils/harness.ts" },
      { status: "M", path: "lib/money.ts" },
      { status: "D", path: "lib/old.ts" },
      { status: "M", path: "apps/mobile/x.ts" },
      { status: "M", path: "docs/readme.md" },
    ]);
    expect(c.convexSide).toBe(true);
    expect(c.rootSide).toBe(true);
    expect(c.lintable).toEqual(["convex/deals.ts", "test-utils/harness.ts", "lib/money.ts"]);
    expect(c.testFiles).toEqual([]);
  });

  it("selects changed *.test.ts files that still exist as the --tests set", () => {
    const c = classifyChanges([
      { status: "M", path: "convex/deals.test.ts" },
      { status: "D", path: "convex/gone.test.ts" },
      { status: "A", path: "scripts/x.test.mjs" },
    ]);
    expect(c.testFiles).toEqual(["convex/deals.test.ts"]);
  });
});

describe("runPreflight", () => {
  it("runs every applicable check, cheapest first, and passes with exit code 0", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]] });
    expect(h.code).toBe(0);
    expect(h.results.map((r) => r.id)).toEqual(["api-dts", "guardrails", "baseline-evidence", "eslint", "execution-pins", "typecheck", "tests"]);
    expect(byId(h, "api-dts").status).toBe("PASS");
    expect(byId(h, "typecheck").detail).toMatch(/typecheck:convex/);
    expect(byId(h, "tests").status).toBe("NOT APPLICABLE");
    expect(byId(h, "tests").detail).toMatch(/--tests/);
  });

  it("invokes the baseline evidence check with the merge-base as --pr-base and the CI reviewed revision", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]] });
    const call = h.calls.find((c) => c.id === "baseline-evidence");
    expect(call?.args).toEqual(expect.arrayContaining(["--reviewed", "c82890bd", "--check-evidence", "--pr-base", "0123456789abcdef0123456789abcdef01234567"]));
  });

  it("(iii) FAILS on a stale baseline entry, with the script's own output and a concrete fix", async () => {
    const h = await run({
      changed: [["M", "convex/deals.ts"]],
      outcomes: { "baseline-evidence": { status: 10, stdout: "renewal evidence: 3 renewed entries checked, 0 unrenewed, 1 stale, 0 malformed, 0 missing\nSTALE entry #2 deals.update: unnamed convex/deals.ts; changed after review ; unresolved \n" } },
    });
    const r = byId(h, "baseline-evidence");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/STALE entry #2/);
    expect(r.fix.join("\n")).toMatch(/renewBaselineReviewed\.mjs/);
    expect(r.fix.join("\n")).toMatch(/--blob-evidence/);
    expect(h.code).not.toBe(0);
  });

  it("keeps going after a failure so every problem is listed in one run", async () => {
    const h = await run({
      changed: [["M", "convex/deals.ts"]],
      outcomes: { guardrails: { status: 1, stdout: "FAIL file too large" }, eslint: { status: 1, stdout: "1 error" } },
    });
    expect(h.results).toHaveLength(7);
    expect(h.results.filter((r) => r.status === "FAIL").map((r) => r.id)).toEqual(["guardrails", "eslint"]);
    expect(h.calls.map((c) => c.id)).toEqual(expect.arrayContaining(["baseline-evidence", "typecheck-convex"]));
    expect(h.code).toBe(1);
  });

  it("(iv) reports a check whose tool is missing as FAIL, never as skipped", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], existing: (p) => !/eslint/.test(p) });
    const r = byId(h, "eslint");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/cannot run/i);
    expect(h.calls.some((c) => c.id === "eslint")).toBe(false);
    expect(h.code).not.toBe(0);
  });

  it("(iv) reports a spawn error as FAIL", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], outcomes: { guardrails: { status: null, error: new Error("spawn ENOENT") } } });
    expect(byId(h, "guardrails").status).toBe("FAIL");
    expect(byId(h, "guardrails").detail).toMatch(/cannot run.*ENOENT/is);
  });

  it("(iv) reports a check script that throws (exit 2, no PASS marker) as FAIL", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], outcomes: { "baseline-evidence": { status: 2, stderr: "Error: reviewed revision c82890bd is unavailable; fetch full Git history" } } });
    const r = byId(h, "baseline-evidence");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/unavailable/);
  });

  it("(iv) reports an api.d.ts check that throws as FAIL", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], api: () => { throw new Error("cannot read convex/_generated/api.d.ts"); } });
    expect(byId(h, "api-dts").status).toBe("FAIL");
    expect(byId(h, "api-dts").detail).toMatch(/cannot run/i);
  });

  it("surfaces api.d.ts problems with their per-problem fix", async () => {
    const h = await run({
      changed: [["A", "convex/zeta.ts"]],
      api: () => ({ ok: false, expectedCount: 2, problems: [{ message: "zeta is missing", fix: 'add `import type * as zeta from "../zeta.js";` after alpha' }] }),
    });
    const r = byId(h, "api-dts");
    expect(r.status).toBe("FAIL");
    expect(r.fix.join("\n")).toMatch(/after alpha/);
  });

  it("runs only the root typecheck, and says so, when no convex or test-utils file changed", async () => {
    const h = await run({ changed: [["M", "lib/money.ts"]] });
    const r = byId(h, "typecheck");
    expect(r.status).toBe("PASS");
    expect(r.detail).toMatch(/root/);
    expect(h.calls.some((c) => c.id === "typecheck-convex")).toBe(false);
    expect(h.calls.some((c) => c.id === "typecheck-root")).toBe(true);
  });

  it("runs both typechecks when both sides changed, and neither for a docs-only change", async () => {
    const both = await run({ changed: [["M", "convex/deals.ts"], ["M", "lib/money.ts"]] });
    expect(both.calls.filter((c) => c.id.startsWith("typecheck")).map((c) => c.id)).toEqual(["typecheck-convex", "typecheck-root"]);
    const docs = await run({ changed: [["M", "docs/readme.md"]] });
    expect(byId(docs, "typecheck").status).toBe("NOT APPLICABLE");
    expect(byId(docs, "eslint").status).toBe("NOT APPLICABLE");
    expect(docs.calls.some((c) => c.id.startsWith("typecheck") || c.id === "eslint")).toBe(false);
  });

  it("lints only changed lintable files, including untracked ones", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"], ["D", "convex/old.ts"], ["M", "README.md"]], untracked: ["lib/new.ts"] });
    const call = h.calls.find((c) => c.id === "eslint");
    expect(call?.args.slice(-2)).toEqual(["convex/deals.ts", "lib/new.ts"]);
  });

  it("--tests runs vitest on changed test files with --maxWorkers=1", async () => {
    const h = await run({ changed: [["M", "convex/deals.test.ts"]], tests: true });
    const call = h.calls.find((c) => c.id === "tests");
    expect(call?.args).toEqual(expect.arrayContaining(["run", "--maxWorkers=1", "convex/deals.test.ts"]));
    expect(byId(h, "tests").status).toBe("PASS");
  });

  it("--tests with no changed test file is NOT APPLICABLE with the reason", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], tests: true });
    expect(byId(h, "tests").status).toBe("NOT APPLICABLE");
    expect(byId(h, "tests").detail).toMatch(/no changed/i);
  });

  it("prints one line per check, the total time, and the fix for each FAIL", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], outcomes: { guardrails: { status: 1, stdout: "boom" } } });
    expect(h.out).toMatch(/PASS\s+api-dts/);
    expect(h.out).toMatch(/FAIL\s+guardrails/);
    expect(h.out).toMatch(/NOT APPLICABLE\s+tests/);
    expect(h.out).toMatch(/total/i);
    expect(h.out).toMatch(/node quality\/guardrails\/check\.mjs --base origin\/main/);
  });
});

describe("execution-input pins (supplier navigation closure census)", () => {
  const SUITE = "scripts/intelligence/supplierNavigationDoors.test.ts";

  it("runs the census suite when a pinned execution input such as package.json changed", async () => {
    const h = await run({ changed: [["M", "package.json"]] });
    const call = h.calls.find((c) => c.id === "execution-pins");
    expect(call?.args).toEqual(expect.arrayContaining(["run", "--maxWorkers=1", SUITE]));
    expect(byId(h, "execution-pins").status).toBe("PASS");
  });

  it("FAILS with the pin-renewal fix when the census suite fails", async () => {
    const h = await run({ changed: [["M", "package.json"]], outcomes: { "execution-pins": { status: 1, stdout: "Error: package.json: EXECUTABLE_CLOSURE execution input changed" } } });
    const r = byId(h, "execution-pins");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/execution input changed/);
    expect(r.fix.join("\n")).toMatch(/sourceClosureCases\.ts/);
    expect(r.fix.join("\n")).toMatch(/closurePins\.ts/);
    expect(h.code).not.toBe(0);
  });

  it("is NOT APPLICABLE, with the reason, when no pinned input or census file changed", async () => {
    const h = await run({ changed: [["M", "lib/money.ts"]] });
    expect(byId(h, "execution-pins").status).toBe("NOT APPLICABLE");
    expect(byId(h, "execution-pins").detail).toMatch(/no pinned/i);
    expect(h.calls.some((c) => c.id === "execution-pins")).toBe(false);
  });

  it("also runs when the census files themselves change", async () => {
    const h = await run({ changed: [["M", "test-utils/supplierNavigationAudit/closurePins.ts"]] });
    expect(h.calls.some((c) => c.id === "execution-pins")).toBe(true);
  });

  it("FAILS, never skips, when the pinned-file list cannot be read", async () => {
    const h = await run({ changed: [["M", "package.json"]], readText: () => { throw new Error("ENOENT sourceClosureCases.ts"); } });
    expect(byId(h, "execution-pins").status).toBe("FAIL");
    expect(byId(h, "execution-pins").detail).toMatch(/cannot run/i);
  });
});

describe("review batch 1: typecheck selection mirrors what the root program really checks", () => {
  // tsconfig `exclude` only removes root files; imports still pull convex/, test-utils/ and packages/ into the program,
  // and CI runs `pnpm typecheck` unconditionally. So any TypeScript-relevant change selects the root typecheck.
  const selected = (p: string) => classifyChanges([{ status: "M", path: p }]) as { rootSide: boolean; convexSide: boolean; contractSkewSide: boolean };

  it.each([
    "convex/utils/permissions.ts",
    "test-utils/harness.ts",
    "packages/shared/src/x.ts",
    "apps/mobile/screen.tsx",
    "package.json",
    "pnpm-lock.yaml",
    "next.config.mjs",
    "postcss.config.js",
    "types/global.d.ts",
    "tsconfig.json",
    "convex/tsconfig.json",
  ])("%s selects the root typecheck", (p) => {
    expect(selected(p).rootSide).toBe(true);
  });

  it("does not select it for files TypeScript never reads", () => {
    expect(selected("docs/readme.md").rootSide).toBe(false);
    expect(selected("public/logo.png").rootSide).toBe(false);
    expect(selected("node_modules/x/index.ts").rootSide).toBe(false);
  });

  it("keeps typecheck:convex for convex/ and test-utils/ changes only", () => {
    expect(selected("convex/utils/permissions.ts").convexSide).toBe(true);
    expect(selected("packages/shared/src/x.ts").convexSide).toBe(false);
  });

  it("selects the contract-skew typecheck when the root tsconfig or package.json changes (its tsconfig extends the root)", () => {
    expect(selected("tsconfig.json").contractSkewSide).toBe(true);
    expect(selected("package.json").contractSkewSide).toBe(true);
    expect(selected("lib/money.ts").contractSkewSide).toBe(false);
  });

  it("a convex-only change runs both typechecks", async () => {
    const h = await run({ changed: [["M", "convex/utils/permissions.ts"]] });
    expect(h.calls.filter((c) => c.id.startsWith("typecheck")).map((c) => c.id)).toEqual(["typecheck-convex", "typecheck-root"]);
  });
});

describe("review batch 1: api.d.ts registers .jsx and matches extensions case-sensitively, like the generator", () => {
  it("FAILS a convex/foo.jsx that is missing from api.d.ts", () => {
    const root = fixture({ files: [...FILES, "foo.jsx"], importOrder: SORTED });
    fs.writeFileSync(path.join(root, "convex", "foo.jsx"), "export const x = 1;\n");
    const r = checkApiDts({ root }) as ApiCheck;
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.kind === "missing" && p.module === "foo")).toBe(true);
  });

  it("does not register an upper-case extension (the generator's endsWith is case-sensitive)", () => {
    const root = fixture({ files: [...FILES, "Legacy.TS"], importOrder: SORTED });
    expect(expectedApiModules(path.join(root, "convex"))).toEqual(SORTED);
  });
});

describe("review batch 1: CLI details and fail-closed parsing", () => {
  it("passes `--` before the eslint file list, and not to vitest (cac would drop the filters and run the whole suite)", async () => {
    const h = await run({ changed: [["M", "convex/a.ts"], ["M", "convex/a.test.ts"]], tests: true });
    const lint = h.calls.find((c) => c.id === "eslint");
    const vt = h.calls.find((c) => c.id === "tests");
    expect(lint?.args.slice(-3)).toEqual(["--", "convex/a.ts", "convex/a.test.ts"]);
    expect(vt?.args).not.toContain("--");
    expect(vt?.args.slice(-1)).toEqual(["convex/a.test.ts"]);
  });

  it("reads the EXECUTION_INPUTS table from a CRLF checkout", async () => {
    const h = await run({ changed: [["M", "package.json"]], readText: () => PIN_SOURCE.replaceAll("\n", "\r\n") });
    expect(byId(h, "execution-pins").status).toBe("PASS");
  });

  it("FAILS closed when the EXECUTION_INPUTS block end cannot be found", async () => {
    const h = await run({ changed: [["M", "lib/money.ts"]], readText: () => 'const EXECUTION_INPUTS = [ { "file": "package.json" }' });
    expect(byId(h, "execution-pins").status).toBe("FAIL");
    expect(byId(h, "execution-pins").detail).toMatch(/cannot run.*EXECUTION_INPUTS/is);
  });

  it("warns when the working tree has changes other than the hook files", async () => {
    const h = await run({ changed: [["M", "lib/money.ts"]], porcelain: " M .gitignore\n?? .ignore\n M lib/money.ts\n" });
    expect(h.out).toMatch(/uncommitted/i);
    const quiet = await run({ changed: [["M", "lib/money.ts"]], porcelain: " M .gitignore\n?? .ignore\n" });
    expect(quiet.out).not.toMatch(/uncommitted/i);
  });
});
describe("against the real repository", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");

  it("the emulation reproduces the committed convex/_generated/api.d.ts exactly (guards the emulation against drift)", () => {
    const r = checkApiDts({ root: repoRoot }) as ApiCheck;
    expect(r.problems).toEqual([]);
  });

  it("catches two adjacent real entries swapped in a copy of the committed file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-real-"));
    roots.push(root);
    const lines = fs.readFileSync(path.join(repoRoot, "convex", "_generated", "api.d.ts"), "utf8").split("\n");
    const first = lines.findIndex((l) => l.startsWith("import type * as "));
    [lines[first], lines[first + 1]] = [lines[first + 1], lines[first]];
    fs.mkdirSync(path.join(root, "convex", "_generated"), { recursive: true });
    fs.writeFileSync(path.join(root, "convex", "_generated", "api.d.ts"), lines.join("\n"));
    // One empty module per real registered module, so the on-disk side matches the real repository.
    for (const m of expectedApiModules(path.join(repoRoot, "convex")) as string[]) {
      fs.mkdirSync(path.dirname(path.join(root, "convex", `${m}.ts`)), { recursive: true });
      fs.writeFileSync(path.join(root, "convex", `${m}.ts`), "export {};\n");
    }
    const r = checkApiDts({ root }) as ApiCheck;
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.kind === "order" && p.block === "import")).toBe(true);
  });
});