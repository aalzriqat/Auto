import { afterAll, beforeAll, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditEvidenceError, captureAuditProcess, gpgArgumentPath, importAuditRecipient, packageAuditEvidence, publicAuditSummary, roleRegressionOutcome, runRoleAudit, withEvidenceCleanup } from "./pilotRoleAuditEvidence.mjs";
import { SCREEN_AUDIT_ROUTES } from "../playwright/fixtures/screenAuditRoutes";

// One disposable, synthetic recipient. Never use these test keys for real data.
// No key or recovery copy survives the suite, and nothing enters the user keyring.
const gpg = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/gpg.exe" : "/usr/bin/gpg";
const tar = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "/usr/bin/tar";
const parent = realpathSync(os.tmpdir());
const root = mkdtempSync(path.join(parent, "pilot-evidence-synthetic-controls-"));
const keyHome = path.join(root, "synthetic-keyring");
let keyHomeArgument = keyHome;
const publicKey = path.join(root, "test-recipient.asc");
const passphrase = path.join(root, "synthetic-passphrase");
const resultsRoot = path.join(root, "captures");
const privateLog = path.join(root, "private-browser.log");
const sha = "1".repeat(40);
const canary = "Synthetic.QA@EXAMPLE.INVALID";
let fingerprint = "";
let image: Buffer;

// Child processes need native OS paths, not the calling CI job's audit identity.
// Each behavioral test declares the context whose stage it intends to measure.
function auditTestEnvironment(context: "local" | "trustedRoleCI" | "invalidCI",
  extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.GITHUB_SHA = sha;
  env.HUNT_AUDIT_ROLE = "OWNER";
  env.PILOT_ROLE_GPG_BINARY = gpg;
  if (context !== "local") env.GITHUB_ACTIONS = "true";
  if (context === "trustedRoleCI") {
    env.GITHUB_RUN_ID = "123456789";
    env.GITHUB_RUN_ATTEMPT = "2";
    env.GITHUB_WORKFLOW_REF = "aalzriqat/Auto/.github/workflows/pilot-role-audit.yml@refs/heads/main";
  }
  return { ...env, ...extra, NODE_ENV: "test" };
}

