/** Re-evaluate referenced local reports and waivers after edits/deletion, using main's code. */
import { fileURLToPath } from "node:url";
import { check, getJson } from "./checkPrSkillEvidence.mjs";
import { localReviewUrl, referencedCommentUrls } from "./prSkillEvidence.mjs";

async function writeCheck(fetchImpl, token, repo, method, suffix, body) {
  const repositoryPath = repo.split("/").map(encodeURIComponent).join("/");
  const response = await fetchImpl(`https://api.github.com/repos/${repositoryPath}/check-runs${suffix}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub checks API ${response.status}`);
  return response.json();
}

export async function refresh({ REPO, PR_NUMBER, COMMENT_ID, GH_TOKEN }, fetchImpl = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO ?? "") || !/^\d+$/.test(PR_NUMBER ?? "") ||
      REPO.split("/").some((part) => part === "." || part === "..") ||
      !/^[1-9]\d*$/.test(COMMENT_ID ?? "") || !GH_TOKEN) throw new Error("Invalid refresh environment");
  const repositoryPath = REPO.split("/").map(encodeURIComponent).join("/");
  const prPath = `/repos/${repositoryPath}/pulls/${encodeURIComponent(PR_NUMBER)}`;
  const pr = await getJson(fetchImpl, GH_TOKEN, prPath);
  const expected = `https://github.com/${REPO}/pull/${PR_NUMBER}#issuecomment-${COMMENT_ID}`;
  const isReferenced = (localReviewUrl(pr.body) === expected) || referencedCommentUrls(pr.body).includes(expected);
  if (pr.state !== "open" || !isReferenced) return { refreshed: false };
  const head = pr.head.sha;
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Invalid PR head");
  const started = await writeCheck(fetchImpl, GH_TOKEN, REPO, "POST", "", {
    name: "skill-evidence", head_sha: head, status: "in_progress",
    output: { title: "Rechecking review evidence", summary: "The referenced report or waiver changed. Reading current evidence." },
  });
  if (!Number.isSafeInteger(started.id) || started.id < 1) throw new Error("Invalid check id");
  let result;
  try {
    result = await check({ REPO, PR_NUMBER, GH_TOKEN }, fetchImpl);
  } catch {
    result = { exitCode: 1, lines: ["Review evidence is unavailable; refusing approval."] };
  }
  if (result.headSha !== head) {
    result = { exitCode: 1, lines: ["PR head changed or could not be measured during revalidation; refusing approval."] };
  }
  const conclusion = result.exitCode === 0 ? "success" : "failure";
  await writeCheck(fetchImpl, GH_TOKEN, REPO, "PATCH", `/${Number(started.id)}`, {
    status: "completed", conclusion,
    output: { title: `Skill Evidence: ${conclusion}`, summary: result.lines.join("\n") },
  });
  return { refreshed: true, head, conclusion };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await refresh(process.env); console.log("Skill Evidence refresh finished; inspect the head-bound check result."); }
  catch { console.error("Skill Evidence refresh failed; current evidence is unavailable."); process.exitCode = 1; }
}
