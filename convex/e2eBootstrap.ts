/**
 * SCRUM-143 — deterministic QA bootstrap for a FRESH Convex preview deployment.
 *
 * ## The failure this replaces
 *
 * Every Playwright run claims a brand-new Convex preview deployment, whose
 * database is completely empty: no `organizations`, no `roles`, no
 * `memberships`, and no `users` (the Clerk -> Convex webhook points at one
 * fixed URL and never reaches an ephemeral preview). So both auth-setup
 * fixtures signed in successfully and then landed on the orgless "How will you
 * be using AutoFlow?" choice screen. Measured at `90d5f03fe`, run
 * `33933915963`: **22 tests discovered, 2 auth-setup tests failed, 20 product
 * specs did not run.**
 *
 * The suite was right to refuse. Letting a fixture click through the wizard
 * would create a second, empty dealership and produce a green suite that
 * proved nothing — and it could not give the approver a seat in the first
 * dealership at all, which is exactly the separation-of-duties path the
 * financed-deal specs exist to cover.
 *
 * ## What this module is, and what stops it being an admin bypass
 *
 * Both entry points are `internalMutation`s: they are unreachable from any
 * client, and callable only by something already holding an admin/deploy key
 * for the deployment. That bounds *privilege*. What it does not bound is
 * *operator error* — pointing a seed at production instead of a preview — so
 * there are four independent controls, and every one of them has to hold:
 *
 * 1. **The CI path cannot carry it to production.** `markPreviewDeployment` is
 *    invoked through the deploy command's `--preview-run` hook, which the CLI
 *    reaches only on the preview branch of its deploy path and only for a
 *    NEWLY-CLAIMED preview deployment. A production deploy ignores the flag
 *    outright, so *the workflow* never mints the marker anywhere else.
 * 2. **The seed refuses without that marker.** `bootstrapE2EOrganization`
 *    reads the marker row before it writes anything. No marker, no writes.
 * 3. **The marker refuses a deployment that looks real.**
 *    `markPreviewDeployment` fails closed if the deployment holds any
 *    organization, membership or user, OR if it carries deployment
 *    environment variables that only a configured production/dev deployment
 *    has. See `assertDeploymentLooksDisposable` for what that does and does
 *    not prove.
 * 4. **The marker vouches for exactly one deployment.** It records
 *    `CONVEX_CLOUD_URL` at minting time, requires that variable to exist, and
 *    both entry points re-check it against the URL the browser will drive, so
 *    a marker carried in by a snapshot import cannot authorize the deployment
 *    it landed on and a command aimed at one preview cannot seed another.
 *
 * ## ⚠️ WHAT CONTROL 3 DOES NOT PROVE — READ THIS BEFORE TRUSTING IT
 *
 * Convex exposes **no deployment-type signal** to a running function. There is
 * `CONVEX_CLOUD_URL` and `CONVEX_SITE_URL`, and both are opaque hostnames. So
 * nothing here can *prove* "this is a preview". What controls 3 and 4 actually
 * establish is narrower, and the difference matters:
 *
 *   > this deployment holds no tenant rows, is not configured like a real
 *   > deployment, and is the one the caller aimed at.
 *
 * A **production deployment that had been emptied and stripped of its
 * integration secrets** would still satisfy that. That is not hypothetical for
 * this repository — SCRUM-231 plans exactly such a wipe — which is why this
 * paragraph exists instead of a comment claiming the case is closed. Both
 * adversarial reviewers reached this independently on PR #278.
 *
 * Closing it properly needs a signal the deployment itself carries and a
 * caller cannot supply: a **Preview-scoped Convex Default Environment
 * Variable**, the same mechanism `.github/workflows/playwright.yml` already
 * relies on for `CLERK_JWT_ISSUER_DOMAIN` and three others. That is a one-time
 * project-settings action, tracked as the follow-up on SCRUM-143. Until it
 * exists, the residual is stated here rather than papered over.
 *
 * And on the caller's side, `scripts/e2ePreviewBootstrap.mjs` refuses to
 * invoke either function unless `CONVEX_DEPLOY_KEY` is a *preview* deploy key
 * and an explicit `--preview-name` is supplied — because the CLI's own default
 * for an unspecified target resolves to the project's personal DEV deployment,
 * which this must never touch.
 *
 * ## What it seeds, and what it deliberately does not
 *
 * One organization, the product's own default roles, one membership per
 * configured Clerk identity, and the org-level baseline the app needs to
 * render at all (settings, lead sources, pipeline stages). Nothing else.
 * Vehicles, customers, leads, deals and money stay where they belong — in the
 * specs that create them through the interface. A large opaque seed database
 * is how an E2E suite starts proving that fixtures exist rather than that the
 * product works.
 */
