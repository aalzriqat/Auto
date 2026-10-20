import { convexTestWithComponents } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { expectAppError } from "../test-utils/expectAppError";
import { settleOutbox } from "../test-utils/outboxWork";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * SCRUM-444 / SCRUM-795 (narrowed pilot, owner ruling R1): the DOOR side of the
 * pin in `utils/permissions.test.ts`.
 *
 * That file pins which default role templates hold a money-moving permission.
 * This one proves the doors it covers honour it: a REAL default SALES-template
 * actor (the permission list is read from `DEFAULT_ROLE_TEMPLATES`, not
 * hand-written) is refused with the exact FORBIDDEN code and message, and a
 * full-content snapshot of every table in `schema.tables` is identical afterwards, so a refusal
 * that patched a row in place cannot pass.
 *
 * Covered doors (the only ones this file claims): collections.recordPayment,
 * registerCheque, clearCheque, depositCheque, returnCheque, returnClearedCheque,
 * applyRetainedCredit; vehicles.createReservation with a deposit;
 * deposits.create, release, voidDeposit, allocateToVehicles,
 * releaseVehicleAllocation, resolveReleasedAllocation (an acquiring and a
 * forfeiting treatment); depositRequests.confirm.
 *
 * Every door listed above is refused in a state where it is EXECUTABLE: after
 * the SALES refusal, a real MANAGER-template actor (ACCOUNTANT-template for the
 * manage:finance doors) makes the same call in the same state, and it succeeds
 * and changes tables. So the refusal is about
 * the actor, not about missing data. Not covered: reserveSaleInvoiceReceipt
 * (no such function on this branch).
 *
 * Custom roles are outside this pin: for them the control is the permission the
 * door checks, not the template name.
 */
function templatePermissions(name: string): string[] {
  const template = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === name);
  if (!template) throw new Error(`no default role template named ${name}`);
  return [...template.permissions];
}

const ALL_TABLES = Object.keys(schema.tables);

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const now = Date.now();
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Dealer A", createdAt: now }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: now, updatedAt: now })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "USD",
      currencySymbol: "$",
      enabledPaymentTypes: ["CASH", "CHEQUE", "BANK_TRANSFER"],
    })
  );

  let ownerUserId: Id<"users"> | undefined;
  async function member(key: string, roleName: string, permissions: string[], isSystemOwnerRole = false) {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `user_${key}`, email: `${key}@test.com`, name: `User ${key}` })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: roleName, permissions, ...(isSystemOwnerRole ? { isSystemOwnerRole: true } : {}) })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    if (key === "owner") ownerUserId = userId;
    return t.withIdentity({ subject: `user_${key}`, clerkId: `user_${key}` });
  }

  // `owner` only prepares real money rows for the refusals to be tried against.
  const owner = await member("owner", "OWNER", [PERMISSIONS.MANAGE_FINANCE], true);
  // collections.clearCheque requires a physical bank in the org currency (SCRUM-571 cheque
  // clearing rule); a legitimate active USD bank, so a refusal is never about this argument.
  const bankAccountId = await t.run((ctx) =>
    ctx.db.insert("bankAccounts", {
      orgId, name: "Collection bank", currency: "USD", openingBalanceMinor: 0,
      openingBalanceDate: now, isActive: true, isReconciliationTarget: false,
      createdBy: ownerUserId!, createdAt: now, updatedAt: now,
    })
  );
  const sales = await member("sales", "SALES", templatePermissions("SALES"));
  const manager = await member("manager", "MANAGER", templatePermissions("MANAGER"));
  const accountant = await member("accountant", "ACCOUNTANT", templatePermissions("ACCOUNTANT"));

  // The owner's money rows queue accounting work on convex-test's scheduler. Freeze
  // the timers BEFORE they are written (a chain already on real timers cannot be
  // frozen later) so no background drain can change a row between the "before"
  // and "after" snapshots and make a refusal look like a write.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const period = (await owner.query(api.accountingPeriods.list, { orgId }))[0];
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Nora", lastName: "Khaled", createdAt: now })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A444444",
      make: "Mazda",
      model: "CX-5",
      year: 2023,
      color: "Red",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 500,
      sellingPrice: 22000,
      status: "AVAILABLE",
    })
  );

  // Real rows for the doors to refuse against: a receivable, a retained receipt
  // (a receipt with no debt to land on) and a HELD customer cheque.
  const receivableId = (await owner.mutation(api.collections.createReceivable, {
    idempotencyKey: crypto.randomUUID(),
    orgId,
    customerId,
    sourceType: "OTHER",
    creditSystemKey: "MISCELLANEOUS_INCOME",
    title: "Balance due",
    amount: 100,
    dueDate: now + 86_400_000,
  })) as Id<"receivables">;
  const paymentId = (await owner.mutation(api.collections.recordPayment, {
    idempotencyKey: crypto.randomUUID(),
    orgId,
    customerId,
    amount: 50,
    method: "CASH",
    paymentDate: now,
  })) as Id<"collectionPayments">;
  const receiptMovement = await t.run((ctx) =>
    ctx.db
      .query("receiptMovements")
      .withIndex("by_org_payment", (q) => q.eq("orgId", orgId).eq("collectionPaymentId", paymentId))
      .unique()
  );
  if (!receiptMovement) throw new Error("fixture: the owner's receipt produced no receipt movement");
  const chequeId = (await owner.mutation(api.collections.registerCheque, {
    orgId,
    customerId,
    bank: "Test Bank",
    chequeNumber: "000123",
    chequeDate: now + 86_400_000,
    amount: 40,
  })) as Id<"postDatedCheques">;

  // Post the owner's receipt to the ledger, so retained credit can really be applied.
  await settleOutbox(t, orgId);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  // A quote and a deposit request: a salesperson is allowed to make both, and they
  // are the rows the deposit doors act on.
  const quoteId = await sales.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId,
    vehiclePrice: 22000,
    downPayment: 2000,
    termMonths: 0,
  });
  const requestId = (await sales.mutation(api.depositRequests.request, {
    orgId,
    quoteId,
    amount: 1500,
    idempotencyKey: crypto.randomUUID(),
  })) as Id<"depositRequests">;
  vi.useRealTimers();

  return { t, orgId, owner, sales, manager, accountant, quoteId, requestId, customerId, vehicleId, bankAccountId, receivableId, receiptMovementId: receiptMovement._id, chequeId };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function expectRefusedWithoutWriting(
  s: Fixture,
  attempt: () => Promise<unknown>,
  missingPermission: string
) {
  const before = await dbSnapshot(s.t, ALL_TABLES);
  await expectAppError(attempt(), "FORBIDDEN", `Forbidden: Missing required permissions: ${missingPermission}`);
  expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
}

