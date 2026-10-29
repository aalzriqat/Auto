import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "./renewBaselineReviewed.mjs";
import { resolveGit } from "./gitExecutable.mjs";

const baseline = "scripts/contractSkew/needs-evidence-baseline.json";
const client = "app/page.tsx";
const backend = "convex/definition.ts";
const trailer = "Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-blob-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = resolveGit();
  assert.ok(git, "real git is required");
  const run = (...args) => execFileSync(git, args, { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 10000 }).trim();
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
  };
  const entry = { surface: "web", file: client, callSiteId: `${client}:1:1`, functionId: "vehicles:update",
    contractPath: "orgId", kind: "TYPE_UNKNOWN", cause: "cause", fingerprint: "fingerprint", multiplicity: 1,
    rationale: "Reviewed fixture", issue: "SCRUM-866", expires: "2026-11-01" };
  const save = (renewal, overrides = {}) => write(baseline, JSON.stringify({ version: 1, entries: [{ ...entry, ...overrides,
    ...(renewal === undefined ? {} : { renewal }) }] }, null, 2) + "\n");
  const commit = (message) => {
    run("add", "--", client, "convex", "tsconfig.json", "package.json", "pnpm-lock.yaml", baseline);
    run("commit", "-q", "-m", message, "-m", trailer);
    return run("rev-parse", "HEAD");
  };
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Fixture");
  run("config", "user.email", "fixture@example.invalid");
  run("config", "commit.gpgsign", "false");
  run("config", "core.autocrlf", "false");
  write(client, "export const payload: unknown = {};\n");
  write(backend, "declare function mutation(x: unknown): unknown; export const update = mutation({ args: {} });\n");
  write("convex/vehicles.ts", 'export { update } from "./definition";\n');
  write("convex/schema.ts", "export default {};\n");
  const config = JSON.stringify({ compilerOptions: { moduleResolution: "bundler", module: "esnext", types: [] } });
  write("tsconfig.json", config);
  write("convex/tsconfig.json", config);
  write("package.json", "{}\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  save();
  const base = commit("test(SCRUM-866): base fixture");
  const blob = (file) => run("rev-parse", `HEAD:${file}`);
  const reference = (records = [[client, blob(client)], [backend, blob(backend)]]) => `reviewed fixture; evidence-blobs ${JSON.stringify(records)}`;
  const check = (extra = []) => {
    const lines = [];
    const status = main(["--reviewed", base, "--check-evidence", ...extra], { log: (s) => lines.push(s), error: (s) => lines.push(s) }, root);
    return { status, output: lines.join("\n") };
  };
  return { root, run, write, save, commit, base, blob, reference, check };
}

test("blob evidence survives a real squash with its original commits absent from history", (t) => {
  const f = fixture(t);
  f.run("switch", "-q", "-c", "reviewed");
  f.write(client, "export const payload: unknown = { reviewed: true };\n");
  const sourceHead = f.commit("test(SCRUM-866): reviewed source");
  f.save(f.reference(), { expires: "2026-12-01" });
  const reviewHead = f.commit("test(SCRUM-866): blob renewal");
  f.run("switch", "-q", "main");
  f.run("merge", "--squash", "reviewed");
  f.commit("test(SCRUM-866): squash review");
  f.run("branch", "-D", "reviewed");
  const history = f.run("rev-list", "HEAD");
  assert.ok(!history.includes(sourceHead) && !history.includes(reviewHead));
  const result = f.check(["--pr-base", f.base]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1 renewed entries checked.*0 stale/);
});

for (const file of [client, backend]) {
  test(`blob evidence refuses a later change to ${file}`, (t) => {
    const f = fixture(t);
    f.save(f.reference());
    f.commit("test(SCRUM-866): record blobs");
    f.write(file, fs.readFileSync(path.join(f.root, file), "utf8") + "// changed after review\n");
    f.commit("test(SCRUM-866): changed source");
    const result = f.check();
    assert.equal(result.status, 10, result.output);
    assert.ok(result.output.includes(file), result.output);
  });
}

for (const variant of ["wrong", "missing", "malformed", "duplicate"]) {
  test(`blob evidence refuses ${variant} records without falling back to an older commit`, (t) => {
    const f = fixture(t);
    const records = [[client, f.blob(client)], [backend, f.blob(backend)]];
    if (variant === "wrong") records[1][1] = "0".repeat(40);
    if (variant === "missing") records.pop();
    if (variant === "malformed") records[1][1] += "z";
    if (variant === "duplicate") records.push(records[0]);
    f.save(`SCRUM-866 review of PR #1 head ${f.base}; ${f.reference(records)}`);
    f.commit("test(SCRUM-866): invalid blob renewal");
    const result = f.check();
    assert.equal(result.status, 10, result.output);
  });
}

test("PR mode refuses changed commit evidence outside the PR base with blob guidance", (t) => {
  const f = fixture(t);
  f.write(client, "export const payload = 2;\n");
  const head = f.commit("test(SCRUM-866): PR change");
  f.save(`SCRUM-866 review of PR #1 head ${head}; reviewed ${client}`);
  f.commit("test(SCRUM-866): commit renewal");
  assert.equal(f.check().status, 0, "legacy HEAD ancestry still accepts PR commits outside PR mode");
  const result = f.check(["--pr-base", f.base]);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /use.*blob/i);
});

test("PR mode compares renewal text with the PR base, leaving unchanged legacy references alone", (t) => {
  const f = fixture(t);
  f.save(`SCRUM-866 review of PR #1 head ${f.base}`);
  const prBase = f.commit("test(SCRUM-866): existing renewal");
  const result = f.check(["--pr-base", prBase]);
  assert.equal(result.status, 0, result.output);
});

test("legacy commit evidence still refuses non-ancestor revisions", (t) => {
  const f = fixture(t);
  f.run("switch", "-q", "-c", "unmerged");
  f.write(client, "export const payload = 3;\n");
  const unmerged = f.commit("test(SCRUM-866): unmerged source");
  f.run("switch", "-q", "main");
  f.save(`SCRUM-866 review of PR #1 head ${unmerged}`);
  f.commit("test(SCRUM-866): non-ancestor renewal");
  const result = f.check();
  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /HISTORY_ANCESTRY_REFUSED/);
});

test("writer mechanically emits blobs for client and resolved declaration after verifying files", (t) => {
  const f = fixture(t);
  const lines = [];
  const status = main(["--reviewed", f.base, "--expires", "2026-12-01", "--renewal", "Reviewed fixture", "--blob-evidence", "--write"],
    { log: (s) => lines.push(s), error: (s) => lines.push(s) }, f.root);
  assert.equal(status, 0, lines.join("\n"));
  const renewed = JSON.parse(fs.readFileSync(path.join(f.root, baseline), "utf8")).entries[0];
  assert.equal(renewed.renewal, f.reference().replace("reviewed fixture", "Reviewed fixture"));
  f.commit("test(SCRUM-866): generated renewal");
  const result = f.check(["--pr-base", f.base]);
  assert.equal(result.status, 0, result.output);
});
