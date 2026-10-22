import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, createReadStream, createWriteStream, openSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SCREEN_AUDIT_ROUTES } from "../playwright/fixtures/screenAuditRoutes.ts";

const ROLES = ["OWNER", "MANAGER", "SALES", "RECEPTION", "ACCOUNTANT", "SENIOR_ACCOUNTANT"];
const LOCALES = ["en", "ar"];
const VIEWPORTS = ["desktop", "phone"];
const SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT = /^[A-F0-9]{40}$/;
const MAX_FILES = 1024;
const MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_GPG = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/gpg.exe" : "/usr/bin/gpg";
const DEFAULT_TAR = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "/usr/bin/tar";
const POWERSHELL = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const PRIVATE_FILE = /^(?:role-locale-route\.png|role-cell\.json|tenant-boundary\.json|(?:A-to-B|B-to-A)-(?:en|ar)-(?:desktop|phone)\.png)$/;
const PROBE_OPERATIONS = new Set(["foreign organization read", "foreign customer read", "foreign row under own org",
  "foreign organization update", "foreign customer delete", "foreign row delete under own org"]);
const runContextSchema = z.object({ runId: z.string().regex(/^\d+$/), attempt: z.string().regex(/^[1-9]\d*$/),
  workflowRef: z.string().regex(/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/pilot-role-audit\.yml@refs\/heads\/main$/) }).strict();

/** Bounded codes only: raw process errors and DOM text are private evidence. */
export class AuditEvidenceError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.name = "AuditEvidenceError"; }
}

/** @template T @param {() => Promise<T>} operation
 * @returns {Promise<PromiseSettledResult<T>>} */
async function settleEvidenceOperation(operation) {
  try { return { status: "fulfilled", value: await operation() }; }
  catch (reason) { return { status: "rejected", reason }; }
}

/** Cleanup always runs, but cannot replace an already measured failure.
 * @template T @param {() => Promise<T>} operation @param {() => Promise<void>} cleanup
 * @returns {Promise<T>} */
export async function withEvidenceCleanup(operation, cleanup) {
  const result = await settleEvidenceOperation(operation);
  const cleaned = await settleEvidenceOperation(cleanup);
  if (result.status === "rejected") throw result.reason;
  if (cleaned.status === "rejected") throw cleaned.reason;
  return result.value;
}

