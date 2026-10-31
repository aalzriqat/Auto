/**
 * SCRUM-873: why the baseline is sharded, shown against the real certificate-carry check.
 *
 * The carry (scripts/skillEnforcement/checkPrSkillEvidence.mjs, `proveDisjoint`) refuses to carry a Seat 1 certificate
 * across an update-from-main when main touched ANY file the PR touched. With one baseline file, every PR that edits
 * the baseline overlaps every other PR that edits it, so the carry refused whenever main moved the baseline. With one
 * shard per client file, two PRs overlap only when they change the same client file's entries.
 *
 * This test drives the unmodified `check` with a mocked GitHub API. It does not edit or weaken the carry rule: it
 * reuses the exact response shapes certificateCarry.test.ts (SCRUM-874) builds, and changes only which paths the PR and
 * main touched.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BASELINE_DIRECTORY, LEGACY_BASELINE_FILE, shardNameFor } from "./baselineShards.mjs";

// A non-literal specifier keeps this import out of `pnpm typecheck:contract-skew`, which does not (and must not have
// to) type-check the skill-enforcement gate.
const gateUrl = new URL("../skillEnforcement/checkPrSkillEvidence.mjs", import.meta.url).href;
const { check } = /** @type {{ check: (env: Record<string, string>, fetchImpl: typeof fetch) => Promise<{ exitCode: number, lines: string[] }> }} */ (
  await import(gateUrl)
);

const env = { REPO: "o/r", PR_NUMBER: "7", GH_TOKEN: "test" };
const oldBase = "1".repeat(40);
const main = "2".repeat(40);
const certified = "3".repeat(40);
const head = "4".repeat(40);
const session = "df7e4a61-cb22-4774-9ed8-3c191d397ed2";
const source = "scripts/skillEnforcement/checkPrSkillEvidence.mjs";
const testFile = "scripts/skillEnforcement/certificateCarry.test.ts";
const reviewUrl = "https://github.com/o/r/pull/7#issuecomment-123";

const clientA = "app/(dashboard)/[org_id]/payroll/page.tsx";
const clientB = "app/(dashboard)/[org_id]/expenses/page.tsx";
const shardPath = (/** @type {string} */ clientFile) => `${BASELINE_DIRECTORY}/${shardNameFor(clientFile)}`;

/** @param {string} filename */
const file = (filename) => ({
  filename, status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-before\n+after",
});

const body = `## Skill evidence
- Skills run: tdd, blast-radius, two-axis-review, engineering-principles, technical-writing, unslop
- Red run:
\`\`\`
FAIL ${testFile}: 1 failed
\`\`\`
- /simplify output:
\`\`\`
Reviewed the change for reuse and simplification; no changes needed.
\`\`\`
- Seat 1 session: local:${session}
- Implementer session: 01a15fef-a4fe-79e2-a9a5-d91bff56cd10
- Seat 1 review: ${reviewUrl}
- Seat 1 model: claude-opus-5-5
- Seat 1 SHA: ${certified}
- Seat 2 model: gpt-6.1-sol
- Seat 2 effort: medium
- Seat 2 SHA: ${certified}
`;
const report = `Local Claude session: ${session}
Local Claude model: claude-opus-5-5
Local Claude effort: high
Local Claude SHA: ${certified}
Local Claude verdict: CERTIFY
Signed: Claude Seat 1
`;

/**
 * @param {string} base
 * @param {string} tip
 * @param {ReturnType<typeof file>[]} changed
 */
const comparison = (base, tip, changed) => ({
  base_commit: { sha: base }, merge_base_commit: { sha: base },
  status: base === tip ? "identical" : "ahead", total_commits: base === tip ? 0 : 1,
  commits: base === tip ? [] : [{ sha: tip }], files: changed,
});

/**
 * One PR (a gate file, its test, and `prTouches`) that was certified at C, then updated from a main that moved by one
 * commit touching `mainTouches`. The trees give each path the blob a real merge would: a path only main changed
 * differs at main and head, a path only the PR changed differs at C and head, and a path both changed has no
 * single clean merge result.
 *
 * @param {{ prTouches: string[], mainTouches: string[] }} scenario
 */
