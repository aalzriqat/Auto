import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveGit } from "../contractSkew/gitExecutable.mjs";
import {
  executionEvidence,
  planPrE2e,
  prE2eVerdict,
  publishPrE2eCheck,
} from "./trustedPrE2eGate.mjs";

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? "");
const safeJson = (value) =>
  JSON.stringify(value, null, 2)
    .replaceAll("`", "\\u0060")
    .replaceAll("<", "\\u003c");

/** @param {string} mode @param {Record<string, string | undefined>} [env] @param {typeof fetch} [fetchImpl] */
export async function runGate(mode, env = process.env, fetchImpl = fetch) {
  // Fixed absolute git path: no PATH lookup (Sonar S4036).
  const gitPath = resolveGit();
  const git = (...args) => {
    if (!gitPath) throw new Error("git executable not found at a fixed path.");
    return execFileSync(gitPath, args, {
      cwd: env.G5_REPO_ROOT ?? process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  };
  const controllerSha = env.GITHUB_WORKFLOW_SHA;
  if (!sha(controllerSha) || git("rev-parse", "HEAD") !== controllerSha)
    throw new Error("Trusted controller checkout mismatch.");
  if (mode === "evidence") {
    const evidence = executionEvidence(
      json("g5/results.json"),
      json("g5/discovery.json"),
      {
        headSha: env.HEAD_SHA,
        testedSha: env.TESTED_SHA,
        controllerSha,
      },
    );
    writeFileSync("g5/evidence.json", JSON.stringify(evidence));
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `\nFull authenticated suite counts:\n\n\`\`\`json\n${safeJson(evidence)}\n\`\`\`\n`,
    );
    return;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? ""))
    throw new Error("Invalid repository identity.");
  const api = async (method, route, body) => {
    const response = await fetchImpl(
      `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}${route}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error("GitHub gate request failed.");
    return response.json();
  };
  const event = json(env.GITHUB_EVENT_PATH);
  let snapshot = event.pull_request ?? event.workflow_run?.pull_requests?.[0];
  if (!snapshot && sha(event.workflow_run?.head_sha)) {
    const prs = await api(
      "GET",
      `/commits/${event.workflow_run.head_sha}/pulls?per_page=100`,
    );
    const matches = prs.filter(
      (pr) =>
        pr.base?.ref === "main" && pr.head?.sha === event.workflow_run.head_sha,
    );
    if (matches.length === 1) snapshot = matches[0];
  }
  const headSha = snapshot?.head?.sha;
  const prNumber = snapshot?.number;
  if (!sha(headSha) || !Number.isSafeInteger(prNumber) || prNumber <= 0)
    throw new Error("Exact triggering PR identity unavailable.");
  const detailsUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const publication = {
    headSha,
    prNumber,
    runKey: `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`,
    mode,
    detailsUrl,
  };
  // Initialize a red check before scope I/O. Failure, timeout or absent workflow_run
  // must never leave an old success as the evidence for a new attempt.
  const initial =
    mode !== "finish"
      ? await publishPrE2eCheck(api, {
          ...publication,
          summary: "Trusted scope evaluation pending.",
        })
      : undefined;
  let verdict = {
    conclusion: "failure",
    reason: "Trusted scope or counted authenticated execution is unavailable.",
  };
  let plan;
  let evidence;
  let testedSha = env.TESTED_SHA;
  try {
    const pr = await api("GET", `/pulls/${prNumber}`);
    const files = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await api(
        "GET",
        `/pulls/${prNumber}/files?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch))
        throw new Error("PR file inventory unavailable.");
      files.push(...batch);
      if (batch.length < 100) break;
    }
    if (files.length !== pr.changed_files)
      throw new Error("PR file inventory incomplete.");
    const mainFiles = git(
      "ls-tree",
      "-r",
      "--name-only",
      controllerSha,
      "--",
      "playwright/tests",
    )
      .split("\n")
      .filter(Boolean);
    plan = planPrE2e(
      files.flatMap((file) => [
        file.filename,
        ...(file.previous_filename ? [file.previous_filename] : []),
      ]),
      mainFiles,
    );
    if (mode === "finish" && env.EVIDENCE_PATH) {
      try {
        evidence = json(env.EVIDENCE_PATH);
      } catch {
        /* Missing evidence refuses. */
      }
    }
    const current = await api("GET", `/pulls/${prNumber}`);
    const sameRepository =
      current.head?.repo?.full_name === env.GITHUB_REPOSITORY;
    let fresh =
      current.state === "open" &&
      current.base?.ref === "main" &&
      current.head?.sha === headSha &&
      current.base?.sha === pr.base?.sha &&
      pr.head?.sha === headSha;
    if (mode === "finish" && plan.inScope) {
      const merge = await api("GET", `/git/ref/pull/${prNumber}/merge`);
      fresh = fresh && sha(testedSha) && merge.object?.sha === testedSha;
    }
    verdict = prE2eVerdict({
      plan,
      fresh,
      sameRepository,
      result: mode === "finish" ? env.E2E_RESULT : undefined,
      evidence,
      headSha,
      testedSha,
      controllerSha,
    });
    // A green consumer requires its full-suite job AND successful preflight.
    if (plan.inScope && event.workflow_run?.conclusion !== "success")
      verdict = {
        conclusion: "failure",
        reason: "The secret-free PR preflight did not succeed.",
      };
  } catch {
    // Error objects may contain token-bearing requests or candidate text.
    console.error(
      "Trusted PR scope or execution evidence could not be verified.",
    );
  }
  const summary = `Controller: ${controllerSha}\n\nHead: ${headSha}\n\nTested backend and frontend merge: ${testedSha ?? "unavailable"}\n\n${verdict.reason}\n\nMain test definitions available to the trusted configuration (conditional and ignored definitions may not register in this lane):\n\n\`\`\`json\n${safeJson(plan?.mainDefinitions ?? [])}\n\`\`\`\n\nDefinitions changed by the PR (candidate versions never executed with secrets):\n\n\`\`\`json\n${safeJson(plan?.changedDefinitions ?? [])}\n\`\`\`\n\nCounts and executed definitions (paths from the Playwright report):\n\n\`\`\`json\n${safeJson(evidence ?? null)}\n\`\`\`\n`;
  appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  if (mode === "begin") {
    // The final job alone can certify execution. Scope success remains recorded
    // in the summary until then; initialize handles docs without a consumer.
    return;
  }
  // A delayed admission run must not revoke a consumer's newer execution.
  if (
    mode !== "initialize" ||
    initial?.external_id === `g5:${prNumber}:${publication.runKey}`
  ) {
    await publishPrE2eCheck(api, {
      ...publication,
      mode: "finish",
      verdict,
      summary,
    });
  }
  return verdict;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  mkdirSync("g5", { recursive: true });
  runGate(process.argv[2])
    .then((verdict) => {
      if (verdict?.conclusion === "failure") process.exitCode = 1;
    })
    .catch(() => {
      console.error(
        "Trusted authenticated PR gate failed; no success was certified.",
      );
      process.exitCode = 1;
    });
}
