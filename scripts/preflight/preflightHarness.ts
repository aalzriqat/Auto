// Shared test harness for the preflight runner (SCRUM-1007, split out in SCRUM-1011): drives runPreflight with fake git, fake
// child processes and a fake file system, so step tests need no repository, no network and no real tools.
import { exitCodeOf, runPreflight } from "./preflight.mjs";

export interface CheckResult {
  id: string;
  title: string;
  status: "PASS" | "FAIL" | "NOT APPLICABLE";
  detail: string;
  fix: string[];
}
export interface RunCall { id: string; command: string; args: string[] }
export interface RunOutcome { status: number | null; stdout?: string; stderr?: string; error?: Error }
export interface ApiStub { ok: boolean; problems: Array<{ message: string; fix: string }>; expectedCount?: number }

export const NUL = "\0";
export const status = (entries: Array<[string, string]>) => entries.map(([s, p]) => `${s}${NUL}${p}${NUL}`).join("");
export const ok = (stdout = ""): RunOutcome => ({ status: 0, stdout, stderr: "" });
export const okApi = (): ApiStub => ({ ok: true, problems: [], expectedCount: 1 });

export const PIN_SOURCE = `const EXECUTION_INPUTS = [\n  {\n    "file": "package.json",\n    "hash": "aa"\n  },\n  {\n    "file": "tsconfig.json",\n    "hash": "bb"\n  }\n];\n\nfunction other() {}\n`;

/** The inventory test files that exist in the real repository, as directory listings. */
export const defaultReadDir = (dir: string): string[] => {
  const d = dir.replaceAll("\\", "/");
  if (d.endsWith("/scripts/regression")) return ["pilotDoorInventory.test.ts", "other.test.ts"];
  if (d.endsWith("/scripts")) return ["tenantWriteGuard.test.ts", "tenantWriteGuardDelegation.test.ts", "economicCommandCensus.test.ts", "economicCommandCensusDomainIndex.test.ts", "unrelated.test.ts"];
  throw new Error(`unexpected readDir ${dir}`);
};

export interface Harness { calls: RunCall[]; gitCalls: string[][]; results: CheckResult[]; code: number; out: string }

/** Drop leading `-c key=value` pairs and `--literal-pathspecs`, so fakes match on the git subcommand whatever the step pins. */
const withoutConfig = (args: string[]): string[] => {
  let i = 0;
  while (args[i] === "-c" || args[i] === "--literal-pathspecs") i += args[i] === "-c" ? 2 : 1;
  return args.slice(i);
};
export async function run(opts: {
  changed: Array<[string, string]>;
  untracked?: string[];
  outcomes?: Record<string, RunOutcome | (() => RunOutcome)>;
  existing?: (p: string) => boolean;
  api?: () => ApiStub;
  readText?: (p: string) => string;
  readDir?: (p: string) => string[];
  porcelain?: string;
  gitignoreDiff?: string;
  /**
   * `git diff -U0` output the sonar-lint step uses to scope findings to changed lines; empty means every line counts. A string is
   * returned for whichever single file is asked about; a record is keyed by that file (a file not in it gets no output).
   */
  hunks?: string | Record<string, string>;
  tests?: boolean;
}): Promise<Harness> {
  const calls: RunCall[] = [];
  const gitCalls: string[][] = [];
  const lines: string[] = [];
  const result = await runPreflight({
    root: "/repo",
    options: { tests: Boolean(opts.tests) },
    log: (l: string) => lines.push(l),
    deps: {
      git: (rawArgs: string[]) => {
        gitCalls.push(rawArgs);
        const args = withoutConfig(rawArgs);
        if (args[0] === "merge-base") return "0123456789abcdef0123456789abcdef01234567\n";
        if (args[0] === "diff" && args.includes("-U0")) {
          const hunks = opts.hunks ?? "";
          return typeof hunks === "string" ? hunks : (hunks[rawArgs.at(-1) ?? ""] ?? "");
        }
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
        // sonar-lint reads JSON from stdout; an empty document is "no findings", never an empty string.
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
  return { calls, gitCalls, results: result.results as CheckResult[], code: exitCodeOf(result.results), out: lines.join("\n") };
}

export const byId = (h: Harness, id: string): CheckResult => {
  const r = h.results.find((x) => x.id === id);
  if (!r) throw new Error(`no result for ${id}: ${h.results.map((x) => x.id).join(",")}`);
  return r;
};
