import { expect, test } from "vitest";
import type { FunctionArgs } from "convex/server";
import { seedDealNetProfit } from "../test-utils/dealNetProfitFixture";
import { api } from "./_generated/api";
import { figures } from "./dealListRow";
import type { QueryCtx } from "./_generated/server";

const modules = import.meta.glob("./**/*.ts");

/**
 * The Deals list's net-profit column is the deal cockpit's headline, served
 * per row, and it is gated on `view:cost_price` on the SERVER (SCRUM-902
 * c24475): a caller without it receives `null`, never 0 and never the figure.
 */
type Seeded = Awaited<ReturnType<typeof seedDealNetProfit>>;

const VARIANTS = [
  [false, "SOURCED"],
  [true, "SOURCED"],
  [false, "STOCK"],
  [true, "STOCK"],
] as const;

/** The row the Deals list shows for the seeded deal: the application on a financed deal, the sale on a cash one. */
function readRow(s: Seeded, financed: boolean) {
  return s.asOwner.query(api.dealListRow.figures, {
    orgId: s.orgId,
    deal: financed
      ? { kind: "APPLICATION", applicationId: s.applicationId }
      : { kind: "SALE", saleId: s.saleId },
  });
}

async function setPermissions(s: Seeded, permissions: string[]) {
  await s.t.run((ctx) => ctx.db.patch(s.roleId, { name: "Deal reader", isSystemOwnerRole: false, permissions }));
}

test.each(VARIANTS)(
  "deals list financed=%s %s: net profit is null without view:cost_price and the cockpit figure with it",
  async (financed, sourceType) => {
    const s = await seedDealNetProfit(modules, sourceType, financed);
    const base = ["view:sales", "view:finance", "view:commissions"];

    await setPermissions(s, [...base, "view:cost_price"]);
    const cockpit = await s.read();
    if (!cockpit?.available) throw new Error("Expected the cockpit to publish a net profit");
    const withCost = await readRow(s, financed);
    expect(withCost).toMatchObject({
      netProfitMinor: cockpit.amountMinor,
      netProfitReason: null,
      currency: "JOD",
    });

    await setPermissions(s, base);
    const withheld = await readRow(s, financed);
    expect(withheld).toEqual({ ...withCost, netProfitMinor: null, netProfitReason: "CostAccessRequired" });
    // Not on the wire in any field: the figure, its operands, or a zero in its place.
    const wire = JSON.stringify(withheld);
    expect(wire).not.toContain(String(cockpit.amountMinor));
    expect(wire).not.toContain("9900");
  }
);

test.each(VARIANTS)("deals list financed=%s %s: the owner reads the cockpit's figure", async (financed, sourceType) => {
  const s = await seedDealNetProfit(modules, sourceType, financed);
  const cockpit = await s.read();
  if (!cockpit?.available) throw new Error("Expected the cockpit to publish a net profit");
  expect(await readRow(s, financed)).toMatchObject({ netProfitMinor: cockpit.amountMinor, netProfitReason: null });
});

test.each(VARIANTS)(
  "deals list financed=%s %s: a sales-only caller sees the step but no money",
  async (financed, sourceType) => {
    const s = await seedDealNetProfit(modules, sourceType, financed);
    await setPermissions(s, ["view:sales"]);
    const row = await readRow(s, financed);
    const cockpit = financed
      ? await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: s.applicationId })
      : await s.asOwner.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(row).toEqual({
      photoUrl: null,
      consigned: cockpit?.vehicle?.consigned ?? null,
      stages: cockpit?.stages.map(({ key, state }) => ({ key, state })) ?? [],
      sellingPriceMinor: null,
      sellingPriceReason: financed ? "FinanceAccessRequired" : null,
      netProfitMinor: null,
      netProfitReason: "CostAccessRequired",
      currency: null,
    });
    // A financed price is the cockpit's, served with finance access only; a sale's is on its list row.
    expect(row?.sellingPriceReason).toBe(financed ? "FinanceAccessRequired" : null);
    expect(row?.stages.length).toBeGreaterThan(0);
    // No vehicle permission, no photo URL (the cockpit's own allowlist).
    expect(row?.photoUrl).toBeNull();
  }
);

test("deals list: the financed row's selling price is the cockpit's customer sale price", async () => {
  const s = await seedDealNetProfit(modules, "SOURCED", true);
  const overview = await s.asOwner.query(api.dealOverview.financedDealOverview, {
    orgId: s.orgId,
    applicationId: s.applicationId,
  });
  const row = await readRow(s, true);
  expect(row?.sellingPriceMinor).toBe(overview?.financialSummary?.customerSalePrice?.amountMinor ?? null);
  expect(row?.consigned).toBe(true);
});

test.each([false, true])("SCRUM-917 financed=%s: finance gate with cost access preserves the complete public response", async (financed) => {
  const s = await seedDealNetProfit(modules, "STOCK", financed);
  await setPermissions(s, ["view:sales", "view:cost_price"]);
  const cockpit = financed
    ? await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: s.applicationId })
    : await s.asOwner.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
  expect(await readRow(s, financed)).toEqual({
    photoUrl: null,
    consigned: cockpit?.vehicle?.consigned ?? null,
    stages: cockpit?.stages.map(({ key, state }) => ({ key, state })) ?? [],
    sellingPriceMinor: null,
    sellingPriceReason: financed ? "FinanceAccessRequired" : null,
    netProfitMinor: null,
    netProfitReason: "FinanceAccessRequired",
    currency: null,
  });
});