/** @param {string} directory @param {string} parent @param {string} prefix */
async function removePrivateDirectory(directory, parent, prefix) {
  const resolved = await fs.realpath(directory);
  if (path.dirname(resolved) !== await fs.realpath(parent) || !path.basename(resolved).startsWith(prefix)) {
    throw new AuditEvidenceError("UNSAFE_CLEANUP");
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

/** @param {string} directory */
async function assertFreshPublication(directory) {
  try { await fs.lstat(directory); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new AuditEvidenceError("PUBLICATION_EXISTS");
}

/** Git-for-Windows ships an MSYS GPG; native argv needs its POSIX path form.
 * @param {string} binary @param {string} file
 */
export function gpgArgumentPath(binary, file) {
  const normalized = file.replaceAll("\\", "/");
  return process.platform === "win32" && /\/Git\/usr\/bin\/gpg\.exe$/i.test(binary.replaceAll("\\", "/"))
    ? normalized.replace(/^([A-Za-z]):\//, (_match, drive) => `/${drive.toLowerCase()}/`) : normalized;
}

/** @param {string} binary @param {string} directory */
function gpgHomeArgument(binary, directory) {
  if (process.platform !== "win32" || !/\/Git\/usr\/bin\/gpg\.exe$/i.test(binary.replaceAll("\\", "/"))) {
    return gpgArgumentPath(binary, directory);
  }
  // MSYS agent sockets cannot use long workspace names. Resolve the same
  // existing directory's OS short name without interpolating paths into code.
  const result = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command",
    "$fso=New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder($env:PILOT_GPG_HOME_DIRECTORY).ShortPath"],
  { env: { ...process.env, PILOT_GPG_HOME_DIRECTORY: directory }, encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) throw new AuditEvidenceError("RECIPIENT_UNAVAILABLE");
  return gpgArgumentPath(binary, result.stdout.trim());
}

/** @param {unknown} value @param {readonly string[]} choices */
function member(value, choices) { return typeof value === "string" && choices.includes(value); }

/** @param {string} file */
async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AuditEvidenceError("UNSAFE_FILE");
  return stat;
}

/** @param {string} root */
async function captureFiles(root) {
  /** @type {string[]} */
  const files = [];
  let bytes = 0;
  let visited = 0;
  /** @param {string} directory @param {number} depth */
  async function visit(directory, depth) {
    if (depth > 16) throw new AuditEvidenceError("INVENTORY_LIMIT");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > 4096) throw new AuditEvidenceError("INVENTORY_LIMIT");
      if (entry.isSymbolicLink()) throw new AuditEvidenceError("UNSAFE_FILE");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (PRIVATE_FILE.test(entry.name)) {
        const stat = await regularFile(file);
        bytes += stat.size;
        files.push(file);
        if (files.length > MAX_FILES || bytes > MAX_BYTES || stat.size > 64 * 1024 * 1024) throw new AuditEvidenceError("INVENTORY_LIMIT");
      }
    }
  }
  await visit(root, 0);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

const cellSchema = z.object({
  sha: z.string().regex(SHA), route: z.enum(SCREEN_AUDIT_ROUTES), locale: z.enum(["en", "ar"]),
  viewport: z.object({ name: z.enum(["desktop", "phone"]) }),
  role: z.object({ roleName: z.string() }), observed: z.literal("MATCHED"),
  requestedPath: z.string(), expectedPath: z.string(), observedPath: z.string(),
  expected: z.enum(["ALLOWED_ROUTE", "DENIED_ROUTE"]),
});
const isolationSchema = z.object({
  sha: z.string().regex(SHA), auditedRoleBeforeIsolation: z.string(),
  actualProbeRoles: z.object({ A: z.literal("OWNER"), B: z.literal("OWNER") }),
  stateUnchanged: z.literal(true),
  attempts: z.array(z.object({ direction: z.enum(["A to B", "B to A"]), operation: z.string(), outcome: z.literal("REFUSED") })).length(12),
});

/** @param {string} image @param {string[]} files */
async function assertCapturePng(image, files) {
  if (!files.includes(image) || (await regularFile(image)).size < 8) throw new AuditEvidenceError("MISSING_IMAGE");
  const handle = await fs.open(image, "r");
  const signature = Buffer.alloc(8);
  try { await handle.read(signature, 0, 8, 0); } finally { await handle.close(); }
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new AuditEvidenceError("INVALID_IMAGE");
}

/** Project only fixed labels and measured booleans, never spread a private row.
 * @param {string[]} files @param {string} role @param {string} sha
 */
export async function publicAuditSummary(files, role, sha) {
  if (!member(role, ROLES) || !SHA.test(sha)) throw new AuditEvidenceError("INVALID_CONTEXT");
  const seen = new Set();
  /** @type {{ route: string, locale: string, viewport: string, destinationMatched: true, access: string }[]} */
  const cells = [];
  for (const file of files.filter((candidate) => path.basename(candidate) === "role-cell.json")) {
    if ((await regularFile(file)).size > 64 * 1024) throw new AuditEvidenceError("INVALID_CELL");
    const parsed = cellSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
    if (!parsed.success) throw new AuditEvidenceError("INVALID_CELL");
    const row = parsed.data;
    const identity = `${row.route}:${row.locale}:${row.viewport.name}`;
    if (row.sha !== sha || row.role.roleName !== role || row.expectedPath !== row.observedPath || seen.has(identity)) {
      throw new AuditEvidenceError("INVALID_CELL");
    }
    const image = path.join(path.dirname(file), "role-locale-route.png");
    await assertCapturePng(image, files);
    seen.add(identity);
    cells.push({ route: row.route, locale: row.locale, viewport: row.viewport.name, destinationMatched: true, access: row.expected });
  }
  const isolationFiles = files.filter((file) => path.basename(file) === "tenant-boundary.json");
  if (isolationFiles.length > 1) throw new AuditEvidenceError("INVALID_ISOLATION");
  let isolationVerified = false;
  if (isolationFiles.length === 1) {
    const file = isolationFiles[0];
    if ((await regularFile(file)).size > 64 * 1024) throw new AuditEvidenceError("INVALID_ISOLATION");
    const parsed = isolationSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
    if (!parsed.success || parsed.data.sha !== sha || parsed.data.auditedRoleBeforeIsolation !== role) throw new AuditEvidenceError("INVALID_ISOLATION");
    const identities = new Set(parsed.data.attempts.map((attempt) => `${attempt.direction}:${attempt.operation}`));
    if (identities.size !== 12 || parsed.data.attempts.some((attempt) => !PROBE_OPERATIONS.has(attempt.operation))) throw new AuditEvidenceError("INVALID_ISOLATION");
    for (const direction of ["A-to-B", "B-to-A"]) for (const locale of LOCALES) for (const viewport of VIEWPORTS) {
      const image = path.join(path.dirname(file), `${direction}-${locale}-${viewport}.png`);
      await assertCapturePng(image, files);
    }
    isolationVerified = true;
  }
  return { schemaVersion: 1, sha, role, expectedCells: SCREEN_AUDIT_ROUTES.length * LOCALES.length * VIEWPORTS.length,
    observedCells: cells.length, complete: isolationVerified && cells.length === SCREEN_AUDIT_ROUTES.length * LOCALES.length * VIEWPORTS.length,
    cells, isolationVerified, isolationScope: "ORGANIZATION_AND_CUSTOMER_RELATIONS_ONLY",
    visualReview: "UNAVAILABLE_UNTIL_LOCAL_DECRYPT_AND_INSPECTION" };
}

/** @param {string} binary @param {string[]} args */
function nativeOutput(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.status !== 0 || result.error) throw new AuditEvidenceError("RECIPIENT_UNAVAILABLE");
  return result.stdout;
}

