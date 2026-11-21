import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const userId = await t.run((ctx) => ctx.db.insert("users", {
    clerkId: "sale-reference-owner", email: "sale-reference@example.test", name: "Reference owner",
  }));
  const owner = t.withIdentity({ subject: "sale-reference-owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "QA TEST sale reference A" });
  const foreignOrgId = await owner.mutation(api.organizations.create, { name: "QA TEST sale reference B" });
  await owner.mutation(api.orgSettings.upsert, { orgId, currency: "JOD", currencySymbol: "JD" });
  const customerId = await owner.mutation(api.customers.create, { orgId, firstName: "QA TEST", lastName: "Reference buyer" });
  const vehicle = (ownerOrg: Id<"organizations">, vin: string, tradeIn = false) => t.run((ctx) => ctx.db.insert("vehicles", {
    orgId: ownerOrg, vin, make: "Toyota", model: "Corolla", year: 2024, mileage: 10,
    color: "White", fuelType: "Gasoline", transmission: "Automatic", sourceType: "STOCK",
    ...(tradeIn ? {} : { purchasePrice: 10_000 }), sellingPrice: 12_500, status: "AVAILABLE",
  }));
  const vehicleId = await vehicle(orgId, "QA-REFERENCE-SALE");
  const tradeInId = await vehicle(orgId, "QA-REFERENCE-OWN", true);
  const foreignTradeInId = await vehicle(foreignOrgId, "QA-REFERENCE-FOREIGN", true);
  const saleId = await owner.mutation(api.sales.createDraft, {
    orgId, vehicleId, customerId, salespersonId: userId, salePrice: 12_500,
    saleDate: Date.now(), financingType: "CASH", idempotencyKey: "sale-reference-draft",
  });
  const snapshot = () => t.run(async (ctx) => ({
    sales: await ctx.db.query("sales").collect(), vehicles: await ctx.db.query("vehicles").collect(),
    transactions: await ctx.db.query("transactions").collect(), notifications: await ctx.db.query("notifications").collect(),
    events: await ctx.db.query("accountingEvents").collect(), pending: await ctx.db.query("pendingAccountingEvents").collect(),
    deposits: await ctx.db.query("deposits").collect(), depositApplications: await ctx.db.query("depositApplications").collect(),
    depositVehicleHolds: await ctx.db.query("depositVehicleHolds").collect(),
    commercialDeals: await ctx.db.query("commercialDeals").collect(),
  }));
  // The cash pilot requires a fully paid sale. Use the existing opening-reservation
  // path so the stale completion would otherwise really post at the amended price.
  const fundDraft = (amount: number, identity = { customerId, vehicleId }) => t.run((ctx) => ctx.db.insert("deposits", {
    orgId, ...identity, amount, amountMinor: amount * 1000, currency: "JOD", status: "HELD",
    holdActive: false, usesVehicleHoldRows: false, createdBy: userId, createdAt: Date.now(),
    origin: "OPENING", openingRowKey: "sale-reference-opening", openingDepositKind: "RESERVATION",
  }));
  return { t, owner, orgId, saleId, tradeInId, foreignTradeInId, snapshot, fundDraft };
}

describe("SCRUM-811 sale update owns trade-in metadata before persisting it", () => {
  test.each(["foreign", "missing", "deleted"] as const)("refuses a %s trade-in and leaves the constructed state unchanged", async (kind) => {
    const f = await fixture();
    let tradeInVehicleId = f.foreignTradeInId;
    if (kind === "missing") {
      tradeInVehicleId = f.tradeInId;
      await f.t.run((ctx) => ctx.db.delete(tradeInVehicleId));
    } else if (kind === "deleted") {
      tradeInVehicleId = f.tradeInId;
      await f.t.run((ctx) => ctx.db.patch(tradeInVehicleId, { isDeleted: true }));
    }
    const before = await f.snapshot();
    let refusal: unknown;
    try {
      await f.owner.mutation(api.sales.update, {
        orgId: f.orgId, saleId: f.saleId, tradeInVehicleId, tradeInValue: 0,
      });
    } catch (error) {
      refusal = error;
    }
    // Read back even if the mutation accepted: the red report must demonstrate
    // the persisted reference, not merely an unexpected resolved promise.
    const after = await f.snapshot();
    if (refusal === undefined) {
      expect(after.sales.find((row) => row._id === f.saleId)?.tradeInVehicleId).toBe(tradeInVehicleId);
    }
    expect(after).toEqual(before);
    expect(refusal).toBeInstanceOf(ConvexError);
    if (!(refusal instanceof ConvexError)) throw new Error("The sale update did not return the expected reference refusal.");
    expect(refusal.data).toBe("Trade-in vehicle not found in this organization.");
  });

  test("accepts a live same-org reference on a pending draft without moving money", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await f.owner.mutation(api.sales.update, { orgId: f.orgId, saleId: f.saleId, tradeInVehicleId: f.tradeInId, tradeInValue: 0 });
    const after = await f.snapshot();
    expect(await f.owner.query(api.sales.get, { orgId: f.orgId, saleId: f.saleId }))
      .toMatchObject({ status: "PENDING", tradeInVehicleId: f.tradeInId, tradeInValue: 0 });
    expect(after.vehicles).toEqual(before.vehicles);
    expect(after.transactions).toEqual(before.transactions);
    expect(after.events).toEqual(before.events);
    expect(after.pending).toEqual(before.pending);
  });
});

