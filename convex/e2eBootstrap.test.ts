import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";
import {
  E2E_APPROVER_ROLE_NAME,
  E2E_ORGANIZATION_NAME,
  E2E_PRIMARY_ROLE_NAME,
  HUNT_SEAT_ROLES,
  constantTimeEqual,
  REPLAY_MAX_LIFETIME_MS,
  replayProofFor,
  replayRunBindingReasons,
} from "./e2eBootstrap";

const modules = import.meta.glob("./**/*.ts");

const PRIMARY = {
  clerkUserId: "user_e2e_salesperson",
  email: "autoflow-e2e@example.com",
  name: "E2E Salesperson",
};
const APPROVER = {
  clerkUserId: "user_e2e_manager",
  email: "autoflow-approver@example.com",
  name: "E2E Manager",
};

const CLOUD_URL = "https://the-one-preview.convex.cloud";

function newDeployment() {
  return convexTestWithComponents(schema, modules);
}

/** A deployment that the CLI's preview-only hook has already marked. */
async function markedDeployment() {
  const t = newDeployment();
  await t.mutation(internal.e2eBootstrap.markPreviewDeployment, {});
  return t;
}

async function bootstrap(
  t: ReturnType<typeof newDeployment>,
  opts: { seedLegacyManualJournalDraft?: boolean } = {}
) {
  return await t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
    primary: PRIMARY,
    approver: APPROVER,
    expectedCloudUrl: CLOUD_URL,
    ...opts,
  });
}

/**
 * Every test runs on a deployment that exposes its own identity, because the
 * marker now refuses to be minted without one.
 *
 * ⚠️ That demand is backed by evidence, not preference. `convex-test` does not
 * set `CONVEX_CLOUD_URL`, so no unit test could ever establish that the real
 * runtime provides it — and while that was unknown, every identity check had to
 * degrade to "SKIPPED", which for this mutation's control flow is
 * indistinguishable from a pass. PR #278's run `33940299176` seeded a real
 * preview and the mutation returned `"VERIFIED — impressive-ox-948"`. Only then
 * did failing closed become safe.
 */
beforeEach(() => {
  vi.stubEnv("CONVEX_CLOUD_URL", CLOUD_URL);
  // Control 5, exactly as the Preview-scoped Convex project default supplies it.
  // Tests that need the declaration absent or wrong override it deliberately —
  // see the last describe in this file.
  vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "preview");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("markPreviewDeployment — the preview attestation", () => {
  test("marks an empty, freshly-claimed deployment", async () => {
    const t = newDeployment();

    const result = await t.mutation(internal.e2eBootstrap.markPreviewDeployment, {});

    expect(result.status).toBe("MARKED");
    const markers = await t.run(async (ctx) => ctx.db.query("e2ePreviewBootstrap").collect());
    expect(markers).toHaveLength(1);
  });

  test("is idempotent — a second call adds no second marker", async () => {
    const t = await markedDeployment();

    const result = await t.mutation(internal.e2eBootstrap.markPreviewDeployment, {});

    expect(result.status).toBe("ALREADY_MARKED");
    const markers = await t.run(async (ctx) => ctx.db.query("e2ePreviewBootstrap").collect());
    expect(markers).toHaveLength(1);
  });

  /**
   * ⚠️ WHAT THIS PROVES, AND WHAT IT DOES NOT.
   *
   * The marker's presence authorizes seeding, so the case worth guarding is a
   * hand-run `convex run e2eBootstrap:markPreviewDeployment` against a real
   * deployment. These tests prove that a deployment holding tenant ROWS refuses.
   *
   * They do NOT prove "this is a preview" — nothing can, because Convex exposes
   * no deployment-type signal to a function. An earlier version of this comment
   * claimed they closed that case; both adversarial reviewers on PR #278 caught
   * it independently. The residual, and the Preview-scoped default environment
   * variable that would close it, are stated in the module header. The
   * environment-marker test below is what narrows it in the meantime.
   */
  test("refuses a deployment that already holds an organization", async () => {
    const t = newDeployment();
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        name: "A Real Dealership",
        createdAt: Date.now(),
        commitmentAuthorityVersion: 1,
      });
    });

    await expect(
      t.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
    ).rejects.toThrow(/already contains at least one organization/);

    const markers = await t.run(async (ctx) => ctx.db.query("e2ePreviewBootstrap").collect());
    expect(markers).toEqual([]);
  });

  test("refuses a deployment that already holds a user", async () => {
    const t = newDeployment();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { clerkId: "user_real", email: "real@example.com" });
    });

    await expect(
      t.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
    ).rejects.toThrow(/already contains at least one user/);
  });

  /**
   * The realistic version of the residual, and the reason this check exists.
   *
   * An emptied PRODUCTION deployment passes every row check — SCRUM-231 plans
   * exactly such a wipe — but it still carries the integration secrets a real
   * deployment is configured with. A freshly-claimed preview carries only the
   * five the project sets as Preview defaults.
   */
  test.each([
    ["SUPER_ADMIN_EMAILS", "owner@example.com"],
    ["RESEND_API_KEY", "re_something"],
    ["STRIPE_WEBHOOK_SECRET", "whsec_something"],
  ])("refuses a deployment configured like a real one (%s)", async (name, value) => {
    vi.stubEnv(name, value);
    const t = newDeployment();

    await expect(
      t.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
    ).rejects.toThrow(new RegExp(`only a configured production or dev deployment has \\(${name}\\)`));

    const markers = await t.run(async (ctx) => ctx.db.query("e2ePreviewBootstrap").collect());
    expect(markers).toEqual([]);
  });

  /** TURNSTILE_SECRET_KEY is a legitimate Preview default and must not refuse. */
  test("does not refuse a deployment carrying only the project's preview defaults", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test_turnstile_secret_1");
    vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://example.clerk.accounts.dev");
    const t = newDeployment();

    await expect(
      t.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
    ).resolves.toMatchObject({ status: "MARKED" });
  });

  test("refuses to mint an unattributable marker when the deployment has no readable URL", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "");
    const t = newDeployment();

    await expect(
      t.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
    ).rejects.toThrow(/Refusing to mint an unattributable marker/);
  });

  /**
   * A marker is evidence about ONE deployment. A snapshot import is the
   * realistic way it travels, and a travelled marker would otherwise hand a
   * real deployment an authorization it never earned.
   */
  test("refuses a marker minted for a different deployment", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://preview-one.convex.cloud");
    const t = await markedDeployment();

    vi.stubEnv("CONVEX_CLOUD_URL", "https://somewhere-else.convex.cloud");

    await expect(
      t.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
    ).rejects.toThrow(/was minted for https:\/\/preview-one\.convex\.cloud/);
    // Aimed at the deployment it is EXECUTING on, so the identity check passes
    // and the travelled marker is the thing actually under test.
    await expect(
      t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
        primary: PRIMARY,
        approver: APPROVER,
        expectedCloudUrl: "https://somewhere-else.convex.cloud",
      }),
    ).rejects.toThrow(/was minted for https:\/\/preview-one\.convex\.cloud/);
  });
});

