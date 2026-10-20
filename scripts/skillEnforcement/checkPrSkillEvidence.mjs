#!/usr/bin/env node
/**
 * CI entry for the `skill-evidence` check. Env: GH_TOKEN, REPO (owner/name),
 * PR_NUMBER. Reads the PR body and files live through the API (the event
 * payload goes stale on re-runs). Runs from the base branch only.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate, TEMPLATE } from "./prSkillEvidence.mjs";

const gh = (args) => execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

async function main() {
  const { REPO, PR_NUMBER } = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO ?? "") || !/^\d+$/.test(PR_NUMBER ?? "")) {
    throw new Error("REPO and PR_NUMBER are required");
  }
  const pr = JSON.parse(gh([`repos/${REPO}/pulls/${PR_NUMBER}`]));
  const files = gh([`repos/${REPO}/pulls/${PR_NUMBER}/files`, "--paginate", "--jq", ".[] | .filename, (.previous_filename // empty)"])
    .split("\n")
    .filter(Boolean);
  const head = pr.head.sha;
  const isAncestor = async (sha) => {
    try {
      const status = gh([`repos/${REPO}/compare/${sha}...${head}`, "--jq", ".status"]).trim();
      return status === "ahead" || status === "identical";
    } catch {
      return false;
    }
  };
  const result = await evaluate({ body: pr.body ?? "", files, isAncestor });
  if (!result.required) {
    console.log("skill-evidence: no money, permission or gate paths touched; not required.");
    return;
  }
  if (result.ok) {
    console.log("skill-evidence: section present and consistent.");
    return;
  }
  console.error("skill-evidence: FAILED\n" + result.problems.map((p) => `- ${p}`).join("\n"));
  console.error(`\nAdd this to the PR body and fill it in:\n\n${TEMPLATE}`);
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