function carryRun({ prTouches, mainTouches }) {
  const prFiles = [source, testFile, ...prTouches];
  const routes = new Map();
  routes.set("/pulls/7", {
    body, head: { sha: head }, base: { sha: main, ref: "main", repo: { full_name: "o/r" } },
    commits: 2, changed_files: prFiles.length,
  });
  routes.set("/pulls/7/files?per_page=100&page=1", prFiles.map(file));
  routes.set("/pulls/7/commits?per_page=100&page=1", [{ sha: certified }, { sha: head }]);
  routes.set("/issues/comments/123", {
    html_url: reviewUrl, issue_url: "https://api.github.com/repos/o/r/issues/7", author_association: "OWNER", body: report,
  });
  routes.set(`/compare/${main}...${certified}?per_page=100&page=1`, {
    ...comparison(main, certified, prFiles.map(file)), status: "diverged", merge_base_commit: { sha: oldBase },
  });
  routes.set(`/compare/${main}...${head}?per_page=100&page=1`, comparison(main, head, prFiles.map(file)));
  routes.set(`/compare/${main}...${main}?per_page=100&page=1`, comparison(main, main, []));
  routes.set(`/compare/${oldBase}...${main}?per_page=100&page=1`, comparison(oldBase, main, mainTouches.map(file)));
  routes.set(`/commits/${main}?per_page=100&page=1`, { sha: main, files: mainTouches.map(file) });
  routes.set(`/git/commits/${head}`, { sha: head, tree: { sha: head }, parents: [{ sha: certified }, { sha: main }] });
  for (const sha of [oldBase, main, certified]) {
    routes.set(`/git/commits/${sha}`, { sha, tree: { sha }, parents: [{ sha: oldBase }] });
  }
  const paths = [...new Set([...prFiles, ...mainTouches])];
  /** @param {string} path @param {string} at */
  const blobAt = (path, at) => {
    const prChanged = prFiles.includes(path), mainChanged = mainTouches.includes(path);
    if (prChanged && mainChanged) return at === oldBase ? oldBase : at === main ? main : at === certified ? certified : "5".repeat(40);
    if (prChanged) return at === certified || at === head ? certified : oldBase;
    if (mainChanged) return at === main || at === head ? main : oldBase;
    return oldBase;
  };
  for (const at of [oldBase, main, certified, head]) {
    routes.set(`/git/trees/${at}?recursive=1`, {
      sha: at, truncated: false, tree: paths.map((path) => ({ path, mode: "100644", type: "blob", sha: blobAt(path, at) })),
    });
  }
  const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {unknown} */ url) => {
    const path = String(url).replace("https://api.github.com/repos/o/r", "");
    if (!routes.has(path)) throw new Error(`Unexpected API request ${path}`);
    return { ok: true, status: 200, json: async () => routes.get(path) };
  }));
  return check(env, fetchImpl);
}

test("two different client files have two different shard paths", () => {
  assert.notEqual(shardPath(clientA), shardPath(clientB));
  assert.ok(shardPath(clientA).startsWith(`${BASELINE_DIRECTORY}/`));
});

test("sharded: a PR that changes one client file's shard still carries when main changed another client file's shard", async () => {
  const result = await carryRun({ prTouches: [shardPath(clientA)], mainTouches: [shardPath(clientB)] });
  const output = result.lines.join("\n");
  assert.equal(result.exitCode, 0, output);
  assert.match(output, new RegExp(`carried from ${certified} to ${head}`));
});

test("sharded: the carry refuses when main changed the SAME client file's shard", async () => {
  const result = await carryRun({ prTouches: [shardPath(clientA)], mainTouches: [shardPath(clientA)] });
  const output = result.lines.join("\n");
  assert.equal(result.exitCode, 1, output);
  assert.doesNotMatch(output, /carried from/);
  assert.match(output, /base blob changed|disjointness/);
});

test("single file (the layout this change removes): the carry refuses even though main changed other entries", async () => {
  // Main edited a different client file's entries, but both PRs live in one JSON file, so the file overlaps.
  const result = await carryRun({ prTouches: [LEGACY_BASELINE_FILE], mainTouches: [LEGACY_BASELINE_FILE] });
  const output = result.lines.join("\n");
  assert.equal(result.exitCode, 1, output);
  assert.doesNotMatch(output, /carried from/);
});

test("a PR that moves entries between two client files touches exactly those two shards, so an unrelated main change carries", async () => {
  // A relocation is an in-place edit of both shards (not a file rename), which the carry treats as ordinary edits.
  const result = await carryRun({
    prTouches: [shardPath(clientA), shardPath("app/(dashboard)/[org_id]/approvals/page.tsx")],
    mainTouches: [shardPath(clientB)],
  });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
});