function runGpg(args: string[]): string {
  return execFileSync(gpg, ["--homedir", gpgArgumentPath(gpg, keyHomeArgument), "--batch", "--yes", "--no-tty", "--pinentry-mode", "loopback",
    "--passphrase-file", gpgArgumentPath(gpg, passphrase), ...args.map((arg) => path.isAbsolute(arg) ? gpgArgumentPath(gpg, arg) : arg)],
  { encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

beforeAll(async () => {
  mkdirSync(keyHome, { mode: 0o700 });
  if (process.platform === "win32") {
    // MSYS Unix sockets have a short path limit. This is the same directory,
    // represented by its native Windows short name; no external key custody.
    keyHomeArgument = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$fso=New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder($env:PILOT_SYNTHETIC_GPG_HOME).ShortPath"],
  { env: auditTestEnvironment("local", { PILOT_SYNTHETIC_GPG_HOME: keyHome }), encoding: "utf8", timeout: 10_000, windowsHide: true }).trim();
  }
  mkdirSync(resultsRoot);
  writeFileSync(passphrase, "SYNTHETIC-TEST-ONLY-NOT-A-REAL-CREDENTIAL", { mode: 0o600 });
  runGpg(["--quick-generate-key", "Synthetic role evidence TEST ONLY", "rsa3072", "cert", "1d"]);
  fingerprint = runGpg(["--with-colons", "--list-keys"]).split(/\r?\n/).find((line) => line.startsWith("fpr:"))?.split(":")[9] ?? "";
  expect(fingerprint).toMatch(/^[A-F0-9]{40}$/);
  runGpg(["--quick-add-key", fingerprint, "rsa3072", "encr", "1d"]);
  runGpg(["--armor", "--output", publicKey, "--export", fingerprint]);
  // Unit CI needs no browser install. The explicit local visual control supplies
  // the real browser canary PNG; both inputs exercise identical archive I/O.
  image = process.env.PILOT_EVIDENCE_CONTROL_IMAGE ? readFileSync(process.env.PILOT_EVIDENCE_CONTROL_IMAGE)
    : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", "base64");
  const cell = path.join(resultsRoot, "team-en-desktop");
  mkdirSync(cell);
  writeFileSync(path.join(cell, "role-locale-route.png"), image);
  writeFileSync(path.join(cell, "role-cell.json"), JSON.stringify({ sha, route: "team", locale: "en", viewport: { name: "desktop" },
    role: { roleName: "OWNER", userId: "synthetic-private-user", email: canary }, observed: "MATCHED", expected: "ALLOWED_ROUTE",
    requestedPath: "/synthetic-private-org/team", expectedPath: "/synthetic-private-org/team", observedPath: "/synthetic-private-org/team" }));
  writeFileSync(privateLog, `Synthetic failure could include ${canary} and synthetic-private-org\n`);
}, 90_000);

afterAll(() => {
  // Kill only the disposable synthetic agent, never the user's agent.
  const gpgconf = process.platform === "win32" ? path.join(path.dirname(gpg), "gpgconf.exe") : "gpgconf";
  spawnSync(gpgconf, ["--homedir", gpgArgumentPath(gpg, keyHomeArgument), "--kill", "gpg-agent"], { timeout: 10_000, windowsHide: true, stdio: "ignore" });
  const resolved = realpathSync(root);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("pilot-evidence-synthetic-controls-")) {
    throw new Error("Unsafe synthetic cleanup target");
  }
  rmSync(resolved, { recursive: true, force: true });
});

function options(name: string) {
  return { resultsRoot, privateLog, publicRoot: path.join(root, name), role: "OWNER", sha, publicKey, fingerprint, gpgBinary: gpg, tarBinary: tar };
}

test.each([
  { workFails: false, cleanupFails: false, reason: null },
  { workFails: true, cleanupFails: false, reason: "PRIMARY_FAILURE" },
  { workFails: false, cleanupFails: true, reason: "CLEANUP_FAILURE" },
  { workFails: true, cleanupFails: true, reason: "PRIMARY_FAILURE" },
])("resource cleanup preserves the measured result: work=$workFails cleanup=$cleanupFails", async ({ workFails, cleanupFails, reason }) => {
  const resource = path.join(root, `cleanup-${workFails}-${cleanupFails}.private`);
  const cleaned = resource + ".cleaned";
  const result = withEvidenceCleanup(async () => {
    writeFileSync(resource, "Synthetic private resource");
    if (workFails) throw new AuditEvidenceError("PRIMARY_FAILURE");
    return "MEASURED_RESULT";
  }, async () => {
    rmSync(resource);
    writeFileSync(cleaned, "RESOURCE_REMOVED");
    if (cleanupFails) throw new AuditEvidenceError("CLEANUP_FAILURE");
  });
  if (reason) await expect(result).rejects.toThrow(reason);
  else await expect(result).resolves.toBe("MEASURED_RESULT");
  expect(existsSync(resource)).toBe(false);
  expect(readFileSync(cleaned, "utf8")).toBe("RESOURCE_REMOVED");
});

test("actual image and private observations survive native encryption/decryption; public results cannot contain them", async () => {
  const args = options("public-success");
  const summary = await packageAuditEvidence(args);
  expect(summary.observedCells).toBe(1);
  expect(summary.complete).toBe(false); // Missing 135 cells and isolation is UNAVAILABLE, never PASS.
  expect(summary.visualReview).toBe("UNAVAILABLE_UNTIL_LOCAL_DECRYPT_AND_INSPECTION");
  const publicBytes = readFileSync(path.join(args.publicRoot, "results.json"), "utf8");
  expect(publicBytes).not.toMatch(/synthetic-private|@|EXAMPLE|userId|requestedPath|observedPath/);
  const ciphertext = readFileSync(path.join(args.publicRoot, "role-evidence.tar.gpg"));
  expect(summary.ciphertextSha256).toBe(createHash("sha256").update(ciphertext).digest("hex"));
  expect(readdirSync(args.publicRoot).sort()).toEqual(["results.json", "role-evidence.tar.gpg"]);
  expect(ciphertext.includes(Buffer.from(canary))).toBe(false);
  const decoded = path.join(root, "decoded.tar");
  runGpg(["--output", decoded, "--decrypt", path.join(args.publicRoot, "role-evidence.tar.gpg")]);
  const inventory = execFileSync(tar, ["-tf", decoded], { encoding: "utf8", timeout: 10_000 });
  expect(inventory).not.toMatch(/(?:^|\n)(?:\/|[A-Za-z]:)|\.\.|\.auth|trace\.zip|\.webm|\.html/);
  const extracted = path.join(root, "decoded");
  mkdirSync(extracted);
  execFileSync(tar, ["-xf", decoded, "-C", extracted], { timeout: 10_000, stdio: "pipe" });
  expect(readFileSync(path.join(extracted, "captures/team-en-desktop/role-locale-route.png"))).toEqual(image);
  expect(readFileSync(path.join(extracted, "browser.log"), "utf8")).toContain(canary);
  expect(readFileSync(path.join(extracted, "captures/team-en-desktop/role-cell.json"), "utf8")).toContain(canary);
  const manifest = JSON.parse(readFileSync(path.join(extracted, "manifest.json"), "utf8")) as { files: { path: string; bytes: number; sha256: string }[] };
  expect(manifest.files).toHaveLength(3);
  for (const entry of manifest.files) {
    const content = readFileSync(path.join(extracted, entry.path));
    expect(content).toHaveLength(entry.bytes);
    expect(createHash("sha256").update(content).digest("hex")).toBe(entry.sha256);
  }
  const corrupted = Buffer.from(ciphertext);
  corrupted[Math.floor(corrupted.length / 2)] ^= 1;
  const damagedFile = path.join(root, "damaged.gpg");
  writeFileSync(damagedFile, corrupted);
  const damagedOutput = path.join(root, "damaged-output.private");
  const refusal = spawnSync(gpg, ["--homedir", gpgArgumentPath(gpg, keyHomeArgument), "--batch", "--yes", "--pinentry-mode", "loopback",
    "--passphrase-file", gpgArgumentPath(gpg, passphrase), "--output", gpgArgumentPath(gpg, damagedOutput), "--decrypt", gpgArgumentPath(gpg, damagedFile)],
  { timeout: 30_000, windowsHide: true, stdio: "ignore" });
  expect(refusal.status).not.toBe(0);
  rmSync(damagedOutput, { force: true });
}, 30_000);

test.each([false, true])("summary write failure publishes neither completed file (partial write=%s)", async (partial) => {
  const args = options(`public-summary-failure-${partial}`);
  const original = fs.writeFile;
  let reached = false;
  const write = vi.spyOn(fs, "writeFile").mockImplementation(async (file, ...rest) => {
    if (path.basename(String(file)) === "results.json") {
      reached = true;
      if (partial) await original(file, "{", { mode: 0o600 });
      throw new Error("SYNTHETIC_SUMMARY_WRITE_FAILURE");
    }
    return original(file, ...rest);
  });
  try {
    await expect(packageAuditEvidence(args)).rejects.toThrow("EVIDENCE_UNAVAILABLE");
    expect(reached).toBe(true);
    expect(existsSync(args.publicRoot) ? readdirSync(args.publicRoot) : []).toEqual([]);
  } finally { write.mockRestore(); }
});

test("a wrong pinned recipient refuses without a completed artifact", async () => {
  const args = { ...options("public-wrong-key"), fingerprint: "0".repeat(40) };
  await expect(packageAuditEvidence(args)).rejects.toThrow("RECIPIENT_UNAVAILABLE");
  expect(existsSync(args.publicRoot)).toBe(false);
});

test("a native directory rename failure cannot publish either completed file", async () => {
  const args = options("public-rename-failure");
  const original = fs.rename;
  let reached = false;
  let staged: string[] = [];
  const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === args.publicRoot) {
      reached = true;
      staged = readdirSync(String(from)).sort();
      throw new Error("SYNTHETIC_DIRECTORY_RENAME_FAILURE");
    }
    return original(from, to);
  });
  try {
    await expect(packageAuditEvidence(args)).rejects.toThrow("EVIDENCE_UNAVAILABLE");
    expect(reached).toBe(true);
    expect(staged).toEqual(["results.json", "role-evidence.tar.gpg"]);
    expect(existsSync(args.publicRoot)).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith(".role-evidence-private-"))).toEqual([]);
  } finally { rename.mockRestore(); }
});

