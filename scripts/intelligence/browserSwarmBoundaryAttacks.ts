/**
 * SCRUM-350 — executable TENANT_ESCAPE, AUTHORIZATION_ABUSE,
 * COMPLETENESS_BOUNDARY and LIFECYCLE_REVERSAL browser attacks.
 *
 * Each attack drives the REAL authenticated web session against the isolated,
 * marker-gated disposable preview with run-unique synthetic data, and judges
 * only BACKEND authority (a refusal, or state read back through a
 * permission-checked public query). The pure judgements live in
 * browserSwarmBoundaryOracle.ts; the mission lifecycle in
 * browserSwarmBoundaryHarness.ts. Nothing here launches a browser.
 *
 * What each attack does and does NOT cover is stated on the attack itself, so a
 * green run is not read as proof of more than it exercised.
 */
import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "../../convex/utils/permissions";
import type { BrowserAttackHandlerRegistry } from "./browserAttackSwarmExecutor";
import {
  AUTHORIZATION_REFUSAL,
  POSTED_HISTORY_REFUSAL,
  REPLAY_REFUSAL,
  TENANT_REFUSAL,
  describeError,
  evaluateListCompleteness,
  evaluateReversalReconciliation,
  judgeRefusedAttempt,
  judgeTenantRead,
  judgeUnchanged,
  probe,
  type Judgement,
  type LedgerEvent,
  type LedgerLine,
  type LedgerSnapshot,
  type ProbeOutcome,
} from "./browserSwarmBoundaryOracle";
import { runBoundaryMission, type BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import {
  UI_STEP_TIMEOUT_MS,
  gotoExpenses,
  untilAborted,
  type MissionBrowserRuntime,
} from "./browserSwarmEconomicAttacks";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import { depositVoidTransitionSpec } from "./browserSwarmLifecycleAttack";

export interface BoundaryAttackOptions {
  /** Replaces real waiting so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** How long the page may take to settle a search over a seeded list. */
  searchSettleMs?: number;
  /** Poll interval while waiting on the page or on the ledger. */
  pollMs?: number;
  /** How long a freshly created expense may take to reach the ledger. */
  postingWaitMs?: number;
  /** How long a screen may take to answer before its silence is reported as unjudged. */
  uiSettleMs?: number;
}

const DEFAULTS = {
  searchSettleMs: 30_000,
  pollMs: 500,
  postingWaitMs: 20_000,
  uiSettleMs: 15_000,
} as const;

/** `customers.list` loads this many rows before a user asks for more. */
const CUSTOMER_FIRST_PAGE = 25;
/** One more than a page holds, so at least one match always sits past the first page. */
const COMPLETENESS_SEED_ROWS = CUSTOMER_FIRST_PAGE + 1;
const MAX_WALK_PAGES = 50;
const WALK_PAGE_SIZE = 100;
const LEDGER_ROW_LIMIT = 200;
const LEDGER_MAX_READS = 40;
const RATE_LIMIT_RETRIES = 3;

function inconclusive(message: string): never {
  throw new BrowserSwarmOracleInconclusiveError(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) inconclusive(`${label} returned a non-array response`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") inconclusive(`${label} carried a non-string field`);
  return value;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Walks a paginated query to its end; a list that never ends is inconclusive. */
async function walkPages(
  fetchPage: (cursor: string | null) => Promise<unknown>,
  label: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < MAX_WALK_PAGES; pageIndex += 1) {
    const result = await fetchPage(cursor);
    if (!isRecord(result) || typeof result.isDone !== "boolean") {
      inconclusive(`${label} returned a malformed page`);
    }
    for (const row of asArray(result.page, `${label} page`)) {
      if (!isRecord(row)) inconclusive(`${label} returned a malformed row`);
      rows.push(row);
    }
    if (result.isDone) return rows;
    cursor = asString(result.continueCursor, `${label} continueCursor`);
  }
  return inconclusive(`${label} did not terminate within ${MAX_WALK_PAGES} pages`);
}

const UI_STEP = { timeout: UI_STEP_TIMEOUT_MS };

/** A screen's route without its origin, so evidence names the page and not the host. */
const pathOf = (url: string): string => url.replace(/^https?:\/\/[^/]+/, "");

function recordProbe(env: BoundaryMissionEnv, label: string, outcome: ProbeOutcome): void {
  const probes = (env.detail.probes ??= []) as { label: string; outcome: string; message?: string }[];
  probes.push({
    label,
    outcome: outcome.kind,
    ...("message" in outcome ? { message: outcome.message } : {}),
  });
}

/** Runs one backend call as a probe and records how it ended. */
async function attempt(
  env: BoundaryMissionEnv,
  label: string,
  refusal: RegExp,
  run: () => Promise<unknown>,
): Promise<ProbeOutcome> {
  const outcome = await probe(() => untilAborted(env.signal, run()), refusal, env.signal);
  recordProbe(env, label, outcome);
  return outcome;
}

// ─── TENANT_ESCAPE ───────────────────────────────────────────────────────────

interface ForeignState {
  orgName: string;
  customers: { id: string; lastName: string }[];
}

async function readForeignState(client: ConvexHttpClient, orgId: string): Promise<ForeignState> {
  const org: unknown = await client.query(api.organizations.get, { orgId: orgId as Id<"organizations"> });
  if (!isRecord(org)) inconclusive("the foreign organization could not be read by its owner");
  const rows = await walkPages(
    (cursor) =>
      client.query(api.customers.list, {
        orgId: orgId as Id<"organizations">,
        paginationOpts: { numItems: WALK_PAGE_SIZE, cursor },
      }),
    "customers.list",
  );
  return {
    orgName: asString(org.name, "organization name"),
    customers: rows
      .map((row) => ({ id: asString(row._id, "customer id"), lastName: asString(row.lastName, "customer lastName") }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/**
 * Reads the page on a foreign organization's route until the product has
 * answered by sending the attacker away from it. Any read that carries a canary
 * counts, however briefly it was there; a page that is still on the foreign
 * organization at the deadline has not answered, whatever it has rendered.
 */
async function observeForeignRoute(
  env: BoundaryMissionEnv,
  options: Required<BoundaryAttackOptions>,
  foreignOrgId: string,
  canaries: readonly string[],
): Promise<{ leftForeignOrganization: boolean; rendersCanary: boolean; finalPath: string }> {
  const deadline = Date.now() + options.uiSettleMs;
  let rendersCanary = false;
  for (;;) {
    const html = await untilAborted(env.signal, env.page.content());
    const url = env.page.url();
    rendersCanary ||= canaries.some((canary) => html.includes(canary));
    const leftForeignOrganization = !url.includes(foreignOrgId);
    if (rendersCanary || leftForeignOrganization || Date.now() >= deadline) {
      return { leftForeignOrganization, rendersCanary, finalPath: pathOf(url) };
    }
    await untilAborted(env.signal, options.sleep(options.pollMs));
  }
}

/**
 * TEN-1: a member of one organization must not read, write or link a
 * resource of another. The dealership's approver seat creates a second,
 * private organization with a canary customer; the primary seat — a member of
 * the dealership only — then attacks it by reading, creating, deleting and
 * cross-referencing through authenticated backend calls, and then walks its own
 * browser to the foreign organization's customers route. Judged on refusals, on
 * the absence of the canary from every response and from the page, and on the
 * victim's state being byte-identical afterwards.
 *
 * The browser leg is a ROUTE boundary only: it proves that the product's
 * workspace guard sends an outsider away from the foreign organization. It does not type into or click anything on the foreign
 * screens — every read and write of the attack is a direct backend call from the
 * attacker's authenticated session — and a page that never leaves the foreign
 * route is unjudged, because a page that has not answered proves nothing.
 *
 * Not covered: tenant-bearing relationships beyond the customer and
 * organization records (vehicles, deals, ledger); the repository census in
 * scripts/tenantWriteGuard.test.ts covers those structurally.
 */
function tenantEscapeSpec(options: Required<BoundaryAttackOptions>) {
  return {
    attack: "TENANT_ESCAPE",
    seat: "primary" as const,
    oracles: ["TENANT_ISOLATION" as const],
    passSummary:
      "A member of one organization could not read, create, delete or cross-reference a private customer of another organization through the backend, the planted canary never appeared in a response or on the foreign route's page before the workspace guard sent the attacker away, and the victim's state was unchanged.",
    breachSummary: "Tenant isolation was breached",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const victim = await env.openSeat("approver");
      if (victim.orgId !== orgId) {
        // The attack is meaningful only between two seats of one dealership.
        inconclusive("the two QA seats do not share a dealership, so the victim seat cannot be isolated from it");
      }

      const foreignName = `${nonce}-foreign`;
      const canaryLastName = `${nonce}-canary`;
      const canaryEmail = `${nonce}-canary@example.test`;
      const foreignOrgId = String(
        await untilAborted(signal, victim.client.mutation(api.organizations.create, { name: foreignName })),
      );
      detail.foreignOrgId = foreignOrgId;
      if (foreignOrgId === orgId) inconclusive("the foreign organization is the attacker's own organization");
      const canaryId = String(
        await untilAborted(
          signal,
          victim.client.mutation(api.customers.create, {
            orgId: foreignOrgId as Id<"organizations">,
            firstName: "Canary",
            lastName: canaryLastName,
            email: canaryEmail,
          }),
        ),
      );
      env.onCleanup("soft-delete the canary customer", async () => {
        await victim.client.mutation(api.customers.softDelete, {
          orgId: foreignOrgId as Id<"organizations">,
          customerId: canaryId as Id<"customers">,
        });
      });
      const canaries = [canaryLastName, canaryEmail, canaryId, foreignName];

      // The attacker must genuinely be an outsider of the foreign organization.
      const mine: unknown = await untilAborted(signal, client.query(api.organizations.listMine, {}));
      if (asArray(mine, "organizations.listMine").some((entry) => isRecord(entry) && String(entry._id) === foreignOrgId)) {
        inconclusive("the attacker seat is a member of the foreign organization, so it is not an outsider");
      }

      const before = await readForeignState(victim.client, foreignOrgId);
      if (!before.customers.some((customer) => customer.id === canaryId)) {
        inconclusive("the canary customer is not visible to its owner, so a leak could not be recognised");
      }

      const foreign = foreignOrgId as Id<"organizations">;
      const own = orgId as Id<"organizations">;
      const canary = canaryId as Id<"customers">;
      const paginationOpts = { numItems: 50, cursor: null };
      const reads: [string, () => Promise<unknown>][] = [
        ["organizations.get (foreign org)", () => client.query(api.organizations.get, { orgId: foreign })],
        ["customers.search (foreign org)", () => client.query(api.customers.search, { orgId: foreign, search: nonce })],
        ["customers.list (foreign org)", () => client.query(api.customers.list, { orgId: foreign, paginationOpts })],
        ["customers.get (foreign org)", () => client.query(api.customers.get, { orgId: foreign, customerId: canary })],
        ["customers.getByEmail (foreign org)", () => client.query(api.customers.getByEmail, { orgId: foreign, email: canaryEmail })],
        [
          "customers.checkDuplicates (foreign org)",
          () => client.query(api.customers.checkDuplicates, { orgId: foreign, email: canaryEmail, firstName: "Canary", lastName: canaryLastName }),
        ],
        ["customers.get (foreign id under own org)", () => client.query(api.customers.get, { orgId: own, customerId: canary })],
      ];
      for (const [label, run] of reads) {
        env.judge(judgeTenantRead(label, await attempt(env, label, TENANT_REFUSAL, run), canaries));
      }

      const writes: [string, () => Promise<unknown>][] = [
        [
          "customers.create (foreign org)",
          () =>
            client.mutation(api.customers.create, {
              orgId: foreign,
              firstName: "Intruder",
              lastName: `${nonce}-intruder`,
              email: `${nonce}-intruder@example.test`,
            }),
        ],
        ["customers.softDelete (foreign org)", () => client.mutation(api.customers.softDelete, { orgId: foreign, customerId: canary })],
        ["customers.softDelete (foreign id under own org)", () => client.mutation(api.customers.softDelete, { orgId: own, customerId: canary })],
      ];
      for (const [label, run] of writes) {
        env.judge(judgeRefusedAttempt(label, await attempt(env, label, TENANT_REFUSAL, run)));
      }

      // The browser: the attacker's own signed-in session walks to the other
      // organization's customers screen. The canary must not be on the page, and
      // that only means something once the workspace guard has answered.
      await untilAborted(signal, page.goto(`/${foreignOrgId}/customers`, { waitUntil: "domcontentloaded" }));
      const route = await observeForeignRoute(env, options, foreignOrgId, [canaryLastName, canaryEmail]);
      detail.foreignRoute = route;
      if (route.rendersCanary) {
        env.judge({
          violations: ["the foreign organization's customers screen rendered its canary customer in the attacker's browser"],
          unjudged: [],
        });
      } else if (!route.leftForeignOrganization) {
        env.unjudged(
          "the foreign organization's route never settled (the page stayed on it), so the canary's absence from the page proves nothing",
        );
      }

      const after = await readForeignState(victim.client, foreignOrgId);
      detail.foreignStateBefore = before;
      detail.foreignStateAfter = after;
      env.judge(judgeUnchanged("the foreign organization's name and customers", before, after));
    },
  };
}

// ─── AUTHORIZATION_ABUSE ─────────────────────────────────────────────────────

interface AuthorityState {
  orgName: string;
  members: { id: string; roleId: string }[];
  ownRolePermissions: string[];
}

async function readAuthorityState(
  client: ConvexHttpClient,
  orgId: string,
  ownRoleId: string,
): Promise<AuthorityState> {
  const org: unknown = await client.query(api.organizations.get, { orgId: orgId as Id<"organizations"> });
  if (!isRecord(org)) inconclusive("the organization could not be read");
  const members = await walkPages(
    (cursor) =>
      client.query(api.memberships.list, {
        orgId: orgId as Id<"organizations">,
        paginationOpts: { numItems: WALK_PAGE_SIZE, cursor },
      }),
    "memberships.list",
  );
  const role: unknown = await client.query(api.roles.get, {
    orgId: orgId as Id<"organizations">,
    roleId: ownRoleId as Id<"roles">,
  });
  if (!isRecord(role)) inconclusive("the seat's own role could not be read");
  return {
    orgName: asString(org.name, "organization name"),
    members: members
      .map((row) => ({ id: asString(row._id, "membership id"), roleId: asString(row.roleId, "membership roleId") }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    ownRolePermissions: asArray(role.permissions, "role permissions").map(String).sort((left, right) => left.localeCompare(right)),
  };
}

/**
 * The manager asks the Team screen to move the OWNER onto the manager's own
 * role. `control: "withheld"` means the screen offers no such button; otherwise
 * the screen's own answer is awaited (the dialog closing is acceptance) before
 * anything is read back, and silence is inconclusive. A toast is a refusal only
 * when its text is the product's authorization refusal; a rate limit,
 * validation or network failure is "unclassified" and proves nothing.
 */
async function demoteOwnerOnTeamScreen(
  env: BoundaryMissionEnv,
  options: Required<BoundaryAttackOptions>,
  ownerEmail: string,
  ownRoleId: string,
): Promise<{ control: "withheld" | "attempted"; answer?: "accepted" | "refused" | "unclassified"; message?: string }> {
  const { page, signal, orgId } = env;
  await untilAborted(signal, page.goto(`/${orgId}/team`, { waitUntil: "domcontentloaded" }));
  const ownerRow = page.locator("tr").filter({ hasText: ownerEmail });
  await untilAborted(signal, ownerRow.waitFor({ state: "visible", ...UI_STEP }));
  const changeRole = ownerRow.getByRole("button", { name: "Change Role", exact: true });
  if (!(await untilAborted(signal, changeRole.isVisible())) || !(await untilAborted(signal, changeRole.isEnabled()))) {
    return { control: "withheld" };
  }
  await untilAborted(signal, changeRole.click(UI_STEP));
  const dialog = page.getByRole("dialog");
  await untilAborted(signal, dialog.locator("div.relative > button").first().click(UI_STEP));
  await untilAborted(signal, dialog.getByTestId(`searchable-option-${ownRoleId}`).click(UI_STEP));
  await untilAborted(signal, dialog.getByRole("button", { name: "Save", exact: true }).click(UI_STEP));

  // An access refusal is shown as an untyped "Access restricted" toast, not an error one
  // (components/ui/sonner.tsx), so any toast but a success counts as the screen's answer.
  const answerToast = page.locator("[data-sonner-toast]:not([data-type='success'])").first();
  const deadline = Date.now() + options.uiSettleMs;
  for (;;) {
    if (!(await untilAborted(signal, dialog.isVisible()))) return { control: "attempted", answer: "accepted" };
    if (await untilAborted(signal, answerToast.isVisible())) {
      // innerText keeps the title and description apart, as the refusal pattern needs.
      const message = (await untilAborted(signal, answerToast.innerText(UI_STEP))).trim().slice(0, 200);
      return { control: "attempted", answer: AUTHORIZATION_REFUSAL.test(message) ? "refused" : "unclassified", message };
    }
    if (Date.now() >= deadline) return inconclusive("the Team screen gave no answer to the role change");
    await untilAborted(signal, options.sleep(options.pollMs));
  }
}

const SHARED_PREVIEW_MUTATED =
  "an accepted attack changed the shared preview; missions that ran after it or alongside it, on any worker, are not independent of that change";

/**
 * AUTH-1: a sensitive action must be authorized server-side. The approver seat
 * (a MANAGER, who holds MANAGE_USERS but is not the owner) attacks the
 * boundaries that sit above it: renaming the organization, promoting itself to
 * OWNER, demoting the OWNER, and rewriting its own role's permissions. Every
 * call must be refused by an authorization guard — a refusal for any other
 * reason (rate limit, validation) proves nothing and is unjudged — and the
 * organization, every membership role and the role's permissions must be
 * unchanged afterwards. The manager then repeats the most sensitive of those,
 * demoting the OWNER, through the Team screen's own Change Role dialog; the
 * screen may withhold the control (recorded) or offer it, in which case the
 * backend must refuse with its authorization refusal (any other toast is
 * unjudged) and the state must still be unchanged.
 *
 * The browser leg is that one screen. The other three attacks are direct
 * backend calls from the manager's authenticated session, not clicks: this is
 * not a full browser attack on every authorization boundary. A Team screen that
 * cannot be driven or gives no answer is unjudged.
 *
 * Not covered: the same-actor separation-of-duties leg (a maker approving their
 * own manual journal); it needs a finance workflow with two actors holding the
 * approval permission, which is proven in convex/accountingPhase10.test.ts.
 * If the approver seat has been re-roled to hold the authority, the attack has
 * nothing to abuse and is unjudged.
 *
 * Residual: the attacks are not undone. An ACCEPTED attack (which is itself a
 * confirmed breach and fails the run) leaves the shared preview changed. Workers
 * are parallel jobs on one preview, so a restore would race the others, and after
 * a demoted OWNER the seat that could restore it has lost its authority; no
 * restore is attempted. A worker cannot contain this for the others, so the
 * evidence says so (`sharedPreviewMutated`) and no other mission that ran beside
 * or after it may be read as independent of a run that recorded it.
 *
 * The marker is a disclosure, not containment. It lives only in this mission's
 * own evidence; the PASS evidence of other missions is not annotated, so those
 * PASS claims stand alone only while no mission in the run confirmed a breach
 * (the run itself fails on one). It is set only for a change this mission
 * observed: a mutation it could not observe (an ambiguous failure, state that
 * could not be read back) is not flagged.
 */
function authorizationAbuseSpec(options: Required<BoundaryAttackOptions>) {
  return {
    attack: "AUTHORIZATION_ABUSE",
    seat: "approver" as const,
    oracles: ["AUTHORIZATION" as const],
    passSummary:
      "A non-owner manager could not rename the organization, promote itself to owner, demote the owner or rewrite its own role through the backend, the Team screen either withheld the owner's Change Role control or its demotion of the owner was refused, and no membership, role or organization record changed.",
    breachSummary: "Server-side authorization was breached",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail } = env;
      const org = orgId as Id<"organizations">;

      const mine = asArray(await untilAborted(signal, client.query(api.organizations.listMine, {})), "organizations.listMine");
      const entry = mine.find((row) => isRecord(row) && String(row._id) === orgId);
      if (!isRecord(entry)) inconclusive("the approver seat is not a member of the dealership it signed in to");
      const permissions = asArray(entry.permissions, "membership permissions").map(String);
      const roleName = asString(entry.roleName, "role name");
      detail.seatRole = roleName;
      if (roleName === "OWNER" || permissions.includes(PERMISSIONS.EDIT_ORG)) {
        env.unjudged(
          `the approver seat holds ${roleName} with the authority to edit the organization, so the boundary under test does not apply to it`,
        );
        return;
      }

      const membership: unknown = await untilAborted(signal, client.query(api.memberships.getMyMembership, { orgId: org }));
      if (!isRecord(membership)) inconclusive("the approver's own membership could not be read");
      const ownMembershipId = asString(membership._id, "membership id");
      const ownRoleId = asString(membership.roleId, "role id");

      const roles = asArray(await untilAborted(signal, client.query(api.roles.list, { orgId: org })), "roles.list");
      const ownerRole =
        roles.find((role) => isRecord(role) && role.isSystemOwnerRole === true) ??
        roles.find((role) => isRecord(role) && role.name === "OWNER");
      if (!isRecord(ownerRole)) inconclusive("the dealership has no readable OWNER role");
      const ownerRoleId = asString(ownerRole._id, "owner role id");

      const members = await walkPages(
        (cursor) => client.query(api.memberships.list, { orgId: org, paginationOpts: { numItems: WALK_PAGE_SIZE, cursor } }),
        "memberships.list",
      );
      const ownerMembership = members.find((row) => String(row.roleId) === ownerRoleId);
      if (!ownerMembership) inconclusive("the dealership has no readable OWNER membership to defend");
      const ownerMembershipId = asString(ownerMembership._id, "owner membership id");
      const ownerEmail = typeof ownerMembership.userEmail === "string" ? ownerMembership.userEmail : "";

      /** An accepted attack really changed the preview, which every worker shares. */
      const judge = (verdict: Judgement): void => {
        if (verdict.violations.length > 0) detail.sharedPreviewMutated = SHARED_PREVIEW_MUTATED;
        env.judge(verdict);
      };

      const before = await readAuthorityState(client, orgId, ownRoleId);
      const attacks: [string, () => Promise<unknown>][] = [
        ["organizations.update (rename)", () => client.mutation(api.organizations.update, { orgId: org, name: `${nonce}-renamed` })],
        [
          "memberships.updateRole (promote self to OWNER)",
          () => client.mutation(api.memberships.updateRole, { orgId: org, membershipId: ownMembershipId as Id<"memberships">, newRoleId: ownerRoleId as Id<"roles"> }),
        ],
        [
          "memberships.updateRole (demote the OWNER)",
          () => client.mutation(api.memberships.updateRole, { orgId: org, membershipId: ownerMembershipId as Id<"memberships">, newRoleId: ownRoleId as Id<"roles"> }),
        ],
        [
          "roles.update (grant own role every permission)",
          () => client.mutation(api.roles.update, { orgId: org, roleId: ownRoleId as Id<"roles">, permissions: [...ALL_PERMISSIONS] }),
        ],
      ];
      for (const [label, run] of attacks) {
        judge(judgeRefusedAttempt(label, await attempt(env, label, AUTHORIZATION_REFUSAL, run)));
      }

      if (ownerEmail === "") {
        env.unjudged("the OWNER's email was not readable, so the Team screen leg could not find the OWNER row");
      } else {
        try {
          const team = await demoteOwnerOnTeamScreen(env, options, ownerEmail, ownRoleId);
          detail.teamScreen = team;
          if (team.answer === "accepted") {
            judge({ violations: ["the Team screen's role change (demote the OWNER) was accepted"], unjudged: [] });
          } else if (team.answer === "unclassified") {
            env.unjudged(`the Team screen's role change failed with "${team.message}", which is not an authorization refusal`);
          }
        } catch (error) {
          if (signal.aborted) throw error;
          env.unjudged(`the Team screen could not be driven (${describeError(error)})`);
        }
      }

      const after = await readAuthorityState(client, orgId, ownRoleId);
      detail.authorityBefore = before;
      detail.authorityAfter = after;
      judge(judgeUnchanged("the organization name, membership roles and the seat's role permissions", before, after));
    },
  };
}

// ─── COMPLETENESS_BOUNDARY ───────────────────────────────────────────────────

const RATE_LIMIT_TEXT = /rate limit exceeded[^\d]{0,40}(\d{1,6})s/i;

/** Creates one synthetic customer, waiting out the product's own write rate limit. */
async function createCustomerWithBackoff(
  env: BoundaryMissionEnv,
  options: Required<BoundaryAttackOptions>,
  args: { firstName: string; lastName: string; email: string },
): Promise<string> {
  for (let tries = 0; ; tries += 1) {
    try {
      return String(
        await untilAborted(
          env.signal,
          env.client.mutation(api.customers.create, { orgId: env.orgId as Id<"organizations">, ...args }),
        ),
      );
    } catch (error) {
      const wait = RATE_LIMIT_TEXT.exec(describeError(error));
      if (!wait || tries >= RATE_LIMIT_RETRIES) throw error;
      await untilAborted(env.signal, options.sleep((Number(wait[1]) + 1) * 1000));
    }
  }
}

/** The customers screen's own statement of how much it holds ("12 results" / "12 loaded results"). */
const RESULTS_CLAIM = /^\d+ (?:loaded )?results$/;
const EXHAUSTED_CLAIM = /^\d+ results$/;

async function readResultsClaim(page: Page): Promise<string | null> {
  try {
    const text = await page.getByText(RESULTS_CLAIM).first().textContent({ timeout: 2_000 });
    return text === null ? null : text.trim();
  } catch {
    return null;
  }
}

async function visibleRowIds(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[id^="row-"]')
    .evaluateAll((elements) => elements.map((element) => element.id.slice("row-".length)));
  return [...new Set(ids)];
}

/**
 * PERF-1: a search on a paginated list must not infer completeness from the
 * first page. The attack plants one more matching customer than a page holds,
 * walks the whole backend list for the authoritative order, then types the
 * run's nonce into the customers screen and waits for it to settle. The page
 * states whether it holds the whole list: "N results" once exhausted, "N loaded
 * results" while more can still load (the "Load more" button is not consulted:
 * the mobile and desktop layouts each render their own and only one is visible).
 * A page that claims "N results" while omitting any planted row has silently
 * truncated; one that says it is still partial, or whose claim cannot be read,
 * is unjudged.
 *
 * Not covered: other paginated lists (leads, vehicles, deals) and server-side
 * filters; this exercises the customers screen's client-side search contract.
 */
function completenessBoundarySpec(options: Required<BoundaryAttackOptions>) {
  return {
    attack: "COMPLETENESS_BOUNDARY",
    seat: "primary" as const,
    oracles: ["LIST_COMPLETENESS" as const],
    passSummary:
      "A search over a customer list longer than one page showed every matching customer, so the screen did not infer completeness from its first page.",
    breachSummary: "A paginated list silently truncated its result",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;

      const seededIds: string[] = [];
      for (let index = 0; index < COMPLETENESS_SEED_ROWS; index += 1) {
        const id = await createCustomerWithBackoff(env, options, {
          firstName: "Swarm",
          lastName: `${nonce}-${index}`,
          email: `${nonce}-${index}@example.test`,
        });
        seededIds.push(id);
        env.onCleanup(`soft-delete customer ${index}`, async () => {
          await client.mutation(api.customers.softDelete, { orgId: org, customerId: id as Id<"customers"> });
        });
      }
      detail.seededCount = seededIds.length;

      const authorityRows = await walkPages(
        (cursor) => client.query(api.customers.list, { orgId: org, paginationOpts: { numItems: WALK_PAGE_SIZE, cursor } }),
        "customers.list",
      );
      const authorityOrder = authorityRows.map((row) => asString(row._id, "customer id"));
      detail.authorityTotal = authorityOrder.length;

      await untilAborted(signal, page.goto(`/${orgId}/customers`, { waitUntil: "domcontentloaded" }));
      const search = page.locator('main input[placeholder^="Search"]:not([readonly])').first();
      await untilAborted(signal, search.waitFor({ state: "visible", timeout: 20_000 }));
      await untilAborted(signal, search.fill(nonce));

      const wanted = new Set(seededIds);
      const deadline = Date.now() + options.searchSettleMs;
      // The claim is read BEFORE the rows: the page flips "N loaded results" to
      // "N results" in the same render that shows its last rows, so rows read after an
      // exhausted claim are already complete. The reverse order can pair stale rows with
      // the final claim and report a truncation that never happened.
      const observe = async (): Promise<{ uiIds: string[]; claim: string | null }> => {
        const claim = await untilAborted(signal, readResultsClaim(page));
        return { claim, uiIds: await untilAborted(signal, visibleRowIds(page)) };
      };
      let seen = await observe();
      while (
        !seededIds.every((id) => seen.uiIds.includes(id)) &&
        !EXHAUSTED_CLAIM.test(seen.claim ?? "") &&
        Date.now() < deadline
      ) {
        await untilAborted(signal, options.sleep(options.pollMs));
        seen = await observe();
      }
      const { uiIds, claim } = seen;
      // Only an explicit "N results" is a claim of completeness.
      const partialDisclosed = !EXHAUSTED_CLAIM.test(claim ?? "");
      detail.uiShownSeeded = uiIds.filter((id) => wanted.has(id)).length;
      detail.uiRowCount = uiIds.length;
      detail.resultsClaim = claim;
      detail.partialDisclosed = partialDisclosed;

      env.judge(
        evaluateListCompleteness({
          seededIds,
          authorityOrder,
          firstPageSize: CUSTOMER_FIRST_PAGE,
          uiIds,
          partialDisclosed,
        }),
      );
    },
  };
}

// ─── LIFECYCLE_REVERSAL ──────────────────────────────────────────────────────

async function readLedger(
  client: ConvexHttpClient,
  orgId: string,
  sourceId: string,
  sourceType: string,
): Promise<LedgerSnapshot> {
  const raw = asArray(
    await client.query(api.accountingLedger.listAccountingEvents, {
      orgId: orgId as Id<"organizations">,
      sourceType,
      sourceId,
      limit: LEDGER_ROW_LIMIT,
    }),
    "listAccountingEvents",
  );
  if (raw.length >= LEDGER_ROW_LIMIT) inconclusive(`accounting events for ${sourceType}/${sourceId} may be truncated`);
  const events: LedgerEvent[] = raw.map((row) => {
    if (!isRecord(row)) inconclusive("listAccountingEvents returned a malformed row");
    return {
      id: asString(row._id, "event id"),
      eventType: asString(row.eventType, "event type"),
      status: asString(row.status, "event status"),
      reversalOfEventId: typeof row.reversalOfEventId === "string" ? row.reversalOfEventId : null,
      reversedByEventId: typeof row.reversedByEventId === "string" ? row.reversedByEventId : null,
      journalEntryId: typeof row.journalEntryId === "string" ? row.journalEntryId : null,
    };
  });
  const journals: Record<string, LedgerLine[]> = {};
  for (const event of events) {
    if (!event.journalEntryId || event.journalEntryId in journals) continue;
    const entry: unknown = await client.query(api.accountingLedger.getJournalEntry, {
      orgId: orgId as Id<"organizations">,
      journalEntryId: event.journalEntryId as Id<"journalEntries">,
    });
    if (entry === null) continue;
    if (!isRecord(entry)) inconclusive("getJournalEntry returned a malformed response");
    journals[event.journalEntryId] = asArray(entry.lines, "journal lines").map((line) => {
      if (
        !isRecord(line) ||
        typeof line.debitMinor !== "number" ||
        typeof line.creditMinor !== "number" ||
        typeof line.scale !== "number" ||
        typeof line.currency !== "string"
      ) {
        inconclusive(`journal ${event.journalEntryId} has a malformed line`);
      }
      return {
        accountId: typeof line.accountId === "string" ? line.accountId : null,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        scale: line.scale,
        currency: line.currency,
      };
    });
  }
  return { events, journals };
}

/** What `readSettledLedger` waits for, and whose events it reads. */
export interface SettledLedgerRead {
  /** The snapshot must also satisfy this before it counts as settled. */
  until?: (snapshot: LedgerSnapshot) => boolean;
  /** The ledger source `sourceId` belongs to; an expense unless a mission names another. */
  sourceType?: string;
  /**
   * Extra wait a mission lets a verifiably queued posting use after `postingWaitMs`, shared by all its reads:
   * each use is subtracted from `remainingMs`. Absent means no extension.
   */
  extraWait?: { remainingMs: number };
}

/** An outbox row for one source, reduced to structural fields: no payload, ids, reason or error text. */
interface QueuedPost {
  kind: string;
  status: string;
  eventType: string | null;
  attempts: number;
  hasError: boolean;
}

/**
 * What the outbox showed for one source. `listPending` returns only the newest page (the server caps it at
 * `LEDGER_ROW_LIMIT`), so a full page without a match cannot show absence: that status is `incomplete`.
 */
interface QueuedInspection {
  posts: QueuedPost[];
  incomplete: ("PENDING" | "FAILED")[];
}

/** The outbox rows for one source; null when they cannot be read, never taken to mean "nothing queued". */
async function readQueuedPosts(env: BoundaryMissionEnv, sourceType: string, sourceId: string): Promise<QueuedInspection | null> {
  try {
    const inspection: QueuedInspection = { posts: [], incomplete: [] };
    for (const status of ["PENDING", "FAILED"] as const) {
      const rows = asArray(
        await untilAborted(
          env.signal,
          env.client.query(api.accountingOutbox.listPending, {
            orgId: env.orgId as Id<"organizations">,
            status,
            limit: LEDGER_ROW_LIMIT,
          }),
        ),
        "listPending",
      );
      const before = inspection.posts.length;
      for (const row of rows) {
        if (!isRecord(row) || row.sourceType !== sourceType || row.sourceId !== sourceId) continue;
        inspection.posts.push({
          kind: typeof row.kind === "string" ? row.kind : "UNKNOWN",
          status,
          eventType: typeof row.eventType === "string" ? row.eventType : null,
          attempts: typeof row.attempts === "number" ? row.attempts : 0,
          hasError: typeof row.lastError === "string" && row.lastError.length > 0,
        });
      }
      if (rows.length >= LEDGER_ROW_LIMIT && inspection.posts.length === before) inspection.incomplete.push(status);
    }
    return inspection;
  } catch (error) {
    if (env.signal.aborted) throw error;
    return null;
  }
}

/**
 * Two consecutive identical reads: the posting outbox drains asynchronously. The events are those whose
 * source is `sourceId` in `sourceType`.
 *
 * A posting that did not land inline waits in the outbox for the one-minute tick, which `postingWaitMs`
 * alone does not cover. A mission that passes `extraWait` lets the wait grow, once per read and from that
 * shared allowance, when the outbox verifiably holds a still-waiting row for this source and no failed one
 * (and the failed rows were fully inspected). Without `extraWait` the wait is never extended. Every lapse is
 * unjudged (never a pass) and records the last ledger read and the outbox inspection on
 * `env.detail.ledgerSettleTimeouts`.
 */
export async function readSettledLedger(
  env: BoundaryMissionEnv,
  options: Pick<Required<BoundaryAttackOptions>, "sleep" | "pollMs" | "postingWaitMs">,
  sourceId: string,
  { until, sourceType = "expenses", extraWait }: SettledLedgerRead = {},
): Promise<LedgerSnapshot> {
  let last = await untilAborted(env.signal, readLedger(env.client, env.orgId, sourceId, sourceType));
  const settle = async (waitMs: number, maxReads: number): Promise<LedgerSnapshot | null> => {
    const deadline = Date.now() + waitMs;
    for (let reads = 0; reads < maxReads && Date.now() < deadline; reads += 1) {
      await untilAborted(env.signal, options.sleep(options.pollMs));
      const current = await untilAborted(env.signal, readLedger(env.client, env.orgId, sourceId, sourceType));
      const repeated = JSON.stringify(current) === JSON.stringify(last);
      last = current;
      if (repeated && (until === undefined || until(current))) return current;
    }
    return null;
  };

  const settled = await settle(options.postingWaitMs, LEDGER_MAX_READS - 1);
  if (settled) return settled;

  let queued = await readQueuedPosts(env, sourceType, sourceId);
  const extraMs = Math.max(extraWait?.remainingMs ?? 0, 0);
  const extend =
    extraWait !== undefined &&
    extraMs > 0 &&
    queued !== null &&
    queued.posts.some((post) => post.status === "PENDING") &&
    !queued.posts.some((post) => post.status === "FAILED") &&
    !queued.incomplete.includes("FAILED");
  if (extend) {
    const extendedAt = Date.now();
    const lateSettled = await settle(extraMs, Math.ceil(extraMs / Math.max(options.pollMs, 1)));
    extraWait.remainingMs = Math.max(extraMs - (Date.now() - extendedAt), 0);
    if (lateSettled) return lateSettled;
    queued = await readQueuedPosts(env, sourceType, sourceId);
  }
  const outbox = queued === null ? "UNREADABLE" : queued.incomplete.length > 0 ? "INCOMPLETE" : "COMPLETE";
  const timeouts = (env.detail.ledgerSettleTimeouts ??= []) as unknown[];
  timeouts.push({
    sourceType,
    sourceId,
    extendedForQueuedPost: extend,
    lastRead: last.events.map((event) => ({
      eventType: event.eventType,
      status: event.status,
      journalRead: event.journalEntryId === null ? null : event.journalEntryId in last.journals,
    })),
    outbox,
    queuedPosts: queued?.posts ?? null,
    outboxPagesWithoutMatch: queued?.incomplete ?? null,
  });
  const queuedNote =
    outbox === "UNREADABLE"
      ? "outbox unreadable"
      : outbox === "INCOMPLETE"
        ? "outbox inspection incomplete, newest page full"
        : `${queued?.posts.length ?? 0} queued post(s)${extend ? ", wait extended" : ""}`;
  return inconclusive(
    `the ledger state for ${sourceType}/${sourceId} did not settle (${last.events.length} event(s) read, ${queuedNote})`,
  );
}

/**
 * Delete → the posted-expense refusal flips the dialog to Reverse & Delete → the
 * reason is typed, which arms the action. Nothing is submitted.
 */
export async function armReversalOnExpenseScreen(
  page: Page,
  signal: AbortSignal,
  expenseId: string,
  reason: string,
): Promise<void> {
  const row = page.locator(`#row-${expenseId}`);
  await untilAborted(signal, row.waitFor({ state: "visible", ...UI_STEP }));
  await untilAborted(signal, row.getByRole("button").last().click(UI_STEP));
  const dialog = page.getByRole("dialog");
  await untilAborted(signal, dialog.getByRole("button", { name: "Delete Permanently", exact: true }).click(UI_STEP));
  const reasonField = dialog.locator("#reversal-reason");
  await untilAborted(signal, reasonField.waitFor({ state: "visible", ...UI_STEP }));
  await untilAborted(signal, reasonField.fill(reason, UI_STEP));
}

/** Arms the reversal, then submits it and waits for the dialog to close. */
export async function reverseOnExpenseScreen(page: Page, signal: AbortSignal, expenseId: string, reason: string): Promise<void> {
  await armReversalOnExpenseScreen(page, signal, expenseId, reason);
  const dialog = page.getByRole("dialog");
  await untilAborted(signal, dialog.getByRole("button", { name: "Reverse & Delete", exact: true }).click(UI_STEP));
  await untilAborted(signal, dialog.waitFor({ state: "hidden", ...UI_STEP }));
}

/** The expense's posting is on the ledger with every journal it names readable. */
export const isPosted = (snapshot: LedgerSnapshot): boolean =>
  snapshot.events.some((event) => event.eventType === "EXPENSE_POSTED" && event.status === "POSTED") &&
  snapshot.events.every((event) => event.journalEntryId === null || event.journalEntryId in snapshot.journals);

/** The ledger holds a posted reversal event. */
export const isReversed = (snapshot: LedgerSnapshot): boolean =>
  snapshot.events.some((event) => event.eventType === "JOURNAL_REVERSAL" && event.status === "POSTED");

/**
 * ACC-2: posted financial history is immutable and corrections use the
 * canonical linked reversal. The attack posts a synthetic expense, then tries
 * to rewrite it — edit its amount, delete it — and both must be refused with
 * the ledger byte-identical. It then performs the canonical reversal through the
 * expense screen's own Delete → Reverse & Delete flow, and asks for it a second
 * time directly. The ledger must hold a real, balanced posting of the seeded
 * amount in the organization's own currency (read independently from its
 * settings; unreadable settings leave the mission unjudged), keep the original
 * posted event and its journal untouched, hold exactly one linked reversal event
 * whose journal is the exact mirror of the original, and acquire no further
 * reversal or posting event of any kind.
 *
 * The only legitimate refusal of the repeat is the product's own "Expense not
 * found" (the first reversal soft-deletes the expense). A rate limit, a missing
 * permission or a validation failure is unjudged. A screen flow that cannot be
 * completed is unjudged too: the reversal is never issued by a direct call in
 * its place. The edit/delete attempts and the repeat are direct backend calls.
 *
 * Not covered: reversal of non-expense postings (receipts, deals, manual
 * journals) and reversals across a closed accounting period.
 */
function lifecycleReversalSpec(options: Required<BoundaryAttackOptions>) {
  return {
    attack: "LIFECYCLE_REVERSAL",
    seat: "primary" as const,
    oracles: ["REVERSAL_RECONCILIATION" as const],
    passSummary:
      "A posted expense could not be edited or deleted, its balanced ledger posting in the organization's currency stayed untouched through a canonical reversal made on the expense screen, the ledger held exactly one linked reversal that mirrors the original, and asking again was refused as 'Expense not found' and created no further ledger event.",
    breachSummary: "Posted financial history was not preserved by its reversal",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;

      await untilAborted(signal, gotoExpenses(page, orgId));

      // The posting's denomination is the organization's own, read before anything is
      // seeded. No settings (or none this seat may read) leaves it unknown, never assumed.
      const settings: unknown = await untilAborted(signal, client.query(api.orgSettings.get, { orgId: org }));
      const expectedCurrency = isRecord(settings) && typeof settings.currency === "string" ? settings.currency : null;
      detail.expectedCurrency = expectedCurrency;

      const amount = 53;
      const expenseId = String(
        await untilAborted(
          signal,
          client.mutation(api.expenses.create, {
            orgId: org,
            title: `${nonce}-posted`,
            amount,
            date: Date.now(),
            category: "OTHER",
            status: "PAID",
            paymentMethod: "CASH",
            idempotencyKey: `${nonce}-create`,
          }),
        ),
      );
      detail.expenseId = expenseId;
      const expense = expenseId as Id<"expenses">;

      const posted = await readSettledLedger(env, options, expenseId, { until: isPosted });

      // Rewrite attempts on posted history: both must be refused as locked.
      const edit = await attempt(env, "expenses.update (rewrite the posted amount)", POSTED_HISTORY_REFUSAL, () =>
        client.mutation(api.expenses.update, { orgId: org, expenseId: expense, amount: amount + 7 }),
      );
      env.judge(judgeRefusedAttempt("expenses.update (rewrite the posted amount)", edit));
      const removal = await attempt(env, "expenses.remove (delete the posted expense)", POSTED_HISTORY_REFUSAL, () =>
        client.mutation(api.expenses.remove, { orgId: org, expenseId: expense }),
      );
      env.judge(judgeRefusedAttempt("expenses.remove (delete the posted expense)", removal));

      // The canonical correction, made the way a user makes it. A flow that cannot
      // be completed means the attack could not be exercised, never a pass, and
      // never a direct call that would sidestep the screen.
      try {
        await reverseOnExpenseScreen(page, signal, expenseId, `${nonce} canonical reversal`);
      } catch (error) {
        if (signal.aborted) throw error;
        env.unjudged(
          `the expense screen's reversal flow could not be completed (${describeError(error)}), so reversal of posted history could not be judged`,
        );
        return;
      }
      detail.reversalVia = "expense screen";
      const reversed = await readSettledLedger(env, options, expenseId, { until: isReversed });

      // Asking again: the expense is gone, so "Expense not found" is the only
      // legitimate refusal. Anything else never reached the reversal.
      const replay = await attempt(env, "expenses.reverseExpense (second request)", REPLAY_REFUSAL, () =>
        client.mutation(api.expenses.reverseExpense, { orgId: org, expenseId: expense, reason: `${nonce} repeated reversal` }),
      );
      if (replay.kind === "ACCEPTED") {
        env.unjudged(
          'the repeated reversal was accepted rather than refused as "Expense not found", so the product did not give the answer this attack judges',
        );
      } else if (replay.kind === "LAPSED" || replay.kind === "UNCLASSIFIED") {
        env.unjudged(
          `the repeated reversal request was neither accepted nor refused as "Expense not found" (${
            replay.kind === "LAPSED" ? "the harness session lapsed" : replay.message
          }), so an unchanged ledger proves nothing about a replay`,
        );
      }
      const replayed = await readSettledLedger(env, options, expenseId);

      detail.ledger = { posted, reversed, replayed };
      env.judge(evaluateReversalReconciliation({ posted, reversed, replayed, seededAmount: amount, expectedCurrency }));
    },
  };
}

// ─── Registry ────────────────────────────────────────────────────────────────

export function createBoundaryAttackHandlers(
  runtimeApi: MissionBrowserRuntime,
  overrides: BoundaryAttackOptions = {},
): BrowserAttackHandlerRegistry {
  const options: Required<BoundaryAttackOptions> = {
    sleep: overrides.sleep ?? realSleep,
    searchSettleMs: overrides.searchSettleMs ?? DEFAULTS.searchSettleMs,
    pollMs: overrides.pollMs ?? DEFAULTS.pollMs,
    postingWaitMs: overrides.postingWaitMs ?? DEFAULTS.postingWaitMs,
    uiSettleMs: overrides.uiSettleMs ?? DEFAULTS.uiSettleMs,
  };
  return {
    TENANT_ESCAPE: (context) => runBoundaryMission(runtimeApi, context, tenantEscapeSpec(options)),
    AUTHORIZATION_ABUSE: (context) => runBoundaryMission(runtimeApi, context, authorizationAbuseSpec(options)),
    COMPLETENESS_BOUNDARY: (context) => runBoundaryMission(runtimeApi, context, completenessBoundarySpec(options)),
    // One family, two obligations: ACC-2 judges the reconciliation of a reversed
    // expense, LIFE-1 judges the state transition of a voided deposit. The spec's
    // own oracle list refuses any mission asking for a third.
    LIFECYCLE_REVERSAL: (context) =>
      runBoundaryMission(
        runtimeApi,
        context,
        context.mission.oracle === "STATE_TRANSITION" ? depositVoidTransitionSpec(options) : lifecycleReversalSpec(options),
      ),
  };
}
