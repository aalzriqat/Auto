/**
 * SCRUM-143 — the caller-side half of the E2E preview bootstrap.
 *
 * Resolves the two configured Clerk identities, then runs
 * `e2eBootstrap:bootstrapE2EOrganization` and `e2eBootstrap:assertE2EBootstrap`
 * against ONE explicitly named preview deployment.
 *
 * ## ⚠️ WHY `--preview-name` IS LOAD-BEARING SAFETY, NOT TIDINESS
 *
 * `convex run` with a preview deploy key and NO target selector does not
 * refuse. Its deployment selection falls through to `unspecified`, which the
 * CLI resolves via `handleOwnDev` — the project's DEV deployment. That is the
 * shared deployment this bootstrap must never touch, and the failure would be
 * silent: the command succeeds, seeds the wrong database, and the preview the
 * browser is pointed at stays empty.
 *
 * With `--preview-name` the CLI authorizes through `deployment/authorize_preview`,
 * an endpoint that can only ever return a preview deployment. It cannot resolve
 * to production, and it cannot resolve to dev. So the flag is not decoration —
 * it is the difference between a preview-only command and one that quietly
 * targets shared infrastructure, which is why `assertPreviewTargeting` refuses
 * to build a command without it rather than defaulting anything.
 *
 * The same reasoning covers the key: `--preview-create` is refused outright by
 * the CLI for a non-preview key, but `convex run` is not, so the key shape is
 * checked here before any argument is assembled.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Marks refusals raised by this module, so the CLI entry can print them plainly. */
export class PreviewTargetingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreviewTargetingError";
  }
}

/**
 * A Convex PREVIEW deploy key, exactly as the CLI recognises one.
 *
 * Mirrors `isPreviewDeployKey` in the Convex CLI: the part before `|` splits on
 * `:` into exactly three segments, the first being `preview`. Production and
 * dev keys are `prod:…|…` / `dev:…|…`, project keys are `project:…|…`, and a
 * bare admin key has no `|` at all — every one of those is refused here.
 */
export function isPreviewDeployKey(deployKey) {
  if (typeof deployKey !== "string") return false;
  const parts = deployKey.split("|");
  if (parts.length < 2) return false;
  const prefixParts = parts[0].split(":");
  return prefixParts[0] === "preview" && prefixParts.length === 3;
}

/**
 * Preview names the Convex CLI will accept as an identifier.
 *
 * Deliberately narrow. A branch name reaches this containing `/`, and an
 * unsanitised value could otherwise smuggle a leading `-` that the CLI would
 * read as another flag.
 */
// ⚠️ Deliberately lowercase-only. `[\w.-]` would be "more concise" and would
// also start accepting uppercase, which `sanitizePreviewName` never produces —
// a validator that admits more than the producer emits is not a validator.
const PREVIEW_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}$/;

export function sanitizePreviewName(raw) {
  const lowered = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  return lowered.slice(0, 61);
}

/** How many hex characters of the ref digest survive into the preview name. */
const REF_DIGEST_LENGTH = 10;

/**
 * A preview name that collides only when the REF collides.
 *
 * ⚠️ WHY A DIGEST AND NOT JUST THE SANITISED REF. `--preview-create` DELETES
 * and recreates the named deployment, so the preview name is a destructive
 * resource key. GitHub's `concurrency` serialises runs that share a group, and
 * the group is keyed on `github.ref` — so the invariant that has to hold is:
 *
 *   > two runs get the same preview name ONLY IF they get the same
 *   > concurrency group.
 *
 * Sanitising the ref broke that in two ways, both reproduced on PR #278:
 *
 *   refs/heads/feature/foo  ->  e2e-feature-foo   ┐ different groups,
 *   refs/heads/feature-foo  ->  e2e-feature-foo   ┘ same preview
 *
 *   ...58 chars...-one      ->  truncated to 61   ┐ different groups,
 *   ...58 chars...-two      ->  truncated to 61   ┘ same preview
 *
 * Either pair runs concurrently, and the second `--preview-create` deletes the
 * first run's backend from under a browser that is mid-suite. The result is not
 * merely a failure — it is a failure attributed to the wrong commit.
 *
 * Appending a digest of the FULL ref — the same string the concurrency group is
 * keyed on — restores the implication. The digest is appended AFTER truncation
 * so shortening the readable part can never remove it.
 */
