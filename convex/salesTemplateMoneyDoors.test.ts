import { convexTestWithComponents } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { expectAppError } from "../test-utils/expectAppError";
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
 * This one proves the doors honour it: a REAL default SALES-template actor (the
 * permission list is read from `DEFAULT_ROLE_TEMPLATES`, not hand-written) is
 * refused by every receipt, cheque and deposit door with the exact FORBIDDEN
 * code and message, and a full-content snapshot of EVERY table is identical
 * afterwards, so a refusal that patched a row in place cannot pass.
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

  async function member(key: string, roleName: string, permissions: string[], isSystemOwnerRole = false) {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `user_${key}`, email: `${key}@test.com`, name: `User ${key}` })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: roleName, permissions, ...(isSystemOwnerRole ? { isSystemOwnerRole: true } : {}) })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return t.withIdentity({ subject: `user_${key}`, clerkId: `user_${key}` });
  }

  // `owner` only prepares real money rows for the refusals to be tried against.
  const owner = await member("owner", "OWNER", [PERMISSIONS.MANAGE_FINANCE], true);
  const sales = await member("sales", "SALES", templatePermissions("SALES"));

  // The owner's money rows queue accounting work on convex-test's scheduler. Freeze
  // the timers BEFORE they are written (a chain already on real timers cannot be
  // frozen later) so no background drain can change a row between the "before"
  // and "after" snapshots and make a refusal look like a write.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });

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

  vi.useRealTimers();

  return { t, orgId, owner, sales, customerId, vehicleId, receivableId, receiptMovementId: receiptMovement._id, chequeId };
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

describe("SCRUM-444: a default SALES-template actor cannot move money through any door", () => {
  test("control: the owner's preparatory rows exist, so each refusal below is about the actor, not missing data", async () => {
    const s = await setup();
    expect((await dbSnapshot(s.t, ["receivables"])).receivables).toHaveLength(1);
    expect((await dbSnapshot(s.t, ["receiptMovements"])).receiptMovements).toHaveLength(1);
    expect((await dbSnapshot(s.t, ["postDatedCheques"])).postDatedCheques).toHaveLength(1);
  });

  test("collections.recordPayment is refused and nothing is written", async () => {
    const s = await setup();
    await expectRefusedWithoutWriting(
      s,
      () =>
        s.sales.mutation(api.collections.recordPayment, {
          idempotencyKey: crypto.randomUUID(),
          orgId: s.orgId,
          customerId: s.customerId,
          amount: 25,
          method: "CASH",
          paymentDate: Date.now(),
        }),
      PERMISSIONS.MANAGE_FINANCE
    );
  });

  test("collections.registerCheque is refused and nothing is written", async () => {
    const s = await setup();
    await expectRefusedWithoutWriting(
      s,
      () =>
        s.sales.mutation(api.collections.registerCheque, {
          orgId: s.orgId,
          customerId: s.customerId,
          bank: "Test Bank",
          chequeNumber: "000999",
          chequeDate: Date.now() + 86_400_000,
          amount: 10,
        }),
      PERMISSIONS.MANAGE_FINANCE
    );
  });

  test("collections.clearCheque is refused and the held cheque is unchanged", async () => {
    const s = await setup();
    await expectRefusedWithoutWriting(
      s,
      () =>
        s.sales.mutation(api.collections.clearCheque, {
          orgId: s.orgId,
          chequeId: s.chequeId,
          idempotencyKey: crypto.randomUUID(),
        }),
      PERMISSIONS.MANAGE_FINANCE
    );
    const cheque = await s.t.run((ctx) => ctx.db.get(s.chequeId));
    expect(cheque?.status).toBe("HELD");
  });

  test("collections.applyRetainedCredit is refused and the retained receipt is untouched", async () => {
    const s = await setup();
    await expectRefusedWithoutWriting(
      s,
      () =>
        s.sales.mutation(api.collections.applyRetainedCredit, {
          orgId: s.orgId,
          receiptMovementId: s.receiptMovementId,
          receivableId: s.receivableId,
          requestedAmount: 10,
          idempotencyKey: crypto.randomUUID(),
        }),
      PERMISSIONS.MANAGE_FINANCE
    );
  });

  test("vehicles.createReservation with a deposit is refused for the SALES template", async () => {
    const s = await setup();
    // EDIT_VEHICLES is checked first and SALES holds only EDIT_VEHICLES_REQUEST, so the
    // refusal names it; the deposit authority is the second requirement.
    expect(templatePermissions("SALES")).not.toContain(PERMISSIONS.EDIT_VEHICLES);
    expect(templatePermissions("SALES")).not.toContain(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    await expectRefusedWithoutWriting(
      s,
      () =>
        s.sales.mutation(api.vehicles.createReservation, {
          orgId: s.orgId,
          vehicleId: s.vehicleId,
          customerId: s.customerId,
          depositAmount: 500,
          depositMethod: "CASH",
          idempotencyKey: crypto.randomUUID(),
        }),
      `${PERMISSIONS.EDIT_VEHICLES}, ${PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT}`
    );
  });
});
