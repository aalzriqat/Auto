/**
 * SCRUM-313 — the CLOUD Accounting rehearsal, run inside GitHub Actions against
 * a disposable Convex PREVIEW deployment.
 *
 * ## Why this exists when `convex/accountingReleaseRehearsal.test.ts` already does
 *
 * That file says so itself: it runs on `convex-test`, which establishes
 * REPOSITORY BEHAVIOUR only. It serialises everything and models no OCC, so
 * there is one class of claim it structurally cannot make —
 *
 *     two release attempts IN FLIGHT TOGETHER against ONE unchanged free
 *     balance must not pay that balance twice
 *
 * — and that is exactly the claim `deposits.release` now rests on, because its
 * command identity is GENERATION-AWARE: safety comes from `releaseCount`
 * advancing inside the same patch that moves the money. Under a serial harness
 * the generation always advances before the next call is even constructed. Only
 * a real backend can interleave them.
 *
 * ## ⚠️ THIS SCRIPT REFUSES RATHER THAN DEGRADES
 *
 * Every precondition below is checked before a single fixture row is written,
 * and each failure exits non-zero with the reason. There is deliberately NO
 * fallback to a shared dev deployment, to local, or to production: the failure
 * mode this guards against is not "the rehearsal did not run", it is "the
 * rehearsal ran somewhere else and reported success".
 *
 * Concretely, before any write:
 *   1. the deploy key must be PREVIEW-shaped (`isPreviewDeployKey`);
 *   2. an explicit preview name must be present;
 *   3. the deployment must carry the `e2eBootstrap` PREVIEW MARKER;
 *   4. the deployment's own recorded URL must equal the URL this script drives.
 *
 * (3) and (4) are the ones that matter most. A preview key plus a name still
 * only proves "some preview"; the marker plus the URL agreement prove it is
 * THIS one. `convex/e2eBootstrap.ts` documents the marker's own controls.
 *
 * ## Authentication is REAL, not bypassed
 *
 * Economic mutations require a Clerk identity, and no test backdoor is added
 * for this rehearsal — adding one would put a production-callable auth bypass
 * in the tree to prove that money is safe, which is not a trade worth making.
 * Instead the two dedicated Clerk TEST-MODE identities already used by the E2E
 * suite are issued genuine session tokens through Clerk's Backend API, minted
 * against the `convex` JWT template that `convex/auth.config.ts` names.
 *
 * ## Evidence, not exit codes
 *
 * Every case emits a record. HTTP success is never treated as proof: each case
 * reads the resulting economic state back — released amount, `releaseCount`,
 * canonical payments, ledger effects, remaining balance — and asserts on that.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createHash } from "node:crypto";
import { assertPreviewTargeting, buildConvexRunArgs, isPreviewDeployKey, runConvex } from "./e2ePreviewBootstrap.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class RehearsalError extends Error {
  constructor(message) {
    super(message);
    this.name = "RehearsalError";
  }
}

/**
 * Fail-closed environment check.
 *
 * Returns the resolved config or throws. Never defaults a target: an absent or
 * ambiguous value is a refusal, because every "sensible default" here resolves
 * to somebody else's database.
 */
export function assertRehearsalEnv(env) {
  const missing = [];
  for (const key of [
    "CONVEX_DEPLOY_KEY",
    "CONVEX_PREVIEW_NAME",
    "NEXT_PUBLIC_CONVEX_URL",
    "CLERK_SECRET_KEY",
    "E2E_LOGIN_USER",
    "E2E_APPROVER_USER",
  ]) {
    if (!env[key] || String(env[key]).trim() === "") missing.push(key);
  }
  if (missing.length > 0) {
    throw new RehearsalError(
      `The rehearsal cannot run without ${missing.join(", ")}. It refuses rather than falling back to any ` +
        `other deployment: an unnamed or unauthenticated target resolves to shared infrastructure, and a ` +
        `rehearsal that silently ran elsewhere is worse than one that did not run.`
    );
  }
  if (!isPreviewDeployKey(env.CONVEX_DEPLOY_KEY)) {
    throw new RehearsalError(
      "CONVEX_DEPLOY_KEY is not a PREVIEW deploy key. A prod, dev, project or bare admin key is refused here " +
        "before any argument is assembled — this script must never be able to reach a real deployment."
    );
  }
  const url = String(env.NEXT_PUBLIC_CONVEX_URL).trim();
  if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud\/?$/.test(url)) {
    throw new RehearsalError(
      `NEXT_PUBLIC_CONVEX_URL (${url}) is not a Convex cloud deployment URL. Refusing rather than guessing.`
    );
  }
  return {
    deployKey: env.CONVEX_DEPLOY_KEY,
    previewName: env.CONVEX_PREVIEW_NAME,
    convexUrl: url.replace(/\/$/, ""),
    clerkSecret: env.CLERK_SECRET_KEY,
    salesEmail: env.E2E_LOGIN_USER,
    approverEmail: env.E2E_APPROVER_USER,
  };
}