const unreadableRows = ([false, true] as const).flatMap((financed) =>
  (["foreign", "missing", "deleted"] as const).map((state) => ({ financed, state }))
);

test.each(unreadableRows)("SCRUM-917 financed=$financed $state: local ownership refuses before delegation", async ({ financed, state }) => {
  const s = await seedDealNetProfit(modules, "STOCK", financed);
  expect(await readRow(s, financed)).not.toBeNull();
  const args: FunctionArgs<typeof api.dealListRow.figures> = {
    orgId: s.orgId,
    deal: financed ? { kind: "APPLICATION", applicationId: s.applicationId } : { kind: "SALE", saleId: s.saleId },
  };
  await s.t.run(async (ctx) => {
    const id = financed ? s.applicationId : s.saleId;
    if (state === "missing") {
      // convex-test ids encode their table suffix. Normalize a never-issued id
      // and confirm absence, separately from deleting an existing fixture row.
      if (financed) {
        const applicationId = ctx.db.normalizeId("financeApplications", "99999financeApplications");
        if (applicationId === null) throw new Error("Missing application fixture id is invalid");
        expect(await ctx.db.get(applicationId)).toBeNull();
        args.deal = { kind: "APPLICATION", applicationId };
      } else {
        const saleId = ctx.db.normalizeId("sales", "99999sales");
        if (saleId === null) throw new Error("Missing sale fixture id is invalid");
        expect(await ctx.db.get(saleId)).toBeNull();
        args.deal = { kind: "SALE", saleId };
      }
    } else if (state === "foreign") {
      const orgId = await ctx.db.insert("organizations", { name: "Synthetic foreign row", createdAt: 1 });
      await ctx.db.patch(id, { orgId });
    } else if (state === "deleted" && !financed) {
      await ctx.db.patch(s.saleId, { isDeleted: true });
    } else {
      // Applications have no soft-delete field in the schema. Exercise an
      // actually deleted application, not a fabricated isDeleted property.
      await ctx.db.delete(id);
    }
  });
  // Full public wire response: foreign, missing and deleted are indistinguishable.
  expect(await s.asOwner.query(api.dealListRow.figures, args)).toBeNull();

  // Instrument the Convex query-dispatch boundary over the real authenticated
  // harness DB. Even if a downstream reader refuses today, this public wrapper
  // must refuse before delegating caller-supplied ids (TEN-1).
  const handler: unknown = Reflect.get(figures, "_handler");
  if (typeof handler !== "function") throw new Error("Registered figures handler unavailable");
  const invoke = handler as (ctx: QueryCtx, args: FunctionArgs<typeof api.dealListRow.figures>) => Promise<unknown>;
  let delegated = 0;
  const runQuery: QueryCtx["runQuery"] = async () => {
    delegated += 1;
    throw new Error("Unexpected downstream delegation");
  };
  expect(await s.asOwner.run((ctx) => invoke({ ...ctx, runQuery }, args))).toBeNull();
  expect(delegated).toBe(0);
});

test.each([false, true])("deals list financed=%s: a caller from another organization cannot read a row", async (financed) => {
  const s = await seedDealNetProfit(modules, "STOCK", financed);
  const foreign = await s.t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic other dealership", createdAt: 1 });
    const userId = await ctx.db.insert("users", { clerkId: "other-reader", email: "other@example.invalid" });
    const roleId = await ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ["view:sales", "view:finance", "view:cost_price"],
      isSystemOwnerRole: true,
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    return orgId;
  });
  const other = s.t.withIdentity({ subject: "other-reader" });
  const deal: FunctionArgs<typeof api.dealListRow.figures>["deal"] = financed
    ? { kind: "APPLICATION", applicationId: s.applicationId }
    : { kind: "SALE", saleId: s.saleId };
  // Its own org id with the first org's sale: not found, never the figures.
  expect(
    await other.query(api.dealListRow.figures, { orgId: foreign, deal })
  ).toBeNull();
  // The first org's id: refused by tenancy.
  await expect(
    other.query(api.dealListRow.figures, { orgId: s.orgId, deal })
  ).rejects.toThrow();
});

/**
 * SCRUM-761 records `deals-list-row-withholds-net-profit-without-view-cost-price`
 * and `deals-list-row-serves-the-cockpit-net-profit-with-view-cost-price`: every
 * variant (cash and financed, SOURCED and STOCK) in one named test each.
 */
test("scenario deals-list-row-withholds-net-profit: a role with view:sales and view:finance but no view:cost_price gets a null net profit with CostAccessRequired on every deal kind", async () => {
  for (const [financed, sourceType] of VARIANTS) {
    const s = await seedDealNetProfit(modules, sourceType, financed);
    await setPermissions(s, ["view:sales", "view:finance", "view:commissions"]);
    const row = await readRow(s, financed);
    expect(row, `financed=${financed} ${sourceType}`).toMatchObject({ netProfitMinor: null, netProfitReason: "CostAccessRequired" });
  }
});

test("scenario deals-list-row-serves-the-cockpit-net-profit: a role with view:cost_price reads exactly the cockpit's net profit on every deal kind", async () => {
  for (const [financed, sourceType] of VARIANTS) {
    const s = await seedDealNetProfit(modules, sourceType, financed);
    await setPermissions(s, ["view:sales", "view:finance", "view:commissions", "view:cost_price"]);
    const cockpit = await s.read();
    if (!cockpit?.available) throw new Error("Expected the cockpit to publish a net profit");
    expect(await readRow(s, financed), `financed=${financed} ${sourceType}`).toMatchObject({
      netProfitMinor: cockpit.amountMinor,
      netProfitReason: null,
    });
  }
});
