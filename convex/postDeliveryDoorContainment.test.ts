/**
 * SCRUM-760 decision B, door-census gap 3: post-delivery money doors that the
 * narrow pilot blocks SERVER-SIDE (convex/utils/postDeliveryDoorContainment.ts).
 *
 * Each door has an EXPECTED-REFUSAL cell (docs/architecture/scrum486-certification-oracle.md,
 * contract item 3). A cell passes only when:
 *   - the call goes through the door's own public entry, by an authorized actor, with valid arguments;
 *   - it asserts the door's specific containment code, not a generic one;
 *   - a full snapshot of EVERY schema table is identical before and after (journals, subledgers,
 *     deposits, payments, sales, applications, receipts, cheques, bank-balance aggregates and the
 *     idempotency ledger: not a spot check);
 *   - flipping the server-side switch turns the cell red (the item 2 mutation attack, run in-suite
 *     by driving the same call with the switch off and requiring that the cell's assertion fails).
 *
 * Evidence boundary: convex-test only. It is repository behaviour, not the Convex runtime, and
 * not the real-backend replay that SCRUM-762 requires.
 */
import { describe, expect, test, vi } from "vitest";
import {
  insertReceiptBank, refusalDataOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import type { PostDeliverySwitchState } from "../test-utils/postDeliveryDoorSwitches";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/** Live handle on every switch; the shipped state is all ON. Only this file's mock reads it. */
const switches = vi.hoisted(
  (): PostDeliverySwitchState => ({
    clearedChequeReturn: true,
  })
);
vi.mock("./utils/postDeliveryDoorContainment", async (importOriginal) =>
  (await import("../test-utils/postDeliveryDoorSwitches")).withPostDeliverySwitches(
    await importOriginal(),
    switches
  )
);

const MODULES = import.meta.glob("./**/*.ts");
const ALL_TABLES = Object.keys(schema.tables);

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance", "view:cost_price",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

async function seed(tag: string) {
  return await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S760", vinPrefix: "VIN760", actors: {},
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Runs `fn` with one switch off (the door open), then restores the shipped state. */
async function withSwitchOff<T>(key: keyof PostDeliverySwitchState, fn: () => Promise<T>): Promise<T> {
  switches[key] = false;
  try {
    return await fn();
  } finally {
    switches[key] = true;
  }
}

async function snapshot(s: Seeded) {
  return await dbSnapshot(s.t, ALL_TABLES);
}

/**
 * The expected-refusal cell. Returns the observed refusal so the mutation attack can reuse it.
 */
async function expectRefusedAndUnchanged(
  s: Seeded,
  code: string,
  call: () => Promise<unknown>
) {
  const before = await snapshot(s);
  const refusal = await refusalDataOf(call());
  expect(refusal?.code).toBe(code);
  expect(refusal?.message).toMatch(/pilot/i);
  expect(refusal?.message).toMatch(/Nothing has been changed/);
  expect(await snapshot(s)).toEqual(before);
}

describe("the shipped switches are ON (unmocked pin)", () => {
  test("the cleared-cheque switch is the literal true", async () => {
    const real = await vi.importActual<typeof import("./utils/postDeliveryDoorContainment")>(
      "./utils/postDeliveryDoorContainment"
    );
    expect(real.CLEARED_CHEQUE_RETURN_PILOT_DISABLED).toBe(true);
    expect(() => real.assertClearedChequeReturnAllowed()).toThrow();
    // The pure guard passes when its switch is off, so a flipped switch is observable.
    expect(() => real.assertClearedChequeReturnAllowed(false)).not.toThrow();
  });

  test("each refusal code has its own message and every code is an AppErrorCode", async () => {
    const real = await vi.importActual<typeof import("./utils/postDeliveryDoorContainment")>(
      "./utils/postDeliveryDoorContainment"
    );
    const { AppErrorCode } = await import("./utils/errors");
    const codes = Object.keys(real.POST_DELIVERY_DOOR_REFUSALS);
    expect(codes).toEqual(["CLEARED_CHEQUE_RETURN_PILOT_DISABLED"]);
    for (const code of codes) expect(Object.values(AppErrorCode)).toContain(code);
    expect(new Set(Object.values(real.POST_DELIVERY_DOOR_REFUSALS)).size).toBe(codes.length);
  });
});

// ---------------------------------------------------------------------------------------------
// collections.returnClearedCheque (bounced-after-clearing reversal).
// ---------------------------------------------------------------------------------------------

/** A customer cheque the bank has CLEARED (receipt posted to a physical bank). */
async function clearedCheque(tag: string) {
  const s = await seed(tag);
  const chequeId = await s.owner.as.mutation(api.collections.registerCheque, {
    orgId: s.orgId, customerId: s.customerId, bank: "Customer bank",
    chequeNumber: `S760-${tag}`, chequeDate: Date.now(), amount: 10,
  });
  const bankAccountId = await insertReceiptBank(s);
  await s.owner.as.mutation(api.collections.clearCheque, {
    orgId: s.orgId, chequeId, bankAccountId, idempotencyKey: crypto.randomUUID(),
  });
  expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("CLEARED");
  return { s, chequeId };
}

describe("collections.returnClearedCheque is blocked", () => {
  const CODE = "CLEARED_CHEQUE_RETURN_PILOT_DISABLED";
  const returnCheque = (s: Seeded, chequeId: Id<"postDatedCheques">, key = crypto.randomUUID()) =>
    s.owner.as.mutation(api.collections.returnClearedCheque, {
      orgId: s.orgId, chequeId, returnReason: "Bounced after clearing", idempotencyKey: key,
    });

  test("returning a CLEARED cheque is refused and nothing changes", async () => {
    const { s, chequeId } = await clearedCheque("chequeReturn");
    await expectRefusedAndUnchanged(s, CODE, () => returnCheque(s, chequeId));
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("CLEARED");
  });

  test("a stored replay of a return done before the switch is refused too (refusal precedes the idempotency wrapper)", async () => {
    const { s, chequeId } = await clearedCheque("chequeReplay");
    const replayRef = crypto.randomUUID();
    await withSwitchOff("clearedChequeReturn", () => returnCheque(s, chequeId, replayRef));
    await expectRefusedAndUnchanged(s, CODE, () => returnCheque(s, chequeId, replayRef));
  });

  test("MUTATION ATTACK: with the switch flipped off the same return is accepted", async () => {
    const { s, chequeId } = await clearedCheque("chequeAttack");
    expect(await refusalDataOf(withSwitchOff("clearedChequeReturn", () => returnCheque(s, chequeId)))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).not.toBe("CLEARED");
  });

  test("CONTROL: registering and clearing a cheque (the enabled path) still works", async () => {
    const { s, chequeId } = await clearedCheque("chequeControl");
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("CLEARED");
  });
});

