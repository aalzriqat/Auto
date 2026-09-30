/**
 * SCRUM-495 (owner rulings OR-6 / OR-7): the dealership never self-finances and
 * does not lease, so INTERNAL_INSTALLMENT and LEASE are not deal modes any door
 * may create, update into, submit, complete or finalize.
 *
 * Invariant under test: no NEW quote, application or sale can enter a retired
 * mode. The refusal is the server's, raised BEFORE any write, through the one
 * shared helper (`convex/utils/dealModes.ts`) with ONE message. A legacy row can
 * still be cancelled or rejected (it must always be exitable) and still renders.
 *
 * Every refusal test asserts the EXACT message, asserts that nothing was
 * written, and is paired with a same-fixture allowed-mode control that
 * succeeds — so a refusal cannot be an unrelated failure in disguise.
 *
 * `finalizeDeal` and the closing-readiness check are covered in
 * `financierLegNotApplicable.test.ts`, whose fixtures already walk a deal to the
 * finalize door.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

/** The one refusal every door states. Copied literally so a rewording is a deliberate, visible act. */
const RETIRED_MESSAGE = "Lease and in-house instalment deals are no longer offered. Choose cash or a finance company.";

const PERMS = [
  "create:sales", "view:sales", "edit:sales", "delete:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "view:commissions", "manage:commissions", "approve:requests",
];

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Retired ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `rm_${tag}`, email: `rm.${tag}@example.com`, name: "Retired Modes User" })
  );
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  // A second member, so a draft can belong to someone other than the acting user
  // (a salesperson may not approve the cancellation of their own sale).
  const sellerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `rm_seller_${tag}`, email: `rm.seller.${tag}@example.com`, name: "Seller" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: sellerId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Retired", lastName: tag }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `RMVIN${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: 20_000, status: "AVAILABLE",
      sourceType: "STOCK" as const, purchasePrice: 15_000,
    })
  );
  return {
    t, orgId, userId, sellerId, customerId, vehicleId,
    asUser: t.withIdentity({ subject: `rm_${tag}`, clerkId: `rm_${tag}` }),
  };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

const count = (s: Seeded, table: "quotes" | "sales" | "financeApplications") =>
  s.t.run(async (ctx) => (await ctx.db.query(table).collect()).length);

// ---------------------------------------------------------------------------
describe("quotes.saveQuote", () => {
  const saveArgs = (s: Seeded, mode: "CASH" | "MANUAL_FINANCE_COMPANY" | "INTERNAL_INSTALLMENT" | "LEASE") => ({
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: 20_000,
    downPayment: 2_000,
    termMonths: mode === "CASH" ? 0 : 48,
    mode,
    ...(mode === "MANUAL_FINANCE_COMPANY" ? { manualAdminFees: 0 } : {}),
    totalFinancedAmount: 18_000,
  });

  test.each(["INTERNAL_INSTALLMENT", "LEASE"] as const)("%s is refused with the exact message and nothing is written", async (mode) => {
    const s = await seed(`q_${mode}`);
    const before = await count(s, "quotes");
    await expect(s.asUser.mutation(api.quotes.saveQuote, saveArgs(s, mode))).rejects.toThrow(RETIRED_MESSAGE);
    expect(await count(s, "quotes")).toBe(before);
  });

  test.each(["CASH", "MANUAL_FINANCE_COMPANY"] as const)("control: %s still saves in the same fixture", async (mode) => {
    const s = await seed(`qc_${mode}`);
    const before = await count(s, "quotes");
    const quoteId = await s.asUser.mutation(api.quotes.saveQuote, saveArgs(s, mode));
    expect(await count(s, "quotes")).toBe(before + 1);
    expect((await s.t.run((ctx) => ctx.db.get(quoteId)))?.mode).toBe(mode);
  });
});

