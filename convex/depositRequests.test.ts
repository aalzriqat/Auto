import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";
import {
  RESERVATION_PROBE_MAX_FUNDED_TAGGED_PER_QUOTE,
  RESERVATION_PROBE_MAX_ORIGINS_PER_QUOTE,
  assertNoQuoteLinkedReservationDeposit,
} from "./utils/depositRequestGuards";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * SCRUM-444 — a salesperson REQUESTS a deposit; only a holder of
 * CONFIRM_FINANCE_DISBURSEMENT moves the money.
 *
 * Roles are the REAL default templates, not hand-written permission lists, so a
 * change to what SALES / MANAGER / ACCOUNTANT hold shows up here.
 */
function templatePermissions(name: string): string[] {
  const template = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === name);
  if (!template) throw new Error(`no default role template named ${name}`);
  return [...template.permissions];
}

async function setup(options: { transactionLimits?: boolean } = {}) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"), options);
  const now = Date.now();
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Dealer A", createdAt: now }));
  const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Dealer B", createdAt: now }));
  for (const id of [orgId, otherOrgId]) {
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId: id, plan: "professional", status: "active", createdAt: now, updatedAt: now })
    );
  }

  async function member(orgForMember: Id<"organizations">, key: string, permissions: string[], roleName = key) {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `user_${key}`, email: `${key}@test.com`, name: `User ${key}` })
    );
    const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId: orgForMember, name: roleName, permissions }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId: orgForMember, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: `user_${key}`, clerkId: `user_${key}` }) };
  }

  const sales = await member(orgId, "sales", templatePermissions("SALES"), "SALES");
  const sales2 = await member(orgId, "sales2", templatePermissions("SALES"), "SALES2");
  const manager = await member(orgId, "manager", templatePermissions("MANAGER"), "MANAGER");
  const accountant = await member(orgId, "accountant", templatePermissions("ACCOUNTANT"), "ACCOUNTANT");
  // A custom role: may edit vehicles and see sales, and nothing that moves money.
  const editor = await member(
    orgId,
    "editor",
    [PERMISSIONS.EDIT_VEHICLES, PERMISSIONS.VIEW_SALES, PERMISSIONS.VIEW_VEHICLES],
    "EDITOR"
  );
  const outsider = await member(otherOrgId, "outsider", templatePermissions("MANAGER"), "OUTSIDER_MANAGER");

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
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Nora", lastName: "Khaled" })
  );

  return { t, orgId, otherOrgId, vehicleId, customerId, sales, sales2, manager, accountant, editor, outsider };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function makeQuote(s: Ctx, overrides: { customerId?: Id<"customers">; vehicleId?: Id<"vehicles"> } = {}) {
  return await s.sales.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: overrides.customerId ?? s.customerId,
    vehicleId: overrides.vehicleId ?? s.vehicleId,
    vehiclePrice: 22000,
    downPayment: 2000,
    termMonths: 0,
  });
}

/** Every table a deposit's money would touch. A request must leave all of them empty. */
async function moneyFootprint(s: Ctx) {
  return await s.t.run(async (ctx) => ({
    deposits: (await ctx.db.query("deposits").collect()).length,
    transactions: (await ctx.db.query("transactions").collect()).length,
    collectionPayments: (await ctx.db.query("collectionPayments").collect()).length,
    canonicalPayments: (await ctx.db.query("canonicalPayments").collect()).length,
    paymentVouchers: (await ctx.db.query("paymentVouchers").collect()).length,
    accountingEvents: (await ctx.db.query("accountingEvents").collect()).length,
    pendingAccountingEvents: (await ctx.db.query("pendingAccountingEvents").collect()).length,
    commitmentRoots: (await ctx.db.query("commitmentRoots").collect()).length,
    vehicleHolds: (await ctx.db.query("depositVehicleHolds").collect()).length,
  }));
}

const NO_MONEY = {
  deposits: 0,
  transactions: 0,
  collectionPayments: 0,
  canonicalPayments: 0,
  paymentVouchers: 0,
  accountingEvents: 0,
  pendingAccountingEvents: 0,
  commitmentRoots: 0,
  vehicleHolds: 0,
};

async function requestDeposit(s: Ctx, quoteId: Id<"quotes">, amount = 1500, key: string = crypto.randomUUID()) {
  return await s.sales.as.mutation(api.depositRequests.request, {
    orgId: s.orgId,
    quoteId,
    amount,
    idempotencyKey: key,
  });
}

const STILL_WAITING = /deposit request is still waiting/i;

describe("deposits.create authority (the SCRUM-444 defect)", () => {
  test("a SALES-only member cannot post a deposit, and nothing is written", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);

    await expect(
      s.sales.as.mutation(api.deposits.create, {
        orgId: s.orgId,
        quoteId,
        amount: 1500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/confirm:finance_disbursement/i);

    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
    const vehicle = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(vehicle?.status).toBe("AVAILABLE");
  });

  test.each(["manager", "accountant"] as const)("control: a %s posts exactly one deposit", async (who) => {
    const s = await setup();
    const quoteId = await makeQuote(s);

    const depositId = await s[who].as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 1500,
      method: "BANK_TRANSFER",
      idempotencyKey: crypto.randomUUID(),
    });

    const footprint = await moneyFootprint(s);
    expect(footprint.deposits).toBe(1);
    expect(footprint.transactions).toBe(1);
    expect(footprint.collectionPayments).toBe(1);
    expect(footprint.canonicalPayments).toBe(1);
    expect(footprint.accountingEvents + footprint.pendingAccountingEvents).toBe(1);
    const deposit = await s.t.run((ctx) => ctx.db.get(depositId));
    expect(deposit?.method).toBe("BANK_TRANSFER");
  });

  test("the method is required: no silent CASH default (SCRUM-445)", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);

    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId,
        quoteId,
        amount: 1500,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/choose how the deposit was received/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
  });
});

describe("depositRequests.request", () => {
  test("a salesperson's request writes ONLY the request row, and managers AND accountants are told", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);

    const requestId = await requestDeposit(s, quoteId, 1500);

    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
    const vehicle = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(vehicle?.status).toBe("AVAILABLE"); // a pending request does not hold the car (Q1)

    const row = await s.t.run((ctx) => ctx.db.get(requestId));
    expect(row).toMatchObject({
      status: "PENDING",
      amount: 1500,
      amountMinor: 1_500_000,
      currency: "JOD",
      requestedBy: s.sales.userId,
    });

    const notified = await s.t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect())
        .filter((n) => n.type === "depositRequest.created")
        .map((n) => n.userId)
    );
    expect(notified).toContain(s.manager.userId);
    expect(notified).toContain(s.accountant.userId); // DA-06
    expect(notified).not.toContain(s.sales.userId);
    expect(notified).not.toContain(s.editor.userId);
  });

  test("never overwrites the quote's downPayment (Q4)", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await requestDeposit(s, quoteId, 1500);
    const quote = await s.t.run((ctx) => ctx.db.get(quoteId));
    expect(quote?.downPayment).toBe(2000);
  });

  test("same key + same payload is a replay; same key + different payload is refused", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const first = await requestDeposit(s, quoteId, 1500, "req-key-1");
    const replay = await requestDeposit(s, quoteId, 1500, "req-key-1");
    expect(replay).toEqual(first);
    const rows = await s.t.run((ctx) => ctx.db.query("depositRequests").collect());
    expect(rows).toHaveLength(1);

    await expect(requestDeposit(s, quoteId, 1600, "req-key-1")).rejects.toThrow(/different request content/i);
  });

  test("refused on an expired (terminal) quote, with the way forward named", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await s.sales.as.mutation(api.quotes.updateQuoteStatus, { orgId: s.orgId, quoteId, status: "EXPIRED" });

    await expect(requestDeposit(s, quoteId)).rejects.toThrow(/expired.*start a new quote/i);
    expect(await s.t.run((ctx) => ctx.db.query("depositRequests").collect())).toHaveLength(0);
  });

  test("requests already waiting count against the quote amount", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await requestDeposit(s, quoteId, 21_000);
    await expect(requestDeposit(s, quoteId, 1_001)).rejects.toThrow(/cannot exceed the quote amount/i);
  });

  test("a member without VIEW_SALES cannot request", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const reception = await s.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "user_rec", email: "rec@test.com", name: "Rec" });
      const roleId = await ctx.db.insert("roles", {
        orgId: s.orgId,
        name: "RECEPTION",
        permissions: templatePermissions("RECEPTION"),
      });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
      return userId;
    });
    expect(reception).toBeTruthy();
    const asReception = s.t.withIdentity({ subject: "user_rec", clerkId: "user_rec" });
    await expect(
      asReception.mutation(api.depositRequests.request, {
        orgId: s.orgId,
        quoteId,
        amount: 100,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/view:sales/i);
  });
});