/**
 * The preview name for a rehearsal run.
 *
 * Deliberately derived from a REHEARSAL-SCOPED ref string rather than the bare
 * ref. `--preview-create` DELETES the named deployment, so the name is a
 * destructive resource key: it must collide only when this workflow's
 * concurrency group collides. Sharing the browser suite's name would mean this
 * job destroys that job's backend mid-suite, which is precisely the failure the
 * Playwright workflow's own naming comment records.
 */
export function rehearsalRefScope(ref) {
  return `rehearsal/${String(ref ?? "").replace(/^\/+/, "")}`;
}

/** `{status:"success"|"error"}` from Convex's HTTP API, normalised. */
export async function convexCall(
  { convexUrl, token, kind, path: fnPath, args },
  fetchImpl = fetch
) {
  const response = await fetchImpl(`${convexUrl}/api/${kind}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ path: fnPath, args: args ?? {}, format: "json" }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RehearsalError(
      `${fnPath} returned a non-JSON response (HTTP ${response.status}). The rehearsal treats this as a hard ` +
        `failure rather than a retryable one, because it usually means the URL is not a Convex deployment.`
    );
  }
  if (body.status === "success") return { ok: true, value: body.value };
  return {
    ok: false,
    // ConvexError payloads arrive under errorData; plain throws under errorMessage.
    error: String(body.errorData?.message ?? body.errorData ?? body.errorMessage ?? "unknown error"),
    // Additive: the machine code of a coded refusal, so an expected-refusal case can assert the specific code.
    ...(typeof body.errorData?.code === "string" ? { errorCode: body.errorData.code } : {}),
  };
}

/**
 * The product's tenant write limiter rejects BEFORE the handler's first write.
 * A real rehearsal can legitimately exhaust that bucket because it drives many
 * supported create mutations in one short burst. Retrying ONLY that exact
 * refusal keeps the rehearsal about business invariants instead of runner
 * timing, while every other Convex error remains evidence immediately.
 */
export function rateLimitRetryDelayMs(error) {
  const match = /^Rate limit exceeded\. Try again in (\d+)s$/.exec(String(error ?? "").trim());
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  // Token-bucket retryAfter can land on a boundary; add a small deterministic
  // cushion so the retry does not arrive a few milliseconds before refill.
  return Math.min(Math.max(seconds * 1000, 250) + 250, 6250);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function convexCallWithRateLimitRetry(
  spec,
  { fetchImpl = fetch, sleepImpl = sleep, maxAttempts = 5 } = {}
) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new RehearsalError("maxAttempts must be an integer from 1 through 10.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await convexCall(spec, fetchImpl);
    if (result.ok) return result;

    const delayMs = rateLimitRetryDelayMs(result.error);
    if (delayMs === null || attempt === maxAttempts) return result;
    await sleepImpl(delayMs);
  }

  throw new RehearsalError("rate-limit retry loop terminated unexpectedly");
}

/** Same, but a failure is fatal — for steps whose success later cases depend on. */
export async function mustCall(spec, fetchImpl = fetch, sleepImpl = sleep) {
  const result = await convexCallWithRateLimitRetry(spec, { fetchImpl, sleepImpl });
  if (!result.ok) {
    throw new RehearsalError(`${spec.path} failed: ${result.error}`);
  }
  return result.value;
}

/** Clerk's own session-id shape. Narrow on purpose: this value reaches a URL path. */
export function isClerkSessionId(value) {
  return typeof value === "string" && /^sess_[A-Za-z0-9]{8,64}$/.test(value);
}

/**
 * Returns a session id REBUILT from the characters that matched, or null.
 *
 * Not the same thing as testing and then using the original string, and the
 * difference is the point. A `test()` guard leaves the tainted value itself
 * flowing into the URL — Sonar's taint analysis still flags it (S7044/S8476),
 * and it is right to, because the guard and the use are two separate facts that
 * a later edit can silently pull apart. Reconstructing from the capture group
 * means the value that reaches the URL is, by construction, only ever
 * `sess_` followed by characters this regex admitted.
 */
export function sanitizeClerkSessionId(value) {
  const match = /^sess_([A-Za-z0-9]{8,64})$/.exec(typeof value === "string" ? value : "");
  if (match === null) return null;
  let rebuilt = "sess_";
  for (const character of match[1]) {
    const index = CLERK_ID_ALPHABET.indexOf(character);
    if (index < 0) return null;
    rebuilt += CLERK_ID_ALPHABET[index];
  }
  return rebuilt;
}

/**
 * The only characters a Clerk id may contribute to a URL path.
 *
 * Used as a lookup TABLE, not as a test: each output character is read out of
 * this literal, and the input only chooses the index. That is a stronger
 * statement than "the input matched a pattern" — the value that reaches the
 * network is built entirely from characters written in this file.
 */
export const CLERK_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** The only URL shape this rehearsal will ever send a mutation to. */
export function isPreviewCloudUrl(value) {
  return typeof value === "string" && /^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(value);
}

/**
 * A genuine Clerk session token for one TEST-MODE identity.
 *
 * Two calls, both Backend API: create a session for the user, then mint a JWT
 * from the `convex` template — the template name is not a guess, it is the
 * `applicationID` in `convex/auth.config.ts`, which is what the deployment
 * validates the token's audience against.
 */
export async function mintConvexToken({ userId, secretKey }, fetchImpl = fetch) {
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
  };
  const sessionResponse = await fetchImpl("https://api.clerk.com/v1/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: userId }),
  });
  if (!sessionResponse.ok) {
    const detail = await sessionResponse.text();
    throw new RehearsalError(
      `Clerk refused to create a session for the rehearsal identity (HTTP ${sessionResponse.status}). ` +
        `This is reported rather than worked around: the alternative would be a test-only auth bypass in the ` +
        `product, which is not an acceptable price for this evidence. Detail: ${detail.slice(0, 300)}`
    );
  }
  const session = await sessionResponse.json();
  // The session id comes back from a REMOTE server and is then interpolated
  // into a URL PATH. Sonar flags that as SSRF-shaped (jssecurity:S7044/S8476)
  // and it is right to: a response is not trustworthy input just because the
  // host is. An id containing `../` or a scheme would redirect this
  // authenticated request somewhere else entirely, with the Clerk secret
  // attached. Validated against Clerk's own id shape, and refused otherwise.
  // ⚠️ VALIDATED INLINE, and the duplication with `sanitizeClerkSessionId` is
  // deliberate. Sonar's taint analysis does not follow the guarantee across a
  // helper boundary: with the check in a function, S7044/S8476 stayed OPEN
  // through two attempts to satisfy them. That is not the analyser being
  // pedantic — a validated value returned from elsewhere IS just a string here,
  // and nothing at this line makes the guarantee visible to a reader either.
  // The exported helper stays because it is what the unit tests drive.
  const rawSessionId = typeof session?.id === "string" ? session.id : "";
  const sessionMatch = /^sess_([A-Za-z0-9]{8,64})$/.exec(rawSessionId);
  if (sessionMatch === null) {
    throw new RehearsalError(
      `Clerk returned a session id that does not match the expected \`sess_…\` shape. Refusing to build a ` +
        `request URL from it rather than trusting a remote response to be well-formed.`
    );
  }
  // The shape check and the encoder were both true and both insufficient, and
  // the reason is worth stating: each one describes the REMOTE value. The regex
  // says what it may be, `encodeURIComponent` says what it may mean inside a
  // path — but the string travelling to Clerk was still, at every step, the one
  // that came back over the wire.
  //
  // This loop is a different claim. Every character appended below is read out
  // of a LITERAL in this file; the response only selects which index. So the
  // value that reaches the URL is not a validated remote string, it is a string
  // this file wrote — and that is the property both the analyser and the next
  // reader can check locally, without trusting a guard twenty lines up.
  let sessionSegment = "sess_";
  for (const character of sessionMatch[1]) {
    const index = CLERK_ID_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new RehearsalError(
        `Clerk returned a session id containing a character outside the permitted alphabet. Refusing to ` +
          `build a request URL from it.`
      );
    }
    sessionSegment += CLERK_ID_ALPHABET[index];
  }
  const tokenResponse = await fetchImpl(
    `https://api.clerk.com/v1/sessions/${sessionSegment}/tokens/convex`,
    { method: "POST", headers }
  );
  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    throw new RehearsalError(
      `Clerk created a session but refused a \`convex\` template token (HTTP ${tokenResponse.status}). ` +
        `The template name comes from \`applicationID\` in convex/auth.config.ts. Detail: ${detail.slice(0, 300)}`
    );
  }
  const minted = await tokenResponse.json();
  if (!minted.jwt) {
    throw new RehearsalError("Clerk returned no JWT for the `convex` template.");
  }
  return { jwt: minted.jwt, sessionId: session.id };
}