test.each(["empty", "populated", "symlink"] as const)("pre-existing %s publication is refused unchanged", async (kind) => {
  const args = options(`public-existing-${kind}`);
  const target = path.join(root, `existing-target-${kind}`);
  if (kind === "symlink") {
    mkdirSync(target);
    writeFileSync(path.join(target, "sentinel"), "UNCHANGED");
    symlinkSync(target, args.publicRoot, process.platform === "win32" ? "junction" : "dir");
  } else {
    mkdirSync(args.publicRoot);
    if (kind === "populated") writeFileSync(path.join(args.publicRoot, "sentinel"), "UNCHANGED");
  }
  const before = readdirSync(args.publicRoot);
  await expect(packageAuditEvidence(args)).rejects.toThrow("PUBLICATION_EXISTS");
  expect(readdirSync(args.publicRoot)).toEqual(before);
  if (kind !== "empty") expect(readFileSync(path.join(args.publicRoot, "sentinel"), "utf8")).toBe("UNCHANGED");
});

test("invalid publication context cannot enter the public fallback summary", async () => {
  const args = { ...options("public-invalid-context"), role: canary };
  await expect(packageAuditEvidence(args)).rejects.toThrow("INVALID_CONTEXT");
  expect(existsSync(args.publicRoot)).toBe(false);
});