describe("depositRequests.confirm", () => {
  async function pending(s: Ctx, amount = 1500) {
    const quoteId = await makeQuote(s);
    const requestId = await requestDeposit(s, quoteId, amount);
    return { quoteId, requestId };
  }

  test.each(["manager", "accountant"] as const)(
    "a %s confirms: exactly one DEPOSIT_RECEIVED, request CONFIRMED with its deposit, in one step",
    async (who) => {
      const s = await setup();
      const { requestId } = await pending(s);

      const depositId = await s[who].as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        method: "CARD",
        idempotencyKey: crypto.randomUUID(),
      });

      const footprint = await moneyFootprint(s);
      expect(footprint.deposits).toBe(1);
      expect(footprint.transactions).toBe(1);
      expect(footprint.accountingEvents + footprint.pendingAccountingEvents).toBe(1);
      const row = await s.t.run((ctx) => ctx.db.get(requestId));
      expect(row).toMatchObject({ status: "CONFIRMED", confirmedDepositId: depositId, resolvedBy: s[who].userId });
      const deposit = await s.t.run((ctx) => ctx.db.get(depositId));
      expect(deposit).toMatchObject({ status: "HELD", method: "CARD", createdBy: s[who].userId });
      const vehicle = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
      expect(vehicle?.status).toBe("RESERVED");

      const told = await s.t.run(async (ctx) =>
        (await ctx.db.query("notifications").collect()).filter((n) => n.type === "depositRequest.confirmed")
      );
      expect(told.map((n) => n.userId)).toEqual([s.sales.userId]);
    }
  );

  test("a SALES member cannot confirm, and nothing is written", async () => {
    const s = await setup();
    const { requestId } = await pending(s);
    await expect(
      s.sales.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/confirm:finance_disbursement/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
  });

  test("the method is required", async () => {
    const s = await setup();
    const { requestId } = await pending(s);
    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/choose how the deposit was received/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
  });

  test("a different amount is refused and the request stays pending (Q2)", async () => {
    const s = await setup();
    const { requestId } = await pending(s);
    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1400,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/does not match the request.*reject/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
  });

  test("a same-key retry returns the SAME deposit and posts once", async () => {
    const s = await setup();
    const { requestId } = await pending(s);
    const args = { orgId: s.orgId, requestId, amount: 1500, method: "CASH" as const, idempotencyKey: "confirm-1" };

    const first = await s.manager.as.mutation(api.depositRequests.confirm, args);
    const second = await s.manager.as.mutation(api.depositRequests.confirm, args);

    expect(second).toEqual(first);
    const footprint = await moneyFootprint(s);
    expect(footprint.deposits).toBe(1);
    expect(footprint.accountingEvents + footprint.pendingAccountingEvents).toBe(1);
  });

  test("the same key with a different payload is refused", async () => {
    const s = await setup();
    const { requestId } = await pending(s);
    await s.manager.as.mutation(api.depositRequests.confirm, {
      orgId: s.orgId,
      requestId,
      amount: 1500,
      method: "CASH",
      idempotencyKey: "confirm-2",
    });
    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        method: "CARD",
        idempotencyKey: "confirm-2",
      })
    ).rejects.toThrow(/different request content/i);
  });

  test("a second confirm under a NEW key is refused: already confirmed", async () => {
    const s = await setup();
    const { requestId } = await pending(s);
    const base = { orgId: s.orgId, requestId, amount: 1500, method: "CASH" as const };
    await s.manager.as.mutation(api.depositRequests.confirm, { ...base, idempotencyKey: "a" });
    await expect(
      s.accountant.as.mutation(api.depositRequests.confirm, { ...base, idempotencyKey: "b" })
    ).rejects.toThrow(/already confirmed/i);
    expect((await moneyFootprint(s)).deposits).toBe(1);
  });

  test("confirm on a terminal quote is refused", async () => {
    const s = await setup();
    const { requestId, quoteId } = await pending(s);
    // The quote ends by a route that does not go through the guarded doors.
    await s.t.run((ctx) => ctx.db.patch(quoteId, { status: "EXPIRED" }));
    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/expired.*reject the request/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
  });

  test("commitment lost to a rival deal: refused with the way out named, request stays PENDING (Q1)", async () => {
    const s = await setup();
    const { requestId } = await pending(s);

    // A rival customer's manager-taken deposit commits the car after the request.
    const rivalCustomer = await s.t.run((ctx) =>
      ctx.db.insert("customers", { orgId: s.orgId, firstName: "Omar", lastName: "Saleh" })
    );
    const rivalQuote = await makeQuote(s, { customerId: rivalCustomer });
    await s.manager.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId: rivalQuote,
      amount: 1000,
      method: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    const before = await moneyFootprint(s);

    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/already committed.*stays pending.*reject/i);

    expect(await moneyFootprint(s)).toEqual(before);
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
  });

  // SCRUM-629 F-27 (ruling c21924): the same commitment decision `confirm`
  // makes, taken before the customer is asked for money.
  test("a car another deal already holds: the request is refused, nothing is written or sent", async () => {
    const s = await setup();
    const rivalCustomer = await s.t.run((ctx) =>
      ctx.db.insert("customers", { orgId: s.orgId, firstName: "Omar", lastName: "Saleh" })
    );
    const rivalQuote = await makeQuote(s, { customerId: rivalCustomer });
    await s.manager.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId: rivalQuote,
      amount: 1000,
      method: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    const quoteId = await makeQuote(s);
    const notificationsBefore = (await s.t.run((ctx) => ctx.db.query("notifications").collect())).length;

    await expect(requestDeposit(s, quoteId)).rejects.toThrow(/already committed/i);

    expect(await s.t.run((ctx) => ctx.db.query("depositRequests").collect())).toHaveLength(0);
    expect((await s.t.run((ctx) => ctx.db.query("notifications").collect())).length).toBe(notificationsBefore);
  });
});

describe("depositRequests.reject and withdraw", () => {
  test("reject needs a reason, needs the authority, writes no money, and tells the requester", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const requestId = await requestDeposit(s, quoteId);

    await expect(
      s.sales.as.mutation(api.depositRequests.reject, { orgId: s.orgId, requestId, reason: "no" })
    ).rejects.toThrow(/confirm:finance_disbursement/i);
    await expect(
      s.manager.as.mutation(api.depositRequests.reject, { orgId: s.orgId, requestId, reason: "   " })
    ).rejects.toThrow(/say why/i);

    await s.manager.as.mutation(api.depositRequests.reject, {
      orgId: s.orgId,
      requestId,
      reason: "Customer has not paid yet",
    });
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
    expect(await s.t.run((ctx) => ctx.db.get(requestId))).toMatchObject({
      status: "REJECTED",
      resolutionReason: "Customer has not paid yet",
    });
    const told = await s.t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter((n) => n.type === "depositRequest.rejected")
    );
    expect(told.map((n) => n.userId)).toEqual([s.sales.userId]);

    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/already rejected/i);
  });

  test("withdraw: the requester or a confirm-holder may; another salesperson may not", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const first = await requestDeposit(s, quoteId, 500);

    await expect(
      s.sales2.as.mutation(api.depositRequests.withdraw, { orgId: s.orgId, requestId: first })
    ).rejects.toThrow(/only the person who made this request/i);

    await s.sales.as.mutation(api.depositRequests.withdraw, { orgId: s.orgId, requestId: first });
    expect((await s.t.run((ctx) => ctx.db.get(first)))?.status).toBe("WITHDRAWN");

    const second = await requestDeposit(s, quoteId, 500);
    await s.accountant.as.mutation(api.depositRequests.withdraw, { orgId: s.orgId, requestId: second });
    expect((await s.t.run((ctx) => ctx.db.get(second)))?.status).toBe("WITHDRAWN");

    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId: first,
        amount: 500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/withdrawn/i);
  });
});