// ---------------------------------------------------------------------------
describe("sales doors", () => {
  const saleArgs = (s: Seeded, financingType: "CASH" | "FINANCED" | "LEASE") => ({
    orgId: s.orgId,
    vehicleId: s.vehicleId,
    customerId: s.customerId,
    salespersonId: s.userId,
    salePrice: 20_000,
    saleDate: Date.now(),
    financingType,
  });

  async function saleRows(s: Seeded) {
    return await s.t.run((ctx) => ctx.db.query("sales").collect());
  }
  const vehicleStatus = (s: Seeded) => s.t.run(async (ctx) => (await ctx.db.get(s.vehicleId))?.status);

  async function insertDraft(s: Seeded, financingType: "CASH" | "FINANCED" | "LEASE") {
    return await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.sellerId,
        salePrice: 20_000, saleDate: Date.now(), status: "PENDING", financingType,
      })
    );
  }

  test("sales.create with LEASE is refused with the exact message; no sale, vehicle untouched", async () => {
    const s = await seed("sc_lease");
    await expect(
      s.asUser.mutation(api.sales.create, {
        ...saleArgs(s, "LEASE"), status: "COMPLETED" as const, idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(RETIRED_MESSAGE);
    expect(await saleRows(s)).toEqual([]);
    expect(await vehicleStatus(s)).toBe("AVAILABLE");
  });

  test("control: sales.create with CASH succeeds in the same fixture", async () => {
    const s = await seed("sc_cash");
    await s.asUser.mutation(api.sales.create, {
      ...saleArgs(s, "CASH"), status: "COMPLETED" as const, idempotencyKey: crypto.randomUUID(),
    });
    expect((await saleRows(s)).map((r) => r.financingType)).toEqual(["CASH"]);
    expect(await vehicleStatus(s)).toBe("SOLD");
  });

  test("sales.createDraft with LEASE is refused with the exact message; no sale row", async () => {
    const s = await seed("sd_lease");
    await expect(
      s.asUser.mutation(api.sales.createDraft, { ...saleArgs(s, "LEASE"), idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(RETIRED_MESSAGE);
    expect(await saleRows(s)).toEqual([]);
  });

  test.each(["CASH", "FINANCED"] as const)("control: sales.createDraft with %s succeeds", async (financingType) => {
    const s = await seed(`sd_${financingType}`);
    await s.asUser.mutation(api.sales.createDraft, { ...saleArgs(s, financingType), idempotencyKey: crypto.randomUUID() });
    expect((await saleRows(s)).map((r) => r.financingType)).toEqual([financingType]);
  });

  test("sales.update CASH -> LEASE is refused with the exact message and the stored value is unchanged", async () => {
    const s = await seed("su_into");
    const saleId = await insertDraft(s, "CASH");
    const before = await s.t.run((ctx) => ctx.db.get(saleId));
    await expect(
      s.asUser.mutation(api.sales.update, { orgId: s.orgId, saleId, financingType: "LEASE" })
    ).rejects.toThrow(RETIRED_MESSAGE);
    expect(await s.t.run((ctx) => ctx.db.get(saleId))).toEqual(before);
  });

  test("control: sales.update CASH -> FINANCED succeeds in the same fixture", async () => {
    const s = await seed("su_ctrl");
    const saleId = await insertDraft(s, "CASH");
    await s.asUser.mutation(api.sales.update, { orgId: s.orgId, saleId, financingType: "FINANCED" });
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.financingType).toBe("FINANCED");
  });

  test("a legacy LEASE draft can be CANCELLED while the client resends LEASE; LEASE stays stored", async () => {
    const s = await seed("su_cancel");
    const saleId = await insertDraft(s, "LEASE");
    await s.asUser.mutation(api.sales.update, { orgId: s.orgId, saleId, status: "CANCELLED", financingType: "LEASE" });
    const after = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(after?.status).toBe("CANCELLED");
    expect(after?.financingType).toBe("LEASE");
  });

  test("a legacy LEASE draft can be edited (price) while the client resends LEASE; LEASE stays stored", async () => {
    const s = await seed("su_edit");
    const saleId = await insertDraft(s, "LEASE");
    await s.asUser.mutation(api.sales.update, { orgId: s.orgId, saleId, salePrice: 19_500, financingType: "LEASE" });
    const after = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(after?.salePrice).toBe(19_500);
    expect(after?.financingType).toBe("LEASE");
  });

  test("sales.completeDraft on a legacy LEASE draft is refused; the draft stays PENDING and the vehicle AVAILABLE", async () => {
    const s = await seed("cd_lease");
    const saleId = await insertDraft(s, "LEASE");
    await expect(
      s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId, idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(RETIRED_MESSAGE);
    const after = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(after?.status).toBe("PENDING");
    expect(await vehicleStatus(s)).toBe("AVAILABLE");
  });

  test("control: sales.completeDraft on a CASH draft completes in the same fixture", async () => {
    const s = await seed("cd_cash");
    const saleId = await insertDraft(s, "CASH");
    await s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId, idempotencyKey: crypto.randomUUID() });
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("COMPLETED");
    expect(await vehicleStatus(s)).toBe("SOLD");
  });

  // D4: a legacy quote in a retired mode must not be turned into a sale by the
  // shared completion boundary either.
  describe("a sale linked to a legacy quote in a retired mode", () => {
    async function insertQuote(s: Seeded, mode: "INTERNAL_INSTALLMENT" | "LEASE" | "CASH") {
      return await s.t.run((ctx) =>
        ctx.db.insert("quotes", {
          orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
          vehiclePrice: 20_000, downPayment: 2_000, termMonths: mode === "CASH" ? 0 : 48,
          status: "ACCEPTED", createdBy: s.userId, createdAt: Date.now(), mode,
        })
      );
    }

    test.each(["INTERNAL_INSTALLMENT", "LEASE"] as const)("sales.create against a %s quote + FINANCED is refused; no sale row", async (mode) => {
      const s = await seed(`sq_${mode}`);
      const quoteId = await insertQuote(s, mode);
      await expect(
        s.asUser.mutation(api.sales.create, {
          ...saleArgs(s, "FINANCED"), quoteId, status: "COMPLETED" as const, idempotencyKey: crypto.randomUUID(),
        })
      ).rejects.toThrow(RETIRED_MESSAGE);
      expect(await saleRows(s)).toEqual([]);
      expect(await vehicleStatus(s)).toBe("AVAILABLE");
    });

    test("control: the same fixture with a CASH quote + CASH sale succeeds", async () => {
      const s = await seed("sq_ctrl");
      const quoteId = await insertQuote(s, "CASH");
      await s.asUser.mutation(api.sales.create, {
        ...saleArgs(s, "CASH"), quoteId, status: "COMPLETED" as const, idempotencyKey: crypto.randomUUID(),
      });
      expect((await saleRows(s)).map((r) => r.status)).toEqual(["COMPLETED"]);
    });
  });
});

// ---------------------------------------------------------------------------
describe("applications.createFromQuote and cancelApplication", () => {
  /** A MANUAL quote saved through the real door, so the control is a genuine deal. */
  async function manualQuote(s: Seeded): Promise<Id<"quotes">> {
    return await s.asUser.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
      vehiclePrice: 20_000, downPayment: 2_000, termMonths: 48,
      mode: "MANUAL_FINANCE_COMPANY", manualAdminFees: 0, totalFinancedAmount: 18_000,
    });
  }

  test.each(["INTERNAL_INSTALLMENT", "LEASE"] as const)(
    "a legacy quote in %s is refused with the exact message and no application is written",
    async (mode) => {
      const s = await seed(`cf_${mode}`);
      const quoteId = await manualQuote(s);
      // The legacy shape: a quote that was written before the mode was retired.
      await s.t.run((ctx) => ctx.db.patch(quoteId, { mode }));
      await expect(
        s.asUser.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId })
      ).rejects.toThrow(RETIRED_MESSAGE);
      expect(await count(s, "financeApplications")).toBe(0);
    }
  );

  test("control: the same quote in MANUAL_FINANCE_COMPANY creates its application", async () => {
    const s = await seed("cf_ctrl");
    const quoteId = await manualQuote(s);
    await s.asUser.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
    expect(await count(s, "financeApplications")).toBe(1);
  });

  test.each(["INTERNAL_INSTALLMENT", "LEASE"] as const)(
    "a legacy application in %s can still be cancelled (a legacy row is never a dead end)",
    async (mode) => {
      const s = await seed(`ca_${mode}`);
      const quoteId = await manualQuote(s);
      const applicationId = await s.asUser.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
      await s.t.run(async (ctx) => {
        await ctx.db.patch(quoteId, { mode });
        await ctx.db.patch(applicationId, { quoteModeAtSubmission: mode });
      });
      await s.asUser.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId, reason: "retired mode", idempotencyKey: crypto.randomUUID(),
      });
      expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
    }
  );
});