describe("bootstrapE2EOrganization — the preview-only gate", () => {
  /**
   * Failing-first case 7: a non-preview target is refused BEFORE any write.
   * The assertion on the empty tables is the half that matters — a refusal
   * that had already inserted the organization would be no refusal at all.
   */
  test("refuses, and writes nothing, when the deployment carries no preview marker", async () => {
    const t = newDeployment();

    await expect(bootstrap(t)).rejects.toThrow(/carries no preview bootstrap marker/);

    const { orgs, users, memberships } = await t.run(async (ctx) => ({
      orgs: await ctx.db.query("organizations").collect(),
      users: await ctx.db.query("users").collect(),
      memberships: await ctx.db.query("memberships").collect(),
    }));
    expect(orgs).toEqual([]);
    expect(users).toEqual([]);
    expect(memberships).toEqual([]);
  });

  test("refuses to seed beside an organization it did not create", async () => {
    const t = newDeployment();
    await t.run(async (ctx) => {
      await ctx.db.insert("e2ePreviewBootstrap", {
        markedAt: Date.now(),
        convexCloudUrl: CLOUD_URL,
      });
      await ctx.db.insert("organizations", {
        name: "Somebody Else's Motors",
        createdAt: Date.now(),
        commitmentAuthorityVersion: 1,
      });
    });

    await expect(bootstrap(t)).rejects.toThrow(/did not create/);

    // ⚠️ The refusal happens AFTER the primary user row would have been
    // inserted, so this asserts the rollback, not merely the throw. A refusal
    // that left a user row behind on a real deployment would be no refusal.
    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(users).toEqual([]);
  });

  /**
   * Failing-first case 8's silent sibling: a `--preview-name` that resolved to
   * a DIFFERENT preview would seed one database while the browser drove
   * another. Nothing would error; every spec would simply fail as though the
   * product were broken.
   */
  test("refuses when the deployment it is executing on is not the one the browser will drive", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://actually-here.convex.cloud");
    const t = await markedDeployment();

    await expect(
      t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
        primary: PRIMARY,
        approver: APPROVER,
        expectedCloudUrl: "https://meant-to-be-there.convex.cloud",
      }),
    ).rejects.toThrow(/aimed at deployment "meant-to-be-there" but is executing on "actually-here"/);
  });

  test("records that the deployment identity was VERIFIED", async () => {
    const t = await markedDeployment();

    const result = await t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
      primary: PRIMARY,
      approver: APPROVER,
      expectedCloudUrl: CLOUD_URL,
    });

    expect(result.deploymentIdentity).toBe("VERIFIED — the-one-preview");
  });

  /**
   * ⚠️ THE REGRESSION FOR THE FAIL-OPEN THIS USED TO HAVE.
   *
   * This test previously asserted `deploymentIdentity` came back `"SKIPPED"` and
   * that the seed proceeded anyway. An adversarial reviewer named the flaw
   * exactly: for this mutation's control flow a SKIP has the same effect as a
   * PASS, so an inert control was indistinguishable from a working one. Both
   * halves now refuse.
   */
  test("refuses when the caller states no expected deployment", async () => {
    const t = await markedDeployment();

    await expect(
      t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
        primary: PRIMARY,
        approver: APPROVER,
      }),
    ).rejects.toThrow(/no expected deployment URL was supplied/);
  });

  test("refuses when the deployment cannot state its own identity", async () => {
    const t = await markedDeployment();
    vi.stubEnv("CONVEX_CLOUD_URL", "");

    await expect(bootstrap(t)).rejects.toThrow(/does not expose a readable CONVEX_CLOUD_URL/);
  });

  test("refuses a marker that names no deployment at all", async () => {
    const t = newDeployment();
    await t.run(async (ctx) => {
      await ctx.db.insert("e2ePreviewBootstrap", { markedAt: Date.now() });
    });

    await expect(bootstrap(t)).rejects.toThrow(/names no deployment/);
  });
});

