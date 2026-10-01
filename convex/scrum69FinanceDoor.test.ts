/**
 * SCRUM-69 / SCRUM-532 — A FINANCE-HELD CAR COMPLETES ONLY THROUGH finalizeDeal.
 *
 * INVARIANT: while a vehicle is held by a finance application in
 * IN_FLIGHT_FINANCE_STATUSES (DRAFT, PENDING_DOCS, UNDER_REVIEW, APPROVED) — the
 * application that `createFromQuote` acquired the car for, recorded as an ACTIVE
 * `vehicleCommitmentClaims` row of evidenceKind FINANCE — that vehicle becomes
 * SOLD only through `applications.finalizeDeal` for THAT application. Every other
 * completion door (`sales.create`, `sales.completeFromQuote`,
 * `sales.completeDraft`) refuses, whatever the quote's mode, the financing type,
 * or the lineage the caller or a stored draft presents.
 *
 * Fixtures: org / user / role / customer / vehicle scaffolding and the narrow
 * seeds named in each test use `ctx.db`; every ACT under test goes through a real
 * product mutation under a real identity.
 */

import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { acquireVehicle } from "./commitments";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/** Literals on purpose: the test must not import the constant it is checking. */
const CODE = "SALE_COMPLETES_THROUGH_FINANCE_APPLICATION";
const MESSAGE =
  "This car has a finance application in progress. Complete the sale from the deal page.";
const MESSAGE_AR = "هذه السيارة عليها طلب تمويل قيد المعالجة. أكمل البيع من صفحة الصفقة.";

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "delete:sales",
  "edit:vehicles",
  "view:vehicles",
  "delete:vehicles",
  "approve:requests",
  "manage:finance",
  "view:finance",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "confirm:finance_disbursement",
  "verify:finance_documents",
  "register:vehicle_handover",
  "register:expected_payment",
];

const PRICE = 30_000;

