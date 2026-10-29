/**
 * SCRUM-571 ruling 10 follow-up (owner ruling c23812 on SCRUM-760): a financed deal must never reach the sealed state with a
 * customer gap that no certified door can collect.
 *
 * The completion refusal (`applications.finalizeDeal`, scrum571FinancedGapFailClosed.test.ts) left a dead end: the gap is
 * resolved BEFORE handover and handover seals the figures, so a handed-over deal with a gap R owed to the dealership could
 * never finalize and its only exit was cancelling it. The refusal now also sits where the operator CHOOSES the route
 * (`financingEconomics.resolveAppraisalGap`, the only writer of R) and at the seal (`applications.registerVehicleHandover`),
 * and closing readiness states the same blocker finalize refuses on.
 *
 * Worked figures (JOD, 3 decimals, minor units; never read back from the code under test). The fixture company lends 85%:
 * a 12,500 quotation approved at 11,500 leaves a net shortfall of 850 that the approver splits.
 *   R = cash to the dealership + instalments to the dealership        (the customer's debt to the dealer)
 *   customer pays the finance company, or the dealer absorbs the rest (never a dealer receivable)
 *
 * Evidence boundary: convex-test only (no OCC, not the Convex runtime, not production data).
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { registerHandover } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import {
  appOf, approvedDeal, CUSTOMER_PAYS_DEALER, DEALER_ABSORBS, jod, makeFinalizeReady, refusedWithCode, resolveGap, seedGapDealership,
  writeLegacySplit, type GapAppId, type GapDealSeed, type GapSplit,
} from "../test-utils/gapDealFixture";
import { composeCustomerGapToDealer } from "./utils/financingEconomics";
import {
  assertApplicationGapCollectable,
  assertCustomerGapToDealerCollectable,
  customerGapToDealerIsUncollectable,
} from "./utils/financedGapPilotRule";
import { FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED } from "./utils/financedGapPilotSwitch";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");
const REFUSAL_CODE = "FINANCED_CUSTOMER_GAP_UNCOLLECTABLE_REFUSED";
const READINESS_CHECK = "CUSTOMER_GAP_COLLECTABLE";
const READINESS_REASON = "CUSTOMER_GAP_UNCOLLECTABLE";
const READINESS_REASON_AFTER_HANDOVER = "CUSTOMER_GAP_UNCOLLECTABLE_AFTER_HANDOVER";

const seed = (tag: string) => seedGapDealership(tag, MODULES);
type Seeded = GapDealSeed;
type AppId = GapAppId;
const approvedWithShortfall = (s: Seeded) => approvedDeal(s, 11_500);
const approvedAtQuotation = (s: Seeded) => approvedDeal(s, 12_500);
const everyTable = (s: Pick<Seeded, "t">) => dbSnapshot(s.t, Object.keys(schema.tables));

/** Every way the customer can be left owing the dealership. */
const UNCOLLECTABLE_SPLITS: ReadonlyArray<{ name: string; split: GapSplit }> = [
  { name: "a cash gap of 850 owed to the dealership", split: CUSTOMER_PAYS_DEALER },
  { name: "an instalment gap counts exactly like a cash gap", split: { customer: jod(850), dealer: 0, cash: 0, installment: jod(850), financeCompany: 0 } },
  { name: "a mixed share (200 cash to the dealership, 400 to the finance company): the 200 still refuses", split: { customer: jod(600), dealer: jod(250), cash: jod(200), installment: 0, financeCompany: jod(400) } },
  { name: "the smallest gap, one minor unit (no rounding or tolerance)", split: { customer: 1, dealer: jod(850) - 1, cash: 1, installment: 0, financeCompany: 0 } },
];

