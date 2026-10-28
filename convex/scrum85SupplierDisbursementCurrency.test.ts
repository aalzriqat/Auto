/**
 * SCRUM-85 (owner ruling SCRUM-760 c23812 ruling 9; SCRUM-85 c23823): an organization's or
 * deal's currency and scale are never guessed or silently defaulted. c23823: an unsupported or
 * absent `economicsCurrency` "must be rejected at every active supplier payment
 * confirmation/amendment money-write door".
 *
 * Doors under test (public mutations, through the real harness):
 *  - applications.confirmSupplierDisbursement
 *  - applications.amendSupplierDisbursementAdvice
 *
 * Invariant: the settlement advice stores a minor-unit amount, and a minor-unit amount means
 * nothing without the deal's denomination. A deal whose `economicsCurrency` is absent, unknown
 * ("JD") or not canonical ("jod") is refused with a coded error BEFORE any write; the org's
 * current currency is deliberately NOT a fallback, because the org can change currency after the
 * deal's figures were recorded (a known-wrong, not a conservative, guess).
 *
 * Expected values are literals worked from the fixture (A = 12,500,000 minor JOD), never read
 * back from the code under test. Evidence boundary: convex-test only.
 */
import { describe, expect, test, vi } from "vitest";
import {
  G, finalizeAsOwner, payForwardAsOwner, readyDeal, refusalDataOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { dbSnapshot } from "../test-utils/dbSnapshot";
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
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

async function seed(tag: string) {
  return await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S85D", vinPrefix: "VIN85D",
    actors: {}, sourced: true,
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;
type AppId = Id<"financeApplications">;

/** A finalized direct-to-supplier financed deal, ready for the settlement advice. */
async function finalizedDirectDeal(s: Seeded): Promise<AppId> {
  const { applicationId } = await readyDeal(s, { route: "DIRECT_TO_SUPPLIER", deposit: false });
  await payForwardAsOwner(s, applicationId);
  await finalizeAsOwner(s, applicationId, { payForward: false });
  return applicationId;
}

/** Writes the deal's stored denomination as a raw edit / legacy row would carry it. */
async function setEconomicsCurrency(s: Seeded, applicationId: AppId, currency: string | undefined) {
  await s.t.run((ctx) => ctx.db.patch(applicationId, { economicsCurrency: currency }));
}

const confirmArgs = (s: Seeded, applicationId: AppId, disbursedAmountMinor = G) => ({
  orgId: s.orgId, applicationId, disbursedAmountMinor, reference: "WIRE-85", idempotencyKey: crypto.randomUUID(),
});
const amendArgs = (s: Seeded, applicationId: AppId, disbursedAmountMinor: number) => ({
  orgId: s.orgId, applicationId, disbursedAmountMinor, reference: "WIRE-85B",
  reason: "Mistyped the amount from the advice.", idempotencyKey: crypto.randomUUID(),
});
const confirm = (s: Seeded, args: ReturnType<typeof confirmArgs>) =>
  s.owner.as.mutation(api.applications.confirmSupplierDisbursement, args);
const amend = (s: Seeded, args: ReturnType<typeof amendArgs>) =>
  s.owner.as.mutation(api.applications.amendSupplierDisbursementAdvice, args);

const BAD_DENOMINATIONS: ReadonlyArray<readonly [string, string | undefined]> = [
  ["absent", undefined],
  ["unknown JD", "JD"],
  ["lowercase jod", "jod"],
  ["empty string", ""],
];

describe("SCRUM-85 c23823: confirmSupplierDisbursement refuses a deal with no usable denomination", () => {
  test.each(BAD_DENOMINATIONS)("%s economicsCurrency is refused with a coded error and nothing changes", async (label, bad) => {
    const s = await seed(`c-${label.replace(/\W/g, "")}`);
    const applicationId = await finalizedDirectDeal(s);
    await setEconomicsCurrency(s, applicationId, bad);
    const before = await dbSnapshot(s.t, ALL_TABLES);

    const refusal = await refusalDataOf(confirm(s, confirmArgs(s, applicationId)));

    expect(refusal?.code).toBe("DEAL_CURRENCY_UNSUPPORTED");
    expect(refusal?.message).toMatch(/currency/i);
    expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.supplierDisbursementConfirmedAt).toBeUndefined();
    expect(app?.supplierDisbursedAmountMinor).toBeUndefined();
  });

  test("an org whose CURRENT currency is valid is not a fallback for a deal that recorded none", async () => {
    // The refusal must not depend on the org setting: the org can change currency after the deal's
    // figures were recorded, so the org currency is a known-wrong guess, not a conservative one.
    const s = await seed("c-orgnotfallback");
    const applicationId = await finalizedDirectDeal(s);
    const org = await s.t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique()
    );
    expect(org?.currency).toBe("JOD");
    await setEconomicsCurrency(s, applicationId, undefined);

    expect((await refusalDataOf(confirm(s, confirmArgs(s, applicationId))))?.code).toBe("DEAL_CURRENCY_UNSUPPORTED");
  });

  test("control: a canonical JOD deal still records the advice, with the stored evidence and ledger exactly as before", async () => {
    const s = await seed("c-valid");
    const applicationId = await finalizedDirectDeal(s);
    const before = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(before?.economicsCurrency).toBe("JOD");
    const journalBefore = await dbSnapshot(s.t, ["journalEntries", "journalLines", "accountingEvents"]);

    const result = await confirm(s, confirmArgs(s, applicationId));

    expect(result.disbursedAmountMinor).toBe(G);
    expect(result.status).toBe("CONFIRMED");
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.supplierDisbursedAmountMinor).toBe(G);
    expect(app?.supplierDisbursementReference).toBe("WIRE-85");
    expect(app?.supplierDisbursementStatus).toBe("CONFIRMED");
    expect(app?.settlementStatus).toBe("EXPECTED");
    // An evidence-only advice posts nothing: GL parity with the pre-advice books.
    expect(await dbSnapshot(s.t, ["journalEntries", "journalLines", "accountingEvents"])).toEqual(journalBefore);
  });
});

