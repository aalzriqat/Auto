/** Re-evaluate referenced local reports after edits/deletion, using main's code. */
import { fileURLToPath } from "node:url";
import { check, getJson } from "./checkPrSkillEvidence.mjs";
import { localReviewUrl } from "./prSkillEvidence.mjs";

async function writeCheck(fetchImpl, token, repo, method, suffix, body) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/check-runs${suffix}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub checks API ${response.status}`);
  return response.json();
}

export async function refresh({ REPO, PR_NUMBER, COMMENT_ID, GH_TOKEN }, fetchImpl = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO ?? "") || !/^\d+$/.test(PR_NUMBER ?? "") ||
      !/^[1-9]\d*$/.test(COMMENT_ID ?? "") || !GH_TOKEN) throw new Error("Invalid refresh environment");
  const prPath = `/repos/${REPO}/pulls/${PR_NUMBER}`;
  const pr = await getJson(fetchImpl, GH_TOKEN, prPath);
  const expected = `https://github.com/${REPO}/pull/${PR_NUMBER}#issuecomment-${COMMENT_ID}`;
  if (pr.state !== "open" || localReviewUrl(pr.body) !== expected) return { refreshed: false };
  const head = pr.head.sha;
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Invalid PR head");
  const started = await writeCheck(fetchImpl, GH_TOKEN, REPO, "POST", "", {
    name: "skill-evidence", head_sha: head, status: "in_progress",
    output: { title: "Rechecking local review evidence", summary: "The referenced report changed. Reading current evidence." },
  });
  if (!Number.isSafeInteger(started.id) || started.id < 1) throw new Error("Invalid check id");
  let result;
  try {
    result = await check({ REPO, PR_NUMBER, GH_TOKEN }, fetchImpl);
  } catch {
    result = { exitCode: 1, lines: ["Local review evidence is unavailable; refusing approval."] };
  }
  const conclusion = result.exitCode === 0 ? "success" : "failure";
  await writeCheck(fetchImpl, GH_TOKEN, REPO, "PATCH", `/${started.id}`, {
    status: "completed", conclusion,
    output: { title: `Skill Evidence: ${conclusion}`, summary: result.lines.join("\n") },
  });
  return { refreshed: true, head, conclusion };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await refresh(process.env))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
