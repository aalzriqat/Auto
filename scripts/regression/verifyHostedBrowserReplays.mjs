import { appendFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { HOSTED_REPLAY_WAIT_MINUTES, isProtectedReplayBinding } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { loadRecords, selectForPr } from "./prRunner.mjs";
import { buildBrowserReplayManifest } from "./trustedBrowserManifest.mjs";
import { collectHostedBrowserReplays, hostedReplayCandidate, readProtectedReplayDiff } from "./trustedBrowserSource.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deadline = Date.now() + HOSTED_REPLAY_WAIT_MINUTES * 60_000;

async function collectSelectedReplayProof() {
  const candidate = hostedReplayCandidate(process.env, process.env.BASE_SHA);
  if (!candidate) throw new Error("Exact protected replay context is unavailable.");
  const files = readProtectedReplayDiff(root, candidate);
  const registry = loadRecords(root);
  if (registry.problems.length) throw new Error("Trusted replay registry is unavailable.");
  const selected = selectForPr(registry.records, files).browserSelected.filter(isProtectedReplayBinding);
  let proven = selected.length ? null : [];
  while (selected.length && Date.now() < deadline) {
    const attempt = collectHostedBrowserReplays({ root, candidate, selected, env: process.env });
    if (attempt.ready) {
      proven = attempt.verdicts;
      break;
    }
    await setTimeout(60_000);
  }
  if (proven === null) throw new Error("Protected browser evidence did not arrive within the producer budget.");
  if (selected.length && !proven.length) throw new Error("The protected producer yielded no verified browser evidence.");
  appendFileSync(process.env.GITHUB_OUTPUT, `manifest=${JSON.stringify(buildBrowserReplayManifest(candidate, selected, proven))}\n`);
  console.log(`Protected browser replays verified: ${proven.length}/${selected.length}.`);
}

try {
  await collectSelectedReplayProof();
} catch {
  console.error("Protected browser replay verification could not complete.");
  process.exitCode = 1;
}
