/**
 * CI entry for the `skill-evidence` check. Env: GH_TOKEN, REPO (owner/name),
 * PR_NUMBER. Reads the PR body and files live through the REST API (the event
 * payload goes stale on re-runs). Runs from the base branch only. Uses fetch,
 * not a CLI, so no executable is resolved through PATH.
 */
import { fileURLToPath } from "node:url";
import { evaluate, TEMPLATE } from "./prSkillEvidence.mjs";

const API = "https://api.github.com";
const FORM_ONLY =
  "This check verifies form only and local-report consistency, not model execution or authorship. The seats' own signed PR comments are the authoritative evidence of review.";

const reportLine = (body, label) => {
  const matches = [...String(body).matchAll(new RegExp(`^${label}: ?(.+)$`, "gim"))];
  return matches.length === 1 ? matches[0][1].trim() : undefined;
};

async function verifyLocalReview({ url, session, sha }, { repo, pr, head, fetchImpl, token, carry }) {
  // Never fetch a caller-supplied URL: validate the same-PR reference, then use
  // a fixed GitHub API endpoint. PR text and report text are data, never code.
  const prefix = `https://github.com/${repo}/pull/${pr}#issuecomment-`;
  const id = url?.startsWith(prefix) ? url.slice(prefix.length) : "";
  if (!/^[1-9]\d*$/.test(id)) return ["Seat 1 review must link to an issue comment on this PR."];
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) return ["Local review must certify the full current PR head SHA."];
  const comment = await getJson(fetchImpl, token, `/repos/${repo}/issues/comments/${id}`);
  if (comment.html_url !== url || comment.issue_url !== `${API}/repos/${repo}/issues/${pr}`) {
    return ["Seat 1 review comment does not belong to this PR."];
  }
  if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.author_association)) {
    return ["Local review must be published by a repository owner, member or collaborator."];
  }
  const body = comment.body;
  if (typeof body !== "string" || body.includes("<!--")) {
    return ["Local Claude report fields must be visible, not inside HTML comments."];
  }
  const valid = reportLine(body, "Local Claude session")?.toLowerCase() === session &&
    reportLine(body, "Local Claude model") === "claude-opus-5-5" &&
    reportLine(body, "Local Claude effort") === "high" &&
    reportLine(body, "Local Claude SHA")?.toLowerCase() === sha &&
    reportLine(body, "Local Claude verdict") === "CERTIFY" &&
    reportLine(body, "Signed")?.length >= 5;
  if (!valid) return ["Local Claude signed report must match the session, Opus 5.5 high, reviewed SHA and CERTIFY verdict."];
  if (sha === head.toLowerCase()) return [];
  try {
    await carry(sha);
    return [];
  } catch (error) {
    return [`Local review must certify the full current PR head SHA. Carry refused: ${error.message}`];
  }
}

const fullSha = (sha) => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha);
const requireProof = (condition, message) => { if (!condition) throw new Error(message); };

// Compare responses expose at most 300 files, on page 1 only. A saturated
// response cannot prove completeness. Commit pagination is separate from files.
async function compare(read, base, head, page = 1) {
  const result = await read(`/compare/${base}...${head}?per_page=100&page=${page}`);
  requireProof(result?.base_commit?.sha === base && fullSha(result?.merge_base_commit?.sha) &&
    ["ahead", "behind", "diverged", "identical"].includes(result?.status) &&
    Number.isSafeInteger(result?.total_commits) && result.total_commits >= 0 &&
    Array.isArray(result.commits) && result.commits.every((c) => fullSha(c?.sha)) &&
    result.commits.length === Math.min(100, Math.max(0, result.total_commits - (page - 1) * 100)),
  "Unexpected compare response; ancestry is unavailable.");
  return result;
}

function completeFiles(rows) {
  requireProof(Array.isArray(rows) && rows.length < 300, "Compare file list is missing or at the 300-file limit.");
  const names = new Set();
  for (const f of rows) {
    requireProof(typeof f?.filename === "string" && f.filename.length > 0 && !names.has(f.filename) &&
      ["added", "removed", "modified", "renamed", "copied", "changed"].includes(f.status) &&
      (f.status !== "renamed" || typeof f.previous_filename === "string"), "Unexpected file set or status.");
    names.add(f.filename);
  }
  return rows;
}