describe("cross-organization refusals", () => {
  test("another org's manager cannot request, confirm, reject or withdraw against this org's rows", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const requestId = await requestDeposit(s, quoteId);

    // Naming the victim org: not a member.
    await expect(
      s.outsider.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/not a member/i);

    // Naming their own org with the victim's ids: the row does not exist there.
    await expect(
      s.outsider.as.mutation(api.depositRequests.confirm, {
        orgId: s.otherOrgId,
        requestId,
        amount: 1500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/deposit request not found/i);
    await expect(
      s.outsider.as.mutation(api.depositRequests.reject, { orgId: s.otherOrgId, requestId, reason: "x" })
    ).rejects.toThrow(/deposit request not found/i);
    await expect(
      s.outsider.as.mutation(api.depositRequests.withdraw, { orgId: s.otherOrgId, requestId })
    ).rejects.toThrow(/deposit request not found/i);
    await expect(
      s.outsider.as.mutation(api.depositRequests.request, {
        orgId: s.otherOrgId,
        quoteId,
        amount: 100,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/quote not found/i);

    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
  });
});

describe("DA-04: a direct deposit cannot bypass a waiting request", () => {
  test("create is refused while a request is PENDING, naming the three ways out, and allowed after reject", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const requestId = await requestDeposit(s, quoteId);
    const direct = {
      orgId: s.orgId,
      quoteId,
      amount: 1500,
      method: "CASH" as const,
    };

    await expect(
      s.manager.as.mutation(api.deposits.create, { ...direct, idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(/confirm receipt, reject the request, or have the requester withdraw/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);

    await s.manager.as.mutation(api.depositRequests.reject, { orgId: s.orgId, requestId, reason: "Paid elsewhere" });
    await s.manager.as.mutation(api.deposits.create, { ...direct, idempotencyKey: crypto.randomUUID() });
    expect((await moneyFootprint(s)).deposits).toBe(1);
  });
});

describe("DA-01: a reservation that carries a deposit needs the money authority", () => {
  test("EDIT_VEHICLES + VIEW_SALES only: reservation with a deposit is refused before any write; without a deposit it works", async () => {
    const s = await setup();

    await expect(
      s.editor.as.mutation(api.vehicles.createReservation, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        depositAmount: 500,
        depositMethod: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/confirm:finance_disbursement/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
    expect(await s.t.run((ctx) => ctx.db.query("vehicleReservations").collect())).toHaveLength(0);

    const reservationId = await s.editor.as.mutation(api.vehicles.createReservation, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(reservationId).toBeTruthy();
    expect((await moneyFootprint(s)).deposits).toBe(0);
  });

  test("control: a manager reserves with a deposit and a chosen method; omitting the method is refused", async () => {
    const s = await setup();
    await expect(
      s.manager.as.mutation(api.vehicles.createReservation, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        depositAmount: 500,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/choose how the deposit was received/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);

    await s.manager.as.mutation(api.vehicles.createReservation, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      depositAmount: 500,
      depositMethod: "BANK_TRANSFER",
      idempotencyKey: crypto.randomUUID(),
    });
    const deposits = await s.t.run((ctx) => ctx.db.query("deposits").collect());
    expect(deposits).toHaveLength(1);
    expect(deposits[0].method).toBe("BANK_TRANSFER");
  });

  test("a reservation with NO deposit has no deposit method to judge, and stores none (SCRUM-469)", async () => {
    // The method is only meaningful when money is taken. It used to be computed
    // for a no-deposit reservation too, never stored, and refused when it was
    // OTHER - a rejection of a value that meant nothing.
    const s = await setup();
    const reservationId = await s.manager.as.mutation(api.vehicles.createReservation, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      depositMethod: "OTHER",
      idempotencyKey: crypto.randomUUID(),
    });

    const reservation = await s.t.run((ctx) => ctx.db.get(reservationId));
    expect(reservation?.depositMethod).toBeUndefined();
    expect(await moneyFootprint(s)).toMatchObject({ deposits: 0, transactions: 0, collectionPayments: 0 });
  });

  test("with a deposit, OTHER is still refused and nothing is written (SCRUM-469 control)", async () => {
    const s = await setup();
    await expect(
      s.manager.as.mutation(api.vehicles.createReservation, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        depositAmount: 500,
        depositMethod: "OTHER",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/OTHER is not accepted for a deposit/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
  });
});

describe("DA-02: changing which car deposit money is committed to needs the money authority", () => {
  async function heldHold(s: Ctx) {
    const quoteId = await makeQuote(s);
    const depositId = await s.manager.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 1500,
      method: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    const holdId = await s.t.run((ctx) =>
      ctx.db.insert("depositVehicleHolds", {
        orgId: s.orgId,
        depositId,
        vehicleId: s.vehicleId,
        active: false,
        createdAt: Date.now(),
        allocationStatus: "RELEASED_AWAITING_DECISION",
        allocatedAmountMinor: 1_500_000,
      })
    );
    return { quoteId, depositId, holdId };
  }

  test("SALES cannot allocate, release an allocation, reallocate or return a released share", async () => {
    const s = await setup();
    const { quoteId, holdId } = await heldHold(s);
    const before = await s.t.run((ctx) => ctx.db.get(holdId));

    await expect(
      s.sales.as.mutation(api.deposits.allocateToVehicles, {
        orgId: s.orgId,
        quoteId,
        allocations: [{ vehicleId: s.vehicleId, amount: 100 }],
      })
    ).rejects.toThrow(/confirm:finance_disbursement/i);
    await expect(
      s.sales.as.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: s.orgId,
        quoteId,
        vehicleId: s.vehicleId,
      })
    ).rejects.toThrow(/confirm:finance_disbursement/i);
    for (const treatment of ["REALLOCATE_TO_VEHICLE", "RETURN_TO_UNALLOCATED"] as const) {
      await expect(
        s.sales.as.mutation(api.deposits.resolveReleasedAllocation, {
          orgId: s.orgId,
          holdId,
          treatment,
          toVehicleId: s.vehicleId,
        })
      ).rejects.toThrow(/confirm:finance_disbursement/i);
    }

    expect(await s.t.run((ctx) => ctx.db.get(holdId))).toEqual(before);
  });

  test("control: a manager passes the authority check on each (refused later, for a domain reason, not for permission)", async () => {
    const s = await setup();
    const { quoteId, holdId } = await heldHold(s);
    const notForbidden = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        expect(String(error)).not.toMatch(/forbidden|missing required permissions/i);
      }
    };
    await notForbidden(
      s.manager.as.mutation(api.deposits.allocateToVehicles, {
        orgId: s.orgId,
        quoteId,
        allocations: [{ vehicleId: s.vehicleId, amount: 100 }],
      })
    );
    await notForbidden(
      s.manager.as.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: s.orgId,
        quoteId,
        vehicleId: s.vehicleId,
      })
    );
    await notForbidden(
      s.manager.as.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: s.orgId,
        holdId,
        treatment: "RETURN_TO_UNALLOCATED",
      })
    );
  });
});

describe("DA-03: every terminal door refuses while a request is PENDING", () => {
  async function withPending(s: Ctx) {
    const quoteId = await makeQuote(s);
    const requestId = await requestDeposit(s, quoteId, 1500);
    return { quoteId, requestId };
  }
  async function makeApplication(s: Ctx, quoteId: Id<"quotes">, status: "DRAFT" | "UNDER_REVIEW" | "APPROVED") {
    const now = Date.now();
    return await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: s.orgId,
        quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.sales.userId,
        status,
        createdAt: now,
        updatedAt: now,
      })
    );
  }
  async function expectBlockedThenFreed(s: Ctx, requestId: Id<"depositRequests">, call: () => Promise<unknown>) {
    await expect(call()).rejects.toThrow(STILL_WAITING);
    await s.manager.as.mutation(api.depositRequests.reject, { orgId: s.orgId, requestId, reason: "Not needed" });
    // Control: once resolved, the door no longer refuses for THAT reason.
    try {
      await call();
    } catch (error) {
      expect(String(error)).not.toMatch(STILL_WAITING);
    }
  }

  test("quotes.updateQuoteStatus EXPIRED", async () => {
    const s = await setup();
    const { quoteId, requestId } = await withPending(s);
    await expectBlockedThenFreed(s, requestId, () =>
      s.sales.as.mutation(api.quotes.updateQuoteStatus, { orgId: s.orgId, quoteId, status: "EXPIRED" })
    );
    expect((await s.t.run((ctx) => ctx.db.get(quoteId)))?.status).toBe("EXPIRED");
  });

  test("a non-terminal quote status change is NOT blocked", async () => {
    const s = await setup();
    const { quoteId } = await withPending(s);
    await s.sales.as.mutation(api.quotes.updateQuoteStatus, { orgId: s.orgId, quoteId, status: "SHARED" });
    expect((await s.t.run((ctx) => ctx.db.get(quoteId)))?.status).toBe("SHARED");
  });

  test("sales.completeFromQuote", async () => {
    const s = await setup();
    const { quoteId, requestId } = await withPending(s);
    await expectBlockedThenFreed(s, requestId, () =>
      s.manager.as.mutation(api.sales.completeFromQuote, {
        orgId: s.orgId,
        quoteId,
        idempotencyKey: "complete-quote-1",
      })
    );
  });

  test("sales.create (with the quote)", async () => {
    const s = await setup();
    const { quoteId, requestId } = await withPending(s);
    await expectBlockedThenFreed(s, requestId, () =>
      s.manager.as.mutation(api.sales.create, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        salespersonId: s.manager.userId,
        salePrice: 22000,
        saleDate: Date.now(),
        status: "COMPLETED",
        quoteId,
        idempotencyKey: "sale-create-1",
      })
    );
  });

  test("sales.completeDraft: a draft cannot carry the quote, so it cannot orphan a request", async () => {
    const s = await setup();
    const { quoteId, requestId } = await withPending(s);
    const draftArgs = {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      salespersonId: s.manager.userId,
      salePrice: 22000,
      saleDate: Date.now(),
    };
    // SCRUM-425: the door is closed structurally — a draft never names a quote.
    await expect(
      s.manager.as.mutation(api.sales.createDraft, { ...draftArgs, quoteId, idempotencyKey: "draft-with-quote" } as never)
    ).rejects.toThrow(/quoteId/);

    const saleId = await s.manager.as.mutation(api.sales.createDraft, { ...draftArgs, idempotencyKey: "draft-1" });
    // Control: completing the quote-less draft never reaches the pending-request guard.
    try {
      await s.manager.as.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId, idempotencyKey: "draft-complete-1" });
    } catch (error) {
      expect(String(error)).not.toMatch(STILL_WAITING);
    }
    // The request was never touched.
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
  });
  test("applications.finalizeDeal", async () => {
    const s = await setup();
    const { quoteId, requestId } = await withPending(s);
    const applicationId = await makeApplication(s, quoteId, "APPROVED");
    await expectBlockedThenFreed(s, requestId, () =>
      s.manager.as.mutation(api.applications.finalizeDeal, {
        orgId: s.orgId,
        applicationId,
        idempotencyKey: "finalize-1",
      })
    );
  });

  test("applications.cancelApplication", async () => {
    const s = await setup();
    const { quoteId, requestId } = await withPending(s);
    const applicationId = await makeApplication(s, quoteId, "DRAFT");
    await expectBlockedThenFreed(s, requestId, () =>
      s.manager.as.mutation(api.applications.cancelApplication, {
        orgId: s.orgId,
        applicationId,
        idempotencyKey: "cancel-1",
      })
    );
  });

  test("applications.updateStatus REJECTED", async () => {
    const s = await setup();
    const { quoteId, requestId } = await withPending(s);
    const applicationId = await makeApplication(s, quoteId, "UNDER_REVIEW");
    await expectBlockedThenFreed(s, requestId, () =>
      s.manager.as.mutation(api.applications.updateStatus, {
        orgId: s.orgId,
        applicationId,
        status: "REJECTED",
      })
    );
  });

  test("the deal cockpit reader surfaces the pending request as zero paid", async () => {
    const s = await setup();
    const { quoteId, requestId } = await withPending(s);
    const applicationId = await makeApplication(s, quoteId, "UNDER_REVIEW");
    const cockpit = await s.manager.as.query(api.dealWorkspace.financedDealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    expect(cockpit?.pendingDepositRequests).toEqual([
      expect.objectContaining({ _id: requestId, amount: 1500, currency: "JOD" }),
    ]);
  });
});

