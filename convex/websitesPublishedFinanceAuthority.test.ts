import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { getPublishedSnapshotData } from "./websites";

const MODULES = import.meta.glob("./**/*.*s");

describe("published website finance authority", () => {
  test("NEGATIVE CONTROL: a legacy snapshot cannot turn unknown live execution fees into zero", async () => {
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
    expect(published?.financeCompany).toMatchObject({
      name: "Unknown Fee Lender",
      profitRate: 5,
    });
    expect(published?.financeCompany).not.toHaveProperty("adminFees");
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
});
