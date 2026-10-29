/**
 * SCRUM-858 S1 (owner ruling SCRUM-858#c23884, 2026-10-29): named refundable
 * security and reservation deposits, opened per customer through the existing
 * opening-balance draft and approval flow.
 *
 * Every test here drives the public mutations and queries. The harness is
 * convex-test: serial, no OCC, so these prove logic, not production concurrency.
 */
import { expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import { CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED } from "./utils/customerCreditPayoutContainment";
import { SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED } from "./utils/customerCreditPayoutContainment";
import { DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED } from "./utils/depositOtherContainment";
import { applyOpeningDepositsToSale } from "./utils/openingDepositApplication";
import { payOutDepositSlice } from "./utils/depositHelpers";
import { reverseDepositApplicationsForSale } from "./utils/depositApplications";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const GLOB = import.meta.glob("./**/*.ts");

async function seed() {
  const t = convexTestWithComponents(schema, GLOB);
  const ownerRole = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "OWNER");
  if (!ownerRole) throw new Error("Missing native owner template");
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Opening deposits org", createdAt: Date.now() }),
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const ownerUserId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "od_owner", email: "od_owner@test.com", name: "Owner" }),
  );
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: [...ownerRole.permissions],
      isSystemOwnerRole: true,
    }),
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerUserId, roleId: ownerRoleId }));
  // The accountant who approves: a second person with finance authority.
  const accountantUserId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "od_accountant", email: "od_acc@test.com", name: "Accountant" }),
  );
  const accountantRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: [...ownerRole.permissions] }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId: accountantUserId, roleId: accountantRoleId }),
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    }),
  );
  const owner = t.withIdentity({ subject: "od_owner" });
  const accountant = t.withIdentity({ subject: "od_accountant" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId });
  const bySystemKey = (key: string) => {
    const found = accounts.find((account) => account.systemKey === key);
    if (!found) throw new Error(`Missing system account ${key}`);
    return found._id;
  };
  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Security" }),
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Omar", lastName: "Reservation" }),
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Synthetic",
      model: "Opening reservation car",
      year: 2024,
      mileage: 0,
      color: "Gray",
      fuelType: "Gas",
      transmission: "Auto",
      sellingPrice: 100,
      status: "AVAILABLE",
      vin: "OPENDEP0000000001",
    }),
  );
  const otherVehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Synthetic",
      model: "Other car",
      year: 2024,
      mileage: 0,
      color: "Gray",
      fuelType: "Gas",
      transmission: "Auto",
      sellingPrice: 100,
      status: "AVAILABLE",
      vin: "OPENDEP0000000002",
    }),
  );
  return {
    t,
    orgId,
    owner,
    accountant,
    ownerUserId,
    cash: bySystemKey("CASH_ON_HAND"),
    deposits: bySystemKey("CUSTOMER_DEPOSITS_LIABILITY"),
    customerA,
    customerB,
    vehicleId,
    otherVehicleId,
  };
}
type Seed = Awaited<ReturnType<typeof seed>>;

