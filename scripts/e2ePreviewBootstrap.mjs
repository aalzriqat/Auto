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
const PREVIEW_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}$/;

export function sanitizePreviewName(raw) {
  const lowered = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  return lowered.slice(0, 61);
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
  if (!functionName || !/^[A-Za-z0-9_/]+:[A-Za-z0-9_]+$/.test(functionName)) {
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
  return id;
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
 */
function runConvex(args) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpm, args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Could not start \`${pnpm} ${args.join(" ")}\`: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`\`${pnpm} ${args.join(" ")}\` failed with exit code ${result.status}.`);
  }
}

export async function main(env = process.env) {
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
  const primaryClerkUserId = await resolveClerkUserId({ email: primaryEmail, secretKey });
  const approverClerkUserId = await resolveClerkUserId({ email: approverEmail, secretKey });

  /**
   * The URL the browser is about to drive, captured by the deploy step.
   *
   * Passed so the SERVER can compare it with its own `CONVEX_CLOUD_URL` and
   * refuse a mismatch. Without it, a `--preview-name` that resolved to some
   * other preview would seed one database while the suite drove another, and
   * every spec would fail as though the product were broken.
   */
  const expectedCloudUrl = env.NEXT_PUBLIC_CONVEX_URL;

  console.log(
    `Seeding preview "${previewName}" at ${expectedCloudUrl ?? "<no URL supplied>"}: ` +
      `${maskEmail(primaryEmail)} -> ${primaryClerkUserId}, ` +
      `${maskEmail(approverEmail)} -> ${approverClerkUserId}`,
  );

  runConvex(
    buildConvexRunArgs({
      functionName: "e2eBootstrap:bootstrapE2EOrganization",
      argsJson: JSON.stringify({
        primary: { clerkUserId: primaryClerkUserId, email: primaryEmail, name: "E2E Salesperson" },
        approver: { clerkUserId: approverClerkUserId, email: approverEmail, name: "E2E Manager" },
        ...(expectedCloudUrl ? { expectedCloudUrl } : {}),
      }),
      previewName,
      deployKey,
      env,
    }),
  );

  runConvex(
    buildConvexRunArgs({
      functionName: "e2eBootstrap:assertE2EBootstrap",
      argsJson: JSON.stringify({
        primaryClerkUserId,
        approverClerkUserId,
        ...(expectedCloudUrl ? { expectedCloudUrl } : {}),
      }),
      previewName,
      deployKey,
      env,
    }),
  );
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const [mode, value] = process.argv.slice(2);
  const run =
    mode === "--print-name"
      ? async () => {
          const name = sanitizePreviewName(value);
          if (!PREVIEW_NAME_PATTERN.test(name)) {
            throw new PreviewTargetingError(
              `Could not derive a safe preview name from ${JSON.stringify(value)}.`,
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
