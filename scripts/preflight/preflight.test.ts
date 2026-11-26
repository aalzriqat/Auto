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
import { classifyChanges, exitCodeOf, main, makeGit, makeRun, runPreflight } from "./preflight.mjs";

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

/** The only .gitignore edit the agent hook makes in this worktree, as `git diff -- .gitignore` prints it. */
const HOOK_GITIGNORE_DIFF = "diff --git a/.gitignore b/.gitignore\n--- a/.gitignore\n+++ b/.gitignore\n@@ -115,3 +115,6 @@\n \n+\n+# graft's local graph cache — regenerable, not committed (run `graft build`).\n+/graft/\n";

/** The inventory test files that exist in the real repository, as directory listings. */
const defaultReadDir = (dir: string): string[] => {
  const d = dir.replaceAll("\\", "/");
  if (d.endsWith("/scripts/regression")) return ["pilotDoorInventory.test.ts", "other.test.ts"];
  if (d.endsWith("/scripts")) return ["tenantWriteGuard.test.ts", "tenantWriteGuardDelegation.test.ts", "economicCommandCensus.test.ts", "economicCommandCensusDomainIndex.test.ts", "unrelated.test.ts"];
  throw new Error(`unexpected readDir ${dir}`);
};

interface Harness { calls: RunCall[]; results: CheckResult[]; code: number; out: string }
async function run(opts: {
  changed: Array<[string, string]>;
  untracked?: string[];
  outcomes?: Record<string, RunOutcome | (() => RunOutcome)>;
  existing?: (p: string) => boolean;
  api?: () => ApiStub;
  readText?: (p: string) => string;
  readDir?: (p: string) => string[];
  porcelain?: string;
  gitignoreDiff?: string;
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
        if (args[0] === "diff" && args.includes(".gitignore")) return opts.gitignoreDiff ?? "";
        if (args[0] === "diff") return status(opts.changed);
        if (args[0] === "ls-files") return (opts.untracked ?? []).map((p) => p + NUL).join("");
        if (args[0] === "rev-list") return "0\n";
        if (args[0] === "status") return opts.porcelain ?? "";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      run: (c: RunCall): RunOutcome => {
        calls.push(c);
        const o = opts.outcomes?.[c.id];
        const fallback = c.id === "sonar-lint" ? ok("[]") : ok();
        return typeof o === "function" ? o() : (o ?? fallback);
      },
      exists: opts.existing ?? (() => true),
      readText: opts.readText ?? (() => PIN_SOURCE),
      readDir: opts.readDir ?? defaultReadDir,
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
    expect(c.docsOnly).toBe(false);
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
    expect(h.results.map((r) => r.id)).toEqual(["api-dts", "guardrails", "baseline-evidence", "eslint", "sonar-lint", "execution-pins", "inventories", "typecheck", "tests"]);
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
    expect(h.results).toHaveLength(9);
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

  it("lints only changed lintable files, including untracked ones", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"], ["D", "convex/old.ts"], ["M", "README.md"]], untracked: ["lib/new.ts"] });
    const call = h.calls.find((c) => c.id === "eslint");
    expect(call?.args.slice(-2)).toEqual(["convex/deals.ts", "lib/new.ts"]);
  });

  it("--tests runs vitest on changed test files with --maxWorkers=1", async () => {
    const h = await run({ changed: [["M", "convex/deals.test.ts"]], tests: true });
    const call = h.calls.find((c) => c.id === "tests");
    expect(call?.args).toEqual(expect.arrayContaining(["run", "--maxWorkers=1", "./convex/deals.test.ts"]));
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
    expect(vt?.args.slice(-1)).toEqual(["./convex/a.test.ts"]);
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
    const quiet = await run({ changed: [["M", "lib/money.ts"]], porcelain: " M .gitignore\n?? .ignore\n", gitignoreDiff: HOOK_GITIGNORE_DIFF });
    expect(quiet.out).not.toMatch(/uncommitted/i);
  });
});