describe("queue readers", () => {
  test("listPending is for confirm-holders only; listForQuote tells the wizard who may decide", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await requestDeposit(s, quoteId, 1500);

    await expect(s.sales.as.query(api.depositRequests.listPending, { orgId: s.orgId })).rejects.toThrow(
      /confirm:finance_disbursement/i
    );
    const queue = await s.accountant.as.query(api.depositRequests.listPending, { orgId: s.orgId });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ amount: 1500, customerName: "Nora Khaled", requestedByName: "User sales" });

    const asSales = await s.sales.as.query(api.depositRequests.listForQuote, { orgId: s.orgId, quoteId });
    expect(asSales?.canConfirm).toBe(false);
    expect(asSales?.requests[0]).toMatchObject({ status: "PENDING", isMine: true });
    const asManager = await s.manager.as.query(api.depositRequests.listForQuote, { orgId: s.orgId, quoteId });
    expect(asManager?.canConfirm).toBe(true);
    expect(await s.outsider.as.query(api.depositRequests.listPending, { orgId: s.otherOrgId })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIX ROUND 1 (Opus 5.5 + Sol review of 670856372)
// ---------------------------------------------------------------------------

/** The historical shape F1 is about: a reservation deposit whose claim names the quote. */
async function seedQuoteLinkedReservationDeposit(s: Ctx, quoteId: Id<"quotes">) {
  const reservationId = await s.manager.as.mutation(api.vehicles.createReservation, {
    orgId: s.orgId,
    vehicleId: s.vehicleId,
    customerId: s.customerId,
    depositAmount: 22000,
    depositMethod: "CASH",
    idempotencyKey: crypto.randomUUID(),
  });
  // Rows written before `createReservation` refused this combination carry the
  // quote on the reservation's commitment episode. One field, exactly that.
  await s.t.run(async (ctx) => {
    const claims = await ctx.db
      .query("vehicleCommitmentClaims")
      .withIndex("by_reservation", (q) => q.eq("reservationId", reservationId))
      .collect();
    expect(claims).toHaveLength(1);
    await ctx.db.patch(claims[0]._id, { quoteId });
  });
  return reservationId;
}

describe("F1 — a quote-linked reservation deposit cannot be paid twice", () => {
  test("createReservation REFUSES a deposit together with dealQuoteId, and writes nothing", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);

    await expect(
      s.manager.as.mutation(api.vehicles.createReservation, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        depositAmount: 22000,
        depositMethod: "CASH",
        dealQuoteId: quoteId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/linked to a quote.*quote's deposit screen/i);

    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
    expect(await s.t.run((ctx) => ctx.db.query("vehicleReservations").collect())).toHaveLength(0);
  });

  test("ordering 2: a PENDING request then a linked reservation deposit -> refused, no receipt", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await requestDeposit(s, quoteId, 22000);

    await expect(
      s.manager.as.mutation(api.vehicles.createReservation, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        depositAmount: 22000,
        depositMethod: "CASH",
        dealQuoteId: quoteId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/linked to a quote/i);
    expect((await moneyFootprint(s)).deposits).toBe(0);
  });

  test("ordering 1: a live quote-linked reservation deposit -> request, record and confirm all fail closed", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    // Raised BEFORE the reservation deposit exists, so `confirm` is exercised too.
    const earlyRequest = await requestDeposit(s, quoteId, 22000);
    await seedQuoteLinkedReservationDeposit(s, quoteId);
    expect((await moneyFootprint(s)).deposits).toBe(1);

    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(/reservation deposit.*already holding money/i);
    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId: earlyRequest,
        amount: 22000,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/reservation deposit.*already holding money/i);
    expect((await s.t.run((ctx) => ctx.db.get(earlyRequest)))?.status).toBe("PENDING");

    // Withdraw the waiting request so DA-04 does not answer first, then the
    // direct door must still fail closed on the reservation deposit.
    await s.sales.as.mutation(api.depositRequests.withdraw, { orgId: s.orgId, requestId: earlyRequest });
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId,
        quoteId,
        amount: 22000,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/reservation deposit.*already holding money/i);

    // Exactly ONE receipt in the whole org.
    expect((await moneyFootprint(s)).deposits).toBe(1);
  });

  test("controls: a deposit-free quote-linked reservation and a standalone reservation deposit still work", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    // Standalone reservation WITH a deposit: unchanged.
    const standalone = await s.manager.as.mutation(api.vehicles.createReservation, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      depositAmount: 1000,
      depositMethod: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(standalone).toBeTruthy();
    expect((await moneyFootprint(s)).deposits).toBe(1);

    // A second car: deposit-free reservation naming its quote is unchanged.
    const car2 = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "1HGCM82633A555555", make: "Kia", model: "Sportage", year: 2022,
        color: "Blue", fuelType: "Gasoline", transmission: "Automatic", mileage: 900,
        sellingPrice: 18000, status: "AVAILABLE",
      })
    );
    const quote2 = await makeQuote(s, { vehicleId: car2 });
    const linked = await s.manager.as.mutation(api.vehicles.createReservation, {
      orgId: s.orgId,
      vehicleId: car2,
      customerId: s.customerId,
      dealQuoteId: quote2,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(linked).toBeTruthy();
    expect((await moneyFootprint(s)).deposits).toBe(1);
    // ...and the quote for a car with NO such deposit still takes a request.
    await expect(requestDeposit(s, quote2, 500)).resolves.toBeTruthy();
    void quoteId;
  });
});

describe("F2 — currency", () => {
  test("a PENDING request locks the organization currency; a resolved one does not", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const requestId = await requestDeposit(s, quoteId, 1500);
    // Changing the currency is an owner action (`requireOwner`).
    const ownerUserId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_owner", email: "owner@test.com", name: "Owner" })
    );
    const ownerRoleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId: s.orgId,
        name: "OWNER",
        permissions: [...Object.values(PERMISSIONS)],
        isSystemOwnerRole: true,
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: s.orgId, userId: ownerUserId, roleId: ownerRoleId })
    );
    const owner = s.t.withIdentity({ subject: "user_owner", clerkId: "user_owner" });

    await expect(
      owner.mutation(api.orgSettings.upsert, { orgId: s.orgId, currency: "USD" })
    ).rejects.toThrow(/currency cannot be changed/i);

    await s.manager.as.mutation(api.depositRequests.reject, {
      orgId: s.orgId,
      requestId,
      reason: "Customer changed their mind",
    });
    await expect(
      owner.mutation(api.orgSettings.upsert, { orgId: s.orgId, currency: "USD" })
    ).resolves.toBeDefined();
  });

  test("confirm refuses a request raised in another currency BEFORE any write", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const requestId = await s.t.run((ctx) =>
      ctx.db.insert("depositRequests", {
        orgId: s.orgId,
        quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        amount: 1500,
        amountMinor: 150000,
        currency: "USD",
        status: "PENDING",
        requestedBy: s.sales.userId,
        requestedAt: Date.now(),
        idempotencyKey: "anomalous-usd",
      })
    );

    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/raised in USD.*now uses JOD.*raise a new request/i);
    expect(await moneyFootprint(s)).toEqual(NO_MONEY);
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
  });

  test("control: a same-currency request confirms", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const requestId = await requestDeposit(s, quoteId, 1500);
    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId,
        requestId,
        amount: 1500,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).resolves.toBeTruthy();
    expect((await moneyFootprint(s)).deposits).toBe(1);
  });
});

describe("F3/F4 — who is told, and where the link goes", () => {
  async function offboard(s: Ctx, userId: Id<"users">) {
    await s.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", s.orgId).eq("userId", userId))
        .unique();
      await ctx.db.patch(membership!._id, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" });
    });
  }
  const notifiedFor = (s: Ctx, type: string) =>
    s.t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter((n) => n.type === type)
    );

  test("the new-request notification links to the approvals queue, where accountants can act", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await requestDeposit(s, quoteId, 1500);
    const created = await notifiedFor(s, "depositRequest.created");
    expect(created.length).toBeGreaterThan(0);
    for (const n of created) expect(n.link).toBe(`/${s.orgId}/approvals`);
  });

  test("an OFFBOARDED finance member is told nothing; active finance members still are", async () => {
    const s = await setup();
    await offboard(s, s.accountant.userId);
    const quoteId = await makeQuote(s);
    await requestDeposit(s, quoteId, 1500);

    const recipients = (await notifiedFor(s, "depositRequest.created")).map((n) => n.userId);
    expect(recipients).not.toContain(s.accountant.userId);
    expect(recipients).toContain(s.manager.userId);
  });

  test("an OFFBOARDED requester gets no rejection or confirmation notice; an active one does", async () => {
    const s = await setup();
    const q1 = await makeQuote(s);
    const r1 = await requestDeposit(s, q1, 1500);
    await s.manager.as.mutation(api.depositRequests.reject, { orgId: s.orgId, requestId: r1, reason: "No funds" });
    expect((await notifiedFor(s, "depositRequest.rejected")).map((n) => n.userId)).toEqual([s.sales.userId]);

    const car2 = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "1HGCM82633A666666", make: "Kia", model: "Rio", year: 2021,
        color: "Grey", fuelType: "Gasoline", transmission: "Automatic", mileage: 700,
        sellingPrice: 12000, status: "AVAILABLE",
      })
    );
    const q2 = await makeQuote(s, { vehicleId: car2 });
    const r2 = await requestDeposit(s, q2, 500);
    await offboard(s, s.sales.userId);
    await s.manager.as.mutation(api.depositRequests.reject, { orgId: s.orgId, requestId: r2, reason: "Changed mind" });
    await s.manager.as.mutation(api.depositRequests.confirm, {
      orgId: s.orgId,
      requestId: await s.t.run(async (ctx) =>
        (await ctx.db.insert("depositRequests", {
          orgId: s.orgId, quoteId: q2, customerId: s.customerId, vehicleId: car2,
          amount: 500, amountMinor: 500000, currency: "JOD", status: "PENDING",
          requestedBy: s.sales.userId, requestedAt: Date.now(), idempotencyKey: "off-confirm",
        }))
      ),
      amount: 500,
      method: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    // Still exactly the ONE notice from the active-requester control above.
    expect((await notifiedFor(s, "depositRequest.rejected"))).toHaveLength(1);
    expect(await notifiedFor(s, "depositRequest.confirmed")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FIX ROUND 2 (Opus 5.5 N1/N2 + Sol F1-R2 on b8f6fe9e4)
//
// INVARIANT: every HELD/APPLIED receipt that belongs to a quote's deal — however
// it joined (quote deposit, quote-linked reservation, reservation joined via
// dealDepositId, standalone reservation adopted into the quote) — is visible to
// every door that can post money for the quote, and the probe fails CLOSED.
// ---------------------------------------------------------------------------

const RESERVATION_MONEY = /reservation deposit.*already holding money/i;
const FUNDED_ADOPTION = /already holds a deposit.*cannot be continued/i;

async function fundedStandaloneReservation(
  s: Ctx,
  amount = 22000,
  vehicleId = s.vehicleId,
  creator: "manager" | "cashier" = "manager"
) {
  let actor = s.manager.as;
  if (creator === "cashier") {
    // A second finance actor, so a DIFFERENT person (the manager) can resolve the
    // deposit — the creator may not resolve their own.
    const userId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_cashier", email: "cashier@test.com", name: "Cashier" })
    );
    const roleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId: s.orgId,
        name: "CASHIER",
        permissions: [PERMISSIONS.EDIT_VEHICLES, PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT],
      })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId }));
    actor = s.t.withIdentity({ subject: "user_cashier", clerkId: "user_cashier" });
  }
  await actor.mutation(api.vehicles.createReservation, {
    orgId: s.orgId,
    vehicleId,
    customerId: s.customerId,
    depositAmount: amount,
    depositMethod: "CASH",
    idempotencyKey: crypto.randomUUID(),
  });
  return await s.t.run(async (ctx) => {
    const reservation = (await ctx.db.query("vehicleReservations").collect()).find(
      (r) => r.vehicleId === vehicleId && r.status === "ACTIVE"
    );
    if (!reservation) throw new Error("fixture: no ACTIVE reservation");
    return reservation._id;
  });
}

/** The pre-fix adoption's footprint: root re-headed onto the quote, claim untagged. */
async function rehead(s: Ctx, quoteId: Id<"quotes">, vehicleId = s.vehicleId) {
  await s.t.run(async (ctx) => {
    const root = await ctx.db
      .query("commitmentRoots")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", s.orgId).eq("vehicleId", vehicleId).eq("status", "OPEN")
      )
      .unique();
    await ctx.db.patch(root!._id, { headQuoteId: quoteId });
  });
}

async function seedAnotherCar(s: Ctx, vin: string) {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin, make: "Kia", model: "Sportage", year: 2022,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic", mileage: 900,
      sellingPrice: 18000, status: "AVAILABLE",
    })
  );
}

