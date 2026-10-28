/**
 * SCRUM-85 / SCRUM-760 c23812 ruling 9 (owner, 2026-10-28):
 *
 *   "A denomination breakdown is NOT required. Currency code and scale must never
 *    be defaulted."
 *
 * Invariant: wherever money is computed, posted or displayed from an
 * organization's currency, the currency code comes from a value the organization
 * actually STORED. When there is none the call refuses with a typed error
 * (`CURRENCY_NOT_CONFIGURED`); it never falls back to "JOD" and it never
 * invents a row that stamps one.
 *
 * Seams under test (public interface only):
 *  - `configuredCurrencyOf` / `requireConfiguredCurrency` (convex/utils/money.ts)
 *  - the public mutations and queries that read the org currency
 *  - every public door that could CREATE an orgSettings row (the silent stamp)
 */
import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { configuredCurrencyOf, requireConfiguredCurrency } from "./utils/money";
import { DEFAULT_SETTINGS } from "./orgSettings";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

async function codeOf(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
    return undefined;
  } catch (error) {
    if (error instanceof ConvexError) {
      const data: unknown = error.data;
      if (typeof data === "object" && data !== null) {
        return (data as { code?: string }).code;
      }
      return typeof data === "string" ? `STRING:${data}` : undefined;
    }
    return `NOT_CONVEX_ERROR:${String(error)}`;
  }
}

/** An org with an owner, an accounting plan and NO orgSettings row at all. */
async function seedUnconfiguredOrg() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "No Currency Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "s85_owner", email: "s85@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: ["view:finance", "manage:finance", "approve:requests", "view:settings"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asOwner = t.withIdentity({ subject: "s85_owner", clerkId: "s85_owner" });
  return { t, orgId, asOwner };
}

async function settingsRows(
  t: Awaited<ReturnType<typeof seedUnconfiguredOrg>>["t"],
  orgId: Id<"organizations">
) {
  return await t.run((ctx) =>
    ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
}

describe("SCRUM-85 pure contract: a stored currency or nothing", () => {
  it("configuredCurrencyOf returns the stored code and null for every absent shape", () => {
    expect(configuredCurrencyOf({ currency: "JOD" })).toBe("JOD");
    expect(configuredCurrencyOf({ currency: "USD" })).toBe("USD");
    expect(configuredCurrencyOf(null)).toBeNull();
    expect(configuredCurrencyOf(undefined)).toBeNull();
    expect(configuredCurrencyOf({})).toBeNull();
    expect(configuredCurrencyOf({ currency: undefined })).toBeNull();
    expect(configuredCurrencyOf({ currency: "" })).toBeNull();
    expect(configuredCurrencyOf({ currency: "   " })).toBeNull();
  });

  it("requireConfiguredCurrency refuses with the typed code and never answers JOD", () => {
    for (const absent of [null, undefined, {}, { currency: "" }, { currency: "  " }]) {
      let thrown: unknown;
      try {
        requireConfiguredCurrency(absent);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConvexError);
      expect((thrown as ConvexError<{ code: string }>).data.code).toBe("CURRENCY_NOT_CONFIGURED");
    }
    expect(requireConfiguredCurrency({ currency: "EUR" })).toBe("EUR");
  });

  it("the shared settings defaults carry no currency or currency symbol", () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty("currency");
    expect(DEFAULT_SETTINGS).not.toHaveProperty("currencySymbol");
  });
});

