import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { RESET_TABLES_FOR_TEST } from "./orgFinancialReset";

/**
 * This deletes production rows with no undo, so the tests are about what it
 * must NOT touch at least as much as what it removes.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

function setup() {
  return convexTestWithComponents(schema, MODULES);
}

/** Seeds one org with a row in each of three reset tables plus protected rows. */
async function seedOrg(t: ReturnType<typeof setup>, name: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name, createdAt: Date.now() })
  );

  await t.run(async (ctx) => {
    await ctx.db.insert("chartOfAccounts", {
      orgId,
      code: "1000",
      name: "Cash",
      type: "ASSET" as const,
      normalBalance: "DEBIT" as const,
      isControlAccount: false,
      allowManualPosting: true,
      active: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("transactions", {
      orgId,
      type: "IN" as const,
      amount: 1000,
      date: Date.now(),
      category: "VEHICLE_SALE" as const,
      description: "sale",
    });
    await ctx.db.insert("expenses", {
      orgId,
      title: "Office supplies",
      amount: 50,
      date: Date.now(),
      category: "OTHER" as const,
    });

    // Protected: must survive the reset.
    await ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: "Corolla",
      year: 2020,
      vin: `VIN${name}`,
      mileage: 1000,
      color: "White",
      fuelType: "PETROL",
      transmission: "AUTOMATIC",
      sellingPrice: 10000,
      status: "SOLD" as const,
    });
    await ctx.db.insert("customers", { orgId, firstName: "Keep", lastName: "Me" });
  });

  return orgId;
}

async function countFor(
  t: ReturnType<typeof setup>,
  table: "chartOfAccounts" | "transactions" | "expenses" | "vehicles" | "customers",
  orgId: Id<"organizations">,
) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query(table)
      .filter((q) => q.eq(q.field("orgId"), orgId))
      .collect()
  );
  return rows.length;
}