// Check each hunk and the API's aggregate counts before ignoring positions.
// This rejects a patch cut mid-hunk or between hunks, including missing binaries.
function contributedLines(file) {
  requireProof(typeof file.patch === "string" && file.patch.length > 0, `Missing patch for ${file.filename}.`);
  const lines = file.patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const contribution = [];
  let oldLeft = 0, newLeft = 0, hunks = 0, added = 0, removed = 0;
  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@.*$/);
    if (hunk) {
      requireProof(oldLeft === 0 && newLeft === 0, `Truncated patch for ${file.filename}.`);
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      hunks++;
    } else if (hunks && line === "\\ No newline at end of file") {
      contribution.push(line);
    } else if (hunks && line.startsWith("+")) {
      newLeft--; added++; contribution.push(line);
    } else if (hunks && line.startsWith("-")) {
      oldLeft--; removed++; contribution.push(line);
    } else if (hunks && line.startsWith(" ")) {
      oldLeft--; newLeft--;
    } else {
      throw new Error(`Unexpected patch line for ${file.filename}.`);
    }
    requireProof(oldLeft >= 0 && newLeft >= 0, `Invalid patch counts for ${file.filename}.`);
  }
  requireProof(hunks > 0 && oldLeft === 0 && newLeft === 0 && added === file.additions &&
    removed === file.deletions && file.changes === added + removed,
  `Truncated or inconsistent patch for ${file.filename}.`);
  return JSON.stringify(contribution);
}

async function readTree(read, sha) {
  const commit = await read(`/git/commits/${sha}`);
  requireProof(commit?.sha === sha && fullSha(commit?.tree?.sha), "Commit tree identity is unavailable.");
  const tree = await read(`/git/trees/${commit.tree.sha}?recursive=1`);
  requireProof(tree?.sha === commit.tree.sha && tree.truncated === false && Array.isArray(tree.tree),
    "Git tree is missing or truncated; file modes are unavailable.");
  const entries = new Map();
  for (const entry of tree.tree) {
    requireProof(typeof entry?.path === "string" && !entries.has(entry.path) && fullSha(entry.sha) &&
      ["100644", "100755", "040000", "160000", "120000"].includes(entry.mode) &&
      ["blob", "tree", "commit"].includes(entry.type), "Unexpected Git tree entry.");
    entries.set(entry.path, entry);
  }
  return entries;
}

const filePaths = (files) => new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

function proveCompleteDiff(files, baseTree, headTree) {
  const changed = new Set([...baseTree.keys(), ...headTree.keys()].filter((path) => {
    const before = baseTree.get(path), after = headTree.get(path);
    if (before?.type === "tree" || after?.type === "tree") return false;
    return before?.sha !== after?.sha || before?.mode !== after?.mode || before?.type !== after?.type;
  }));
  requireProof(sameSet(changed, filePaths(files)), "Compare file set is not complete against Git trees.");
}

async function proveUpdateMerges(read, certified, head, main, own) {
  const updates = [];
  let sha = head;
  // Only the PR's first-parent path is its own work. Imported main commits
  // naturally include ordinary commits; every imported parent must be on main.
  for (let step = 0; step < 250 && sha !== certified; step++) {
    requireProof(own.has(sha) && !updates.includes(sha), "Update commit is not in this PR's complete commit list.");
    const commit = await read(`/git/commits/${sha}`);
    requireProof(commit?.sha === sha && Array.isArray(commit.parents) && commit.parents.length >= 2 &&
      commit.parents.every((p) => fullSha(p?.sha)), `Commit ${sha} is not an update-from-main merge commit.`);
    for (const parent of commit.parents.slice(1)) {
      const ancestry = await compare(read, parent.sha, main);
      requireProof(ancestry.merge_base_commit.sha === parent.sha && ["ahead", "identical"].includes(ancestry.status),
        `Merge parent ${parent.sha} is not reachable from main.`);
    }
    updates.push(sha);
    sha = commit.parents[0].sha;
  }
  requireProof(sha === certified, "Certified commit is not on the bounded first-parent update path.");
  return updates.reverse();
}