// ── fixtures ────────────────────────────────────────────────────────────────

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Dealer ${suffix}`, createdAt: Date.now() })
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
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `user_${suffix}`, email: `${suffix}@test.com`, name: "Sales User" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: `user_${suffix}`, clerkId: `user_${suffix}` });

  // A salesperson may not approve their own application, so approval is the manager's.
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `mgr_${suffix}`, email: `mgr-${suffix}@test.com`, name: "Manager" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));
  const asManager = t.withIdentity({ subject: `mgr_${suffix}`, clerkId: `mgr_${suffix}` });

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "A",
      phone: `+96279221${suffix.length}1`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "B",
      phone: `+96279221${suffix.length}2`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, asUser, managerId, asManager, customerA, customerB };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

let vinCounter = 0;
async function vehicle(seed: Seed) {
  vinCounter += 1;
  const vin = `5VWFA7AT${String(800000 + vinCounter).slice(0, 6)}ZZ`;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin,
      make: "Toyota",
      model: "RAV4",
      year: 2023,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 90,
      purchasePrice: 20_000,
      sellingPrice: PRICE,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
}

async function quoteFor(seed: Seed, customerId: Id<"customers">, vehicles: Array<Id<"vehicles">>) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId: vehicles[0],
    vehicleItems: vehicles.map((vehicleId) => ({ vehicleId, unitPrice: PRICE })),
    mode: "CASH" as const,
    vehiclePrice: PRICE * vehicles.length,
    downPayment: 0,
    termMonths: 0,
  });
}

async function depositOn(seed: Seed, quoteId: Id<"quotes">, amount: number) {
  return await seed.asUser.mutation(api.deposits.create, {
    method: "CASH",
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    quoteId,
    amount,
  });
}

/** The real acquisition door: PENDING_DOCS, with the FINANCE claim written. */
async function applicationFor(seed: Seed, quoteId: Id<"quotes">) {
  return await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });
}

async function toUnderReview(seed: Seed, applicationId: Id<"financeApplications">) {
  await seed.asUser.mutation(api.applications.updateStatus, {
    orgId: seed.orgId,
    applicationId,
    status: "UNDER_REVIEW" as const,
  });
}

async function toApproved(seed: Seed, applicationId: Id<"financeApplications">) {
  await toUnderReview(seed, applicationId);
  await seed.asManager.mutation(api.applications.updateStatus, {
    orgId: seed.orgId,
    applicationId,
    status: "APPROVED" as const,
  });
}

type InFlight = "DRAFT" | "PENDING_DOCS" | "UNDER_REVIEW" | "APPROVED";

/**
 * An application in the given in-flight status. DRAFT is not reachable through
 * `createFromQuote` (it writes PENDING_DOCS), so it is patched in on a row the
 * real door created — the only way to hold a legacy DRAFT row.
 */
async function applicationIn(seed: Seed, quoteId: Id<"quotes">, status: InFlight) {
  const applicationId = await applicationFor(seed, quoteId);
  if (status === "DRAFT") {
    await seed.t.run((ctx) => ctx.db.patch(applicationId, { status: "DRAFT" as const }));
  } else if (status === "UNDER_REVIEW") {
    await toUnderReview(seed, applicationId);
  } else if (status === "APPROVED") {
    await toApproved(seed, applicationId);
  }
  return applicationId;
}

async function directSale(
  seed: Seed,
  quoteId: Id<"quotes"> | undefined,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">,
  extra: Record<string, unknown> = {}
) {
  return (await seed.asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    vehicleId,
    customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    ...(quoteId ? { quoteId } : {}),
    ...extra,
  })) as Id<"sales">;
}

async function completeQuote(seed: Seed, quoteId: Id<"quotes">) {
  return (await seed.asUser.mutation(api.sales.completeFromQuote, {
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    quoteId,
  })) as Array<Id<"sales">>;
}

async function createDraftFor(seed: Seed, vehicleId: Id<"vehicles">, customerId: Id<"customers">) {
  return await seed.asUser.mutation(api.sales.createDraft, {
    orgId: seed.orgId,
    vehicleId,
    customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
  });
}

async function completeDraft(seed: Seed, saleId: Id<"sales">) {
  return await seed.asUser.mutation(api.sales.completeDraft, {
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    saleId,
  });
}

async function finalizeDeal(seed: Seed, applicationId: Id<"financeApplications">) {
  await registerHandover(seed.asUser, api, seed.orgId, applicationId);
  await seed.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: seed.orgId,
    applicationId,
    method: "CASH" as const,
    expectedDate: Date.now() + 86_400_000,
  });
  return (await seed.asUser.mutation(api.applications.finalizeDeal, {
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    applicationId,
  })) as Id<"sales">;
}

// ── observation ─────────────────────────────────────────────────────────────

async function salesCount(seed: Seed) {
  return await seed.t.run(async (ctx) => (await ctx.db.query("sales").collect()).length);
}

async function vehicleStatus(seed: Seed, v: Id<"vehicles">) {
  return (await seed.t.run((ctx) => ctx.db.get(v)))?.status;
}

async function applicationStatus(seed: Seed, a: Id<"financeApplications">) {
  return (await seed.t.run((ctx) => ctx.db.get(a)))?.status;
}

async function rowCounts(seed: Seed) {
  return await seed.t.run(async (ctx) => ({
    sales: (await ctx.db.query("sales").collect()).length,
    journals: (await ctx.db.query("journalEntries").collect()).length,
    receivables: (await ctx.db.query("receivableDocuments").collect()).length,
    pendingEvents: (await ctx.db.query("pendingAccountingEvents").collect()).length,
  }));
}

/** Nothing was written: no sale, the car is not SOLD, the application did not move. */
async function expectNoResidue(
  seed: Seed,
  v: Id<"vehicles">,
  applicationId: Id<"financeApplications">,
  statusBefore: string | undefined
) {
  expect(await salesCount(seed), "no sale row").toBe(0);
  expect(await vehicleStatus(seed, v), "the car is not SOLD").not.toBe("SOLD");
  expect(await applicationStatus(seed, applicationId), "the application did not move").toBe(statusBefore);
}

/**
 * Claim rows are never transitioned when an application is rejected or cancelled
 * (nothing in the product rewrites `vehicleCommitmentClaims.status`), so an
 * ACTIVE FINANCE claim is NOT proof the application still holds the car — the
 * application's own status is. This pins that fact so the guard cannot be
 * rebuilt on the claim row's status alone.
 */
async function expectFinanceClaimStillActive(seed: Seed, v: Id<"vehicles">) {
  const claims = await seed.t.run(async (ctx) =>
    (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
      (c) => c.vehicleId === v && c.evidenceKind === "FINANCE"
    )
  );
  expect(claims, "precondition: the released application's claim row").toHaveLength(1);
  expect(claims[0].status, "and it is still ACTIVE").toBe("ACTIVE");
}

const IN_FLIGHT: InFlight[] = ["DRAFT", "PENDING_DOCS", "UNDER_REVIEW", "APPROVED"];

// ── T1 ──────────────────────────────────────────────────────────────────────

describe("T1 sales.create refuses a car a finance application holds", () => {
  test.each(IN_FLIGHT)("application %s", async (status) => {
    const seed = await seedDealer(`t1${status.length}`);
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await applicationIn(seed, quoteId, status);
    expect(await applicationStatus(seed, applicationId), "precondition").toBe(status);

    // CASH and "no financing type" are the two shapes the caller may present.
    await expectAppError(directSale(seed, quoteId, v, seed.customerA, { financingType: "CASH" }), CODE, MESSAGE);
    await expectAppError(directSale(seed, quoteId, v, seed.customerA), CODE, MESSAGE);

    await expectNoResidue(seed, v, applicationId, status);
  });
});

// ── T2 ──────────────────────────────────────────────────────────────────────

describe("T2 sales.completeFromQuote refuses a car a finance application holds (SCRUM-532)", () => {
  test("a CASH quote with an APPROVED application", async () => {
    const seed = await seedDealer("t2a");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await applicationIn(seed, quoteId, "APPROVED");

    await expectAppError(completeQuote(seed, quoteId), CODE, MESSAGE);

    await expectNoResidue(seed, v, applicationId, "APPROVED");
  });

  test("a mode-less quote carrying a finance company, with an application", async () => {
    const seed = await seedDealer("t2b");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await applicationIn(seed, quoteId, "PENDING_DOCS");
    // A stored quote with no mode but a company is the shape that slips past
    // `completeFromQuote`'s own mode check (it only refuses a non-CASH mode).
    const companyId = await seed.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: seed.orgId,
        name: "Configured Finance Co",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        adminFees: 0,
      })
    );
    await seed.t.run((ctx) => ctx.db.patch(quoteId, { mode: undefined, companyId }));

    await expectAppError(completeQuote(seed, quoteId), CODE, MESSAGE);

    await expectNoResidue(seed, v, applicationId, "PENDING_DOCS");
  });
});

// ── T3 ──────────────────────────────────────────────────────────────────────

describe("T3 sales.completeDraft refuses a stored draft that names the application (Codex D1)", () => {
  test("a legacy PENDING draft with the application's own lineage", async () => {
    const seed = await seedDealer("t3");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await applicationIn(seed, quoteId, "APPROVED");

    // `createDraft` never takes a quote (SCRUM-425), so this row can only exist
    // as legacy data: a PENDING sale carrying valid lineage to the deal.
    const draftId = await seed.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
        salespersonId: seed.userId,
        salePrice: PRICE,
        saleDate: Date.now(),
        status: "PENDING" as const,
        quoteId,
        applicationId,
      })
    );
    const before = await rowCounts(seed);

    await expectAppError(completeDraft(seed, draftId), CODE, MESSAGE);

    expect((await seed.t.run((ctx) => ctx.db.get(draftId)))?.status, "the draft stays a draft").toBe("PENDING");
    expect(await vehicleStatus(seed, v)).not.toBe("SOLD");
    expect(await applicationStatus(seed, applicationId)).toBe("APPROVED");
    expect(await rowCounts(seed), "no writes").toEqual(before);
  });
});

// ── T4 ──────────────────────────────────────────────────────────────────────

describe("T4 an application covering several cars holds each of them (Codex D2)", () => {
  test("completing the SECOND car through sales.create is refused", async () => {
    const seed = await seedDealer("t4");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteA = await quoteFor(seed, seed.customerA, [a]);
    const applicationId = await applicationIn(seed, quoteA, "APPROVED");
    const quoteAB = await quoteFor(seed, seed.customerA, [a, b]);

    // `createFromQuote` refuses a multi-vehicle quote, so the second car's
    // acquisition is written by the SAME acquisition function the real door
    // uses, with the FINANCE evidence of the same application, and the
    // application is widened to list both cars.
    await seed.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        vehicleItems: [
          { vehicleId: a, unitPrice: PRICE },
          { vehicleId: b, unitPrice: PRICE },
        ],
      });
      await acquireVehicle(ctx as unknown as MutationCtx, {
        orgId: seed.orgId,
        vehicleId: b,
        customerId: seed.customerA,
        createdBy: seed.userId,
        evidence: { kind: "FINANCE", applicationId },
        lineage: { quoteId: quoteAB },
      });
    });
    const finance = await seed.t.run(async (ctx) =>
      (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
        (c) => c.evidenceKind === "FINANCE" && c.applicationId === applicationId
      )
    );
    expect(finance.map((c) => String(c.vehicleId)).sort(), "precondition: a claim per car").toEqual(
      [String(a), String(b)].sort()
    );

    await expectAppError(directSale(seed, quoteAB, b, seed.customerA), CODE, MESSAGE);

    expect(await salesCount(seed)).toBe(0);
    expect(await vehicleStatus(seed, b)).not.toBe("SOLD");
    expect(await applicationStatus(seed, applicationId)).toBe("APPROVED");
  });
});

// ── T5 ──────────────────────────────────────────────────────────────────────

describe("T5 controls: what must keep working", () => {
  test("a CASH quote with no application completes through all three doors", async () => {
    const seed = await seedDealer("t5a");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const v3 = await vehicle(seed);

    const q1 = await quoteFor(seed, seed.customerA, [v1]);
    await directSale(seed, q1, v1, seed.customerA);
    expect(await vehicleStatus(seed, v1)).toBe("SOLD");

    const q2 = await quoteFor(seed, seed.customerA, [v2]);
    expect(await completeQuote(seed, q2)).toHaveLength(1);
    expect(await vehicleStatus(seed, v2)).toBe("SOLD");

    const draftId = await createDraftFor(seed, v3, seed.customerA);
    await completeDraft(seed, draftId);
    expect(await vehicleStatus(seed, v3)).toBe("SOLD");
  });

  test("a REJECTED application no longer holds the car", async () => {
    const seed = await seedDealer("t5b");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await applicationFor(seed, quoteId);
    await toUnderReview(seed, applicationId);
    await seed.asManager.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });
    expect(await applicationStatus(seed, applicationId), "precondition").toBe("REJECTED");
    await expectFinanceClaimStillActive(seed, v);

    await directSale(seed, quoteId, v, seed.customerA);

    expect(await vehicleStatus(seed, v)).toBe("SOLD");
  });

  test("a CANCELLED application no longer holds the car", async () => {
    const seed = await seedDealer("t5c");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await applicationFor(seed, quoteId);
    await seed.asManager.mutation(api.applications.cancelApplication, {
      idempotencyKey: crypto.randomUUID(),
      orgId: seed.orgId,
      applicationId,
      reason: "customer withdrew",
    });
    expect(await applicationStatus(seed, applicationId), "precondition").toBe("CANCELLED");
    await expectFinanceClaimStillActive(seed, v);

    await directSale(seed, quoteId, v, seed.customerA);

    expect(await vehicleStatus(seed, v)).toBe("SOLD");
  });

  test("finalizeDeal still completes its own APPROVED deal", async () => {
    const seed = await seedDealer("t5d");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    const applicationId = await applicationIn(seed, quoteId, "APPROVED");

    const saleId = await finalizeDeal(seed, applicationId);

    const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.status).toBe("COMPLETED");
    expect(sale?.applicationId).toBe(applicationId);
    expect(await vehicleStatus(seed, v)).toBe("SOLD");
  });
});

// ── T7 ──────────────────────────────────────────────────────────────────────

describe("T7 the refusal is translatable", () => {
  test("ar and en ServerError_ keys exist and en equals the server message", async () => {
    const { dictionaries } = await import("../lib/i18n/dictionaries");
    const key = `ServerError_${CODE}`;
    const en = (dictionaries.en as Record<string, string>)[key];
    const ar = (dictionaries.ar as Record<string, string>)[key];
    expect(en, "en key").toBeTruthy();
    expect(ar, "ar key").toBeTruthy();
    expect(en).toBe(MESSAGE);
    expect(ar).toBe(MESSAGE_AR);
  });
});

// ── T8 ──────────────────────────────────────────────────────────────────────

describe("T8 the completion door cannot be forged by a client", () => {
  test("sales.create rejects an extra `door` argument", async () => {
    const seed = await seedDealer("t8");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await applicationIn(seed, quoteId, "APPROVED");

    await expect(
      directSale(seed, quoteId, v, seed.customerA, {
        door: { kind: "FINANCE_FINALIZATION", applicationId },
      })
    ).rejects.toThrow();

    await expectNoResidue(seed, v, applicationId, "APPROVED");
  });
});