/** Resolves a Clerk email to its user id, reusing the E2E bootstrap's resolver. */
export async function resolveIdentity(email, secretKey) {
  const { resolveClerkUserId } = await import("./e2ePreviewBootstrap.mjs");
  return resolveClerkUserId({ email, secretKey });
}

/**
 * Runs one preview-targeted `convex run` through the REVIEWED argv builder and
 * runner, rather than assembling the command here.
 *
 * That is deliberate. `buildConvexRunArgs` is what makes `--preview-name`
 * un-droppable, and `runConvex` re-validates every argument at the point a
 * process is actually started, refusing anything option-shaped it did not
 * expect. Hand-rolling the spawn in this file would inherit neither guarantee,
 * and the failure it protects against — `convex run` silently resolving an
 * unspecified target to the shared DEV deployment — is exactly the one this
 * rehearsal must never hit.
 *
 * @param {{
 *   functionName: string,
 *   args: Record<string, unknown>,
 *   previewName: string,
 *   deployKey: string,
 *   env?: Record<string, string | undefined>,
 *   spawnCli?: (command: string, args: string[], options: object) => { status: number | null, error?: Error },
 * }} options
 */
export async function runPreviewFunction({ functionName, args, previewName, deployKey, env = process.env, spawnCli = spawnSync }) {
  const { buildConvexRunArgs, runConvex } = await import("./e2ePreviewBootstrap.mjs");
  const argv = buildConvexRunArgs({
    functionName,
    argsJson: JSON.stringify(args ?? {}),
    previewName,
    deployKey,
    env,
  });
  // The assertion returns bootstrap JSON on stdout. The release workflow
  // reserves this process's stdout for its single evidence document; letting
  // the child inherit it produced two adjacent JSON objects and a red verdict
  // after all 22 cloud cases passed. Keep stderr visible and retain runConvex's
  // argument/exit checks while capturing only this child command's stdout.
  runConvex(argv, functionName, (command, commandArgs, options) =>
    spawnCli(command, commandArgs, { ...options, stdio: ["inherit", "pipe", "inherit"] }));
}

