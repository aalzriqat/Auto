import { describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";

// Literal oracle, deliberately independent of the production census.
const TABLES = ["vehicleSupplierPayables", "vehicleSupplierReceivables", "supplierCostRecoveries",
  "supplierCostRecoveryReceipts", "openingPayablePayments", "vehicles", "vehicleOwnershipConversions",
  "financeApplications", "expenses", "vehicleEdits", "openingBalanceDrafts"] as const;
const scan = makeFunctionReference<"query">("supplierLaunchEvidence:scanPage");
const ZERO = { MISSING_SUPPLIER_ID: 0, MISSING_PAYEE_ID: 0, MISSING_BEARER_ID: 0, MISSING_SOURCE: 0 };
const unavailable = { status: "UNAVAILABLE", code: "SUPPLIER_EVIDENCE_UNAVAILABLE" };

async function fixture(identified: boolean) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run(ctx => ctx.db.insert("organizations", { name: "PRIVATE TENANT", createdAt: 1 }));
  const userId = await t.run(ctx => ctx.db.insert("users", { clerkId: "p7", email: "p7@example.test", name: "PRIVATE USER" }));
  const supplierId = await seedSupplier(t, { orgId, userId, displayName: "PRIVATE SUPPLIER" });
  const identity = identified ? { supplierId } : {};
  const vehicleId = await t.run(ctx => ctx.db.insert("vehicles", { orgId, vin: "P7", make: "Toyota",
    model: "Camry", year: 2024, mileage: 0, color: "White", fuelType: "Gas", transmission: "Auto",
    sellingPrice: 100, status: "AVAILABLE", sourceType: "SOURCED", sourcedFromName: "PRIVATE SUPPLIER",
    ...(identified ? { sourcedSupplierId: supplierId } : {}) }));
  const customerId = await t.run(ctx => ctx.db.insert("customers", { orgId, firstName: "PRIVATE", lastName: "CUSTOMER" }));
  const saleId = await t.run(ctx => ctx.db.insert("sales", { orgId, vehicleId, customerId,
    salespersonId: userId, salePrice: 100, saleDate: 1, status: "COMPLETED" }));
  const accountId = await t.run(ctx => ctx.db.insert("chartOfAccounts", { orgId, code: "P7",
    name: "PRIVATE ACCOUNT", type: "LIABILITY", normalBalance: "CREDIT", active: true,
    isControlAccount: false, allowManualPosting: true, createdAt: 1, updatedAt: 1 }));
  const draftId = await t.run(ctx => ctx.db.insert("openingBalanceDrafts", { orgId, status: "POSTED",
    lines: [], asOfDate: 1, createdBy: userId, createdAt: 1, allocations: [{ kind: "SUPPLIER_PAYABLE",
      rowKey: "P7", accountId, amountMinor: 100, counterpartyName: "PRIVATE SUPPLIER", title: "PRIVATE", ...identity }] }));
  const payableId = await t.run(ctx => ctx.db.insert("vehicleSupplierPayables", { orgId, origin: "OPENING",
    openingBalanceDraftId: draftId, openingRowKey: "P7", openingKind: "SUPPLIER_PAYABLE", title: "PRIVATE",
    sourcedFromName: "PRIVATE SUPPLIER", amountDue: 100, currency: "JOD", status: "PAID",
    createdBy: userId, createdAt: 1, updatedAt: 1, ...identity }));
  const receivableId = await t.run(ctx => ctx.db.insert("vehicleSupplierReceivables", { orgId, vehicleId,
    saleId, sourcedFromName: "PRIVATE SUPPLIER", amountDue: 100, currency: "JOD", status: "OPEN",
    createdBy: userId, createdAt: 1, updatedAt: 1, ...identity }));
  const expenseId = await t.run(ctx => ctx.db.insert("expenses", { orgId, vehicleId, title: "PRIVATE",
    amount: 100, date: 1, category: "MAINTENANCE", costBearer: "SUPPLIER", vendor: "PRIVATE GARAGE",
    ...(identified ? { vendorSupplierId: supplierId, costBearerSupplierId: supplierId } : {}) }));
  const recoveryId = await t.run(ctx => ctx.db.insert("supplierCostRecoveries", { orgId, vehicleId, expenseId,
    origin: "EXPENSE", sourceEventKey: "P7", sourcedFromName: "PRIVATE SUPPLIER", amountDueMinor: 100,
    amountRecoveredMinor: 100, currency: "JOD", receiptSeq: 1, status: "RECOVERED",
    createdBy: userId, createdAt: 1, updatedAt: 1, ...identity }));
  const receiptId = await t.run(ctx => ctx.db.insert("supplierCostRecoveryReceipts", { orgId, vehicleId,
    recoveryId, seq: 1, amountMinor: 100, currency: "JOD", method: "CASH", receivedDate: 1,
    idempotencyKey: "KEY_1", status: "LIVE", createdBy: userId, createdAt: 1 }));
  await t.run(ctx => ctx.db.insert("openingPayablePayments", { orgId, payableId, seq: 1,
    openingBalanceDraftId: draftId, openingRowKey: "P7", amountMinor: 100, currency: "JOD",
    method: "CASH", occurredAt: 1, actorId: userId, commandKey: "KEY_1", operation: "markPaid", status: "LIVE" }));
  await t.run(ctx => ctx.db.insert("vehicleOwnershipConversions", { orgId, vehicleId,
    fromSourceType: "SOURCED", toSourceType: "STOCK", supplierName: "PRIVATE SUPPLIER",
    convertedBy: userId, convertedAt: 1, ...identity }));
  const editId = await t.run(ctx => ctx.db.insert("vehicleEdits", { orgId, requestedBy: userId, type: "CREATE",
    status: "PENDING", createdAt: 1, payload: { sourceType: "STOCK", purchasePaymentMethod: "ON_ACCOUNT",
      purchaseSupplierName: "PRIVATE SUPPLIER", ...(identified ? { purchaseSupplierId: supplierId } : {}) } }));
  const quoteId = await t.run(ctx => ctx.db.insert("quotes", { orgId, customerId, vehicleId, vehiclePrice: 100,
    downPayment: 0, termMonths: 1, status: "DRAFT", createdBy: userId, createdAt: 1 }));
  await t.run(ctx => ctx.db.insert("financeApplications", { orgId, quoteId, customerId, vehicleId,
    salespersonId: userId, status: "CLOSED", createdAt: 1, updatedAt: 1,
    supplierGapBasis: { contractEntitlementMinor: 100, currency: "JOD", supplierName: "PRIVATE SUPPLIER", ...identity } }));
  return { t, orgId, userId, supplierId, vehicleId, payableId, receivableId, expenseId, recoveryId, receiptId, editId, draftId };
}

