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

async function verifyLocalReview({ url, session, sha }, { repo, pr, head, fetchImpl, token }) {
  // Never fetch a caller-supplied URL: validate the same-PR reference, then use
  // a fixed GitHub API endpoint. PR text and report text are data, never code.
  const prefix = `https://github.com/${repo}/pull/${pr}#issuecomment-`;
  const id = url?.startsWith(prefix) ? url.slice(prefix.length) : "";
  if (!/^[1-9]\d*$/.test(id)) return ["Seat 1 review must link to an issue comment on this PR."];
  if (sha !== head.toLowerCase()) return ["Local review must certify the full current PR head SHA."];
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
  return valid ? [] : ["Local Claude signed report must match the session, Opus 5.5 high, current head SHA and CERTIFY verdict."];
}

export async function getJson(fetchImpl, token, path) {
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
  const own = commits.map((c) => c.sha);
  const commitText = commits.map((c) => c.commit?.message ?? "").join("\n");
  own.push(pr.head.sha);
  const isPrCommit = async (sha) => own.some((c) => c.startsWith(sha.toLowerCase()));
  const result = await evaluate({ body: pr.body ?? "", files, isPrCommit, commitText,
    localReview: (evidence) => verifyLocalReview(evidence, {
      repo: REPO, pr: PR_NUMBER, head: pr.head.sha, fetchImpl, token: GH_TOKEN,
    }),
  });
  if (!result.required) {
    return { exitCode: 0, headSha: pr.head.sha, lines: ["skill-evidence: no money, permission or gate paths touched; not required."] };
  }
  if (result.ok) return { exitCode: 0, headSha: pr.head.sha, lines: ["skill-evidence: section present and consistent.", FORM_ONLY] };
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { exitCode, lines } = await check(process.env);
    (exitCode ? console.error : console.log)(lines.join("\n"));
    process.exitCode = exitCode;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
