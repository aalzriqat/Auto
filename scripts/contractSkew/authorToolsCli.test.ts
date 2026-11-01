// @vitest-environment node
/**
 * The author tools (checkBaselineIdentity, relocateBaseline, renewBaselineReviewed) run IN PROCESS here, so the
 * coverage report Sonar reads counts them (coverage from a spawned child is not recorded), and the SonarCloud
 * findings of #703 round 12 have a failing-first test each: argument injection through a revision (S8705), path
 * traversal through a CLI path (S8707), and a CLI started through a symlink or junction silently doing nothing.
 *
 * Every fixture repository lives under os.tmpdir() and builds its own history, so a depth-1 clone passes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { assertSafeRevision, isAncestor, resolveCommit, resolveGit, runGitText } from "./gitExecutable.mjs";
import { resolveInside } from "./baselineFile.mjs";
import { readBaselineEntries, snapshotBaseline, writeBaselineDirectory } from "./baselineTestSupport.mjs";
import { isRunDirectly } from "./runDirectly.mjs";
import { main as checkMain } from "./checkBaselineIdentity.mjs";
import { main as relocateMain } from "./relocateBaseline.mjs";
import { main as renewMain } from "./renewBaselineReviewed.mjs";

const git = resolveGit();
const toolDir = path.resolve(__dirname);
const created: string[] = [];
const originalCwd = process.cwd();
// The CLI fixtures model local runs independently of the runner's GitHub event.
beforeAll(() => vi.stubEnv("GITHUB_EVENT_NAME", undefined));
afterAll(() => vi.unstubAllEnvs());
afterEach(() => process.chdir(originalCwd));
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
};
const runGit = (cwd: string, ...args: string[]) =>
  execFileSync(String(git), ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: "pipe", timeout: 20_000 }).trim();
const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) }, out, err, all: () => [...out, ...err].join("\n") };
};

beforeAll(() => {
  expect(git, "git must be locatable; cannot-run is a failure, not a skip").toBeTruthy();
});

describe("revision arguments cannot be read as git options (argument injection, S8705)", () => {
  test.each(["--output=owned", "-h", "--upload-pack=calc", "-", "a b", "main\n--x", "HEAD:file", "HEAD@{1}", "HEAD^{tree}", "a..b", "", " HEAD", "caf\u00e9", "ab\u{1F600}", "HEAD\u0000"])(
    "assertSafeRevision refuses %j", (revision) => {
      expect(() => assertSafeRevision(revision)).toThrow(/not a plain revision name/);
    });

  test.each(["HEAD", "HEAD~2", "HEAD^", "origin/main", "c82890bd", "v1.2.3", "claude/scrum866-baseline-renewal", "a".repeat(40)])(
    "assertSafeRevision accepts %s", (revision) => {
      expect(assertSafeRevision(revision)).toBe(revision);
    });

  test("assertSafeRevision returns an equal copy rebuilt from the allowlist, not the caller's string", () => {
    const typed = ["HEAD", "~1"].join("");
    expect(assertSafeRevision(typed)).toBe("HEAD~1");
    expect(assertSafeRevision("x".repeat(255))).toHaveLength(255);
    expect(() => assertSafeRevision("x".repeat(256))).toThrow(/not a plain revision name/);
  });

  test("assertSafeRevision refuses a non-string", () => {
    expect(() => assertSafeRevision(undefined)).toThrow(/not a plain revision name/);
  });

  test("resolveCommit never forwards an option-shaped revision to git, and returns a full commit id", () => {
    const dir = tempDir("cs-rev-");
    runGit(dir, "init", "-q");
    runGit(dir, "commit", "-q", "--allow-empty", "-m", "root");
    const marker = path.join(dir, "owned.txt");
    expect(() => resolveCommit(String(git), `--output=${marker}`, dir)).toThrow(/not a plain revision name/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(resolveCommit(String(git), "HEAD", dir)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("isAncestor validates both revisions and answers from git", () => {
    const dir = tempDir("cs-anc-");
    runGit(dir, "init", "-q");
    runGit(dir, "commit", "-q", "--allow-empty", "-m", "one");
    const first = runGit(dir, "rev-parse", "HEAD");
    runGit(dir, "commit", "-q", "--allow-empty", "-m", "two");
    expect(isAncestor(String(git), first, "HEAD", dir)).toBe(true);
    expect(isAncestor(String(git), "HEAD", first, dir)).toBe(false);
    expect(() => isAncestor(String(git), "--help", "HEAD", dir)).toThrow(/ancestor/);
    expect(() => isAncestor(String(git), "HEAD", "--help", dir)).toThrow(/descendant/);
  });

  test("a NUL byte in a git argument is refused before the process starts", () => {
    expect(() => runGitText(String(git), ["rev-parse", "HE\0AD"])).toThrow(/NUL/);
  });
});

describe("CLI paths stay inside the repository (path traversal, S8707)", () => {
  test.each(["../outside.json", "..", "sub/../../outside.json", "", "  "])("resolveInside refuses %j", (candidate) => {
    const root = tempDir("cs-root-");
    expect(() => resolveInside(root, candidate)).toThrow();
  });

  test("resolveInside refuses an absolute path elsewhere and accepts one inside", () => {
    const root = tempDir("cs-root-");
    const elsewhere = tempDir("cs-else-");
    expect(() => resolveInside(root, path.join(elsewhere, "x.json"))).toThrow(/outside the repository root/);
    expect(resolveInside(root, path.join(root, "a", "x.json"))).toBe(path.join(root, "a", "x.json"));
    expect(resolveInside(root, "a/x.json")).toBe(path.join(root, "a", "x.json"));
    expect(() => resolveInside(root, "a\0b")).toThrow(/non-empty path/);
  });

  test("resolveInside refuses a link inside the root that points outside it", () => {
    const root = tempDir("cs-root-");
    const elsewhere = tempDir("cs-else-");
    fs.writeFileSync(path.join(elsewhere, "secret.json"), "{}");
    fs.symlinkSync(elsewhere, path.join(root, "link"), "junction");
    expect(() => resolveInside(root, "link/secret.json")).toThrow(/resolves outside the repository root/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// checkBaselineIdentity + relocateBaseline, in process.
const file = "app/(dashboard)/[orgId]/sourcing/client.tsx";
const oldSite = `${file}:150:13`;
const newSite = `${file}:156:13`;
const expression = "markPaid({ payableId: 'payable', taxAmount: amount })";
const source = (line: number, call = expression) =>
  "declare const api: any;\ndeclare function useMutation(ref: any): (args: any) => void;\nconst markPaid = useMutation(api.sourcingPayables.markPaid);\ndeclare const amount: number;\nexport function pay() {\n" +
  "\n".repeat(line - 6) + `            ${call};\n}\n`;

function identityFixture(head = source(156)) {
  const root = tempDir("cs-identity-");
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), source(150));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [] } }));
  const entries = ["bankAccountId", "taxAmount"].map((contractPath) => ({
    surface: "web", file, callSiteId: oldSite, functionId: "sourcingPayables:markPaid", contractPath, kind: "TYPE_UNKNOWN",
    cause: "reviewed cause", fingerprint: "reviewed fingerprint", multiplicity: 1, rationale: "reviewed rationale", issue: "SCRUM-866", expires: "2026-11-01",
  }));
  writeBaselineDirectory(path.join(root, "baseline"), entries);
  const baseline = snapshotBaseline(path.join(root, "baseline"));
  runGit(root, "init", "-q");
  runGit(root, "add", "--", file, "baseline", "tsconfig.json");
  runGit(root, "commit", "-q", "-m", "base fixture");
  const base = runGit(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, file), head);
  process.chdir(root);
  return { root, baseline, base, entries };
}
const baselineText = (root: string) => snapshotBaseline(path.join(root, "baseline"));

describe("checkBaselineIdentity main (in process)", { timeout: 60_000 }, () => {
  test("passes when every baseline entry still names a live call", () => {
    const { root } = identityFixture(source(150));
    const out = sink();
    expect(checkMain(["--baseline", "baseline"], out.io)).toBe(0);
    expect(out.all()).toContain("2 baseline entries matched");
    expect(baselineText(root)).toContain(oldSite);
  });

  test("a shifted call is drift (exit 10) naming the replacement; the baseline is not touched", () => {
    const { root, baseline } = identityFixture();
    const out = sink();
    expect(checkMain(["--baseline", "baseline"], out.io)).toBe(10);
    expect(out.all()).toContain(oldSite);
    expect(out.all()).toContain(newSite);
    expect(out.all()).toContain("relocateBaseline.mjs");
    expect(baselineText(root)).toBe(baseline);
  });

  test("an empty baseline is refused unless --allow-empty, which never excuses drift", () => {
    const { root } = identityFixture();
    writeBaselineDirectory(path.join(root, "empty"), []);
    const refused = sink();
    expect(checkMain(["--baseline", "empty"], refused.io)).toBe(3);
    expect(refused.all()).toMatch(/no baseline entries/);
    const allowed = sink();
    expect(checkMain(["--baseline", "empty", "--allow-empty"], allowed.io)).toBe(0);
    expect(allowed.all()).toMatch(/empty baseline allowed/);
    const drift = sink();
    expect(checkMain(["--baseline", "baseline", "--allow-empty"], drift.io)).toBe(10);
  });

  test.each(["../baseline.json", "..", path.join(os.tmpdir(), "elsewhere.json")])("refuses --baseline %s outside the repository (exit 3)", (baseline) => {
    identityFixture(source(150));
    const out = sink();
    expect(checkMain(["--baseline", baseline], out.io)).toBe(3);
    expect(out.all()).toMatch(/UNAVAILABLE.*(outside|resolves outside)/s);
  });

  test("an unreadable baseline and an unknown option are UNAVAILABLE, never a pass", () => {
    const { root } = identityFixture(source(150));
    fs.mkdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(root, "broken", "app+page.tsx.json"), "broken json");
    const broken = sink();
    expect(checkMain(["--baseline", "broken"], broken.io)).toBe(3);
    expect(broken.all()).toMatch(/UNAVAILABLE.*JSON/s);
    const unknown = sink();
    expect(checkMain(["--nope"], unknown.io)).toBe(3);
  });
});

describe("relocateBaseline main (in process)", { timeout: 60_000 }, () => {
  test("dry run proposes and leaves the baseline byte-identical; --write relocates then the check passes", () => {
    const { root, baseline, base, entries } = identityFixture();
    const dry = sink();
    expect(relocateMain(["--baseline", "baseline", "--base", base], dry.io)).toBe(0);
    expect(dry.all()).toContain(`PROPOSE: ${oldSite} -> ${newSite}`);
    expect(dry.all()).toContain("Dry run; baseline unchanged.");
    expect(baselineText(root)).toBe(baseline);
    const written = sink();
    expect(relocateMain(["--baseline", "baseline", "--base", base, "--write"], written.io)).toBe(0);
    expect(written.all()).toContain("RELOCATE:");
    expect(readBaselineEntries(path.join(root, "baseline"))).toEqual(entries.map((e) => ({ ...e, callSiteId: newSite })));
    expect(checkMain(["--baseline", "baseline"], sink().io)).toBe(0);
  });

  test("a changed call needs human review (exit 10) and --write leaves the baseline untouched", () => {
    const { root, baseline, base } = identityFixture(source(156, expression.replace("amount", "0")));
    const out = sink();
    expect(relocateMain(["--baseline", "baseline", "--base", base, "--write"], out.io)).toBe(10);
    expect(out.all()).toMatch(/NEEDS HUMAN REVIEW/);
    expect(baselineText(root)).toBe(baseline);
  });

  test("requires --base, refuses an option-shaped revision before git sees it, and an unknown commit", () => {
    const { root, baseline } = identityFixture();
    const none = sink();
    expect(relocateMain(["--baseline", "baseline"], none.io)).toBe(3);
    expect(none.all()).toMatch(/Required: --base/);
    const marker = path.join(root, "owned.txt");
    const injected = sink();
    expect(relocateMain(["--baseline", "baseline", `--base=--output=${marker}`], injected.io)).toBe(3);
    expect(injected.all()).toMatch(/not a plain revision name/);
    expect(fs.existsSync(marker)).toBe(false);
    const unknown = sink();
    expect(relocateMain(["--baseline", "baseline", "--base", "no-such-rev", "--write"], unknown.io)).toBe(3);
    expect(baselineText(root)).toBe(baseline);
  });

  test.each(["../baseline.json", path.join(os.tmpdir(), "elsewhere.json")])("refuses --baseline %s outside the repository, and writes nothing", (baseline) => {
    const { base } = identityFixture();
    const out = sink();
    expect(relocateMain(["--baseline", baseline, "--base", base, "--write"], out.io)).toBe(3);
    expect(out.all()).toMatch(/outside the repository root/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// renewBaselineReviewed, in process, against a hermetic repository.
const RENEWED = "2026-12-01";
const renewalEntry = (over: Record<string, unknown> = {}) => ({
  surface: "web", file: "app/page.tsx", callSiteId: "app/page.tsx:1:5", functionId: "vehicles:update", contractPath: "orgId",
  kind: "TYPE_UNKNOWN", cause: "cause", fingerprint: "0123456789abcdef", multiplicity: 1, rationale: "Reviewed rationale with no file reference.",
  issue: "SCRUM-711", expires: "2026-11-01", ...over,
});
const BASELINE = "scripts/contractSkew/needs-evidence-baseline";

describe("renewBaselineReviewed main (in process)", { timeout: 90_000 }, () => {
  let root: string;
  let reviewed: string;
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const baselinePath = () => path.join(root, BASELINE);
  const run = (...args: string[]) => {
    const out = sink();
    return { code: renewMain(args, out.io, root), out };
  };
  beforeAll(() => {
    root = tempDir("cs-renew-main-");
    write("tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "bundler", module: "esnext", jsx: "preserve", types: [] } }));
    write("package.json", "{}");
    write("pnpm-lock.yaml", "lockfileVersion: 9\n");
    write("convex/schema.ts", "export const schema = {};");
    write("convex/tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "bundler", module: "esnext", types: [] } }));
    write("convex/definition.ts", 'declare function mutation(options: unknown): unknown; export const update = mutation({ args: { orgId: "string" } });');
    write("convex/vehicles.ts", 'export { update } from "./definition";');
    write("app/page.tsx", "export const payload: unknown = {};");
    writeBaselineDirectory(baselinePath(), [renewalEntry()]);
    runGit(root, "init", "-q");
    runGit(root, "add", "--", ".");
    runGit(root, "commit", "-q", "-m", "reviewed fixture");
    reviewed = runGit(root, "rev-parse", "HEAD");
  });
  const setRenewed = (sha: string) => writeBaselineDirectory(baselinePath(), [renewalEntry({
    expires: RENEWED, renewal: `SCRUM-866 round 12 review against origin/main ${sha}: app/page.tsx and convex/definition.ts reviewed.`,
  })]);

  test("mechanical renewal: dry run changes nothing, --write renews the provably unchanged entry", () => {
    const before = snapshotBaseline(baselinePath());
    const dry = run("--reviewed", reviewed, "--expires", RENEWED, "--renewal", "SCRUM-866 unchanged since reviewed");
    expect(dry.code, dry.out.all()).toBe(0);
    expect(dry.out.all()).toContain("renewed 1, already current 0, refused 0");
    expect(dry.out.all()).toContain("dry run; pass --write to apply");
    expect(snapshotBaseline(baselinePath())).toBe(before);
    const applied = run("--reviewed", reviewed, "--expires", RENEWED, "--renewal", "SCRUM-866 unchanged since reviewed", "--write");
    expect(applied.code, applied.out.all()).toBe(0);
    expect(applied.out.all()).toContain("wrote ");
    expect(readBaselineEntries(baselinePath())[0]).toMatchObject({ expires: RENEWED, renewal: "SCRUM-866 unchanged since reviewed" });
    writeBaselineDirectory(baselinePath(), [renewalEntry()]);
    expect(snapshotBaseline(baselinePath())).toBe(before);
  });

  test("evidence check passes for an entry whose renewal names the reviewed head", () => {
    setRenewed(reviewed);
    const result = run("--reviewed", reviewed, "--check-evidence");
    expect(result.code, result.out.all()).toBe(0);
    expect(result.out.all()).toContain("1 renewed entries checked, 0 unrenewed, 0 stale");
  });

  test("evidence check reports a file changed after the recorded review as STALE (exit 10)", () => {
    setRenewed(reviewed);
    write("convex/definition.ts", fs.readFileSync(path.join(root, "convex/definition.ts"), "utf8") + "\n// changed after review\n");
    runGit(root, "add", "--", "convex/definition.ts");
    runGit(root, "commit", "-q", "-m", "definition changed");
    const result = run("--reviewed", reviewed, "--check-evidence");
    expect(result.code, result.out.all()).toBe(10);
    expect(result.out.all()).toContain("STALE entry #1");
    expect(result.out.all()).toContain("1 stale");
  });

  test("usage errors are UNAVAILABLE (exit 3)", () => {
    for (const args of [[], ["--reviewed", reviewed], ["--reviewed", reviewed, "--expires", RENEWED], ["--bogus"]]) {
      expect(run(...args).code, args.join(" ")).toBe(3);
    }
  });

  test("an option-shaped revision is refused before git sees it", () => {
    const marker = path.join(root, "owned.txt");
    const result = run(`--reviewed=--output=${marker}`, "--check-evidence");
    expect(result.code).toBe(3);
    expect(result.out.all()).toMatch(/not a plain revision name/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test.each(["../elsewhere.json", path.join(os.tmpdir(), "elsewhere.json")])("refuses --baseline %s outside the repository (exit 3), reading and writing nothing", (baseline) => {
    const result = run("--reviewed", reviewed, "--check-evidence", "--baseline", baseline);
    expect(result.code).toBe(3);
    expect(result.out.all()).toMatch(/outside the repository root/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// M1: a CLI started through a symlink or junction must still run.
describe("CLIs started through a symlink or junction still run (fail-closed entry point)", { timeout: 60_000 }, () => {
  const linkedTools = () => {
    const holder = tempDir("cs-link-");
    const link = path.join(holder, "linked");
    fs.symlinkSync(toolDir, link, "junction");
    return { holder, link };
  };

  test("isRunDirectly compares real paths", () => {
    const { link } = linkedTools();
    const via = path.join(link, "runDirectly.mjs");
    const url = pathToFileURL(path.join(toolDir, "runDirectly.mjs")).href;
    expect(isRunDirectly(url, via)).toBe(true);
    expect(isRunDirectly(url, path.join(toolDir, "runDirectly.mjs"))).toBe(true);
    expect(isRunDirectly(url, path.join(toolDir, "gitExecutable.mjs"))).toBe(false);
    expect(isRunDirectly(url, undefined)).toBe(false);
    expect(isRunDirectly(url, path.join(toolDir, "does-not-exist.mjs"))).toBe(false);
  });

  test.each([
    ["renewBaselineReviewed.mjs", ["--reviewed=--output=owned", "--check-evidence"], /not a plain revision name/],
    ["relocateBaseline.mjs", ["--base=--output=owned"], /Relocation UNAVAILABLE.*not a plain revision name/s],
    ["checkBaselineIdentity.mjs", ["--baseline", "../outside.json"], /Call identity check UNAVAILABLE.*outside the repository root/s],
  ])("%s exits non-zero with a diagnostic when started through a junction", (script, args, diagnostic) => {
    const { holder, link } = linkedTools();
    const child = spawnSync(process.execPath, [path.join(link, script), ...args], { cwd: holder, encoding: "utf8", timeout: 30_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(3);
    expect(child.stderr).toMatch(diagnostic);
    expect(fs.existsSync(path.join(holder, "owned"))).toBe(false);
  });
});