/** @typedef {"DISCOVERY" | "REFERENCE"} CleanupSplitPhase */
/** @typedef {{ok:true,value:unknown} | {ok:false,refusal:"OPENING_CLEANUP_SPLIT_REQUIRED",phase:CleanupSplitPhase,exitCode:number}} CleanupPreviewReceipt */
/** @typedef {{status:number|null,stdout?:string|Buffer|null,stderr?:string|Buffer|null,error?:Error,signal?:string|null}} CleanupCliResult */
const CLEANUP_FUNCTIONS = new Set([
  "e2eBootstrap:prepareOpeningCleanupFixture",
  "e2eBootstrap:observeOpeningCleanupFixture",
  "orgFinancialReset:resetOrgFinancialData",
  "adminOrgs:runDeletionRequestBatch",
]);
const CLEANUP_OUTPUT_LIMIT = 262_144;
/** Fixed fixture refusals the server may state; the code is the only thing retained, never the stream. */
const CLEANUP_SERVER_REFUSALS = new Map([
  ["invalid cleanup fixture scope.", "INVALID_SCOPE"],
  ["cleanup membership inventory is incomplete.", "INVENTORY_INCOMPLETE"],
  ["cleanup requires the two active QA identities.", "IDENTITIES_UNAVAILABLE"],
  ["cleanup QA baseline is unavailable.", "BASELINE_UNAVAILABLE"],
  ["unexpected cleanup QA membership.", "UNEXPECTED_MEMBERSHIP"],
  ["cleanup requires a newly created QA fixture.", "FIXTURE_NOT_NEW"],
  ["cleanup fixture cannot be reused.", "FIXTURE_REUSED"],
  ["cleanup fixture already has a lifecycle owner.", "LIFECYCLE_OWNED"],
  ["cleanup reference scan is not ready.", "REFERENCE_NOT_READY"],
  ["cleanup fixture was already removed.", "FIXTURE_REMOVED"],
  ["cleanup organization is missing.", "ORG_MISSING"],
]);
const cleanupUnavailable = (cleanupReason = "INVOCATION_UNAVAILABLE") => Object.assign(
  new RehearsalError("Cleanup preview invocation is UNAVAILABLE."), { cleanupReason });
/** @typedef {{records:unknown[],truncated:boolean,terminal?:unknown,lastUnavailable?:unknown}} CleanupDiagnostics */

/**
 * A code is named only for a complete, failed child whose stderr carries exactly one line that is, whole, an
 * allowlisted server message (optionally after "ConvexError: "). Echoed, repeated or competing text names nothing.
 * @param {CleanupCliResult | undefined} result @returns {string | null}
 */
function serverRefusalCode(result) {
  const stderr = result?.stderr;
  if (!result || result.error || result.signal || !Number.isInteger(result.status) || result.status === null || result.status < 1) return null;
  if ((typeof stderr !== "string" && !Buffer.isBuffer(stderr)) || Buffer.byteLength(stderr) > CLEANUP_OUTPUT_LIMIT) return null;
  const codes = [];
  for (const line of stripVTControlCharacters(stderr.toString()).split(/\r?\n/).map(entry => entry.trim())) {
    for (const [message, code] of CLEANUP_SERVER_REFUSALS) {
      if (line === `E2E_BOOTSTRAP: ${message}` || line === `ConvexError: E2E_BOOTSTRAP: ${message}`) codes.push(code);
    }
  }
  return codes.length === 1 ? codes[0] : null;
}

/** No stream text, arguments, targets or arbitrary exception fields enter evidence.
 * @param {CleanupCliResult | undefined} result @param {string} functionName
 * @param {CleanupSplitPhase | undefined} phase @param {string} reason */
