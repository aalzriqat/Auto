// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readTrustedBrowserArchive, readTrustedRoleSummaryArchive } from "./trustedBrowserArchive.mjs";

it("reads only root receipts from the digest-matched native archive and refuses changed bytes", () => {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
