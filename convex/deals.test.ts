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
 * The queue authorizes on `view:sales`, exactly like the two lists it replaces,
 * and one of those lists hands financed amounts to this role today. So the
 * allow-list assertion below runs as this role deliberately.
 *
 * ⚠️ It proves the projection SHAPE — that no money field can reach any caller —
 * not that a lower-permission role sees less than a higher one. Those are
 * different claims, and the earlier wording here asserted the second while
 * testing the first. A permission-differential test would need a second role;
 * it is not needed while the row type carries no amount at all, and the
 * allow-list is what enforces that.
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
    const { applicationId, quoteId, vehicleId: depositVehicleId } = await preSaleApplication(env);

    await env.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: env.orgId,
        quoteId,
        vehicleId: depositVehicleId,
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

  test("deposits on live deals cannot crowd out the one that needs resolving", async () => {
    const env = await setup();
    const { applicationId, quoteId, vehicleId: depositVehicleId } = await preSaleApplication(env);

    /**
     * The held-deposit scan is filtered AFTER it is bounded: it takes a page of
     * HELD deposits, then keeps only those whose application was rejected or
     * cancelled. Bound that page to the caller's `limit` and a floor with a few
     * live deposits fills it entirely with rows that all fail the filter — so
     * DEPOSIT_PENDING renders EMPTY while a customer's money sits unrefunded.
     *
     * `truncated` was true throughout, so the screen never claimed to be
     * complete. It just showed nothing, which is a poor way to say "there is
     * more" on the one view that exists to find this.
     */
    for (let index = 0; index < 5; index += 1) {
      const liveVehicleId = await env.t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId: env.orgId,
          vin: `1HGCM82633A8000${index}`,
          make: "Kia",
          model: "Rio",
          year: 2023,
          color: "Red",
          fuelType: "Gasoline",
          transmission: "Automatic",
          mileage: 100,
          sellingPrice: 9000,
          status: "RESERVED",
        })
      );
      // Their OWN quote, with no rejected application behind it — otherwise
      // every deposit resolves to the same rejected deal and the test passes
      // whether or not the scan ever reached the sixth row. The first draft of
      // this test did exactly that.
      const liveQuoteId = await env.t.run((ctx) =>
        ctx.db.insert("quotes", {
          orgId: env.orgId,
          customerId: env.customerId,
          vehicleId: liveVehicleId,
          vehiclePrice: 9000,
          downPayment: 1000,
          termMonths: 24,
          status: "SHARED",
          createdBy: env.userId,
          createdAt: Date.now(),
        })
      );
      await env.t.run((ctx) =>
        ctx.db.insert("deposits", {
          orgId: env.orgId,
          quoteId: liveQuoteId,
          vehicleId: liveVehicleId,
          customerId: env.customerId,
          amount: 300,
          method: "CASH",
          status: "HELD",
          holdActive: true,
          createdAt: Date.now(),
          createdBy: env.userId,
        })
      );
    }

    // The one that matters is inserted LAST, so a page bounded by `limit` never
    // reaches it.
    await env.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: env.orgId,
        quoteId,
        vehicleId: depositVehicleId,
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

    const view = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "DEPOSIT_PENDING",
      limit: 2,
    });
    expect(view.rows.map((r) => r.href)).toContain(
      `/${env.orgId}/applications/${applicationId}/deal`
    );
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

  test("a chip shows no number rather than a wrong one", async () => {
    const env = await setup();
    // One finished deal and one open application. From NEEDS_ATTENTION the
    // history scan is skipped, so only the open one is in the scanned set.
    await finalizedFinancedDeal(env);
    await preSaleApplication(env);

    const attention = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "NEEDS_ATTENTION",
    });
    // The actionable population is reached by status and is complete, so its
    // own counts are sound.
    expect(attention.counts.NEEDS_ATTENTION).toBe(1);
    // But "All" cannot be answered without the history scan. It used to report
    // 1 — a confident total, off by the finished deal, sitting next to a view
    // that shows 2 the moment it is clicked.
    expect(attention.counts.ALL).toBeUndefined();

    const all = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });
    expect(all.counts.ALL).toBe(2);
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

    /**
     * `limit` bounds each SCAN, not the number of rows returned — pinned here
     * so the two cannot drift apart unnoticed.
     *
     * Deliberate. Slicing the result to `limit` would mean deciding, on the
     * server, which actionable deals an operator is not allowed to see, on a
     * screen whose entire purpose is that nothing outstanding goes unnoticed.
     * A scan that stopped early says so through `truncated`; work that was
     * found is always handed over.
     */
    expect(result.rows.length).toBeGreaterThan(result.limit);
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