describe("resetOrgFinancialData", () => {
  test("defaults to a dry run and destroys nothing", async () => {
    // The safe form has to be the default: a caller who forgets the flag gets
    // a report, not a deletion.
    const t = setup();
    const orgId = await seedOrg(t, "Dry Run Motors");

    const result = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
    });

    expect(result.dryRun).toBe(true);
    expect(result.orgName).toBe("Dry Run Motors");
    expect(result.total).toBe(3);
    expect(result.perTable).toEqual({ chartOfAccounts: 1, transactions: 1, expenses: 1 });

    // Everything still there.
    expect(await countFor(t, "chartOfAccounts", orgId)).toBe(1);
    expect(await countFor(t, "transactions", orgId)).toBe(1);
    expect(await countFor(t, "expenses", orgId)).toBe(1);
  });

  test("with dryRun false, removes the listed tables and nothing else", async () => {
    const t = setup();
    const orgId = await seedOrg(t, "Reset Motors");

    const result = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: false,
    });
    expect(result.total).toBe(3);
    expect(result.remaining).toBe(0);

    expect(await countFor(t, "chartOfAccounts", orgId)).toBe(0);
    expect(await countFor(t, "transactions", orgId)).toBe(0);
    expect(await countFor(t, "expenses", orgId)).toBe(0);

    // Inventory and CRM are explicitly out of scope.
    expect(await countFor(t, "vehicles", orgId)).toBe(1);
    expect(await countFor(t, "customers", orgId)).toBe(1);
  });

  test("never touches another organization's rows", async () => {
    // The failure that would matter most: a reset for one dealership reaching
    // into another's books.
    const t = setup();
    const target = await seedOrg(t, "Target Motors");
    const bystander = await seedOrg(t, "Bystander Motors");

    await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId: target,
      dryRun: false,
    });

    expect(await countFor(t, "chartOfAccounts", target)).toBe(0);
    expect(await countFor(t, "transactions", bystander)).toBe(1);
    expect(await countFor(t, "chartOfAccounts", bystander)).toBe(1);
    expect(await countFor(t, "expenses", bystander)).toBe(1);
  });

  test("leaves vehicle status alone, including SOLD with no sale behind it", async () => {
    // Accepted inconsistency, chosen deliberately — pinned so a later edit
    // cannot quietly start rewriting inventory.
    const t = setup();
    const orgId = await seedOrg(t, "Status Motors");

    await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: false,
    });

    const vehicles = await t.run((ctx) =>
      ctx.db
        .query("vehicles")
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .collect()
    );
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].status).toBe("SOLD");
  });

  test("deletes an appraisal's stored report rather than orphaning it", async () => {
    const t = setup();
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Blob Motors", createdAt: Date.now() })
    );
    const blobId = await t.run((ctx) => ctx.storage.store(new Blob(["appraisal.pdf"])));

    const appraisalId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "reset_u1", email: "u@x.com" });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: "VINRESET1", make: "Toyota", model: "Camry", year: 2024, mileage: 10,
        color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 20000,
        status: "AVAILABLE",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId, firstName: "Reset", lastName: "Customer",
      });
      const quoteId = await ctx.db.insert("quotes", {
        orgId, customerId, vehicleId, vehiclePrice: 20000, downPayment: 2000,
        termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
      });
      const applicationId = await ctx.db.insert("financeApplications", {
        orgId, quoteId, customerId, vehicleId, salespersonId: userId,
        status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      });
      return await ctx.db.insert("financeAppraisals", {
        orgId, applicationId, vehicleId, appraisalAmountMinor: 12_500_000,
        currency: "JOD", providerType: "FINANCE_COMPANY", appraisedAt: Date.now(),
        documentStorageIds: [blobId], isReappraisal: false, status: "APPROVED",
        recordedBy: userId, recordedAt: Date.now(),
      });
    });

    await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: false,
    });

    // An orphaned row is recoverable. A blob with nothing referencing it is
    // not enumerable, not deletable by any code path, and billed indefinitely —
    // and this one is the finance company's report on a customer's vehicle.
    expect(await t.run((ctx) => ctx.db.get(appraisalId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(blobId))).toBeNull();
  });

  test("a partial batch never deletes an application out from under its own fee rows", async () => {
    const t = setup();
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Batch Motors", createdAt: Date.now() })
    );

    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "reset_u2", email: "u2@x.com" });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: "VINRESET2", make: "Kia", model: "Rio", year: 2024, mileage: 10,
        color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 15000,
        status: "AVAILABLE",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId, firstName: "Batch", lastName: "Customer",
      });
      const quoteId = await ctx.db.insert("quotes", {
        orgId, customerId, vehicleId, vehiclePrice: 15000, downPayment: 1000,
        termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
      });
      const applicationId = await ctx.db.insert("financeApplications", {
        orgId, quoteId, customerId, vehicleId, salespersonId: userId,
        status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      });
      const fee = async (n: number) =>
        await ctx.db.insert("financeDealFees", {
          orgId, applicationId, feeType: "LICENSING", currency: "JOD",
          actualAmountMinor: n, paidBy: "DEALER", paidTo: "GOVERNMENT",
          accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
          includedInQuotation: false, deductedFromSettlement: false, refundable: false,
          source: "MANUAL", createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
        });
      return { applicationId, feeA: await fee(1000), feeB: await fee(2000) };
    });

    // One row per table per run. The batch limit applies to each table
    // separately, so without the deferral this clears one fee and then deletes
    // the application in the same pass — leaving the second fee pointing at an
    // applicationId that no longer resolves. Atomicity is no help: the whole
    // broken state commits together.
    const first = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId, dryRun: false, batchSize: 1,
    });
    expect(first.remaining).toBeGreaterThan(0);
    expect(await t.run((ctx) => ctx.db.get(ids.applicationId))).not.toBeNull();

    // Repeat until it settles; the parent goes only once the children are gone.
    for (let pass = 0; pass < 8; pass += 1) {
      await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
        orgId, dryRun: false, batchSize: 1,
      });
    }

    await t.run(async (ctx) => {
      expect(await ctx.db.get(ids.feeA)).toBeNull();
      expect(await ctx.db.get(ids.feeB)).toBeNull();
      expect(await ctx.db.get(ids.applicationId)).toBeNull();
    });
  });

  test("the signed-off scope excludes inventory, CRM, people and org config", async () => {
    // A guard on the constant itself. Adding a table here is a decision that
    // should fail this test and be made on purpose, not slipped in.
    const forbidden = [
      "vehicles",
      "vehicleValuations",
      "customers",
      "leads",
      "memberships",
      "roles",
      "orgSettings",
      "subscriptions",
      "branches",
      "bankAccounts",
      "financeCompanies",
      "orgValuationCompanies",
      "organizations",
    ];
    for (const table of forbidden) {
      expect(RESET_TABLES_FOR_TEST).not.toContain(table);
    }
    // 31 -> 33: `commitmentAuthorityAttempt` and `commitmentAuthorityWork` —
    // the deferred vehicle-authority settlement queue and its per-execution
    // attempt records (SCRUM-208 c15825). They are listed FIRST, ahead of
    // `pendingAccountingEvents`, because each references the one after it and
    // the reset is not one transaction.
    //
    // ⚠️ THIS OMISSION WAS FOUND BY A REVIEWER, NOT BY A GUARD. When the work
    // table was introduced, `orgDeletionCoverage.test.ts` failed because it had
    // no organization hard-delete step; that step was added and nobody asked
    // which OTHER destructive path had the same gap. This one did — a reset
    // clears the ledger but KEEPS the organization, so the leftover rows are
    // not obviously orphaned: they are live instructions to settle a car
    // against a reversal that the same reset just deleted.
    // `authorityLifecycleManifests.test.ts` now asserts the invariant across
    // both manifests rather than one at a time.
    //
    // 28 -> 31: `financeDealCustodyEntries`, `financeDealFees` and
    // `financeDealCustody` — a financed deal's itemized costs and the money an
    // employee is holding to pay them. All three are per-deal financial records
    // whose parent `financeApplications` the reset already clears, so leaving
    // them behind would orphan every cost line and every custody movement
    // against an application id that no longer resolves. `financeDealFees`
    // carries receipt attachments, which the storage sweep below handles, and
    // it is listed before `financeDealCustody` because its rows reference one.
    //
    // 26 -> 28: `financeAppraisals` and `financeApplicationOverrides` were added
    // deliberately. They are children of `financeApplications`, which the reset
    // already clears, so leaving them out orphaned every appraisal and every
    // money-change audit row against an application id that no longer resolves
    // — and, for appraisals, left `_storage` blobs with nothing referencing
    // them. They are listed immediately before their parent so a run that stops
    // between batches never leaves a child without one. The financeCompanies
    // row itself is still deliberately out of scope, as `forbidden` pins above.
    // 33 -> 36: `receiptApplications`, `receiptRetainedPositions` and
    // `receiptMovements` — SCRUM-218-C's receipt authority. Added on purpose,
    // which is what this guard asks for.
    //
    // The reset already clears `collectionPayments`, `canonicalPayments` and
    // `paymentAllocations`. Leaving these three behind would strand a customer's
    // RETAINED CREDIT: a live liability position, and the movement that created
    // it, pointing at payments and allocations that no longer exist — on an
    // otherwise fresh ledger. They are listed before the rows they reference so
    // a run that stops between batches never leaves a child without its parent.
    //
    // Found because the organization hard-delete guard failed for the same three
    // tables and this file's own constant warns, from a previous round, that
    // fixing the destructive path that fired without asking which OTHER one has
    // the same gap is how the second gap survives.
    expect(RESET_TABLES_FOR_TEST).toHaveLength(36);
  });
});