function securityRow(s: Seed, over: Record<string, unknown> = {}) {
  return {
    kind: "CUSTOMER_DEPOSIT" as const,
    rowKey: "dep-security-1",
    accountId: s.deposits,
    customerId: s.customerA,
    amountMinor: 100_000,
    depositKind: "SECURITY" as const,
    title: "Security deposit",
    ...over,
  };
}
function reservationRow(s: Seed, over: Record<string, unknown> = {}) {
  return {
    kind: "CUSTOMER_DEPOSIT" as const,
    rowKey: "opening-deposit-row-1",
    accountId: s.deposits,
    customerId: s.customerB,
    amountMinor: 50_000,
    depositKind: "RESERVATION" as const,
    vehicleId: s.vehicleId,
    title: "Reservation deposit",
    ...over,
  };
}
function linesFor(s: Seed, totalMinor: number) {
  return [
    { accountId: s.cash, debitMinor: totalMinor, creditMinor: 0 },
    { accountId: s.deposits, debitMinor: 0, creditMinor: totalMinor },
  ];
}
async function counts(s: Seed) {
  return s.t.run(async (ctx) => ({
    deposits: (await ctx.db.query("deposits").collect()).length,
    drafts: (await ctx.db.query("openingBalanceDrafts").collect()).length,
    journals: (await ctx.db.query("journalEntries").collect()).length,
    lines: (await ctx.db.query("journalLines").collect()).length,
    transactions: (await ctx.db.query("transactions").collect()).length,
    canonicalPayments: (await ctx.db.query("canonicalPayments").collect()).length,
    collectionPayments: (await ctx.db.query("collectionPayments").collect()).length,
    holds: (await ctx.db.query("depositVehicleHolds").collect()).length,
    applications: (await ctx.db.query("depositApplications").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
  }));
}
async function draftAndApprove(s: Seed, allocations: unknown[], totalMinor: number) {
  const { draftId } = await s.owner.mutation(api.accountingCutover.draftOpeningBalance, {
    orgId: s.orgId,
    expectedCurrency: "JOD",
    asOfDate: Date.now(),
    lines: linesFor(s, totalMinor),
    allocations: allocations as never,
  });
  return draftId;
}
function draftCall(s: Seed, allocations: unknown[], totalMinor: number) {
  return s.owner.mutation(api.accountingCutover.draftOpeningBalance, {
    orgId: s.orgId,
    expectedCurrency: "JOD",
    asOfDate: Date.now(),
    lines: linesFor(s, totalMinor),
    allocations: allocations as never,
  });
}
async function postNamedDeposits(s: Seed) {
  const draftId = await draftAndApprove(s, [securityRow(s), reservationRow(s)], 150_000);
  const before = await counts(s);
  expect(before.deposits).toBe(0);
  await s.accountant.mutation(api.accountingCutover.approveOpeningBalance, {
    orgId: s.orgId,
    draftId: draftId as Id<"openingBalanceDrafts">,
  });
  return draftId;
}

test("a named opening deposit materialises one HELD native row per customer only after accountant approval, with no cash, payment, voucher or extra GL line", async () => {
  const s = await seed();
  const draftId = await draftAndApprove(s, [securityRow(s), reservationRow(s)], 150_000);
  const pending = await counts(s);
  expect(pending.deposits).toBe(0);
  expect(pending.journals).toBe(0);

  await s.accountant.mutation(api.accountingCutover.approveOpeningBalance, {
    orgId: s.orgId,
    draftId: draftId as Id<"openingBalanceDrafts">,
  });
  const after = await counts(s);
  expect(after.deposits).toBe(2);
  expect(after.journals).toBe(1);
  expect(after.lines).toBe(2);
  expect(after.transactions).toBe(0);
  expect(after.canonicalPayments).toBe(0);
  expect(after.collectionPayments).toBe(0);
  expect(after.holds).toBe(0);
  expect(after.applications).toBe(0);
  expect(after.events).toBe(0);

  const rows = await s.t.run((ctx) => ctx.db.query("deposits").collect());
  const security = rows.find((row) => row.customerId === s.customerA);
  const reservation = rows.find((row) => row.customerId === s.customerB);
  expect(security).toMatchObject({
    origin: "OPENING",
    openingRowKey: "dep-security-1",
    openingDepositKind: "SECURITY",
    status: "HELD",
    holdActive: false,
    usesVehicleHoldRows: false,
    amountMinor: 100_000,
    currency: "JOD",
  });
  expect(security?.vehicleId).toBeUndefined();
  expect(security?.quoteId).toBeUndefined();
  expect(security?.method).toBeUndefined();
  expect(reservation).toMatchObject({
    origin: "OPENING",
    openingDepositKind: "RESERVATION",
    vehicleId: s.vehicleId,
    status: "HELD",
    holdActive: false,
    amountMinor: 50_000,
  });
  const draft = await s.t.run((ctx) => ctx.db.get(draftId as Id<"openingBalanceDrafts">));
  expect(draft?.allocationResults).toEqual([
    { kind: "CUSTOMER_DEPOSIT", rowKey: "dep-security-1", depositId: security?._id },
    { kind: "CUSTOMER_DEPOSIT", rowKey: "opening-deposit-row-1", depositId: reservation?._id },
  ]);
});

test("the owner's direct post refuses named deposits with a coded error before any write; the draft and approval route still posts them (F1, c23884)", async () => {
  const s = await seed();
  const baseline = await counts(s);
  for (const rows of [[securityRow(s)], [reservationRow(s)], [securityRow(s), reservationRow(s)]]) {
    const total = rows.reduce((sum, row) => sum + row.amountMinor, 0);
    await expect(
      s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId: s.orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: linesFor(s, total),
        allocations: rows as never,
      }),
    ).rejects.toMatchObject({ data: { code: "OPENING_DEPOSIT_DIRECT_POST_REFUSED" } });
    // No journal, no draft, no deposit row, no application, nothing.
    expect(await counts(s)).toEqual(baseline);
  }

  // The refusal leaves the org able to open the same rows through the approval route.
  await postNamedDeposits(s);
  const after = await counts(s);
  expect(after.deposits).toBe(2);
  expect(after.journals).toBe(1);
  const draft = await s.t.run(async (ctx) => (await ctx.db.query("openingBalanceDrafts").collect())[0]);
  expect(draft?.status).toBe("POSTED");
  expect(draft?.autoApproved).toBe(false);
});