describe("round 2: typecheck is not selected by path; it always runs all three, except for a docs-only diff", () => {
  const ALL = ["typecheck-convex", "typecheck-root", "typecheck-contract-skew"];
  it.each([
    ["M", "regression/scenarios/screen/x.scenario.json"],
    ["D", "regression/scenarios/screen/x.scenario.json"],
    ["M", "scripts/contractSkew/__fixtures__/x.json"],
    ["M", "pnpm-workspace.yaml"],
    ["M", "patches/x.patch"],
    ["M", "assets/data.weirdext"],
    ["A", "Makefile"],
  ])("a diff of only %s %s runs all three typechecks", async (s, p) => {
    const h = await run({ changed: [[s, p]] });
    expect(h.calls.filter((c) => c.id.startsWith("typecheck")).map((c) => c.id)).toEqual(ALL);
    expect(byId(h, "typecheck").status).toBe("PASS");
    expect(byId(h, "typecheck").detail).toMatch(/typecheck:convex.*typecheck \(root\).*typecheck:contract-skew/s);
  });

  it("a docs-only diff also has nothing to lint", async () => {
    const h = await run({ changed: [["M", "README.md"]] });
    expect(byId(h, "eslint").status).toBe("NOT APPLICABLE");
  });

  it("a docs-only diff (*.md anywhere, or anything under docs/) is the one NOT APPLICABLE case, with the reason", async () => {
    const h = await run({ changed: [["M", "README.md"], ["A", "docs/adr/x.png"], ["M", "docs/y.txt"]] });
    expect(byId(h, "typecheck").status).toBe("NOT APPLICABLE");
    expect(byId(h, "typecheck").detail).toMatch(/docs-only/i);
    expect(h.calls.some((c) => c.id.startsWith("typecheck"))).toBe(false);
  });

  it("one non-doc file among docs brings all three back", async () => {
    const h = await run({ changed: [["M", "README.md"], ["M", "regression/a.json"]] });
    expect(h.calls.filter((c) => c.id.startsWith("typecheck"))).toHaveLength(3);
  });

  it("an untracked non-doc file counts too", async () => {
    const h = await run({ changed: [["M", "README.md"]], untracked: ["data/new.json"] });
    expect(h.calls.filter((c) => c.id.startsWith("typecheck"))).toHaveLength(3);
  });

  it("FAILS when any one of the three fails, naming it, and still runs the others", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "typecheck-root": { status: 2, stdout: "error TS2322" } } });
    expect(byId(h, "typecheck").status).toBe("FAIL");
    expect(h.calls.filter((c) => c.id.startsWith("typecheck"))).toHaveLength(3);
  });
});

describe("round 2: pin-table parsing and dirty-tree warning", () => {
  it("reads an unquoted `file:` key", async () => {
    const src = 'const EXECUTION_INPUTS = [\n  { file: "package.json", hash: "aa" },\n];\n';
    const h = await run({ changed: [["M", "package.json"]], readText: () => src });
    expect(h.calls.some((c) => c.id === "execution-pins")).toBe(true);
  });

  it("FAILS closed when a table entry has no parsable file", async () => {
    const src = 'const EXECUTION_INPUTS = [\n  { "file": "package.json", "hash": "aa" },\n  { "hash": "bb" },\n];\n';
    const h = await run({ changed: [["M", "lib/a.ts"]], readText: () => src });
    expect(byId(h, "execution-pins").status).toBe("FAIL");
    expect(byId(h, "execution-pins").detail).toMatch(/cannot run/i);
  });

  it("warns on a real .gitignore edit, ignoring only the exact known hook state", async () => {
    const real = await run({ changed: [["M", "lib/a.ts"]], porcelain: " M .gitignore\n", gitignoreDiff: "+node_modules/\n+secret-thing\n" });
    expect(real.out).toMatch(/uncommitted/i);
    const hook = await run({ changed: [["M", "lib/a.ts"]], porcelain: " M .gitignore\n?? .ignore\n", gitignoreDiff: HOOK_GITIGNORE_DIFF });
    expect(hook.out).not.toMatch(/uncommitted/i);
  });
});