describe("SCRUM-85 money paths refuse an org with no stored currency", () => {
  it("opening a cash drawer for an org with no settings row is refused and writes nothing", async () => {
    const { t, orgId, asOwner } = await seedUnconfiguredOrg();
    const code = await codeOf(asOwner.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 1000 }));
    expect(code).toBe("CURRENCY_NOT_CONFIGURED");
    const sessions = await t.run((ctx) => ctx.db.query("cashDrawerSessions").take(10));
    expect(sessions).toHaveLength(0);
  });

  it("a financial report for an org with no settings row refuses instead of labelling it JOD", async () => {
    const { orgId, asOwner } = await seedUnconfiguredOrg();
    const code = await codeOf(asOwner.query(api.accountingReports.trialBalance, { orgId }));
    expect(code).toBe("CURRENCY_NOT_CONFIGURED");
  });

  it("the VAT summary for an org with no settings row refuses instead of reporting a JOD zero", async () => {
    const { orgId, asOwner } = await seedUnconfiguredOrg();
    const code = await codeOf(asOwner.query(api.vatReport.generateVatSummary, { orgId }));
    expect(code).toBe("CURRENCY_NOT_CONFIGURED");
  });

  it("the role dashboard for an org with no settings row refuses instead of labelling amounts JOD", async () => {
    const { orgId, asOwner } = await seedUnconfiguredOrg();
    const code = await codeOf(asOwner.query(api.dashboard.todayForRole, { orgId }));
    expect(code).toBe("CURRENCY_NOT_CONFIGURED");
  });

  it("control: an org with a stored currency still opens a drawer in exactly that currency", async () => {
    const { t, orgId, asOwner } = await seedUnconfiguredOrg();
    await asOwner.mutation(api.orgSettings.upsert, { orgId, currency: "USD", currencySymbol: "$" });
    await asOwner.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 1000 });
    const sessions = await t.run((ctx) => ctx.db.query("cashDrawerSessions").take(10));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].currency).toBe("USD");
  });

  it("control: a stored JOD still works (the fix does not break a configured org)", async () => {
    const { t, orgId, asOwner } = await seedUnconfiguredOrg();
    await asOwner.mutation(api.orgSettings.upsert, { orgId, currency: "JOD", currencySymbol: "د.أ" });
    await asOwner.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 5000 });
    const sessions = await t.run((ctx) => ctx.db.query("cashDrawerSessions").take(10));
    expect(sessions.map((s) => s.currency)).toEqual(["JOD"]);
  });
});

describe("SCRUM-85 no door may silently stamp a currency into orgSettings", () => {
  it("saving unrelated settings (dealership name) does not choose a currency for the org", async () => {
    const { t, orgId, asOwner } = await seedUnconfiguredOrg();
    await asOwner.mutation(api.orgSettings.upsert, { orgId, dealershipName: "Bloom Test" });
    const rows = await settingsRows(t, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBeUndefined();
    expect(rows[0].currencySymbol).toBeUndefined();
    // and money still refuses afterwards
    expect(
      await codeOf(asOwner.mutation(api.cashDrawer.open, { orgId, openingFloatMinor: 1 }))
    ).toBe("CURRENCY_NOT_CONFIGURED");
  });

  it("choosing the commission mode does not choose a currency for the org", async () => {
    const { t, orgId, asOwner } = await seedUnconfiguredOrg();
    await asOwner.mutation(api.orgSettings.setCommissionMode, { orgId, commissionMode: "AUTO_MEMBER" });
    const rows = await settingsRows(t, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBeUndefined();
  });

  it("toggling lead auto-assignment does not choose a currency for the org", async () => {
    const { t, orgId, asOwner } = await seedUnconfiguredOrg();
    await asOwner.mutation(api.orgSettings.setGeneratedLeadAutoAssignmentEnabled, { orgId, enabled: true });
    const rows = await settingsRows(t, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBeUndefined();
  });

  it("disconnecting Facebook on an org with no settings row records the marker without a currency", async () => {
    const { t, orgId, asOwner } = await seedUnconfiguredOrg();
    await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });
    const rows = await settingsRows(t, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].facebookDisconnectedAt).toBeTypeOf("number");
    expect(rows[0].currency).toBeUndefined();
  });

  it("the public settings projection of a row with no currency exposes none (no JOD invented on read)", async () => {
    const { orgId, asOwner } = await seedUnconfiguredOrg();
    await asOwner.mutation(api.orgSettings.upsert, { orgId, dealershipName: "Bloom Test" });
    const settings = await asOwner.query(api.orgSettings.get, { orgId });
    expect(settings).not.toBeNull();
    expect(settings?.currency).toBeUndefined();
  });

  it("an owner who explicitly chooses a currency later gets exactly that one (no JOD residue)", async () => {
    const { t, orgId, asOwner } = await seedUnconfiguredOrg();
    await asOwner.mutation(api.orgSettings.setCommissionMode, { orgId, commissionMode: "AUTO_MEMBER" });
    await asOwner.mutation(api.orgSettings.upsert, { orgId, currency: "SAR", currencySymbol: "ر.س" });
    const rows = await settingsRows(t, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBe("SAR");
    expect(rows[0].currencySymbol).toBe("ر.س");
  });
});
