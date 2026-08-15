import { TestConvex } from "convex-test";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

/**
 * SCRUM-69 — the sale-completion boundary.
 *
 * A financed deal is supposed to commit through its finance application:
 * handover registered, dealer economics recorded, then `finalizeDeal`. But
 * `sales.create`, `sales.createDraft` -> `sales.completeDraft` and
 * `sales.completeFromQuote` all reach the shared completion path without ever
 * asking whether the quote is financed or whether a lifecycle is in progress.
 * A caller holding `create:sales` can therefore complete a configured quote
 * outright: the sale is COMPLETED, the vehicle is SOLD, the accounting side
 * effects run, and the application is left APPROVED and stranded because its
 * own `finalizeDeal` now fails on an already-sold vehicle.
 *
 * These tests are written to FAIL against the current tree. Every refusal
 * asserted below is a refusal that does not exist yet — that is the point, and
 * a run of this file before the boundary lands is the evidence that the four
 * doors are genuinely open rather than theoretically open.
 *
 * The mode-less cases are not a variant of the configured ones, they are the
 * sharper defect. `quotes.saveQuote` permits `companyId` with no `mode`, and
 * `completeFromQuote` refuses only a mode that is PRESENT and non-CASH — so a
 * quote naming a real finance company with no mode is completed and recorded as
 * `financingType: "CASH"`. That is not a bypassed lifecycle, it is a financed
 * deal written down as a cash one.
 */

type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function createVehicle(
  t: TestConvex,
  orgId: Id<"organizations">,
  vin: string
): Promise<Id<"vehicles">> {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 24_000,
      sellingPrice: 31_000,
      status: "AVAILABLE",
    })
  );
}

async function seedDealer(suffix = "1") {
  const t = convexTestWithComponents(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Boundary Dealer ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `boundary_user_${suffix}`,
      email: `boundary${suffix}@example.com`,
      name: "Boundary User",
    })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `boundary_approver_${suffix}`,
      email: `boundary.approver${suffix}@example.com`,
      name: "Boundary Approver",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Boundary",
      permissions: [
        "view:sales",
        "create:sales",
        "approve:requests",
        "review:finance_application",
        "approve:finance_application",
        "finalize:financed_deal",
        "view:finance_applications",
        "view:customers",
        "register:vehicle_handover",
        "register:expected_payment",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Boundary", lastName: "Customer" })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Configured Finance Co",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    })
  );

  return {
    t,
    orgId,
    userId,
    approverId,
    customerId,
    companyId,
    asUser: t.withIdentity({ subject: `boundary_user_${suffix}`, clerkId: `boundary_user_${suffix}` }),
    asApprover: t.withIdentity({
      subject: `boundary_approver_${suffix}`,
      clerkId: `boundary_approver_${suffix}`,
    }),
  };
}

const PRICE = 31_000;

/** A quote whose mode names a configured finance company. */
async function configuredQuote(seed: Seed, vin: string): Promise<{ quoteId: Id<"quotes">; vehicleId: Id<"vehicles"> }> {
  const vehicleId = await createVehicle(seed.t, seed.orgId, vin);
  const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: seed.companyId,
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 48,
    totalFinancedAmount: PRICE,
  });
  return { quoteId, vehicleId };
}

/**
 * A quote carrying a real finance company with NO mode recorded.
 *
 * Creatable through the ordinary public mutation today, and the shape
 * `settlementPayer` already treats as configured. This is the one that gets
 * written down as CASH.
 */
async function modelessFinancedQuote(
  seed: Seed,
  vin: string
): Promise<{ quoteId: Id<"quotes">; vehicleId: Id<"vehicles"> }> {
  const vehicleId = await createVehicle(seed.t, seed.orgId, vin);
  const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId,
    companyId: seed.companyId,
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 48,
    totalFinancedAmount: PRICE,
  });
  return { quoteId, vehicleId };
}

/** An ordinary cash quote — no financier, no application, nothing to bypass. */
async function cashQuote(seed: Seed, vin: string): Promise<{ quoteId: Id<"quotes">; vehicleId: Id<"vehicles"> }> {
  const vehicleId = await createVehicle(seed.t, seed.orgId, vin);
  const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId,
    mode: "CASH",
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 0,
    totalFinancedAmount: 0,
  });
  return { quoteId, vehicleId };
}

function saleArgs(seed: Seed, quoteId: Id<"quotes">, vehicleId: Id<"vehicles">) {
  return {
    orgId: seed.orgId,
    vehicleId,
    customerId: seed.customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    quoteId,
  };
}

/** The refusal must NAME the reason, not merely reject. */
const COMMITS_THROUGH_APPLICATION = /finance application|through its application|commits through/i;