type Stage = "none" | "deposit" | "allocated" | "released" | "clearedCheque";
type World = { dealQuoteId: Id<"quotes">; vehicleB: Id<"vehicles">; depositId?: Id<"deposits">; holdId?: Id<"depositVehicleHolds"> };
type Actor = Fixture["sales"];

/** Builds, as the owner and with timers frozen, the state a door needs to be executable. */
async function buildWorld(s: Fixture, stage: Stage): Promise<World> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const vehicleB = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "1HGCM82633A555555",
        make: "Mazda",
        model: "CX-30",
        year: 2023,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 300,
        sellingPrice: 15000,
        status: "AVAILABLE",
      })
    );
    const world: World = { dealQuoteId: s.quoteId, vehicleB };
    if (stage === "none" || stage === "clearedCheque") {
      if (stage === "clearedCheque") {
        await s.owner.mutation(api.collections.clearCheque, {
          orgId: s.orgId,
          chequeId: s.chequeId,
          bankAccountId: s.bankAccountId,
          idempotencyKey: crypto.randomUUID(),
        });
      }
      return world;
    }
    world.dealQuoteId = await s.owner.mutation(api.quotes.saveQuote, {
      orgId: s.orgId,
      customerId: s.customerId,
      vehicleId: s.vehicleId,
      vehicleItems: [
        { vehicleId: s.vehicleId, unitPrice: 15000 },
        { vehicleId: vehicleB, unitPrice: 15000 },
      ],
      mode: "CASH" as const,
      vehiclePrice: 30000,
      downPayment: 0,
      termMonths: 0,
    });
    await s.owner.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId: world.dealQuoteId,
      amount: 6000,
      method: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    world.depositId = (await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0]._id;
    if (stage === "deposit") return world;
    await s.owner.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId,
      quoteId: world.dealQuoteId,
      allocations: [
        { vehicleId: s.vehicleId, amount: 3000 },
        { vehicleId: vehicleB, amount: 3000 },
      ],
    });
    if (stage === "allocated") return world;
    await s.owner.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: world.dealQuoteId,
      vehicleId: vehicleB,
      reason: "customer changed their mind",
    });
    const hold = await s.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).find(
        (h) => h.vehicleId === vehicleB && h.allocationStatus === "RELEASED_AWAITING_DECISION"
      )
    );
    if (!hold) throw new Error("fixture: the released slice is not awaiting a decision");
    world.holdId = hold._id;
    return world;
  } finally {
    vi.useRealTimers();
  }
}

type Door = [name: string, stage: Stage, permission: string, call: (actor: Actor, s: Fixture, w: World) => Promise<unknown>];
const CONFIRM = PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT;
const APPROVE = PERMISSIONS.APPROVE_REQUESTS;
// MANAGER holds the deposit authorities but not MANAGE_FINANCE; the accountant template holds it.
const FINANCE = PERMISSIONS.MANAGE_FINANCE;

