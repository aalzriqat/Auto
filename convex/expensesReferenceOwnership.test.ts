/**
 * SCRUM-811 (tenant-reference ownership), expense write doors.
 *
 * Invariant: every foreign document id a public expense mutation accepts is
 * proven to belong to the caller's org, and to be live, BEFORE any write. That
 * includes an id the door reads from the STORED row rather than its arguments:
 * marking a PENDING expense paid posts against the stored vehicle, so the
 * vehicle is proven again at payment. An already-paid expense is history and is
 * not re-validated (replay, non-accounting edits and reversal stay available).
 *
 * The caller here owns BOTH org A and org B, so a pass-through of an org B id
 * cannot be told apart from a legitimate one by authentication alone: only the
 * reference check refuses it.
 *
 * Each door is driven with a foreign (org B), a missing (hard-deleted) and a
 * soft-deleted reference (a payer also gets a dangling-membership variant). A
 * refusal must leave every table of the app schema unchanged, which includes
 * the idempotency ledger, journals, notifications and the dashboard expense
 * month summary, whose READY state is established first so a write to it would
 * show. Component-owned aggregate tables are NOT readable through `ctx.db` and
 * are outside that claim; Convex rolls back a throwing mutation as a whole.
 * A same-org live reference is the positive control for every door, and the
 * bound regression test below runs those controls itself.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id, TableNames } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

afterEach(() => {
  vi.useRealTimers();
});

type Kind = "foreign" | "missing" | "deleted";
type PayerKind = Kind | "dangling";
const KINDS: Kind[] = ["foreign", "missing", "deleted"];
const PAYER_KINDS: PayerKind[] = [...KINDS, "dangling"];
const BANK_MESSAGE = "The selected bank account was not found in this organization.";
const VEHICLE_MESSAGE = "Vehicle not found in this organization.";
const PAYER_MESSAGE = "The selected payer is not a member of this organization.";
const EXPENSE_MESSAGE = "Expense not found.";

const beginSummary = makeFunctionReference<"mutation", { orgId: Id<"organizations"> }, { generation: number }>(
  "dashboardExpenseSummary:begin",
);
const TABLES = Object.keys(schema.tables) as TableNames[];

async function fixture() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  await t.run((ctx) => ctx.db.insert("users", {
    clerkId: "expense-reference-owner", email: "expense-reference@example.test", name: "Reference owner",
  }));
  const owner = t.withIdentity({ subject: "expense-reference-owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "QA TEST expense reference A" });
  const orgBId = await owner.mutation(api.organizations.create, { name: "QA TEST expense reference B" });
  await owner.mutation(api.orgSettings.upsert, { orgId, currency: "JOD", currencySymbol: "JD" });
  await owner.mutation(api.orgSettings.upsert, { orgId: orgBId, currency: "JOD", currencySymbol: "JD" });
  // Put the dashboard expense summary in its READY state, so an expense write that
  // reached it would change `dashboardExpenseMonths` and the snapshot would show it.
  await t.mutation(beginSummary, { orgId });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
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
  const expenseIn = (org: Id<"organizations">, extra: Partial<{ isDeleted: boolean; vehicleId: Id<"vehicles"> }> = {}) =>
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
    // "dangling" is a membership that outlived its users row: the membership
    // lookup alone cannot tell it from a live member.
    payer: async (kind: PayerKind | "live") => {
      if (kind === "foreign") return userIn(orgBId);
      if (kind === "deleted") return userIn(orgId, true);
      if (kind === "missing") {
        const id = await userIn(null);
        await t.run((ctx) => ctx.db.delete(id));
        return id;
      }
      if (kind === "dangling") {
        const id = await userIn(orgId);
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

  // Every table of the app schema, read generically so a table a door writes
  // transitively cannot be left out of the comparison by omission.
  const snapshot = () => t.run(async (ctx) => {
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of TABLES) out[table] = (await ctx.db.query(table).collect()) as Array<Record<string, unknown>>;
    return out;
  });

  const base = () => ({ orgId, title: "QA expense", amount: 100, date: Date.now(), category: "OFFICE" as const });
  return { t, owner, orgId, orgBId, refs, snapshot, base, expenseIn };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

interface Door {
  name: string;
  ref: keyof Fixture["refs"];
  kinds: ReadonlyArray<string>;
  message: string;
  /** The org A expense the door edits; created BEFORE the snapshot is taken. */
  prepare?: (f: Fixture, id: never) => Promise<Id<"expenses">>;
  /** Runs the door with `id` in the foreign-id slot. */
  call: (f: Fixture, id: never, target: Id<"expenses">) => Promise<unknown>;
  /** Positive-control assertion that the live reference was accepted. */
  accepted: (f: Fixture, id: never) => Promise<void>;
}

