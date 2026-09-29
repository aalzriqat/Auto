import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";
import {
  RESERVATION_PROBE_MAX_CLAIMS_PER_ROOT,
  RESERVATION_PROBE_MAX_ROOTS_PER_QUOTE,
  RESERVATION_PROBE_MAX_TAGGED_CLAIMS_PER_QUOTE,
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

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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

  test("sales.completeDraft (a draft is allowed; completing it is not)", async () => {
    const s = await setup();
    const { quoteId, requestId } = await withPending(s);
    const saleId = await s.manager.as.mutation(api.sales.createDraft, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      salespersonId: s.manager.userId,
      salePrice: 22000,
      saleDate: Date.now(),
      quoteId,
      idempotencyKey: "draft-1",
    });
    await expectBlockedThenFreed(s, requestId, () =>
      s.manager.as.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId, idempotencyKey: "draft-complete-1" })
    );
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

  test("a root of THIS deal carrying more claims than the probe's bound THROWS instead of concluding 'clear'", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    await insertRootHeadedAt(s, quoteId, RESERVATION_PROBE_MAX_CLAIMS_PER_ROOT + 1);
    const before = await moneyFootprint(s);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(/too many deal records/i);
    expect(await moneyFootprint(s)).toEqual(before);
  });

  test("more roots headed at ONE quote than the per-quote bound THROWS as well", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    for (let i = 0; i <= RESERVATION_PROBE_MAX_ROOTS_PER_QUOTE; i++) {
      await insertRootHeadedAt(s, quoteId, 0);
    }
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(/too many deal records/i);
  });

  test("more claims TAGGED with ONE quote than the per-quote bound THROWS as well", async () => {
    const s = await setup();
    const quoteId = await makeQuote(s);
    const half = Math.ceil((RESERVATION_PROBE_MAX_TAGGED_CLAIMS_PER_QUOTE + 1) / 2);
    await insertRootHeadedAt(s, undefined, half, quoteId);
    await insertRootHeadedAt(s, undefined, half, quoteId);
    await expect(requestDeposit(s, quoteId, 100)).rejects.toThrow(/too many deal records/i);
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