function cleanupDiagnostic(result, functionName, phase, reason) {
  const complete = result && result.status !== null && Number.isInteger(result.status) && result.status >= 0 &&
    !result.error && !result.signal;
  /** @param {unknown} value */
  const stream = (value) => {
    if (typeof value !== "string" && !Buffer.isBuffer(value)) return { bytes: null, sha256: null, digestScope: "UNAVAILABLE" };
    const bytes = Buffer.byteLength(value);
    return { bytes, sha256: complete && bytes <= CLEANUP_OUTPUT_LIMIT ? createHash("sha256").update(value).digest("hex") : null,
      digestScope: !complete ? "UNAVAILABLE_INCOMPLETE" : bytes <= CLEANUP_OUTPUT_LIMIT ? "COMPLETE" : "UNAVAILABLE_OVERSIZE" };
  };
  const code = result?.error && "code" in result.error ? result.error.code : null;
  return {
    functionName: CLEANUP_FUNCTIONS.has(functionName) ? functionName : "UNAVAILABLE",
    phase: phase === "DISCOVERY" || phase === "REFERENCE" ? phase : null,
    status: result && Number.isInteger(result.status) && result.status !== null && result.status >= 0 ? result.status : null,
    signal: result?.signal == null ? null :
      (["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGHUP"].includes(result.signal) ? result.signal : "UNAVAILABLE"),
    errorCode: code == null ? null :
      (typeof code === "string" && ["ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES", "EPERM", "E2BIG"].includes(code) ? code : "UNAVAILABLE"),
    stdout: stream(result?.stdout), stderr: stream(result?.stderr), reason,
    serverRefusal: serverRefusalCode(result),
    stage: reason === "SUCCESS" || reason === "SPLIT_REFUSAL" ? "COMPLETE" :
      reason.startsWith("REFUSAL_") || reason === "SUCCESS_JSON_UNAVAILABLE" ? "PARSER" :
      reason === "STREAM_UNAVAILABLE" ? "STREAM" : "INVOCATION",
  };
}

/** @param {unknown} value */
function cleanupOutput(value) {
  if (value === undefined || value === null) return "";
  if ((!Buffer.isBuffer(value) && typeof value !== "string") || Buffer.byteLength(value) > CLEANUP_OUTPUT_LIMIT) {
    throw cleanupUnavailable("STREAM_UNAVAILABLE");
  }
  return stripVTControlCharacters(value.toString()).trim();
}

/**
 * Recognize only this child invocation's fixed server diagnostic and canonical
 * CLI refusal. A page probe or arbitrary stderr cannot establish a cap refusal.
 * @param {CleanupCliResult} result
 * @param {string} functionName
 * @param {CleanupSplitPhase | undefined} expectedSplitPhase
 * @returns {CleanupPreviewReceipt}
 */
function cleanupReceipt(result, functionName, expectedSplitPhase) {
  if (!result || result.error || result.signal || !Number.isInteger(result.status) || result.status === null || result.status < 0) {
    throw cleanupUnavailable("CHILD_RESULT_UNAVAILABLE");
  }
  const stdout = cleanupOutput(result.stdout);
  const stderr = cleanupOutput(result.stderr);
  const markers = stderr.match(/OPENING_CLEANUP_SPLIT_REQUIRED_[A-Z_]+/g) ?? [];
  if (result.status === 0) {
    if (!stdout || markers.length) throw cleanupUnavailable("SUCCESS_JSON_UNAVAILABLE");
    try {
      /** @type {unknown} */
      const value = JSON.parse(stdout);
      return { ok: true, value };
    } catch { throw cleanupUnavailable("SUCCESS_JSON_UNAVAILABLE"); }
  }
  if (stdout || functionName !== "orgFinancialReset:resetOrgFinancialData" || !expectedSplitPhase || markers.length !== 1) {
    throw cleanupUnavailable("REFUSAL_PREREQUISITES");
  }
  const marker = `OPENING_CLEANUP_SPLIT_REQUIRED_${expectedSplitPhase}`;
  const lines = stderr.split(/\r?\n/).map(line => line.trim());
  const loggerPrefix = `[CONVEX ?(${functionName})] [ERROR] `;
  const serverMarkers = lines.filter(line => [marker, `'${marker}'`, `"${marker}"`].some(value => line === loggerPrefix + value));
  const refusedCalls = lines.filter(line => line.replace(/^[✖✘] /, "") === `Failed to run function "${functionName}":`);
  if (markers[0] !== marker || serverMarkers.length !== 1 || refusedCalls.length !== 1 ||
      !stderr.includes("Opening cleanup could not be verified. Please contact support.")) throw cleanupUnavailable("REFUSAL_SIGNATURE");
  return { ok: false, refusal: "OPENING_CLEANUP_SPLIT_REQUIRED", phase: expectedSplitPhase, exitCode: result.status };
}

/**
 * Trusted closure: callback arguments cannot supply a CLI target or environment.
 * Both output streams are bounded. Only typed receipts and anonymous invocation
 * diagnostics cross back into the rehearsal's public evidence document.
 * @param {{deployKey:string,previewName:string,convexUrl:string}} config
 * @param {{env?:Record<string,string|undefined>,spawnCli?:(command:string,args:string[],options:object)=>CleanupCliResult,diagnostics?:CleanupDiagnostics}} dependencies
 */