import { v, ConvexError } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { createOrganizationWithDefaultRoles } from "./organizations";
import { DEFAULT_LEAD_SOURCES } from "./orgLeadSources";
import { DEFAULT_STAGES } from "./orgPipelineStages";
import { DEFAULT_SETTINGS } from "./orgSettings";
import { PERMISSIONS, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";

/** Prefix on every error this module throws, so a CI log names the subsystem. */
const ERR = "E2E_BOOTSTRAP";

export const E2E_ORGANIZATION_NAME = "AutoFlow E2E QA Dealership";

/** The salesperson seat — the identity every existing spec runs as. */
export const E2E_PRIMARY_ROLE_NAME = SYSTEM_OWNER_ROLE_NAME;

/**
 * The approving colleague's seat.
 *
 * MANAGER rather than a bespoke role: it is the product's own answer to "who
 * at this dealership may approve a financed deal", and it already carries
 * every permission the approval path needs (asserted below rather than
 * assumed). Inventing an E2E-only permission set here would mean the suite
 * proves an authority configuration no real dealership has.
 */
export const E2E_APPROVER_ROLE_NAME = "MANAGER";

/**
 * The authority the approval E2E path cannot run without.
 *
 * Asserted against the seeded role rather than trusted, so a future edit to
 * `DEFAULT_ROLE_TEMPLATES` that drops one of these fails the bootstrap with a
 * precise reason instead of failing a browser spec twenty minutes later with
 * a spinner that never resolves.
 */
export const E2E_APPROVER_REQUIRED_PERMISSIONS: string[] = [
  PERMISSIONS.APPROVE_FINANCE_APPLICATION,
  PERMISSIONS.REVIEW_FINANCE_APPLICATION,
  PERMISSIONS.APPROVE_REQUESTS,
  PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
];

type SeatKey = "primary" | "approver";

const SEAT_LABEL: Record<SeatKey, string> = {
  primary: "E2E_LOGIN_USER",
  approver: "E2E_APPROVER_USER",
};

const identityValidator = v.object({
  /** Clerk's stable user id (`user_…`) — the JWT `subject` the backend keys on. */
  clerkUserId: v.string(),
  email: v.string(),
  name: v.optional(v.string()),
});

type Identity = { clerkUserId: string; email: string; name?: string };

/**
 * Never echo a whole configured address back into a CI log.
 *
 * The E2E account addresses are repository secrets. GitHub masks known secret
 * values in its own log stream, but a Convex function's error travels through
 * the CLI, the deployment's log stream and the Convex dashboard, none of which
 * know what a GitHub secret is. So an error that has to identify WHICH
 * identity failed names the environment variable, and shows at most enough of
 * the address to tell two apart.
 */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "<redacted>";
  const local = email.slice(0, at);
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${email.slice(at + 1)}`;
}

function requireNonBlank(value: string, what: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConvexError(`${ERR}: ${what} is empty. ${what} must be a non-blank value.`);
  }
  return trimmed;
}

function normalizeIdentity(seat: SeatKey, identity: Identity): Identity {
  return {
    clerkUserId: requireNonBlank(identity.clerkUserId, `${SEAT_LABEL[seat]} clerkUserId`),
    email: requireNonBlank(identity.email, `${SEAT_LABEL[seat]} email`).toLowerCase(),
    name: identity.name?.trim() || undefined,
  };
}

function currentCloudUrl(): string | null {
  const raw = process.env.CONVEX_CLOUD_URL;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * The deployment's own name, taken from the host's first label.
 *
 * Compared instead of the whole URL because the caller's value comes from the
 * CLI's canonical-URL lookup and the server's from its own environment; those
 * are two different sources for one identity and could differ in scheme or
 * suffix without meaning different deployments. The NAME is the identity.
 */
function deploymentNameFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    const [name] = host.split(".");
    return name && name.trim() ? name : null;
  } catch {
    return null;
  }
}

/**
 * ⚠️ THE CALLER SAYS WHICH DEPLOYMENT IT MEANT; THE SERVER SAYS WHICH IT IS.
 *
 * `expectedCloudUrl` is the URL the browser will actually talk to, captured
 * from the deploy step. It is EVIDENCE, never authority: a mismatch refuses,
 * and a caller cannot make a match happen by declaring one, because the other
 * half is read from this deployment's own environment. Without it, a
 * `--preview-name` that resolved to some other preview would seed one database
 * while the suite drove another, and every spec would fail as though the
 * product were broken.
 *
 * ⚠️ FAILS CLOSED IN BOTH DIRECTIONS, and that is a deliberate change.
 *
 * An earlier revision returned `"SKIPPED — …"` when either half was missing. As
 * an adversarial reviewer put it: for this mutation's control flow a SKIP has
 * exactly the same effect as a PASS, so the control could have been silently
 * inert on every invocation and nothing would have said so.
 *
 * What made refusing safe was evidence, not preference: PR #278's run
 * `33940299176` seeded a real preview and the mutation returned
 * `"VERIFIED — impressive-ox-948"`. So `CONVEX_CLOUD_URL` **is** populated in
 * the real Convex function runtime, and demanding it costs nothing that works
 * today. Before that run this could only have been asserted; `convex-test` does
 * not set the variable, so no unit test could ever have established it.
 */
function checkDeploymentIdentity(expectedCloudUrl: string | undefined): string {
  const expected = deploymentNameFromUrl(expectedCloudUrl?.trim() || null);
  const actual = deploymentNameFromUrl(currentCloudUrl());

  if (!expected) {
    throw new ConvexError(
      `${ERR}: no expected deployment URL was supplied, so this command cannot prove it is seeding the deployment the ` +
        `browser will drive. Pass \`expectedCloudUrl\` (the workflow takes it from NEXT_PUBLIC_CONVEX_URL). Refusing.`
    );
  }
  if (!actual) {
    throw new ConvexError(
      `${ERR}: this deployment does not expose a readable CONVEX_CLOUD_URL, so its identity cannot be established. ` +
        `Refusing rather than proceeding on an unverifiable target.`
    );
  }
  if (expected !== actual) {
    throw new ConvexError(
      `${ERR}: this command was aimed at deployment "${expected}" but is executing on "${actual}". ` +
        `Seeding one deployment while the browser drives another would fail every spec as though the product were broken. Refusing.`
    );
  }
  return `VERIFIED — ${actual}`;
}

