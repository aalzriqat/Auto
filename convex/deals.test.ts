import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULES = import.meta.glob("./**/*.ts");

const PERMISSIONS = [
  "create:sales",
  "view:sales",
  "edit:vehicles",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "register:vehicle_handover",
  "register:expected_payment",
];

/**
 * A caller with `view:sales` but WITHOUT `view:finance`.
 *
 * This is the role the money-leak test turns on: the queue authorizes on
 * `view:sales`, exactly like the two lists it replaces, and one of those lists
 * hands financed amounts to this role today.
 */
async function setup() {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Queue Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "queue_user", email: "q@test.com", name: "Q User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "queue_approver", email: "qa@test.com", name: "Q Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A555555",
      make: "Kia",
      model: "Sportage",
      year: 2023,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 1000,
      sellingPrice: 20000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Sam", lastName: "Lee" })
  );

  return {
    t,
    orgId,
    userId,
    customerId,
    vehicleId,
    asUser: t.withIdentity({ subject: "queue_user", clerkId: "queue_user" }),
    asApprover: t.withIdentity({ subject: "queue_approver", clerkId: "queue_approver" }),
  };
}

/** Drives a quote all the way to a finalized sale through the real mutations. */
async function finalizedFinancedDeal(env: Awaited<ReturnType<typeof setup>>) {
  const { orgId, customerId, vehicleId, asUser, asApprover } = env;
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId,
    vehiclePrice: 20000,
    downPayment: 3000,
    termMonths: 48,
  });
  const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
  await asUser.mutation(api.applications.updateStatus, {
    orgId,
    applicationId,
    status: "UNDER_REVIEW",
  });
  await asApprover.mutation(api.applications.updateStatus, {
    orgId,
    applicationId,
    status: "APPROVED",
  });
  await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
  await asUser.mutation(api.applications.registerExpectedPayment, {
    orgId,
    applicationId,
    method: "CASH",
    expectedDate: Date.now(),
  });
  const saleId = await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });
  return { applicationId, saleId, quoteId };
}

/** A financed application that has NOT been finalized into a sale. */
async function preSaleApplication(env: Awaited<ReturnType<typeof setup>>) {
  const { orgId, customerId, asUser } = env;
  const otherVehicleId = await env.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A666666",
      make: "Toyota",
      model: "Corolla",
      year: 2022,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 5000,
      sellingPrice: 15000,
      status: "AVAILABLE",
    })
  );
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId: otherVehicleId,
    vehiclePrice: 15000,
    downPayment: 2000,
    termMonths: 36,
  });
  const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
  return { applicationId, quoteId, vehicleId: otherVehicleId };
}

describe("deals.queue — identity and dedup", () => {
  test("a finalized financed deal appears EXACTLY ONCE, anchored on the sale", async () => {
    const env = await setup();
    const { applicationId, saleId } = await finalizedFinancedDeal(env);

    const result = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });

    // The whole reason this is a server projection. A client union of
    // `applications.list` and `sales.list` would return this deal twice — once
    // as its application and once as its sale — at two different URLs.
    expect(result.rows).toHaveLength(1);
    const [row] = result.rows;
    expect(row.anchor).toBe("SALE");
    expect(row.dealKind).toBe("FINANCED");
    expect(row.href).toBe(`/${env.orgId}/sales/${saleId}/deal`);
    expect(row.href).not.toContain(applicationId);
  });

  test("a pre-sale application is anchored on the application and keeps its own URL", async () => {
    const env = await setup();
    const { applicationId } = await preSaleApplication(env);

    const result = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].anchor).toBe("APPLICATION");
    expect(result.rows[0].href).toBe(`/${env.orgId}/applications/${applicationId}/deal`);
  });

  test("a sale pointing at an application that does not point back is still deduped", async () => {
    const env = await setup();
    const { applicationId } = await preSaleApplication(env);

    // The two dedup guards read two DIFFERENT pointers: one walks sale ->
    // `applicationId`, the other walks application -> `finalizedSaleId`. The
    // normal `finalizeDeal` path writes both, so either guard alone hides a
    // duplicate — a mutation test showed the sale->app guard was never actually
    // exercised by the suite, only shadowed by the other one.
    //
    // This is the shape that isolates it: a sale naming an application whose
    // own `finalizedSaleId` is unset. Reachable through the super-admin raw
    // record editor, and through any future writer that links a sale without
    // going through `finalizeDeal`.
    const saleId = await env.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: env.orgId,
        vehicleId: env.vehicleId,
        customerId: env.customerId,
        salespersonId: env.userId,
        salePrice: 15000,
        saleDate: Date.now(),
        status: "COMPLETED",
        applicationId,
      })
    );

    const result = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].href).toBe(`/${env.orgId}/sales/${saleId}/deal`);
  });

  test("a deal whose sale was soft-deleted stays in the queue at its application URL", async () => {
    const env = await setup();
    const { applicationId, saleId } = await finalizedFinancedDeal(env);

    // `sales.softDelete` sets `isDeleted` and nothing clears `finalizedSaleId`,
    // so the application still names a sale that can no longer be read. Trusting
    // that pointer would suppress the application row while the sale row it
    // deferred to has already dropped out — and the deal would disappear from
    // the operator's queue entirely.
    await env.t.run((ctx) => ctx.db.patch(saleId, { isDeleted: true }));

    const result = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].anchor).toBe("APPLICATION");
    expect(result.rows[0].href).toBe(`/${env.orgId}/applications/${applicationId}/deal`);
  });
});