describe("SCRUM-85 c23823: amendSupplierDisbursementAdvice refuses a deal with no usable denomination", () => {
  test.each(BAD_DENOMINATIONS)("%s economicsCurrency is refused with a coded error and nothing changes", async (label, bad) => {
    const s = await seed(`a-${label.replace(/\W/g, "")}`);
    const applicationId = await finalizedDirectDeal(s);
    await confirm(s, confirmArgs(s, applicationId));
    await setEconomicsCurrency(s, applicationId, bad);
    const before = await dbSnapshot(s.t, ALL_TABLES);

    const refusal = await refusalDataOf(amend(s, amendArgs(s, applicationId, G - 1_000)));

    expect(refusal?.code).toBe("DEAL_CURRENCY_UNSUPPORTED");
    expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.supplierDisbursedAmountMinor).toBe(G);
    expect(app?.supplierDisbursementReference).toBe("WIRE-85");
  });

  test("control: a canonical JOD deal still amends, flagging the disagreement with the approval", async () => {
    const s = await seed("a-valid");
    const applicationId = await finalizedDirectDeal(s);
    await confirm(s, confirmArgs(s, applicationId));
    const journalBefore = await dbSnapshot(s.t, ["journalEntries", "journalLines", "accountingEvents"]);

    await amend(s, amendArgs(s, applicationId, G - 1_000));

    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.supplierDisbursedAmountMinor).toBe(G - 1_000);
    expect(app?.supplierDisbursementReference).toBe("WIRE-85B");
    expect(app?.supplierDisbursementStatus).toBe("REQUIRES_RECONCILIATION");
    expect(await dbSnapshot(s.t, ["journalEntries", "journalLines", "accountingEvents"])).toEqual(journalBefore);
  });
});