test("an expired encryption key is unavailable", async () => {
  await expect(importAuditRecipient({ gpgBinary: gpg, keyHome: path.join(root, "expired-check"), publicKey, fingerprint,
    now: Date.now() + 3 * 24 * 60 * 60 * 1000 })).rejects.toThrow("RECIPIENT_UNAVAILABLE");
});

test("isolation image presence cannot accept non-PNG bytes as a valid image", async () => {
  const directory = path.join(root, "invalid-isolation-image"); mkdirSync(directory);
  const attempts = ["A to B", "B to A"].flatMap((direction) => ["foreign organization read", "foreign customer read", "foreign row under own org",
    "foreign organization update", "foreign customer delete", "foreign row delete under own org"].map((operation) => ({ direction, operation, outcome: "REFUSED" })));
  const json = path.join(directory, "tenant-boundary.json");
  writeFileSync(json, JSON.stringify({ sha, auditedRoleBeforeIsolation: "OWNER", actualProbeRoles: { A: "OWNER", B: "OWNER" }, stateUnchanged: true, attempts }));
  const files = [json];
  for (const direction of ["A-to-B", "B-to-A"]) for (const locale of ["en", "ar"]) for (const viewport of ["desktop", "phone"]) {
    const file = path.join(directory, `${direction}-${locale}-${viewport}.png`);
    writeFileSync(file, image); files.push(file);
  }
  writeFileSync(files.at(-1)!, "not a PNG image despite its filename");
  await expect(publicAuditSummary(files, "OWNER", sha)).rejects.toThrow("INVALID_IMAGE");
});

test("packaging failure refuses without a plaintext or completed cipher artifact", async () => {
  const args = { ...options("public-package-failure"), tarBinary: process.execPath };
  await expect(packageAuditEvidence(args)).rejects.toThrow("ENCRYPTION_FAILED");
  expect(existsSync(args.publicRoot)).toBe(false);
});

test("a missing screenshot cannot be published as a matched cell", async () => {
  const missingRoot = path.join(root, "missing-image");
  mkdirSync(missingRoot);
  writeFileSync(path.join(missingRoot, "role-cell.json"), readFileSync(path.join(resultsRoot, "team-en-desktop/role-cell.json")));
  const args = { ...options("public-missing-image"), resultsRoot: missingRoot };
  await expect(packageAuditEvidence(args)).rejects.toThrow("MISSING_IMAGE");
  expect(readdirSync(args.publicRoot).sort()).toEqual(["results.json", "role-evidence.tar.gpg"]);
  const summary = JSON.parse(readFileSync(path.join(args.publicRoot, "results.json"), "utf8"));
  expect(summary).toMatchObject({ complete: false, observedCells: 0, measurement: "UNAVAILABLE", reason: "MISSING_IMAGE" });
  expect(summary.cells).toEqual([]);
  const decrypted = path.join(root, "missing-image-failure.tar");
  runGpg(["--output", decrypted, "--decrypt", path.join(args.publicRoot, "role-evidence.tar.gpg")]);
  expect(execFileSync(tar, ["-xOf", decrypted, "browser.log"], { encoding: "utf8" })).toBe(readFileSync(privateLog, "utf8"));
});

