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
import { seedOrgWithMember } from "../test-utils/seedOrg";
import { expectRetiredDealMode } from "../test-utils/retiredDealMode";
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
  const { orgId, userId, identity } = await seedOrgWithMember(t, {
    clerkId: `rm_${tag}`, permissions: PERMS, orgName: `Retired ${tag}`, roleName: "Owner", memberName: "Retired Modes User",
  });
  // A second member, so a draft can belong to someone other than the acting user
  // (a salesperson may not approve the cancellation of their own sale).
  const sellerId = await t.run(async (ctx) => {
    const role = await ctx.db.query("roles").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    const id = await ctx.db.insert("users", { clerkId: `rm_seller_${tag}`, email: `rm.seller.${tag}@example.com`, name: "Seller" });
    await ctx.db.insert("memberships", { orgId, userId: id, roleId: role!._id });
    return id;
  });
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
  return { t, orgId, userId, sellerId, customerId, vehicleId, asUser: identity };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

type Mode = "CASH" | "MANUAL_FINANCE_COMPANY" | "INTERNAL_INSTALLMENT" | "LEASE";
type Retired = "INTERNAL_INSTALLMENT" | "LEASE";
type Financing = "CASH" | "FINANCED" | "LEASE";
const RETIRED_MODES: Retired[] = ["INTERNAL_INSTALLMENT", "LEASE"];

const saleRows = (s: Seeded) => s.t.run((ctx) => ctx.db.query("sales").collect());
const count = (s: Seeded, table: "quotes" | "sales" | "financeApplications") =>
  s.t.run(async (ctx) => (await ctx.db.query(table).collect()).length);
const vehicleStatus = (s: Seeded) => s.t.run(async (ctx) => (await ctx.db.get(s.vehicleId))?.status);