/**
 * Environment variables a configured PRODUCTION or DEV deployment carries and a
 * freshly-claimed preview does not.
 *
 * ⚠️ THIS IS A DENYLIST AND IT IS DEFENCE IN DEPTH, NOT A PROOF. It raises the
 * bar from "no tenant rows right now" to "no tenant rows AND not configured
 * like a real deployment", which removes the realistic version of the residual
 * described at the top of this file: an emptied production deployment still
 * carries `SUPER_ADMIN_EMAILS`, `RESEND_API_KEY` and its webhook secrets long
 * after its tables are cleared.
 *
 * ⚠️ DELIBERATELY EXCLUDES the four variables the project sets as Preview
 * defaults — `CLERK_JWT_ISSUER_DOMAIN`, `CLERK_DEV_JWT_ISSUER_DOMAIN`,
 * `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_APP_URL` — because a legitimate preview
 * has exactly those. If a future default is added to the Preview scope and also
 * appears here, marking fails closed and names the variable, which is the safe
 * direction and a one-line fix.
 */
const REAL_DEPLOYMENT_ENV_MARKERS = [
  "SUPER_ADMIN_EMAILS",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "CLERK_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET",
  "TAP_SECRET_API_KEY",
  "PAYMENT_WEBHOOK_SECRET",
  "VAPID_PRIVATE_KEY",
  "INSTAGRAM_APP_SECRET",
  "FACEBOOK_APP_SECRET",
  "WHATSAPP_APP_SECRET",
] as const;