export function createCleanupPreviewCall(config, { env = process.env, spawnCli = spawnSync, diagnostics } = {}) {
  const { deployKey, previewName, convexUrl } = config;
  const childEnv = { ...env, CONVEX_DEPLOY_KEY: deployKey, CONVEX_PREVIEW_NAME: previewName, NEXT_PUBLIC_CONVEX_URL: convexUrl };
  try {
    assertPreviewTargeting({ deployKey, previewName, env: childEnv });
    if (!isPreviewCloudUrl(convexUrl)) throw cleanupUnavailable();
  } catch { throw cleanupUnavailable(); }

  /**
   * @param {string} functionName
   * @param {Record<string,unknown>} args
   * @param {CleanupSplitPhase} [expectedSplitPhase]
   * @returns {Promise<CleanupPreviewReceipt>}
   */
  return async (functionName, args, expectedSplitPhase) => {
    /** @type {CleanupCliResult | undefined} */
    let result;
    let reason = "INVOCATION_UNAVAILABLE";
    try {
      if (!CLEANUP_FUNCTIONS.has(functionName) || !args || typeof args !== "object" || Array.isArray(args) ||
          (expectedSplitPhase !== undefined && expectedSplitPhase !== "DISCOVERY" && expectedSplitPhase !== "REFERENCE")) {
        throw cleanupUnavailable();
      }
      const fixtureCall = functionName.startsWith("e2eBootstrap:");
      if (fixtureCall && args.expectedCloudUrl !== undefined && args.expectedCloudUrl !== convexUrl) throw cleanupUnavailable();
      const payload = fixtureCall ? { ...args, expectedCloudUrl: convexUrl } : args;
      try {
        const argsJson = JSON.stringify(payload);
        if (Buffer.byteLength(argsJson) > 65_536) throw cleanupUnavailable();
        const argv = buildConvexRunArgs({ functionName, argsJson, previewName, deployKey, env: childEnv });
        runConvex(argv, functionName, (command, commandArgs, options) => {
          result = spawnCli(command, commandArgs, { ...options, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
            timeout: 60_000, maxBuffer: CLEANUP_OUTPUT_LIMIT, encoding: "utf8", windowsHide: true });
          return result;
        });
      } catch {
        if (!result || result.status === 0) throw cleanupUnavailable();
      }
      if (!result) throw cleanupUnavailable();
      const receipt = cleanupReceipt(result, functionName, expectedSplitPhase);
      reason = receipt.ok ? "SUCCESS" : "SPLIT_REFUSAL";
      return receipt;
      } catch (error) {
      if (error instanceof RehearsalError && "cleanupReason" in error &&
        ["CHILD_RESULT_UNAVAILABLE", "STREAM_UNAVAILABLE", "SUCCESS_JSON_UNAVAILABLE", "REFUSAL_PREREQUISITES", "REFUSAL_SIGNATURE"].includes(error.cleanupReason))
        reason = error.cleanupReason;
      throw error;
    } finally {
      // Diagnostics cannot promote or replace the original result/rejection.
      if (diagnostics) {
        try {
          const record = cleanupDiagnostic(result, functionName, expectedSplitPhase, reason);
          diagnostics.terminal = record;
          // A later success or expected cap refusal cannot erase a real failure.
          if (reason !== "SUCCESS" && reason !== "SPLIT_REFUSAL") diagnostics.lastUnavailable = record;
          if (diagnostics.records.length < 256) diagnostics.records.push(record);
          else diagnostics.truncated = true;
        } catch {
          try { diagnostics.truncated = true; } catch { /* Original invocation result takes precedence. */ }
        }
      }
    }
  };
}

/**
 * Fires N release attempts that are genuinely IN FLIGHT TOGETHER.
 *
 * Each attempt runs in its OWN CHILD PROCESS. That is not defensive style: node's
 * global `fetch` multiplexes through one shared connection pool, so a
 * `Promise.all` of requests from one process can be serialised onto a single
 * connection by the HTTP client — which would produce a green "concurrent" result
 * from what was actually a queue. Separate processes have separate pools and
 * separate sockets, so the concurrency is real rather than assumed.
 *
 * They rendezvous on a wall-clock instant rather than being spawned and hoped
 * for: each child waits until `startAt` before issuing its single request, so
 * process startup cost does not stagger them.
 */
export async function fireConcurrentReleases({ convexUrl, attempts, leadMs = 2500 }) {
  const startAt = Date.now() + leadMs;
  const children = attempts.map(
    (attempt) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [path.join(HERE, "rehearsalReleaseWorker.mjs"), String(startAt), JSON.stringify(attempt.args)],
          {
            // The target travels in the ENVIRONMENT, not argv, for the same
            // reason the token already does: argv is readable from the process
            // table by anything else on the box, and this child is handed a live
            // session token aimed at whatever host it is told to use. Keeping
            // the credential and its destination together also removes the
            // "faulty CLI argument redirects an authenticated request" shape
            // outright, rather than validating it after the fact.
            env: {
              ...process.env,
              REHEARSAL_TOKEN: attempt.token,
              REHEARSAL_CONVEX_URL: convexUrl,
            },
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => {
          let parsed = null;
          try {
            parsed = JSON.parse(out.trim());
          } catch {
            parsed = null;
          }
          resolve({
            label: attempt.label,
            exitCode: code,
            result: parsed,
            stderr: err.slice(0, 400),
          });
        });
      })
  );
  return Promise.all(children);
}

