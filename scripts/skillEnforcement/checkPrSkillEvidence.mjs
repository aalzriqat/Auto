/**
 * CI entry for the `skill-evidence` check. Env: GH_TOKEN, REPO (owner/name),
 * PR_NUMBER. Reads the PR body and files live through the REST API (the event
 * payload goes stale on re-runs). Runs from the base branch only. Uses fetch,
 * not a CLI, so no executable is resolved through PATH.
 */
import { fileURLToPath } from "node:url";
import { evaluate, TEMPLATE } from "./prSkillEvidence.mjs";

const API = "https://api.github.com";

async function getJson(fetchImpl, token, path) {
  const res = await fetchImpl(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "skill-evidence" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

async function getPages(fetchImpl, token, path) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const rows = await getJson(fetchImpl, token, `${path}?per_page=100&page=${page}`);
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
  const result = await evaluate({ body: pr.body ?? "", files, isPrCommit, commitText });
  if (!result.required) {
    return { exitCode: 0, lines: ["skill-evidence: no money, permission or gate paths touched; not required."] };
  }
  if (result.ok) return { exitCode: 0, lines: ["skill-evidence: section present and consistent."] };
  return {
    exitCode: 1,
    lines: [
      "skill-evidence: FAILED",
      ...result.problems.map((p) => `- ${p}`),
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