function presentRealDeploymentMarkers(): string[] {
  return REAL_DEPLOYMENT_ENV_MARKERS.filter((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

// ─── The preview marker ──────────────────────────────────────────────────────

async function readMarker(ctx: QueryCtx | MutationCtx): Promise<Doc<"e2ePreviewBootstrap"> | null> {
  return await ctx.db.query("e2ePreviewBootstrap").first();
}

/**
 * ⚠️ FAIL CLOSED. Every caller of this treats a returned marker as proof that
 * the deployment is a throwaway preview, so an unreadable or foreign marker
 * must refuse rather than degrade.
 */
async function requireMarker(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"e2ePreviewBootstrap">> {
  const marker = await readMarker(ctx);
  if (!marker) {
    throw new ConvexError(
      `${ERR}: this deployment carries no preview bootstrap marker, so it has not been proven to be a disposable preview. ` +
        `The marker is minted only by \`e2eBootstrap:markPreviewDeployment\`, which the Convex CLI runs through the deploy command's ` +
        `\`--preview-run\` hook on a newly-claimed PREVIEW deployment and never on production. Refusing to seed.`
    );
  }
  assertMarkerBelongsToThisDeployment(marker);
  return marker;
}

/**
 * ⚠️ FAILS CLOSED ON A MISSING HALF, not just on a mismatch.
 *
 * The previous shape was `marker.convexCloudUrl && here && a !== b`, which
 * short-circuits to "fine" whenever either side is absent — so the one case
 * this check exists for (a marker that arrived from somewhere else, most
 * plausibly a snapshot import, and therefore may well carry no URL) was the
 * case it silently permitted. Both halves are now required.
 */
function assertMarkerBelongsToThisDeployment(marker: Doc<"e2ePreviewBootstrap">): void {
  const here = currentCloudUrl();
  if (!here) {
    throw new ConvexError(
      `${ERR}: this deployment does not expose a readable CONVEX_CLOUD_URL, so the marker's claim about which ` +
        `deployment it vouches for cannot be checked. Refusing.`
    );
  }
  if (!marker.convexCloudUrl) {
    throw new ConvexError(
      `${ERR}: the marker on this deployment names no deployment, so it cannot vouch for this one. ` +
        `Re-create the preview so a marker is minted here rather than inherited.`
    );
  }
  if (marker.convexCloudUrl !== here) {
    throw new ConvexError(
      `${ERR}: the preview bootstrap marker on this deployment was minted for ${marker.convexCloudUrl}, but this deployment is ${here}. ` +
        `A marker vouches for exactly one deployment; this one appears to have travelled (a snapshot import, most likely). Refusing to seed.`
    );
  }
}

/**
 * The deployment holds no tenant data AND is not configured like a real one.
 *
 * ⚠️ NAMED FOR WHAT IT PROVES. This was called `assertDeploymentIsPristine`,
 * and both adversarial reviewers on PR #278 landed on the same objection: the
 * name and its surrounding comments claimed the marker "cannot be minted on a
 * deployment that holds real tenants", while the code only ever established
 * "no rows exist in three tables at this instant" — a strictly weaker, purely
 * temporal condition. The gap is not academic for this repository, where
 * SCRUM-231 plans to empty production.
 *
 * Every check here is read from server state a caller cannot influence: loaded
 * rows and the deployment's own environment. None of them is a proof of
 * deployment TYPE, because Convex exposes no such signal to a function — see
 * the file header.
 */
async function assertDeploymentLooksDisposable(ctx: MutationCtx): Promise<void> {
  const configured = presentRealDeploymentMarkers();
  if (configured.length > 0) {
    throw new ConvexError(
      `${ERR}: refusing to mark this deployment — it carries environment variables that only a configured ` +
        `production or dev deployment has (${configured.join(", ")}). A freshly-claimed preview has none of them. ` +
        `If one of these was legitimately added to the project's PREVIEW default environment variables, remove it from ` +
        `REAL_DEPLOYMENT_ENV_MARKERS in convex/e2eBootstrap.ts.`
    );
  }

  const org = await ctx.db.query("organizations").first();
  if (org) {
    throw new ConvexError(
      `${ERR}: refusing to mark this deployment — it already contains at least one organization (${org._id}). ` +
        `The preview marker may only be minted on an empty, freshly-claimed preview deployment.`
    );
  }
  const membership = await ctx.db.query("memberships").first();
  if (membership) {
    throw new ConvexError(
      `${ERR}: refusing to mark this deployment — it already contains at least one membership (${membership._id}). ` +
        `The preview marker may only be minted on an empty, freshly-claimed preview deployment.`
    );
  }
  const user = await ctx.db.query("users").first();
  if (user) {
    throw new ConvexError(
      `${ERR}: refusing to mark this deployment — it already contains at least one user (${user._id}). ` +
        `The preview marker may only be minted on an empty, freshly-claimed preview deployment.`
    );
  }
}

/**
 * Records that this deployment is a disposable E2E preview.
 *
 * Takes no arguments, because the CLI's `--preview-run` hook always invokes
 * its function with `{}` — which is also why the identity binding lives in a
 * second, separately-targeted call rather than here.
 */
export const markPreviewDeployment = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await readMarker(ctx);
    if (existing) {
      assertMarkerBelongsToThisDeployment(existing);
      return { status: "ALREADY_MARKED" as const, markerId: existing._id };
    }

    await assertDeploymentLooksDisposable(ctx);

    // ⚠️ REQUIRED, not best-effort. The marker's whole job downstream is to say
    // WHICH deployment it vouches for; one minted without a recorded URL would
    // authorize any deployment it were later copied to, because
    // `assertMarkerBelongsToThisDeployment` can only compare what is there.
    const cloudUrl = currentCloudUrl();
    if (!cloudUrl) {
      throw new ConvexError(
        `${ERR}: this deployment does not expose a readable CONVEX_CLOUD_URL, so a marker minted here could not name ` +
          `the deployment it vouches for. Refusing to mint an unattributable marker.`
      );
    }

    const markerId = await ctx.db.insert("e2ePreviewBootstrap", {
      markedAt: Date.now(),
      convexCloudUrl: cloudUrl,
    });
    return { status: "MARKED" as const, markerId, convexCloudUrl: cloudUrl };
  },
});

// ─── Seat binding ────────────────────────────────────────────────────────────

async function findUserByClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkUserId: string
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkUserId))
    .unique();
}

