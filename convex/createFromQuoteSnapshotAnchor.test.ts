/**
 * SCRUM-533. `createFromQuote` admits a finance application only from a quote that passes `finalizeDeal`'s
 * top-level anchor (SCRUM-528, `quoteAgreesWithSnapshot` in convex/utils/quoteEconomicsAnchor.ts): the
 * quote's vehiclePrice, downPayment, totalFinancedAmount and termMonths strictly equal the snapshot.
 * It adds a create-only monthlyInstallment check (intentional, c21628), and refuses a financed quote
 * with no snapshot. Every refusal is coded and writes nothing.
 */
import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { QUOTE_PRICING_SNAPSHOT_MISMATCH_MESSAGE } from "./utils/quoteEconomicsAnchor";

const MODULES = import.meta.glob("./**/*.*s");

type Env = Awaited<ReturnType<typeof setupEnv>>;

async function setupEnv() {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Anchor Dealer", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "user_anchor", email: "anchor@dealer.com" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asOwner = t.withIdentity({ subject: "user_anchor" });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Anchor", lastName: "Customer" }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN_ANCHOR_${Date.now()}_${Math.random()}`,
      make: "Toyota",
      model: "RAV4",
      year: 2024,
      mileage: 100,
      color: "Silver",
      fuelType: "Hybrid",
      transmission: "Auto",
      purchasePrice: 15_000,
      sellingPrice: 20_000,
      status: "AVAILABLE",
    })
  );
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Salary Slip", isActive: true, order: 1 })
  );
  return { t, orgId, asOwner, customerId, vehicleId, customerStatusId };
}

async function financedQuote() {
  const env = await setupEnv();
  const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = env;
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Anchor Bank",
      profitRate: 5,
      maxTermMonths: 48,
      gracePeriodMonths: 0,
      defaultLtvPercent: 100,
      isActive: true,
      adminFees: 500,
      ruleVersion: 1,
    })
  );
  const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId,
    companyId,
    mode: "CONFIGURED_FINANCE_COMPANY",
    vehiclePrice: 20_000,
    downPayment: 0,
    termMonths: 48,
    customerEligibilityStatusIds: [customerStatusId],
  });
  const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
  return { ...env, quoteId, quote };
}

const create = (env: { asOwner: Env["asOwner"]; orgId: Env["orgId"] }, quoteId: Id<"quotes">) =>
  env.asOwner.mutation(api.applications.createFromQuote, { orgId: env.orgId, quoteId });

/** Every table's rows, so "writes nothing" means the whole database, not a hand-picked list. */
const databaseState = (t: Env["t"]) =>
  t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(schema.tables)) {
      out[table] = await ctx.db.query(table as never).collect();
    }
    return out;
  });

async function expectRefusedWithZeroWrites(env: Awaited<ReturnType<typeof financedQuote>>) {
  const before = await databaseState(env.t);
  await expectAppError(create(env, env.quoteId), "QUOTE_PRICING_SNAPSHOT_MISMATCH", QUOTE_PRICING_SNAPSHOT_MISMATCH_MESSAGE);
  expect(await databaseState(env.t)).toEqual(before);
}

describe("SCRUM-533 createFromQuote anchors the quote to its saved pricing snapshot", () => {
  test("control: exact equality is admitted", async () => {
    const env = await financedQuote();
    expect(await create(env, env.quoteId)).toBeTruthy();
  });

  test("monthlyInstallment undefined with a snapshot is still admitted", async () => {
    const env = await financedQuote();
    await env.t.run((ctx) => ctx.db.patch(env.quoteId, { monthlyInstallment: undefined }));
    expect(await create(env, env.quoteId)).toBeTruthy();
  });

  test.each([
    ["monthlyInstallment", (s: { monthlyInstallment: number }) => ({ monthlyInstallment: s.monthlyInstallment + 5e-5 })],
    ["totalFinancedAmount", (s: { totalFinancedAmount: number }) => ({ totalFinancedAmount: s.totalFinancedAmount + 5e-5 })],
    ["vehiclePrice", (s: { vehiclePrice: number }) => ({ vehiclePrice: s.vehiclePrice + 1 })],
    ["downPayment", (s: { downPayment: number }) => ({ downPayment: s.downPayment + 1 })],
    ["termMonths", (s: { termMonths: number }) => ({ termMonths: s.termMonths + 12 })],
  ])("a quote whose %s drifted from the snapshot is refused and writes nothing", async (_field, patchOf) => {
    const env = await financedQuote();
    const snap = env.quote.customerQuotePricingSnapshot!;
    await env.t.run((ctx) => ctx.db.patch(env.quoteId, patchOf(snap)));
    await expectRefusedWithZeroWrites(env);
  });

  test("a financed quote whose snapshot was removed is refused and writes nothing", async () => {
    const env = await financedQuote();
    await env.t.run((ctx) => ctx.db.patch(env.quoteId, { customerQuotePricingSnapshot: undefined }));
    await expectRefusedWithZeroWrites(env);
  });

  test("control: a cash quote with no snapshot is still admitted", async () => {
    const env = await setupEnv();
    const quoteId = await env.asOwner.mutation(api.quotes.saveQuote, {
      orgId: env.orgId,
      customerId: env.customerId,
      vehicleId: env.vehicleId,
      mode: "CASH",
      vehiclePrice: 20_000,
      downPayment: 0,
      termMonths: 1,
    });
    await env.t.run((ctx) => ctx.db.patch(quoteId, { customerQuotePricingSnapshot: undefined }));
    expect(await create(env, quoteId)).toBeTruthy();
  });

  test("the refusal carries the structured code QUOTE_PRICING_SNAPSHOT_MISMATCH", async () => {
    const env = await financedQuote();
    await env.t.run((ctx) => ctx.db.patch(env.quoteId, { vehiclePrice: 1 }));
    const error = await create(env, env.quoteId).then(
      () => {
        throw new Error("expected a refusal");
      },
      (caught: unknown) => caught as { data?: { code?: string } }
    );
    expect(error.data?.code).toBe("QUOTE_PRICING_SNAPSHOT_MISMATCH");
  });
});