/** Native GPG parses the key; names/email substrings never select a recipient.
 * @param {{gpgBinary: string, keyHome: string, publicKey: string, fingerprint: string, now?: number}} options
 */
export async function importAuditRecipient({ gpgBinary, keyHome, publicKey, fingerprint, now = Date.now() }) {
  if (!path.isAbsolute(gpgBinary) || !FINGERPRINT.test(fingerprint)) throw new AuditEvidenceError("RECIPIENT_UNAVAILABLE");
  await regularFile(publicKey);
  await fs.mkdir(keyHome, { recursive: true, mode: 0o700 });
  const homeArgument = gpgHomeArgument(gpgBinary, keyHome);
  const base = ["--homedir", homeArgument, "--batch", "--no-tty"];
  const preview = nativeOutput(gpgBinary, [...base, "--with-colons", "--import-options", "show-only", "--import", gpgArgumentPath(gpgBinary, publicKey)]);
  const rows = preview.split(/\r?\n/).map((line) => line.split(":"));
  const primary = rows.filter((row) => row[0] === "pub");
  const firstFingerprint = rows.find((row) => row[0] === "fpr")?.[9];
  const usable = (/** @type {string[]} */ row) => !["r", "e", "d"].includes(row[1]) &&
    Number(row[2]) >= 3072 && row[3] === "1" && Number(row[5]) * 1000 <= now &&
    (row[6] === "" || row[6] === "0" || Number(row[6]) * 1000 > now);
  const encryptionIndex = rows.findIndex((row) => row[0] === "sub" && usable(row) && row[11]?.includes("e"));
  const encryptionFingerprint = encryptionIndex >= 0 && rows[encryptionIndex + 1]?.[0] === "fpr" ? rows[encryptionIndex + 1][9] : "";
  if (primary.length !== 1 || firstFingerprint !== fingerprint || !usable(primary[0]) || !FINGERPRINT.test(encryptionFingerprint)) {
    throw new AuditEvidenceError("RECIPIENT_UNAVAILABLE");
  }
  nativeOutput(gpgBinary, [...base, "--import", gpgArgumentPath(gpgBinary, publicKey)]);
  return { homeArgument, encryptionFingerprint };
}

/** @param {import("node:child_process").ChildProcess} child */
function completed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new AuditEvidenceError("ENCRYPTION_FAILED")));
    child.once("close", (code) => code === 0 ? resolve(undefined) : reject(new AuditEvidenceError("ENCRYPTION_FAILED")));
  });
}

/** Archive only copies made by this invocation, streaming directly into GPG.
 * @param {{resultsRoot: string, privateLog: string, publicRoot: string, role: string, sha: string,
 * publicKey: string, fingerprint: string, gpgBinary?: string, tarBinary?: string,
 * execution?: "SUCCEEDED" | "FAILED" | "UNAVAILABLE",
 * runContext?: {runId: string, attempt: string, workflowRef: string}}} options
 */