describe("R2 (i) R-A — dealDepositId joins the deal, so it cannot carry a deposit either", () => {
  test("a reservation deposit naming the quote's DEPOSIT is refused; nothing is written", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const depositId = await s.manager.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 5000, method: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    const before = await moneyFootprint(s);
    expect(before.deposits).toBe(1);

    await expect(
      s.manager.as.mutation(api.vehicles.createReservation, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        depositAmount: 3000,
        depositMethod: "CASH",
        dealDepositId: depositId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/linked to a quote or one of its deposits.*quote's deposit screen/i);

    expect(await moneyFootprint(s)).toEqual(before);
    expect(await s.t.run((ctx) => ctx.db.query("vehicleReservations").collect())).toHaveLength(0);
  });

  test("ordering 2: with a request PENDING on the quote the same call is still refused, no receipt", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const depositId = await s.manager.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 5000, method: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    await requestDeposit(s, quoteId, 1000);
    const before = await moneyFootprint(s);

    await expect(
      s.manager.as.mutation(api.vehicles.createReservation, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        depositAmount: 3000,
        depositMethod: "CASH",
        dealDepositId: depositId,
        dealQuoteId: quoteId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/linked to a quote or one of its deposits/i);
    expect(await moneyFootprint(s)).toEqual(before);
  });

  test("control: a DEPOSIT-FREE reservation naming the quote's deposit still joins", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const depositId = await s.manager.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 5000, method: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      s.manager.as.mutation(api.vehicles.createReservation, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        dealDepositId: depositId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).resolves.toBeTruthy();
    expect((await moneyFootprint(s)).deposits).toBe(1);
  });
});

describe("R2 (ii)/(iii) R-B — a FUNDED reservation is never adopted", () => {
  test("deposits.create({adoptReservationId}) on a funded reservation is refused; zero new money rows", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const reservationId = await fundedStandaloneReservation(s);
    const before = await moneyFootprint(s);
    expect(before.deposits).toBe(1);

    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 22000, method: "CASH",
        adoptReservationId: reservationId, idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(FUNDED_ADOPTION);
    expect(await moneyFootprint(s)).toEqual(before);
  });

  test("applications.createFromQuote({adoptReservationId}) on a funded reservation is refused", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const reservationId = await fundedStandaloneReservation(s);
    const before = await moneyFootprint(s);

    await expect(
      s.manager.as.mutation(api.applications.createFromQuote, {
        orgId: s.orgId, quoteId, adoptReservationId: reservationId,
      })
    ).rejects.toThrow(FUNDED_ADOPTION);
    expect(await s.t.run((ctx) => ctx.db.query("financeApplications").collect())).toHaveLength(0);
    expect(await moneyFootprint(s)).toEqual(before);
  });

  test("controls: DEPOSIT-FREE adoption still works at both doors", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await s.manager.as.mutation(api.vehicles.createReservation, {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, idempotencyKey: crypto.randomUUID(),
    });
    const reservationId = await s.t.run(async (ctx) => (await ctx.db.query("vehicleReservations").collect())[0]._id);
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 5000, method: "CASH",
        adoptReservationId: reservationId, idempotencyKey: crypto.randomUUID(),
      })
    ).resolves.toBeTruthy();

    const car2 = await seedAnotherCar(s, "1HGCM82633A777777");
    const quote2 = await makeQuote(s, { vehicleId: car2 });
    await s.manager.as.mutation(api.vehicles.createReservation, {
      orgId: s.orgId, vehicleId: car2, customerId: s.customerId, idempotencyKey: crypto.randomUUID(),
    });
    const reservation2 = await s.t.run(async (ctx) =>
      (await ctx.db.query("vehicleReservations").collect()).find((r) => r.vehicleId === car2)!._id
    );
    await expect(
      s.manager.as.mutation(api.applications.createFromQuote, {
        orgId: s.orgId, quoteId: quote2, adoptReservationId: reservation2,
      })
    ).resolves.toBeTruthy();
  });

  test("control: once the reservation deposit is RELEASED, adoption and the quote deposit are allowed", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    // Created by a different finance actor: the creator may not resolve their own deposit.
    const reservationId = await fundedStandaloneReservation(s, 22000, s.vehicleId, "cashier");
    const reservationDepositId = await s.t.run(
      async (ctx) => (await ctx.db.get(reservationId))!.depositId!
    );

    // The operator path: Vehicle > Deposits > Refund (deposits.release).
    await s.manager.as.mutation(api.deposits.release, {
      orgId: s.orgId,
      depositId: reservationDepositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    expect((await s.t.run((ctx) => ctx.db.get(reservationDepositId)))?.status).toBe("REFUNDED");

    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 22000, method: "CASH",
        adoptReservationId: reservationId, idempotencyKey: crypto.randomUUID(),
      })
    ).resolves.toBeTruthy();
  });

  test("control: a standalone funded reservation alone is untouched, and other orgs' reservations do not interfere", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    // Another tenant's funded reservation on ITS car.
    const foreignCar = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.otherOrgId, vin: "1HGCM82633A888888", make: "Kia", model: "Rio", year: 2021,
        color: "Grey", fuelType: "Gasoline", transmission: "Automatic", mileage: 700,
        sellingPrice: 12000, status: "AVAILABLE",
      })
    );
    const foreignCustomer = await s.t.run((ctx) =>
      ctx.db.insert("customers", { orgId: s.otherOrgId, firstName: "Far", lastName: "Away" })
    );
    await s.outsider.as.mutation(api.vehicles.createReservation, {
      orgId: s.otherOrgId, vehicleId: foreignCar, customerId: foreignCustomer,
      depositAmount: 12000, depositMethod: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    await expect(requestDeposit(s, quoteId, 500)).resolves.toBeTruthy();
  });
});

describe("R2 (iv) — request PENDING, then a funded standalone reservation", () => {
  test("adoption is refused, and confirm stays refused while the reservation money is held", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const requestId = await requestDeposit(s, quoteId, 22000);
    const reservationId = await fundedStandaloneReservation(s);
    const before = await moneyFootprint(s);
    expect(before.deposits).toBe(1);

    await expect(
      s.manager.as.mutation(api.applications.createFromQuote, {
        orgId: s.orgId, quoteId, adoptReservationId: reservationId,
      })
    ).rejects.toThrow(FUNDED_ADOPTION);
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 22000, method: "CASH",
        adoptReservationId: reservationId, idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow();

    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId, requestId, amount: 22000, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow();
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
    expect(await moneyFootprint(s)).toEqual(before);
  });
});

describe("R2 (v) — the historical/adopted shape: root re-headed onto the quote, claim untagged", () => {
  test("request, confirm and deposits.create all refuse on the root probe", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const earlyRequest = await requestDeposit(s, quoteId, 22000);
    await fundedStandaloneReservation(s);
    await rehead(s, quoteId);
    // The claim carries no quote — this is exactly what the claim-tag probe missed.
    const claims = await s.t.run((ctx) => ctx.db.query("vehicleCommitmentClaims").collect());
    expect(claims).toHaveLength(1);
    expect(claims[0].quoteId).toBeUndefined();
    const before = await moneyFootprint(s);
    expect(before.deposits).toBe(1);

    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId, requestId: earlyRequest, amount: 22000, method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(RESERVATION_MONEY);
    await s.sales.as.mutation(api.depositRequests.withdraw, { orgId: s.orgId, requestId: earlyRequest });
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 22000, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(RESERVATION_MONEY);
    expect(await moneyFootprint(s)).toEqual(before);
  });

  test("multi-vehicle quote: the shape on the SECOND car is still seen", async () => {
    const s = await setup();
    const car2 = await seedAnotherCar(s, "1HGCM82633A999999");
    const quoteId = await makeQuote(s);
    await s.t.run((ctx) =>
      ctx.db.patch(quoteId, {
        vehicleItems: [
          { vehicleId: s.vehicleId, unitPrice: 22000 },
          { vehicleId: car2, unitPrice: 18000 },
        ],
      })
    );
    await fundedStandaloneReservation(s, 18000, car2);
    await rehead(s, quoteId, car2);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });

  test("control: once the reservation deposit is RELEASED the quote can take a request again", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const reservationId = await fundedStandaloneReservation(s, 22000, s.vehicleId, "cashier");
    await rehead(s, quoteId);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
    const depositId = await s.t.run(async (ctx) => (await ctx.db.get(reservationId))!.depositId!);
    await s.manager.as.mutation(api.deposits.release, {
      orgId: s.orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH",
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });
});

describe("R2 (vi) N2 — the probe fails closed, never open", () => {
  async function insertTerminalRootWithActiveClaims(s: Ctx, claimCount: number) {
    await s.t.run(async (ctx) => {
      const rootId = await ctx.db.insert("commitmentRoots", {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        status: "RELEASED",
        openedAt: Date.now(),
        openedBy: s.manager.userId,
        closedAt: Date.now(),
      });
      for (let i = 0; i < claimCount; i++) {
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: s.orgId,
          rootId,
          vehicleId: s.vehicleId,
          evidenceKind: "FINANCE",
          status: "ACTIVE",
          createdAt: Date.now(),
          createdBy: s.manager.userId,
        });
      }
    });
  }

  /** A RELEASED root headed at `headQuoteId`, whose ACTIVE claims may carry `claimQuoteId`. */
  async function insertRootHeadedAt(
    s: Ctx,
    headQuoteId: Id<"quotes"> | undefined,
    claimCount: number,
    claimQuoteId?: Id<"quotes">
  ) {
    await s.t.run(async (ctx) => {
      const rootId = await ctx.db.insert("commitmentRoots", {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        status: "RELEASED",
        openedAt: Date.now(),
        openedBy: s.manager.userId,
        closedAt: Date.now(),
        ...(headQuoteId ? { headQuoteId } : {}),
      });
      for (let i = 0; i < claimCount; i++) {
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: s.orgId,
          rootId,
          vehicleId: s.vehicleId,
          evidenceKind: "FINANCE",
          status: "ACTIVE",
          createdAt: Date.now(),
          createdBy: s.manager.userId,
          ...(claimQuoteId ? { quoteId: claimQuoteId } : {}),
        });
      }
    });
  }

  test("more than 10 older ACTIVE claims on the car do not hide the match", async () => {
    const s = await setup();
    // Claims never leave ACTIVE in production, so finished deals pile up first.
    await insertTerminalRootWithActiveClaims(s, 12);
    const quoteId = await makeQuote(s);
    await fundedStandaloneReservation(s);
    await rehead(s, quoteId);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });

  test("the match sitting beyond the first 10 ACTIVE claims of the SAME root is still seen", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const reservationId = await fundedStandaloneReservation(s);
    await rehead(s, quoteId);
    // Episodes accumulate on the root (nothing retires them); the reservation's
    // own episode ends up behind a dozen others.
    await s.t.run(async (ctx) => {
      const original = (await ctx.db.query("vehicleCommitmentClaims").collect())[0];
      await ctx.db.delete(original._id);
      for (let i = 0; i < 12; i++) {
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: s.orgId, rootId: original.rootId, vehicleId: s.vehicleId,
          evidenceKind: "FINANCE", status: "ACTIVE",
          createdAt: Date.now(), createdBy: s.manager.userId,
        });
      }
      await ctx.db.insert("vehicleCommitmentClaims", {
        orgId: s.orgId, rootId: original.rootId, vehicleId: s.vehicleId,
        evidenceKind: "RESERVATION", status: "ACTIVE", reservationId,
        createdAt: Date.now(), createdBy: s.manager.userId,
      });
    });
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });
  test("the tagged (round-1) shape is also seen behind more than 10 older claims", async () => {
    const s = await setup();
    await insertTerminalRootWithActiveClaims(s, 12);
    const quoteId = await makeQuote(s);
    await seedQuoteLinkedReservationDeposit(s, quoteId);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });

  // R5: the probe no longer walks a root's claims or counts tagged claims, so a
  // root with hundreds of unrelated episodes, or hundreds of tagged
  // non-reservation claims, is simply not read. (The round-3 versions of these
  // three tests asserted an overflow that was itself the defect.)
  test("R5: a root of THIS deal carrying 600 unrelated episodes is NOT walked, and does not overflow", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await insertRootHeadedAt(s, quoteId, 600);
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });

  test("R5: 600 claims TAGGED with one quote (non-reservation evidence) do not overflow", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await insertRootHeadedAt(s, undefined, 300, quoteId);
    await insertRootHeadedAt(s, undefined, 300, quoteId);
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });

  test("control: a car with a few finished deals and no reservation money still takes a request", async () => {
    const s = await setup();
    await insertTerminalRootWithActiveClaims(s, 3);
    const quoteId = await makeQuote(s);
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });
});
// ---------------------------------------------------------------------------
// FIX ROUND 3 — the probe is scoped to THE QUOTE'S OWN deal, never the car's history
// ---------------------------------------------------------------------------