describe("bootstrapE2EOrganization — seating both identities", () => {
  /** Failing-first case 5: the exact valid bootstrap. */
  test("seats the salesperson as OWNER and the approver as MANAGER in ONE dealership", async () => {
    const t = await markedDeployment();

    const result = await bootstrap(t);

    expect(result.organizationCreated).toBe(true);
    expect(result.primary.roleName).toBe(E2E_PRIMARY_ROLE_NAME);
    expect(result.approver.roleName).toBe(E2E_APPROVER_ROLE_NAME);

    const state = await t.run(async (ctx) => {
      const orgs = await ctx.db.query("organizations").collect();
      const memberships = await ctx.db.query("memberships").collect();
      const roles = await Promise.all(memberships.map((m) => ctx.db.get(m.roleId)));
      return { orgs, memberships, roles };
    });

    expect(state.orgs).toHaveLength(1);
    expect(state.orgs[0]!.name).toBe(E2E_ORGANIZATION_NAME);
    // A new dealership is born canonical — the seed goes through the product's
    // own creator precisely so this cannot drift.
    expect(state.orgs[0]!.commitmentAuthorityVersion).toBe(1);
    expect(state.memberships).toHaveLength(2);
    expect(new Set(state.memberships.map((m) => m.orgId))).toEqual(new Set([state.orgs[0]!._id]));
    expect(state.roles.map((r) => r?.name).sort()).toEqual(
      [E2E_APPROVER_ROLE_NAME, E2E_PRIMARY_ROLE_NAME].sort(),
    );
  });

  test("gives the approver the authority the approval path needs", async () => {
    const t = await markedDeployment();

    await bootstrap(t);

    const permissions = await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", APPROVER.clerkUserId))
        .unique();
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", user!._id))
        .unique();
      const role = await ctx.db.get(membership!.roleId);
      return role!.permissions;
    });

    expect(permissions).toContain(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    expect(permissions).toContain(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
    expect(permissions).toContain(PERMISSIONS.APPROVE_REQUESTS);
    expect(permissions).toContain(PERMISSIONS.VIEW_FINANCE);
    expect(permissions).toContain(PERMISSIONS.MANAGE_FINANCE);
  });

  test("seeds the org baseline the suite's entry points depend on", async () => {
    const t = await markedDeployment();

    const { orgId } = await bootstrap(t);

    const baseline = await t.run(async (ctx) => ({
      settings: await ctx.db
        .query("orgSettings")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique(),
      sources: await ctx.db
        .query("orgLeadSources")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect(),
      stages: await ctx.db
        .query("orgPipelineStages")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect(),
      accounts: await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect(),
    }));

    // The financed-deal and profit-approval specs enter through the installment
    // sale button, which the sales page renders only when the org enables it.
    expect(baseline.settings!.enabledPaymentTypes).toContain("INSTALLMENT");
    expect(baseline.sources.length).toBeGreaterThan(0);
    expect(baseline.stages.length).toBeGreaterThan(0);
    expect(baseline.accounts.length).toBeGreaterThan(0);
    expect(baseline.accounts.some((a) => a.allowManualPosting)).toBe(true);
  });

  /**
   * SCRUM-795 c22479: the trusted E2E must prove approve is refused on a REAL
   * backend, which needs a pending draft that predates the pilot switch.
   */
  test("the DEFAULT bootstrap seeds no manual-journal draft (a pending draft blocks period close, rehearsal case P1)", async () => {
    const t = await markedDeployment();
    await bootstrap(t);
    await bootstrap(t);
    await bootstrap(t, { seedLegacyManualJournalDraft: false });

    const drafts = await t.run((ctx) => ctx.db.query("manualJournalDrafts").take(10));
    expect(drafts).toHaveLength(0);
  });

  test("with the opt-in flag, seeds exactly one legacy pending manual-journal draft, and a second run adds none", async () => {
    const t = await markedDeployment();
    const first = await bootstrap(t, { seedLegacyManualJournalDraft: true });
    await bootstrap(t, { seedLegacyManualJournalDraft: true });

    const drafts = await t.run((ctx) =>
      ctx.db
        .query("manualJournalDrafts")
        .withIndex("by_org_status", (q) => q.eq("orgId", first.orgId).eq("status", "PENDING_APPROVAL"))
        .take(10)
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].idempotencyKey).toBe("e2e-scrum795-legacy-pending-draft");
    expect(drafts[0].memo).toBe("E2E legacy pending draft (SCRUM-795)");
    expect(drafts[0].lines).toHaveLength(2);
    expect(drafts[0].lines.reduce((s, l) => s + l.debitMinor, 0)).toBe(
      drafts[0].lines.reduce((s, l) => s + l.creditMinor, 0)
    );
    expect(drafts[0].accountingDate).toBeDefined();
    const accounts = await Promise.all(drafts[0].lines.map((l) => t.run((ctx) => ctx.db.get(l.accountId))));
    for (const a of accounts) {
      expect(a?.orgId).toBe(first.orgId);
      expect(a?.allowManualPosting).toBe(true);
      expect(a?.active).toBe(true);
    }
  });

  // Accounting Cloud Rehearsal relies on openTheBooks creating the one open
  // period (scripts/accountingRehearsalCases.mjs), so the bootstrap must leave
  // the books period-less. The browser swarm opens its own, after trusted E2E
  // (scripts/intelligence/browserSwarmAccountingPeriod.ts), never here.
  test("seeds a chart of accounts but no accounting period", async () => {
    const t = await markedDeployment();

    const { orgId } = await bootstrap(t);

    const books = await t.run(async (ctx) => ({
      accounts: await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect(),
      periods: await ctx.db
        .query("accountingPeriods")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect(),
    }));

    expect(books.accounts.length).toBeGreaterThan(0);
    expect(books.periods).toEqual([]);
  });

  /** Failing-first case 6: idempotency. */
  test("running it twice changes nothing", async () => {
    const t = await markedDeployment();

    const first = await bootstrap(t);
    const second = await bootstrap(t);

    expect(second.orgId).toBe(first.orgId);
    expect(second.organizationCreated).toBe(false);
    expect(second.primary.membershipCreated).toBe(false);
    expect(second.approver.membershipCreated).toBe(false);

    const counts = await t.run(async (ctx) => ({
      orgs: (await ctx.db.query("organizations").collect()).length,
      users: (await ctx.db.query("users").collect()).length,
      memberships: (await ctx.db.query("memberships").collect()).length,
      roles: (await ctx.db.query("roles").collect()).length,
      settings: (await ctx.db.query("orgSettings").collect()).length,
      sources: (await ctx.db.query("orgLeadSources").collect()).length,
      stages: (await ctx.db.query("orgPipelineStages").collect()).length,
      markers: (await ctx.db.query("e2ePreviewBootstrap").collect()).length,
    }));

    expect(counts).toEqual({
      orgs: 1,
      users: 2,
      memberships: 2,
      roles: 6,
      settings: 1,
      sources: 8,
      stages: 8,
      markers: 1,
    });
  });

  /**
   * Failing-first case 3, at the seeding step: an identity that already belongs
   * somewhere else is a refusal, not something to paper over with a second
   * membership. A second membership would make `organizations.listMine`
   * order-dependent and land the fixtures in whichever dealership sorted first.
   */
  test("refuses an identity that already belongs to a different organization", async () => {
    const t = await markedDeployment();
    await bootstrap(t);

    const foreignOrgId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        name: "Rival Motors",
        createdAt: Date.now(),
        commitmentAuthorityVersion: 1,
      });
      const roleId = await ctx.db.insert("roles", {
        orgId,
        name: "MANAGER",
        permissions: ["view:org"],
      });
      const strayUserId = await ctx.db.insert("users", {
        clerkId: "user_stray",
        email: "stray@example.com",
      });
      await ctx.db.insert("memberships", { orgId, userId: strayUserId, roleId });
      return orgId;
    });

    await expect(
      t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
        expectedCloudUrl: CLOUD_URL,
        primary: PRIMARY,
        approver: { ...APPROVER, clerkUserId: "user_stray", email: "stray@example.com" },
      }),
    ).rejects.toThrow(new RegExp(`already belongs to a DIFFERENT organization \\(${foreignOrgId}`));
  });

  /** Separation of duties is seeded, not assumed. */
  test("refuses when both seats resolve to the same Clerk identity", async () => {
    const t = await markedDeployment();

    await expect(
      t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
        expectedCloudUrl: CLOUD_URL,
        primary: PRIMARY,
        approver: { ...APPROVER, clerkUserId: PRIMARY.clerkUserId },
      }),
    ).rejects.toThrow(/resolve to the same Clerk user/);
  });

  test("refuses when both seats carry the same address", async () => {
    const t = await markedDeployment();

    await expect(
      t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
        expectedCloudUrl: CLOUD_URL,
        primary: PRIMARY,
        approver: { ...APPROVER, email: PRIMARY.email },
      }),
    ).rejects.toThrow(/must be two different people/);
  });

  /** Failing-first case 2, at the seeding step. */
  test("refuses a blank identity rather than seating an anonymous seat", async () => {
    const t = await markedDeployment();

    await expect(
      t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
        expectedCloudUrl: CLOUD_URL,
        primary: PRIMARY,
        approver: { ...APPROVER, clerkUserId: "   " },
      }),
    ).rejects.toThrow(/E2E_APPROVER_USER clerkUserId is empty/);
  });

  test("never echoes a whole configured address into an error", async () => {
    const t = await markedDeployment();
    await bootstrap(t);
    await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        name: "Rival Motors",
        createdAt: Date.now(),
        commitmentAuthorityVersion: 1,
      });
      const roleId = await ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: [] });
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", APPROVER.clerkUserId))
        .unique();
      await ctx.db.insert("memberships", { orgId, userId: user!._id, roleId });
    });

    const error = await bootstrap(t).catch((e: unknown) => e);

    expect(String(error)).not.toContain(APPROVER.email);
    expect(String(error)).toContain("au***************@example.com");
  });
});