async function assertMissingIdentity(table: typeof TABLES[number]) {
    const w = await fixture(false);
    const counts = { ...ZERO, MISSING_SUPPLIER_ID: 1 };
    if (table === "expenses") Object.assign(counts, { MISSING_SUPPLIER_ID: 0, MISSING_PAYEE_ID: 1, MISSING_BEARER_ID: 1 });
    expect(await w.t.query(scan, { table, cursor: null })).toEqual({ status: "READY", cursor: null, examined: 1, counts });
}

describe("supplier launch evidence", () => {
  test.each(["missing", "foreign", "deleted"])("dead pending %s edit is exempt and approval refuses without writes", async mode => {
    const w = await fixture(true);
    await w.t.run(async ctx => {
      const roleId = await ctx.db.insert("roles", { orgId: w.orgId, name: "OWNER", permissions: ALL_PERMISSIONS });
      await ctx.db.insert("memberships", { orgId: w.orgId, userId: w.userId, roleId });
      await ctx.db.patch(w.editId, { type: "UPDATE", vehicleId: w.vehicleId,
        payload: { sourcedFromName: "Unbound supplier", sourceCost: 100 } });
      if (mode === "missing") await ctx.db.delete(w.vehicleId);
      if (mode === "deleted") await ctx.db.patch(w.vehicleId, { isDeleted: true });
      if (mode === "foreign") {
        const orgId = await ctx.db.insert("organizations", { name: "Other", createdAt: 1 });
        await ctx.db.patch(w.vehicleId, { orgId });
      }
    });
    const before = await w.t.run(async ctx => Promise.all(TABLES.map(table => ctx.db.query(table).collect())));
    await expect(w.t.withIdentity({ subject: "p7" }).mutation(api.vehicleEdits.resolve,
      { orgId: w.orgId, requestId: w.editId, status: "APPROVED" })).rejects.toThrow("Vehicle not found.");
    expect(await w.t.run(async ctx => Promise.all(TABLES.map(table => ctx.db.query(table).collect())))).toEqual(before);
    expect(await w.t.query(scan, { table: "vehicleEdits", cursor: null })).toEqual({ status: "READY", cursor: null, examined: 1, counts: ZERO });
  });

  // SCRUM-761 requires one literal, non-parameterized registration per scenario.
  test("launch payable without identity counts one", async () => { await assertMissingIdentity("vehicleSupplierPayables"); });
  test("launch receivable without identity counts one", async () => { await assertMissingIdentity("vehicleSupplierReceivables"); });
  test("launch recovery without identity counts one", async () => { await assertMissingIdentity("supplierCostRecoveries"); });
  test("launch recovery receipt without parent identity counts one", async () => { await assertMissingIdentity("supplierCostRecoveryReceipts"); });
  test("launch opening payment without parent identity counts one", async () => { await assertMissingIdentity("openingPayablePayments"); });
  test("launch consignment without identity counts one", async () => { await assertMissingIdentity("vehicles"); });
  test("launch conversion without identity counts one", async () => { await assertMissingIdentity("vehicleOwnershipConversions"); });
  test("launch concession basis without identity counts one", async () => { await assertMissingIdentity("financeApplications"); });
  test("launch supplier expense without payee and bearer counts both", async () => { await assertMissingIdentity("expenses"); });
  test("launch pending on-account intake without identity counts one", async () => { await assertMissingIdentity("vehicleEdits"); });
  test("launch supplier opening allocation without identity counts one", async () => { await assertMissingIdentity("openingBalanceDrafts"); });

  test("fully identified tenant returns exact zero evidence for all eleven tables without writes", async () => {
    const w = await fixture(true);
    const before = await w.t.run(async ctx => Promise.all(TABLES.map(table => ctx.db.query(table).collect())));
    for (const table of TABLES) {
      expect(await w.t.query(scan, { table, cursor: null })).toEqual({ status: "READY", cursor: null, examined: 1, counts: ZERO });
    }
    expect(await w.t.run(async ctx => Promise.all(TABLES.map(table => ctx.db.query(table).collect())))).toEqual(before);
  });

  test("ordinary creditor and showroom vendor stay exempt while supplier openings do not", async () => {
    const w = await fixture(false);
    await w.t.run(async ctx => {
      await ctx.db.patch(w.payableId, { openingKind: "OTHER_PAYABLE" });
      await ctx.db.patch(w.expenseId, { costBearer: "SHOWROOM" });
      await ctx.db.patch(w.draftId, { allocations: [{ kind: "OTHER_PAYABLE", rowKey: "P7",
        accountId: (await ctx.db.query("chartOfAccounts").first())!._id,
        amountMinor: 100, counterpartyName: "Ordinary creditor", title: "PRIVATE" }] });
    });
    for (const table of ["vehicleSupplierPayables", "openingPayablePayments", "expenses", "openingBalanceDrafts"] as const) {
      expect(await w.t.query(scan, { table, cursor: null })).toEqual({ status: "READY", cursor: null, examined: 1, counts: ZERO });
    }
  });

  test("pending metadata update inherits identity but changed supplier text cannot", async () => {
    const w = await fixture(true);
    await w.t.run(ctx => ctx.db.patch(w.editId, { type: "UPDATE", vehicleId: w.vehicleId, payload: { notes: "metadata" } }));
    expect(await w.t.query(scan, { table: "vehicleEdits", cursor: null })).toEqual({ status: "READY", cursor: null, examined: 1, counts: ZERO });
    await w.t.run(ctx => ctx.db.patch(w.editId, { payload: { sourcedFromName: "Different party" } }));
    expect(await w.t.query(scan, { table: "vehicleEdits", cursor: null })).toEqual({ status: "READY", cursor: null, examined: 1,
      counts: { ...ZERO, MISSING_SUPPLIER_ID: 1 } });
    await w.t.run(ctx => ctx.db.delete(w.vehicleId));
    expect(await w.t.query(scan, { table: "vehicleEdits", cursor: null })).toEqual({ status: "READY", cursor: null, examined: 1, counts: ZERO });
  });
  test("pending supplier text without an ownership decision still needs identity", async () => {
    const w = await fixture(true);
    await w.t.run(ctx => ctx.db.patch(w.editId, { payload: { sourcedFromName: "PRIVATE SUPPLIER" } }));
    expect(await w.t.query(scan, { table: "vehicleEdits", cursor: null })).toEqual({ status: "READY", cursor: null,
      examined: 1, counts: { ...ZERO, MISSING_SUPPLIER_ID: 1 } });
  });

  test.each(["missing", "foreign"])("receipt with %s parent never yields a false zero", async mode => {
    const w = await fixture(true);
    await w.t.run(async ctx => {
      if (mode === "missing") await ctx.db.delete(w.recoveryId);
      else {
        const other = await ctx.db.insert("organizations", { name: "PRIVATE OTHER", createdAt: 1 });
        await ctx.db.patch(w.recoveryId, { orgId: other });
      }
    });
    expect(await w.t.query(scan, { table: "supplierCostRecoveryReceipts", cursor: null })).toEqual({ status: "READY", cursor: null,
      examined: 1, counts: { ...ZERO, MISSING_SOURCE: 1 } });
  });

  test("expense payee and bearer are counted independently", async () => {
    const w = await fixture(true);
    for (const field of ["vendorSupplierId", "costBearerSupplierId"] as const) {
      await w.t.run(ctx => ctx.db.patch(w.expenseId, { vendorSupplierId: w.supplierId,
        costBearerSupplierId: w.supplierId, [field]: undefined }));
      expect(await w.t.query(scan, { table: "expenses", cursor: null })).toEqual({ status: "READY", cursor: null,
        examined: 1, counts: { ...ZERO, MISSING_PAYEE_ID: field === "vendorSupplierId" ? 1 : 0,
          MISSING_BEARER_ID: field === "costBearerSupplierId" ? 1 : 0 } });
    }
  });

  test("non-supplier history and resolved requests do not create false positives", async () => {
    const w = await fixture(false);
    await w.t.run(async ctx => {
      await ctx.db.patch(w.vehicleId, { sourceType: "STOCK", sourcedFromName: undefined });
      const conversion = await ctx.db.query("vehicleOwnershipConversions").first();
      const app = await ctx.db.query("financeApplications").first();
      if (!conversion || !app) throw new Error("Fixture missing");
      await ctx.db.patch(conversion._id, { fromSourceType: "STOCK", toSourceType: "SOURCED", supplierName: undefined });
      await ctx.db.patch(app._id, { supplierGapBasis: undefined });
      await ctx.db.patch(w.editId, { status: "REJECTED" });
    });
    for (const table of ["vehicles", "vehicleOwnershipConversions", "financeApplications", "vehicleEdits"] as const) {
      expect(await w.t.query(scan, { table, cursor: null })).toEqual({ status: "READY", cursor: null, examined: 1, counts: ZERO });
    }
  });

  test("opening payment with an absent payable counts its missing source", async () => {
    const w = await fixture(true);
    await w.t.run(ctx => ctx.db.delete(w.payableId));
    expect(await w.t.query(scan, { table: "openingPayablePayments", cursor: null })).toEqual({ status: "READY",
      cursor: null, examined: 1, counts: { ...ZERO, MISSING_SOURCE: 1 } });
  });

  test("walks beyond the first bounded page instead of declaring a truncated zero", async () => {
    const w = await fixture(true);
    await w.t.run(async ctx => {
      for (let n = 0; n < 1000; n += 1) {
        await ctx.db.insert("vehicleOwnershipConversions", { orgId: w.orgId, vehicleId: w.vehicleId,
          fromSourceType: "SOURCED", toSourceType: "STOCK", convertedBy: w.userId, convertedAt: n });
      }
    });
    const first = await w.t.query(scan, { table: "vehicleOwnershipConversions", cursor: null });
    expect(first).toEqual({ status: "MORE", cursor: expect.any(String), examined: 1000, counts: { ...ZERO, MISSING_SUPPLIER_ID: 999 } });
    expect(await w.t.query(scan, { table: "vehicleOwnershipConversions", cursor: first.cursor })).toEqual({ status: "READY",
      cursor: null, examined: 1, counts: { ...ZERO, MISSING_SUPPLIER_ID: 1 } });
  });

  test("unreadable cursor returns coded unavailable without partial counts", async () => {
    const w = await fixture(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { expect(await w.t.query(scan, { table: "vehicles", cursor: "invalid" })).toEqual(unavailable); }
    finally { log.mockRestore(); }
  });
  test("a native byte-budget split is unavailable rather than an incomplete count", async () => {
    const w = await fixture(true);
    await w.t.run(async ctx => {
      for (let n = 0; n < 8; n += 1) await ctx.db.insert("vehicleOwnershipConversions", {
        orgId: w.orgId, vehicleId: w.vehicleId, fromSourceType: "SOURCED", toSourceType: "STOCK",
        convertedBy: w.userId, convertedAt: n, notes: "x".repeat(700_000),
      });
    });
    expect(await w.t.query(scan, { table: "vehicleOwnershipConversions", cursor: null })).toEqual(unavailable);
  });
});