/**
 * Finished deals pile up on a car for its whole life (a lapsed hold, a released
 * reservation, a refund, a cancelled application each leave one terminal root).
 * Built through the REAL mutations, not raw inserts, so the roots are exactly
 * the ones production writes.
 */
async function churnReleasedRoots(s: Ctx, count: number) {
  for (let i = 0; i < count; i++) {
    await s.manager.as.mutation(api.vehicles.createReservation, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      idempotencyKey: crypto.randomUUID(),
    });
    const reservationId = await s.t.run(async (ctx) => {
      const active = await ctx.db
        .query("vehicleReservations")
        .withIndex("by_status_expiresAt", (q) => q.eq("status", "ACTIVE"))
        .take(5);
      const mine = active.filter((r) => r.vehicleId === s.vehicleId);
      if (mine.length !== 1) throw new Error("fixture: expected one ACTIVE reservation");
      return mine[0]._id;
    });
    await s.manager.as.mutation(api.vehicles.releaseReservation, { orgId: s.orgId, reservationId });
  }
}

async function otherCustomerQuote(s: Ctx) {
  const customerId = await s.t.run((ctx) =>
    ctx.db.insert("customers", { orgId: s.orgId, firstName: "Omar", lastName: "Saad" })
  );
  return await makeQuote(s, { customerId });
}

const FOREIGN_ROOTS = 30;

describe("R3 — unrelated history on the car never blocks a deal", () => {
  test("the churn fixture really leaves many RELEASED roots on the car", async () => {
    const s = await setup();
    await churnReleasedRoots(s, FOREIGN_ROOTS);
    const released = await s.t.run((ctx) =>
      ctx.db
        .query("commitmentRoots")
        .withIndex("by_org_vehicle_status", (q) =>
          q.eq("orgId", s.orgId).eq("vehicleId", s.vehicleId).eq("status", "RELEASED")
        )
        .take(100)
    );
    expect(released.length).toBeGreaterThanOrEqual(FOREIGN_ROOTS);
  });

  test("request succeeds for a new quote (different customer)", async () => {
    const s = await setup();
    await churnReleasedRoots(s, FOREIGN_ROOTS);
    const quoteId = await otherCustomerQuote(s);
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });

  test("confirm succeeds for a new quote (different customer)", async () => {
    const s = await setup();
    await churnReleasedRoots(s, FOREIGN_ROOTS);
    const quoteId = await otherCustomerQuote(s);
    const requestId = await requestDeposit(s, quoteId, 100);
    await expect(
      s.manager.as.mutation(api.depositRequests.confirm, {
        orgId: s.orgId, requestId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).resolves.toBeTruthy();
  });

  test("deposits.create succeeds for a new quote (different customer)", async () => {
    const s = await setup();
    await churnReleasedRoots(s, FOREIGN_ROOTS);
    const quoteId = await otherCustomerQuote(s);
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).resolves.toBeTruthy();
  });

  test("with the foreign roots present, a live funded reservation on THIS deal's root is still refused", async () => {
    const s = await setup();
    await churnReleasedRoots(s, FOREIGN_ROOTS);
    const quoteId = await otherCustomerQuote(s);
    await fundedStandaloneReservation(s);
    await rehead(s, quoteId);
    const before = await moneyFootprint(s);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(RESERVATION_MONEY);
    expect(await moneyFootprint(s)).toEqual(before);
  });

  test("with the foreign roots present, the TAGGED (round-1) shape is still refused", async () => {
    const s = await setup();
    await churnReleasedRoots(s, FOREIGN_ROOTS);
    const quoteId = await otherCustomerQuote(s);
    await seedQuoteLinkedReservationDeposit(s, quoteId);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });

  test("control: a multi-vehicle quote sees a funded reservation on either car, with foreign history on one", async () => {
    const s = await setup();
    const car2 = await seedAnotherCar(s, "1HGCM82633A888888");
    await churnReleasedRoots(s, FOREIGN_ROOTS);
    const quoteId = await otherCustomerQuote(s);
    await s.t.run((ctx) =>
      ctx.db.patch(quoteId, {
        vehicleItems: [
          { vehicleId: s.vehicleId, unitPrice: 22000 },
          { vehicleId: car2, unitPrice: 18000 },
        ],
      })
    );
    await fundedStandaloneReservation(s, 18000, car2);
    await rehead(s, quoteId, car2);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });
});

// ---------------------------------------------------------------------------
// FIX ROUND 5 — the probe is bounded by the deal's reservation ORIGINS and its
// FUNDED tagged reservations, never by roots, episodes, cars or deposits.
//
// INVARIANT: every HELD/APPLIED receipt of a reservation that belongs to quote
// Q's deal is visible to every door that posts money for Q, and the probe's
// database calls are a small constant times the number of distinct reservation
// origins / funded reservation deposits linked to Q.
// ---------------------------------------------------------------------------

const UNREADABLE_REFUSAL = /could not be found.*administrator/i;
const OVERFLOW_REFUSAL = /too many reservations.*administrator/i;

async function seedCars(s: Ctx, count: number, prefix = "R5") {
  return await s.t.run(async (ctx) => {
    const ids: Id<"vehicles">[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        await ctx.db.insert("vehicles", {
          orgId: s.orgId, vin: `${prefix}${String(i).padStart(6, "0")}VIN`, make: "Kia", model: "Rio",
          year: 2021, color: "Grey", fuelType: "Gasoline", transmission: "Automatic", mileage: 100 + i,
          sellingPrice: 10000, status: "AVAILABLE",
        })
      );
    }
    return ids;
  });
}

/** Rows written DIRECTLY (no writer): each helper is named at its call site. */
async function directDeposit(
  s: Ctx,
  over: { status?: "HELD" | "APPLIED" | "REFUNDED" | "FORFEITED" | "VOIDED"; orgId?: Id<"organizations">; isDeleted?: boolean; quoteId?: Id<"quotes"> } = {}
) {
  return await s.t.run((ctx) =>
    ctx.db.insert("deposits", {
      orgId: over.orgId ?? s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      amount: 100,
      status: over.status ?? "HELD",
      holdActive: false,
      createdBy: s.manager.userId,
      createdAt: Date.now(),
      ...(over.isDeleted ? { isDeleted: true } : {}),
      ...(over.quoteId ? { quoteId: over.quoteId } : {}),
    })
  );
}

async function directReservation(
  s: Ctx,
  over: { depositId?: Id<"deposits">; orgId?: Id<"organizations"> } = {}
) {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicleReservations", {
      orgId: over.orgId ?? s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      status: "RELEASED",
      reservedBy: s.manager.userId,
      reservedAt: Date.now(),
      ...(over.depositId ? { depositId: over.depositId } : {}),
    })
  );
}

async function directRoot(
  s: Ctx,
  over: {
    headQuoteId?: Id<"quotes">;
    originReservationId?: Id<"vehicleReservations">;
    orgId?: Id<"organizations">;
    status?: "OPEN" | "RELEASED" | "CONSUMED";
  }
) {
  return await s.t.run((ctx) =>
    ctx.db.insert("commitmentRoots", {
      orgId: over.orgId ?? s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      status: over.status ?? "RELEASED",
      openedAt: Date.now(),
      openedBy: s.manager.userId,
      closedAt: Date.now(),
      ...(over.headQuoteId ? { headQuoteId: over.headQuoteId } : {}),
      ...(over.originReservationId ? { originReservationId: over.originReservationId } : {}),
    })
  );
}

async function directReservationClaim(
  s: Ctx,
  over: {
    rootId: Id<"commitmentRoots">;
    reservationId: Id<"vehicleReservations">;
    depositId?: Id<"deposits">;
    quoteId?: Id<"quotes">;
    orgId?: Id<"organizations">;
    status?: "ACTIVE" | "RELEASED" | "CONSUMED";
  }
) {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicleCommitmentClaims", {
      orgId: over.orgId ?? s.orgId,
      rootId: over.rootId,
      vehicleId: s.vehicleId,
      evidenceKind: "RESERVATION",
      status: over.status ?? "RELEASED",
      reservationId: over.reservationId,
      createdAt: Date.now(),
      createdBy: s.manager.userId,
      ...(over.depositId ? { depositId: over.depositId } : {}),
      ...(over.quoteId ? { quoteId: over.quoteId } : {}),
    })
  );
}

/** A Q-headed root whose origin reservation carries `depositId` (Branch H shape). */
async function headedOriginWithDeposit(
  s: Ctx,
  quoteId: Id<"quotes">,
  depositId: Id<"deposits"> | undefined,
  rootStatus: "OPEN" | "RELEASED" | "CONSUMED" = "RELEASED"
) {
  const reservationId = await directReservation(s, { depositId });
  const rootId = await directRoot(s, { headQuoteId: quoteId, originReservationId: reservationId, status: rootStatus });
  return { reservationId, rootId };
}