/**
 * Idempotent by `clerkId`, which is the key `requireAuth` resolves an
 * authenticated caller through. Binding on anything else — the email, say —
 * would seed a row the signed-in identity never resolves to, and
 * `requireOrCreateAuthenticatedUser` would then insert a SECOND user row on
 * the fixture's first write, leaving the membership attached to the wrong one.
 */
async function upsertUser(
  ctx: MutationCtx,
  seat: SeatKey,
  identity: Identity
): Promise<Doc<"users">> {
  const existing = await findUserByClerkId(ctx, identity.clerkUserId);
  if (existing) {
    const patch: Partial<Doc<"users">> = {};
    if (existing.email !== identity.email) patch.email = identity.email;
    if (identity.name && existing.name !== identity.name) patch.name = identity.name;
    if (existing.disabled) patch.disabled = false;
    if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
    const refreshed = await ctx.db.get(existing._id);
    if (!refreshed) {
      throw new ConvexError(`${ERR}: ${SEAT_LABEL[seat]}'s user row vanished mid-bootstrap.`);
    }
    return refreshed;
  }

  const collision = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", identity.email))
    .first();
  if (collision) {
    throw new ConvexError(
      `${ERR}: ${SEAT_LABEL[seat]} (${maskEmail(identity.email)}) resolves to Clerk user ${identity.clerkUserId}, ` +
        `but this deployment already holds a different user row with that address (clerkId ${collision.clerkId}). ` +
        `Two Clerk identities cannot share one address; check which Clerk instance the E2E secrets belong to.`
    );
  }

  const userId = await ctx.db.insert("users", {
    clerkId: identity.clerkUserId,
    email: identity.email,
    name: identity.name,
  });
  const created = await ctx.db.get(userId);
  if (!created) {
    throw new ConvexError(`${ERR}: failed to create ${SEAT_LABEL[seat]}'s user row.`);
  }
  return created;
}

