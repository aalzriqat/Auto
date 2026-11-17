import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const UNZIP = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/unzip.exe" : "/usr/bin/unzip";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;

function unzip(args) {
  try {
    return execFileSync(UNZIP, args, {
      encoding: "utf8", env: {}, maxBuffer: MAX_ENTRY_BYTES, timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Receipt archive could not be read within its limits.");
  }
}

function readReceipt(archive, names, name, required) {
  const count = names.filter(entry => entry === name).length;
  if (!required && count === 0) return undefined;
  if (count !== 1) throw new Error("Receipt archive entry is missing or ambiguous.");
  try {
    return JSON.parse(unzip(["-p", archive, name]));
  } catch {
    throw new Error("Receipt archive entry is unreadable.");
  }
}

// The trusted consumer downloads to its own scratch directory. Read receipts
// through stdout so filenames inside the ZIP never become filesystem paths.
function verifyReceiptArchive(filename, expectedDigest) {
  const archive = path.resolve(filename);
  const stat = lstatSync(archive);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ARCHIVE_BYTES) {
    throw new Error("Receipt archive is missing or exceeds its size limit.");
  }
  const archiveSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (expectedDigest !== `sha256:${archiveSha256}`) throw new Error("Receipt archive digest mismatch.");

  const names = unzip(["-Z1", archive]).split(/\r?\n/).filter(Boolean);
  return { archive, archiveSha256, names };
}

export function readTrustedBrowserArchive(filename, expectedDigest) {
  const { archive, archiveSha256, names } = verifyReceiptArchive(filename, expectedDigest);
  const evidence = readReceipt(archive, names, "evidence.json", true);
  const explorer = readReceipt(archive, names, "explorer-evidence.json", false);
  return { archiveSha256, evidence, explorer };
}

export function readTrustedRoleSummaryArchive(filename, expectedDigest) {
  const { archive, names } = verifyReceiptArchive(filename, expectedDigest);
  if (names.length !== 1) throw new Error("Role summary archive must contain only results.json.");
  return readReceipt(archive, names, "results.json", true);
}
