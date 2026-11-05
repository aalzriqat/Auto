/**
 * SCRUM-902 (SCRUM-886 / ACC-10 class, OWASP A01:2021 / API3:2023). A SOURCED car's supplier entitlement equals its
 * acquisition cost, so the per-car supplier and sourcing readers are cost-derived. Each one needs view:cost_price as well
 * as view:finance (STATEMENT_PERMISSIONS), exactly like the supplier statement. ADR
 * docs/adr/2026-11-04-supplier-sourcing-readers-cost-permission.md. Test names are literal: the regression library binds
 * a scenario to one named test.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seed(tag: string, permissions: string[]) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S902 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "U" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Custom", permissions }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const supplierId = await t.run((ctx) =>
    ctx.db.insert("suppliers", {
      orgId, displayName: "Amman Importer Co", displayNameKey: "amman importer co", status: "ACTIVE", version: 1,
      origin: "MANUAL", createdBy: userId, createdAt: Date.now(), updatedBy: userId, updatedAt: Date.now(),
    })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `S902${tag}`.slice(0, 17), make: "Kia", model: "Sportage", year: 2023, mileage: 0, color: "White",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12500, status: "AVAILABLE",
      sourceType: "SOURCED", sourceCost: 9500, sourcedFromName: "Amman Importer Co", sourcedSupplierId: supplierId,
    })
  );
  const payableId = await t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId, vehicleId, sourcedFromName: "Amman Importer Co", supplierId, amountDue: 9500, currency: "JOD",
      status: "PENDING", createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const as = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  return { orgId, vehicleId, payableId, as };
}

const FINANCE_ONLY = ["view:finance", "manage:finance", "view:sales", "view:expenses"];
const BOTH = [...FINANCE_ONLY, "view:cost_price"];
const NAMES_COST = /view:cost_price/;

describe("SCRUM-902 sourcingPayables readers", () => {
  test("sourcingPayables.list: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("splist", FINANCE_ONLY);
    await expect(s.as.query(api.sourcingPayables.list, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("sourcingPayables.listBounded: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("spbnd", FINANCE_ONLY);
    await expect(s.as.query(api.sourcingPayables.listBounded, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("sourcingPayables.listPipeline: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("sppipe", FINANCE_ONLY);
    await expect(s.as.query(api.sourcingPayables.listPipeline, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("sourcingPayables.get: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("spget", FINANCE_ONLY);
    await expect(s.as.query(api.sourcingPayables.get, { orgId: s.orgId, payableId: s.payableId })).rejects.toThrow(NAMES_COST);
  });

  test("sourcingPayables readers: a role holding both view:finance and view:cost_price still reads (SCRUM-902 positive control)", async () => {
    const s = await seed("spboth", BOTH);
    expect(await s.as.query(api.sourcingPayables.list, { orgId: s.orgId })).toHaveLength(1);
    expect((await s.as.query(api.sourcingPayables.listBounded, { orgId: s.orgId })).items).toHaveLength(1);
    expect(await s.as.query(api.sourcingPayables.listPipeline, { orgId: s.orgId })).toHaveLength(1);
    expect((await s.as.query(api.sourcingPayables.get, { orgId: s.orgId, payableId: s.payableId }))?.amountDue).toBe(9500);
  });

  test("sourcingPayables readers: view:cost_price without view:finance is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("spcost", ["view:cost_price", "view:sales"]);
    await expect(s.as.query(api.sourcingPayables.list, { orgId: s.orgId })).rejects.toThrow(/view:finance/);
    await expect(s.as.query(api.sourcingPayables.listPipeline, { orgId: s.orgId })).rejects.toThrow(/view:finance/);
  });
});

describe("SCRUM-902 supplierReceivables readers", () => {
  test("supplierReceivables.list: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("srlist", FINANCE_ONLY);
    await expect(s.as.query(api.supplierReceivables.list, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("supplierReceivables.outstandingSummary: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("srsum", FINANCE_ONLY);
    await expect(s.as.query(api.supplierReceivables.outstandingSummary, { orgId: s.orgId })).rejects.toThrow(NAMES_COST);
  });
  test("supplierReceivables readers: a role holding both view:finance and view:cost_price still reads (SCRUM-902 positive control)", async () => {
    const s = await seed("srboth", BOTH);
    expect((await s.as.query(api.supplierReceivables.list, { orgId: s.orgId })).items).toEqual([]);
    expect(await s.as.query(api.supplierReceivables.outstandingSummary, { orgId: s.orgId })).toMatchObject({ complete: true });
  });
  test("supplierReceivables readers: view:cost_price without view:finance is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("srcost", ["view:cost_price"]);
    await expect(s.as.query(api.supplierReceivables.list, { orgId: s.orgId })).rejects.toThrow(/view:finance/);
    await expect(s.as.query(api.supplierReceivables.outstandingSummary, { orgId: s.orgId })).rejects.toThrow(/view:finance/);
  });
});

describe("SCRUM-902 sales.consignedSalePreview", () => {
  test("consignedSalePreview: a caller with view:finance but without view:cost_price gets null, not the supplier entitlement (SCRUM-902)", async () => {
    const s = await seed("cspno", FINANCE_ONLY);
    expect(await s.as.query(api.sales.consignedSalePreview, { orgId: s.orgId, vehicleId: s.vehicleId, salePrice: 12500 })).toBeNull();
  });
  test("consignedSalePreview: a caller with view:finance and view:cost_price still gets the preview (SCRUM-902 positive control)", async () => {
    const s = await seed("cspyes", BOTH);
    const preview = await s.as.query(api.sales.consignedSalePreview, { orgId: s.orgId, vehicleId: s.vehicleId, salePrice: 12500 });
    expect(preview).toMatchObject({ supplierName: "Amman Importer Co" });
  });
  test("consignedSalePreview: view:cost_price without any of expenses, reports or finance still gets null (SCRUM-902 negative control)", async () => {
    const s = await seed("cspcost", ["view:sales", "view:cost_price"]);
    expect(await s.as.query(api.sales.consignedSalePreview, { orgId: s.orgId, vehicleId: s.vehicleId, salePrice: 12500 })).toBeNull();
  });
});