describe("round 3: Sonar new-code fixes (argument injection, PATH lookups, docs-only, vitest paths)", () => {
  interface Spy { runs: unknown[]; gits: unknown[]; deps: Record<string, unknown> }
  const spy = (): Spy => {
    const s: Spy = { runs: [], gits: [], deps: {} };
    s.deps = {
      git: (a: string[]) => { s.gits.push(a); return ""; },
      run: (c: unknown) => { s.runs.push(c); return { status: 0, stdout: "" }; },
      exists: () => true, readText: () => PIN_SOURCE, readDir: defaultReadDir, checkApiDts: okApi, now: () => 0,
    };
    return s;
  };
  const quiet = (fn: () => Promise<number>) => {
    const log = console.log, err = console.error;
    console.log = () => undefined; console.error = () => undefined;
    return fn().finally(() => { console.log = log; console.error = err; });
  };

  it.each(["--base=--write-baseline", "--base=-x", "--base=--upload-pack=calc", "--base=a b", "--base=a..b", "--base="])("rejects %s before any git or child process runs", async (arg) => {
    const s = spy();
    const code = (await quiet(() => main([arg], "/repo", s.deps as never))) as number;
    expect(code).not.toBe(0);
    expect(s.runs).toEqual([]);
    expect(s.gits).toEqual([]);
  });

  it("still accepts an ordinary ref such as origin/main or a sha", async () => {
    const s = spy();
    s.deps.git = (a: string[]) => { s.gits.push(a); return a[0] === "merge-base" ? "abc\n" : ""; };
    const code = (await quiet(() => main(["--base=origin/main"], "/repo", s.deps as never))) as number;
    expect(s.gits.length).toBeGreaterThan(0);
    expect(typeof code).toBe("number");
  });

  it("makeRun runs pnpm only as node + npm_execpath, never through a shell or PATH", () => {
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: "", stderr: "" }; };
    const run = makeRun({ root: "/repo", env: { npm_execpath: "/x/pnpm.cjs" }, execPath: "/node", spawn });
    run({ id: "t", command: "pnpm", args: ["run", "typecheck"] });
    expect(calls[0].cmd).toBe("/node");
    expect(calls[0].args).toEqual(["/x/pnpm.cjs", "run", "typecheck"]);
    expect(calls[0].opts.shell).toBeFalsy();
  });

  it.each([{}, { npm_execpath: "/x/pnpm.exe" }, { npm_execpath: "/x/npm-cli.js" }])("makeRun refuses pnpm without a JS pnpm entry (%j): cannot run, nothing spawned", (env) => {
    const calls: unknown[] = [];
    const run = makeRun({ root: "/repo", env, execPath: "/node", spawn: (...a: unknown[]) => { calls.push(a); return { status: 0 }; } });
    const r = run({ id: "t", command: "pnpm", args: ["run", "typecheck"] }) as { status: number | null; error?: Error };
    expect(calls).toEqual([]);
    expect(r.status).toBeNull();
    expect(r.error?.message).toMatch(/pnpm preflight/);
  });

  it("a pnpm-backed check that cannot run FAILS with the `pnpm preflight` fix", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "typecheck-root": { status: null, error: new Error("run it as `pnpm preflight`") } } });
    expect(byId(h, "typecheck").status).toBe("FAIL");
    expect(byId(h, "typecheck").fix.join("\n")).toMatch(/run it as `pnpm preflight`/);
  });

  it("makeGit fails closed when the repo's git resolver finds nothing, instead of falling back to a bare `git`", () => {
    expect(() => makeGit({ root: "/repo", resolve: () => undefined, exec: () => "" })).toThrow(/git/i);
    const seen: string[] = [];
    const git = makeGit({ root: "/repo", resolve: () => "/usr/bin/git", exec: (g: string, a: string[]) => { seen.push(g, ...a); return "ok"; } });
    expect(git(["status"])).toBe("ok");
    expect(seen).toEqual(["/usr/bin/git", "-C", "/repo", "status"]);
  });

  it("an outcome with an undefined status is still cannot-run", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { guardrails: { status: undefined as unknown as null } } });
    expect(byId(h, "guardrails").status).toBe("FAIL");
    expect(byId(h, "guardrails").detail).toMatch(/cannot run/i);
  });

  it.each(["docs/x.ts", "docs/x.json", "docs/x.mjs", "docs/deep/y.tsx"])("%s is not docs-only: all three typechecks run", async (p) => {
    const h = await run({ changed: [["M", p]] });
    expect(h.calls.filter((c) => c.id.startsWith("typecheck"))).toHaveLength(3);
  });

  it("docs/ prose and images, and *.md anywhere, stay docs-only; an empty change set reports nothing changed", async () => {
    const docs = await run({ changed: [["M", "docs/x.png"], ["M", "lib/NOTES.md"]] });
    expect(byId(docs, "typecheck").status).toBe("NOT APPLICABLE");
    const none = await run({ changed: [] });
    expect(byId(none, "typecheck").status).toBe("NOT APPLICABLE");
    expect(byId(none, "typecheck").detail).toMatch(/nothing changed/i);
    expect((classifyChanges([]) as { docsOnly: boolean }).docsOnly).toBe(false);
  });

  it("gives vitest each test path with a ./ prefix so a leading dash can never be read as an option", async () => {
    const h = await run({ changed: [["M", "convex/a.test.ts"]], tests: true });
    expect(h.calls.find((c) => c.id === "tests")?.args.slice(-1)).toEqual(["./convex/a.test.ts"]);
  });
});
/** One ESLint `--format json` document, as the sonar-lint step reads it. */
const lintJson = (messages: Array<{ ruleId: string | null; severity: 1 | 2; line: number; message: string; fatal?: boolean }>, file = "/repo/lib/a.ts"): string =>
  JSON.stringify([{ filePath: file, messages: messages.map((m) => ({ column: 1, ...m })) }]);

