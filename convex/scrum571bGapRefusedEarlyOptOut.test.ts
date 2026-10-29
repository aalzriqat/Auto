/**
 * SCRUM-571 ruling 10 follow-up: the opt-out. This suite turns the pilot switch OFF (the fixture-only opt-out that the
 * census in scripts/scrum571FinancedGapOptOutCensus.test.ts lists) and proves that every door the early refusal added
 * goes back to the behaviour it had before the ruling, so the switch is one lever and a post-pilot activation (receipt
 * and application doors SCRUM-722/723/724 certified, owner approval) restores the customer-pays-the-dealership route
 * without a code change to the doors. The refusal itself is proven, with the real switch, in
 * scrum571bGapRefusedEarly.test.ts.
 *
 * Evidence boundary: convex-test only.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { registerHandover } from "../test-utils/convexTest";
import {
  appOf, approvedDeal, CUSTOMER_PAYS_DEALER, seedGapDealership, resolveGap, writeLegacySplit,
} from "../test-utils/gapDealFixture";
import { composeCustomerGapToDealer } from "./utils/financingEconomics";
import { customerGapToDealerIsUncollectable } from "./utils/financedGapPilotRule";

// SCRUM-571 financed-gap-collection opt-out: this suite exists to show the doors with the switch off.
vi.mock("./utils/financedGapPilotSwitch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/financedGapPilotSwitch")>()),
  FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED: false,
}));

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

describe("SCRUM-571 ruling 10 follow-up, switch off: the old behaviour returns at every door", () => {
  test("the rule reads nothing as uncollectable", () => {
    expect(customerGapToDealerIsUncollectable({ readable: true, amountMinor: 850_000 })).toBe(false);
    expect(customerGapToDealerIsUncollectable({ readable: false, reason: "UNSAFE_AMOUNT" })).toBe(false);
  });

  test("the customer can again be recorded as paying the dealership, and the vehicle handed over", async () => {
    const s = await seedGapDealership("off-resolve", MODULES);
    const applicationId = await approvedDeal(s, 11_500);
    await resolveGap(s, applicationId, CUSTOMER_PAYS_DEALER);
    const app = await appOf(s, applicationId);
    expect(app?.gapResolution).toBe("CUSTOMER_ABSORBS");
    expect(composeCustomerGapToDealer(app!)).toEqual({ readable: true, amountMinor: 850_000 });

    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    expect((await appOf(s, applicationId))?.handoverStatus).toBe("HANDED_OVER");
  });

  test("a handed-over deal with a gap shows the check as READY", async () => {
    const s = await seedGapDealership("off-ready", MODULES);
    const applicationId = await approvedDeal(s, 11_500);
    await writeLegacySplit(s, applicationId, CUSTOMER_PAYS_DEALER);
    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    const readiness = await s.owner.as.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId });
    expect(readiness.checks.find((c) => c.key === "CUSTOMER_GAP_COLLECTABLE")?.status).toBe("READY");
  });
});