async function findRoleByName(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  name: string
): Promise<Doc<"roles"> | null> {
  const roles = await ctx.db
    .query("roles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  return roles.find((role) => role.name === name && !role.isDeleted) ?? null;
}

async function membershipsOf(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">
): Promise<Doc<"memberships">[]> {
  return await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
}

/**
 * ⚠️ A MEMBERSHIP IN ANOTHER ORGANIZATION IS A REFUSAL, NOT SOMETHING TO FIX.
 *
 * The suite's whole contract is that both identities operate inside ONE
 * dealership. An identity that already belongs somewhere else means either the
 * deployment is not the pristine preview this believes it is, or a previous
 * run seeded a different org — and silently adding a second membership would
 * make `organizations.listMine` order-dependent, so the fixtures would land in
 * whichever dealership happened to sort first.
 */
async function bindMembership(
  ctx: MutationCtx,
  seat: SeatKey,
  user: Doc<"users">,
  orgId: Id<"organizations">,
  roleName: string
): Promise<{ membershipId: Id<"memberships">; roleId: Id<"roles">; created: boolean }> {
  const role = await findRoleByName(ctx, orgId, roleName);
  if (!role) {
    throw new ConvexError(
      `${ERR}: the QA organization has no role named ${roleName}, so ${SEAT_LABEL[seat]} cannot be seated. ` +
        `Roles are seeded from DEFAULT_ROLE_TEMPLATES; a rename there needs the same rename here.`
    );
  }

  const existing = await membershipsOf(ctx, user._id);
  const foreign = existing.filter((m) => m.orgId !== orgId);
  if (foreign.length > 0) {
    throw new ConvexError(
      `${ERR}: ${SEAT_LABEL[seat]} (${maskEmail(user.email)}) already belongs to a DIFFERENT organization ` +
        `(${foreign.map((m) => m.orgId).join(", ")}) on this deployment, while the QA organization is ${orgId}. ` +
        `Both E2E identities must sit in the same dealership. Refusing to add a second membership.`
    );
  }

  const here = existing.find((m) => m.orgId === orgId);
  if (here) {
    if (here.roleId !== role._id) {
      await ctx.db.patch(here._id, { roleId: role._id });
    }
    return { membershipId: here._id, roleId: role._id, created: false };
  }

  const membershipId = await ctx.db.insert("memberships", {
    orgId,
    userId: user._id,
    roleId: role._id,
  });
  return { membershipId, roleId: role._id, created: true };
}

// ─── Org-level baseline ──────────────────────────────────────────────────────

/**
 * The minimum an authenticated page needs to render — and no more.
 *
 * `enabledPaymentTypes` carries INSTALLMENT because the financed-deal and
 * profit-approval specs enter through the installment sale button, which the
 * sales page only renders when the org enables that payment type.
 */
async function seedOrgBaseline(ctx: MutationCtx, orgId: Id<"organizations">): Promise<void> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .first();
  if (!settings) {
    await ctx.db.insert("orgSettings", {
      orgId,
      currency: DEFAULT_SETTINGS.currency,
      currencySymbol: DEFAULT_SETTINGS.currencySymbol,
      enabledPaymentTypes: [...DEFAULT_SETTINGS.enabledPaymentTypes],
      dealershipName: E2E_ORGANIZATION_NAME,
    });
  }

  const existingSources = await ctx.db
    .query("orgLeadSources")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .first();
  if (!existingSources) {
    for (let i = 0; i < DEFAULT_LEAD_SOURCES.length; i++) {
      await ctx.db.insert("orgLeadSources", {
        orgId,
        label: DEFAULT_LEAD_SOURCES[i],
        isActive: true,
        order: i,
      });
    }
  }

  const existingStages = await ctx.db
    .query("orgPipelineStages")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const existingKeys = new Set(existingStages.map((stage) => stage.stageKey));
  for (const stage of DEFAULT_STAGES) {
    if (!existingKeys.has(stage.stageKey)) {
      await ctx.db.insert("orgPipelineStages", { orgId, ...stage, isActive: true });
    }
  }
}

// ─── The bootstrap ───────────────────────────────────────────────────────────

/**
 * Resolves the one QA organization, creating it on the first run.
 *
 * The marker's `orgId` is the identity — not the organization's NAME. A name
 * match would happily adopt an unrelated organization that someone happened to
 * call the same thing, which on a deployment this is not supposed to be
 * running against is exactly the wrong direction to fail in.
 */
async function resolveQaOrganization(
  ctx: MutationCtx,
  marker: Doc<"e2ePreviewBootstrap">,
  ownerUserId: Id<"users">
): Promise<{ orgId: Id<"organizations">; created: boolean }> {
  if (marker.orgId) {
    const existing = await ctx.db.get(marker.orgId);
    if (existing) return { orgId: existing._id, created: false };
    throw new ConvexError(
      `${ERR}: the marker points at organization ${marker.orgId}, which no longer exists on this deployment. ` +
        `Re-create the preview deployment rather than seeding a second dealership beside a dangling pointer.`
    );
  }

  const stray = await ctx.db.query("organizations").first();
  if (stray) {
    throw new ConvexError(
      `${ERR}: this deployment already holds organization ${stray._id} ("${stray.name}") that the E2E bootstrap did not create. ` +
        `Refusing to add a QA dealership beside existing tenant data.`
    );
  }

  const orgId = await createOrganizationWithDefaultRoles(ctx, {
    name: E2E_ORGANIZATION_NAME,
    ownerUserId,
  });
  return { orgId, created: true };
}