const DOORS: Door[] = [
  ["deposits.create", "deposit", CONFIRM, (a, s, w) =>
    a.mutation(api.deposits.create, { orgId: s.orgId, quoteId: w.dealQuoteId, amount: 500, method: "CASH", idempotencyKey: crypto.randomUUID() })],
  ["deposits.allocateToVehicles", "deposit", CONFIRM, (a, s, w) =>
    a.mutation(api.deposits.allocateToVehicles, { orgId: s.orgId, quoteId: w.dealQuoteId, allocations: [{ vehicleId: s.vehicleId, amount: 100 }] })],
  ["deposits.releaseVehicleAllocation", "allocated", CONFIRM, (a, s, w) =>
    a.mutation(api.deposits.releaseVehicleAllocation, { orgId: s.orgId, quoteId: w.dealQuoteId, vehicleId: w.vehicleB, reason: "changed their mind" })],
  ["deposits.resolveReleasedAllocation (RETURN_TO_UNALLOCATED)", "released", CONFIRM, (a, s, w) =>
    a.mutation(api.deposits.resolveReleasedAllocation, { orgId: s.orgId, holdId: w.holdId!, treatment: "RETURN_TO_UNALLOCATED", reason: "back on the deal" })],
  ["deposits.resolveReleasedAllocation (FORFEITED)", "released", APPROVE, (a, s, w) =>
    a.mutation(api.deposits.resolveReleasedAllocation, { orgId: s.orgId, holdId: w.holdId!, treatment: "FORFEITED", reason: "customer walked away" })],
  ["deposits.release (FORFEITED)", "deposit", APPROVE, (a, s, w) =>
    a.mutation(api.deposits.release, { orgId: s.orgId, depositId: w.depositId!, resolution: "FORFEITED", idempotencyKey: crypto.randomUUID() })],
  ["deposits.voidDeposit", "deposit", APPROVE, (a, s, w) =>
    a.mutation(api.deposits.voidDeposit, { orgId: s.orgId, depositId: w.depositId!, reason: "entered in error" })],
  ["collections.recordPayment", "none", FINANCE, (a, s) =>
    a.mutation(api.collections.recordPayment, { orgId: s.orgId, customerId: s.customerId, amount: 25, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID() })],
  ["collections.registerCheque", "none", FINANCE, (a, s) =>
    a.mutation(api.collections.registerCheque, { orgId: s.orgId, customerId: s.customerId, bank: "Test Bank", chequeNumber: "000999", chequeDate: Date.now() + 86_400_000, amount: 10 })],
  ["collections.clearCheque", "none", FINANCE, (a, s) =>
    a.mutation(api.collections.clearCheque, { orgId: s.orgId, chequeId: s.chequeId, bankAccountId: s.bankAccountId, idempotencyKey: crypto.randomUUID() })],
  ["collections.applyRetainedCredit", "none", FINANCE, (a, s) =>
    a.mutation(api.collections.applyRetainedCredit, { orgId: s.orgId, receiptMovementId: s.receiptMovementId, receivableId: s.receivableId, requestedAmount: 10, idempotencyKey: crypto.randomUUID() })],
  ["vehicles.createReservation (with a deposit)", "none", `${PERMISSIONS.EDIT_VEHICLES}, ${CONFIRM}`, (a, s) =>
    a.mutation(api.vehicles.createReservation, { orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, depositAmount: 500, depositMethod: "CASH", idempotencyKey: crypto.randomUUID() })],
  ["depositRequests.confirm", "none", CONFIRM, (a, s) =>
    a.mutation(api.depositRequests.confirm, { orgId: s.orgId, requestId: s.requestId, amount: 1500, method: "CASH", idempotencyKey: crypto.randomUUID() })],
  ["collections.depositCheque", "none", FINANCE, (a, s) =>
    a.mutation(api.collections.depositCheque, { orgId: s.orgId, chequeId: s.chequeId })],
  ["collections.returnCheque", "none", FINANCE, (a, s) =>
    a.mutation(api.collections.returnCheque, { orgId: s.orgId, chequeId: s.chequeId, returnReason: "insufficient funds" })],
  ["collections.returnClearedCheque", "clearedCheque", FINANCE, (a, s) =>
    a.mutation(api.collections.returnClearedCheque, { orgId: s.orgId, chequeId: s.chequeId, returnReason: "bounced", idempotencyKey: crypto.randomUUID() })],
];

describe("SCRUM-444: a default SALES-template actor cannot move money through the doors this file covers", () => {
  test("control: the setup rows exist, so each refusal below is about the actor, not missing data", async () => {
    const s = await setup();
    const rows = await dbSnapshot(s.t, ["receivables", "receiptMovements", "postDatedCheques", "quotes", "depositRequests"]);
    for (const table of Object.keys(rows)) expect(rows[table], table).toHaveLength(1);
  });

  test("the SALES template holds neither authority a deposit-carrying reservation needs", () => {
    expect(templatePermissions("SALES")).not.toContain(PERMISSIONS.EDIT_VEHICLES);
    expect(templatePermissions("SALES")).not.toContain(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  });

  test.each(DOORS)("%s is refused for SALES in an executable state, and the authorised template can make the same call", async (_door, stage, permission, call) => {
    const s = await setup();
    const world = await buildWorld(s, stage);
    await expectRefusedWithoutWriting(s, () => call(s.sales, s, world), permission);

    const before = await dbSnapshot(s.t, ALL_TABLES);
    await call(permission === FINANCE ? s.accountant : s.manager, s, world);
    expect(await dbSnapshot(s.t, ALL_TABLES)).not.toEqual(before);
  });
});