describe("deals.queue — findings from the SCRUM-63 adversarial review", () => {
  test("an old actionable deal is reachable even behind a page of newer dead ones", async () => {
    const env = await setup();

    // The OLDEST application is the actionable one; two newer ones are dead.
    const old = await preSaleApplication(env);
    await env.asUser.mutation(api.applications.updateStatus, {
      orgId: env.orgId,
      applicationId: old.applicationId,
      status: "UNDER_REVIEW",
    });
    for (const vin of ["1HGCM82633A111111", "1HGCM82633A222222"]) {
      const v = await env.t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId: env.orgId,
          vin,
          make: "Ford",
          model: "Focus",
          year: 2020,
          color: "Red",
          fuelType: "Gasoline",
          transmission: "Automatic",
          mileage: 100,
          sellingPrice: 8000,
          status: "AVAILABLE",
        })
      );
      const q = await env.asUser.mutation(api.quotes.saveQuote, {
        orgId: env.orgId,
        customerId: env.customerId,
        vehicleId: v,
        vehiclePrice: 8000,
        downPayment: 1000,
        termMonths: 24,
      });
      const a = await env.asUser.mutation(api.applications.createFromQuote, {
        orgId: env.orgId,
        quoteId: q,
      });
      await env.asUser.mutation(api.applications.updateStatus, {
        orgId: env.orgId,
        applicationId: a,
        status: "UNDER_REVIEW",
      });
      await env.asUser.mutation(api.applications.updateStatus, {
        orgId: env.orgId,
        applicationId: a,
        status: "REJECTED",
      });
    }

    // Scanning the two NEWEST rows and only then sorting oldest-first cannot
    // ever reach the old one — so the screen that promises "the longest-stuck
    // work is at the top" would show an empty needs-attention queue while a
    // real deal sat waiting. The candidate set has to be the ACTIONABLE
    // population, not the recent population.
    const result = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "NEEDS_ATTENTION",
      limit: 2,
    });

    expect(result.rows.map((r) => r.href)).toContain(
      `/${env.orgId}/applications/${old.applicationId}/deal`
    );
  });

  test("a finalized deal whose sale falls outside the sales window does not vanish", async () => {
    const env = await setup();
    const { applicationId, saleId } = await finalizedFinancedDeal(env);

    // A second, NEWER sale pushes the finalized sale out of a 1-row window,
    // while the application is still the newest application. Suppressing the
    // application row because its sale "exists" then removes the only
    // representation the deal had.
    await env.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: env.orgId,
        vehicleId: env.vehicleId,
        customerId: env.customerId,
        salespersonId: env.userId,
        salePrice: 5000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );

    const result = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "ALL",
      limit: 1,
    });

    const hrefs = result.rows.map((r) => r.href);
    const present =
      hrefs.includes(`/${env.orgId}/sales/${saleId}/deal`) ||
      hrefs.includes(`/${env.orgId}/applications/${applicationId}/deal`);
    expect(present).toBe(true);
  });

  test("a supplier obligation in an unreadable currency never reads as settled", async () => {
    const env = await setup();

    // A consigned CASH sale whose payable is denominated differently from the
    // sale's frozen currency. `sales.dealCockpit` returns UNKNOWN for this and
    // keeps the settlement stage open; the queue must agree, or a deal the Deal
    // screen still considers unresolved silently drops out of the worklist.
    const consignedVehicleId = await env.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: env.orgId,
        vin: "1HGCM82633A999999",
        make: "Honda",
        model: "Civic",
        year: 2020,
        color: "Black",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 100,
        sellingPrice: 12000,
        status: "SOLD",
        sourcedFromName: "Waleed",
        sourceType: "SOURCED",
      })
    );
    const saleId = await env.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: env.orgId,
        vehicleId: consignedVehicleId,
        customerId: env.customerId,
        salespersonId: env.userId,
        salePrice: 12000,
        saleDate: Date.now(),
        status: "COMPLETED",
        consignedMarginCurrency: "JOD",
        supplierSettlementRoute: "THROUGH_DEALERSHIP",
      })
    );
    await env.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: env.orgId,
        saleId,
        vehicleId: consignedVehicleId,
        amountDue: 11000,
        amountPaid: 11000,
        currency: "USD",
        status: "PAID",
        sourcedFromName: "Waleed",
        createdAt: Date.now(),
        createdBy: env.userId,
        updatedAt: Date.now(),
      })
    );

    const result = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });
    const row = result.rows.find((r) => r.href.includes(saleId));
    expect(row).toBeDefined();
    expect(row!.needsAttention).toBe(true);
  });

  test("a hydrated record belonging to another org is never rendered", async () => {
    const env = await setup();

    const foreignCustomerId = await env.t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", {
        name: "Foreign Dealer",
        createdAt: Date.now(),
      });
      return ctx.db.insert("customers", {
        orgId: otherOrgId,
        firstName: "Foreign",
        lastName: "Person",
      });
    });

    // Reachable through the super-admin raw-record editor, which can write any
    // field on any row. Convex ids carry a TABLE, not an organization, so
    // following one out of an in-org document proves nothing about tenancy.
    await env.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: env.orgId,
        vehicleId: env.vehicleId,
        customerId: foreignCustomerId,
        salespersonId: env.userId,
        salePrice: 1000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );

    const result = await env.asUser.query(api.deals.queue, { orgId: env.orgId, view: "ALL" });
    expect(result.rows.map((r) => r.customerName)).not.toContain("Foreign Person");
  });
});