export function previewNameForRef({ ref, prNumber = "" }) {
  const fullRef = String(ref ?? "").trim();
  if (!fullRef) {
    throw new PreviewTargetingError(
      "Cannot derive a preview name without a ref. The workflow passes github.ref, which is also what the " +
        "concurrency group is keyed on; without it the two cannot be kept in step.",
    );
  }

  const digest = createHash("sha256").update(fullRef).digest("hex").slice(0, REF_DIGEST_LENGTH);
  const readable = String(prNumber ?? "").trim()
    ? `pr-${String(prNumber).trim()}`
    : fullRef.replace(/^refs\/(heads|tags)\//, "");

  const suffix = `-${digest}`;
  const head = sanitizePreviewName(`e2e-${readable}`).slice(0, 61 - suffix.length);
  return `${head}${suffix}`;
}

/**
 * ⚠️ FAIL CLOSED. Every refusal below is a case where the command would still
 * have RUN — just against something other than the preview under test.
 */
export function assertPreviewTargeting({ deployKey, previewName, env = {} }) {
  if (!deployKey || !String(deployKey).trim()) {
    throw new PreviewTargetingError(
      "CONVEX_DEPLOY_KEY is not set. The E2E bootstrap refuses to run without an explicit preview deploy key.",
    );
  }
  if (!isPreviewDeployKey(deployKey)) {
    throw new PreviewTargetingError(
      "CONVEX_DEPLOY_KEY is not a PREVIEW deploy key. Seeding is only ever performed against a disposable preview " +
        "deployment, so a production, dev or project key is refused before any command is built.",
    );
  }
  if (!previewName || !String(previewName).trim()) {
    throw new PreviewTargetingError(
      "No preview name was supplied. Without `--preview-name`, `convex run` resolves an unspecified target to the " +
        "project's DEV deployment — shared infrastructure this must never write to.",
    );
  }
  if (!PREVIEW_NAME_PATTERN.test(previewName)) {
    throw new PreviewTargetingError(
      `Preview name ${JSON.stringify(previewName)} is not a safe identifier. Expected ${PREVIEW_NAME_PATTERN}.`,
    );
  }
  // `CONVEX_DEPLOYMENT` takes precedence over a deploy key in some CLI paths and
  // names a dev/prod deployment by definition. Its presence here means the
  // environment is not the isolated CI environment this assumes.
  if (env.CONVEX_DEPLOYMENT && String(env.CONVEX_DEPLOYMENT).trim()) {
    throw new PreviewTargetingError(
      "CONVEX_DEPLOYMENT is set. That variable names a dev or production deployment and must not be present when " +
        "seeding a preview.",
    );
  }
  return true;
}

/**
 * The argv for one preview-targeted `convex run`.
 *
 * The target flag is appended by this function rather than by any caller, so
 * there is no code path that can build the command and forget it.
 */
export function buildConvexRunArgs({ functionName, argsJson, previewName, deployKey, env = {} }) {
  assertPreviewTargeting({ deployKey, previewName, env });
  if (!functionName || !/^[\w/]+:\w+$/.test(functionName)) {
    throw new PreviewTargetingError(
      `Refusing to run ${JSON.stringify(functionName)}: expected a "module:function" reference.`,
    );
  }
  return [
    "exec",
    "convex",
    "run",
    functionName,
    argsJson ?? "{}",
    "--preview-name",
    previewName,
  ];
}

// ─── Clerk identity resolution ───────────────────────────────────────────────

const CLERK_API = "https://api.clerk.com/v1";

/**
 * The only alphabet a Clerk user id is drawn from — and, below, the only
 * alphabet the value this script passes on can be drawn from.
 */
const CLERK_ID_PREFIX = "user_";
const CLERK_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CLERK_ID_MAX_BODY = 64;

/**
 * A Clerk user id, re-emitted from a hard-coded alphabet.
 *
 * ⚠️ THE RESPONSE BODY IS THE ONE INPUT HERE THIS REPOSITORY DOES NOT OWN.
 * Everything else the seed step handles comes from the workflow environment;
 * this one value arrives over the network and is then (a) embedded in the JSON
 * argv of a subprocess and (b) written to the job log. Neither sink runs a
 * shell and `runConvex` already refuses option-shaped arguments, so no concrete
 * exploit is claimed — but "no shell today" is a property of the caller, and
 * this is the boundary where the value stops being external.
 *
 * The check and the output share one source of truth: a character is accepted
 * because it is in `CLERK_ID_ALPHABET`, and the character appended is the one
 * read back out of `CLERK_ID_ALPHABET`. There is no branch in which a byte of
 * the response reaches the returned string, so the returned string is `user_`
 * followed by letters and digits by construction rather than by assertion —
 * no whitespace, no quote, no CR or LF, no leading `-`.
 *
 * @param {unknown} raw the `id` field of the Clerk user object
 * @param {string} email only for the error message, and masked there
 * @returns {string}
 */
export function toVerifiedClerkUserId(raw, email) {
  const value = String(raw ?? "");
  const body = value.slice(CLERK_ID_PREFIX.length);
  if (!value.startsWith(CLERK_ID_PREFIX) || body.length === 0 || body.length > CLERK_ID_MAX_BODY) {
    throw new PreviewTargetingError(
      `Clerk returned an id for ${maskEmail(email)} that is not shaped like a user id ` +
        `("${CLERK_ID_PREFIX}" followed by 1-${CLERK_ID_MAX_BODY} letters or digits). It is not passed on.`,
    );
  }

  let verified = CLERK_ID_PREFIX;
  for (let i = 0; i < body.length; i += 1) {
    const index = CLERK_ID_ALPHABET.indexOf(body.charAt(i));
    if (index < 0) {
      throw new PreviewTargetingError(
        `Clerk returned an id for ${maskEmail(email)} containing a character that is not a letter or a digit. ` +
          "A user id never does, and this one is about to become a subprocess argument, so it is refused.",
      );
    }
    verified += CLERK_ID_ALPHABET.charAt(index);
  }
  return verified;
}

/**
 * Email address -> Clerk user id, against the instance the app itself
 * authenticates with.
 *
 * The `users` row a membership hangs off is keyed by `clerkId`, which is the
 * JWT `subject`. Nothing in the repository knows those ids, and nothing should
 * hard-code them — they belong to whichever Clerk instance the E2E secrets
 * point at. Resolving them here keeps the binding to a stable external
 * identifier without committing one.
 *
 * `fetchImpl` is a seam so the resolution is testable without a network.
 */
export async function resolveClerkUserId({ email, secretKey, fetchImpl = fetch }) {
  if (!email || !String(email).trim()) {
    throw new PreviewTargetingError("Cannot resolve a Clerk user for an empty email address.");
  }
  if (!secretKey || !String(secretKey).trim()) {
    throw new PreviewTargetingError(
      "CLERK_SECRET_KEY is not set, so the E2E identities cannot be resolved to Clerk user ids.",
    );
  }

  const url = `${CLERK_API}/users?email_address=${encodeURIComponent(email)}&limit=2`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new PreviewTargetingError(
      `Clerk rejected the user lookup for ${maskEmail(email)} (HTTP ${response.status}). ` +
        "Check that CLERK_SECRET_KEY belongs to the same Clerk instance as NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.",
    );
  }
  const body = await response.json();
  const users = Array.isArray(body) ? body : (body?.data ?? []);
  if (users.length === 0) {
    throw new PreviewTargetingError(
      `No Clerk user exists with the address ${maskEmail(email)} in this instance. ` +
        "The E2E identity is not provisioned, so it can never belong to the QA dealership.",
    );
  }
  if (users.length > 1) {
    throw new PreviewTargetingError(
      `The address ${maskEmail(email)} resolves to ${users.length} Clerk users, so the E2E seat is ambiguous.`,
    );
  }
  const id = users[0]?.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new PreviewTargetingError(
      `Clerk returned a user for ${maskEmail(email)} with no id, which this cannot bind a membership to.`,
    );
  }
  return toVerifiedClerkUserId(id, email);
}

