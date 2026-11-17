// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ROLE_AUDIT_ROLES } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { readTrustedBrowserArchive, readTrustedRoleSummaryArchive } from "./trustedBrowserArchive.mjs";
import { readPublishedRoleSummaries } from "./trustedBrowserSource.mjs";

it("reads digest-matched root receipts and loads all six exact role archives", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autoflow-receipt-"));
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("autoflow-receipt-")) {
    throw new Error("Unsafe fixture cleanup path");
  }
  try {
    const evidence = { testedSha: "a".repeat(40) };
    const explorer = { records: [{ id: "explorer-1", code: "PASS" }] };
    const files = ["evidence.json", "explorer-evidence.json", "raw-results.json"];
    writeFileSync(path.join(root, files[0]), JSON.stringify(evidence));
    writeFileSync(path.join(root, files[1]), JSON.stringify(explorer));
    writeFileSync(path.join(root, files[2]), "unrelated non-JSON output");
    const archive = path.join(root, "receipt.zip");
    const zip = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "/usr/bin/zip";
    const args = process.platform === "win32" ? ["-acf", archive, ...files] : ["-q", archive, ...files];
    execFileSync(zip, args, { cwd: root, timeout: 5000, stdio: "pipe" });
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");

    expect(() => readTrustedBrowserArchive(archive, `sha256:${"0".repeat(64)}`)).toThrow("Receipt archive digest mismatch.");
    expect(readTrustedBrowserArchive(archive, `sha256:${sha256}`)).toEqual({ archiveSha256: sha256, evidence, explorer });
    expect(readdirSync(root).sort()).toEqual([...files, "receipt.zip"].sort());
    expect(() => readTrustedRoleSummaryArchive(archive, `sha256:${sha256}`)).toThrow("Role summary archive must contain only results.json.");
    const roleArchive = path.join(root, "role.zip");
    writeFileSync(path.join(root, "results.json"), JSON.stringify({ role: "OWNER" }));
    execFileSync(zip, [args[0], roleArchive, "results.json"], { cwd: root, timeout: 5000, stdio: "pipe" });
    const roleDigest = createHash("sha256").update(readFileSync(roleArchive)).digest("hex");
    expect(readTrustedRoleSummaryArchive(roleArchive, `sha256:${roleDigest}`)).toEqual({ role: "OWNER" });

    const expected = { runId: 20, attempt: 2, repositoryId: 3, controllerSha: "a".repeat(40) };
    const steps = [
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