const rowsNaming = async (f: Fixture, field: string, id: unknown) =>
  (await f.snapshot()).expenses.filter((row) => row[field] === id);

const createDoor = (name: string, ref: "vehicle" | "payer" | "bank", message: string): Door => ({
  name, ref, message, kinds: ref === "payer" ? PAYER_KINDS : KINDS,
  call: (f, id) => {
    const arg = { vehicle: { vehicleId: id }, payer: { payerId: id }, bank: { bankAccountId: id } }[ref];
    return f.owner.mutation(api.expenses.create, {
      ...f.base(), idempotencyKey: crypto.randomUUID(),
      paymentMethod: ref === "bank" ? "BANK_TRANSFER" : "CASH", ...arg,
    } as never);
  },
  accepted: async (f, id) => {
    const field = { vehicle: "vehicleId", payer: "payerId", bank: "bankAccountId" }[ref];
    expect(await rowsNaming(f, field, id)).toHaveLength(1);
  },
});

const updateDoor = (name: string, ref: "vehicle" | "payer" | "bank", message: string): Door => ({
  name, ref, message, kinds: ref === "payer" ? PAYER_KINDS : KINDS,
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
    expect(await rowsNaming(f, field, id)).toHaveLength(1);
  },
});

/**
 * The stored-reference door: the vehicle is NOT an argument. The PENDING expense
 * already names it (a legacy or stale link), and marking it paid posts against it.
 */
