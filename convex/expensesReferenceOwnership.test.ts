/**
 * SCRUM-811 (tenant-reference ownership), expense write doors.
 *
 * Invariant: every foreign document id a public expense mutation accepts is
 * proven to belong to the caller's org, and to be live, BEFORE any write.
 * The caller here owns BOTH org A and org B, so a pass-through of an org B id
 * cannot be told apart from a legitimate one by authentication alone: only the
 * reference check refuses it.
 *
 * Each door is driven with a foreign (org B), a missing (hard-deleted) and a
 * soft-deleted reference. A refusal must leave every table the door can write
 * (including the idempotency ledger, journals and notifications) unchanged.
 * A same-org live reference is the positive control for every door.
 */
import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

type Kind = "foreign" | "missing" | "deleted";
const KINDS: Kind[] = ["foreign", "missing", "deleted"];
const BANK_MESSAGE = "The selected bank account was not found in this organization.";
const VEHICLE_MESSAGE = "Vehicle not found in this organization.";
const PAYER_MESSAGE = "The selected payer is not a member of this organization.";
const EXPENSE_MESSAGE = "Expense not found.";

async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  await t.run((ctx) => ctx.db.insert("users", {
    clerkId: "expense-reference-owner", email: "expense-reference@example.test", name: "Reference owner",
  }));
  const owner = t.withIdentity({ subject: "expense-reference-owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "QA TEST expense reference A" });
  const orgBId = await owner.mutation(api.organizations.create, { name: "QA TEST expense reference B" });
  await owner.mutation(api.orgSettings.upsert, { orgId, currency: "JOD", currencySymbol: "JD" });
  await owner.mutation(api.orgSettings.upsert, { orgId: orgBId, currency: "JOD", currencySymbol: "JD" });
  const ownerId = (await t.run((ctx) => ctx.db.query("users").first()))!._id;
  const roleOf = async (org: Id<"organizations">) =>
    (await t.run((ctx) => ctx.db.query("roles").withIndex("by_org", (q) => q.eq("orgId", org)).first()))!._id;
  let n = 0;
  const next = () => `${++n}`;

  const vehicleIn = (org: Id<"organizations">, extra: { isDeleted?: boolean } = {}) =>
    t.run((ctx) => ctx.db.insert("vehicles", {
      orgId: org, vin: `QA-EXP-REF-${next()}`, make: "Toyota", model: "Corolla", year: 2024, mileage: 10,
      color: "White", fuelType: "Gasoline", transmission: "Automatic", sourceType: "STOCK",
      purchasePrice: 10_000, sellingPrice: 12_500, status: "AVAILABLE", ...extra,
    }));
  const bankIn = (org: Id<"organizations">, extra: { isDeleted?: boolean } = {}) =>
    t.run((ctx) => ctx.db.insert("bankAccounts", {
      orgId: org, name: `QA bank ${next()}`, currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
      isActive: true, isReconciliationTarget: false, createdBy: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
      ...extra,
    }));
  const userIn = async (org: Id<"organizations"> | null, offboarding = false) => {
    const userId = await t.run((ctx) => ctx.db.insert("users", {
      clerkId: `expense-reference-user-${next()}`, email: `expense-reference-${next()}@example.test`, name: "Reference payer",
    }));
    if (org) {
      const roleId = await roleOf(org);
      await t.run((ctx) => ctx.db.insert("memberships", {
        orgId: org, userId, roleId, ...(offboarding ? { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" as const } : {}),
      }));
    }
    return userId;
  };
  const expenseIn = (org: Id<"organizations">, extra: { isDeleted?: boolean } = {}) =>
    t.run((ctx) => ctx.db.insert("expenses", {
      orgId: org, title: `QA expense ${next()}`, amount: 100, date: Date.now(), category: "OFFICE", status: "PENDING", ...extra,
    }));

  /** A reference of `kind` for each foreign-id argument; "live" is the same-org positive control. */
  const refs = {
    vehicle: async (kind: Kind | "live") => {
      if (kind === "foreign") return vehicleIn(orgBId);
      const id = await vehicleIn(orgId, kind === "deleted" ? { isDeleted: true } : {});
      if (kind === "missing") await t.run((ctx) => ctx.db.delete(id));
      return id;
    },
    bank: async (kind: Kind | "live") => {
      if (kind === "foreign") return bankIn(orgBId);
      const id = await bankIn(orgId, kind === "deleted" ? { isDeleted: true } : {});
      if (kind === "missing") await t.run((ctx) => ctx.db.delete(id));
      return id;
    },
    // A users row has no soft-delete flag; the live-state equivalent is an
    // offboarding membership, which `requireTenantAuth` already treats as gone.
    payer: async (kind: Kind | "live") => {
      if (kind === "foreign") return userIn(orgBId);
      if (kind === "deleted") return userIn(orgId, true);
      if (kind === "missing") {
        const id = await userIn(null);
        await t.run((ctx) => ctx.db.delete(id));
        return id;
      }
      return userIn(orgId);
    },
    expense: async (kind: Kind | "live") => {
      if (kind === "foreign") return expenseIn(orgBId);
      const id = await expenseIn(orgId, kind === "deleted" ? { isDeleted: true } : {});
      if (kind === "missing") await t.run((ctx) => ctx.db.delete(id));
      return id;
    },
  };

  // Every table a refused expense door could touch.
  const snapshot = () => t.run(async (ctx) => ({
    expenses: await ctx.db.query("expenses").collect(),
    transactions: await ctx.db.query("transactions").collect(),
    journalEntries: await ctx.db.query("journalEntries").collect(),
    journalLines: await ctx.db.query("journalLines").collect(),
    events: await ctx.db.query("accountingEvents").collect(),
    pending: await ctx.db.query("pendingAccountingEvents").collect(),
    idempotency: await ctx.db.query("commandIdempotency").collect(),
    notifications: await ctx.db.query("notifications").collect(),
    prepaid: await ctx.db.query("prepaidExpenseSchedules").collect(),
    recoveries: await ctx.db.query("supplierCostRecoveries").collect(),
    vehicles: await ctx.db.query("vehicles").collect(),
    banks: await ctx.db.query("bankAccounts").collect(),
  }));

  const base = () => ({ orgId, title: "QA expense", amount: 100, date: Date.now(), category: "OFFICE" as const });
  return { t, owner, orgId, orgBId, refs, snapshot, base, expenseIn };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

interface Door {
  name: string;
  ref: keyof Fixture["refs"];
  message: string;
  /** Runs the door with `id` in the foreign-id slot. */
  call: (f: Fixture, id: never, target: Id<"expenses">) => Promise<unknown>;
  /** Positive-control assertion that the live reference was accepted. */
  accepted: (f: Fixture, id: never) => Promise<void>;
}

const createDoor = (name: string, ref: "vehicle" | "payer" | "bank", message: string): Door => ({
  name, ref, message,
  call: (f, id) => {
    const arg = { vehicle: { vehicleId: id }, payer: { payerId: id }, bank: { bankAccountId: id } }[ref];
    return f.owner.mutation(api.expenses.create, {
      ...f.base(), idempotencyKey: crypto.randomUUID(),
      paymentMethod: ref === "bank" ? "BANK_TRANSFER" : "CASH", ...arg,
    } as never);
  },
  accepted: async (f, id) => {
    const field = { vehicle: "vehicleId", payer: "payerId", bank: "bankAccountId" }[ref];
    const rows = (await f.snapshot()).expenses;
    expect(rows.filter((row) => (row as Record<string, unknown>)[field] === id)).toHaveLength(1);
  },
});

const updateDoor = (name: string, ref: "vehicle" | "payer" | "bank", message: string): Door => ({
  name, ref, message,
  call: (f, id, expenseId) => {
    const arg = {
      vehicle: { vehicleId: id }, payer: { payerId: id },
      // A bank can only be named by an expense that is, or becomes, a paid bank payment.
      bank: { status: "PAID", paymentMethod: "BANK_TRANSFER", bankAccountId: id },
    }[ref];
    return f.owner.mutation(api.expenses.update, { orgId: f.orgId, expenseId, ...arg } as never);
  },
  accepted: async (f, id) => {
    const field = { vehicle: "vehicleId", payer: "payerId", bank: "bankAccountId" }[ref];
    const rows = (await f.snapshot()).expenses;
    expect(rows.filter((row) => (row as Record<string, unknown>)[field] === id)).toHaveLength(1);
  },
});

const expenseDoor = (name: string, call: Door["call"]): Door => ({
  name, ref: "expense", message: EXPENSE_MESSAGE, call,
  accepted: async () => undefined,
});

const DOORS: Door[] = [
  createDoor("expenses.create vehicleId", "vehicle", VEHICLE_MESSAGE),
  createDoor("expenses.create payerId", "payer", PAYER_MESSAGE),
  createDoor("expenses.create bankAccountId", "bank", BANK_MESSAGE),
  updateDoor("expenses.update vehicleId", "vehicle", VEHICLE_MESSAGE),
  updateDoor("expenses.update payerId", "payer", PAYER_MESSAGE),
  updateDoor("expenses.update bankAccountId", "bank", BANK_MESSAGE),
  expenseDoor("expenses.update expenseId", (f, id) =>
    f.owner.mutation(api.expenses.update, { orgId: f.orgId, expenseId: id, title: "Renamed" } as never)),
  expenseDoor("expenses.remove expenseId", (f, id) =>
    f.owner.mutation(api.expenses.remove, { orgId: f.orgId, expenseId: id } as never)),
  expenseDoor("expenses.reverseExpense expenseId", (f, id) =>
    f.owner.mutation(api.expenses.reverseExpense, { orgId: f.orgId, expenseId: id, reason: "QA reversal" } as never)),
];

function message(error: unknown): string {
  if (!(error instanceof ConvexError)) return String(error);
  return typeof error.data === "string" ? error.data : JSON.stringify(error.data);
}

describe("SCRUM-811 expense doors own every foreign reference before writing", () => {
  test("every expense door refuses a foreign, missing and soft-deleted reference and writes nothing", async () => {
    const failures: string[] = [];
    for (const door of DOORS) {
      for (const kind of KINDS) {
        const f = await fixture();
        const id = await f.refs[door.ref](kind);
        // The org A expense the update doors edit exists before the snapshot is taken.
        const target = await f.expenseIn(f.orgId);
        const before = await f.snapshot();
        let refusal: unknown;
        try {
          await door.call(f, id as never, target);
        } catch (error) {
          refusal = error;
        }
        const label = `${door.name} / ${kind}`;
        if (refusal === undefined) failures.push(`${label}: accepted the reference`);
        else if (!message(refusal).includes(door.message)) failures.push(`${label}: wrong refusal ${message(refusal)}`);
        // State is compared even when refused, so a write-then-throw would also show.
        if (JSON.stringify(await f.snapshot()) !== JSON.stringify(before)) failures.push(`${label}: changed stored state`);
      }
    }
    expect(failures).toEqual([]);
  });
  test.each(DOORS.filter((door) => door.ref !== "expense").map((door) => [door.name, door] as const))(
    "%s accepts a live same-org reference (positive control)",
    async (_name, door) => {
      const f = await fixture();
      const id = await f.refs[door.ref]("live");
      await door.call(f, id as never, await f.expenseIn(f.orgId));
      await door.accepted(f, id as never);
    }
  );

  test("expenses.update/remove/reverseExpense on a live same-org expense is not refused as not-found (positive control)", async () => {
    const f = await fixture();
    const updatable = await f.refs.expense("live");
    await f.owner.mutation(api.expenses.update, { orgId: f.orgId, expenseId: updatable, title: "Renamed" });
    expect((await f.snapshot()).expenses.find((row) => row._id === updatable)?.title).toBe("Renamed");
    await f.owner.mutation(api.expenses.remove, { orgId: f.orgId, expenseId: updatable });
    expect((await f.snapshot()).expenses.find((row) => row._id === updatable)?.isDeleted).toBe(true);
    // reverseExpense on a live PENDING expense is refused for a reason other than ownership.
    const pending = await f.refs.expense("live");
    let refusal: unknown;
    try {
      await f.owner.mutation(api.expenses.reverseExpense, { orgId: f.orgId, expenseId: pending, reason: "QA reversal" });
    } catch (error) {
      refusal = error;
    }
    expect(message(refusal)).not.toContain(EXPENSE_MESSAGE);
  });
});