/**
 * Seeds the QA dealership and seats both configured Clerk identities in it.
 *
 * Idempotent: a second run against the same preview re-uses the organization,
 * the roles, the users and the memberships, and adds nothing. That is what
 * lets `auth.setup.ts` stop guessing whether a previous run already seeded
 * anything — it never has to look.
 */
export const bootstrapE2EOrganization = internalMutation({
  args: {
    primary: identityValidator,
    approver: identityValidator,
    /** The URL the browser will drive. Evidence, checked against this deployment's own. */
    expectedCloudUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const deploymentIdentity = checkDeploymentIdentity(args.expectedCloudUrl);
    const marker = await requireMarker(ctx);

    const primary = normalizeIdentity("primary", args.primary);
    const approver = normalizeIdentity("approver", args.approver);

    // ⚠️ SEPARATION OF DUTIES IS SEEDED, NOT ASSUMED. `approveDealerPurchaseAmount`
    // and `updateStatus` both refuse the application's own salesperson. Seat the
    // same person twice and every approval spec fails deep inside a wizard with
    // a permissions-shaped error, rather than here with the real reason.
    if (primary.clerkUserId === approver.clerkUserId) {
      throw new ConvexError(
        `${ERR}: ${SEAT_LABEL.primary} and ${SEAT_LABEL.approver} resolve to the same Clerk user (${primary.clerkUserId}). ` +
          `AutoFlow refuses to let one person both create and approve a deal, so the approval E2E path cannot be driven by one identity. ` +
          `Provision a second Clerk account rather than pointing both secrets at one.`
      );
    }
    if (primary.email === approver.email) {
      throw new ConvexError(
        `${ERR}: ${SEAT_LABEL.primary} and ${SEAT_LABEL.approver} carry the same address (${maskEmail(primary.email)}). ` +
          `The two seats must be two different people.`
      );
    }

    const primaryUser = await upsertUser(ctx, "primary", primary);
    const { orgId, created: orgCreated } = await resolveQaOrganization(ctx, marker, primaryUser._id);
    const approverUser = await upsertUser(ctx, "approver", approver);

    const primarySeat = await bindMembership(
      ctx,
      "primary",
      primaryUser,
      orgId,
      E2E_PRIMARY_ROLE_NAME
    );
    const approverSeat = await bindMembership(
      ctx,
      "approver",
      approverUser,
      orgId,
      E2E_APPROVER_ROLE_NAME
    );

    await seedOrgBaseline(ctx, orgId);

    await ctx.db.patch(marker._id, { orgId, bootstrappedAt: Date.now() });

    return {
      orgId,
      deploymentIdentity,
      organizationCreated: orgCreated,
      primary: {
        userId: primaryUser._id,
        roleName: E2E_PRIMARY_ROLE_NAME,
        membershipCreated: primarySeat.created,
      },
      approver: {
        userId: approverUser._id,
        roleName: E2E_APPROVER_ROLE_NAME,
        membershipCreated: approverSeat.created,
      },
    };
  },
});

// ─── The preflight ───────────────────────────────────────────────────────────

async function describeSeat(
  ctx: QueryCtx,
  seat: SeatKey,
  clerkUserId: string,
  orgId: Id<"organizations">
): Promise<{ userId: Id<"users">; roleName: string; permissions: string[] }> {
  const user = await findUserByClerkId(ctx, clerkUserId);
  if (!user) {
    throw new ConvexError(
      `${ERR}: ${SEAT_LABEL[seat]} (Clerk user ${clerkUserId}) has no user row on this deployment, ` +
        `so it belongs to no dealership and will land on the orgless "How will you be using AutoFlow?" screen. ` +
        `The bootstrap did not run, or ran against a different deployment.`
    );
  }
  if (user.disabled) {
    throw new ConvexError(`${ERR}: ${SEAT_LABEL[seat]} is disabled on this deployment.`);
  }

  const memberships = await membershipsOf(ctx, user._id);
  if (memberships.length === 0) {
    throw new ConvexError(
      `${ERR}: ${SEAT_LABEL[seat]} (${maskEmail(user.email)}) has a user row but NO membership, ` +
        `so it belongs to no dealership. The bootstrap did not seat it.`
    );
  }
  const foreign = memberships.filter((m) => m.orgId !== orgId);
  if (foreign.length > 0) {
    throw new ConvexError(
      `${ERR}: ${SEAT_LABEL[seat]} belongs to organization(s) ${foreign
        .map((m) => m.orgId)
        .join(", ")}, not the QA organization ${orgId}. Both identities must sit in the same dealership.`
    );
  }

  const membership = memberships[0];
  const role = await ctx.db.get(membership.roleId);
  if (!role) {
    throw new ConvexError(
      `${ERR}: ${SEAT_LABEL[seat]}'s membership points at role ${membership.roleId}, which does not exist.`
    );
  }
  return { userId: user._id, roleName: role.name, permissions: role.permissions };
}

