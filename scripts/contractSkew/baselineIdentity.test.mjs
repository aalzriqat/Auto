import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { callExpressionAt } from "./baselineIdentity.mjs";
import { resolveGit } from "./gitExecutable.mjs";

const checker = fileURLToPath(new URL("./checkBaselineIdentity.mjs", import.meta.url));
const helper = fileURLToPath(new URL("./relocateBaseline.mjs", import.meta.url));
const file = "app/(dashboard)/[orgId]/sourcing/client.tsx";
const oldSite = `${file}:150:13`;
const newSite = `${file}:156:13`;
const expression = "markPaid({ payableId: 'payable', taxAmount: amount })";

// SCRUM-866 / #690: reproduce the exact 150:13 -> 156:13 coordinate shift.
function source(line, call = expression) {
  const prefix = "declare const api: any;\ndeclare function useMutation(ref: any): (args: any) => void;\nconst markPaid = useMutation(api.sourcingPayables.markPaid);\ndeclare const amount: number;\nexport function pay() {\n";
  return prefix + "\n".repeat(line - 6) + `            ${call};\n}\n`;
}

function fixture(head = source(156)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-identity-"));
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), source(150));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [] } }));
  const entries = ["bankAccountId", "taxAmount", "idempotencyKey"].map((contractPath) => ({
    surface: "web", file, callSiteId: oldSite, functionId: "sourcingPayables:markPaid",
    contractPath, kind: "TYPE_UNKNOWN", cause: "reviewed cause", fingerprint: "reviewed fingerprint",
    multiplicity: 1, rationale: "reviewed rationale", issue: "SCRUM-866", expires: "2026-11-01",
  }));
  const baseline = JSON.stringify({ version: 1, entries }, null, 2) + "\n";
  fs.writeFileSync(path.join(root, "baseline.json"), baseline);
  const git = resolveGit();
  assert.ok(git, "git is required for real base-revision controls");
  const runGit = (args) => execFileSync(git, args, { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 10000 });
  runGit(["init", "--quiet"]);
  runGit(["add", "--", file, "baseline.json", "tsconfig.json"]);
  runGit(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "base fixture"]);
  const base = runGit(["rev-parse", "HEAD"]).trim();
  fs.writeFileSync(path.join(root, file), head);
  return { root, baseline, base, entries };
}

function run(script, root, args = []) {
  const child = spawnSync(process.execPath, [script, "--baseline", "baseline.json", ...args], {
    cwd: root, encoding: "utf8", timeout: 30000,
  });
  assert.ifError(child.error);
  return { status: child.status, output: child.stdout + child.stderr };
}

test("#690 line shift fails the PR check and identifies the replacement call", () => {
  const { root, baseline } = fixture();
  const checked = run(checker, root);
  assert.equal(checked.status, 10, checked.output);
  assert.ok(checked.output.includes(oldSite), checked.output);
  assert.ok(checked.output.includes(newSite), checked.output);
  assert.match(checked.output, /sourcingPayables:markPaid/);
  assert.equal(fs.readFileSync(path.join(root, "baseline.json"), "utf8"), baseline);
});

test("dry-run proposes and --write relocates byte-identical calls, preserving all review fields", () => {
  const { root, baseline, base, entries } = fixture();
  const proposed = run(helper, root, ["--base", base]);
  assert.equal(proposed.status, 0, proposed.output);
  assert.ok(proposed.output.includes(newSite), proposed.output);
  assert.equal(fs.readFileSync(path.join(root, "baseline.json"), "utf8"), baseline);
  const written = run(helper, root, ["--base", base, "--write"]);
  assert.equal(written.status, 0, written.output);
  const actual = JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8"));
  assert.deepEqual(actual.entries, entries.map((entry) => ({ ...entry, callSiteId: newSite })));
  const checked = run(checker, root);
  assert.equal(checked.status, 0, checked.output);
});

test("changed argument text requires human review and --write leaves the baseline byte-identical", () => {
  const { root, baseline, base } = fixture(source(156, expression.replace("amount", "0")));
  const refused = run(helper, root, ["--base", base, "--write"]);
  assert.equal(refused.status, 10, refused.output);
  assert.match(refused.output, /human review/i);
  assert.ok(refused.output.includes(newSite), refused.output);
  assert.equal(fs.readFileSync(path.join(root, "baseline.json"), "utf8"), baseline);
});

test("ambiguous identical calls are never rewritten", () => {
  const { root, baseline, base } = fixture(source(156).replace("\n}", `\n            ${expression};\n}`));
  const refused = run(helper, root, ["--base", base, "--write"]);
  assert.equal(refused.status, 10, refused.output);
  assert.match(refused.output, /human review/i);
  assert.equal(fs.readFileSync(path.join(root, "baseline.json"), "utf8"), baseline);
});

test("a different function at the old coordinates does not satisfy the identity check", () => {
  const { root } = fixture(source(150).replace("sourcingPayables.markPaid", "sourcingPayables.cancel"));
  const checked = run(checker, root);
  assert.equal(checked.status, 10, checked.output);
});

