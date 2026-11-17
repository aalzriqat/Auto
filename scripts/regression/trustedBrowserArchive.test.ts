// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ROLE_AUDIT_ROLES } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { readTrustedBrowserArchive, readTrustedRoleSummaryArchive } from "./trustedBrowserArchive.mjs";
import { bindTrustedBrowserReplays } from "./trustedBrowserReceipt.mjs";
import { readPublishedOpeningProof, readPublishedRoleSummaries } from "./trustedBrowserSource.mjs";
import openingOwner from "../../regression/scenarios/screen/opening-owner-ui-native-post.scenario.json";
import openingReviewer from "../../regression/scenarios/screen/opening-preparer-ui-native-review.scenario.json";

it("reads digest-matched root receipts and loads all six exact role archives", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autoflow-receipt-"));
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("autoflow-receipt-")) {
    throw new Error("Unsafe fixture cleanup path");
  }
  try {
    const evidence = { testedSha: "a".repeat(40) };
    const explorer = { records: [{ id: "explorer-1", code: "PASS" }] };
    const sourced = { records: [{ id: "g8-sourced-cash-delivery-screen", code: "PASS" }] };
    const files = ["evidence.json", "explorer-evidence.json", "raw-results.json", "sourced-evidence.json"];
    writeFileSync(path.join(root, files[0]), JSON.stringify(evidence));
    writeFileSync(path.join(root, files[1]), JSON.stringify(explorer));
    writeFileSync(path.join(root, files[2]), "unrelated non-JSON output");
    writeFileSync(path.join(root, files[3]), JSON.stringify(sourced));
    const archive = path.join(root, "receipt.zip");
    const zip = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "/usr/bin/zip";
    const args = process.platform === "win32" ? ["-acf", archive, ...files] : ["-q", archive, ...files];
    execFileSync(zip, args, { cwd: root, timeout: 5000, stdio: "pipe" });
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");

    expect(() => readTrustedBrowserArchive(archive, `sha256:${"0".repeat(64)}`)).toThrow("Receipt archive digest mismatch.");
    expect(readTrustedBrowserArchive(archive, `sha256:${sha256}`)).toEqual({ archiveSha256: sha256, evidence, explorer, sourced });
    expect(readdirSync(root).sort()).toEqual([...files, "receipt.zip"].sort());
    expect(() => readTrustedRoleSummaryArchive(archive, `sha256:${sha256}`)).toThrow("Role summary archive must contain only results.json.");
    const roleArchive = path.join(root, "role.zip");
    writeFileSync(path.join(root, "results.json"), JSON.stringify({ role: "OWNER" }));
    execFileSync(zip, [args[0], roleArchive, "results.json"], { cwd: root, timeout: 5000, stdio: "pipe" });
    const roleDigest = createHash("sha256").update(readFileSync(roleArchive)).digest("hex");
    expect(readTrustedRoleSummaryArchive(roleArchive, `sha256:${roleDigest}`)).toEqual({ role: "OWNER" });

    const expected = { runId: 20, attempt: 2, repositoryId: 3, controllerSha: "a".repeat(40) };
    const steps = [
      "Prove browser egress containment before authenticated traffic",
      "Audit exact candidate role and tenant authority",
      "Verify the local backend was not changed during the run",
      "Upload verified candidate role summary",
    ].map(name => ({ name, status: "completed", conclusion: "success" }));
    const jobs = ROLE_AUDIT_ROLES.map(role => ({ name: `candidate-role-audit-${role}`, run_id: expected.runId,
      run_attempt: expected.attempt, status: "completed", conclusion: "success", steps }));
    const metadata = new Map<string, unknown>();
    const archives = new Map<number, Buffer>();
    for (const [index, role] of ROLE_AUDIT_ROLES.entries()) {
      const id = index + 1;
      const name = `trusted-candidate-role-summary-${expected.runId}-${expected.attempt}-${role}`;
      const zipFile = path.join(root, `summary-${id}.zip`);
      writeFileSync(path.join(root, "results.json"), JSON.stringify({ role }));
      execFileSync(zip, [args[0], zipFile, "results.json"], { cwd: root, timeout: 5000, stdio: "pipe" });
      const bytes = readFileSync(zipFile);
      const artifact = { id, name, expired: false, size_in_bytes: bytes.length,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        workflow_run: { id: expected.runId, repository_id: expected.repositoryId, head_repository_id: expected.repositoryId,
          head_branch: "main", head_sha: expected.controllerSha } };
      metadata.set(`/actions/runs/${expected.runId}/artifacts?name=${name}&per_page=100`, { total_count: 1, artifacts: [artifact] });
      metadata.set(`/actions/artifacts/${id}`, artifact);
      archives.set(id, bytes);
    }
    expect(readPublishedRoleSummaries({
      receipt: { expected, jobs },
      api: (route: string) => metadata.get(route),
      downloadZip: (id: number) => archives.get(id),
    })).toEqual(ROLE_AUDIT_ROLES.map(role => ({ role })));
    expect(readPublishedRoleSummaries({
      receipt: { expected, jobs },
      api: (route: string) => metadata.get(route),
      downloadZip: (id: number) => id === 2 ? Buffer.from("unreadable role receipt") : archives.get(id),
    })).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("joins both opening cases only from the digest-matched protected job on the exact attempt", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autoflow-opening-proof-"));
  const expected = { runId: 20, attempt: 2, repositoryId: 3, baseSha: "a".repeat(40),
    controllerSha: "b".repeat(40), headSha: "c".repeat(40), testedSha: "d".repeat(40) };
  const steps = [
    "Prove browser egress containment before authenticated traffic",
    "Execute the two terminal opening browser witnesses",
    "Verify exact terminal opening evidence",
    "Verify the local backend was not changed during the run",
    "Upload checked terminal opening evidence",
  ].map(name => ({ name, status: "completed", conclusion: "success" }));
  const job = { name: "terminal-opening-proof", run_id: 20, run_attempt: 2, status: "completed", conclusion: "success", steps };
  const proof = { schemaVersion: 1, binding: { baseSha: expected.baseSha, headSha: expected.headSha,
    testedSha: expected.testedSha, controllerSha: expected.controllerSha, runId: "gh-20-2" },
    expected: 2, passed: 2, skipped: 0, flaky: 0, unexpected: 0, errors: 0,
    cases: ["opening-owner-native", "opening-review-native"], checked: true };
  const file = "opening-proof-public/proof.json";
  const archivePath = path.join(root, "proof.zip");
  const selected = [openingOwner, openingReviewer];
  try {
    mkdirSync(path.join(root, "opening-proof-public"));
    writeFileSync(path.join(root, file), JSON.stringify(proof));
    execFileSync(process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "/usr/bin/zip",
      [process.platform === "win32" ? "-acf" : "-q", archivePath, file], { cwd: root, timeout: 5000, stdio: "pipe" });
    const bytes = readFileSync(archivePath);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const artifact = { id: 61, name: "trusted-opening-proof", expired: false, size_in_bytes: bytes.length, digest,
      workflow_run: { id: 20, repository_id: 3, head_repository_id: 3, head_branch: "main", head_sha: expected.controllerSha } };
    const readProof = (proofJob = job, metadata = artifact, downloadZip = () => bytes) => readPublishedOpeningProof({
      receipt: { expected, jobs: [proofJob] },
      api: (route: string) => {
        if (route === "/actions/runs/20/artifacts?name=trusted-opening-proof&per_page=100") {
          return { total_count: 1, artifacts: [metadata] };
        }
        if (route === "/actions/artifacts/61") return metadata;
      },
      downloadZip,
    });
    const join = (opening: unknown, records = selected) => bindTrustedBrowserReplays({
      expected, opening, selected: records, trusted: selected, evidence: null, explorer: undefined,
    });
    const opening = readProof();
    expect(join(opening)).toEqual(selected.map(({ id }) => ({ id, code: "PASS" })));
    expect(() => readProof(job, artifact, () => { throw new Error("Download temporarily unavailable"); }))
      .toThrow("Download temporarily unavailable");
    expect(join(readProof())).toEqual(selected.map(({ id }) => ({ id, code: "PASS" })));
    const failedSteps = steps.map(step => step.name.includes("backend was not changed")
      ? { ...step, conclusion: "failure" } : step);
    expect(join(readProof({ ...job, steps: failedSteps }))).toEqual([]);
    expect(join(readProof(job, { ...artifact, digest: `sha256:${"0".repeat(64)}` }))).toEqual([]);
    expect(join({ ...proof, binding: { ...proof.binding, runId: "gh-20-1" } })).toEqual([]);
    expect(join({ ...proof, cases: ["opening-owner-native", "opening-owner-native"] })).toEqual([]);
    expect(join(opening, [{ ...openingOwner, fingerprint: "e".repeat(64) }])).toEqual([]);
  } finally {
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith("autoflow-opening-proof-")) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