const saveArgs = (s: Seeded, mode: Mode) => ({
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

/**
 * A quote in `mode`, saved through the real door (so the control is a genuine deal) and, for a
 * retired mode, stamped into that mode afterwards: the legacy shape a quote written before the
 * retirement has, which `saveQuote` can no longer produce.
 */
async function quoteIn(s: Seeded, mode: Mode, opts: { accepted?: boolean } = {}): Promise<Id<"quotes">> {
  const saved = mode === "CASH" || mode === "MANUAL_FINANCE_COMPANY" ? mode : "MANUAL_FINANCE_COMPANY";
  const quoteId = await s.asUser.mutation(api.quotes.saveQuote, saveArgs(s, saved));
  const patch = { ...(saved === mode ? {} : { mode }), ...(opts.accepted ? { status: "ACCEPTED" as const } : {}) };
  if (Object.keys(patch).length > 0) await s.t.run((ctx) => ctx.db.patch(quoteId, patch));
  return quoteId;
}

// ---------------------------------------------------------------------------
describe("quotes.saveQuote", () => {
  test.each(RETIRED_MODES)("%s is refused with the structured code and exact message and nothing is written", async (mode) => {
    const s = await seed(`q_${mode}`);
    const before = await count(s, "quotes");
    await expectRetiredDealMode(s.asUser.mutation(api.quotes.saveQuote, saveArgs(s, mode)));
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
describe("quotes.updateQuoteStatus", () => {
  /** A quote in `mode` linked to a lead and created by the OTHER member, so both the lead advance and the acceptance notification are observable. */
  async function linkedQuote(s: Seeded, mode: Mode) {
    const quoteId = await quoteIn(s, mode);
    const leadId = await s.t.run((ctx) =>
      ctx.db.insert("leads", { orgId: s.orgId, customerId: s.customerId, source: "walk-in", stage: "INTERESTED" })
    );
    await s.t.run((ctx) => ctx.db.patch(quoteId, { leadId, createdBy: s.sellerId }));
    return { quoteId, leadId };
  }
  const quoteStatus = (s: Seeded, id: Id<"quotes">) => s.t.run(async (ctx) => (await ctx.db.get(id))?.status);
  const leadStage = (s: Seeded, id: Id<"leads">) => s.t.run(async (ctx) => (await ctx.db.get(id))?.stage);
  const acceptedNotifications = (s: Seeded) =>
    s.t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.type === "quote.accepted").length);

  for (const mode of RETIRED_MODES) {
    test.each(["SHARED", "ACCEPTED"] as const)(
      `a legacy ${mode} quote cannot be moved to %s and nothing is written`,
      async (status) => {
        const s = await seed(`us_${mode}_${status}`);
        const { quoteId, leadId } = await linkedQuote(s, mode);
        const statusBefore = await quoteStatus(s, quoteId);
        const notificationsBefore = await acceptedNotifications(s);
        await expectRetiredDealMode(s.asUser.mutation(api.quotes.updateQuoteStatus, { orgId: s.orgId, quoteId, status }));
        expect(await quoteStatus(s, quoteId)).toBe(statusBefore);
        expect(await leadStage(s, leadId)).toBe("INTERESTED");
        expect(await acceptedNotifications(s)).toBe(notificationsBefore);
      }
    );

    test(`exit: a legacy ${mode} quote can still be EXPIRED`, async () => {
      const s = await seed(`ue_${mode}`);
      const { quoteId } = await linkedQuote(s, mode);
      await s.asUser.mutation(api.quotes.updateQuoteStatus, { orgId: s.orgId, quoteId, status: "EXPIRED" });
      expect(await quoteStatus(s, quoteId)).toBe("EXPIRED");
    });
  }

  test("control: a CASH quote in the same fixture still goes to SHARED (lead advances) and ACCEPTED (notification sent)", async () => {
    const s = await seed("uc_CASH");
    const { quoteId, leadId } = await linkedQuote(s, "CASH");
    await s.asUser.mutation(api.quotes.updateQuoteStatus, { orgId: s.orgId, quoteId, status: "SHARED" });
    expect(await quoteStatus(s, quoteId)).toBe("SHARED");
    expect(await leadStage(s, leadId)).toBe("NEGOTIATION");
    await s.asUser.mutation(api.quotes.updateQuoteStatus, { orgId: s.orgId, quoteId, status: "ACCEPTED" });
    expect(await quoteStatus(s, quoteId)).toBe("ACCEPTED");
    expect(await acceptedNotifications(s)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("sales doors", () => {
  const saleArgs = (s: Seeded, financingType: Financing) => ({
    orgId: s.orgId,
    vehicleId: s.vehicleId,
    customerId: s.customerId,
    salespersonId: s.userId,
    salePrice: 20_000,
    saleDate: Date.now(),
    financingType,
  });
  const createArgs = (s: Seeded, financingType: Financing, extra: { quoteId?: Id<"quotes"> } = {}) => ({
    ...saleArgs(s, financingType),
    ...extra,
    status: "COMPLETED" as const,
    idempotencyKey: crypto.randomUUID(),
  });
  const draftArgs = (s: Seeded, financingType: Financing) => ({
    ...saleArgs(s, financingType),
    idempotencyKey: crypto.randomUUID(),
  });

  async function insertDraft(s: Seeded, financingType: Financing) {
    return await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.sellerId,
        salePrice: 20_000, saleDate: Date.now(), status: "PENDING", financingType,
      })
    );
  }

  test.each([
    { door: "create", call: (s: Seeded) => s.asUser.mutation(api.sales.create, createArgs(s, "LEASE")) },
    { door: "createDraft", call: (s: Seeded) => s.asUser.mutation(api.sales.createDraft, draftArgs(s, "LEASE")) },
  ])("sales.$door with LEASE is refused with the code and exact message; no sale, vehicle untouched", async ({ door, call }) => {
    const s = await seed(`s_${door}_lease`);
    await expectRetiredDealMode(call(s));
    expect(await saleRows(s)).toEqual([]);
    expect(await vehicleStatus(s)).toBe("AVAILABLE");
  });

  test.each([
    { door: "create", financingType: "CASH", vehicle: "SOLD", call: (s: Seeded) => s.asUser.mutation(api.sales.create, createArgs(s, "CASH")) },
    { door: "createDraft", financingType: "CASH", vehicle: undefined, call: (s: Seeded) => s.asUser.mutation(api.sales.createDraft, draftArgs(s, "CASH")) },
    { door: "createDraft", financingType: "FINANCED", vehicle: undefined, call: (s: Seeded) => s.asUser.mutation(api.sales.createDraft, draftArgs(s, "FINANCED")) },
  ])("control: sales.$door with $financingType succeeds in the same fixture", async ({ door, financingType, vehicle, call }) => {
    const s = await seed(`sc_${door}_${financingType}`);
    await call(s);
    expect((await saleRows(s)).map((r) => r.financingType)).toEqual([financingType]);
    if (vehicle) expect(await vehicleStatus(s)).toBe(vehicle);
  });

  test("sales.update CASH -> LEASE is refused with the code and exact message and the stored value is unchanged", async () => {
    const s = await seed("su_into");
    const saleId = await insertDraft(s, "CASH");
    const before = await s.t.run((ctx) => ctx.db.get(saleId));
    await expectRetiredDealMode(s.asUser.mutation(api.sales.update, { orgId: s.orgId, saleId, financingType: "LEASE" }));
    expect(await s.t.run((ctx) => ctx.db.get(saleId))).toEqual(before);
  });

  test("control: sales.update CASH -> FINANCED succeeds in the same fixture", async () => {
    const s = await seed("su_ctrl");
    const saleId = await insertDraft(s, "CASH");
    await s.asUser.mutation(api.sales.update, { orgId: s.orgId, saleId, financingType: "FINANCED" });
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.financingType).toBe("FINANCED");
  });

  test.each([
    { name: "CANCELLED", patch: { status: "CANCELLED" as const } },
    { name: "edited (price)", patch: { salePrice: 19_500 } },
  ])("a legacy LEASE draft can be $name while the client resends LEASE; LEASE stays stored", async ({ name, patch }) => {
    const s = await seed(`su_${name.slice(0, 4)}`);
    const saleId = await insertDraft(s, "LEASE");
    await s.asUser.mutation(api.sales.update, { orgId: s.orgId, saleId, financingType: "LEASE", ...patch });
    const after = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(after).toMatchObject(patch);
    expect(after?.financingType).toBe("LEASE");
  });

  test.each([
    { financingType: "LEASE" as const, refused: true },
    { financingType: "CASH" as const, refused: false },
  ])("sales.completeDraft on a $financingType draft: refused=$refused", async ({ financingType, refused }) => {
    const s = await seed(`cd_${financingType}`);
    const saleId = await insertDraft(s, financingType);
    const complete = s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId, idempotencyKey: crypto.randomUUID() });
    if (refused) await expectRetiredDealMode(complete);
    else await complete;
    const after = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(after?.status).toBe(refused ? "PENDING" : "COMPLETED");
    expect(await vehicleStatus(s)).toBe(refused ? "AVAILABLE" : "SOLD");
  });

  // D4: a legacy quote in a retired mode must not be turned into a sale by the
  // shared completion boundary either.
  test.each([
    { quoteMode: "INTERNAL_INSTALLMENT", financingType: "FINANCED", refused: true },
    { quoteMode: "LEASE", financingType: "FINANCED", refused: true },
    { quoteMode: "CASH", financingType: "CASH", refused: false },
  ] as const)("sales.create against a $quoteMode quote + $financingType: refused=$refused", async ({ quoteMode, financingType, refused }) => {
    const s = await seed(`sq_${quoteMode}`);
    const quoteId = await quoteIn(s, quoteMode, { accepted: true });
    const create = s.asUser.mutation(api.sales.create, createArgs(s, financingType, { quoteId }));
    if (refused) {
      await expectRetiredDealMode(create);
      expect(await saleRows(s)).toEqual([]);
      expect(await vehicleStatus(s)).toBe("AVAILABLE");
    } else {
      await create;
      expect((await saleRows(s)).map((r) => r.status)).toEqual(["COMPLETED"]);
    }
  });
});

// ---------------------------------------------------------------------------
describe("applications.createFromQuote and cancelApplication", () => {
  test.each([
    { mode: "INTERNAL_INSTALLMENT", refused: true },
    { mode: "LEASE", refused: true },
    { mode: "MANUAL_FINANCE_COMPANY", refused: false },
  ] as const)("createFromQuote on a $mode quote: refused=$refused (nothing written when refused)", async ({ mode, refused }) => {
    const s = await seed(`cf_${mode}`);
    const quoteId = await quoteIn(s, mode);
    const create = s.asUser.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
    if (refused) await expectRetiredDealMode(create);
    else await create;
    expect(await count(s, "financeApplications")).toBe(refused ? 0 : 1);
  });

  test.each(RETIRED_MODES)(
    "a legacy application in %s can still be cancelled (a legacy row is never a dead end)",
    async (mode) => {
      const s = await seed(`ca_${mode}`);
      const quoteId = await quoteIn(s, "MANUAL_FINANCE_COMPANY");
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