describe("SCRUM-1011 sonar-lint step (Sonar rule classes, locally)", () => {
  const BAD = { ruleId: "sonarjs/no-alphabetical-sort", severity: 2 as const, line: 5, message: "Provide a compare function to avoid sorting elements alphabetically." };
  const SMELL = { ruleId: "sonarjs/cognitive-complexity", severity: 1 as const, line: 9, message: "Refactor this function to reduce its Cognitive Complexity from 21 to the 15 allowed." };

  it("runs eslint with the preflight config, JSON output and only the changed lintable files", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"], ["M", "README.md"], ["D", "lib/old.ts"]] });
    const call = h.calls.find((c) => c.id === "sonar-lint");
    expect(call?.args).toEqual(expect.arrayContaining(["--config", "eslint.preflight.config.mjs", "--format", "json"]));
    expect(call?.args.slice(-2)).toEqual(["--", "lib/a.ts"]);
    expect(byId(h, "sonar-lint").status).toBe("PASS");
  });

  it("is NOT APPLICABLE, with the reason, when no lintable file changed", async () => {
    const h = await run({ changed: [["M", "README.md"]] });
    expect(byId(h, "sonar-lint").status).toBe("NOT APPLICABLE");
    expect(h.calls.some((c) => c.id === "sonar-lint")).toBe(false);
  });

  it("FAILS on a bug-class error, naming the rule id, file:line and the Sonar S-number in the fix", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": { status: 1, stdout: lintJson([BAD]) } } });
    const r = byId(h, "sonar-lint");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/sonarjs\/no-alphabetical-sort/);
    expect(r.detail).toMatch(/lib\/a\.ts:5/);
    expect(r.detail).toMatch(/S2871/);
    expect(r.fix.join("\n")).toMatch(/S2871/);
    expect(h.code).toBe(1);
  });

  it("does not fail on warnings: prints and counts them, exit 0", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": { status: 0, stdout: lintJson([SMELL]) } } });
    const r = byId(h, "sonar-lint");
    expect(r.status).toBe("PASS");
    expect(r.detail).toMatch(/1 warning/);
    expect(h.out).toMatch(/lib\/a\.ts:9/);
    expect(h.out).toMatch(/S3776/);
    expect(h.code).toBe(0);
  });

  it("an error and a warning together FAIL and still list the warning", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": { status: 1, stdout: lintJson([BAD, SMELL]) } } });
    expect(byId(h, "sonar-lint").status).toBe("FAIL");
    expect(h.out).toMatch(/S3776/);
  });

  it("ignores messages from rules that are not Sonar rules (the eslint step owns those)", async () => {
    const other = { ruleId: "no-undef", severity: 2 as const, line: 1, message: "x is not defined" };
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": { status: 1, stdout: lintJson([other]) } } });
    expect(byId(h, "sonar-lint").status).toBe("PASS");
  });

  it("(cannot run) a spawn error, exit 2, unparsable output or a fatal parse error is FAIL, never a pass", async () => {
    const cases: Array<[string, RunOutcome]> = [
      ["spawn", { status: null, error: new Error("spawn ENOENT") }],
      ["exit 2", { status: 2, stderr: "Error: Cannot find module 'eslint-plugin-sonarjs'" }],
      ["not json", { status: 0, stdout: "not json" }],
      ["empty", { status: 0, stdout: "" }],
      ["fatal", { status: 1, stdout: lintJson([{ ruleId: null, severity: 2, line: 1, message: "Parsing error: Unexpected token", fatal: true }]) }],
    ];
    for (const [name, outcome] of cases) {
      const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": outcome } });
      expect(byId(h, "sonar-lint").status, name).toBe("FAIL");
      expect(h.code, name).toBe(1);
    }
  });

  it("(cannot run) FAILS when the preflight config is missing", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], existing: (p) => !/eslint\.preflight\.config/.test(p) });
    expect(byId(h, "sonar-lint").status).toBe("FAIL");
    expect(byId(h, "sonar-lint").detail).toMatch(/cannot run/i);
    expect(h.calls.some((c) => c.id === "sonar-lint")).toBe(false);
  });
});

