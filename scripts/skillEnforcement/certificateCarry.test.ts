import { describe, expect, test } from "vitest";
import { check } from "./checkPrSkillEvidence.mjs";
import { refresh } from "./refreshPrSkillEvidence.mjs";

const env = { REPO: "o/r", PR_NUMBER: "7", GH_TOKEN: "test" };
const oldBase = "1".repeat(40), main = "2".repeat(40), certified = "3".repeat(40), head = "4".repeat(40);
const foreign = "5".repeat(40);
const session = "df7e4a61-cb22-4774-9ed8-3c191d397ed2";
const source = "scripts/skillEnforcement/checkPrSkillEvidence.mjs";
const testFile = "scripts/skillEnforcement/certificateCarry.test.ts";
const reviewUrl = "https://github.com/o/r/pull/7#issuecomment-123";
const file = (filename: string) => ({ filename, status: "modified", additions: 1, deletions: 1, changes: 2,
  patch: "@@ -1 +1 @@\n-before\n+after" });
const files = () => [file(source), file(testFile)];
const body = (sha = certified) => `## Skill evidence
- Skills run: tdd, blast-radius, two-axis-review, engineering-principles, technical-writing, unslop
- Red run:
\`\`\`
FAIL ${testFile}: 1 failed
\`\`\`
- /simplify output:
\`\`\`
Reviewed the gate for reuse and simplification; no changes needed.
\`\`\`
- Seat 1 session: local:${session}
- Implementer session: 01a15fef-a4fe-79e2-a9a5-d91bff56cd10
- Seat 1 review: ${reviewUrl}
- Seat 1 model: claude-opus-5-5
- Seat 1 SHA: ${sha}
- Seat 2 model: gpt-6.1-sol
- Seat 2 effort: medium
- Seat 2 SHA: ${certified}
`;
const report = (sha = certified) => `Local Claude session: ${session}
Local Claude model: claude-opus-5-5
Local Claude effort: high
Local Claude SHA: ${sha}
Local Claude verdict: CERTIFY
Signed: Claude Seat 1
`;
const comparison = (base: string, tip: string, changed = files()) => ({
  base_commit: { sha: base }, merge_base_commit: { sha: base },
  status: base === tip ? "identical" : "ahead", total_commits: base === tip ? 0 : 1,
  commits: base === tip ? [] : [{ sha: tip }], files: changed,
});

function fixture(exactHead = false) {
  const routes = new Map<string, unknown>();
  const pr = { body: body(exactHead ? head : certified), head: { sha: head },
    base: { sha: main, ref: "main", repo: { full_name: "o/r" } }, commits: 2, changed_files: 2 };
  routes.set("/pulls/7", pr);
  routes.set("/pulls/7/files?per_page=100&page=1", files());
  routes.set("/pulls/7/commits?per_page=100&page=1", [{ sha: certified }, { sha: head }]);
  const comment = { html_url: reviewUrl, issue_url: "https://api.github.com/repos/o/r/issues/7",
    author_association: "OWNER", body: report(exactHead ? head : certified) };
  routes.set("/issues/comments/123", comment);
  const before = { ...comparison(main, certified), status: "diverged", merge_base_commit: { sha: oldBase } };
  const after = comparison(main, head);
  const delta = comparison(oldBase, main, [file("other.txt")]);
  routes.set(`/compare/${main}...${certified}?per_page=100&page=1`, before);
  routes.set(`/compare/${main}...${head}?per_page=100&page=1`, after);
  routes.set(`/compare/${main}...${main}?per_page=100&page=1`, comparison(main, main, []));
  routes.set(`/compare/${oldBase}...${main}?per_page=100&page=1`, delta);
  const merge = { sha: head, tree: { sha: head }, parents: [{ sha: certified }, { sha: main }] };
  routes.set(`/git/commits/${head}`, merge);
  for (const sha of [oldBase, main, certified]) {
    routes.set(`/git/commits/${sha}`, { sha, tree: { sha }, parents: [{ sha: oldBase }] });
  }
  const trees = new Map<string, { sha: string; truncated: boolean; tree: Array<{ path: string; mode: string; type: string; sha: string }> }>();
  for (const sha of [oldBase, main, certified, head]) {
    const tree = { sha, truncated: false, tree: [source, testFile, "other.txt"].map((path) => ({
      path, mode: "100644", type: "blob", sha: path === "other.txt" ? ([oldBase, certified].includes(sha) ? oldBase : main) :
        ([head, certified].includes(sha) ? certified : oldBase),
    })) };
    trees.set(sha, tree);
    routes.set(`/git/trees/${sha}?recursive=1`, tree);
  }
  const mainCommit = { sha: main, files: [file("other.txt")] };
  routes.set(`/commits/${main}?per_page=100&page=1`, mainCommit);
  const errors = new Map<string, number>();
  const fetchImpl = (async (url: string) => {
    const path = String(url).replace("https://api.github.com/repos/o/r", "");
    if (errors.has(path)) return { ok: false, status: errors.get(path) } as Response;
    if (!routes.has(path)) throw new Error(`Unexpected API request ${path}`);
    return { ok: true, status: 200, json: async () => routes.get(path) } as Response;
  }) as typeof fetch;
  return { routes, errors, pr, comment, before, after, delta, merge, trees, mainCommit,
    run: () => check(env, fetchImpl) };
}