describe("SCRUM-966 cash draft corrections", () => {
  test("corrects the buyer and vehicle of an unposted cash draft under the same deal number", async () => {
    const f = await fixture();
    const replacementBuyer = await f.owner.mutation(api.customers.create, {
      orgId: f.orgId, firstName: "QA TEST", lastName: "Replacement buyer",
    });
    await f.t.run((ctx) => ctx.db.patch(f.tradeInId, { purchasePrice: 10_000 }));
    const originalCustomerCredit = await f.fundDraft(500);
    await f.t.run((ctx) => ctx.db.patch(originalCustomerCredit, { vehicleId: undefined }));
    const before = await f.snapshot();
    const original = before.sales[0];
    const correction = {
      orgId: f.orgId, saleId: f.saleId,
      draftCorrection: {
        expectedRevision: 0, reason: "Replace the buyer and vehicle before completion",
        customerId: replacementBuyer, vehicleId: f.tradeInId,
      },
    };
    await f.owner.mutation(api.sales.update, correction);
    await expect(f.owner.mutation(api.sales.update, correction)).rejects.toThrow(/changed since/i);
    const after = await f.snapshot();
    expect(after.sales).toMatchObject([{
      _id: f.saleId, dealId: original.dealId, dealNumber: original.dealNumber, status: "PENDING",
      customerId: replacementBuyer, vehicleId: f.tradeInId, draftRevision: 1,
    }]);
    expect(after.vehicles).toEqual(before.vehicles);
    expect(after.transactions).toEqual(before.transactions);
    expect(after.events).toEqual(before.events);
    expect(after.deposits).toEqual(before.deposits);
    expect(after.commercialDeals).toEqual(before.commercialDeals);
    const history = await f.t.run(async (ctx) => (await ctx.db.query("adminAuditLog")
      .withIndex("by_org", (q) => q.eq("orgId", f.orgId)).collect())
      .filter((entry) => entry.targetId === f.saleId && entry.action === "CORRECT_CASH_DRAFT_TERMS"));
    expect(history).toMatchObject([{
      before: { customerId: original.customerId, vehicleId: original.vehicleId },
      after: { customerId: replacementBuyer, vehicleId: f.tradeInId },
    }]);

    const completion = { orgId: f.orgId, saleId: f.saleId, idempotencyKey: "complete-corrected-identities" };
    await f.fundDraft(original.salePrice, { customerId: replacementBuyer, vehicleId: f.tradeInId });
    await expect(f.owner.mutation(api.sales.completeDraft, { ...completion, expectedDraftRevision: 0 }))
      .rejects.toThrow(/changed since/i);
    await expect(f.owner.mutation(api.sales.completeDraft, { ...completion, expectedDraftRevision: 1 }))
      .resolves.toBe(f.saleId);
    const completed = await f.snapshot();
    expect(completed.sales).toMatchObject([{
      _id: f.saleId, status: "COMPLETED", dealId: original.dealId, dealNumber: original.dealNumber,
      customerId: replacementBuyer, vehicleId: f.tradeInId,
    }]);
    expect(completed.depositApplications).toMatchObject([
      { saleId: f.saleId, customerId: replacementBuyer, vehicleId: f.tradeInId },
    ]);
    expect(completed.deposits.find((row) => row._id === originalCustomerCredit)).toMatchObject({
      customerId: original.customerId, status: "HELD",
    });
    expect(completed.vehicles.find((row) => row._id === original.vehicleId)?.status).toBe("AVAILABLE");
    expect(completed.vehicles.find((row) => row._id === f.tradeInId)?.status).toBe("SOLD");
  });

  test.each(["RESERVATION", "SECURITY"] as const)("refuses a foreign replacement and preserves an opening %s deposit on the original vehicle", async (kind) => {
    const f = await fixture();
    const correction = { orgId: f.orgId, saleId: f.saleId };
    const metadata = { expectedRevision: 0, reason: "Correct the pending vehicle" };
    await expect(f.owner.mutation(api.sales.update, {
      ...correction, draftCorrection: { ...metadata, vehicleId: f.foreignTradeInId },
    })).rejects.toThrow(/not found/i);
    const depositId = await f.fundDraft(200);
    await f.t.run((ctx) => ctx.db.patch(depositId, { openingDepositKind: kind }));
    const before = await f.snapshot();
    await expect(f.owner.mutation(api.sales.update, {
      ...correction, draftCorrection: { ...metadata, vehicleId: f.tradeInId },
    })).rejects.toThrow(/deposit on the original vehicle/i);
    expect(await f.snapshot()).toEqual(before);
  });

  test.each(["held receipt", "legacy held receipt", "active split hold"] as const)("preserves an original %s during identity corrections", async (depositSource) => {
    const f = await fixture();
    const initial = (await f.snapshot()).sales[0];
    const replacementBuyer = await f.owner.mutation(api.customers.create, {
      orgId: f.orgId, firstName: "QA TEST", lastName: "Replacement buyer",
    });
    const depositId = await f.fundDraft(200);
    await f.t.run(async (ctx) => {
      const split = depositSource === "active split hold";
      await ctx.db.patch(depositId, {
        origin: undefined, openingRowKey: undefined, openingDepositKind: undefined,
        method: "CASH", holdActive: split,
        usesVehicleHoldRows: depositSource === "legacy held receipt" ? undefined : split,
        ...(depositSource === "held receipt" ? { isDeleted: false } : {}),
        ...(split ? { vehicleId: f.tradeInId } : {}),
      });
      if (split) {
        await ctx.db.insert("depositVehicleHolds", {
          orgId: f.orgId, depositId, vehicleId: initial.vehicleId, active: true, createdAt: Date.now(),
        });
      }
    });
    const before = await f.snapshot();
    for (const changed of [
      { customerId: replacementBuyer },
      { vehicleId: f.tradeInId },
      { customerId: replacementBuyer, vehicleId: f.tradeInId },
    ]) {
      await expect(f.owner.mutation(api.sales.update, {
        orgId: f.orgId, saleId: f.saleId,
        draftCorrection: { ...changed, expectedRevision: 0, reason: "Correct the pending agreement" },
      })).rejects.toThrow(/deposit on the original vehicle/i);
    }
    expect(await f.snapshot()).toEqual(before);
  });

  test("keeps a legacy split deposit with its active vehicle rather than its recorded primary vehicle", async () => {
    const f = await fixture();
    const replacementBuyer = await f.owner.mutation(api.customers.create, {
      orgId: f.orgId, firstName: "QA TEST", lastName: "Replacement buyer",
    });
    const depositId = await f.fundDraft(200);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(depositId, {
        origin: undefined, openingRowKey: undefined, openingDepositKind: undefined,
        method: "CASH", holdActive: true, usesVehicleHoldRows: undefined,
      });
      await ctx.db.insert("depositVehicleHolds", {
        orgId: f.orgId, depositId, vehicleId: f.tradeInId, active: true, createdAt: Date.now(),
      });
    });
    const before = await f.snapshot();
    await f.owner.mutation(api.sales.update, {
      orgId: f.orgId, saleId: f.saleId,
      draftCorrection: { customerId: replacementBuyer, expectedRevision: 0, reason: "Correct the draft buyer" },
    });
    const after = await f.snapshot();
    expect(after.sales[0]).toMatchObject({ _id: f.saleId, customerId: replacementBuyer, draftRevision: 1 });
    expect(after.deposits).toEqual(before.deposits);
    expect(after.depositVehicleHolds).toEqual(before.depositVehicleHolds);
  });

  test("saves corrected terms under the same draft identity with one audit entry", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const correction = {
      orgId: f.orgId,
      saleId: f.saleId,
      salePrice: 13_000,
      draftCorrection: { expectedRevision: 0, reason: "Correct the agreed cash price" },
    };

    await f.owner.mutation(api.sales.update, correction);
    await expect(f.owner.mutation(api.sales.update, correction)).rejects.toThrow(/changed since/i);

    const after = await f.snapshot();
    expect(after.sales).toMatchObject([{ _id: f.saleId, status: "PENDING", salePrice: 13_000, draftRevision: 1 }]);
    expect(after.sales[0]?.dealNumber).toBe(before.sales[0]?.dealNumber);
    expect(after.vehicles).toEqual(before.vehicles);
    expect(after.transactions).toEqual(before.transactions);
    expect(after.events).toEqual(before.events);
    expect(after.pending).toEqual(before.pending);

    const history = await f.t.run(async (ctx) => (await ctx.db.query("adminAuditLog")
      .withIndex("by_org", (q) => q.eq("orgId", f.orgId)).collect())
      .filter((entry) => entry.targetId === f.saleId && entry.action === "CORRECT_CASH_DRAFT_TERMS"));
    expect(history).toMatchObject([{
      targetId: f.saleId,
      before: { salePrice: 12_500, draftRevision: 0 },
      after: { salePrice: 13_000, draftRevision: 1, reason: "Correct the agreed cash price" },
    }]);
  });

  test("refuses an old correction after another editor changes the pending sale", async () => {
    const f = await fixture();
    await f.owner.mutation(api.sales.update, {
      orgId: f.orgId, saleId: f.saleId, salePrice: 13_000, expectedDraftRevision: 0,
    });
    const edited = await f.snapshot();

    await expect(f.owner.mutation(api.sales.update, {
      orgId: f.orgId,
      saleId: f.saleId,
      salePrice: 14_000,
      draftCorrection: { expectedRevision: 0, reason: "Submit the earlier edit" },
    })).rejects.toThrow(/changed since/i);

    expect(await f.snapshot()).toEqual(edited);
  });

  test("requires the displayed revision for a price change from the ordinary sale editor", async () => {
    const f = await fixture();
    const change = { orgId: f.orgId, saleId: f.saleId, salePrice: 13_000 };
    await expect(f.owner.mutation(api.sales.update, change)).rejects.toThrow(/changed since/i);
    expect((await f.snapshot()).sales[0]?.salePrice).toBe(12_500);
  });

  test("refuses stale or omitted draft revisions when a correction lands before completion", async () => {
    const f = await fixture();
    const sale = { orgId: f.orgId, saleId: f.saleId };
    await f.owner.mutation(api.sales.update, { ...sale, salePrice: 12_500, expectedDraftRevision: 0 });
    await f.owner.mutation(api.sales.update, {
      ...sale, salePrice: 13_000,
      draftCorrection: { expectedRevision: 0, reason: "Correct the agreed cash price" },
    });
    await f.fundDraft(13_000);
    const corrected = await f.snapshot();
    const completion = { ...sale, idempotencyKey: "complete-corrected-draft" };

    await expect(f.owner.mutation(api.sales.completeDraft, completion)).rejects.toThrow(/changed since/i);
    const stale = { ...completion, expectedDraftRevision: 0 };
    await expect(f.owner.mutation(api.sales.completeDraft, stale)).rejects.toThrow(/changed since/i);
    expect(await f.snapshot()).toEqual(corrected);
  });

  test("completes the revision returned by the editor and replays only that intent", async () => {
    const f = await fixture();
    const sale = { orgId: f.orgId, saleId: f.saleId };
    const edited = await f.owner.mutation(api.sales.update, {
      ...sale, salePrice: 13_000, expectedDraftRevision: 0,
    });
    expect(edited).toEqual({ draftRevision: 1 });
    await f.fundDraft(13_000);
    const completion = { ...sale, expectedDraftRevision: 1, idempotencyKey: "complete-reviewed-draft" };
    await expect(f.owner.mutation(api.sales.completeDraft, completion)).resolves.toBe(f.saleId);
    const completed = await f.snapshot();
    expect(completed.sales).toMatchObject([{ status: "COMPLETED", salePrice: 13_000 }]);
    expect(completed.depositApplications).toMatchObject([{ saleId: f.saleId, amountMinor: 13_000_000 }]);
    await expect(f.owner.mutation(api.sales.completeDraft, completion)).resolves.toBe(f.saleId);
    const differentRevision = { ...completion, expectedDraftRevision: 0 };
    await expect(f.owner.mutation(api.sales.completeDraft, differentRevision)).rejects.toThrow(/different request content/i);
    expect(await f.snapshot()).toEqual(completed);
  });

  test("leaves an older pending sale unchanged when it already has sale cashflow", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.insert("transactions", {
      orgId: f.orgId, saleId: f.saleId, type: "IN", amount: 12_500,
      date: Date.now(), category: "VEHICLE_SALE", description: "Historical sale cashflow",
    }));
    const before = await f.snapshot();

    await expect(f.owner.mutation(api.sales.update, {
      orgId: f.orgId, saleId: f.saleId, salePrice: 13_000,
      draftCorrection: { expectedRevision: 0, reason: "Historical correction" },
    })).rejects.toThrow(/accounting history/i);
    await expect(f.owner.mutation(api.sales.update, {
      orgId: f.orgId, saleId: f.saleId, salePrice: 13_000,
    })).rejects.toThrow(/accounting history/i);

    expect(await f.snapshot()).toEqual(before);
  });
});