describe("assertE2EBootstrap — the preflight", () => {
  test("passes on a correctly seeded preview", async () => {
    const t = await markedDeployment();
    const { orgId } = await bootstrap(t);

    const verdict = await t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        expectedCloudUrl: CLOUD_URL,
      primaryClerkUserId: PRIMARY.clerkUserId,
      approverClerkUserId: APPROVER.clerkUserId,
    });

    expect(verdict.orgId).toBe(orgId);
    expect(verdict.primary.roleName).toBe(E2E_PRIMARY_ROLE_NAME);
    // Probed by NAME. `process.env` is not enumerable in the Convex runtime —
    // the real preview answered [] to Object.keys() in the same call whose
    // deploymentIdentity was VERIFIED, which requires CONVEX_CLOUD_URL to be set.
    expect(verdict.convexEnvProbe).toContain("CONVEX_CLOUD_URL");
    expect(verdict.approver.roleName).toBe(E2E_APPROVER_ROLE_NAME);
  });

  /** Failing-first case 1: a brand-new preview with no seed. */
  test("reports an unseeded preview as an infrastructure fault", async () => {
    const t = await markedDeployment();

    await expect(
      t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        expectedCloudUrl: CLOUD_URL,
        primaryClerkUserId: PRIMARY.clerkUserId,
        approverClerkUserId: APPROVER.clerkUserId,
      }),
    ).rejects.toThrow(/marked as a preview but was never seeded/);
  });

  /**
   * Failing-first case 2: the exact production failure, named at the preflight
   * instead of thirty seconds into a browser. This is the state that produced
   * "2 failed + 20 did not run" at 90d5f03fe.
   */
  test("names the seat when the approver has no membership", async () => {
    const t = await markedDeployment();
    await bootstrap(t);
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", APPROVER.clerkUserId))
        .unique();
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", user!._id))
        .unique();
      await ctx.db.delete(membership!._id);
    });

    await expect(
      t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        expectedCloudUrl: CLOUD_URL,
        primaryClerkUserId: PRIMARY.clerkUserId,
        approverClerkUserId: APPROVER.clerkUserId,
      }),
    ).rejects.toThrow(/E2E_APPROVER_USER .* has a user row but NO membership/);
  });

  test("names the seat when the approver has no user row at all", async () => {
    const t = await markedDeployment();
    await bootstrap(t);

    await expect(
      t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        expectedCloudUrl: CLOUD_URL,
        primaryClerkUserId: PRIMARY.clerkUserId,
        approverClerkUserId: "user_never_provisioned",
      }),
    ).rejects.toThrow(/has no user row on this deployment/);
  });

  /** Failing-first case 3, at the preflight. */
  test("names the organizations when the approver sits in a different one", async () => {
    const t = await markedDeployment();
    await bootstrap(t);
    const foreignOrgId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        name: "Rival Motors",
        createdAt: Date.now(),
        commitmentAuthorityVersion: 1,
      });
      const roleId = await ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: [] });
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", APPROVER.clerkUserId))
        .unique();
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", user!._id))
        .unique();
      await ctx.db.patch(membership!._id, { orgId });
      return orgId;
    });

    await expect(
      t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        expectedCloudUrl: CLOUD_URL,
        primaryClerkUserId: PRIMARY.clerkUserId,
        approverClerkUserId: APPROVER.clerkUserId,
      }),
    ).rejects.toThrow(new RegExp(`belongs to organization\\(s\\) ${foreignOrgId}`));
  });

  /** Failing-first case 4. */
  test("names the missing permission when the approver's role is under-powered", async () => {
    const t = await markedDeployment();
    await bootstrap(t);
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", APPROVER.clerkUserId))
        .unique();
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", user!._id))
        .unique();
      const role = await ctx.db.get(membership!.roleId);
      await ctx.db.patch(membership!.roleId, {
        permissions: role!.permissions.filter(
          (p) => p !== PERMISSIONS.APPROVE_FINANCE_APPLICATION,
        ),
      });
    });

    await expect(
      t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        expectedCloudUrl: CLOUD_URL,
        primaryClerkUserId: PRIMARY.clerkUserId,
        approverClerkUserId: APPROVER.clerkUserId,
      }),
    ).rejects.toThrow(/missing approve:finance_application/);
  });

  test("refuses when both seats are the same identity", async () => {
    const t = await markedDeployment();
    await bootstrap(t);

    await expect(
      t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        expectedCloudUrl: CLOUD_URL,
        primaryClerkUserId: PRIMARY.clerkUserId,
        approverClerkUserId: PRIMARY.clerkUserId,
      }),
    ).rejects.toThrow(/separation of duties/);
  });
});

/**
 * SCRUM-143-RR-1 — Codex, bounded re-review of `ab0c1fdb7`.
 *
 * The marker was a ONE-TIME attestation. `markPreviewDeployment` returned
 * ALREADY_MARKED before re-running any guard, and `requireMarker` only checked
 * that a marker existed and named this deployment. So a deployment marked while
 * it was empty and unconfigured stayed authorized **forever** — including after
 * it acquired every environment marker of a real deployment. Nothing
 * revalidated it.
 *
 * Codex rated it production-reachable via a privileged hand-run outside
 * `scripts/e2ePreviewBootstrap.mjs`. I could not reproduce the specific
 * SCRUM-231 framing — a wipe deletes rows, not environment variables, so an
 * emptied production deployment still trips the configuration check at mint
 * time. The window that IS real is narrower and entirely mechanical: marked
 * while unconfigured, configured afterwards. These tests close it.
 *
 * Each fails against the code as it stood at `ab0c1fdb7`.
 */