describe("certificate carry across update-from-main (SCRUM-874)", () => {
  test("a clean merge carries the original report and states the proof without certifying H", async () => {
    const f = fixture();
    f.after.files[0].patch = "@@ -80 +80 @@\n-before\n+after";
    const result = await f.run();
    expect(result.lines.join("\n")).toContain(`carried from ${certified} to ${head}`);
    expect(result.exitCode).toBe(0);
    const output = result.lines.join("\n");
    expect(output).toContain(`carried from ${certified} to ${head}`);
    expect(output).toContain(`merge commits ${head}`);
    expect(output).toMatch(/2 files/);
    expect(output).toMatch(/disjoint/i);
    expect(output).not.toMatch(new RegExp(`certif(?:ied|ication) at ${head}`, "i"));
    expect(output).toContain("CI");
  });

  const refusals: Array<[string, (f: ReturnType<typeof fixture>) => void, RegExp]> = [
    ["ordinary commit after C", (f) => { f.merge.parents = [{ sha: certified }]; }, /merge commit/],
    ["added parent outside main", (f) => {
      f.merge.parents[1].sha = foreign;
      f.routes.set(`/compare/${foreign}...${main}?per_page=100&page=1`, {
        ...comparison(foreign, main, []), status: "diverged", merge_base_commit: { sha: oldBase },
      });
    }, /reachable from main/],
    ["conflict resolution changes contributed lines", (f) => { f.after.files[0].patch = "@@ -1 +1 @@\n-before\n+changed"; }, /contributed lines/],
    ["file added", (f) => { f.after.files.push(file("new.txt")); }, /file set/],
    ["file removed", (f) => { f.after.files.pop(); }, /file set/],
    ["status changed", (f) => { f.after.files[0].status = "added"; }, /status/],
    ["mode changed", (f) => { f.trees.get(head)!.tree[0].mode = "100755"; }, /file mode changed/],
    ["main touched a PR file", (f) => { f.mainCommit.files = [file(source)]; }, /disjointness/],
    ["missing patch", (f) => { delete (f.after.files[0] as Partial<ReturnType<typeof file>>).patch; }, /patch/],
    ["truncated patch", (f) => { f.after.files[0].patch = "@@ -1,2 +1,2 @@\n-before\n+after"; }, /patch/],
    ["compare API file limit", (f) => { f.after.files = Array.from({ length: 300 }, (_, i) => file(`f${i}`)); }, /300/],
    ["incomplete PR commits", (f) => { f.pr.commits = 251; }, /commit list/],
    ["truncated tree", (f) => { f.trees.get(head)!.truncated = true; }, /tree/],
    ["compare omitted file", (f) => { f.before.files.pop(); f.after.files.pop(); }, /complete|file set/],
    ["invalid signed verdict", (f) => { f.comment.body = report().replace("CERTIFY", "BLOCK"); }, /CERTIFY/],
    ["C not a PR commit", (f) => { f.routes.set("/pulls/7/commits?per_page=100&page=1", [{ sha: head }, { sha: foreign }]); }, /commit of this PR/],
    ["compare API error", (f) => { f.errors.set(`/compare/${main}...${certified}?per_page=100&page=1`, 403); }, /403/],
    ["unexpected compare shape", (f) => { f.routes.set(`/compare/${main}...${certified}?per_page=100&page=1`, {}); }, /compare/],
    ["base outside main", (f) => { f.pr.base.ref = "other"; }, /Main\/base/],
    ["patch cut between hunks", (f) => { f.after.files[0].additions = 2; }, /patch/],
    ["whitespace changed", (f) => { f.after.files[0].patch = "@@ -1 +1 @@\n-before\n+after "; }, /contributed lines/],
    ["main commit file pagination", (f) => { f.mainCommit.files = Array.from({ length: 100 }, (_, i) => file(`f${i}`)); }, /pagination/],
    ["end-of-file newline changed", (f) => { f.after.files[0].patch += "\n\\ No newline at end of file"; }, /contributed lines/],
  ];
  test.each(refusals)("refuses %s and requires exact-head evidence", async (_name, change, reason) => {
    const f = fixture();
    change(f);
    const result = await f.run();
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(reason);
    expect(result.lines.join("\n")).not.toContain("carried from");
  });

  test("an exact-head local report retains today's behavior and leaves Seat 2 on an older PR commit", async () => {
    const result = await fixture(true).run();
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).not.toContain("carried from");
  });

  test("a second update merge carries across the entire first-parent path", async () => {
    const f = fixture();
    const middle = "6".repeat(40);
    f.pr.commits = 3;
    f.routes.set("/pulls/7/commits?per_page=100&page=1", [{ sha: certified }, { sha: middle }, { sha: head }]);
    f.merge.parents[0].sha = middle;
    f.routes.set(`/git/commits/${middle}`, { sha: middle, parents: [{ sha: certified }, { sha: main }] });
    const result = await f.run();
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain(`merge commits ${middle}, ${head}`);
    f.routes.set(`/git/commits/${middle}`, { sha: middle, parents: [{ sha: certified }] });
    expect((await f.run()).exitCode).toBe(1);
  });

  test("main commit pagination includes a reverted touch on a later page", async () => {
    const f = fixture();
    const mainShas = Array.from({ length: 101 }, (_, i) => (i + 100).toString(16).padStart(40, "0"));
    mainShas[100] = main;
    f.delta.total_commits = 101;
    f.delta.commits = mainShas.slice(0, 100).map((sha) => ({ sha }));
    f.routes.set(`/compare/${oldBase}...${main}?per_page=100&page=2`, {
      ...f.delta, files: undefined, commits: [{ sha: mainShas[100] }],
    });
    for (const sha of mainShas) f.routes.set(`/commits/${sha}?per_page=100&page=1`, { sha, files: [file("other.txt")] });
    expect((await f.run()).exitCode).toBe(0);
    f.routes.set(`/commits/${mainShas[100]}?per_page=100&page=1`, { sha: mainShas[100], files: [file(source)] });
    const result = await f.run();
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("disjointness failed");
  });

  test("PR commit pagination proves membership beyond the first page", async () => {
    const f = fixture();
    const commits = [...Array.from({ length: 99 }, (_, i) => ({ sha: (i + 100).toString(16).padStart(40, "0") })),
      { sha: certified }, { sha: head }];
    f.pr.commits = commits.length;
    f.routes.set("/pulls/7/commits?per_page=100&page=1", commits.slice(0, 100));
    f.routes.set("/pulls/7/commits?per_page=100&page=2", commits.slice(100));
    expect((await f.run()).exitCode).toBe(0);
    f.routes.set("/pulls/7/commits?per_page=100&page=2", []);
    const result = await f.run();
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("commit list is incomplete");
  });

  test("editing the carried report to BLOCK revokes the refresh result on H", async () => {
    const f = fixture();
    expect((await f.run()).exitCode).toBe(0);
    f.comment.body = report().replace("CERTIFY", "BLOCK");
    const writes: Array<Record<string, unknown>> = [];
    f.routes.set("/pulls/7", { ...f.pr, state: "open" });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method) {
        writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { ok: true, json: async () => ({ id: 100 }) } as Response;
      }
      const path = String(url).replace("https://api.github.com/repos/o/r", "");
      if (!f.routes.has(path)) throw new Error(`Unexpected API request ${path}`);
      return { ok: true, json: async () => f.routes.get(path) } as Response;
    }) as typeof fetch;
    expect(await refresh({ ...env, COMMENT_ID: "123" }, fetchImpl)).toEqual({ refreshed: true, head, conclusion: "failure" });
    expect(writes[0]).toMatchObject({ name: "skill-evidence", head_sha: head });
    expect(writes[1]).toMatchObject({ conclusion: "failure" });
  });
});