/**
 * SCRUM-208 R2 — A DESTRUCTIVE RESET MUST REFUSE, NOT PARTIALLY ORPHAN.
 * (Codex AF-208-02582-R2; Option C containment authorized in c15892.)
 *
 * Phase 3 added the authority lifecycle to this reset. Each table is batched
 * independently, so a partial pass could delete a `pendingAccountingEvents` row
 * while a `commitmentAuthorityWork` row referencing it survived — and
 * `performAuthoritySettlement` dereferences `work.pendingEventId` with a
 * non-null assertion, so the survivor throws on every dispatch, burns its retry
 * budget and records a false RETRY_EXHAUSTED.
 *
 * ⚠️ THE FIX REFUSES RATHER THAN REORDERING, DELIBERATELY. Work rows reference
 * pending events, deposits, sales, holds and vehicles at once; array order is
 * not a dependency proof, and a wrong guess on a destructive tool orphans money
 * records. A refusal costs an operator an error message.
 */
async function seedAuthorityLifecycle(t: ReturnType<typeof setup>, orgId: Id<"organizations">) {
  return await t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", {
      clerkId: `reset_auth_${orgId}`,
      email: "a@b.com",
      name: "Op",
    });
    const vehicle = (await ctx.db.query("vehicles").collect()).find(
      (v: any) => String(v.orgId) === String(orgId)
    );
    const customer = (await ctx.db.query("customers").collect()).find(
      (c: any) => String(c.orgId) === String(orgId)
    );
    const depositId = await ctx.db.insert("deposits", {
      orgId,
      vehicleId: vehicle._id,
      customerId: customer._id,
      amount: 1000,
      status: "HELD" as const,
      holdActive: true,
      usesVehicleHoldRows: false,
      createdBy: userId,
      createdAt: Date.now(),
    });
    const saleId = await ctx.db.insert("sales", {
      orgId,
      vehicleId: vehicle._id,
      customerId: customer._id,
      salespersonId: userId,
      salePrice: 10000,
      saleDate: Date.now(),
      status: "CANCELLED" as const,
    });
    const pendingEventId = await ctx.db.insert("pendingAccountingEvents", {
      orgId,
      kind: "REVERSE" as const,
      status: "POSTED" as const,
      idempotencyKey: `reversed_reset_${orgId}`,
      accountingDate: Date.now(),
      actorId: userId,
      attempts: 1,
      createdAt: Date.now(),
      sourceType: "depositApplications",
      sourceId: `reset_${orgId}`,
    });
    await ctx.db.insert("commitmentAuthorityWork", {
      orgId,
      workKey: `reset_${orgId}:DIRECT:${String(depositId)}`,
      status: "READY" as const,
      sourceKind: "DIRECT" as const,
      depositId,
      vehicleId: vehicle._id,
      saleId,
      pendingEventId,
      executions: 0,
      generation: 0,
      nextActionAt: Date.now(),
      createdAt: Date.now(),
    });
    return { pendingEventId };
  });
}