test("a named opening deposit that fails validation leaves no draft, row, journal or payment behind", async () => {
  const s = await seed();
  const foreignOrg = await s.t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Foreign org", createdAt: Date.now() }),
  );
  const foreignCustomer = await s.t.run((ctx) =>
    ctx.db.insert("customers", { orgId: foreignOrg, firstName: "Foreign", lastName: "Customer" }),
  );
  const foreignVehicle = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: foreignOrg,
      make: "Foreign",
      model: "Car",
      year: 2024,
      mileage: 0,
      color: "Gray",
      fuelType: "Gas",
      transmission: "Auto",
      sellingPrice: 1,
      status: "AVAILABLE",
    }),
  );
  const sourced = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId,
      make: "Sourced",
      model: "Car",
      year: 2024,
      mileage: 0,
      color: "Gray",
      fuelType: "Gas",
      transmission: "Auto",
      sellingPrice: 1,
      status: "AVAILABLE",
      sourceType: "SOURCED",
    }),
  );
  const deletedCustomer = await s.t.run((ctx) =>
    ctx.db.insert("customers", { orgId: s.orgId, firstName: "Gone", lastName: "Customer", isDeleted: true }),
  );
  const baseline = await counts(s);
  const cases: Array<[string, unknown[], number, RegExp]> = [
    ["foreign customer", [securityRow(s, { customerId: foreignCustomer })], 100_000, /Opening customer not found/],
    ["foreign vehicle", [reservationRow(s, { vehicleId: foreignVehicle })], 50_000, /Opening deposit vehicle not found/],
    ["sourced vehicle", [reservationRow(s, { vehicleId: sourced })], 50_000, /live vehicle that the dealership can hold/],
    ["deleted customer", [securityRow(s, { customerId: deletedCustomer })], 100_000, /Opening customer is unavailable/],
    ["duplicate row key", [securityRow(s), reservationRow(s, { rowKey: "dep-security-1" })], 150_000, /row keys must be unique/],
    ["sum mismatch", [securityRow(s), reservationRow(s)], 160_000, /exactly match their declared control balance/],
    ["zero amount", [securityRow(s, { amountMinor: 0 })], 100_000, /positive whole minor-unit/],
    ["fractional amount", [securityRow(s, { amountMinor: 100_000.5 })], 100_000, /positive whole minor-unit/],
    ["security with a vehicle", [securityRow(s, { vehicleId: s.vehicleId })], 100_000, /Only a reservation deposit can name a vehicle/],
    [
      "duplicate customer and vehicle reservation",
      [reservationRow(s), reservationRow(s, { rowKey: "opening-deposit-row-2" })],
      100_000,
      /only once per customer and vehicle/,
    ],
    [
      "unnamed pool mixed on the same control",
      [
        securityRow(s),
        {
          kind: "UNALLOCATED_LIABILITY" as const,
          rowKey: "pool-1",
          accountId: s.deposits,
          amountMinor: 50_000,
          purpose: "CUSTOMER_DEPOSIT" as const,
          title: "Unnamed pool",
        },
      ],
      150_000,
      /one explicitly declared allocation family/,
    ],
  ];
  for (const [label, allocations, total, refusal] of cases) {
    // A business refusal, not the argument validator rejecting an unknown shape.
    await expect(draftCall(s, allocations, total), label).rejects.toThrow(refusal);
    expect(await counts(s), label).toEqual(baseline);
  }
});