async function proveDisjoint(read, oldBase, newBase, paths) {
  if (oldBase === newBase) return 0;
  const delta = await compare(read, oldBase, newBase);
  requireProof(delta.merge_base_commit.sha === oldBase && delta.status === "ahead", "Main merge bases do not advance along main.");
  const rows = completeFiles(delta.files);
  rows.forEach(contributedLines);
  requireProof(delta.total_commits > 0 && delta.total_commits < 250, "Main commit list is unavailable at the 250-commit limit.");
  const commits = [...delta.commits];
  for (let page = 2; page <= Math.ceil(delta.total_commits / 100); page++) {
    const next = await compare(read, oldBase, newBase, page);
    requireProof(next.total_commits === delta.total_commits && next.merge_base_commit.sha === oldBase,
      "Main compare pagination is inconsistent.");
    commits.push(...next.commits);
  }
  requireProof(commits.length === delta.total_commits && commits.at(-1)?.sha === newBase &&
    new Set(commits.map((c) => c.sha)).size === commits.length,
    "Main commit list is incomplete.");
  const touched = filePaths(rows);
  // Net compare files alone miss a file touched and then reverted on main.
  for (const commit of commits) {
    const detail = await read(`/commits/${commit.sha}?per_page=100&page=1`);
    requireProof(detail?.sha === commit.sha && Array.isArray(detail.files) && detail.files.length < 100,
      "Main commit file pagination is incomplete or unavailable.");
    const changed = completeFiles(detail.files);
    changed.forEach(contributedLines);
    for (const path of filePaths(changed)) touched.add(path);
  }
  requireProof(![...touched].some((path) => paths.has(path)), "Main/PR disjointness failed: main touched a PR file.");
  return touched.size;
}

async function carryCertificate(certified, { pr, commits, fileRows, read, repo, prNumber }) {
  requireProof(commits.some((c) => c.sha === certified), "Certified SHA must be a commit of this PR.");
  requireProof(Number.isSafeInteger(pr.commits) && pr.commits < 250 && pr.commits === commits.length &&
    new Set(commits.map((c) => c.sha)).size === commits.length && commits.every((c) => fullSha(c.sha)),
  "PR commit list is incomplete or at the 250-commit limit.");
  requireProof(pr.base?.ref === "main" && pr.base?.repo?.full_name === repo && fullSha(pr.base?.sha) && fullSha(pr.head?.sha),
    "Main/base identity is unavailable.");
  const main = pr.base.sha, head = pr.head.sha;
  const updates = await proveUpdateMerges(read, certified, head, main, new Set(commits.map((c) => c.sha)));
  const before = await compare(read, main, certified);
  const after = await compare(read, main, head);
  const oldFiles = completeFiles(before.files), newFiles = completeFiles(after.files);
  requireProof(sameSet(new Set(oldFiles.map((f) => f.filename)), new Set(newFiles.map((f) => f.filename))),
    "PR file set changed after certification.");
  const oldByName = new Map(oldFiles.map((f) => [f.filename, f]));
  for (const file of newFiles) {
    const prior = oldByName.get(file.filename);
    requireProof(prior.status === file.status && prior.previous_filename === file.previous_filename,
      `PR file status or rename changed for ${file.filename}.`);
    requireProof(contributedLines(prior) === contributedLines(file), `PR contributed lines changed for ${file.filename}.`);
  }
  requireProof(pr.changed_files === newFiles.length && sameSet(filePaths(newFiles), filePaths(fileRows)),
    "Current PR file set is incomplete or changed during the check.");
  const trees = [];
  for (const sha of [before.merge_base_commit.sha, certified, after.merge_base_commit.sha, head]) trees.push(await readTree(read, sha));
  proveCompleteDiff(oldFiles, trees[0], trees[1]);
  proveCompleteDiff(newFiles, trees[2], trees[3]);
  for (const file of newFiles) {
    const path = file.previous_filename ?? file.filename;
    requireProof(trees[0].get(path)?.mode === trees[2].get(path)?.mode &&
      trees[1].get(file.filename)?.mode === trees[3].get(file.filename)?.mode, `PR file mode changed for ${file.filename}.`);
  }
  const mainFiles = await proveDisjoint(read, before.merge_base_commit.sha, after.merge_base_commit.sha, filePaths(newFiles));
  const current = await read(`/pulls/${prNumber}`);
  requireProof(current?.head?.sha === head && current?.base?.sha === main && current.body === pr.body,
    "PR head, main or evidence body changed during the carry proof.");
  return [`Seat 1 local certificate carried from ${certified} to ${head}.`,
    `Proof: update-from-main merge commits ${updates.join(", ")}; ${newFiles.length} files with identical statuses, modes and contributed lines.`,
    `Proof: disjointness verified across merge bases ${before.merge_base_commit.sha} to ${after.merge_base_commit.sha}; ${mainFiles} main files checked.`,
    "Required CI must still pass at the current head; this check does not evaluate other checks."];
}