test("an unsafe capture inventory still encrypts the private failure log and refuses measurement", async () => {
  const unsafe = path.join(root, "unsafe-captures"); mkdirSync(unsafe);
  symlinkSync(resultsRoot, path.join(unsafe, "untrusted-link"), "junction");
  const args = { ...options("public-unsafe-inventory"), resultsRoot: unsafe };
  await expect(packageAuditEvidence(args)).rejects.toThrow("UNSAFE_FILE");
  expect(readdirSync(args.publicRoot).sort()).toEqual(["results.json", "role-evidence.tar.gpg"]);
  expect(JSON.parse(readFileSync(path.join(args.publicRoot, "results.json"), "utf8")))
    .toMatchObject({ complete: false, observedCells: 0, measurement: "UNAVAILABLE", reason: "UNSAFE_FILE" });
  const decoded = path.join(root, "unsafe-inventory-failure.tar");
  runGpg(["--output", decoded, "--decrypt", path.join(args.publicRoot, "role-evidence.tar.gpg")]);
  expect(execFileSync(tar, ["-xOf", decoded, "browser.log"], { encoding: "utf8" })).toBe(readFileSync(privateLog, "utf8"));
  expect(execFileSync(tar, ["-tf", decoded], { encoding: "utf8" })).not.toContain("untrusted-link");
});

test("an oversized private log retains a bounded encrypted tail and cannot pass", async () => {
  const oversizedLog = path.join(root, "oversized-browser.private.log");
  const data = Buffer.alloc(33 * 1024 * 1024);
  Buffer.from(canary).copy(data, data.length - Buffer.byteLength(canary));
  writeFileSync(oversizedLog, data);
  const args = { ...options("public-oversized-log"), privateLog: oversizedLog };
  await expect(packageAuditEvidence(args)).rejects.toThrow("INVENTORY_LIMIT");
  expect(JSON.parse(readFileSync(path.join(args.publicRoot, "results.json"), "utf8")))
    .toMatchObject({ complete: false, measurement: "UNAVAILABLE", reason: "INVENTORY_LIMIT" });
  const decoded = path.join(root, "oversized-log-failure.tar");
  runGpg(["--output", decoded, "--decrypt", path.join(args.publicRoot, "role-evidence.tar.gpg")]);
  const tail = execFileSync(tar, ["-xOf", decoded, "browser.log"], { maxBuffer: 33 * 1024 * 1024, timeout: 10_000 });
  expect(tail).toHaveLength(32 * 1024 * 1024);
  expect(tail.subarray(-Buffer.byteLength(canary)).toString("utf8")).toBe(canary);
  const manifest = JSON.parse(execFileSync(tar, ["-xOf", decoded, "manifest.json"], { encoding: "utf8" }));
  expect(manifest.diagnostic).toMatchObject({ logTruncated: true, captureInventoryAccepted: false, refusal: "INVENTORY_LIMIT" });
}, 45_000);

test("a failing native child keeps both output streams in the private log", () => {
  const logFile = path.join(root, "failed-command.private.log");
  const result = captureAuditProcess({ command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.AUDIT_CANARY);process.stderr.write(process.env.AUDIT_CANARY.toLowerCase());process.exit(17)"],
    cwd: root, logFile, env: auditTestEnvironment("local", { AUDIT_CANARY: canary }), timeout: 10_000 });
  expect(result).toEqual({ execution: "FAILED", exitCode: 17 });
  expect(readFileSync(logFile, "utf8")).toContain(canary);
  expect(readFileSync(logFile, "utf8")).toContain(canary.toLowerCase());
  expect(Object.keys(result).sort()).toEqual(["execution", "exitCode"]);
});

test.each([
  ["invalid JSON", "EVIDENCE_UNAVAILABLE"],
  ["unexpected field", "RECIPIENT_UNAVAILABLE"],
] as const)("CLI %s recipient refuses at its measured stage without starting a browser", (kind, reason) => {
  const fakeRepo = path.join(root, `malformed-recipient-repo-${kind}`);
  mkdirSync(path.join(fakeRepo, ".github"), { recursive: true });
  const descriptor = kind === "invalid JSON" ? `${canary} invalid JSON`
    : JSON.stringify({ fingerprint, publicKey: readFileSync(publicKey, "utf8"), unexpected: canary });
  writeFileSync(path.join(fakeRepo, ".github/pilot-role-evidence-recipient.json"), descriptor);
  const runnerTemp = path.join(root, `cli-runner-temp-${kind}`);
  mkdirSync(runnerTemp);
  const result = spawnSync(process.execPath, [path.resolve("scripts/pilotRoleAuditEvidence.mjs")], {
    cwd: fakeRepo, env: auditTestEnvironment("local", { RUNNER_TEMP: runnerTemp }),
    encoding: "utf8", timeout: 15_000, windowsHide: true });
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(canary);
  // Node can emit its module-format warning before the CLI's bounded JSON.
  const diagnostics = result.stderr.split(/\r?\n/).filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as unknown);
  expect(diagnostics).toEqual([{ execution: "UNAVAILABLE", reason }]);
  expect(result.stdout).toBe("");
  expect(readdirSync(runnerTemp)).toEqual([]);
});

