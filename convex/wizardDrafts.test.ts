import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { buildWizardDraftData, buildWizardQuotePayload } from "../components/sales/wizard/quotePayload";
import type { FunctionArgs } from "convex/server";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const DRAFT_DATA = {
  vehicleId: "",
  vehiclePrice: 15000,
  desiredProfit: 2000,
  downPayment: 3000,
  termMonths: 48,
};

async function seedMember(t: ReturnType<typeof convexTestWithComponents>, clerkId: string) {
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
  test("SCRUM-862: lead and two CASH lines survive save, read and quote resume", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "draft_resume");
    const refs = await seedReferences(t, orgId);
    const wizardData = buildWizardDraftData({ ...DRAFT_DATA, vehicleId: refs.vehicleIds[0], leadId: refs.leadId,
      vehicleItems: refs.vehicleIds.map((vehicleId, index) => ({ vehicleId, unitPrice: index === 0 ? 15000 : 17000 })) });
    await asUser.mutation(api.wizardDrafts.saveDraft, { orgId, paymentType: "CASH", currentStep: 2, wizardData });
    const draft = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
    expect(draft?.wizardData).toEqual(wizardData);
    if (!draft) throw new Error("Saved draft missing");
    const quote = buildWizardQuotePayload({ orgId, customerId: refs.customerId,
      paymentType: "CASH", wizardData: draft.wizardData, selectedResult: {} });
    expect(quote.leadId).toBe(refs.leadId);
    expect(quote.vehicleItems).toEqual(wizardData.vehicleItems);
  });

  test.each(["vehicleId", "vehicleItems", "leadId", "selectedCustomerId", "selectedCompanyId", "status", "wrong-table-status", "wrong-table", "malformed"] as const)(
    "SCRUM-862: refuses %s reference without altering an existing draft", async field => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asUser } = await seedMember(t, "draft_owner");
      const foreign = await seedMember(t, "foreign_owner");
      const localRefs = await seedReferences(t, orgId);
      const foreignRefs = await seedReferences(t, foreign.orgId);
      const args: FunctionArgs<typeof api.wizardDrafts.saveDraft> = { orgId, paymentType: "CASH", currentStep: 2, selectedCustomerId: localRefs.customerId,
        wizardData: { ...DRAFT_DATA, vehicleId: localRefs.vehicleIds[0], leadId: localRefs.leadId,
          selectedCompanyId: localRefs.companyId,
          vehicleItems: [{ vehicleId: localRefs.vehicleIds[0], unitPrice: 15000 },
            { vehicleId: localRefs.vehicleIds[1], unitPrice: 17000 }] } };
      await asUser.mutation(api.wizardDrafts.saveDraft, args);
      const before = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
      const invalid = { ...args, currentStep: 3, wizardData: { ...args.wizardData } };
      if (field === "vehicleId") invalid.wizardData.vehicleId = foreignRefs.vehicleIds[0];
      if (field === "vehicleItems") invalid.wizardData.vehicleItems = [{ vehicleId: localRefs.vehicleIds[0], unitPrice: 15000 },
        { vehicleId: foreignRefs.vehicleIds[1], unitPrice: 17000 }];
      if (field === "leadId") invalid.wizardData.leadId = foreignRefs.leadId;
      if (field === "selectedCustomerId") invalid.selectedCustomerId = foreignRefs.customerId;
      if (field === "selectedCompanyId") invalid.wizardData.selectedCompanyId = foreignRefs.companyId;
      if (field === "status") invalid.wizardData.customerStatuses = [localRefs.statusId, foreignRefs.statusId];
      if (field === "wrong-table-status") invalid.wizardData.customerStatuses = [localRefs.customerId];
      if (field === "wrong-table") invalid.wizardData.vehicleItems = [{ vehicleId: localRefs.customerId, unitPrice: 15000 }];
      if (field === "malformed") invalid.wizardData.vehicleItems = [{ vehicleId: "not-a-native-id", unitPrice: 15000 }];
      await expect(asUser.mutation(api.wizardDrafts.saveDraft, invalid)).rejects.toThrow("Record not found in this organization.");
      expect(await asUser.query(api.wizardDrafts.getMyDraft, { orgId })).toEqual(before);
      expect(await foreign.asUser.query(api.wizardDrafts.getMyDraft, { orgId: foreign.orgId })).toBeNull();
      await expect(foreign.asUser.mutation(api.wizardDrafts.saveDraft, args)).rejects.toThrow();
    });

  test("SCRUM-862: retains repeated lines and manual sentinel, refuses unrelated draft keys", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "draft_strict");
    const refs = await seedReferences(t, orgId);
    const wizardData = { ...DRAFT_DATA, selectedCompanyId: "OTHER",
      customerStatuses: [refs.statusId, refs.statusId],
      vehicleItems: [{ vehicleId: refs.vehicleIds[0], unitPrice: 0 }, { vehicleId: refs.vehicleIds[0], unitPrice: 0 }] };
    const args = { orgId, paymentType: "CASH", currentStep: 1, wizardData };
    await asUser.mutation(api.wizardDrafts.saveDraft, args);
    const before = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
    expect(before?.wizardData).toEqual(wizardData);
    const unrelated = { ...args, wizardData: { ...wizardData, unrelated: true } };
    await expect(asUser.mutation(api.wizardDrafts.saveDraft, unrelated)).rejects.toThrow("Unexpected field");
    const nested = { ...args, wizardData: { ...wizardData,
      vehicleItems: [{ ...wizardData.vehicleItems[0], unrelated: true }] } };
    await expect(asUser.mutation(api.wizardDrafts.saveDraft, nested)).rejects.toThrow("Unexpected field");
    expect(await asUser.query(api.wizardDrafts.getMyDraft, { orgId })).toEqual(before);
  });
  test("getMyDraft returns null when no draft exists", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "sales_wd_001");
    const draft = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
    expect(draft).toBeNull();
  });

  test("saveDraft creates a draft", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "sales_wd_002");
    const refs = await seedReferences(t, orgId);
    const legacyData = { ...DRAFT_DATA, vehicleId: refs.vehicleIds[0] };
    await asUser.mutation(api.wizardDrafts.saveDraft, {
      orgId,
      paymentType: "CASH",
      currentStep: 1,
      wizardData: legacyData,
    });
    const draft = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
    expect(draft).not.toBeNull();
    expect(draft?.paymentType).toBe("CASH");
    expect(draft?.currentStep).toBe(1);
    expect(draft?.wizardData).toEqual(legacyData);
  });

  test("saveDraft upserts — calling twice updates the existing draft", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "sales_wd_005");
    // Should not throw
    await expect(
      asUser.mutation(api.wizardDrafts.clearDraft, { orgId })
    ).resolves.not.toThrow();
  });

  test("drafts are scoped per user — two users have independent drafts", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

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

  test("persists and restores customerStatuses in wizardData", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asUser } = await seedMember(t, "sales_wd_003");
    const refs = await seedReferences(t, orgId);
    await asUser.mutation(api.wizardDrafts.saveDraft, {
      orgId,
      paymentType: "INSTALLMENT",
      currentStep: 2,
      wizardData: {
        ...DRAFT_DATA,
        customerStatuses: [refs.statusId],
      },
    });

    const draft = await asUser.query(api.wizardDrafts.getMyDraft, { orgId });
    expect(draft?.wizardData.customerStatuses).toEqual([refs.statusId]);
  });
});

async function seedReferences(t: ReturnType<typeof convexTestWithComponents>, orgId: import("./_generated/dataModel").Id<"organizations">) {
  return await t.run(async ctx => {
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Customer" });
    const leadId = await ctx.db.insert("leads", { orgId, customerId, source: "Synthetic", stage: "NEW" });
    const companyId = await ctx.db.insert("financeCompanies", { orgId, name: "Synthetic finance", profitRate: 0,
      maxTermMonths: 60, gracePeriodMonths: 0, isActive: true });
    const statusId = await ctx.db.insert("orgCustomerStatuses", { orgId, label: "Synthetic category", isActive: true, order: 0 });
    const vehicleIds = [];
    for (const vin of ["SYNTHETIC-DRAFT-01", "SYNTHETIC-DRAFT-02"]) {
      vehicleIds.push(await ctx.db.insert("vehicles", { orgId, vin, make: "Example", model: "Test", year: 2026,
        color: "Gray", fuelType: "Gasoline", transmission: "Automatic", mileage: 0, sellingPrice: 17000, status: "AVAILABLE" }));
    }
    return { customerId, leadId, companyId, statusId, vehicleIds };
  });
}