describe("SCRUM-571 ruling 10 follow-up: choosing a route that leaves the customer owing the dealership is refused where it is chosen", () => {
  test.each(UNCOLLECTABLE_SPLITS)("$name: resolveAppraisalGap refuses and writes nothing", async ({ split }) => {
    const s = await seed("resolve");
    const applicationId = await approvedWithShortfall(s);
    const before = await everyTable(s);

    expect(await refusedWithCode(resolveGap(s, applicationId, split))).toBe(REFUSAL_CODE);

    expect(await everyTable(s)).toEqual(before);
    const app = await appOf(s, applicationId);
    expect(app?.gapResolution).toBe("PENDING_NEGOTIATION");
    expect(app?.customerGapCashToDealerMinor).toBeUndefined();
    expect(app?.customerGapInstallmentToDealerMinor).toBeUndefined();
  });

  test("the refusal says what to do and names no figure", async () => {
    const s = await seed("message");
    const applicationId = await approvedWithShortfall(s);
    const refusal = await refusalDataOf(resolveGap(s, applicationId, UNCOLLECTABLE_SPLITS[0].split));
    expect(refusal?.code).toBe(REFUSAL_CODE);
    expect(refusal?.message).toContain("Nothing has been changed");
    expect(refusal?.message).toMatch(/gap/i);
    expect(refusal?.message).not.toMatch(/850/);
    // Truthful about when the remedy exists: it is available before handover only, and only for a configured finance company.
    expect(refusal?.message).toMatch(/Before the vehicle is handed over/);
    expect(refusal?.message).toMatch(/configured/);
    expect(refusal?.message).toMatch(/After handover the agreement can no longer be changed/);
  });

  test("after the refusal the operator can still settle the gap an allowed way", async () => {
    const s = await seed("retry");
    const applicationId = await approvedWithShortfall(s);
    expect(await refusedWithCode(resolveGap(s, applicationId, UNCOLLECTABLE_SPLITS[0].split))).toBe(REFUSAL_CODE);
    await resolveGap(s, applicationId, DEALER_ABSORBS);
    expect((await appOf(s, applicationId))?.gapResolution).toBe("DEALER_ABSORBS");
  });
});

describe("SCRUM-571 ruling 10 follow-up: the allowed routes stay open", () => {
  test.each([
    { name: "the dealership absorbs the whole shortfall", split: DEALER_ABSORBS, resolution: "DEALER_ABSORBS" },
    { name: "the customer pays the whole shortfall to the finance company", split: { customer: jod(850), dealer: 0, cash: 0, installment: 0, financeCompany: jod(850) }, resolution: "CUSTOMER_ABSORBS" },
    { name: "the customer pays part to the finance company and the dealership absorbs the rest", split: { customer: jod(400), dealer: jod(450), cash: 0, installment: 0, financeCompany: jod(400) }, resolution: "SPLIT" },
  ])("$name: resolved, and the vehicle can then be handed over", async ({ split, resolution }) => {
    const s = await seed("allowed");
    const applicationId = await approvedWithShortfall(s);
    await resolveGap(s, applicationId, split);
    const app = await appOf(s, applicationId);
    expect(app?.gapResolution).toBe(resolution);
    expect(composeCustomerGapToDealer(app!)).toEqual({ readable: true, amountMinor: 0 });

    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    expect((await appOf(s, applicationId))?.handoverStatus).toBe("HANDED_OVER");
  });

  test("a deal with no shortfall at all is handed over untouched", async () => {
    const s = await seed("noshort");
    const applicationId = await approvedAtQuotation(s);
    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    expect((await appOf(s, applicationId))?.handoverStatus).toBe("HANDED_OVER");
  });
});

