/**
 * SCRUM-613: no door may post or record money on a deal whose approval has an
 * excess the posting leg cannot carry. The excess is the part of the customer's
 * first payment (plus F) that goes beyond the approved value A; the leg keeps it
 * as dealer income out of the held deposit, so an excess larger than the deposit
 * the dealership holds is refused with a coded reason at every door.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import { readyDeal, refusalDataOf, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { seedBank } from "../test-utils/bankFixture";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { closingReadinessInputsOrRefusal, prospectiveForwardPlan } from "./domains/deal/closingReadiness";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");
const PERMS = [
  "create:sales", "view:sales", "edit:sales", "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers", "approve:requests", "view:finance_applications",
  "create:finance_application", "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover", "register:expected_payment",
  "manage:finance", "view:finance", "view:commissions", "manage:commissions", "view:reports", "manage:settings",
];
// Larger than the 200,000 deposit the fixture holds, so the shape is refused (EXCESS_EXCEEDS_HELD_DEPOSIT).
const EXCESS = 300_000;
const FORWARD = 1_575_000; // H + D of the fixture deal

async function seedExcessDeal(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: PERMS, label: "S613X", vinPrefix: "VIN613X", actors: {}, sourced: false,
  });
  const { applicationId } = await readyDeal(s);
  // The field an approval with an excess stores (approveDealerPurchaseAmount ->
  // recomputeAndPatchEconomics); the refusal depends on nothing else.
  await s.t.run((ctx) => ctx.db.patch(applicationId, { approvalExcessMinor: EXCESS }));
  return { s, applicationId };
}
type Seeded = Awaited<ReturnType<typeof seedExcessDeal>>["s"];

/** Row counts of every table a money door could write, to prove "nothing was written". */
async function writes(s: Seeded) {
  return await s.t.run(async (ctx) => ({
    forwards: (await ctx.db.query("financeCompanyForwards").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    journals: (await ctx.db.query("journalEntries").collect()).length,
    sales: (await ctx.db.query("sales").collect()).length,
  }));
}

describe("a deal whose approval has an excess accepts no money when its excess cannot be carried", () => {
  test("recordFinanceCompanyForward refuses with the coded excess refusal and writes nothing", async () => {
    const { s, applicationId } = await seedExcessDeal("fwd");
    const before = await writes(s);
    const refusal = await refusalDataOf(
      s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
        orgId: s.orgId, applicationId, method: "BANK_TRANSFER", bankAccountId: await seedBank(s.t, s.orgId),
        paidAt: Date.now(), expectedAmountMinor: FORWARD, idempotencyKey: crypto.randomUUID(),
      }),
    );
    expect(await writes(s)).toEqual(before);
    expect(refusal?.code).toBe("EXCESS_EXCEEDS_HELD_DEPOSIT");
    expect((await s.t.run((ctx) => ctx.db.get(applicationId as Id<"financeApplications">)))?.status).toBe("APPROVED");
  });

  test("the shared readiness-inputs seam refuses with the coded error, and a deal without an excess passes it", async () => {
    const { s, applicationId } = await seedExcessDeal("seam");
    const run = async () =>
      await s.t
        .run(async (ctx) => await closingReadinessInputsOrRefusal(ctx, (await ctx.db.get(applicationId))!, "testing"))
        .then((r) => (r.ok ? true : r.refusal.code), (e: unknown) => (e as { data?: { code?: string } }).data?.code ?? "threw");
    expect(await run()).toBe("EXCESS_EXCEEDS_HELD_DEPOSIT");
    await s.t.run((ctx) => ctx.db.patch(applicationId, { approvalExcessMinor: 0 }));
    expect(await run()).toBe(true);
    // A row without F (legacy or production data) carries no excess field at all and must pass the seam.
    await s.t.run((ctx) => ctx.db.patch(applicationId, { approvalExcessMinor: undefined, approvedFinancingAmountMinor: undefined }));
    expect(await run()).toBe(true);
  });

  test("the cockpit readiness query stays a read and reports the deal as not determinable", async () => {
    const { s, applicationId } = await seedExcessDeal("ready");
    const view = await s.owner.as.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId });
    expect(view.state).toBe("UNAVAILABLE");
    expect(view.unavailableReason).toBeTruthy();
  });

  test("the forward payment's prospective plan carries the refusal to its caller, and a deal without an excess still yields a plan", async () => {
    const { s, applicationId } = await seedExcessDeal("pros");
    const code = async () =>
      await s.t
        .run(async (ctx) => {
          await prospectiveForwardPlan(ctx, (await ctx.db.get(applicationId))!, true);
          return null;
        })
        .then(() => null, (e: unknown) => (e as { data?: { code?: string } }).data?.code ?? null);
    expect(await code()).toBe("EXCESS_EXCEEDS_HELD_DEPOSIT");
    await s.t.run((ctx) => ctx.db.patch(applicationId, { approvalExcessMinor: 0 }));
    expect(await code()).toBeNull();
  });
});