const roleTitles = [
  "protected role routes render actual authority across audited pages",
  "lead screen and create dialog respect actual audited role authority",
  "approval screen renders authorized queue or explicit role refusal",
  "sales quote picker respects audited role and tenant choice authority",
  "pilot Accounting traversal paints every section and nested reader",
  "pilot Sales opens CASH and configured FINANCED entry panels for each audited role",
  "pilot Deals opens owned and SOURCED cash and configured financed detail screens",
];

function roleReport(statuses: readonly string[] = roleTitles.map(() => "passed")) {
  return { errors: [], suites: [{ file: "../tests/audit-role-access.spec.ts", specs: statuses.map((status, index) => ({
    title: roleTitles[index] ?? roleTitles[0], file: "../tests/audit-role-access.spec.ts", ok: status === "passed",
    tests: [{ projectName: index < 4 ? "role-regressions" : "pilot-g8-role-hunt", status: status === "passed" ? "expected" : status,
      expectedStatus: "passed", results: status === "skipped" ? [] : [{ status }] }],
  })) }] };
}

function wrongProjectReport() {
  const report = roleReport();
  return { ...report, suites: [{ ...report.suites[0], specs: report.suites[0].specs.map((spec, index) => index === 6 ? { ...spec, tests: [{ ...spec.tests[0], projectName: "role-regressions" }] } : spec) }] };
}

test.each([
  ["all seven passed", roleReport(), true, "PASS"],
  ["no cases", { errors: [], suites: [] }, false, "UNAVAILABLE"],
  ["missing case", roleReport(["passed", "passed", "passed"]), false, "UNAVAILABLE"],
  ["a G8 journey that ran in the wrong project", wrongProjectReport(), false, "FAIL"],
  ["skipped case", roleReport(roleTitles.map((_, index) => index === 1 ? "skipped" : "passed")), false, "FAIL"],
  ["duplicate case", { errors: [], suites: [{ ...roleReport().suites[0], specs: [...roleReport().suites[0].specs, roleReport().suites[0].specs[0]] }] }, false, "FAIL"],
  ["nested duplicate case", { errors: [], suites: [{ ...roleReport().suites[0], suites: [{ specs: [roleReport().suites[0].specs[0]] }] }] }, false, "FAIL"],
  ["unparseable", null, false, "UNAVAILABLE"],
] as const)("real-role case census measures %s", (_name, report, verified, measurement) => {
  expect(roleRegressionOutcome(report)).toMatchObject({ expected: 7, verified, measurement });
});