describe("SCRUM-143-RR-1 — authorization is revalidated, not remembered", () => {
  test("re-minting is refused once the deployment is configured like a real one", async () => {
    const t = await markedDeployment();

    vi.stubEnv("SUPER_ADMIN_EMAILS", "owner@example.com");

    await expect(t.mutation(internal.e2eBootstrap.markPreviewDeployment, {})).rejects.toThrow(
      /only a configured production or dev deployment has \(SUPER_ADMIN_EMAILS\)/,
    );
  });

  test("a valid marker does NOT authorize seeding once the deployment is configured", async () => {
    const t = await markedDeployment();

    vi.stubEnv("RESEND_API_KEY", "re_something");

    await expect(
      t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
        primary: PRIMARY,
        approver: APPROVER,
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/refusing to honour a preview bootstrap marker/);
  });

  test("and writes nothing when it refuses", async () => {
    const t = await markedDeployment();

    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_something");

    await expect(
      t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
        primary: PRIMARY,
        approver: APPROVER,
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow();

    const [orgs, users, memberships] = await t.run(async (ctx) => [
      await ctx.db.query("organizations").collect(),
      await ctx.db.query("users").collect(),
      await ctx.db.query("memberships").collect(),
    ]);
    expect(orgs).toEqual([]);
    expect(users).toEqual([]);
    expect(memberships).toEqual([]);
  });

  test("the preflight refuses too, rather than vouching for a configured deployment", async () => {
    const t = await markedDeployment();
    await bootstrap(t);

    vi.stubEnv("CLERK_WEBHOOK_SECRET", "whsec_clerk");

    await expect(
      t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        primaryClerkUserId: PRIMARY.clerkUserId,
        approverClerkUserId: APPROVER.clerkUserId,
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/refusing to honour a preview bootstrap marker/);
  });

  /**
   * The control for all four: the same calls on the same deployment, with no
   * real-deployment variable set, still succeed. Without this the tests above
   * would pass just as well against a function that refused everything.
   */
  test("CONTROL — an unconfigured preview is unaffected by any of this", async () => {
    const t = await markedDeployment();
    await bootstrap(t);

    await expect(
      t.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
    ).resolves.toMatchObject({ status: "ALREADY_MARKED" });

    await expect(
      t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        primaryClerkUserId: PRIMARY.clerkUserId,
        approverClerkUserId: APPROVER.clerkUserId,
        expectedCloudUrl: CLOUD_URL,
      }),
    ).resolves.toMatchObject({ orgName: E2E_ORGANIZATION_NAME });
  });
});

/**
 * SCRUM-143, owner ruling c17727 — CONTROL 5.
 *
 * The four controls that came before are all ABSENCES: no tenant rows, no
 * production secrets, no foreign URL, no missing marker. An emptied and
 * deconfigured production deployment satisfies every one of them, which is the
 * residual both adversarial reviewers independently found on PR #278 and which
 * SCRUM-231 turns from theory into a scheduled event.
 *
 * `AUTOFLOW_DEPLOYMENT_CLASS=preview`, set as a Convex project Default
 * Environment Variable scoped to Preview only, is the first POSITIVE proof of
 * deployment type this module has. These tests hold two properties:
 *
 * 1. exactly the value `preview` is accepted — absent, different, or merely
 *    similar all refuse, at every boundary, before anything is written;
 * 2. it is re-proved from the CURRENT environment, so a marker minted while the
 *    declaration held is worthless once it is gone. That is the property a
 *    marker cannot carry, and the one the RR-1 round showed this module had
 *    been getting wrong in the other direction.
 *
 * Each boundary is exercised in isolation — the mint on a bare deployment, the
 * write-consumer on a marked one, the read-consumer on a seeded one — so that
 * removing the check from any single site fails a test that removing it from
 * the other two does not.
 */
