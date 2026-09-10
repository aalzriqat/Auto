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
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { isPreviewDeployKey } from "./e2ePreviewBootstrap.mjs";

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
  };
}

/** Same, but a failure is fatal — for steps whose success later cases depend on. */
export async function mustCall(spec, fetchImpl = fetch) {
  const result = await convexCall(spec, fetchImpl);
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
  return match ? `sess_${match[1]}` : null;
}

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
  const sessionId = sanitizeClerkSessionId(session?.id);
  if (sessionId === null) {
    throw new RehearsalError(
      `Clerk returned a session id that does not match the expected \`sess_…\` shape. Refusing to build a ` +
        `request URL from it rather than trusting a remote response to be well-formed.`
    );
  }
  const tokenUrl = new URL(`/v1/sessions/${sessionId}/tokens/convex`, "https://api.clerk.com");
  const tokenResponse = await fetchImpl(tokenUrl.toString(), { method: "POST", headers });
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
 */
export async function runPreviewFunction({ functionName, args, previewName, deployKey, env = process.env }) {
  const { buildConvexRunArgs, runConvex } = await import("./e2ePreviewBootstrap.mjs");
  const argv = buildConvexRunArgs({
    functionName,
    argsJson: JSON.stringify(args ?? {}),
    previewName,
    deployKey,
    env,
  });
  runConvex(argv, functionName);
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
          [
            path.join(HERE, "rehearsalReleaseWorker.mjs"),
            convexUrl,
            String(startAt),
            JSON.stringify(attempt.args),
          ],
          { env: { ...process.env, REHEARSAL_TOKEN: attempt.token }, stdio: ["ignore", "pipe", "pipe"] }
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
export function recordCase(results, id, description, assertion) {
  return Promise.resolve()
    .then(assertion)
    .then((detail) => {
      results.push({ id, description, status: "PASS", detail: detail ?? null });
    })
    .catch((error) => {
      results.push({ id, description, status: "FAIL", detail: String(error?.message ?? error) });
    });
}

export function summarize(results) {
  const failed = results.filter((r) => r.status === "FAIL");
  return {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    failedIds: failed.map((r) => r.id),
  };
}

/* c8 ignore start — the orchestration below only runs inside CI against a preview. */
export async function main(env = process.env) {
  const config = assertRehearsalEnv(env);
  const evidence = {
    testedSha: env.REHEARSAL_TESTED_SHA ?? null,
    previewName: config.previewName,
    convexUrl: config.convexUrl,
    deploymentType: "preview",
    workflowRunId: env.GITHUB_RUN_ID ?? null,
    workflowJob: env.GITHUB_JOB ?? null,
    cases: [],
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
    convexCall({ convexUrl: config.convexUrl, token: sales.jwt, kind, path: fnPath, args });
  /** No Authorization header at all — for the case that proves money needs one. */
  const anonymousCall = (kind, fnPath, args) =>
    convexCall({ convexUrl: config.convexUrl, token: null, kind, path: fnPath, args });
  const asApprover = (kind, fnPath, args) =>
    convexCall({ convexUrl: config.convexUrl, token: approver.jwt, kind, path: fnPath, args });
  const salesMust = (kind, fnPath, args) =>
    mustCall({ convexUrl: config.convexUrl, token: sales.jwt, kind, path: fnPath, args });
  const approverMust = (kind, fnPath, args) =>
    mustCall({ convexUrl: config.convexUrl, token: approver.jwt, kind, path: fnPath, args });

  const orgs = await salesMust("query", "organizations:listMine", {});
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new RehearsalError(
      "The rehearsal identity belongs to no organization on this preview. The bootstrap step must run first."
    );
  }
  const orgId = orgs[0]._id;
  evidence.orgId = orgId;

  const results = evidence.cases;
  const { runRehearsalCases } = await import("./accountingRehearsalCases.mjs");
  await runRehearsalCases({
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
    fireConcurrentReleases,
  });

  evidence.summary = summarize(results);
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.summary.failed > 0) {
    console.error(
      `\nREHEARSAL FAILED: ${evidence.summary.failed} of ${evidence.summary.total} cases — ` +
        evidence.summary.failedIds.join(", ")
    );
    return 1;
  }
  console.error(`\nREHEARSAL PASSED: ${evidence.summary.passed} of ${evidence.summary.total} cases.`);
  return 0;
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
