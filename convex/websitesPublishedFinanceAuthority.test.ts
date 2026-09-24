import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { getPublishedSnapshotData } from "./websites";

const MODULES = import.meta.glob("./**/*.*s");

describe("published website finance authority", () => {
  test("NEGATIVE CONTROL: a legacy snapshot without lender identity suppresses finance terms", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        name: "Unknown Fee Dealer",
        createdAt: Date.now(),
      });
      const userId = await ctx.db.insert("users", {
        clerkId: "unknown_fee_owner",
        email: "unknown@example.com",
        name: "Unknown Owner",
      });
      const companyId = await ctx.db.insert("financeCompanies", {
        orgId,
        name: "Unknown Fee Lender",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
      });
      const settingsId = await ctx.db.insert("websiteSettings", {
        orgId,
        enabled: true,
        status: "active",
        templateId: "default",
        defaultLanguage: "en",
        supportedLanguages: ["en", "ar"],
        activeFinanceCompanyId: companyId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        publishedAt: Date.now(),
      });
      const snapshotId = await ctx.db.insert("websitePublishSnapshots", {
        orgId,
        websiteSettingsId: settingsId,
        version: "legacy",
        snapshotJson: {
          financeCompany: {
            name: "Unknown Fee Lender",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: 0,
          },
        },
        createdAt: Date.now(),
        publishedAt: Date.now(),
        publishedByUserId: userId,
      });
      await ctx.db.patch(settingsId, { publishedSnapshotId: snapshotId });
      return { orgId };
    });

    const published = await t.run((ctx) => getPublishedSnapshotData(ctx, orgId));
    expect(published?.financeCompany).toBeNull();
  });

  test("refreshes the published execution fee from the current selected lender", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        name: "Current Fee Dealer",
        createdAt: Date.now(),
      });
      const userId = await ctx.db.insert("users", {
        clerkId: "current_fee_owner",
        email: "current@example.com",
        name: "Current Owner",
      });
      const companyId = await ctx.db.insert("financeCompanies", {
        orgId,
        name: "Current Fee Lender",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        adminFees: 125,
        isActive: true,
      });
      const settingsId = await ctx.db.insert("websiteSettings", {
        orgId,
        enabled: true,
        status: "active",
        templateId: "default",
        defaultLanguage: "en",
        supportedLanguages: ["en", "ar"],
        activeFinanceCompanyId: companyId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        publishedAt: Date.now(),
      });
      const snapshotId = await ctx.db.insert("websitePublishSnapshots", {
        orgId,
        websiteSettingsId: settingsId,
        version: "legacy",
        snapshotJson: {
          financeCompany: {
            _id: companyId,
            name: "Current Fee Lender",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: 0,
          },
        },
        createdAt: Date.now(),
        publishedAt: Date.now(),
        publishedByUserId: userId,
      });
      await ctx.db.patch(settingsId, { publishedSnapshotId: snapshotId });
      return { orgId };
    });

    const published = await t.run((ctx) => getPublishedSnapshotData(ctx, orgId));
    expect(published?.financeCompany).toMatchObject({ adminFees: 125 });
  });

  test("NEGATIVE CONTROL: a snapshot from a different lender suppresses finance terms", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        name: "Changed Lender Dealer",
        createdAt: Date.now(),
      });
      const userId = await ctx.db.insert("users", {
        clerkId: "changed_lender_owner",
        email: "changed@example.com",
        name: "Changed Lender Owner",
      });
      const publishedCompanyId = await ctx.db.insert("financeCompanies", {
        orgId,
        name: "Published Lender",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        adminFees: 100,
        isActive: true,
      });
      const activeCompanyId = await ctx.db.insert("financeCompanies", {
        orgId,
        name: "Replacement Lender",
        profitRate: 7,
        maxTermMonths: 48,
        gracePeriodMonths: 1,
        adminFees: 250,
        isActive: true,
      });
      const settingsId = await ctx.db.insert("websiteSettings", {
        orgId,
        enabled: true,
        status: "active",
        templateId: "default",
        defaultLanguage: "en",
        supportedLanguages: ["en", "ar"],
        activeFinanceCompanyId: activeCompanyId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        publishedAt: Date.now(),
      });
      const snapshotId = await ctx.db.insert("websitePublishSnapshots", {
        orgId,
        websiteSettingsId: settingsId,
        version: "published-lender",
        snapshotJson: {
          financeCompany: {
            _id: publishedCompanyId,
            name: "Published Lender",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: 100,
          },
        },
        createdAt: Date.now(),
        publishedAt: Date.now(),
        publishedByUserId: userId,
      });
      await ctx.db.patch(settingsId, { publishedSnapshotId: snapshotId });
      return { orgId };
    });

    const published = await t.run((ctx) => getPublishedSnapshotData(ctx, orgId));
    expect(published?.financeCompany).toBeNull();
  });
});