/** Records one case outcome. Never throws — a failed case is evidence too. */
/**
 * The marker that separates "this property is false" from "this run could not
 * put the property to the test".
 *
 * Both of those are non-PASS and only one of them is a defect. Collapsing them
 * loses the distinction in the direction that flatters the run: a case that
 * could not execute, reported as a failure, invites someone to "fix" it by
 * weakening the assertion — and reported as a pass, it is simply a lie. So a
 * case may declare itself UNPROVEN, and the summary counts those separately and
 * refuses to describe the run as complete while any remain.
 */
export class Unproven extends Error {}

export function unproven(reason) {
  throw new Unproven(reason);
}

export function recordCase(results, id, description, assertion) {
  return Promise.resolve()
    .then(assertion)
    .then((detail) => {
      results.push({ id, description, status: "PASS", detail: detail ?? null });
    })
    .catch((error) => {
      results.push({
        id,
        description,
        status: error instanceof Unproven ? "UNPROVEN" : "FAIL",
        detail: String(error?.message ?? error),
      });
    });
}

export function summarize(results) {
  const failed = results.filter((r) => r.status === "FAIL");
  const unprovenCases = results.filter((r) => r.status === "UNPROVEN");
  return {
    total: results.length,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: failed.length,
    failedIds: failed.map((r) => r.id),
    unproven: unprovenCases.length,
    unprovenIds: unprovenCases.map((r) => r.id),
    // The run is only "complete" when nothing was skipped. A green exit code
    // beside a non-empty unproven list is how a partial rehearsal gets quoted
    // as a full one.
    complete: results.length > 0 && failed.length === 0 && unprovenCases.length === 0,
  };
}

/**
 * FD1's SCRUM-54 bank-contract input, from trusted provenance only.
 *
 * The tested merge is checked out BESIDE this trusted checkout (`../candidate`) and
 * read as data; an unreadable source is `undefined`, which leaves FD1 UNPROVEN.
 * The bank receipt contract itself is unconditional: FD1 fails unless the candidate
 * source and the deployed backend both take the physical bank.
 */
export function fd1BankContractInputs({ env, cwd, readText = (file) => readFileSync(file, "utf8") }) {
  const candidateSource = (filename) => {
    try {
      return readText(path.join(cwd, "..", "candidate", "convex", filename));
    } catch {
      return undefined;
    }
  };
  return {
    candidateSource: candidateSource("applications.ts"),
    directFeeSource: candidateSource("financeDealCosts.ts"),
    chequeSource: candidateSource("collections.ts"),
    requireBankContract: env.PR_NUMBER === "602",
  };
}