describe("SCRUM-69: a financed deal commits through its finance application", () => {
  describe("sales.create", () => {
    test("refuses a configured quote", async () => {
      const seed = await seedDealer("create-cfg");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000001");

      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...saleArgs(seed, quoteId, vehicleId),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });

    test("refuses a mode-less quote that names a finance company", async () => {
      const seed = await seedDealer("create-modeless");
      const { quoteId, vehicleId } = await modelessFinancedQuote(seed, "BND0000000000002");

      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...saleArgs(seed, quoteId, vehicleId),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });
  });

  describe("sales.createDraft -> sales.completeDraft", () => {
    test("refuses a configured quote", async () => {
      const seed = await seedDealer("draft-cfg");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000003");

      // The refusal may land at either step. What must NOT happen is a
      // COMPLETED sale: a draft that can never be completed is acceptable, a
      // completed one is the defect.
      await expect(
        (async () => {
          const saleId = await seed.asUser.mutation(api.sales.createDraft, {
            ...saleArgs(seed, quoteId, vehicleId),
          });
          await seed.asUser.mutation(api.sales.completeDraft, { orgId: seed.orgId, saleId });
        })()
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });

    test("refuses a mode-less quote that names a finance company", async () => {
      const seed = await seedDealer("draft-modeless");
      const { quoteId, vehicleId } = await modelessFinancedQuote(seed, "BND0000000000004");

      await expect(
        (async () => {
          const saleId = await seed.asUser.mutation(api.sales.createDraft, {
            ...saleArgs(seed, quoteId, vehicleId),
          });
          await seed.asUser.mutation(api.sales.completeDraft, { orgId: seed.orgId, saleId });
        })()
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });
  });

  describe("sales.completeFromQuote", () => {
    test("refuses a configured quote", async () => {
      const seed = await seedDealer("cfq-cfg");
      const { quoteId } = await configuredQuote(seed, "BND0000000000005");

      await expect(
        seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });

    test("refuses a mode-less financed quote instead of recording it as CASH", async () => {
      // The worst of the four. `completeFromQuote` checks only for a mode that
      // is PRESENT and non-CASH, so this quote passes and the sale is written
      // down as `financingType: "CASH"` — a financed deal misstated as a cash
      // one, not merely a skipped lifecycle.
      const seed = await seedDealer("cfq-modeless");
      const { quoteId } = await modelessFinancedQuote(seed, "BND0000000000006");

      await expect(
        seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });
  });

  describe("the boundary derives authority from lifecycle state, not from its caller", () => {
    test("a matching application is NOT enough — missing prerequisites are still refused", async () => {
      // The case that separates a real derivation from a row lookup.
      //
      // This quote HAS its finance application, and it is APPROVED. What it
      // does not have is a registered handover or recorded dealer economics.
      // A boundary that admits the sale because an application exists is not
      // checking lifecycle state, it is checking for a row — and a design that
      // exempted a "trusted caller" flag could never fail this test, which is
      // why it exists.
      const seed = await seedDealer("prereq");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000007");

      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });
      await seed.asUser.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId,
        status: "UNDER_REVIEW",
      });
      await seed.asApprover.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId,
        status: "APPROVED",
      });

      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...saleArgs(seed, quoteId, vehicleId),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);

      // And the application is left intact rather than stranded.
      const app = await seed.t.run((ctx) => ctx.db.get(applicationId));
      expect(app?.status).toBe("APPROVED");
      expect(app?.finalizedSaleId).toBeUndefined();
    });
  });

  describe("the refusal is not widened into a different defect", () => {
    test("an ordinary CASH quote still completes through sales.create", async () => {
      const seed = await seedDealer("cash-create");
      const { quoteId, vehicleId } = await cashQuote(seed, "BND0000000000008");

      const saleId = await seed.asUser.mutation(api.sales.create, {
        ...saleArgs(seed, quoteId, vehicleId),
        status: "COMPLETED" as const,
      });
      const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
      expect(sale?.status).toBe("COMPLETED");
    });

    test("an ordinary CASH quote still completes through the draft path", async () => {
      const seed = await seedDealer("cash-draft");
      const { quoteId, vehicleId } = await cashQuote(seed, "BND0000000000009");

      const saleId = await seed.asUser.mutation(api.sales.createDraft, {
        ...saleArgs(seed, quoteId, vehicleId),
      });
      await seed.asUser.mutation(api.sales.completeDraft, { orgId: seed.orgId, saleId });
      const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
      expect(sale?.status).toBe("COMPLETED");
    });

    test("an ordinary CASH quote still completes through completeFromQuote", async () => {
      const seed = await seedDealer("cash-cfq");
      const { quoteId } = await cashQuote(seed, "BND0000000000010");

      await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });
      const sales = await seed.t.run((ctx) =>
        ctx.db
          .query("sales")
          .filter((q) => q.eq(q.field("orgId"), seed.orgId))
          .collect()
      );
      expect(sales.some((s) => s.status === "COMPLETED")).toBe(true);
    });

    test("finalizeDeal still completes its own deal through the same boundary", async () => {
      // The authorized path, and the one the boundary must not close. It is
      // authorized because its deal SATISFIES the requirement, not because the
      // caller asserted anything about itself.
      const seed = await seedDealer("finalize");
      const { quoteId } = await configuredQuote(seed, "BND0000000000011");

      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });
      await seed.asUser.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId,
        status: "UNDER_REVIEW",
      });
      await seed.asApprover.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId,
        status: "APPROVED",
      });
      await registerHandover(seed.asUser, api, seed.orgId, applicationId);
      await seed.asUser.mutation(api.applications.registerExpectedPayment, {
        orgId: seed.orgId,
        applicationId,
        method: "CASH",
        expectedDate: Date.now(),
      });

      const saleId = await seed.asUser.mutation(api.applications.finalizeDeal, {
        orgId: seed.orgId,
        applicationId,
      });
      const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
      expect(sale?.status).toBe("COMPLETED");
    });
  });
});