describe("deals.queue — a finished deal that still owes its supplier", () => {
  test("an unpaid supplier keeps a COMPLETED sale actionable regardless of age", async () => {
    const env = await setup();

    // Scoping the actionable population to OPEN statuses closed one hole and
    // opened another: a COMPLETED sale is not an open status, but it is still
    // actionable while the supplier has not been paid. That is money, on a deal
    // everyone has already filed as finished — so it is reached through the
    // subledger's own status index rather than by hoping the sale is recent.
    const consignedVehicleId = await env.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: env.orgId,
        vin: "1HGCM82633A424242",
        make: "Honda",
        model: "Accord",
        year: 2019,
        color: "Silver",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 900,
        sellingPrice: 14000,
        status: "SOLD",
        sourcedFromName: "Waleed",
        sourceType: "SOURCED",
      })
    );
    const saleId = await env.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: env.orgId,
        vehicleId: consignedVehicleId,
        customerId: env.customerId,
        salespersonId: env.userId,
        salePrice: 14000,
        saleDate: Date.now(),
        status: "COMPLETED",
        consignedMarginCurrency: "JOD",
        supplierSettlementRoute: "THROUGH_DEALERSHIP",
      })
    );
    await env.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: env.orgId,
        saleId,
        vehicleId: consignedVehicleId,
        amountDue: 13000,
        amountPaid: 0,
        currency: "JOD",
        status: "PENDING",
        sourcedFromName: "Waleed",
        createdAt: Date.now(),
        createdBy: env.userId,
        updatedAt: Date.now(),
      })
    );

    const attention = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "NEEDS_ATTENTION",
    });
    expect(attention.rows.map((r) => r.href)).toContain(`/${env.orgId}/sales/${saleId}/deal`);
  });

  test("more unsettled suppliers than the page cap is never reported as a complete worklist", async () => {
    const env = await setup();

    /**
     * FAILING FIRST against `f8233afe`.
     *
     * The sweep that reaches these deals takes `limit + 1` rows per obligation
     * status, but the overflow test counted only the sales, deposit and
     * application buckets — never the payables or receivables. So the obligation
     * past that cap fell out of `unsettledSaleIds`, out of the candidates and
     * out of NEEDS_ATTENTION, while the queue still answered `truncated: false`.
     *
     * That is the failure this whole screen exists to prevent, in its most
     * expensive form: unpaid supplier money on deals everyone has already filed
     * as finished, omitted by a queue asserting it had shown everything.
     *
     * The invariant is a disjunction, deliberately: EITHER every actionable
     * obligation is represented, OR the queue says out loud that it is not
     * showing everything. It may never quietly claim a complete worklist.
     */
    const LIMIT = 2;
    const OBLIGATIONS = LIMIT + 2;
    const saleIds: string[] = [];

    for (let index = 0; index < OBLIGATIONS; index += 1) {
      const vehicleId = await env.t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId: env.orgId,
          vin: `1HGCM82633A5000${index}`,
          make: "Honda",
          model: "Civic",
          year: 2020,
          color: "White",
          fuelType: "Gasoline",
          transmission: "Automatic",
          mileage: 1000,
          sellingPrice: 12000,
          status: "SOLD",
          sourcedFromName: "Waleed",
          sourceType: "SOURCED",
        })
      );
      const saleId = await env.t.run((ctx) =>
        ctx.db.insert("sales", {
          orgId: env.orgId,
          vehicleId,
          customerId: env.customerId,
          salespersonId: env.userId,
          salePrice: 12000,
          saleDate: Date.now(),
          status: "COMPLETED",
          consignedMarginCurrency: "JOD",
          supplierSettlementRoute: "THROUGH_DEALERSHIP",
        })
      );
      saleIds.push(saleId);
      // Every obligation in the SAME status, so one bucket alone overflows.
      await env.t.run((ctx) =>
        ctx.db.insert("vehicleSupplierPayables", {
          orgId: env.orgId,
          saleId,
          vehicleId,
          amountDue: 11000,
          amountPaid: 0,
          currency: "JOD",
          status: "PENDING",
          sourcedFromName: "Waleed",
          createdAt: Date.now(),
          createdBy: env.userId,
          updatedAt: Date.now(),
        })
      );
    }

    const attention = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "NEEDS_ATTENTION",
      limit: LIMIT,
    });

    const scanned = new Set(attention.rows.map((row) => row.key));
    const everyObligationRepresented = saleIds.every((id) => scanned.has(`sale:${id}`));
    expect(everyObligationRepresented || attention.truncated).toBe(true);

    // And the concrete choice this implementation makes: a single overflowing
    // obligation bucket is reported, not absorbed. Asserted separately so the
    // disjunction above cannot be satisfied by an accident of page size.
    expect(attention.truncated).toBe(true);
  });

  test("a FULLY_SETTLED stamp cannot outrank an open supplier payable", async () => {
    const env = await setup();

    /**
     * The sweep found this deal BECAUSE the supplier is still owed. If the row
     * it produces then reads "nothing outstanding", the sweep has surfaced a
     * deal and immediately hidden it again.
     *
     * `deriveDealStages` falls back to `settlementStatus` whenever
     * `settlementComplete` is undefined, and the queue passed undefined for
     * every financed row — so a deal stamped FULLY_SETTLED while a payable sat
     * open reported settled here and unsettled in the cockpit, which resolves
     * the obligation from the subledger. Two screens, same deal, opposite
     * answers about whether money is owed.
     *
     * The queue may only use the subledger to REFUSE to call a deal settled.
     * Declaring settlement stays with the cockpit, which resolves route,
     * currency and entitlement to do it.
     */
    const vehicleId = await env.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: env.orgId,
        vin: "1HGCM82633A777777",
        make: "Mazda",
        model: "CX-5",
        year: 2022,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 500,
        sellingPrice: 16000,
        status: "SOLD",
        sourcedFromName: "Waleed",
        sourceType: "SOURCED",
      })
    );
    const quoteId = await env.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: env.orgId,
        customerId: env.customerId,
        vehicleId,
        vehiclePrice: 16000,
        downPayment: 2000,
        termMonths: 48,
        mode: "CONFIGURED_FINANCE_COMPANY",
        status: "ACCEPTED",
        createdBy: env.userId,
        createdAt: Date.now(),
      })
    );
    const saleId = await env.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: env.orgId,
        vehicleId,
        customerId: env.customerId,
        salespersonId: env.userId,
        salePrice: 16000,
        saleDate: Date.now(),
        status: "COMPLETED",
        financingType: "FINANCED",
        consignedMarginCurrency: "JOD",
        supplierSettlementRoute: "THROUGH_DEALERSHIP",
      })
    );
    const applicationId = await env.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: env.orgId,
        quoteId,
        customerId: env.customerId,
        vehicleId,
        salespersonId: env.userId,
        status: "CLOSED",
        // The stamp that used to win the argument on its own.
        settlementStatus: "FULLY_SETTLED",
        // Every earlier stage is deliberately COMPLETE, so SETTLEMENT is the
        // only one that can be live. Without this the rail stalls at an earlier
        // step and the test passes whether or not the fix exists — which is
        // exactly what the first draft of it did.
        creditDecision: "APPROVED",
        appraisalStatus: "COMPLETED",
        gapResolution: "NOT_REQUIRED",
        approvedDealerPurchaseAmountMinor: 15_000_000,
        handoverStatus: "HANDED_OVER",
        finalizedSaleId: saleId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await env.t.run((ctx) => ctx.db.patch(saleId, { applicationId }));
    await env.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: env.orgId,
        saleId,
        vehicleId,
        amountDue: 15000,
        amountPaid: 0,
        currency: "JOD",
        status: "PENDING",
        sourcedFromName: "Waleed",
        createdAt: Date.now(),
        createdBy: env.userId,
        updatedAt: Date.now(),
      })
    );

    const attention = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "NEEDS_ATTENTION",
    });
    const row = attention.rows.find((r) => r.key === `sale:${saleId}`);
    expect(row).toBeDefined();
    expect(row?.needsAttention).toBe(true);
    expect(row?.stageKey).toBe("SETTLEMENT");
  });

  test("an overflowing receivable bucket is reported too", async () => {
    const env = await setup();

    // The payable sweep and the receivable sweep are separate queries, so a fix
    // applied to one proves nothing about the other. DIRECT_TO_SUPPLIER is the
    // route where the supplier owes the dealership its margin back.
    const LIMIT = 2;
    for (let index = 0; index < LIMIT + 2; index += 1) {
      const vehicleId = await env.t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId: env.orgId,
          vin: `1HGCM82633A6000${index}`,
          make: "Toyota",
          model: "Yaris",
          year: 2021,
          color: "Grey",
          fuelType: "Gasoline",
          transmission: "Automatic",
          mileage: 800,
          sellingPrice: 10000,
          status: "SOLD",
          sourcedFromName: "Waleed",
          sourceType: "SOURCED",
        })
      );
      const saleId = await env.t.run((ctx) =>
        ctx.db.insert("sales", {
          orgId: env.orgId,
          vehicleId,
          customerId: env.customerId,
          salespersonId: env.userId,
          salePrice: 10000,
          saleDate: Date.now(),
          status: "COMPLETED",
          consignedMarginCurrency: "JOD",
          supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
        })
      );
      await env.t.run((ctx) =>
        ctx.db.insert("vehicleSupplierReceivables", {
          orgId: env.orgId,
          saleId,
          vehicleId,
          amountDue: 1000,
          amountReceived: 0,
          currency: "JOD",
          status: "OPEN",
          sourcedFromName: "Waleed",
          createdAt: Date.now(),
          createdBy: env.userId,
          updatedAt: Date.now(),
        })
      );
    }

    const attention = await env.asUser.query(api.deals.queue, {
      orgId: env.orgId,
      view: "NEEDS_ATTENTION",
      limit: LIMIT,
    });
    expect(attention.truncated).toBe(true);
  });
});
