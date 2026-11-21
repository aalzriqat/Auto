import { execFileSync } from "node:child_process";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { loadRecords, parseScenarioRecords, selectForPr } from "./prRunner.mjs";
import { finishPrScenarioEvidence, preserveScenarioObligations } from "./prScenarioEvidence.mjs";
import { readProtectedReplayDiff, readPublishedLocalScenarios } from "./trustedBrowserSource.mjs";

const readGit = (checkout, args, options = {}) => execFileSync(resolveTrustedGitExecutable(), args, {
  cwd: checkout, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options,
});

export function assertLocalScenarioContext(checkout, candidate) {
  const parents = readGit(checkout, ["show", "-s", "--format=%H %P", "HEAD"], { encoding: "utf8" }).trim();
  if (parents !== `${candidate.testedSha} ${candidate.baseSha} ${candidate.headSha}`) throw new Error("SCENARIO_LOCAL_CONTEXT_INVALID");
}

// Candidate definitions are Git objects. Candidate hooks, scripts, filesystem
// links and tests never run in the base checkout.
export function readScenarioRegistry(checkout, sha) {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha)) throw new Error("SCENARIO_GIT_REVISION_INVALID");
  const tree = readGit(checkout, ["ls-tree", "-rz", sha, "--", "regression/scenarios/"], { encoding: "utf8" });
  const blobs = tree.split("\0").filter(entry => entry.endsWith(".scenario.json")).map(entry => {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(regression\/scenarios\/.+)$/u.exec(entry);
    if (!match) throw new Error("SCENARIO_OBJECT_INVALID");
    return { hash: match[1], file: match[2] };
  });
  if (!blobs.length || blobs.length > 10_000) throw new Error("SCENARIO_OBJECT_COUNT_INVALID");
  const batch = readGit(checkout, ["cat-file", "--batch"], { input: blobs.map(({ hash }) => hash).join("\n") + "\n" });
  let offset = 0;
  const entries = blobs.map(({ hash, file }) => {
    const end = batch.indexOf(10, offset);
    if (end < offset || end - offset > 100) throw new Error("SCENARIO_OBJECT_INVALID");
    const match = /^([a-f0-9]{40}) blob ([1-9]\d{0,5})$/u.exec(batch.toString("ascii", offset, end));
    if (!match || match[1] !== hash) throw new Error("SCENARIO_OBJECT_INVALID");
    const last = end + 1 + Number(match[2]);
    if (batch[last] !== 10) throw new Error("SCENARIO_OBJECT_INVALID");
    offset = last + 1;
    return { file, read: () => batch.toString("utf8", end + 1, last) };
  });
  if (offset !== batch.length) throw new Error("SCENARIO_OBJECT_INVALID");
  const registry = parseScenarioRecords(entries);
  if (registry.problems.length) throw new Error("SCENARIO_REGISTRY_INVALID");
  return registry.records;
}

export function readProtectedScenarioRulings(checkout, baseSha) {
  const snapshot = JSON.parse(readGit(checkout, ["cat-file", "blob", `${baseSha}:regression/rulings.json`], { encoding: "utf8" }));
  if (!Array.isArray(snapshot)) throw new Error("SCENARIO_RULINGS_INVALID");
  return snapshot;
}

export function aggregateScenarioEvidence({ checkout, candidate, localRaw, localDigest, browserRaw }) {
  const changed = readProtectedReplayDiff(checkout, candidate);
  const candidateRecords = readScenarioRegistry(checkout, candidate.testedSha);
  const selection = selectForPr(candidateRecords, changed);
  const base = loadRecords(checkout);
  if (base.problems.length) throw new Error("SCENARIO_REGISTRY_INVALID");
  const protectedSelection = preserveScenarioObligations({ baseRecords: base.records, candidateRecords, selection, changed,
    protectedRulings: readProtectedScenarioRulings(checkout, candidate.baseSha) });
  return finishPrScenarioEvidence({ candidate, selection, protectedSelection, localRaw, localDigest, browserRaw });
}

export function verifyPublishedScenarioEvidence({ checkout, candidate, transport, artifactId, archiveDigest, localDigest, browserRaw }) {
  const assertLiveMerge = () => {
    const live = transport.api(`/git/ref/pull/${candidate.prNumber}/merge`);
    if (live?.object?.sha !== candidate.testedSha) throw new Error("SCENARIO_AGGREGATION_CONTEXT_STALE");
  };
  assertLiveMerge();
  const localRaw = readPublishedLocalScenarios({ candidate, ...transport, artifactId, digest: archiveDigest });
  const summary = aggregateScenarioEvidence({ checkout, candidate, localRaw, localDigest, browserRaw });
  assertLiveMerge();
  return summary;
}