/**
 * Proves the seeded state is actually usable BEFORE a browser starts.
 *
 * Separate from the bootstrap on purpose. The bootstrap's own success proves
 * that its writes did not throw; it does not prove that what is now on the
 * deployment satisfies the suite's contract — a mutation that took the "reuse
 * everything" path on a half-seeded preview would report success either way.
 * This re-reads the state from scratch and fails with the specific reason, so
 * an infrastructure fault reports as an infrastructure fault instead of as
 * twenty product specs timing out.
 */
export const assertE2EBootstrap = internalQuery({
  args: {
    primaryClerkUserId: v.string(),
    approverClerkUserId: v.string(),
    expectedCloudUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const deploymentIdentity = checkDeploymentIdentity(args.expectedCloudUrl);
    const marker = await readMarker(ctx);
    if (!marker) {
      throw new ConvexError(
        `${ERR}: no preview bootstrap marker on this deployment — nothing has been seeded here.`
      );
    }
    assertMarkerBelongsToThisDeployment(marker);
    if (!marker.orgId || !marker.bootstrappedAt) {
      throw new ConvexError(
        `${ERR}: this deployment is marked as a preview but was never seeded (no QA organization recorded on the marker).`
      );
    }

    const org = await ctx.db.get(marker.orgId);
    if (!org) {
      throw new ConvexError(
        `${ERR}: the QA organization ${marker.orgId} recorded on the marker no longer exists.`
      );
    }
    if (org.suspended) {
      throw new ConvexError(`${ERR}: the QA organization ${org._id} is suspended.`);
    }

    const primaryClerkUserId = requireNonBlank(args.primaryClerkUserId, "primaryClerkUserId");
    const approverClerkUserId = requireNonBlank(args.approverClerkUserId, "approverClerkUserId");
    if (primaryClerkUserId === approverClerkUserId) {
      throw new ConvexError(
        `${ERR}: both seats resolve to Clerk user ${primaryClerkUserId}; separation of duties makes the approval path undrivable.`
      );
    }

    const primary = await describeSeat(ctx, "primary", primaryClerkUserId, org._id);
    const approver = await describeSeat(ctx, "approver", approverClerkUserId, org._id);

    if (primary.userId === approver.userId) {
      throw new ConvexError(
        `${ERR}: both seats resolve to the same user row (${primary.userId}).`
      );
    }

    const held = new Set(approver.permissions);
    const missing = E2E_APPROVER_REQUIRED_PERMISSIONS.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw new ConvexError(
        `${ERR}: ${SEAT_LABEL.approver} holds role "${approver.roleName}", which is missing ${missing.join(", ")}. ` +
          `The approval E2E path cannot be driven without it.`
      );
    }

    return {
      orgId: org._id,
      orgName: org.name,
      deploymentIdentity,
      /**
       * Diagnostic, deliberately narrow: the NAMES (never the values) of the
       * `CONVEX_*` variables this deployment exposes.
       *
       * It answers one open question cheaply and from the real runtime — does
       * Convex give a function any signal of its deployment's TYPE? Today the
       * answer is no, which is why the file header's residual exists; if a
       * future Convex release adds one, this line is where it shows up. Names
       * only: `CONVEX_*` names are already public in `convex/utils/env.ts`, so
       * this discloses nothing a reader of the repository lacks.
       */
      convexEnvNames: Object.keys(process.env)
        .filter((name) => name.startsWith("CONVEX_"))
        .sort(),
      primary: { userId: primary.userId, roleName: primary.roleName },
      approver: { userId: approver.userId, roleName: approver.roleName },
    };
  },
});