describe("SCRUM-1011 inventories step (registration inventories that CI runs as unit tests)", () => {
  it("is NOT APPLICABLE when neither convex/ nor an inventory file changed", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]] });
    expect(byId(h, "inventories").status).toBe("NOT APPLICABLE");
    expect(h.calls.some((c) => c.id === "inventories")).toBe(false);
  });

  it("runs the globbed inventory tests with --maxWorkers=1 when convex/ changed", async () => {
    const h = await run({ changed: [["A", "convex/newModule.ts"]] });
    const call = h.calls.find((c) => c.id === "inventories");
    expect(call?.args).toEqual(expect.arrayContaining(["run", "--maxWorkers=1"]));
    const files = (call?.args ?? []).filter((a) => a.startsWith("./"));
    expect([...files].sort((a, b) => a.localeCompare(b))).toEqual([
      "./scripts/economicCommandCensus.test.ts",
      "./scripts/economicCommandCensusDomainIndex.test.ts",
      "./scripts/regression/pilotDoorInventory.test.ts",
      "./scripts/tenantWriteGuard.test.ts",
      "./scripts/tenantWriteGuardDelegation.test.ts",
    ]);
    expect(byId(h, "inventories").status).toBe("PASS");
  });

  it("also runs when an inventory test itself changed", async () => {
    const h = await run({ changed: [["M", "scripts/regression/pilotDoorInventory.test.ts"]] });
    expect(h.calls.some((c) => c.id === "inventories")).toBe(true);
  });

  it("FAILS with the failing output and the command to re-run", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], outcomes: { inventories: { status: 1, stdout: "FAIL tenantWriteGuard.test.ts: convex/deals.ts is not registered" } } });
    const r = byId(h, "inventories");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/not registered/);
    expect(r.fix.join("\n")).toMatch(/vitest\.mjs run --maxWorkers=1/);
  });

  it("FAILS, never skips, when the inventory tests cannot be listed or none are found", async () => {
    const boom = await run({ changed: [["M", "convex/deals.ts"]], readDir: () => { throw new Error("ENOENT scripts"); } });
    expect(byId(boom, "inventories").status).toBe("FAIL");
    expect(byId(boom, "inventories").detail).toMatch(/cannot run/i);
    const none = await run({ changed: [["M", "convex/deals.ts"]], readDir: () => [] });
    expect(byId(none, "inventories").status).toBe("FAIL");
  });

  it("FAILS when the test process cannot be spawned", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], outcomes: { inventories: { status: null, error: new Error("spawn ENOENT") } } });
    expect(byId(h, "inventories").status).toBe("FAIL");
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