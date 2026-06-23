import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const DRAFT_DATA = {
  vehicleId: "abc123",
  vehiclePrice: 15000,
  desiredProfit: 2000,
  downPayment: 3000,
  termMonths: 48,
};

async function seedMember(t: ReturnType<typeof convexTest>, clerkId: string) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: "Sales" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:sales"] })
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { orgId, userId, roleId })
  );
  return { orgId, asUser: t.withIdentity({ subject: clerkId }) };
}

describe("wizardDrafts", () => {
  test("getMyDraft returns null when no draft exists", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "sales_wd_001");
    const draft = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
    expect(draft).toBeNull();
  });

  test("saveDraft creates a draft", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "sales_wd_002");
    await asUser.mutation(api.wizardDrafts.saveDraft, {
      orgId,
      paymentType: "CASH",
      currentStep: 1,
      wizardData: DRAFT_DATA,
    });
    const draft = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
    expect(draft).not.toBeNull();
    expect(draft?.paymentType).toBe("CASH");
    expect(draft?.currentStep).toBe(1);
  });

  test("saveDraft upserts — calling twice updates the existing draft", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "sales_wd_003");
    await asUser.mutation(api.wizardDrafts.saveDraft, {
      orgId,
      paymentType: "CASH",
      currentStep: 1,
      wizardData: DRAFT_DATA,
    });
    await asUser.mutation(api.wizardDrafts.saveDraft, {
      orgId,
      paymentType: "INSTALLMENT",
      currentStep: 2,
      wizardData: { ...DRAFT_DATA, downPayment: 5000 },
    });
    const draft = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
    expect(draft?.currentStep).toBe(2);
    expect(draft?.paymentType).toBe("INSTALLMENT");
    // Only one draft should exist
    await t.run(async (ctx) => {
      const all = await ctx.db.query("wizardDrafts").collect();
      expect(all).toHaveLength(1);
    });
  });

  test("clearDraft removes the draft", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "sales_wd_004");
    await asUser.mutation(api.wizardDrafts.saveDraft, {
      orgId,
      paymentType: "CASH",
      currentStep: 1,
      wizardData: DRAFT_DATA,
    });
    await asUser.mutation(api.wizardDrafts.clearDraft, { orgId });
    const draft = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
    expect(draft).toBeNull();
  });

  test("clearDraft is safe to call when no draft exists", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "sales_wd_005");
    // Should not throw
    await expect(
      asUser.mutation(api.wizardDrafts.clearDraft, { orgId })
    ).resolves.not.toThrow();
  });

  test("drafts are scoped per user — two users have independent drafts", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));

    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", { name: "Shared Org", createdAt: Date.now() })
    );
    const roleId = await t.run(async (ctx) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    );

    for (const clerkId of ["user_a", "user_b"]) {
      const userId = await t.run(async (ctx) =>
        ctx.db.insert("users", { clerkId, email: `${clerkId}@t.com`, name: clerkId })
      );
      await t.run(async (ctx) =>
        ctx.db.insert("memberships", { orgId, userId, roleId })
      );
    }

    const asA = t.withIdentity({ subject: "user_a" });
    const asB = t.withIdentity({ subject: "user_b" });

    await asA.mutation(api.wizardDrafts.saveDraft, {
      orgId,
      paymentType: "CASH",
      currentStep: 1,
      wizardData: DRAFT_DATA,
    });
    await asB.mutation(api.wizardDrafts.saveDraft, {
      orgId,
      paymentType: "INSTALLMENT",
      currentStep: 2,
      wizardData: DRAFT_DATA,
    });

    const draftA = await asA.query(api.wizardDrafts.getMyDraft, { orgId });
    const draftB = await asB.query(api.wizardDrafts.getMyDraft, { orgId });

    expect(draftA?.paymentType).toBe("CASH");
    expect(draftB?.paymentType).toBe("INSTALLMENT");
  });
});