describe("SCRUM-143 — the deployment class is re-proved, never remembered", () => {
  /** Every one of these is NOT the string `preview`, and `===` is the whole check. */
  const NOT_PREVIEW: Array<[string, string | undefined]> = [
    ["absent entirely", undefined],
    ["empty", ""],
    ["production", "production"],
    ["dev", "dev"],
    ["prod", "prod"],
    ["capitalised", "Preview"],
    ["shouted", "PREVIEW"],
    ["space-padded on the left", " preview"],
    ["space-padded on the right", "preview "],
    ["pluralised", "previews"],
    ["a list that contains it", "preview,dev"],
    ["a sentence that contains it", "this is a preview"],
  ];

  test.each(NOT_PREVIEW)(
    "the mint refuses, and writes nothing, when the class is %s",
    async (_label, value) => {
      const t = newDeployment();
      vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", value);

      await expect(
        t.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
      ).rejects.toThrow(/may mint or honour a preview bootstrap marker/);

      // Refused BEFORE the write, not rolled back after it: no marker at all.
      const markers = await t.run(async (ctx) =>
        ctx.db.query("e2ePreviewBootstrap").collect(),
      );
      expect(markers).toEqual([]);
    },
  );

  test("the mint distinguishes an absent declaration from a wrong one", async () => {
    const absent = newDeployment();
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", undefined);
    await expect(
      absent.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
    ).rejects.toThrow(/declares no class at all/);

    const wrong = newDeployment();
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "production");
    await expect(
      wrong.mutation(internal.e2eBootstrap.markPreviewDeployment, {}),
    ).rejects.toThrow(/declares a different class/);
  });

  /**
   * The refusal reaches a CI log. Interpolating the observed value into it is
   * the same taint class (`jssecurity:S5145`) already fixed once on this branch
   * — and by definition the value here is one this deployment should not hold.
   */
  test("the refusal never prints the value it rejected", async () => {
    const sentinel = "prod-cluster-7-do-not-print-me";
    const t = newDeployment();
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", sentinel);

    let message = "";
    try {
      await t.mutation(internal.e2eBootstrap.markPreviewDeployment, {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Non-empty AND matching, so a mutation that stopped throwing fails here.
    expect(message).toMatch(/declares a different class/);
    expect(message).not.toContain(sentinel);
  });

  test("a marker minted under `preview` is worthless once the class is gone", async () => {
    const t = await markedDeployment();
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", undefined);

    await expect(bootstrap(t)).rejects.toThrow(/declares no class at all/);

    const [orgs, users, memberships] = await t.run(async (ctx) => [
      await ctx.db.query("organizations").collect(),
      await ctx.db.query("users").collect(),
      await ctx.db.query("memberships").collect(),
    ]);
    expect(orgs).toEqual([]);
    expect(users).toEqual([]);
    expect(memberships).toEqual([]);
  });

  test("and once the class changes to something else", async () => {
    const t = await markedDeployment();
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "production");

    await expect(bootstrap(t)).rejects.toThrow(/declares a different class/);
  });

  /**
   * Boundary 3 in isolation: the deployment was a preview when it was marked
   * AND when it was seeded, so neither of the other two checks is what refuses
   * here. A preflight that vouched for a deployment the seed would refuse is a
   * green light for a red door.
   */
  test("the preflight refuses on the same evidence, not on the marker", async () => {
    const t = await markedDeployment();
    await bootstrap(t);

    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "dev");

    await expect(
      t.query(internal.e2eBootstrap.assertE2EBootstrap, {
        primaryClerkUserId: PRIMARY.clerkUserId,
        approverClerkUserId: APPROVER.clerkUserId,
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/declares a different class/);
  });

  /**
   * The control for all of the above. Without it every test here would pass
   * just as well against a module that refused everything unconditionally —
   * and it also pins the runtime evidence field, which exists because a
   * fail-closed check that never runs looks exactly like one that always passes.
   */
  test("CONTROL — under an exact `preview` declaration, the whole path still works", async () => {
    const t = await markedDeployment();

    const seeded = await bootstrap(t);
    expect(seeded.organizationCreated).toBe(true);

    const preflight = await t.query(internal.e2eBootstrap.assertE2EBootstrap, {
      primaryClerkUserId: PRIMARY.clerkUserId,
      approverClerkUserId: APPROVER.clerkUserId,
      expectedCloudUrl: CLOUD_URL,
    });
    expect(preflight.orgName).toBe(E2E_ORGANIZATION_NAME);
    expect(preflight.deploymentClass).toBe("VERIFIED — declared preview");
  });
});

describe("setHuntSeatRole — SCRUM-768 hunt seat re-roling", () => {
  async function seeded() {
    const t = await markedDeployment();
    await bootstrap(t);
    return t;
  }

  async function seatState(t: ReturnType<typeof newDeployment>, clerkUserId: string) {
    return await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkUserId))
        .unique();
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", user!._id))
        .unique();
      const role = await ctx.db.get(membership!.roleId);
      const agent = await ctx.db
        .query("supportAgents")
        .withIndex("by_userId", (q) => q.eq("userId", user!._id))
        .unique();
      return { roleName: role!.name, permissions: role!.permissions as string[], agent };
    });
  }

  test("covers exactly the dealership roles: never super-admin, never support agent", () => {
    expect(HUNT_SEAT_ROLES).toEqual(DEFAULT_ROLE_TEMPLATES.map((r) => r.name));
    expect(HUNT_SEAT_ROLES).not.toContain("SUPER_ADMIN");
    expect(HUNT_SEAT_ROLES).not.toContain("SUPPORT_AGENT");
  });

  test.each(DEFAULT_ROLE_TEMPLATES.map((r) => r.name))(
    "moves the primary seat to %s with exactly the template's permissions",
    async (roleName) => {
      const t = await seeded();

      const result = await t.mutation(internal.e2eBootstrap.setHuntSeatRole, {
        seat: "primary",
        clerkUserId: PRIMARY.clerkUserId,
        role: roleName,
        expectedCloudUrl: CLOUD_URL,
      });

      expect(result.role).toBe(roleName);
      const state = await seatState(t, PRIMARY.clerkUserId);
      const template = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === roleName)!;
      expect(state.roleName).toBe(roleName);
      expect([...state.permissions].sort()).toEqual([...template.permissions].sort());
    },
  );

  test("resets the bootstrap's widened approver role to the MANAGER template", async () => {
    const t = await seeded();
    const template = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "MANAGER")!;
    const before = await seatState(t, APPROVER.clerkUserId);
    const widened = before.permissions.some((p) => !(template.permissions as string[]).includes(p));

    const result = await t.mutation(internal.e2eBootstrap.setHuntSeatRole, {
      seat: "approver",
      clerkUserId: APPROVER.clerkUserId,
      role: "MANAGER",
      expectedCloudUrl: CLOUD_URL,
    });

    expect(result.permissionsResetToTemplate).toBe(widened);
    const after = await seatState(t, APPROVER.clerkUserId);
    expect([...after.permissions].sort()).toEqual([...template.permissions].sort());
  });

  // A seat that kept its OWNER membership and gained a support-agent row would
  // hold both authorities at once — not what any real support agent holds.
  test("refuses SUPPORT_AGENT and never grants a support-agent row", async () => {
    const t = await seeded();
    await expect(
      t.mutation(internal.e2eBootstrap.setHuntSeatRole, {
        seat: "primary",
        clerkUserId: PRIMARY.clerkUserId,
        role: "SUPPORT_AGENT",
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/not a hunt role/);
    const state = await seatState(t, PRIMARY.clerkUserId);
    expect(state.roleName).toBe("OWNER");
    expect(state.agent).toBeNull();
  });

  test("refuses a role outside the hunt list", async () => {
    const t = await seeded();
    await expect(
      t.mutation(internal.e2eBootstrap.setHuntSeatRole, {
        seat: "primary",
        clerkUserId: PRIMARY.clerkUserId,
        role: "SUPER_ADMIN",
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/not a hunt role/);
  });

  test("refuses a deployment other than the one the workflow named", async () => {
    const t = await seeded();
    await expect(
      t.mutation(internal.e2eBootstrap.setHuntSeatRole, {
        seat: "primary",
        clerkUserId: PRIMARY.clerkUserId,
        role: "SALES",
        expectedCloudUrl: "https://kindly-hound-172.convex.cloud",
      }),
    ).rejects.toThrow(/aimed at deployment/);
    expect((await seatState(t, PRIMARY.clerkUserId)).roleName).toBe(E2E_PRIMARY_ROLE_NAME);
  });

  test("refuses a deployment configured like a real one (SUPER_ADMIN_EMAILS set)", async () => {
    const t = await seeded();
    vi.stubEnv("SUPER_ADMIN_EMAILS", "someone@example.com");
    await expect(
      t.mutation(internal.e2eBootstrap.setHuntSeatRole, {
        seat: "primary",
        clerkUserId: PRIMARY.clerkUserId,
        role: "SALES",
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/configured production or dev deployment/);
  });

  test("refuses a deployment that does not declare itself a preview", async () => {
    const t = await seeded();
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "");
    await expect(
      t.mutation(internal.e2eBootstrap.setHuntSeatRole, {
        seat: "primary",
        clerkUserId: PRIMARY.clerkUserId,
        role: "SALES",
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/declares no class/);
  });

  test("refuses a marked preview that was never seeded", async () => {
    const t = await markedDeployment();
    await expect(
      t.mutation(internal.e2eBootstrap.setHuntSeatRole, {
        seat: "primary",
        clerkUserId: PRIMARY.clerkUserId,
        role: "SALES",
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/never seeded/);
  });

  test("refuses a Clerk user that is not a seated hunt identity", async () => {
    const t = await seeded();
    await expect(
      t.mutation(internal.e2eBootstrap.setHuntSeatRole, {
        seat: "primary",
        clerkUserId: "user_someone_else",
        role: "SALES",
        expectedCloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/no user row/);
  });
});
describe("replayAttestation — the positive attestation the GL replay requires (SCRUM-795)", () => {
  const NONCE = "0123456789abcdef0123456789abcdef";
  const RUN_ID = "run-4242";

  /** The lane's three per-run variables, as it sets them on the fresh preview right after creating it. */
  function stubRunBinding(over: { nonce?: string; runId?: string; expiresAt?: number } = {}) {
    vi.stubEnv("E2E_REPLAY_RUN_NONCE", over.nonce ?? NONCE);
    vi.stubEnv("E2E_REPLAY_RUN_ID", over.runId ?? RUN_ID);
    vi.stubEnv("E2E_REPLAY_RUN_EXPIRES_AT", String(over.expiresAt ?? Date.now() + 60 * 60 * 1000));
  }

  /** The lane's end-of-run cleanup: `convex env remove` for each of the three. */
  function removeRunBinding(...names: string[]) {
    for (const name of names) vi.stubEnv(name, undefined as unknown as string);
  }

  async function seededAs() {
    const t = await markedDeployment();
    const result = await bootstrap(t);
    return {
      t,
      orgId: result.orgId,
      asPrimary: t.withIdentity({ subject: PRIMARY.clerkUserId, clerkId: PRIMARY.clerkUserId }),
      asApprover: t.withIdentity({ subject: APPROVER.clerkUserId, clerkId: APPROVER.clerkUserId }),
    };
  }

  /** What the client sends: the run id and an HMAC proof over the org and run id, never the nonce. */
  const sentFor = (orgId: string, over: { nonce?: string; runId?: string } = {}) => ({
    runId: over.runId ?? RUN_ID,
    proof: replayProofFor(over.nonce ?? NONCE, orgId, over.runId ?? RUN_ID),
  });

  test("attests a seeded preview whose run values and proof match", async () => {
    stubRunBinding();
    const { asPrimary, orgId } = await seededAs();
    const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(attestation).toMatchObject({
      attested: true,
      reasons: [],
      deploymentName: "the-one-preview",
      markerDeploymentName: "the-one-preview",
    });
    expect(attestation.orgAgeMs).toBeGreaterThanOrEqual(0);
  });

  test("the server does not return the nonce, the run id, the proof or the expiry", async () => {
    stubRunBinding();
    const { asPrimary, orgId } = await seededAs();
    const sent = sentFor(orgId);
    const wire = JSON.stringify(await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sent }));
    expect(wire).not.toContain(NONCE);
    expect(wire).not.toContain(RUN_ID);
    expect(wire).not.toContain(sent.proof);
  });

  test("the exact promoted-preview scenario when the lane cleaned up: class, marker and org attest, the run values are gone", async () => {
    stubRunBinding();
    const { asPrimary, orgId } = await seededAs();
    expect((await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) })).attested).toBe(true);
    // The lane removes all three from the preview before deleting it. A preview promoted after that has no values.
    removeRunBinding("E2E_REPLAY_RUN_NONCE", "E2E_REPLAY_RUN_ID", "E2E_REPLAY_RUN_EXPIRES_AT");
    const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(attestation.attested).toBe(false);
    expect(attestation.reasons).toEqual(expect.arrayContaining(["NONCE_NOT_SET", "EXPIRY_NOT_SET", "RUN_ID_MISMATCH"]));
    expect(attestation.reasons).not.toContain("CLASS_NOT_PREVIEW");
    expect(attestation.reasons).not.toContain("NO_MARKER");
  });

  test.each([
    ["the nonce", ["E2E_REPLAY_RUN_NONCE"], "NONCE_NOT_SET"],
    ["the run id", ["E2E_REPLAY_RUN_ID"], "RUN_ID_MISMATCH"],
    ["the expiry", ["E2E_REPLAY_RUN_EXPIRES_AT"], "EXPIRY_NOT_SET"],
  ])("removing only %s from the environment refuses", async (_name, names, code) => {
    stubRunBinding();
    const { asPrimary, orgId } = await seededAs();
    removeRunBinding(...names);
    const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(attestation.attested).toBe(false);
    expect(attestation.reasons).toContain(code);
  });

  test("a promotion that keeps the values but changes the deployment's URL is refused by the marker's identity", async () => {
    stubRunBinding();
    const { asPrimary, orgId } = await seededAs();
    vi.stubEnv("CONVEX_CLOUD_URL", "https://promoted-elsewhere-1.convex.cloud");
    const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(attestation.attested).toBe(false);
    expect(attestation.reasons).toContain("MARKER_NOT_THIS_DEPLOYMENT");
    // The backend now names a different deployment than the marker, which the client guard also refuses.
    expect(attestation.deploymentName).toBe("promoted-elsewhere-1");
    expect(attestation.markerDeploymentName).toBe("the-one-preview");
  });

  test("a promotion that drops the preview class is refused", async () => {
    stubRunBinding();
    const { asPrimary, orgId } = await seededAs();
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "");
    expect((await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) })).reasons).toContain(
      "CLASS_NOT_PREVIEW",
    );
  });

  test("refuses a proof made with another nonce, another org, or another run id (no replay across them)", async () => {
    stubRunBinding();
    const { t, asPrimary, orgId } = await seededAs();
    const otherOrg = await t.run(async (ctx) => {
      const org = await ctx.db.get(orgId);
      return (await ctx.db.insert("organizations", { ...org!, _id: undefined, _creationTime: undefined } as never)) as typeof orgId;
    });
    const cases = [
      { runId: RUN_ID, proof: replayProofFor("fedcba9876543210fedcba9876543210", orgId, RUN_ID) },
      { runId: RUN_ID, proof: replayProofFor(NONCE, otherOrg, RUN_ID) },
      { runId: RUN_ID, proof: replayProofFor(NONCE, orgId, "run-other") },
    ];
    for (const sent of cases) {
      const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sent });
      expect(attestation.attested).toBe(false);
      expect(attestation.reasons).toContain("PROOF_MISMATCH");
    }
  });

  test("refuses a run id that does not match, and malformed run ids and proofs", async () => {
    stubRunBinding();
    const { asPrimary, orgId } = await seededAs();
    const mismatch = await asPrimary.query(api.e2eBootstrap.replayAttestation, {
      orgId,
      runId: "run-other",
      proof: replayProofFor(NONCE, orgId, "run-other"),
    });
    expect(mismatch.attested).toBe(false);
    expect(mismatch.reasons).toContain("RUN_ID_MISMATCH");

    const badRunId = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, runId: "bad run!", proof: sentFor(orgId).proof });
    expect(badRunId.reasons).toContain("SENT_RUN_ID_MALFORMED");
    for (const proof of ["", "abc", "Z".repeat(64), sentFor(orgId).proof.toUpperCase(), `${sentFor(orgId).proof}0`]) {
      const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, runId: RUN_ID, proof });
      expect(attestation.attested).toBe(false);
      expect(attestation.reasons).toContain("PROOF_MALFORMED");
    }
  });

  test("refuses after the expiry, and an expiry further ahead than the 2 hour cap", async () => {
    const { asPrimary, orgId } = await seededAs();
    stubRunBinding({ expiresAt: Date.now() - 1 });
    const expired = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(expired.attested).toBe(false);
    expect(expired.reasons).toContain("EXPIRED");

    stubRunBinding({ expiresAt: Date.now() + 2 * 60 * 60 * 1000 + 60_000 });
    const far = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(far.attested).toBe(false);
    expect(far.reasons).toContain("EXPIRY_TOO_FAR");

    stubRunBinding({ expiresAt: Date.now() + 60 * 60 * 1000 });
    expect((await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) })).attested).toBe(true);
  });

  test("refuses a nonce shorter than 128 bits in the environment, even with a matching proof", async () => {
    const { asPrimary, orgId } = await seededAs();
    stubRunBinding({ nonce: "short" });
    const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, {
      orgId,
      ...sentFor(orgId, { nonce: "short" }),
    });
    expect(attestation.attested).toBe(false);
    expect(attestation.reasons).toContain("NONCE_TOO_SHORT");
  });

  test("does not attest when the deployment declares no preview class (production answers false)", async () => {
    stubRunBinding();
    const { asPrimary, orgId } = await seededAs();
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "");
    const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(attestation.attested).toBe(false);
    expect(attestation.reasons).toContain("CLASS_NOT_PREVIEW");
  });

  test("does not attest when the marker names another deployment, is not bound to the org, or is missing", async () => {
    stubRunBinding();
    const { t, asPrimary, orgId } = await seededAs();
    const sent = sentFor(orgId);
    await t.run(async (ctx) => {
      const marker = await ctx.db.query("e2ePreviewBootstrap").first();
      await ctx.db.patch(marker!._id, { convexCloudUrl: "https://another-one.convex.cloud" });
    });
    const foreign = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sent });
    expect(foreign.attested).toBe(false);
    expect(foreign.reasons).toContain("MARKER_NOT_THIS_DEPLOYMENT");
    expect(foreign.markerDeploymentName).toBe("another-one");

    await t.run(async (ctx) => {
      const marker = await ctx.db.query("e2ePreviewBootstrap").first();
      await ctx.db.patch(marker!._id, { convexCloudUrl: CLOUD_URL, orgId: undefined });
    });
    const unbound = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sent });
    expect(unbound.attested).toBe(false);
    expect(unbound.reasons).toContain("ORG_NOT_BOUND_TO_MARKER");

    await t.run(async (ctx) => {
      const marker = await ctx.db.query("e2ePreviewBootstrap").first();
      await ctx.db.delete(marker!._id);
    });
    const none = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sent });
    expect(none.attested).toBe(false);
    expect(none.reasons).toContain("NO_MARKER");
  });

  test("does not attest a deployment configured like a real one (a real-deployment env marker is set)", async () => {
    stubRunBinding();
    const { asPrimary, orgId } = await seededAs();
    vi.stubEnv("RESEND_API_KEY", "re_live_example");
    const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(attestation.attested).toBe(false);
    expect(attestation.reasons).toContain("CONFIGURED_LIKE_REAL_DEPLOYMENT");
    expect(JSON.stringify(attestation)).not.toContain("re_live_example");
  });

  test("an organization created exactly at the marker's time is attested (the boundary is strict)", async () => {
    stubRunBinding();
    const { t, asPrimary, orgId } = await seededAs();
    await t.run(async (ctx) => {
      const marker = await ctx.db.query("e2ePreviewBootstrap").first();
      const org = await ctx.db.get(orgId);
      await ctx.db.patch(marker!._id, { markedAt: org!._creationTime });
    });
    const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(attestation.reasons).not.toContain("ORG_PREDATES_MARKER");
    expect(attestation.attested).toBe(true);
  });

  test("does not attest an organization created before the marker", async () => {
    stubRunBinding();
    const { t, asPrimary, orgId } = await seededAs();
    await t.run(async (ctx) => {
      const marker = await ctx.db.query("e2ePreviewBootstrap").first();
      await ctx.db.patch(marker!._id, { markedAt: Date.now() + 60_000 });
    });
    const attestation = await asPrimary.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) });
    expect(attestation.attested).toBe(false);
    expect(attestation.reasons).toContain("ORG_PREDATES_MARKER");
  });

  test("refuses a caller who is not a member of the organization", async () => {
    stubRunBinding();
    const { t, orgId } = await seededAs();
    await expect(
      t
        .withIdentity({ subject: "user_outsider", clerkId: "user_outsider" })
        .query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) }),
    ).rejects.toThrow();
  });

  test("refuses an active member of the organization who lacks VIEW_FINANCE", async () => {
    stubRunBinding();
    const { t, orgId, asApprover } = await seededAs();
    // Positive control: the same member, holding the permission, is answered.
    expect((await asApprover.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) })).attested).toBe(true);
    await t.run(async (ctx) => {
      const role = await ctx.db
        .query("roles")
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .collect();
      const manager = role.find((r) => r.name === E2E_APPROVER_ROLE_NAME)!;
      await ctx.db.patch(manager._id, {
        permissions: manager.permissions.filter((p) => p !== PERMISSIONS.VIEW_FINANCE),
      });
    });
    await expect(asApprover.query(api.e2eBootstrap.replayAttestation, { orgId, ...sentFor(orgId) })).rejects.toThrow();
  });
});