/**
 * Anything interpolated into a log line, reduced to characters that cannot
 * forge one.
 *
 * A CI log is parsed by humans and by tooling, and three of the values this
 * script prints do not originate here: `NEXT_PUBLIC_CONVEX_URL` comes from the
 * deploy step's environment, and both Clerk user ids come back from an external
 * API. A CR or LF in any of them writes a line of its own choosing into the job
 * log. None of them can legitimately contain one, so stripping is lossless for
 * every real value and removes the class outright.
 *
 * `*` is in the kept set because `maskEmail` produces one per redacted
 * character. Collapsing that run made both configured addresses render
 * identically as `au?@example.com` on the real fresh-preview run at
 * fd55c827c, which is the opposite of what this line is for — it is the
 * diagnostic naming which identity was bound to which Clerk id. A `*`
 * cannot forge a log line.
 */
export function safeForLog(value) {
  return String(value ?? "").replace(/[^\w.:@/*-]+/g, "?").slice(0, 200);
}

/** Same reasoning as the backend's: an E2E address is a repository secret. */
export function maskEmail(email) {
  const at = String(email ?? "").indexOf("@");
  if (at <= 0) return "<redacted>";
  const local = String(email).slice(0, at);
  return `${local.slice(0, 2)}${"*".repeat(Math.max(1, local.length - 2))}@${String(email).slice(at + 1)}`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

/**
 * ⚠️ NO SHELL. The JSON argument carries quotes and braces; handing it to a
 * shell would re-split it on whitespace and the mutation would receive
 * something other than what was built here. Passing argv directly is also what
 * makes `buildConvexRunArgs`'s appended `--preview-name` un-droppable.
 *
 * ⚠️ THE ARGV NEVER REACHES AN ERROR MESSAGE, and that is the whole point of
 * the `label` parameter. This function used to report failures as
 * `` `pnpm ${args.join(" ")}` failed `` — and `args` contains the JSON payload,
 * which contains BOTH configured E2E addresses in full. Every refusal, every
 * transient CLI failure and every spawn error printed them. Reproduced on PR
 * #278 with a control: the failure string contained both addresses while the
 * progress line, which goes through `maskEmail`, contained neither. GitHub
 * masks registered secret values in its own log stream, but that protects
 * neither a local run nor a copied exception, and it is not a reason to emit
 * them.
 *
 * The Convex CLI's own diagnostics are not lost: `stdio: "inherit"` has already
 * streamed them to the job log by the time this throws.
 */
/**
 * @param {string[]} args
 * @param {string} label a function reference, never anything caller-derived
 * @param {(command: string, args: string[], options: object) =>
 *          { status: number | null, error?: Error | undefined }} [spawn]
 *        the seam the failure-path tests drive; only `status` and `error` are read
 */
export function runConvex(args, label, spawn = spawnSync) {
  // ⚠️ RE-VALIDATED AT THE CALL SITE, not merely where the argv was built.
  // `buildConvexRunArgs` is the only intended producer and it validates every
  // element, but this is the line that actually executes a process, and a
  // second producer added later would inherit no guarantee from the first. An
  // argument that is not a string, or that opens with `-` without being one of
  // the two flags this command legitimately passes, is refused rather than
  // handed to the CLI as an option.
  const ALLOWED_FLAGS = new Set(["--preview-name"]);
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new PreviewTargetingError(`Refusing to run ${label}: a non-string argument was supplied.`);
    }
    if (arg.startsWith("-") && !ALLOWED_FLAGS.has(arg)) {
      throw new PreviewTargetingError(
        `Refusing to run ${label}: unexpected option-shaped argument. Only ${[...ALLOWED_FLAGS].join(", ")} may be passed.`,
      );
    }
  }

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawn(pnpm, args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Could not start the Convex CLI for ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.status}. The Convex CLI's own output is above.`,
    );
  }
}