describe("deals.queue — no money at any permission level", () => {
  test("no row carries an amount, and the field set is exactly the declared one", async () => {
    const env = await setup();
    await finalizedFinancedDeal(env);
    await preSaleApplication(env);

    const result = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });
    expect(result.rows.length).toBeGreaterThan(0);

    // An allow-list assertion rather than a deny-list. A deny-list ("no key
    // called financedAmount") passes the moment someone spreads a document and
    // introduces a differently-named amount; this fails on ANY new field, which
    // forces the money question to be answered in review rather than at runtime.
    const ALLOWED = [
      "key",
      "href",
      "dealKind",
      "anchor",
      "customerName",
      "vehicleLabel",
      "providerName",
      "providerLabelKey",
      "ownerName",
      "statusKey",
      "stageKey",
      "blockerKey",
      "needsAttention",
      "depositPending",
      "lastActivityAt",
    ].sort();

    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(ALLOWED);
    }
  });
});

describe("deals.queue — one source of truth for the blocker", () => {
  test("the row's stage and blocker are exactly what the deal screen reports", async () => {
    const env = await setup();
    const { applicationId } = await preSaleApplication(env);

    const [queueResult, cockpit] = await Promise.all([
      env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" }),
      env.asUser.query(api.applications.dealCockpit, { orgId: env.orgId, applicationId }),
    ]);

    const row = queueResult.rows.find((r) => r.href.includes(applicationId));
    expect(row).toBeDefined();

    // The Deal screen focuses the first stage that is CURRENT or BLOCKED. If the
    // queue ever computes that its own cheaper way, a row will advertise one
    // next step and the screen it opens will show another — the second source of
    // truth the SCRUM-63 review forbade. This test is that prohibition.
    const live = cockpit!.stages.find(
      (stage) => stage.state === "CURRENT" || stage.state === "BLOCKED"
    );
    expect(row!.stageKey).toBe(live?.key ?? null);
    expect(row!.blockerKey).toBe(live?.blocker ?? null);
  });
});

describe("deals.queue — tenancy", () => {
  test("deals from another org never appear", async () => {
    const env = await setup();
    await finalizedFinancedDeal(env);

    const otherOrgId = await env.t.run(async (ctx) => {
      const id = await ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() });
      const otherCustomerId = await ctx.db.insert("customers", {
        orgId: id,
        firstName: "Other",
        lastName: "Buyer",
      });
      const otherVehicleId = await ctx.db.insert("vehicles", {
        orgId: id,
        vin: "1HGCM82633A777777",
        make: "Nissan",
        model: "Sunny",
        year: 2021,
        color: "Grey",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 200,
        sellingPrice: 9000,
        status: "AVAILABLE",
      });
      await ctx.db.insert("sales", {
        orgId: id,
        vehicleId: otherVehicleId,
        customerId: otherCustomerId,
        salespersonId: env.userId,
        salePrice: 9000,
        saleDate: Date.now(),
        status: "COMPLETED",
      });
      return id;
    });

    const mine = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows.every((row) => row.href.startsWith(`/${env.orgId}/`))).toBe(true);

    // And the caller cannot simply ask for the other org's queue.
    await expect(
      env.asUser.query(api.deals.queue, { orgId: otherOrgId, view: "ALL" })
    ).rejects.toThrow();
  });
});