describe("replayRunBindingReasons — the pure run binding", () => {
  const NONCE = "0123456789abcdef0123456789abcdef";
  const now = 1_000_000;
  const env = { nonce: NONCE, runId: "r1", expiresAt: String(now + 1000) };
  const sentOk = { orgId: "org1", runId: "r1", proof: replayProofFor(NONCE, "org1", "r1") };

  test("matches only on the same proof, run id and an unexpired, near expiry", () => {
    expect(replayRunBindingReasons(sentOk, env, now)).toEqual([]);
  });

  test("constantTimeEqual agrees with equality and rejects different lengths", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });

  test("a proof differing only in its last or first hex character is a mismatch (no prefix compare)", () => {
    const flip = (c: string) => (c === "0" ? "1" : "0");
    const last = sentOk.proof.slice(0, -1) + flip(sentOk.proof.at(-1)!);
    const first = flip(sentOk.proof[0]!) + sentOk.proof.slice(1);
    for (const proof of [last, first]) {
      expect(replayRunBindingReasons({ ...sentOk, proof }, env, now)).toEqual(["PROOF_MISMATCH"]);
    }
  });

  test("the proof binds the org: the same proof for another org is a mismatch", () => {
    expect(replayRunBindingReasons({ ...sentOk, orgId: "org2" }, env, now)).toEqual(["PROOF_MISMATCH"]);
  });

  test.each(["0x10", "1e9", " 123", "123 ", "+123", "1_000", "-5", "12.5", ""])(
    "rejects the expiry string %j, which Number() might accept but is not a plain integer",
    (expiresAt) => {
      expect(replayRunBindingReasons(sentOk, { ...env, expiresAt }, now)).toContain("EXPIRY_NOT_SET");
    },
  );

  test("pins the clock edges: expiry == now refuses, now + 2h passes, now + 2h + 1 refuses", () => {
    const at = (expiresAt: number) => replayRunBindingReasons(sentOk, { ...env, expiresAt: String(expiresAt) }, now);
    expect(at(now)).toEqual(["EXPIRED"]);
    expect(at(now - 1)).toEqual(["EXPIRED"]);
    expect(at(now + 1)).toEqual([]);
    expect(at(now + REPLAY_MAX_LIFETIME_MS)).toEqual([]);
    expect(at(now + REPLAY_MAX_LIFETIME_MS + 1)).toEqual(["EXPIRY_TOO_FAR"]);
  });

  test("accepts a plain integer expiry", () => {
    expect(replayRunBindingReasons(sentOk, { ...env, expiresAt: String(now + 5000) }, now)).toEqual([]);
  });

  test("fails closed on a nonce outside the alphabet or too short in the environment", () => {
    const odd = "0123456789abcdef0123456789abcde!";
    expect(replayRunBindingReasons(sentOk, { ...env, nonce: odd }, now)).toContain("NONCE_TOO_SHORT");
    expect(replayRunBindingReasons(sentOk, { ...env, nonce: undefined }, now)).toContain("NONCE_NOT_SET");
  });
});
