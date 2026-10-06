// Entry point for trusted-review-evidence.yml (SCRUM-644 S3b-2). Builds the real
// git and GitHub ports and writes out/audit-<N>.json per open pull request.
//
// It refuses to run unless the checkout, the workflow's own revision and
// main's tip are one commit: the payload claims all three are equal, and the
// reader rejects any run where they are not.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractCanonicalInvariants } from "./jevImpact.mjs";
import { AUDIT_ARTIFACT_NAME } from "./reviewAuditAuthority.mjs";
import { createGithubClient, runController } from "./reviewAuditController.mjs";
import { isCommitSha } from "./reviewEvidence.mjs";

const SHA = /^[0-9a-f]{40}$/;

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

// Every SHA reaching git here is either controller-derived or checked by the
// evaluator first; this refuses anything else rather than pass it as an option.
const requireSha = (value) => {
  if (!SHA.test(value)) throw new Error("not a commit SHA");
  return value;
};
const requirePath = (file) => {
  if (typeof file !== "string" || file.startsWith("-") || file.includes("\0")) throw new Error("bad path");
  return file;
};

export function createGitPort() {
  const blobSpec = (sha, file) => `${requireSha(sha)}:${requirePath(file)}`;
  return {
    fetchPull(number) {
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error("bad PR number");
      git(["fetch", "--no-tags", "--quiet", "origin",
        `+refs/pull/${number}/head:refs/tre/${number}/head`,
        `+refs/pull/${number}/merge:refs/tre/${number}/merge`]);
      return {
        head: git(["rev-parse", `refs/tre/${number}/head`]).trim(),
        merge: git(["rev-parse", `refs/tre/${number}/merge`]).trim(),
      };
    },
    parents(sha) {
      return git(["show", "-s", "--format=%P", requireSha(sha)]).trim().split(/\s+/).filter(Boolean);
    },
    changedFiles(from, to) {
      const out = git(["diff", "--no-renames", "--name-only", "-z", requireSha(from), requireSha(to)]);
      return out.split("\0").filter(Boolean);
    },
    isAncestor(ancestor, descendant) {
      // Exit 1 (not an ancestor) and 128 (unknown object) are both "no".
      return git(["merge-base", "--is-ancestor", requireSha(ancestor), requireSha(descendant)], { allowFailure: true }) !== null;
    },
    blobSize(sha, file) {
      const out = git(["cat-file", "-s", blobSpec(sha, file)], { allowFailure: true });
      return out === null ? null : Number(out.trim());
    },
    blobId(sha, file) {
      const out = git(["rev-parse", blobSpec(sha, file)], { allowFailure: true });
      return out === null ? null : out.trim();
    },
    show(sha, file) {
      return git(["show", blobSpec(sha, file)]);
    },
  };
}

async function main() {
  const env = process.env;
  const workflowSha = env.GITHUB_WORKFLOW_SHA;
  const repositoryId = Number(env.GITHUB_REPOSITORY_ID);
  const run = {
    id: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    workflowSha,
    artifactName: AUDIT_ARTIFACT_NAME,
  };
  if (!isCommitSha(workflowSha) || !Number.isSafeInteger(repositoryId) || !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.attempt)) {
    throw new Error("the run context is incomplete");
  }

  git(["fetch", "--no-tags", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const mainTip = git(["rev-parse", "refs/remotes/origin/main"]).trim();
  const checkout = git(["rev-parse", "HEAD"]).trim();
  if (mainTip !== workflowSha || checkout !== workflowSha) {
    throw new Error(`refusing: checkout ${checkout}, workflow ${workflowSha} and main ${mainTip} are not one commit`);
  }

  const root = process.cwd();
  const trusted = {
    policy: JSON.parse(readFileSync(path.join(root, ".github/review-policy.json"), "utf8")),
    invariants: extractCanonicalInvariants(root),
  };
  const github = createGithubClient({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY });
  const { payloads, published, halted } = await runController({
    github,
    git: createGitPort(),
    trusted,
    run,
    repositoryId,
    mainTip,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const outDir = path.join(root, "out");
  mkdirSync(outDir, { recursive: true });
  for (const payload of payloads) {
    writeFileSync(path.join(outDir, `audit-${payload.N}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }
  console.log(`audited ${payloads.length} pull request(s); ${published} check-run(s) written; ${github.used()} API request(s)`);
  // A halted batch is still a successful run: its unreached PRs carry
  // BATCH_INCOMPLETE, which the reader treats as no binding.
  if (halted) console.log("batch halted early; remaining pull requests are BATCH_INCOMPLETE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