test.each([
  { exitCode: 0, reportMode: "passed", complete: true },
  { exitCode: 0, reportMode: "missing", complete: false },
  { exitCode: 0, reportMode: "malformed", complete: false },
  { exitCode: 0, reportMode: "skipped", complete: false },
  { exitCode: 17, reportMode: "passed", complete: false },
] as const)("native audit requires measured real-role cases: process=$exitCode report=$reportMode", async ({ exitCode, reportMode, complete }) => {
  const repo = path.join(root, `native-orchestration-${exitCode}-${reportMode}`);
  const captures = path.join(repo, "synthetic-inputs");
  const runnerTemp = path.join(root, `native-orchestration-temp-${exitCode}-${reportMode}`);
  mkdirSync(path.join(repo, ".github"), { recursive: true });
  mkdirSync(captures); mkdirSync(runnerTemp);
  const sharedResults = path.join(repo, "test-results");
  mkdirSync(sharedResults);
  writeFileSync(path.join(sharedResults, "caller-owned.txt"), "caller-owned results");
  writeFileSync(path.join(runnerTemp, "deal-scenarios-output.log"), "caller-owned scenario log");
  writeFileSync(path.join(repo, ".github/pilot-role-evidence-recipient.json"), JSON.stringify({ fingerprint,
    publicKey: readFileSync(publicKey, "utf8") }));
  for (const route of SCREEN_AUDIT_ROUTES) for (const locale of ["en", "ar"]) for (const viewport of ["desktop", "phone"]) {
    const cell = path.join(captures, `${route}-${locale}-${viewport}`);
    mkdirSync(cell, { recursive: true });
    writeFileSync(path.join(cell, "role-locale-route.png"), image);
    writeFileSync(path.join(cell, "role-cell.json"), JSON.stringify({ sha, route, locale, viewport: { name: viewport },
      role: { roleName: "OWNER" }, observed: "MATCHED", expected: "ALLOWED_ROUTE", requestedPath: `/${route}`, expectedPath: `/${route}`, observedPath: `/${route}` }));
  }
  const isolation = path.join(captures, "isolation"); mkdirSync(isolation);
  const attempts = ["A to B", "B to A"].flatMap((direction) => ["foreign organization read", "foreign customer read", "foreign row under own org",
    "foreign organization update", "foreign customer delete", "foreign row delete under own org"].map((operation) => ({ direction, operation, outcome: "REFUSED" })));
  writeFileSync(path.join(isolation, "tenant-boundary.json"), JSON.stringify({ sha, auditedRoleBeforeIsolation: "OWNER",
    actualProbeRoles: { A: "OWNER", B: "OWNER" }, stateUnchanged: true, attempts }));
  for (const direction of ["A-to-B", "B-to-A"]) for (const locale of ["en", "ar"]) for (const viewport of ["desktop", "phone"]) {
    writeFileSync(path.join(isolation, `${direction}-${locale}-${viewport}.png`), image);
  }
  const stub = path.join(repo, "synthetic-browser.cjs");
  const failureMarker = "\nPreview attestation failed: [Request ID: 42e39a239aecaeb1]\n";
  const report = reportMode === "skipped" ? roleReport(roleTitles.map((_, index) => index === 1 ? "skipped" : "passed")) : roleReport();
  const reportBytes = reportMode === "malformed" ? "{invalid report" : JSON.stringify(report);
  const reportWrite = reportMode === "missing" ? "" : `fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,${JSON.stringify(reportBytes)});`;
  writeFileSync(stub, `const fs=require("node:fs"),path=require("node:path");const output=process.argv.find(arg=>arg.startsWith("--output="));fs.cpSync(path.join(process.cwd(),"synthetic-inputs"),output?output.slice(9):path.join(process.cwd(),"test-results"),{recursive:true});${reportWrite}process.stdout.write(process.env.AUDIT_CANARY);process.stderr.write(process.env.AUDIT_CANARY.toLowerCase());if(${exitCode}!==0)process.stderr.write(${JSON.stringify(failureMarker)});process.exit(${exitCode});`);
  let diagnosticCalls = 0;
  const outcome = await runRoleAudit({ cwd: repo, browserCli: stub,
    diagnosticSpawn: () => {
      diagnosticCalls++;
      return { status: 0, stdout: JSON.stringify({ kind: "Completion", identifier: "e2eBootstrap:assertHuntSeats",
        requestId: "42e39a239aecaeb1", error: `RangeError: ${canary}` }) };
    },
    env: auditTestEnvironment("trustedRoleCI", { RUNNER_TEMP: runnerTemp, AUDIT_CANARY: canary,
      CONVEX_PREVIEW_NAME: "e2e-role-test", CONVEX_DEPLOY_KEY: "preview:test:key|synthetic",
      CONVEX_PREVIEW_URL: "https://tame-mouse-328.convex.cloud", CONVEX_PREVIEW_CREATED_AT: "1234567" }) });
  expect(diagnosticCalls).toBe(exitCode === 0 ? 0 : 1);
  expect(outcome).toMatchObject({ cellsComplete: true, observedCells: 136, isolationVerified: true,
    complete, execution: exitCode === 0 ? "SUCCEEDED" : "FAILED",
    roleRegressionsVerified: reportMode === "passed",
    roleRegressionsMeasurement: reportMode === "passed" ? "PASS" : reportMode === "skipped" ? "FAIL" : "UNAVAILABLE",
    visualReview: "UNAVAILABLE_UNTIL_LOCAL_DECRYPT_AND_INSPECTION" });
  const publication = path.join(runnerTemp, "pilot-role-audit-public");
  expect(JSON.parse(readFileSync(path.join(publication, "results.json"), "utf8"))).toEqual(outcome);
  const decoded = path.join(root, `native-orchestration-${exitCode}-${reportMode}.tar`);
  runGpg(["--output", decoded, "--decrypt", path.join(publication, "role-evidence.tar.gpg")]);
  const manifest = JSON.parse(execFileSync(tar, ["-xOf", decoded, "manifest.json"], { encoding: "utf8" }));
  expect(manifest.runContext).toEqual(outcome.runContext);
  expect(manifest.measurement).toMatchObject({ complete, execution: outcome.execution, sha, role: "OWNER" });
  expect(manifest.files.some((file: { path: string }) => file.path === "role-results.json")).toBe(reportMode === "passed" || reportMode === "skipped");
  if (reportMode === "passed" || reportMode === "skipped") {
    expect(JSON.parse(execFileSync(tar, ["-xOf", decoded, "role-results.json"], { encoding: "utf8" }))).toEqual(report);
  }
  expect(execFileSync(tar, ["-xOf", decoded, "browser.log"], { encoding: "utf8" })).toBe(canary + canary.toLowerCase() +
    (exitCode === 0 ? "" : failureMarker + "\nAttestation backend failures: request=42e39a239aecaeb1 class=RangeError category=unclassified location=unavailable\n"));
  expect(readFileSync(path.join(publication, "results.json"), "utf8")).not.toMatch(/42e39a239aecaeb1|Synthetic.QA|EXAMPLE.INVALID/);
  expect(readdirSync(runnerTemp).sort()).toEqual(["deal-scenarios-output.log", "pilot-role-audit-public"]);
  expect(readFileSync(path.join(sharedResults, "caller-owned.txt"), "utf8")).toBe("caller-owned results");
  expect(readFileSync(path.join(runnerTemp, "deal-scenarios-output.log"), "utf8")).toBe("caller-owned scenario log");
  expect(existsSync(captures)).toBe(true); // Caller-owned fixture inputs are not audit-owned cleanup.
}, 45_000);