/* c8 ignore start — the orchestration below only runs inside CI against a preview. */
export async function main(env = process.env) {
  const config = assertRehearsalEnv(env);
  /** @type {CleanupDiagnostics} */
  const cleanupInvocations = { records: [], truncated: false, terminal: null, lastUnavailable: null };
  const evidence = {
    testedSha: env.REHEARSAL_TESTED_SHA ?? null,
    previewName: config.previewName,
    convexUrl: config.convexUrl,
    deploymentType: "preview",
    workflowRunId: env.GITHUB_RUN_ID ?? null,
    workflowRunAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    workflowJob: env.GITHUB_JOB ?? null,
    cases: [],
    cleanupInvocations,
  };

  // ── Real Clerk identities, resolved before anything is targeted ───────────
  const salesUserId = await resolveIdentity(config.salesEmail, config.clerkSecret);
  const approverUserId = await resolveIdentity(config.approverEmail, config.clerkSecret);

  // ── Target identity: marker + URL agreement, BEFORE any fixture write ─────
  //
  // The bootstrap step already ran this, and it is run AGAIN here on purpose.
  // This process is the one about to write economic fixtures, and "the previous
  // step vouched for the target" is not the same claim as "the target this
  // process is about to write to is the right one". `assertE2EBootstrap`
  // refuses a deployment without the preview marker, and `expectedCloudUrl`
  // makes it refuse a deployment whose own recorded URL disagrees with the URL
  // these mutations will be sent to.
  await runPreviewFunction({
    functionName: "e2eBootstrap:assertE2EBootstrap",
    args: {
      primaryClerkUserId: salesUserId,
      approverClerkUserId: approverUserId,
      expectedCloudUrl: config.convexUrl,
    },
    previewName: config.previewName,
    deployKey: config.deployKey,
    env,
  });
  evidence.targetVerification = "assertE2EBootstrap agreed: preview marker present, cloud URL matches";

  const sales = await mintConvexToken({ userId: salesUserId, secretKey: config.clerkSecret });
  const approver = await mintConvexToken({ userId: approverUserId, secretKey: config.clerkSecret });

  const asSales = (kind, fnPath, args) =>
    convexCallWithRateLimitRetry({
      convexUrl: config.convexUrl,
      token: sales.jwt,
      kind,
      path: fnPath,
      args,
    });
  /** No Authorization header at all — for the case that proves money needs one. */
  const anonymousCall = (kind, fnPath, args) =>
    convexCall({ convexUrl: config.convexUrl, token: null, kind, path: fnPath, args });
  const asApprover = (kind, fnPath, args) =>
    convexCallWithRateLimitRetry({
      convexUrl: config.convexUrl,
      token: approver.jwt,
      kind,
      path: fnPath,
      args,
    });
  /** @type {Set<string>} */
  const createdRehearsalOrgIds = new Set();
  const salesMust = async (kind, fnPath, args) => {
    const value = await mustCall({ convexUrl: config.convexUrl, token: sales.jwt, kind, path: fnPath, args });
    if (kind === "mutation" && fnPath === "organizations:create" && typeof value === "string") createdRehearsalOrgIds.add(value);
    return value;
  };
  const approverMust = async (kind, fnPath, args) => {
    const value = await mustCall({ convexUrl: config.convexUrl, token: approver.jwt, kind, path: fnPath, args });
    if (kind === "mutation" && fnPath === "organizations:create" && typeof value === "string") createdRehearsalOrgIds.add(value);
    return value;
  };

  const orgs = await salesMust("query", "organizations:listMine", {});
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new RehearsalError(
      "The rehearsal identity belongs to no organization on this preview. The bootstrap step must run first."
    );
  }
  const orgId = orgs[0]._id;
  evidence.orgId = orgId;

  const results = evidence.cases;
  const { runRehearsalCases, candidateNamesReceiptBank, candidateCommandNamesBank } = await import("./accountingRehearsalCases.mjs");
  const fd1Bank = fd1BankContractInputs({ env, cwd: process.cwd() });
  const context = {
    candidateFinanceReceiptNamesBank: candidateNamesReceiptBank(fd1Bank.candidateSource),
    candidateDirectFeeNamesBank: candidateCommandNamesBank(fd1Bank.directFeeSource, "recordDirectFeePayment"),
    candidateChequeClearNamesBank: candidateCommandNamesBank(fd1Bank.chequeSource, "clearCheque"),
    requireFinanceReceiptBankContract: fd1Bank.requireBankContract,
    results,
    orgId,
    config,
    tokens: { sales: sales.jwt, approver: approver.jwt },
    asSales,
    asApprover,
    anonymousCall,
    salesMust,
    approverMust,
    recordCase,
    unproven,
    fireConcurrentReleases,
  };
  await runRehearsalCases(context);
  const { runCleanupRehearsalCases } = await import("./accountingCleanupRehearsal.mjs");
  await runCleanupRehearsalCases({ ...context,
    previewCall: createCleanupPreviewCall(config, { env, diagnostics: cleanupInvocations }),
    qaIdentities: { primaryClerkUserId: salesUserId, approverClerkUserId: approverUserId },
    createdRehearsalOrgIds: [...createdRehearsalOrgIds],
  });

  evidence.summary = summarize(results);
  console.log(JSON.stringify(evidence, null, 2));
  console.error(bannerForSummary(evidence.summary));
  return exitCodeForSummary(evidence.summary);
}

/**
 * The ONE place a summary becomes a process exit code.
 *
 * Both reviewer seats found the same defect here independently (Sonnet F1b,
 * Codex RG-02): an UNPROVEN case returned 0, so an incomplete rehearsal was a
 * GREEN job. That was my deliberate design — "nothing is broken, so not a
 * failure code" — and it was wrong by this repository's own rule: an
 * unexecuted gate is UNAVAILABLE, never PASS. A validator that returns success
 * when the evidence it exists to produce is missing has failed open.
 *
 * UNPROVEN and FAIL stay DISTINCT in the JSON and the banner, because they
 * mean different things and invite different responses — one is a defect, the
 * other is a precondition to restore. They are identical to the process
 * boundary, because to a release gate "could not test it" and "it failed" are
 * the same answer: not certified.
 *
 * Pure, so it can be unit-tested for every branch without running a rehearsal.
 */
export function exitCodeForSummary(summary) {
  if (!Number.isSafeInteger(summary.total) || summary.total === 0 || summary.complete !== true) return 1;
  if (summary.failed > 0) return 1;
  if (summary.unproven > 0) return 1;
  return 0;
}

export function bannerForSummary(summary) {
  if (summary.total === 0) return "\nREHEARSAL INCOMPLETE — NOT CERTIFIED: no cloud cases executed.";
  if (summary.failed > 0) {
    const unprovenTail =
      summary.unproven > 0 ? `; ${summary.unproven} UNPROVEN (${summary.unprovenIds.join(", ")})` : "";
    return `\nREHEARSAL FAILED: ${summary.failed} of ${summary.total} cases — ${summary.failedIds.join(", ")}${unprovenTail}`;
  }
  if (summary.unproven > 0) {
    return (
      `\nREHEARSAL INCOMPLETE — NOT CERTIFIED: ${summary.passed} of ${summary.total} cases passed, ` +
      `${summary.unproven} UNPROVEN (${summary.unprovenIds.join(", ")}). ` +
      `An unproven case is not evidence of anything, and this run exits non-zero for it.`
    );
  }
  return `\nREHEARSAL PASSED: ${summary.passed} of ${summary.total} cases.`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(String(error?.stack ?? error));
      process.exit(1);
    });
}
/* c8 ignore stop */