test("a named opening deposit cannot sit on a custom liability account", async () => {
  const s = await seed();
  const custom = await s.owner.mutation(api.chartOfAccounts.create, {
    orgId: s.orgId,
    code: "2999",
    name: "Custom deposits",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    currencyRestriction: "JOD",
    isControlAccount: true,
    allowManualPosting: false,
  });
  const baseline = await counts(s);
  await expect(
    s.owner.mutation(api.accountingCutover.draftOpeningBalance, {
      orgId: s.orgId,
      expectedCurrency: "JOD",
      asOfDate: Date.now(),
      lines: [
        { accountId: s.cash, debitMinor: 100_000, creditMinor: 0 },
        { accountId: custom, debitMinor: 0, creditMinor: 100_000 },
      ],
      allocations: [securityRow(s, { accountId: custom })] as never,
    }),
  ).rejects.toThrow(/does not match its active control account/);
  expect(await counts(s)).toEqual(baseline);
});

test("release, forfeit and void of an opening deposit refuse server-side with a coded refusal before any write, and the pilot switches are unchanged", async () => {
  expect(CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED).toBe(true);
  expect(SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED).toBe(true);
  expect(DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED).toBe(true);

  const s = await seed();
  await postNamedDeposits(s);
  const rows = await s.t.run((ctx) => ctx.db.query("deposits").collect());
  const baseline = await counts(s);
  const before = await s.t.run((ctx) => ctx.db.query("deposits").collect());
  for (const row of rows) {
    for (const resolution of ["REFUNDED", "FORFEITED"] as const) {
      await expect(
        s.accountant.mutation(api.deposits.release, {
          orgId: s.orgId,
          depositId: row._id,
          resolution,
          ...(resolution === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
          idempotencyKey: `od-release-${row._id}-${resolution}`,
        }),
      ).rejects.toMatchObject({ data: { code: "OPENING_DEPOSIT_PAYOUT_REFUSED" } });
    }
    await expect(
      s.accountant.mutation(api.deposits.voidDeposit, { orgId: s.orgId, depositId: row._id }),
    ).rejects.toMatchObject({ data: { code: "OPENING_DEPOSIT_PAYOUT_REFUSED" } });
  }
  expect(await counts(s)).toEqual(baseline);
  expect(await s.t.run((ctx) => ctx.db.query("deposits").collect())).toEqual(before);
});

test("the deposits reconciliation matches the control to the opening rows and labels any difference without posting", async () => {
  const s = await seed();
  await postNamedDeposits(s);
  const clean = await s.owner.query(api.accountingReports.customerDepositsReconciliation, {
    orgId: s.orgId,
  });
  expect(clean.isReconciled).toBe(true);
  expect(clean.byCurrency.JOD).toMatchObject({
    glBalanceMinor: 150_000,
    subledgerBalanceMinor: 150_000,
    discrepancyMinor: 0,
  });
  expect(clean.attributionStatus).toBe("ATTRIBUTED");
  expect(clean.unexplainedOpeningDifference).toBeNull();

  // Drift the subledger side only. Nothing may be posted to hide it.
  const journalsBefore = (await counts(s)).journals;
  const linesBefore = (await counts(s)).lines;
  const row = await s.t.run(async (ctx) =>
    (await ctx.db.query("deposits").collect()).find((d) => d.customerId === s.customerA),
  );
  if (!row) throw new Error("Missing opening deposit");
  await s.t.run((ctx) => ctx.db.patch(row._id, { amountMinor: 90_000, amount: 90 }));
  const drift = await s.owner.query(api.accountingReports.customerDepositsReconciliation, {
    orgId: s.orgId,
  });
  expect(drift.isReconciled).toBe(false);
  expect(drift.byCurrency.JOD.discrepancyMinor).toBe(10_000);
  expect(drift.unexplainedOpeningDifference).toEqual({
    label: {
      en: "Unexplained opening-balance reconciliation difference",
      ar: "فرق أرصدة افتتاحية غير مفسر قيد المطابقة",
    },
    currencies: ["JOD"],
  });
  const after = await counts(s);
  expect(after.journals).toBe(journalsBefore);
  expect(after.lines).toBe(linesBefore);
});

// ── Sale consumption (the only door that spends an opening deposit) ─────────────────────────────

const SALE_PRICE = 100; // JOD; equals a 100_000 minor-unit reservation
const SALE_DATE = Date.now(); // fixed so a replayed request has the same fingerprint
function sell(
  s: Seed,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">,
  key: string = crypto.randomUUID(),
  quoteId?: Id<"quotes">,
) {
  return s.owner.mutation(api.sales.create, {
    idempotencyKey: key,
    orgId: s.orgId,
    vehicleId,
    customerId,
    salespersonId: s.ownerUserId,
    salePrice: SALE_PRICE,
    saleDate: SALE_DATE,
    status: "COMPLETED" as const,
    ...(quoteId ? { quoteId } : {}),
  });
}
async function postOne(s: Seed, row: Record<string, unknown>, totalMinor: number) {
  const draftId = await draftAndApprove(s, [row], totalMinor);
  await s.accountant.mutation(api.accountingCutover.approveOpeningBalance, {
    orgId: s.orgId,
    draftId: draftId as Id<"openingBalanceDrafts">,
  });
}
const REFUSED_UNPAID = /full payment is recorded as a deposit/;

test("a reservation deposit pays the named car's cash sale once: APPLIED, one application, liability released, replay and second pass add nothing", async () => {
  const s = await seed();
  await postOne(s, reservationRow(s, { amountMinor: 100_000 }), 100_000);

  const saleId = await sell(s, s.vehicleId, s.customerB, "od-sale-1");
  const deposit = await s.t.run(async (ctx) => (await ctx.db.query("deposits").collect())[0]);
  expect(deposit).toMatchObject({ status: "APPLIED", holdActive: false, resolutionSaleId: saleId, origin: "OPENING" });
  const applications = await s.t.run((ctx) => ctx.db.query("depositApplications").collect());
  expect(applications).toHaveLength(1);
  expect(applications[0]).toMatchObject({
    depositId: deposit._id,
    saleId,
    customerId: s.customerB,
    vehicleId: s.vehicleId,
    amountMinor: 100_000,
    treatment: "CUSTOMER_RECEIVABLE",
    status: "APPLIED",
  });

  // The liability is released exactly once and the subledger agrees with the control.
  const recon = await s.owner.query(api.accountingReports.customerDepositsReconciliation, { orgId: s.orgId });
  expect(recon.byCurrency.JOD).toMatchObject({ glBalanceMinor: 0, subledgerBalanceMinor: 0, discrepancyMinor: 0 });
  expect(recon.isReconciled).toBe(true);

  // A retried request and a second pass over the same customer take nothing more.
  expect(await sell(s, s.vehicleId, s.customerB, "od-sale-1")).toBe(saleId);
  const again = await s.t.run((ctx) =>
    applyOpeningDepositsToSale(ctx, {
      orgId: s.orgId,
      customerId: s.customerB,
      vehicleId: s.vehicleId,
      saleId,
      currency: "JOD",
      capMinor: 100_000,
      actorId: s.ownerUserId,
      occurredAt: Date.now(),
    }),
  );
  expect(again).toEqual([]);
  expect(await s.t.run((ctx) => ctx.db.query("depositApplications").collect())).toHaveLength(1);
  const recon2 = await s.owner.query(api.accountingReports.customerDepositsReconciliation, { orgId: s.orgId });
  expect(recon2.byCurrency.JOD.glBalanceMinor).toBe(0);
});

test("an opening deposit that does not belong to this sale pays nothing: other car, security kind, or a row larger than the bill", async () => {
  const s = await seed();
  await postOne(s, reservationRow(s, { amountMinor: 100_000 }), 100_000);
  const baseline = await counts(s);

  // Reserved for another car.
  await expect(sell(s, s.otherVehicleId, s.customerB)).rejects.toThrow(REFUSED_UNPAID);
  expect(await counts(s)).toEqual(baseline);
  expect((await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0]?.status).toBe("HELD");

  // Someone else's customer credit is not this customer's.
  await expect(sell(s, s.vehicleId, s.customerA)).rejects.toThrow(REFUSED_UNPAID);
  expect(await counts(s)).toEqual(baseline);

  // A row larger than the bill is never taken part-way: it stays HELD.
  const s2 = await seed();
  await postOne(s2, reservationRow(s2, { amountMinor: 150_000 }), 150_000);
  const baseline2 = await counts(s2);
  await expect(sell(s2, s2.vehicleId, s2.customerB)).rejects.toThrow(REFUSED_UNPAID);
  expect(await counts(s2)).toEqual(baseline2);
  expect((await s2.t.run((ctx) => ctx.db.query("deposits").collect()))[0]?.status).toBe("HELD");

  // A security deposit is never spent on a car.
  const s3 = await seed();
  await postOne(s3, securityRow(s3, { customerId: s3.customerB, amountMinor: 100_000 }), 100_000);
  const baseline3 = await counts(s3);
  await expect(sell(s3, s3.vehicleId, s3.customerB)).rejects.toThrow(REFUSED_UNPAID);
  expect(await counts(s3)).toEqual(baseline3);
  expect((await s3.t.run((ctx) => ctx.db.query("deposits").collect()))[0]?.status).toBe("HELD");
});

test("a reservation with no VIN is customer credit: applied to that customer's sale, never to another customer's", async () => {
  const s = await seed();
  await postOne(s, reservationRow(s, { amountMinor: 100_000, vehicleId: undefined }), 100_000);
  const row = (await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0];
  expect(row?.vehicleId).toBeUndefined();
  await expect(sell(s, s.vehicleId, s.customerA)).rejects.toThrow(REFUSED_UNPAID);
  const saleId = await sell(s, s.otherVehicleId, s.customerB);
  const after = (await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0];
  expect(after).toMatchObject({ status: "APPLIED", resolutionSaleId: saleId });
});

test("cancelling a sale that applied an opening deposit refuses with a coded error before any write", async () => {
  const s = await seed();
  await postOne(s, reservationRow(s, { amountMinor: 100_000 }), 100_000);
  const saleId = await sell(s, s.vehicleId, s.customerB);
  const baseline = await counts(s);
  const depositsBefore = await s.t.run((ctx) => ctx.db.query("deposits").collect());
  const salesBefore = await s.t.run((ctx) => ctx.db.query("sales").collect());

  await expect(
    s.accountant.mutation(api.sales.update, { orgId: s.orgId, saleId, status: "CANCELLED" as const }),
  ).rejects.toMatchObject({ data: { code: "OPENING_DEPOSIT_REVERSAL_REFUSED" } });

  expect(await counts(s)).toEqual(baseline);
  expect(await s.t.run((ctx) => ctx.db.query("deposits").collect())).toEqual(depositsBefore);
  expect(await s.t.run((ctx) => ctx.db.query("sales").collect())).toEqual(salesBefore);
});
test("the payout executor and the application reversal each refuse an opening deposit by themselves, behind the doors", async () => {
  const s = await seed();
  await postOne(s, reservationRow(s, { amountMinor: 100_000 }), 100_000);
  const deposit = (await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0];
  const baseline = await counts(s);

  // payOutDepositSlice is the executor every refund and forfeiture reaches; called directly, with every door bypassed.
  await expect(
    s.t.run((ctx) =>
      payOutDepositSlice(ctx, {
        orgId: s.orgId,
        deposit,
        holdId: "unused-hold" as unknown as Id<"depositVehicleHolds">,
        vehicleId: s.vehicleId,
        amountMinor: 50_000,
        currency: "JOD",
        resolution: "REFUNDED",
        refundMethod: "CASH",
        actorId: s.ownerUserId,
        occurredAt: Date.now(),
      }),
    ),
  ).rejects.toMatchObject({ data: { code: "OPENING_DEPOSIT_PAYOUT_REFUSED" } });
  expect(await counts(s)).toEqual(baseline);

  // Reversing the application of an opening deposit is refused for the whole sale, whichever door asks.
  const saleId = await sell(s, s.vehicleId, s.customerB);
  const afterSale = await counts(s);
  await expect(
    s.t.run((ctx) =>
      reverseDepositApplicationsForSale(ctx, {
        orgId: s.orgId,
        saleId,
        reason: "test",
        actorId: s.ownerUserId,
        reversalDate: Date.now(),
      }),
    ),
  ).rejects.toMatchObject({ data: { code: "OPENING_DEPOSIT_REVERSAL_REFUSED" } });
  expect(await counts(s)).toEqual(afterSale);
  const applications = await s.t.run((ctx) => ctx.db.query("depositApplications").collect());
  expect(applications.map((a) => a.status)).toEqual(["APPLIED"]);
});
async function quoteWithReceiptDeposit(s: Seed, amount: number) {
  const quoteId = await s.t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: s.orgId,
      customerId: s.customerB,
      vehicleId: s.vehicleId,
      vehiclePrice: SALE_PRICE,
      downPayment: 0,
      termMonths: 0,
      status: "ACCEPTED",
      createdBy: s.ownerUserId,
      createdAt: Date.now(),
    }),
  );
  await s.owner.mutation(api.deposits.create, {
    idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId,
    quoteId,
    amount,
    method: "CASH" as const,
  });
  return quoteId;
}