// Every request path is built from GitHub API data (SHAs, PR numbers, repo name). Refuse anything that is not a
// plain absolute path of unreserved characters, so a crafted value cannot reach another endpoint (OWASP SSRF and
// path traversal; Sonar S7044/S8476).
const SAFE_API_PATH = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*(?:\?[A-Za-z0-9._~=&-]*)?$/;

export async function getJson(fetchImpl, token, path) {
  const segments = path.split("?")[0].split("/");
  if (!SAFE_API_PATH.test(path) || segments.some((s) => s === "." || s === ".."))
    throw new Error("Unsafe GitHub API path refused.");
  const res = await fetchImpl(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "skill-evidence" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

async function getPages(fetchImpl, token, path) {
  const all = [];
  // GitHub lists at most 3000 entries. Reading page 31 distinguishes exactly
  // 3000 (page 31 is empty) from more than 3000 (page 31 has rows).
  for (let page = 1; page <= 31; page++) {
    const rows = await getJson(fetchImpl, token, `${path}?per_page=100&page=${page}`);
    requireProof(Array.isArray(rows) && rows.length <= 100, `Unexpected paginated response for ${path}.`);
    if (page === 31 && rows.length > 0) break;
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error(`${path} has more than 3000 entries; the check cannot read them all`);
}

/** Returns {exitCode, lines}. All I/O goes through the injected fetch. */
export async function check({ REPO, PR_NUMBER, GH_TOKEN }, fetchImpl = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO ?? "") || !/^\d+$/.test(PR_NUMBER ?? "") || !GH_TOKEN) {
    throw new Error("REPO, PR_NUMBER and GH_TOKEN are required");
  }
  const base = `/repos/${REPO}/pulls/${PR_NUMBER}`;
  const pr = await getJson(fetchImpl, GH_TOKEN, base);
  const fileRows = await getPages(fetchImpl, GH_TOKEN, `${base}/files`);
  const files = fileRows.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  // The PR's own range: head plus every commit GitHub lists for the PR.
  // A main commit from before the PR is not accepted as a certified SHA.
  const commits = await getPages(fetchImpl, GH_TOKEN, `${base}/commits`);
  const carryLines = [];
  const own = commits.map((c) => c.sha);
  const commitText = commits.map((c) => c.commit?.message ?? "").join("\n");
  own.push(pr.head.sha);
  const isPrCommit = async (sha) => own.some((c) => c.startsWith(sha.toLowerCase()));
  const result = await evaluate({ body: pr.body ?? "", files, isPrCommit, commitText,
    localReview: (evidence) => verifyLocalReview(evidence, {
      repo: REPO, pr: PR_NUMBER, head: pr.head.sha, fetchImpl, token: GH_TOKEN,
      carry: async (sha) => carryLines.push(...await carryCertificate(sha, { pr, commits, fileRows,
        repo: REPO, prNumber: PR_NUMBER,
        read: (path) => getJson(fetchImpl, GH_TOKEN, `/repos/${REPO}${path}`) })),
    }),
  });
  if (!result.required) {
    return { exitCode: 0, headSha: pr.head.sha, lines: ["skill-evidence: no money, permission or gate paths touched; not required."] };
  }
  if (result.ok) return { exitCode: 0, headSha: pr.head.sha, lines: ["skill-evidence: section present and consistent.", ...carryLines, FORM_ONLY] };
  return {
    exitCode: 1,
    headSha: pr.head.sha,
    lines: [
      "skill-evidence: FAILED",
      ...result.problems.map((p) => `- ${p}`),
      "",
      FORM_ONLY,
      "",
      `Add this to the PR body and fill it in:\n\n${TEMPLATE}`,
    ],
  };
}

/** One printed line: control characters (CR, LF, ESC and the rest) become spaces so PR data cannot forge log lines (Sonar S5145). */
export function safeLogLine(line) {
  return String(line).replace(/[\u0000-\u001f\u007f]/g, " ");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { exitCode, lines } = await check(process.env);
    (exitCode ? console.error : console.log)(lines.map(safeLogLine).join("\n"));
    process.exitCode = exitCode;
  } catch (e) {
    console.error(safeLogLine(e.message));
    process.exitCode = 1;
  }
}