/** A tagged FUNDED reservation claim (Branch T shape). */
async function taggedFundedClaim(s: Ctx, quoteId: Id<"quotes">, depositId: Id<"deposits">) {
  const reservationId = await directReservation(s, { depositId });
  const rootId = await directRoot(s, { originReservationId: reservationId });
  await directReservationClaim(s, { rootId, reservationId, depositId, quoteId });
  return { reservationId, rootId };
}

async function linkedUnfundedCycles(s: Ctx, quoteId: Id<"quotes">, count: number) {
  for (let i = 0; i < count; i++) {
    await s.manager.as.mutation(api.vehicles.createReservation, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      dealQuoteId: quoteId,
      idempotencyKey: crypto.randomUUID(),
    });
    const reservationId = await s.t.run(async (ctx) => {
      const active = await ctx.db
        .query("vehicleReservations")
        .withIndex("by_status_expiresAt", (q) => q.eq("status", "ACTIVE"))
        .take(5);
      const mine = active.filter((r) => r.vehicleId === s.vehicleId);
      if (mine.length !== 1) throw new Error("fixture: expected one ACTIVE reservation");
      return mine[0]._id;
    });
    await s.manager.as.mutation(api.vehicles.releaseReservation, { orgId: s.orgId, reservationId });
  }
}

async function confirmPending(s: Ctx, requestId: Id<"depositRequests">, amount = 100) {
  return await s.manager.as.mutation(api.depositRequests.confirm, {
    orgId: s.orgId, requestId, amount, method: "CASH", idempotencyKey: crypto.randomUUID(),
  });
}

describe("R5 — the probe's bounds are the constants the design states", () => {
  test("exported bounds", () => {
    expect(RESERVATION_PROBE_MAX_ORIGINS_PER_QUOTE).toBe(100);
    expect(RESERVATION_PROBE_MAX_FUNDED_TAGGED_PER_QUOTE).toBe(50);
  });
});

describe("R5 T1 — a multi-car CASH quote is never a dead end (platform limits ENFORCED)", () => {
  test.each([100, 101])(
    "%i-car quote: deposits.create, then request, then confirm all succeed",
    async (cars) => {
      const s = await setup({ transactionLimits: true });
      const extra = await seedCars(s, cars - 1);
      const quoteId = await makeQuote(s);
      await s.t.run((ctx) =>
        ctx.db.patch(quoteId, {
          vehicleItems: [s.vehicleId, ...extra].map((vehicleId) => ({ vehicleId, unitPrice: 200 })),
        })
      );
      await s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      });
      const requestId = await requestDeposit(s, quoteId, 100);
      await expect(confirmPending(s, requestId, 100)).resolves.toBeTruthy();
      expect((await moneyFootprint(s)).deposits).toBe(2);
    },
    240_000
  );
});

async function maxShapeQuote(s: Ctx, cars: number) {
  const extra = await seedCars(s, cars - 1);
  const quoteId = await makeQuote(s);
  await s.t.run((ctx) =>
    ctx.db.patch(quoteId, {
      vehicleItems: [s.vehicleId, ...extra].map((vehicleId) => ({ vehicleId, unitPrice: 200 })),
    })
  );
  // Maximum probe shape, nothing refusing: 100 origins + 50 funded tagged deposits.
  for (let i = 0; i < 100; i++) {
    await headedOriginWithDeposit(s, quoteId, await directDeposit(s, { status: "REFUNDED" }));
  }
  for (let i = 0; i < 50; i++) {
    await taggedFundedClaim(s, quoteId, await directDeposit(s, { status: "REFUNDED" }));
  }
  return quoteId;
}

describe("R5 T1b — the known ENVELOPE of a large quote combined with the maximum probe shape (limits ENFORCED)", () => {
  test("(a) envelope pass: a 90-car quote with the max probe shape -> deposits.create, request, confirm all succeed", async () => {
    const s = await setup({ transactionLimits: true });
    const quoteId = await maxShapeQuote(s, 90);
    const beforeDeposits = (await moneyFootprint(s)).deposits;
    await s.manager.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    const requestId = await requestDeposit(s, quoteId, 100);
    await expect(confirmPending(s, requestId, 100)).resolves.toBeTruthy();
    expect((await moneyFootprint(s)).deposits).toBe(beforeDeposits + 2);
  }, 300_000);

  test("(b) KNOWN ENVELOPE (follow-up SCRUM-461): a 101-car quote with the max probe shape exceeds the platform range limit and the transaction writes nothing", async () => {
    const s = await setup({ transactionLimits: true });
    const quoteId = await maxShapeQuote(s, 101);
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/Too many index ranges/i);
    const written = await s.t.run(async (ctx) => ({
      deposits: (await ctx.db.query("deposits").collect()).filter((d) => d.quoteId === quoteId).length,
      requests: (await ctx.db.query("depositRequests").collect()).filter((r) => r.quoteId === quoteId).length,
    }));
    expect(written).toEqual({ deposits: 0, requests: 0 });
  }, 300_000);
});

describe("R5 T2 — many instalments on one quote across cars", () => {
  test("200 deposits over a 3-car quote, then a request, still pass", async () => {
    const s = await setup();
    const extra = await seedCars(s, 2);
    const quoteId = await makeQuote(s);
    await s.t.run((ctx) =>
      ctx.db.patch(quoteId, {
        vehicleItems: [s.vehicleId, ...extra].map((vehicleId) => ({ vehicleId, unitPrice: 7000 })),
      })
    );
    for (let i = 0; i < 200; i++) {
      await s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 10, method: "CASH", idempotencyKey: crypto.randomUUID(),
      });
    }
    expect((await moneyFootprint(s)).deposits).toBe(200);
    await expect(requestDeposit(s, quoteId, 10)).resolves.toBeTruthy();
  }, 240_000);
});

describe("R5 T3 — restoration successors cost nothing", () => {
  // Rows inserted DIRECTLY: the successor roots (one per restoration, copying
  // headQuoteId + originReservationId exactly as restoration does). The funded
  // reservation, its deposit, its original root and its claim are real.
  test.each([60, 150])("one funded reservation's deal with %i restoration successors", async (successors) => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const reservationId = await fundedStandaloneReservation(s, 22000, s.vehicleId, "cashier");
    await rehead(s, quoteId);
    for (let i = 0; i < successors; i++) {
      await directRoot(s, { headQuoteId: quoteId, originReservationId: reservationId });
    }
    // The deposit is still HELD and has no quote: refused, however many successors.
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
    const depositId = await s.t.run(async (ctx) => (await ctx.db.get(reservationId))!.depositId!);
    await s.manager.as.mutation(api.deposits.release, {
      orgId: s.orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  }, 120_000);
});

describe("R5 T4/T7 — Branch T never counts unfunded reservations (Branch H counts unfunded origins, cap 100)", () => {
  test("T4 (Branch T): 51 unfunded dealQuoteId reservation cycles (create + release) still pass request and deposits.create", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await linkedUnfundedCycles(s, quoteId, 51);
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  }, 240_000);

  test("T4b (Branch T): the same 51 cycles do not block deposits.create", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await linkedUnfundedCycles(s, quoteId, 51);
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).resolves.toBeTruthy();
  }, 240_000);

  test("T7 (Branch T): a tagged UNFUNDED reservation passes", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await linkedUnfundedCycles(s, quoteId, 1);
    const claims = await s.t.run((ctx) => ctx.db.query("vehicleCommitmentClaims").collect());
    expect(claims.some((c) => c.evidenceKind === "RESERVATION" && c.quoteId === quoteId)).toBe(true);
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });
});

describe("R5 T4c — pinned current behaviour: Branch H counts unfunded origins", () => {
  // Documents the fail-closed cap, not a UI path: 101 real create -> release
  // cycles that each carry dealQuoteId = Q open 101 distinct origins on Q.
  test("101 real create->release cycles with dealQuoteId on Q -> guided overflow refusal", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await linkedUnfundedCycles(s, quoteId, 101);
    const before = await moneyFootprint(s);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(OVERFLOW_REFUSAL);
    expect(await moneyFootprint(s)).toEqual(before);
  }, 300_000);
});

describe("R5 T5 — the origin and funded-tagged bounds fail closed", () => {
  test("Branch H: 100 distinct origins pass, the 101st throws the guided overflow", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const refunded = await directDeposit(s, { status: "REFUNDED" });
    for (let i = 0; i < 100; i++) await headedOriginWithDeposit(s, quoteId, refunded);
    const atBound = await requestDeposit(s, quoteId, 100);
    await s.sales.as.mutation(api.depositRequests.withdraw, { orgId: s.orgId, requestId: atBound });
    await headedOriginWithDeposit(s, quoteId, refunded);
    const before = await moneyFootprint(s);
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(OVERFLOW_REFUSAL);
    expect(await moneyFootprint(s)).toEqual(before);
  }, 120_000);

  test("Branch H: many roots sharing ONE origin count once", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const reservationId = await directReservation(s, {});
    for (let i = 0; i < 250; i++) await directRoot(s, { headQuoteId: quoteId, originReservationId: reservationId });
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  }, 120_000);

  test("Branch T: 50 distinct funded tagged deposits pass, the 51st throws the guided overflow", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    for (let i = 0; i < 50; i++) {
      await taggedFundedClaim(s, quoteId, await directDeposit(s, { status: "REFUNDED" }));
    }
    const atBound = await requestDeposit(s, quoteId, 100);
    await s.sales.as.mutation(api.depositRequests.withdraw, { orgId: s.orgId, requestId: atBound });
    await taggedFundedClaim(s, quoteId, await directDeposit(s, { status: "REFUNDED" }));
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(OVERFLOW_REFUSAL);
  }, 120_000);

  test("Branch T: many tagged claims sharing ONE deposit count once", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const depositId = await directDeposit(s, { status: "REFUNDED" });
    for (let i = 0; i < 120; i++) await taggedFundedClaim(s, quoteId, depositId);
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  }, 120_000);
});