describe("deals.queue — the state that only lived on the old list", () => {
  test("a rejected application holding a deposit surfaces as depositPending", async () => {
    const env = await setup();
    const { applicationId, quoteId } = await preSaleApplication(env);

    await env.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: env.orgId,
        quoteId,
        vehicleId: env.vehicleId,
        customerId: env.customerId,
        amount: 500,
        method: "CASH",
        status: "HELD",
        holdActive: true,
        createdAt: Date.now(),
        createdBy: env.userId,
      })
    );
    await env.asUser.mutation(api.applications.updateStatus, {
      orgId: env.orgId,
      applicationId,
      status: "UNDER_REVIEW",
    });
    await env.asUser.mutation(api.applications.updateStatus, {
      orgId: env.orgId,
      applicationId,
      status: "REJECTED",
    });

    const result = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });
    const row = result.rows.find((r) => r.href.includes(applicationId));
    expect(row?.depositPending).toBe(true);

    // A REJECTED application has a fully STOPPED rail, so judging attention by
    // the rail alone reported "nothing outstanding" on a deal that is holding a
    // customer's money. The refund is outstanding, and a dead deal is exactly
    // when it gets forgotten.
    expect(row?.needsAttention).toBe(true);
    const attention = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "NEEDS_ATTENTION",
    });
    expect(attention.rows.map((r) => r.href)).toContain(
      `/${env.orgId}/applications/${applicationId}/deal`
    );

    // `DEPOSIT_PENDING` is actionable today ONLY from the applications list and
    // its dialog. If the queue could not surface it, retiring that list would
    // silently delete a held customer deposit awaiting refund or forfeit.
    const view = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "DEPOSIT_PENDING",
    });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].href).toContain(applicationId);
  });
});

describe("deals.queue — ordering and limits", () => {
  test("actionable deals sort above finished ones, longest-waiting first", async () => {
    const env = await setup();
    const { applicationId } = await preSaleApplication(env);
    const { saleId } = await finalizedFinancedDeal(env);

    // The pre-sale application is made to look older than the finalized deal, so
    // "oldest first" and "insertion order" cannot accidentally agree.
    await env.t.run((ctx) =>
      ctx.db.patch(applicationId, { updatedAt: Date.now() - 30 * 86_400_000 })
    );

    const result = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });

    expect(result.rows).toHaveLength(2);
    // Whichever of the two still needs a human comes first; among equals, the
    // one that has waited longest leads. A newest-first queue is how a finance
    // company goes quiet for three weeks without anyone noticing.
    const [first, second] = result.rows;
    if (first.needsAttention === second.needsAttention) {
      expect(first.lastActivityAt).toBeLessThanOrEqual(second.lastActivityAt);
    } else {
      expect(first.needsAttention).toBe(true);
    }
    expect(result.rows.map((r) => r.href)).toContain(`/${env.orgId}/sales/${saleId}/deal`);
  });

  test("a limit smaller than the data reports itself as truncated", async () => {
    const env = await setup();
    await finalizedFinancedDeal(env);
    await preSaleApplication(env);

    const result = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "ALL",
      limit: 1,
    });

    // Silence here would read as "you are done" on a worklist that is not done.
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(1);
  });

  test("a non-finite limit cannot turn the scan unbounded", async () => {
    const env = await setup();
    await preSaleApplication(env);

    // Convex's `v.number()` accepts NaN and Infinity, and either one reaching
    // `.take()` is an unbounded scan on a live subscription.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 10_000]) {
      const result = await env.asUser.query(api.deals.queue, {
        orgId: env.orgId,
        view: "ALL",
        limit: bad,
      });
      expect(Number.isFinite(result.limit)).toBe(true);
      expect(result.limit).toBeGreaterThan(0);
      expect(result.limit).toBeLessThanOrEqual(100);
    }
  });
});