test("a receipt deposit on the quote and an opening reservation together pay one cash sale; an opening row that overshoots the remainder stays HELD", async () => {
  const s = await seed();
  await postOne(s, reservationRow(s, { amountMinor: 60_000 }), 60_000);
  const quoteId = await quoteWithReceiptDeposit(s, 40);
  const saleId = await sell(s, s.vehicleId, s.customerB, "od-mixed-1", quoteId);
  const rows = await s.t.run((ctx) => ctx.db.query("deposits").collect());
  expect(rows.map((r) => r.status).sort()).toEqual(["APPLIED", "APPLIED"]);
  expect(rows.every((r) => r.resolutionSaleId === saleId)).toBe(true);
  const applications = await s.t.run((ctx) => ctx.db.query("depositApplications").collect());
  expect(applications.map((a) => a.amountMinor).sort((a, b) => a - b)).toEqual([40_000, 60_000]);

  // 40 + 70 would exceed the 100 bill: the opening row is not taken part-way, so the sale is refused unpaid.
  const s2 = await seed();
  await postOne(s2, reservationRow(s2, { amountMinor: 70_000 }), 70_000);
  const quote2 = await quoteWithReceiptDeposit(s2, 40);
  const baseline = await counts(s2);
  await expect(sell(s2, s2.vehicleId, s2.customerB, "od-mixed-2", quote2)).rejects.toThrow(REFUSED_UNPAID);
  expect(await counts(s2)).toEqual(baseline);
  const heldRows = await s2.t.run((ctx) => ctx.db.query("deposits").collect());
  expect(heldRows.map((r) => r.status)).toEqual(["HELD", "HELD"]);
});
test("an organization with no opening balance still sees a plain difference, never the opening-balance label", async () => {
  const s = await seed();
  await s.t.run((ctx) =>
    ctx.db.insert("deposits", {
      orgId: s.orgId,
      customerId: s.customerA,
      amount: 10,
      amountMinor: 10_000,
      currency: "JOD",
      status: "HELD",
      holdActive: false,
      usesVehicleHoldRows: false,
      createdBy: s.ownerUserId,
      createdAt: Date.now(),
    }),
  );
  const result = await s.owner.query(api.accountingReports.customerDepositsReconciliation, { orgId: s.orgId });
  expect(result.isReconciled).toBe(false);
  expect(Math.abs(result.byCurrency.JOD.discrepancyMinor)).toBe(10_000);
  expect(result.unexplainedOpeningDifference).toBeNull();
});