export async function packageAuditEvidence({ resultsRoot, privateLog, publicRoot, role, sha, publicKey, fingerprint,
  gpgBinary = DEFAULT_GPG, tarBinary = DEFAULT_TAR, execution = "UNAVAILABLE", runContext }) {
  if (!member(role, ROLES) || !SHA.test(sha) || !member(execution, ["SUCCEEDED", "FAILED", "UNAVAILABLE"]) ||
      (runContext && !runContextSchema.safeParse(runContext).success)) {
    throw new AuditEvidenceError("INVALID_CONTEXT");
  }
  if (!path.isAbsolute(gpgBinary) || !path.isAbsolute(tarBinary)) throw new AuditEvidenceError("NATIVE_BINARY_UNAVAILABLE");
  const output = path.resolve(publicRoot);
  // A caller must supply a fresh publication directory. Never reuse stale evidence.
  await assertFreshPublication(output);
  const staging = await fs.mkdtemp(path.join(path.dirname(output), ".role-evidence-private-"));
  const archiveRoot = path.join(staging, "archive");
  const keyHome = path.join(staging, "public-keyring");
  const publication = path.join(staging, "publication");
  const ciphertext = path.join(publication, "role-evidence.tar.gpg");
  let keyHomeArgument = "";
  return withEvidenceCleanup(async () => {
   try {
    const recipient = await importAuditRecipient({ gpgBinary, keyHome, publicKey, fingerprint });
    keyHomeArgument = recipient.homeArgument;
    const sourceRoot = await fs.realpath(resultsRoot);
    // Failed cells can leave incomplete JSON/images. Preserve their encrypted
    // diagnostic evidence while refusing to publish a successful measurement.
    /** @type {AuditEvidenceError | undefined} */
    let validationError;
    /** @type {string[]} */
    let files = [];
    try { files = await captureFiles(sourceRoot); }
    catch (error) { validationError = error instanceof AuditEvidenceError ? error : new AuditEvidenceError("EVIDENCE_UNAVAILABLE"); }
    let logBytes = Buffer.from("Browser log unavailable.\n");
    let logTruncated = false;
    try {
      const logStat = await regularFile(privateLog);
      const length = Math.min(logStat.size, 32 * 1024 * 1024);
      logTruncated = length !== logStat.size;
      const handle = await fs.open(privateLog, "r");
      logBytes = Buffer.alloc(length);
      try {
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(logBytes, read, length - read, logStat.size - length + read);
          if (bytesRead === 0) throw new AuditEvidenceError("EVIDENCE_UNAVAILABLE");
          read += bytesRead;
        }
      } finally { await handle.close(); }
      if (logTruncated) validationError ??= new AuditEvidenceError("INVENTORY_LIMIT");
    } catch (error) { validationError ??= error instanceof AuditEvidenceError ? error : new AuditEvidenceError("EVIDENCE_UNAVAILABLE"); }
    const sizes = await Promise.all(files.map(async (file) => (await regularFile(file)).size));
    if (sizes.reduce((sum, size) => sum + size, 0) + logBytes.length > MAX_BYTES) {
      files = [];
      validationError ??= new AuditEvidenceError("INVENTORY_LIMIT");
    }
    let summary;
    try {
      if (validationError) throw validationError;
      summary = await publicAuditSummary(files, role, sha);
    }
    catch (error) {
      validationError = error instanceof AuditEvidenceError ? error : new AuditEvidenceError("EVIDENCE_UNAVAILABLE");
      summary = { schemaVersion: 1, sha, role, expectedCells: SCREEN_AUDIT_ROUTES.length * LOCALES.length * VIEWPORTS.length,
        observedCells: 0, complete: false, cells: [], isolationVerified: false,
        isolationScope: "ORGANIZATION_AND_CUSTOMER_RELATIONS_ONLY",
        visualReview: "UNAVAILABLE_UNTIL_LOCAL_DECRYPT_AND_INSPECTION", measurement: "UNAVAILABLE", reason: validationError.message };
    }
    summary = { ...summary, cellsComplete: summary.complete, complete: execution === "SUCCEEDED" && summary.complete, execution,
      runContext: runContext ?? "UNAVAILABLE" };
    await fs.mkdir(path.join(archiveRoot, "captures"), { recursive: true, mode: 0o700 });
    /** @type {{path: string, bytes: number, sha256: string}[]} */
    const manifest = [];
    for (const file of files) {
      const relative = path.relative(sourceRoot, file);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new AuditEvidenceError("UNSAFE_FILE");
      const destination = path.join(archiveRoot, "captures", relative);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.copyFile(file, destination);
      const bytes = await fs.readFile(destination);
      manifest.push({ path: `captures/${relative.replaceAll(path.sep, "/")}`, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    await fs.writeFile(path.join(archiveRoot, "browser.log"), logBytes, { mode: 0o600 });
    manifest.push({ path: "browser.log", bytes: logBytes.length, sha256: createHash("sha256").update(logBytes).digest("hex") });
    await fs.writeFile(path.join(archiveRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, sha, role, files: manifest,
      runContext: runContext ?? "UNAVAILABLE", measurement: summary,
      diagnostic: { logTruncated, captureInventoryAccepted: !validationError, refusal: validationError?.message ?? null } }), { mode: 0o600 });
    await fs.mkdir(publication, { mode: 0o700 });
    const diagnostics = createWriteStream(path.join(staging, "encryption.log"), { mode: 0o600 });
    const tar = spawn(tarBinary, ["-cf", "-", "-C", archiveRoot, "captures", "browser.log", "manifest.json"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, windowsHide: true });
    const gpg = spawn(gpgBinary, ["--homedir", keyHomeArgument, "--batch", "--no-tty", "--trust-model", "always",
      "--recipient", `${recipient.encryptionFingerprint}!`, "--cipher-algo", "AES256", "--output", gpgArgumentPath(gpgBinary, ciphertext), "--encrypt"],
    { stdio: ["pipe", "ignore", "pipe"], timeout: 120_000, windowsHide: true });
    tar.stderr?.pipe(diagnostics, { end: false });
    gpg.stderr?.pipe(diagnostics, { end: false });
    await withEvidenceCleanup(async () => {
     try {
      if (!tar.stdout || !gpg.stdin) throw new AuditEvidenceError("ENCRYPTION_FAILED");
      await Promise.all([completed(tar), completed(gpg), pipeline(tar.stdout, gpg.stdin)]);
     } catch {
      tar.kill(); gpg.kill();
      throw new AuditEvidenceError("ENCRYPTION_FAILED");
     }
    }, async () => { diagnostics.end(); await finished(diagnostics); });
    if ((await regularFile(ciphertext)).size === 0) throw new AuditEvidenceError("ENCRYPTION_FAILED");
    const cipherHash = createHash("sha256");
    for await (const chunk of createReadStream(ciphertext)) cipherHash.update(chunk);
    summary = { ...summary, ciphertextSha256: cipherHash.digest("hex") };
    await fs.writeFile(path.join(publication, "results.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
    const publicFiles = await fs.readdir(publication);
    if (publicFiles.length !== 2 || !publicFiles.includes("results.json") || !publicFiles.includes("role-evidence.tar.gpg")) {
      throw new AuditEvidenceError("EVIDENCE_UNAVAILABLE");
    }
    await regularFile(path.join(publication, "results.json"));
    await regularFile(ciphertext);
    // Both files become visible together on this runner's filesystem. Never
    // copy individual files to the final paths, including on rename failure.
    await assertFreshPublication(output);
    await fs.rename(publication, output);
    if (validationError) throw validationError;
    return summary;
   } catch (error) {
    throw error instanceof AuditEvidenceError ? error : new AuditEvidenceError("EVIDENCE_UNAVAILABLE");
   }
  }, async () => {
    if (keyHomeArgument) {
      const gpgconf = path.join(path.dirname(gpgBinary), process.platform === "win32" ? "gpgconf.exe" : "gpgconf");
      spawnSync(gpgconf, ["--homedir", keyHomeArgument, "--kill", "all"], { timeout: 10_000, windowsHide: true, stdio: "ignore" });
    }
    // This is the private staging directory this function itself just created.
    await removePrivateDirectory(staging, path.dirname(output), ".role-evidence-private-");
  });
}

/** Capture from process start. Neither a child error nor stderr reaches a public
 * console; the caller reports only the bounded exit classification.
 * @param {{ command: string, args: string[], cwd: string, logFile: string, env: NodeJS.ProcessEnv, timeout?: number }} options
 */
export function captureAuditProcess({ command, args, cwd, logFile, env, timeout = 45 * 60 * 1000 }) {
  const descriptor = openSync(logFile, "w", 0o600);
  try {
    const result = spawnSync(command, args, { cwd, env, stdio: ["ignore", descriptor, descriptor], timeout, windowsHide: true });
    return { execution: result.status === 0 && !result.error ? "SUCCEEDED" : "FAILED", exitCode: result.status };
  } finally { closeSync(descriptor); }
}

/** The committed recipient is public data; its fingerprint is independently
 * compared with owner-held custody during source review. No private key in CI.
 */
const recipientSchema = z.object({ fingerprint: z.string().regex(FINGERPRINT),
  publicKey: z.string().startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----").max(64 * 1024) }).strict();

/** Native orchestration. The browser entry point is injectable only by direct
 * module callers for synthetic controls; the CLI always resolves Playwright.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, browserCli?: string}} options
 */
export async function runRoleAudit({ cwd = process.cwd(), env = process.env, browserCli } = {}) {
  const role = env.HUNT_AUDIT_ROLE ?? "";
  const sha = env.GITHUB_SHA ?? "";
  if (!member(role, ROLES) || !SHA.test(sha) || !env.RUNNER_TEMP) throw new AuditEvidenceError("INVALID_CONTEXT");
  const reportedRun = runContextSchema.safeParse({ runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, workflowRef: env.GITHUB_WORKFLOW_REF });
  if (env.GITHUB_ACTIONS === "true" && !reportedRun.success) throw new AuditEvidenceError("INVALID_CONTEXT");
  const gpgBinary = env.PILOT_ROLE_GPG_BINARY ?? DEFAULT_GPG;
  if (!path.isAbsolute(gpgBinary)) throw new AuditEvidenceError("NATIVE_BINARY_UNAVAILABLE");
  const runnerTemp = await fs.realpath(env.RUNNER_TEMP);
  const preflight = await fs.mkdtemp(path.join(runnerTemp, ".role-evidence-preflight-"));
  const privateLog = path.join(runnerTemp, "deal-scenarios-output.log");
  const publicRoot = path.join(runnerTemp, "pilot-role-audit-public");
  let homeArgument = "";
  return withEvidenceCleanup(async () => {
    const recipient = recipientSchema.safeParse(JSON.parse(await fs.readFile(path.join(cwd, ".github/pilot-role-evidence-recipient.json"), "utf8")));
    if (!recipient.success) throw new AuditEvidenceError("RECIPIENT_UNAVAILABLE");
    const publicKey = path.join(preflight, "recipient.asc");
    await fs.writeFile(publicKey, recipient.data.publicKey, { mode: 0o600 });
    homeArgument = (await importAuditRecipient({ gpgBinary, keyHome: path.join(preflight, "keyring"), publicKey,
      fingerprint: recipient.data.fingerprint })).homeArgument;
    const require = createRequire(import.meta.url);
    const playwright = browserCli ?? require.resolve("@playwright/test/cli");
    const result = captureAuditProcess({ command: process.execPath,
      args: [playwright, "test", "-c", "playwright.role-audit.config.ts", "--workers=1"], cwd, logFile: privateLog, env });
    // Playwright may fail before creating test-results; an empty directory keeps
    // the encrypted failure log available but cannot become complete evidence.
    await fs.mkdir(path.join(cwd, "test-results"), { recursive: true });
    const summary = await packageAuditEvidence({ resultsRoot: path.join(cwd, "test-results"), privateLog, publicRoot, role, sha,
      publicKey, fingerprint: recipient.data.fingerprint, gpgBinary, execution: result.execution === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      runContext: reportedRun.success ? reportedRun.data : undefined });
    return summary;
  }, async () => {
    if (homeArgument) {
      const gpgconf = path.join(path.dirname(gpgBinary), process.platform === "win32" ? "gpgconf.exe" : "gpgconf");
      spawnSync(gpgconf, ["--homedir", homeArgument, "--kill", "all"], { timeout: 10_000, windowsHide: true, stdio: "ignore" });
    }
    await removePrivateDirectory(preflight, runnerTemp, ".role-evidence-preflight-");
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const summary = await runRoleAudit();
    console.log(JSON.stringify({ role: summary.role, execution: summary.execution, observedCells: summary.observedCells,
      expectedCells: summary.expectedCells, complete: summary.complete, isolationVerified: summary.isolationVerified,
      visualReview: "UNAVAILABLE_UNTIL_LOCAL_DECRYPT_AND_INSPECTION" }));
    if (!summary.complete) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ execution: "UNAVAILABLE", reason: error instanceof AuditEvidenceError ? error.message : "EVIDENCE_UNAVAILABLE" }));
    process.exitCode = 1;
  }
}