const payStoredVehicleDoor = (): Door => ({
  name: "expenses.update status PAID (stored vehicleId)", ref: "vehicle", kinds: KINDS, message: VEHICLE_MESSAGE,
  prepare: (f, id) => f.expenseIn(f.orgId, { vehicleId: id }).then(async (expenseId) => {
    await f.t.run((ctx) => ctx.db.patch(expenseId, { category: "REPAIR" }));
    return expenseId;
  }),
  call: (f, _id, expenseId) =>
    f.owner.mutation(api.expenses.update, { orgId: f.orgId, expenseId, status: "PAID", paymentMethod: "CASH" }),
  accepted: async (f, id) => {
    const rows = await rowsNaming(f, "vehicleId", id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PAID");
  },
});

const expenseDoor = (name: string, call: Door["call"]): Door => ({
  name, ref: "expense", kinds: KINDS, message: EXPENSE_MESSAGE, call,
  accepted: async () => undefined,
});

const DOORS: Door[] = [
  createDoor("expenses.create vehicleId", "vehicle", VEHICLE_MESSAGE),
  createDoor("expenses.create payerId", "payer", PAYER_MESSAGE),
  createDoor("expenses.create bankAccountId", "bank", BANK_MESSAGE),
  updateDoor("expenses.update vehicleId", "vehicle", VEHICLE_MESSAGE),
  updateDoor("expenses.update payerId", "payer", PAYER_MESSAGE),
  updateDoor("expenses.update bankAccountId", "bank", BANK_MESSAGE),
  payStoredVehicleDoor(),
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

const targetFor = (door: Door, f: Fixture, id: unknown) =>
  door.prepare ? door.prepare(f, id as never) : f.expenseIn(f.orgId);

// Bound by SCRUM-761 scenario `expense-doors-refuse-foreign-missing-and-deleted-references`. It is a TOP-LEVEL
// test, with its positive controls inside it: the local runner anchors `^title$` against the full name
// (describe + title), so a nested title selects nothing and "executes" zero tests.
test("every expense door refuses a foreign, missing and soft-deleted reference and writes nothing", async () => {
  const failures: string[] = [];
  for (const door of DOORS) {
    for (const kind of door.kinds) {
      const f = await fixture();
      const id = await (f.refs[door.ref] as (k: string) => Promise<unknown>)(kind);
      // The org A expense the door edits exists before the snapshot is taken.
      const target = await targetFor(door, f, id);
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

  // Positive control for every door: the same call with a live same-org reference is accepted.
  for (const door of DOORS.filter((d) => d.ref !== "expense")) {
    const f = await fixture();
    const id = await (f.refs[door.ref] as (k: string) => Promise<unknown>)("live");
    try {
      await door.call(f, id as never, await targetFor(door, f, id));
      await door.accepted(f, id as never);
    } catch (error) {
      failures.push(`${door.name} / live (positive control): ${message(error)}`);
    }
  }

  // The snapshot can see the summary write: a real accepted expense changes dashboardExpenseMonths, so an
  // unchanged table on a refusal is evidence and not blindness.
  const f = await fixture();
  const before = await f.snapshot();
  await f.owner.mutation(api.expenses.create, { ...f.base(), idempotencyKey: crypto.randomUUID(), paymentMethod: "CASH" });
  const after = await f.snapshot();
  if (JSON.stringify(after.dashboardExpenseMonths) === JSON.stringify(before.dashboardExpenseMonths))
    failures.push("snapshot discrimination: a paid expense did not change dashboardExpenseMonths (summary not READY)");
  if (after.dashboardExpenseMonths.length === 0) failures.push("snapshot discrimination: no expense month row after a paid expense");

  expect(failures).toEqual([]);
}, 240_000);

describe("SCRUM-811 expense doors own every foreign reference before writing", () => {
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

  test("an already-PAID expense whose vehicle is later deleted keeps its replay, non-accounting edit and reversal", async () => {
    const f = await fixture();
    const vehicleId = await f.refs.vehicle("live");
    const args = {
      ...f.base(), category: "REPAIR" as const, vehicleId, paymentMethod: "CASH" as const, idempotencyKey: crypto.randomUUID(),
    };
    const expenseId = await f.owner.mutation(api.expenses.create, args);
    // The car is deleted AFTER the payment was accepted: the payment is history.
    await f.t.run((ctx) => ctx.db.patch(vehicleId, { isDeleted: true }));
    // An idempotent replay of the accepted create returns the original result, not a new refusal.
    expect(await f.owner.mutation(api.expenses.create, args)).toBe(expenseId);
    await f.owner.mutation(api.expenses.update, { orgId: f.orgId, expenseId, notes: "late note" });
    expect((await f.snapshot()).expenses.find((row) => row._id === expenseId)?.notes).toBe("late note");
    await f.owner.mutation(api.expenses.reverseExpense, { orgId: f.orgId, expenseId, reason: "QA reversal after car deleted" });
    expect((await f.snapshot()).expenses.find((row) => row._id === expenseId)?.isDeleted).toBe(true);
  });

  test("a stale stored vehicle can be repaired in the same call that pays: cleared or replaced by a live car", async () => {
    const f = await fixture();
    const stale = await f.refs.vehicle("deleted");
    const cleared = await f.expenseIn(f.orgId, { vehicleId: stale });
    await f.owner.mutation(api.expenses.update, {
      orgId: f.orgId, expenseId: cleared, vehicleId: null, status: "PAID", paymentMethod: "CASH",
    });
    const clearedRow = (await f.snapshot()).expenses.find((row) => row._id === cleared);
    expect(clearedRow).toMatchObject({ status: "PAID" });
    expect(clearedRow?.vehicleId).toBeUndefined();

    const replaced = await f.expenseIn(f.orgId, { vehicleId: stale });
    const live = await f.refs.vehicle("live");
    await f.owner.mutation(api.expenses.update, {
      orgId: f.orgId, expenseId: replaced, vehicleId: live, status: "PAID", paymentMethod: "CASH",
    });
    expect((await f.snapshot()).expenses.find((row) => row._id === replaced)).toMatchObject({ status: "PAID", vehicleId: live });
  });
});