/**
 * `deps` exists so the whole flow is testable without a network or a
 * subprocess — the failure path in particular, which is where the address leak
 * lived and where nothing but an injected runner can observe the message.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{
 *   run?: (args: string[], label: string) => void,
 *   resolveClerkUserId?: (options: { email: string, secretKey: string | undefined }) => Promise<string>,
 *   log?: (message: string) => void,
 * }} [deps]
 */
export async function main(env = process.env, deps = {}) {
  const { run = runConvex, resolveClerkUserId: resolveId = resolveClerkUserId, log = console.log } = deps;
  const deployKey = env.CONVEX_DEPLOY_KEY;
  const previewName = env.CONVEX_PREVIEW_NAME;
  assertPreviewTargeting({ deployKey, previewName, env });

  const primaryEmail = env.E2E_LOGIN_USER;
  const approverEmail = env.E2E_APPROVER_USER;
  if (!primaryEmail || !approverEmail) {
    throw new PreviewTargetingError(
      "E2E_LOGIN_USER and E2E_APPROVER_USER must both be set. AutoFlow refuses to let one person both create and " +
        "approve a deal, so the approval E2E path needs two provisioned identities.",
    );
  }

  const secretKey = env.CLERK_SECRET_KEY;
  const primaryClerkUserId = await resolveId({ email: primaryEmail, secretKey });
  const approverClerkUserId = await resolveId({ email: approverEmail, secretKey });

  /**
   * The URL the browser is about to drive, captured by the deploy step.
   *
   * Passed so the SERVER can compare it with its own `CONVEX_CLOUD_URL` and
   * refuse a mismatch. Without it, a `--preview-name` that resolved to some
   * other preview would seed one database while the suite drove another, and
   * every spec would fail as though the product were broken.
   */
  const expectedCloudUrl = env.NEXT_PUBLIC_CONVEX_URL;

  log(
    `Seeding preview "${safeForLog(previewName)}" at ${safeForLog(expectedCloudUrl)}: ` +
      `${safeForLog(maskEmail(primaryEmail))} -> ${safeForLog(primaryClerkUserId)}, ` +
      `${safeForLog(maskEmail(approverEmail))} -> ${safeForLog(approverClerkUserId)}`,
  );

  if (!expectedCloudUrl) {
    throw new PreviewTargetingError(
      "NEXT_PUBLIC_CONVEX_URL is not set, so the deployment being seeded cannot be checked against the one the browser " +
        "will drive. Run this after the deploy step that captures it.",
    );
  }

  run(
    buildConvexRunArgs({
      functionName: "e2eBootstrap:bootstrapE2EOrganization",
      argsJson: JSON.stringify({
        primary: { clerkUserId: primaryClerkUserId, email: primaryEmail, name: "E2E Salesperson" },
        approver: { clerkUserId: approverClerkUserId, email: approverEmail, name: "E2E Manager" },
        expectedCloudUrl,
      }),
      previewName,
      deployKey,
      env,
    }),
    "e2eBootstrap:bootstrapE2EOrganization",
  );

  run(
    buildConvexRunArgs({
      functionName: "e2eBootstrap:assertE2EBootstrap",
      argsJson: JSON.stringify({ primaryClerkUserId, approverClerkUserId, expectedCloudUrl }),
      previewName,
      deployKey,
      env,
    }),
    "e2eBootstrap:assertE2EBootstrap",
  );
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const [mode, ref, prNumber] = process.argv.slice(2);
  const run =
    mode === "--print-name"
      ? async () => {
          const name = previewNameForRef({ ref, prNumber });
          if (!PREVIEW_NAME_PATTERN.test(name)) {
            throw new PreviewTargetingError(
              `Could not derive a safe preview name from ${JSON.stringify(ref)}.`,
            );
          }
          process.stdout.write(name);
        }
      : () => main();

  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