describe("R5 T6 — a live funded reservation is refused even when its root is finished", () => {
  test("adopted funded reservation, root and claim RELEASED, deposit HELD with no quote", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const reservationId = await fundedStandaloneReservation(s, 22000, s.vehicleId, "cashier");
    await rehead(s, quoteId);
    await s.t.run(async (ctx) => {
      const claim = (await ctx.db.query("vehicleCommitmentClaims").collect())[0];
      await ctx.db.patch(claim.rootId, { status: "RELEASED", closedAt: Date.now() });
      await ctx.db.patch(claim._id, { status: "RELEASED", resolvedAt: Date.now() });
    });
    void reservationId;
    const before = await moneyFootprint(s);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(RESERVATION_MONEY);
    expect(await moneyFootprint(s)).toEqual(before);
  });

  test("a restoration successor (no claims of its own) on a HELD funded origin is refused", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const held = await directDeposit(s, { status: "HELD" });
    await headedOriginWithDeposit(s, quoteId, held, "RELEASED");
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });

  test("APPLIED counts as live too", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const applied = await directDeposit(s, { status: "APPLIED" });
    await headedOriginWithDeposit(s, quoteId, applied, "CONSUMED");
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });

  test("Branch T: a tagged funded claim whose reservation does not name the deposit (claim carries it) is refused", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const held = await directDeposit(s, { status: "HELD" });
    const reservationId = await directReservation(s, {});
    const rootId = await directRoot(s, {});
    await directReservationClaim(s, { rootId, reservationId, depositId: held, quoteId });
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });

  test("a deposit already recorded ON this quote is the quote's own (visible), so it does not refuse", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const own = await directDeposit(s, { status: "HELD", quoteId });
    await headedOriginWithDeposit(s, quoteId, own);
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });
});

describe("R5 T8 — a missing reservation fails closed", () => {
  test("a Q-headed origin naming a reservation that does not exist -> guided administrator refusal", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const gone = await directReservation(s, {});
    await directRoot(s, { headQuoteId: quoteId, originReservationId: gone });
    await s.t.run((ctx) => ctx.db.delete(gone));
    const before = await moneyFootprint(s);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(UNREADABLE_REFUSAL);
    await expect(
      s.manager.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(UNREADABLE_REFUSAL);
    expect(await moneyFootprint(s)).toEqual(before);
  });

  test("a tagged funded claim naming a reservation that does not exist -> guided administrator refusal", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const refunded = await directDeposit(s, { status: "REFUNDED" });
    const gone = await directReservation(s, {});
    const rootId = await directRoot(s, {});
    await directReservationClaim(s, { rootId, reservationId: gone, depositId: refunded, quoteId });
    await s.t.run((ctx) => ctx.db.delete(gone));
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(UNREADABLE_REFUSAL);
  });
});

describe("R5 T9 — another organization's rows are never read as this one's", () => {
  test("an origin reservation belonging to another org -> fail closed, not 'clear'", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const foreign = await directReservation(s, { orgId: s.otherOrgId });
    await directRoot(s, { headQuoteId: quoteId, originReservationId: foreign });
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(UNREADABLE_REFUSAL);
  });

  test("a foreign-org ROOT headed at the same quote id is never seeked (the seek leads with orgId)", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const foreignDeposit = await directDeposit(s, { status: "HELD", orgId: s.otherOrgId });
    const foreignReservation = await directReservation(s, { orgId: s.otherOrgId, depositId: foreignDeposit });
    await directRoot(s, { orgId: s.otherOrgId, headQuoteId: quoteId, originReservationId: foreignReservation });
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });

  test("a foreign-org tagged CLAIM naming the quote is never seeked", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const foreignDeposit = await directDeposit(s, { status: "HELD", orgId: s.otherOrgId });
    const foreignReservation = await directReservation(s, { orgId: s.otherOrgId, depositId: foreignDeposit });
    const rootId = await directRoot(s, { orgId: s.otherOrgId });
    await directReservationClaim(s, {
      orgId: s.otherOrgId, rootId, reservationId: foreignReservation, depositId: foreignDeposit, quoteId,
    });
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });

  test("an own-org reservation pointing at another org's HELD deposit is not counted as money", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const foreignDeposit = await directDeposit(s, { status: "HELD", orgId: s.otherOrgId });
    await headedOriginWithDeposit(s, quoteId, foreignDeposit);
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });
});

describe("R5 T10/T11 — money that is not live does not block", () => {
  test.each(["REFUNDED", "FORFEITED", "VOIDED"] as const)("%s deposit passes at both branches", async (status) => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const dead = await directDeposit(s, { status });
    await headedOriginWithDeposit(s, quoteId, dead);
    await taggedFundedClaim(s, quoteId, await directDeposit(s, { status }));
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });

  test("T11: an isDeleted HELD deposit passes at both branches", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const deleted = await directDeposit(s, { status: "HELD", isDeleted: true });
    await headedOriginWithDeposit(s, quoteId, deleted);
    await taggedFundedClaim(s, quoteId, await directDeposit(s, { status: "HELD", isDeleted: true }));
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });

  test("an ordinary quote deposit (originless Q-headed root) does not hide a funded origin holding a HELD off-quote deposit", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await s.manager.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 100, method: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    const rootsHeaded = await s.t.run((ctx) =>
      ctx.db.query("commitmentRoots").filter((q) => q.eq(q.field("headQuoteId"), quoteId)).collect()
    );
    expect(rootsHeaded.length).toBeGreaterThan(0);
    expect(rootsHeaded.every((r) => r.originReservationId === undefined)).toBe(true);
    await headedOriginWithDeposit(s, quoteId, await directDeposit(s, { status: "HELD" }));
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });

  test("controls: a headed root with NO origin is never visited", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    for (let i = 0; i < 5; i++) await directRoot(s, { headQuoteId: quoteId });
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });
});

describe("R5 T12 — the probe's own database calls are bounded (platform limits ENFORCED)", () => {
  test("at the maximum shape the probe alone makes <= 700 database calls, and confirm's double run fits", async () => {
    const s = await setup({ transactionLimits: true });
    const quoteId = await makeQuote(s);
    // Maximum shape: 100 distinct Branch-H origins (each funded by a NON-live
    // deposit, so every one is fully inspected) + 50 distinct funded tagged
    // deposits. Everything is inspected; nothing refuses.
    for (let i = 0; i < 100; i++) {
      await headedOriginWithDeposit(s, quoteId, await directDeposit(s, { status: "REFUNDED" }));
    }
    for (let i = 0; i < 50; i++) {
      await taggedFundedClaim(s, quoteId, await directDeposit(s, { status: "REFUNDED" }));
    }
    const used = await s.t.run(async (ctx) => {
      const quote = (await ctx.db.get(quoteId))!;
      const before = await ctx.meta.getTransactionMetrics();
      await assertNoQuoteLinkedReservationDeposit(ctx, quote);
      const mid = await ctx.meta.getTransactionMetrics();
      await assertNoQuoteLinkedReservationDeposit(ctx, quote);
      const after = await ctx.meta.getTransactionMetrics();
      return {
        one: mid.databaseQueries.used - before.databaseQueries.used,
        two: after.databaseQueries.used - before.databaseQueries.used,
      };
    });
    expect(used.one).toBeGreaterThan(300);
    expect(used.one).toBeLessThanOrEqual(700);
    expect(used.two).toBeLessThanOrEqual(1400);
  }, 120_000);

  test("the call count does not grow with roots, episodes or unfunded reservations", async () => {
    const s = await setup({ transactionLimits: true });
    const quoteId = await makeQuote(s);
    const measure = async () =>
      await s.t.run(async (ctx) => {
        const quote = (await ctx.db.get(quoteId))!;
        const before = await ctx.meta.getTransactionMetrics();
        await assertNoQuoteLinkedReservationDeposit(ctx, quote);
        const after = await ctx.meta.getTransactionMetrics();
        return after.databaseQueries.used - before.databaseQueries.used;
      });
    const base = await measure();
    const reservationId = await directReservation(s, {});
    for (let i = 0; i < 300; i++) {
      const rootId = await directRoot(s, { headQuoteId: quoteId });
      await directReservationClaim(s, { rootId, reservationId, quoteId });
    }
    for (let i = 0; i < 200; i++) await directRoot(s, { headQuoteId: quoteId, originReservationId: reservationId });
    expect(await measure()).toBeLessThanOrEqual(base + 4);
  }, 120_000);
});
describe("R5 dedupe — a reservation reached by BOTH branches is read once", () => {
  test("one funded reservation that is a Q-headed origin AND a tagged funded claim costs 6 calls, not 8", async () => {
    const s = await setup({ transactionLimits: true });
    const quoteId = await makeQuote(s);
    const dead = await directDeposit(s, { status: "REFUNDED" });
    const reservationId = await directReservation(s, { depositId: dead });
    const rootId = await directRoot(s, { headQuoteId: quoteId, originReservationId: reservationId });
    await directReservationClaim(s, { rootId, reservationId, depositId: dead, quoteId });
    const calls = await s.t.run(async (ctx) => {
      const quote = (await ctx.db.get(quoteId))!;
      const before = await ctx.meta.getTransactionMetrics();
      await assertNoQuoteLinkedReservationDeposit(ctx, quote);
      const after = await ctx.meta.getTransactionMetrics();
      return after.databaseQueries.used - before.databaseQueries.used;
    });
    // Branch H: seek, reservation, deposit, terminal seek. Branch T: seek, (deduped), terminal seek.
    expect(calls).toBeLessThanOrEqual(6);
  });

  test("P1: BOTH candidates live — the reservation's own deposit is on-quote, the claim's is off-quote -> refused (no short-circuit)", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const da = await directDeposit(s, { status: "HELD", quoteId });
    const db = await directDeposit(s, { status: "HELD" });
    const reservationId = await directReservation(s, { depositId: da });
    const rootId = await directRoot(s, {});
    await directReservationClaim(s, { rootId, reservationId, depositId: db, quoteId });
    const before = await moneyFootprint(s);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
    expect(await moneyFootprint(s)).toEqual(before);
  });

  test("P1 control: the claim's off-quote deposit refunded -> passes", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const da = await directDeposit(s, { status: "HELD", quoteId });
    const db = await directDeposit(s, { status: "REFUNDED" });
    const reservationId = await directReservation(s, { depositId: da });
    const rootId = await directRoot(s, {});
    await directReservationClaim(s, { rootId, reservationId, depositId: db, quoteId });
    await expect(requestDeposit(s, quoteId, 100)).resolves.toBeTruthy();
  });

  test("dedupe never hides a LIVE claim-side deposit that differs from the reservation's own", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const dead = await directDeposit(s, { status: "REFUNDED" });
    const held = await directDeposit(s, { status: "HELD" });
    const reservationId = await directReservation(s, { depositId: dead });
    const rootId = await directRoot(s, { headQuoteId: quoteId, originReservationId: reservationId });
    await directReservationClaim(s, { rootId, reservationId, depositId: held, quoteId });
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(RESERVATION_MONEY);
  });
});