describe("SCRUM-571 ruling 10 follow-up: no deal reaches the sealed state while the customer owes the dealership", () => {
  test.each(UNCOLLECTABLE_SPLITS)("$name (a row agreed before the early refusal): handover refuses and writes nothing", async ({ split }) => {
    const s = await seed("handover");
    const applicationId = await approvedWithShortfall(s);
    await writeLegacySplit(s, applicationId, split);
    const before = await everyTable(s);

    expect(await refusedWithCode(registerHandover(s.owner.as, api, s.orgId, applicationId))).toBe(REFUSAL_CODE);

    expect(await everyTable(s)).toEqual(before);
    expect((await appOf(s, applicationId))?.vehicleHandoverAt).toBeUndefined();
  });

  test("a gap recorded on a deal that needs no resolution is refused at handover too", async () => {
    const s = await seed("noshort-gap");
    const applicationId = await approvedAtQuotation(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerGapCashToDealerMinor: jod(200) }));
    const before = await everyTable(s);

    expect(await refusedWithCode(registerHandover(s.owner.as, api, s.orgId, applicationId))).toBe(REFUSAL_CODE);

    expect(await everyTable(s)).toEqual(before);
  });

  test("an unreadable stored gap fails closed at handover instead of reading as zero", async () => {
    const s = await seed("nan");
    const applicationId = await approvedWithShortfall(s);
    await writeLegacySplit(s, applicationId, DEALER_ABSORBS);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerGapInstallmentToDealerMinor: -5 }));
    expect(await refusedWithCode(registerHandover(s.owner.as, api, s.orgId, applicationId))).toBe(REFUSAL_CODE);
  });
});

describe("SCRUM-571 ruling 10 follow-up: closing readiness states the blocker finalize refuses on", () => {
  /** A handed-over deal that carries R, as a row written before the early refusal would. */
  async function handedOverWithGap(tag: string) {
    const s = await seed(tag);
    const applicationId = await approvedWithShortfall(s);
    await resolveGap(s, applicationId, DEALER_ABSORBS);
    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    await makeFinalizeReady(s, applicationId);
    await writeLegacySplit(s, applicationId, CUSTOMER_PAYS_DEALER);
    return { s, applicationId };
  }
  const readinessOf = (s: Seeded, applicationId: AppId) =>
    s.owner.as.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId });

  test("while R is above zero the check is BLOCKED with a coded reason, and the verdict is not READY", async () => {
    const { s, applicationId } = await handedOverWithGap("blocked");
    const readiness = await readinessOf(s, applicationId);
    const check = readiness.checks.find((c) => c.key === READINESS_CHECK);
    expect(check?.status).toBe("BLOCKED");
    expect(check?.reasonCode).toBe(READINESS_REASON_AFTER_HANDOVER);
    expect(check?.reason).toMatch(/owing the dealership/i);
    expect(readiness.state).toBe("BLOCKED");
    // Only this check stands between the deal and finalize.
    expect(readiness.checks.filter((c) => c.status === "BLOCKED" || c.status === "UNAVAILABLE").map((c) => c.key)).toEqual([READINESS_CHECK]);
  });

  test("after handover the remedy is not 'pay the finance company' or 'change the agreement': neither is possible", async () => {
    const { s, applicationId } = await handedOverWithGap("after-handover");
    const check = (await readinessOf(s, applicationId)).checks.find((c) => c.key === READINESS_CHECK);
    expect(check?.reasonCode).toBe(READINESS_REASON_AFTER_HANDOVER);
    expect(check?.reason).toMatch(/already been handed over/);
    expect(check?.reason).toMatch(/can no longer be changed/);
    expect(check?.reason).toMatch(/contact support/);
    expect(check?.reason).not.toMatch(/agree that/i);
  });

  test("before handover the remedy names the options that exist, and only for where they exist", async () => {
    const s = await seed("pre-handover");
    const applicationId = await approvedWithShortfall(s);
    await writeLegacySplit(s, applicationId, CUSTOMER_PAYS_DEALER);
    const check = (await readinessOf(s, applicationId)).checks.find((c) => c.key === READINESS_CHECK);
    expect(check?.status).toBe("BLOCKED");
    expect(check?.reasonCode).toBe(READINESS_REASON);
    expect(check?.reason).toMatch(/Before the vehicle is handed over/);
    expect(check?.reason).toMatch(/where the finance company is a configured one/);
  });

  test("an unreadable stored gap is BLOCKED as unreadable, not read as zero and not as a debt", async () => {
    const s = await seed("unreadable");
    const applicationId = await approvedWithShortfall(s);
    await writeLegacySplit(s, applicationId, DEALER_ABSORBS);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerGapInstallmentToDealerMinor: -5 }));
    const check = (await readinessOf(s, applicationId)).checks.find((c) => c.key === READINESS_CHECK);
    expect(check?.status).toBe("BLOCKED");
    expect(check?.reasonCode).toBe("CUSTOMER_GAP_UNREADABLE");
    expect(check?.reason).toMatch(/not a readable amount/);
  });

  test("a deal whose readiness names this check is refused by finalize with the same ruling", async () => {
    const { s, applicationId } = await handedOverWithGap("agree");
    const refusal = await refusalDataOf(
      s.owner.as.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId })
    );
    expect(refusal?.code).toBe(REFUSAL_CODE);
  });

  test("once the gap no longer leaves the customer owing the dealership the check is READY", async () => {
    const { s, applicationId } = await handedOverWithGap("clears");
    await writeLegacySplit(s, applicationId, DEALER_ABSORBS);
    const readiness = await readinessOf(s, applicationId);
    expect(readiness.checks.find((c) => c.key === READINESS_CHECK)?.status).toBe("READY");
    expect(readiness.state).toBe("READY");
  });

  test("a deal that was resolved an allowed way never shows the blocker", async () => {
    const s = await seed("never");
    const applicationId = await approvedWithShortfall(s);
    await resolveGap(s, applicationId, { customer: jod(400), dealer: jod(450), cash: 0, installment: 0, financeCompany: jod(400) });
    const readiness = await readinessOf(s, applicationId);
    expect(readiness.checks.find((c) => c.key === READINESS_CHECK)?.status).toBe("READY");
  });

  test("the check is appended LAST, so every existing refusal keeps its order", async () => {
    const { s, applicationId } = await handedOverWithGap("order");
    const readiness = await readinessOf(s, applicationId);
    expect(readiness.checks.at(-1)?.key).toBe(READINESS_CHECK);
  });
});

