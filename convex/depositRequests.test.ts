import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";

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