test("unreadable baseline or base revision cannot pass or rewrite evidence", () => {
  const { root, baseline } = fixture();
  const refused = run(helper, root, ["--base", "missing-base", "--write"]);
  assert.equal(refused.status, 3, refused.output);
  assert.equal(fs.readFileSync(path.join(root, "baseline.json"), "utf8"), baseline);
  fs.writeFileSync(path.join(root, "baseline.json"), "broken json");
  assert.equal(run(checker, root).status, 3);
});

test("two old calls cannot both relocate onto one surviving identical call", () => {
  const { root, entries } = fixture();
  const document = { version: 1, entries: [...entries, { ...entries[0], callSiteId: `${file}:151:13` }] };
  const baseline = JSON.stringify(document, null, 2) + "\n";
  fs.writeFileSync(path.join(root, "baseline.json"), baseline);
  // The second base site must contain a real call too, rather than testing a missing old expression.
  fs.writeFileSync(path.join(root, file), source(150).replace("\n}", `\n            ${expression};\n}`));
  const git = resolveGit();
  assert.ok(git, "git is required for base-revision controls");
  execFileSync(git, ["add", "--", file], { cwd: root, stdio: "pipe" });
  execFileSync(git, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "two old calls"], { cwd: root, stdio: "pipe" });
  fs.writeFileSync(path.join(root, file), source(156));
  const refused = run(helper, root, ["--base", "HEAD", "--write"]);
  assert.equal(refused.status, 10, refused.output);
  assert.equal(fs.readFileSync(path.join(root, "baseline.json"), "utf8"), baseline);
});

test("a deleted client file fails with no candidate instead of an empty successful scan", () => {
  const { root } = fixture();
  // Rename rather than delete repository files; the new name is outside the baseline scope.
  fs.renameSync(path.join(root, file), path.join(root, "removed-client.tsx"));
  const checked = run(checker, root);
  assert.equal(checked.status, 10, checked.output);
  assert.match(checked.output, /candidates: none/);
});

// SCRUM-866: on Windows `core.autocrlf=true` checks the head out as CRLF while `git show <base>:file`
// returns the stored LF blob, so a textually identical MULTI-LINE call must still relocate.
const multiLine = "markPaid({\n              payableId: 'payable',\n              taxAmount: amount,\n            })";

test("a multi-line call relocates when the head is checked out with CRLF and the base blob is LF", () => {
  const { root, base, entries } = fixture(source(156, multiLine).replace(/\n/g, "\r\n"));
  fs.writeFileSync(path.join(root, file), source(150, multiLine));
  const git = resolveGit();
  assert.ok(git, "git is required for base-revision controls");
  execFileSync(git, ["add", "--", file], { cwd: root, stdio: "pipe" });
  execFileSync(git, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "multi-line base"], { cwd: root, stdio: "pipe" });
  const multiBase = execFileSync(git, ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.notEqual(multiBase, base);
  assert.ok(!execFileSync(git, ["show", `${multiBase}:${file}`], { cwd: root, encoding: "utf8" }).includes("\r"), "the base blob must be LF");
  fs.writeFileSync(path.join(root, file), source(156, multiLine).replace(/\n/g, "\r\n"));
  assert.ok(fs.readFileSync(path.join(root, file), "utf8").includes("\r\n"), "the head must be CRLF");
  const written = run(helper, root, ["--base", multiBase, "--write"]);
  assert.equal(written.status, 0, written.output);
  const actual = JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8"));
  assert.deepEqual(actual.entries, entries.map((entry) => ({ ...entry, callSiteId: newSite })));
  assert.equal(run(checker, root).status, 0);
});

test("CRLF normalisation does not hide a real change inside a multi-line call", () => {
  const { root, entries } = fixture();
  fs.writeFileSync(path.join(root, file), source(150, multiLine));
  const git = resolveGit();
  assert.ok(git, "git is required for base-revision controls");
  execFileSync(git, ["add", "--", file], { cwd: root, stdio: "pipe" });
  execFileSync(git, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "multi-line base"], { cwd: root, stdio: "pipe" });
  const multiBase = execFileSync(git, ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(root, file), source(156, multiLine.replace("amount", "0")).replace(/\n/g, "\r\n"));
  const refused = run(helper, root, ["--base", multiBase, "--write"]);
  assert.equal(refused.status, 10, refused.output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8")).entries[0].callSiteId, entries[0].callSiteId);
});

test("--write preserves the baseline's CRLF line endings and every unrelated byte", () => {
  const { root, baseline, base } = fixture();
  const crlf = baseline.replace(/\n/g, "\r\n");
  fs.writeFileSync(path.join(root, "baseline.json"), crlf);
  const written = run(helper, root, ["--base", base, "--write"]);
  assert.equal(written.status, 0, written.output);
  assert.equal(fs.readFileSync(path.join(root, "baseline.json"), "utf8"), crlf.replaceAll(oldSite, newSite));
});

test("request maps inside unrelated wrapper calls cannot authorize relocation", () => {
  const text = "const map = useMemo(() => ({ key: { query: api.a.b, args: payload } }), []); useQueries(map);";
  const parsed = ts.createSourceFile("app/query.tsx", text, ts.ScriptTarget.Latest, true);
  const site = `app/query.tsx:1:${text.indexOf("api.a.b") + 1}`;
  assert.equal(callExpressionAt(parsed, site), null);
});