describe("SCRUM-571 ruling 10 follow-up: the one rule", () => {
  test("the switch is on", () => {
    expect(FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED).toBe(true);
  });

  test("only exactly zero is collectable; an unreadable gap fails closed", () => {
    expect(customerGapToDealerIsUncollectable({ readable: true, amountMinor: 0 })).toBe(false);
    expect(customerGapToDealerIsUncollectable({ readable: true, amountMinor: 1 })).toBe(true);
    expect(customerGapToDealerIsUncollectable({ readable: true, amountMinor: Number.NaN })).toBe(true);
    expect(customerGapToDealerIsUncollectable({ readable: false, reason: "UNSAFE_AMOUNT" })).toBe(true);
    expect(() => assertCustomerGapToDealerCollectable({ readable: true, amountMinor: 0 })).not.toThrow();
    expect(() => assertCustomerGapToDealerCollectable({ readable: true, amountMinor: 1 })).toThrow();
  });

  test("an absent component reads as zero (nothing agreed), a corrupt one as unreadable", () => {
    expect(customerGapToDealerIsUncollectable(composeCustomerGapToDealer({}))).toBe(false);
    expect(customerGapToDealerIsUncollectable(composeCustomerGapToDealer({ customerGapCashToDealerMinor: 0, customerGapInstallmentToDealerMinor: 0 }))).toBe(false);
    expect(customerGapToDealerIsUncollectable(composeCustomerGapToDealer({ customerGapInstallmentToDealerMinor: 1 }))).toBe(true);
    expect(customerGapToDealerIsUncollectable(composeCustomerGapToDealer({ customerGapCashToDealerMinor: -100, customerGapInstallmentToDealerMinor: 200 }))).toBe(true);
  });

  test("an application with no finance company is not this rule's business", () => {
    const gap = composeCustomerGapToDealer({ customerGapCashToDealerMinor: jod(200) });
    expect(() => assertApplicationGapCollectable({ companyId: undefined, quoteModeAtSubmission: undefined }, gap)).not.toThrow();
    expect(() => assertApplicationGapCollectable({ companyId: undefined, quoteModeAtSubmission: "MANUAL_FINANCE_COMPANY" }, gap)).toThrow();
  });
});
