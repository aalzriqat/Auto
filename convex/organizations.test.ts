import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  COMMITMENT_AUTHORITY_V1,
  admitAuthorityVersion,
  tryDecisionContext,
} from "./utils/commitmentKernel";

const modules = import.meta.glob("./**/*.ts");

describe("organizations.create", () => {
  test("bootstraps the Convex user row when the Clerk webhook has not synced yet", async () => {
    const t = convexTestWithComponents(schema, modules);
    const asWebhookLaggedUser = t.withIdentity({
      subject: "user_webhook_lagged",
      name: "Webhook Lagged User",
    });

    const orgId = await asWebhookLaggedUser.mutation(api.organizations.create, {
      name: "Webhook Lag Motors",
    });

    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", "user_webhook_lagged"))
        .unique();
      expect(user).toMatchObject({
        clerkId: "user_webhook_lagged",
        email: "no-email-user_webhook_lagged@autoflow.local",
        name: "Webhook Lagged User",
      });
      if (!user) throw new Error("Expected organizations.create to create a user row.");

      const org = await ctx.db.get(orgId);
      expect(org?.name).toBe("Webhook Lag Motors");

      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", user._id))
        .unique();
      expect(membership).toBeTruthy();
      if (!membership) throw new Error("Expected organizations.create to create an owner membership.");

      const role = await ctx.db.get(membership.roleId);
      expect(role?.isSystemOwnerRole).toBe(true);
    });
  });
});

/**
 * SCRUM-208 / SCRUM-201 — A NEW DEALERSHIP IS BORN CANONICAL (owner ruling
 * c15855).
 *
 * ⚠️ WITHOUT THIS, THE CANONICAL RESTORATION LIFECYCLE IS UNREACHABLE CODE.
 * `admitAuthorityVersion` reads a missing version as LEGACY, and before this
 * slice NOTHING in production wrote the field — its only writers in the whole
 * repository were test fixtures. So every organization the product could
 * create was permanently LEGACY, and every deferred reversal it would ever
 * make terminalized AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE. That legacy
 * behaviour was proven end to end against a real Convex backend in c15854;
 * these contracts pin the half that makes the canonical path reachable.
 *
 * ⚠️ TWO HARNESS INSTANCES, NOT FOUR, AND THE REASON IS MEASURED.
 * Each `convexTestWithComponents` instance is real parallel load. Splitting
 * these assertions across four instances reliably tipped timing-marginal
 * suites elsewhere (`collections.test.ts` exhausting its 10,000-timer-pump
 * budget) — red twice with four, green with the production change alone and
 * green at two. The contracts below are unchanged; only the harness cost is.
 */
describe("organizations.create activates canonical commitment authority", () => {
  test("a new organization is canonical before its first commitment transaction", async () => {
    // ⚠️ THE ORDERING IS THE CONTRACT, NOT AN INCIDENTAL DETAIL. Authority
    // must be established before the first vehicle, deposit or finance record
    // exists, because a commitment created while the org still read LEGACY
    // would be judged by the readers the canonical model exists to replace.
    const t = convexTestWithComponents(schema, modules);
    const asOwner = t.withIdentity({ subject: "user_activation", name: "Activation Owner" });

    const orgId = await asOwner.mutation(api.organizations.create, {
      name: "Canonical Motors",
    });

    await t.run(async (ctx) => {
      const org = await ctx.db.get(orgId);
      expect(org?.commitmentAuthorityVersion).toBe(COMMITMENT_AUTHORITY_V1);
      expect(admitAuthorityVersion(org?.commitmentAuthorityVersion)).toEqual({
        ok: true,
        version: "V1",
      });

      // Nothing commitment-shaped exists yet, so the version is genuinely in
      // place BEFORE any commitment could be judged by it.
      expect(await ctx.db.query("vehicles").collect()).toEqual([]);
      expect(await ctx.db.query("deposits").collect()).toEqual([]);
      expect(await ctx.db.query("commitmentRoots").collect()).toEqual([]);
      expect(await ctx.db.query("vehicleCommitmentClaims").collect()).toEqual([]);

      const decision = await tryDecisionContext(
        ctx,
        { now: Date.now(), actor: { kind: "SYSTEM", source: "activation-test" } },
        orgId
      );
      expect(decision.kind).toBe("READY");
      if (decision.kind !== "READY") throw new Error("expected a READY decision context");
      expect(decision.decision.authorityVersion).toBe("V1");
    });
  });

  test("the version is server-owned: legacy rows stay LEGACY and update cannot change it", async () => {
    const t = convexTestWithComponents(schema, modules);
    const asOwner = t.withIdentity({ subject: "user_activation", name: "Activation Owner" });

    const orgId = await asOwner.mutation(api.organizations.create, {
      name: "Canonical Motors",
    });

    // `update` is the only public mutation that patches an organization row.
    // No caller may select, downgrade or clear the version through it.
    await asOwner.mutation(api.organizations.update, { orgId, name: "Renamed Motors" });

    // The activation is for NEW organizations only. A row created without the
    // field keeps being judged by the legacy readers — switching those over is
    // SCRUM-201's cutover, not this slice.
    const legacyOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Legacy Motors", createdAt: Date.now() })
    );

    await t.run(async (ctx) => {
      const org = await ctx.db.get(orgId);
      expect(org?.name).toBe("Renamed Motors");
      expect(org?.commitmentAuthorityVersion).toBe(COMMITMENT_AUTHORITY_V1);

      const legacy = await tryDecisionContext(
        ctx,
        { now: Date.now(), actor: { kind: "SYSTEM", source: "activation-test" } },
        legacyOrgId
      );
      expect(legacy.kind).toBe("READY");
      if (legacy.kind !== "READY") throw new Error("expected a READY decision context");
      expect(legacy.decision.authorityVersion).toBe("LEGACY");
    });
  });
});