describe("resetOrgFinancialData refuses an org carrying authority lifecycle state", () => {
  test("refuses BEFORE any deletion, leaving every table untouched", async () => {
    const t = setup();
    const orgId = await seedOrg(t, "AuthRefuse");
    await seedAuthorityLifecycle(t, orgId);

    const before = {
      chart: await countFor(t, "chartOfAccounts", orgId),
      tx: await countFor(t, "transactions", orgId),
      exp: await countFor(t, "expenses", orgId),
    };

    // batchSize 1 is the shape that could orphan: far more lifecycle rows than
    // one pass can clear.
    await expect(
      t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
        orgId,
        dryRun: false,
        batchSize: 1,
      })
    ).rejects.toThrow(/commitment-authority/i);

    // THE CONTRACT: nothing was deleted. Asserted as an absence, because the
    // damage this prevents is a partial delete, not a bad return value.
    expect(await countFor(t, "chartOfAccounts", orgId)).toBe(before.chart);
    expect(await countFor(t, "transactions", orgId)).toBe(before.tx);
    expect(await countFor(t, "expenses", orgId)).toBe(before.exp);
    const survivingWork = await t.run(async (ctx: any) =>
      (await ctx.db.query("commitmentAuthorityWork").collect()).length
    );
    expect(survivingWork, "and the authority row itself is untouched").toBe(1);
  });

  test("a dry run stays non-destructive and reports the precondition truthfully", async () => {
    const t = setup();
    const orgId = await seedOrg(t, "AuthDry");
    await seedAuthorityLifecycle(t, orgId);

    const res = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      batchSize: 1,
    });

    expect(res.dryRun).toBe(true);
    expect(res.authorityLifecyclePresent, "the operator learns it BEFORE typing the destructive form")
      .toBe(true);
    expect(await countFor(t, "chartOfAccounts", orgId)).toBeGreaterThan(0);
  });

  test("CONTROL — an org with no authority state resets exactly as before", async () => {
    const t = setup();
    const orgId = await seedOrg(t, "NoAuth");

    const res = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: false,
    });

    expect(res.authorityLifecyclePresent).toBe(false);
    expect(await countFor(t, "chartOfAccounts", orgId)).toBe(0);
    expect(await countFor(t, "transactions", orgId)).toBe(0);
    // Protected tables still survive, as before.
    expect(await countFor(t, "vehicles", orgId)).toBe(1);
    expect(await countFor(t, "customers", orgId)).toBe(1);
  });
});
