import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveGit } from "./gitExecutable.mjs";
import { main } from "./renewBaselineReviewed.mjs";

// SCRUM-866 / #711: a PR-head review survives the synthetic merge ref, but a
// squash drops that ancestry. Exercise the author CLI against real Git history.
test("renewal evidence must survive a squash merge onto the PR base", async (t) => {
  const git = resolveGit();
  assert.ok(git, "real Git is required; unavailable infrastructure cannot pass");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-pr-base-"));
  t.after(() => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith("cs-pr-base-"));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const runGit = (...args) => execFileSync(git, [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 10_000 }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const baseline = "scripts/contractSkew/needs-evidence-baseline.json";
  const entry = {
    surface: "web", file: "app/page.tsx", callSiteId: "app/page.tsx:1:1",
    functionId: "vehicles:update", contractPath: "vehicleId", kind: "TYPE_UNKNOWN",
    cause: "reviewed cause", fingerprint: "reviewed fingerprint", multiplicity: 1,
    rationale: "Vehicle namespace remains unproved.", issue: "SCRUM-866", expires: "2026-11-01",
  };
  write("app/page.tsx", "export const vehicleId: unknown = 'vehicle';\n");
  write("convex/tsconfig.json", JSON.stringify({ compilerOptions: { types: [] } }));
  write("convex/vehicles.ts", "declare function mutation(options: unknown): unknown; export const update = mutation({});\n");
  write(baseline, JSON.stringify({ version: 1, entries: [entry] }, null, 2) + "\n");
  runGit("init", "-q");
  runGit("add", "--", "app", "convex", "scripts/contractSkew");
  runGit("commit", "-q", "-m", "main reviewed base");
  const base = runGit("rev-parse", "HEAD");
  write("pr-only.txt", "PR-only review revision\n");
  runGit("add", "--", "pr-only.txt");
  runGit("commit", "-q", "-m", "PR head excluded from squash ancestry");
  const prHead = runGit("rev-parse", "HEAD");
  const unrelated = runGit("commit-tree", "HEAD^{tree}", "-m", "unrelated root");
  const renew = (sha) => write(baseline, JSON.stringify({ version: 1, entries: [{
    ...entry, expires: "2026-12-01",
    renewal: `SCRUM-868 review of PR #711 head ${sha}: app/page.tsx and convex/vehicles.ts reviewed.`,
  }] }, null, 2) + "\n");
  const check = (...args) => {
    const lines = [];
    const status = main(["--reviewed", base, "--check-evidence", ...args], {
      log: (line) => lines.push(line), error: (line) => lines.push(line),
    }, root);
    return { status, output: lines.join("\n") };
  };

  await t.test("PR-only evidence passes today's HEAD check but must refuse the PR base", () => {
    renew(prHead);
    const current = check();
    assert.equal(current.status, 0, current.output);
    const before = fs.readFileSync(path.join(root, baseline), "utf8");
    const result = check("--pr-base", base);
    assert.equal(result.status, 3, result.output);
    assert.match(result.output, /PR_BASE_ANCESTRY_REFUSED/);
    assert.match(result.output, /cite a commit already on main/i);
    assert.match(result.output, /name the PR's own changed files/i);
    assert.equal(fs.readFileSync(path.join(root, baseline), "utf8"), before);
  });
  await t.test("evidence already on the PR base passes", () => {
    renew(base);
    const result = check("--pr-base", base);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /1 renewed entries checked, 0 unrenewed, 0 stale/);
  });
  for (const [name, revision, diagnostic] of [
    ["unrelated", unrelated, /HISTORY_ANCESTRY_REFUSED/],
    ["unavailable", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", /PR base revision .* unavailable/],
    ["empty", "", /PR base revision/],
  ]) {
    await t.test(`${name} PR base cannot certify evidence`, () => {
      renew(base);
      const result = check("--pr-base", revision);
      assert.equal(result.status, 3, result.output);
      assert.match(result.output, diagnostic);
      assert.doesNotMatch(result.output, /entries checked/);
    });
  }
});
