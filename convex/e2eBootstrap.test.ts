import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { PERMISSIONS } from "./utils/permissions";
import {
  E2E_APPROVER_ROLE_NAME,
  E2E_ORGANIZATION_NAME,
  E2E_PRIMARY_ROLE_NAME,
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

async function bootstrap(t: ReturnType<typeof newDeployment>) {
  return await t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, {
    primary: PRIMARY,
    approver: APPROVER,
    expectedCloudUrl: CLOUD_URL,
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
   * four the project sets as Preview defaults.
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
    }));

    // The financed-deal and profit-approval specs enter through the installment
    // sale button, which the sales page renders only when the org enables it.
    expect(baseline.settings!.enabledPaymentTypes).toContain("INSTALLMENT");
    expect(baseline.sources.length).toBeGreaterThan(0);
    expect(baseline.stages.length).toBeGreaterThan(0);
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