test.each([
  { label: "missing run identity", extra: {} },
  { label: "unit workflow identity", extra: { GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "aalzriqat/Auto/.github/workflows/test.yml@refs/pull/661/merge" } },
])("CI cannot start an audit with $label", async ({ extra }) => {
  const before = readdirSync(root).sort();
  await expect(runRoleAudit({ env: auditTestEnvironment("invalidCI", { RUNNER_TEMP: root, ...extra }) }))
    .rejects.toThrow("INVALID_CONTEXT");
  expect(readdirSync(root).sort()).toEqual(before);
});

test("an unqualified native binary refuses before creating preflight files", async () => {
  const before = readdirSync(root).sort();
  await expect(runRoleAudit({ env: auditTestEnvironment("local", { RUNNER_TEMP: root, PILOT_ROLE_GPG_BINARY: "gpg" }) }))
    .rejects.toThrow("NATIVE_BINARY_UNAVAILABLE");
  expect(readdirSync(root).sort()).toEqual(before);
});

test.each(["HOST_PATH", "EMPTY_PATH"] as const)("%s native Playwright CLI failure is captured and encrypted after valid preflight", (lookup) => {
  const repo = path.join(root, `native-playwright-missing-config-${lookup}`);
  const runnerTemp = path.join(root, `native-playwright-temp-${lookup}`);
  mkdirSync(path.join(repo, ".github"), { recursive: true }); mkdirSync(runnerTemp);
  writeFileSync(path.join(repo, ".github/pilot-role-evidence-recipient.json"), JSON.stringify({ fingerprint,
    publicKey: readFileSync(publicKey, "utf8") }));
  const env = auditTestEnvironment("local", { RUNNER_TEMP: runnerTemp });
  if (lookup === "EMPTY_PATH") {
    const emptyPath = path.join(root, "empty-executable-search");
    mkdirSync(emptyPath);
    env.PATH = emptyPath;
    env.Path = emptyPath;
  }
  const cli = spawnSync(process.execPath, [path.resolve("scripts/pilotRoleAuditEvidence.mjs")], {
    cwd: repo, env, encoding: "utf8", timeout: 45_000, windowsHide: true });
  expect(cli.status).toBe(1);
  expect(cli.stdout).not.toBe("");
  const result: unknown = JSON.parse(cli.stdout.trim());
  expect(result).toMatchObject({ complete: false, observedCells: 0, execution: "FAILED" });
  const publication = path.join(runnerTemp, "pilot-role-audit-public");
  expect(readFileSync(path.join(publication, "results.json"), "utf8")).not.toContain(repo);
  const decoded = path.join(root, `native-playwright-failure-${lookup}.tar`);
  runGpg(["--output", decoded, "--decrypt", path.join(publication, "role-evidence.tar.gpg")]);
  expect(execFileSync(tar, ["-xOf", decoded, "browser.log"], { encoding: "utf8" }))
    .toContain("playwright.role-audit.config.ts");
  expect(readdirSync(runnerTemp)).toEqual(["pilot-role-audit-public"]);
  expect(existsSync(path.join(repo, "test-results"))).toBe(false);
}, 45_000);
