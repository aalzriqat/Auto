/**
 * SCRUM-426 step 1 (SCRUM-418), area 2: closing readiness. Characterisation of the first refusal each
 * role meets at each stage of a financed deal, before step 4 moves the evaluator.
 *
 * Driven through the three public doors: `getClosingReadiness` (query), `finalizeDeal` and
 * `registerVehicleHandover` (mutations), on real documents and the real role templates
 * (MANAGER, SALES, ACCOUNTANT) beside a system owner. The client `deriveStepChecklist` is out of scope.
 *
 * Sources of the expected values:
 *  - Redaction below the finance tier (WITHHELD_*): SCRUM-414, `lib/closingReadinessReasonCodes.ts` header.
 *  - Closing a financed deal is the accountant's act: owner ruling SCRUM-407, comment in `finalizeDeal`.
 *  - Every other value is "characterises <file>:<line>; no ruling" and is listed in the PR report.
 *
 * Evidence boundary: convex-test only (no OCC, no production data).
 */
import { beforeAll, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import { registerHandover, registerRateLimiter } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import {
  G, newApplication, payForwardAsOwner, readyDeal, refusalDataOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";

const MODULES = import.meta.glob("./**/*.ts");
const OWNER_PERMS = ["view:sales", "create:sales", "view:finance_applications", "view:vehicles"];
const templatePerms = (name: string) => DEFAULT_ROLE_TEMPLATES.find((role) => role.name === name)!.permissions as string[];

type RoleName = "owner" | "manager" | "sales" | "accountant";
const ROLES: readonly RoleName[] = ["owner", "manager", "sales", "accountant"];

async function seed() {
  const s = await seedFinancedDealership("readiness", {
    modules: MODULES, ownerPerms: OWNER_PERMS, label: "S426R", vinPrefix: "VIN426R",
    actors: { manager: templatePerms("MANAGER"), sales: templatePerms("SALES"), accountant: templatePerms("ACCOUNTANT") },
  });
  registerRateLimiter(s.t);
  const as: Record<RoleName, typeof s.owner.as> = {
    owner: s.owner.as, manager: s.actors.manager.as, sales: s.actors.sales.as, accountant: s.actors.accountant.as,
  };
  return { ...s, as };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

let vehicleCounter = 0;
async function newVehicle(s: Seeded) {
  vehicleCounter += 1;
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: `VIN426RX${vehicleCounter}`, make: "Kia", model: "Rio", year: 2024, mileage: 10,
      color: "Red", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12_500, status: "AVAILABLE",
      sourceType: "STOCK", purchasePrice: 9_000,
    })
  );
}
const freshApplication = async (s: Seeded) => (await newApplication({ ...s, vehicleId: await newVehicle(s) })).applicationId;
async function approve(s: Seeded, applicationId: Id<"financeApplications">) {
  await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
}
async function approvePurchase(s: Seeded, applicationId: Id<"financeApplications">) {
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: s.orgId, applicationId, submittedQuotationMinor: G, source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId, applicationId, approvedAmountMinor: G, basis: "MANUAL", notes: "Approved at the quotation.",
  });
}

// ---- the stages, each built through the public doors on its own vehicle ----
const STAGE_BUILDERS = {
  PENDING_DOCS: async (s: Seeded) => await freshApplication(s),
  APPROVED_NO_ECONOMICS: async (s: Seeded) => {
    const id = await freshApplication(s);
    await approve(s, id);
    return id;
  },
  PURCHASE_APPROVED: async (s: Seeded) => {
    const id = await freshApplication(s);
    await approve(s, id);
    await approvePurchase(s, id);
    return id;
  },
  HANDED_OVER: async (s: Seeded) => {
    const id = await freshApplication(s);
    await approve(s, id);
    await approvePurchase(s, id);
    await registerHandover(s.owner.as, api, s.orgId, id);
    return id;
  },
  EXPECTED_PAYMENT_NO_COSTS: async (s: Seeded) => {
    const id = await freshApplication(s);
    await approve(s, id);
    await approvePurchase(s, id);
    await registerHandover(s.owner.as, api, s.orgId, id);
    await s.owner.as.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId, applicationId: id, method: "BANK_TRANSFER", expectedDate: Date.now(),
    });
    return id;
  },
  READY_FORWARD_UNPAID: async (s: Seeded) => (await readyDeal({ ...s, vehicleId: await newVehicle(s) })).applicationId,
  REJECTED: async (s: Seeded) => {
    const id = await freshApplication(s);
    await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId: id, status: "REJECTED" });
    return id;
  },
} as const;
type StageName = keyof typeof STAGE_BUILDERS;
const STAGE_NAMES = Object.keys(STAGE_BUILDERS) as StageName[];

// ---- expected refusals (literal) ----
type Refusal = { code?: string; message: string };
const NOT_APPROVED_FINALIZE: Refusal = { message: "Application must be APPROVED before finalizing" };
const NOT_APPROVED_HANDOVER: Refusal = { message: "Application must be APPROVED before registering handover." };
const NEEDS_HANDOVER: Refusal = { message: "Register the vehicle handover to the customer before finalizing the deal." };
const NEEDS_EXPECTED_PAYMENT: Refusal = { message: "Register how and when the payment is expected before finalizing the deal." };
const NEEDS_STAMP: Refusal = {
  message: "Confirm the handover from the deal screen so the figures you acted on can be checked. If you were already on it, reload the page and try again.",
};
const ALREADY_HANDED_OVER: Refusal = { message: "Vehicle handover has already been registered." };
const FORWARD_UNPAID: Refusal = {
  code: "FORWARD_FINALIZE_UNPAID",
  message: "The deposit and contribution owed to the finance company have not been paid yet. A manager or accountant records the payment to the finance company before finalizing.",
};
const COSTS_NONE_FINANCE_TIER: Refusal = {
  code: "COSTS_NONE",
  message: "No costs are itemized on this deal, so its accounting cannot be finalized. Record them, or a zero-cost line saying the dealership bore none, before finalizing.",
};
// SCRUM-414: below the finance tier a readiness refusal is a WITHHELD_* code with the generic sentence.
const COSTS_NONE_WITHHELD: Refusal = { code: "WITHHELD_COSTS_CLOSABLE", message: "Detail withheld: finance access is required to see it." };

interface ReadinessExpectation {
  state: "UNAVAILABLE" | "BLOCKED" | "READY";
  open: boolean;
  /** The first check that is neither READY nor NOT_APPLICABLE, as the finance tier and the redacted tiers see it. */
  first: { key: string; status: string; financeCode: string; withheldCode: string } | null;
}
const REMITTANCE_FIRST = { key: "REMITTANCE_KNOWN", status: "UNAVAILABLE", financeCode: "REMITTANCE_APPROVAL_MISSING", withheldCode: "WITHHELD_REMITTANCE_KNOWN" };
const COSTS_FIRST = { key: "COSTS_CLOSABLE", status: "BLOCKED", financeCode: "COSTS_NONE", withheldCode: "WITHHELD_COSTS_CLOSABLE" };

// characterises applications.ts:4401 getClosingReadiness, :4450 finalizeDeal, :3710 registerVehicleHandover; redaction per SCRUM-414.
const EXPECTED: Record<StageName, {
  readiness: ReadinessExpectation;
  /** What finalizeDeal answers a caller who holds confirm:finance_disbursement; manager is below the finance tier. */
  finalize: { financeTier: Refusal; manager: Refusal };
  /** What registerVehicleHandover answers a caller who holds register:vehicle_handover (called without a stamp). */
  handover: Refusal;
}> = {
  PENDING_DOCS: {
    readiness: { state: "UNAVAILABLE", open: true, first: REMITTANCE_FIRST },
    finalize: { financeTier: NOT_APPROVED_FINALIZE, manager: NOT_APPROVED_FINALIZE },
    handover: NOT_APPROVED_HANDOVER,
  },
  APPROVED_NO_ECONOMICS: {
    readiness: { state: "UNAVAILABLE", open: true, first: REMITTANCE_FIRST },
    finalize: { financeTier: NEEDS_HANDOVER, manager: NEEDS_HANDOVER },
    handover: NEEDS_STAMP,
  },
  PURCHASE_APPROVED: {
    readiness: { state: "BLOCKED", open: true, first: COSTS_FIRST },
    finalize: { financeTier: NEEDS_HANDOVER, manager: NEEDS_HANDOVER },
    handover: NEEDS_STAMP,
  },
  HANDED_OVER: {
    readiness: { state: "BLOCKED", open: true, first: COSTS_FIRST },
    finalize: { financeTier: NEEDS_EXPECTED_PAYMENT, manager: NEEDS_EXPECTED_PAYMENT },
    handover: ALREADY_HANDED_OVER,
  },
  EXPECTED_PAYMENT_NO_COSTS: {
    readiness: { state: "BLOCKED", open: true, first: COSTS_FIRST },
    finalize: { financeTier: COSTS_NONE_FINANCE_TIER, manager: COSTS_NONE_WITHHELD },
    handover: ALREADY_HANDED_OVER,
  },
  READY_FORWARD_UNPAID: {
    readiness: { state: "READY", open: true, first: null },
    finalize: { financeTier: FORWARD_UNPAID, manager: FORWARD_UNPAID },
    handover: ALREADY_HANDED_OVER,
  },
  REJECTED: {
    readiness: { state: "UNAVAILABLE", open: false, first: null },
    finalize: { financeTier: NOT_APPROVED_FINALIZE, manager: NOT_APPROVED_FINALIZE },
    handover: NOT_APPROVED_HANDOVER,
  },
};

const FORBIDDEN_FINALIZE: Refusal = { code: "FORBIDDEN", message: "Forbidden: Missing required permissions: confirm:finance_disbursement" };
const FORBIDDEN_HANDOVER: Refusal = { code: "FORBIDDEN", message: "Forbidden: Missing required permissions: register:vehicle_handover" };

// The checks served for a deal in an operated mode, written independently of lib/closingReadinessReasonCodes.ts.
// DEAL_MODE_RETIRED (SCRUM-495) is in that module's list but is not served for an operated (CONFIGURED_FINANCE_COMPANY) deal; no ruling.
const CHECK_KEYS = [
  "REMITTANCE_KNOWN", "CONFIGURED_FEES_RECORDED", "CUSTODY_ON_LEDGER", "CUSTODY_SETTLED", "COSTS_CLOSABLE",
  "HANDOVER_COSTS_PAID", "FIRST_PAYMENT_RECORDED", "LEGAL_INVOICE_RECORDED", "FINANCING_RECONCILED",
  "CUSTOMER_FINANCE_COMPANY_PAYMENT_CONFIRMED", "RECOGNITION_PERIOD_OPEN",
];

const readinessOf = (s: Seeded, role: RoleName, applicationId: Id<"financeApplications">) =>
  s.as[role].query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId });
const finalizeAs = (s: Seeded, role: RoleName, applicationId: Id<"financeApplications">) =>
  refusalDataOf(s.as[role].mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId, idempotencyKey: `char-${role}-${applicationId}` }));
const handoverAs = (s: Seeded, role: RoleName, applicationId: Id<"financeApplications">) =>
  refusalDataOf(s.as[role].mutation(api.applications.registerVehicleHandover, { orgId: s.orgId, applicationId }));

describe("the first refusal each role meets at each stage", () => {
  let s: Seeded;
  const deals = new Map<StageName, Id<"financeApplications">>();
  const ALL_TABLES = Object.keys(schema.tables);

  beforeAll(async () => {
    s = await seed();
    for (const stage of STAGE_NAMES) deals.set(stage, await STAGE_BUILDERS[stage](s));
  }, 180_000);


  describe.each(STAGE_NAMES)("stage %s", (stage) => {
    test.each(ROLES)("getClosingReadiness as %s: verdict and first unmet check", async (role) => {
      const readiness = await readinessOf(s, role, deals.get(stage)!);
      const want = EXPECTED[stage].readiness;
      expect(readiness.state).toBe(want.state);
      expect(readiness.open).toBe(want.open);
      // SCRUM-117 / SCRUM-414: money is withheld below the accounting-economics tier (owner or view:finance).
      const withheld = role === "manager" || role === "sales";
      expect(readiness.moneyWithheld).toBe(withheld);
      const first = readiness.checks.find((check) => check.status !== "READY" && check.status !== "NOT_APPLICABLE");
      if (want.first === null) {
        expect(first).toBeUndefined();
      } else {
        expect(first).toMatchObject({ key: want.first.key, status: want.first.status, reasonCode: withheld ? want.first.withheldCode : want.first.financeCode });
      }
      if (want.open) expect(new Set(readiness.checks.map((check) => check.key))).toEqual(new Set(CHECK_KEYS));
      else expect(readiness.checks).toEqual([]);
    });

    test.each(["owner", "manager", "accountant"] as const)("finalizeDeal as %s: first refusal, nothing written", async (role) => {
      const before = await dbSnapshot(s.t, ALL_TABLES);
      const want = role === "manager" ? EXPECTED[stage].finalize.manager : EXPECTED[stage].finalize.financeTier;
      const refusal = await finalizeAs(s, role, deals.get(stage)!);
      expect(refusal).toEqual(want);
      expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
    });

    test("finalizeDeal as sales: refused for the missing permission before any state is read", async () => {
      expect(await finalizeAs(s, "sales", deals.get(stage)!)).toEqual(FORBIDDEN_FINALIZE);
    });

    test.each(["owner", "manager", "sales"] as const)("registerVehicleHandover as %s: first refusal, nothing written", async (role) => {
      const before = await dbSnapshot(s.t, ALL_TABLES);
      expect(await handoverAs(s, role, deals.get(stage)!)).toEqual(EXPECTED[stage].handover);
      expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
    });

    test("registerVehicleHandover as accountant: refused for the missing permission before any state is read", async () => {
      expect(await handoverAs(s, "accountant", deals.get(stage)!)).toEqual(FORBIDDEN_HANDOVER);
    });
  });
});

describe("the doors that succeed or move the verdict", () => {
  test("registerVehicleHandover: a stale stamp is refused, the current stamp is accepted and the deal is HANDED_OVER", async () => {
    const s = await seed();
    const applicationId = await STAGE_BUILDERS.PURCHASE_APPROVED(s);
    const stale = await refusalDataOf(
      s.as.sales.mutation(api.applications.registerVehicleHandover, { orgId: s.orgId, applicationId, economicsStamp: "stale-stamp" })
    );
    expect(stale).toEqual({
      message: "The deal's approved figures changed while you were confirming the handover. Re-check them on the deal before handing the vehicle over.",
    });
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))!.handoverStatus).toBe("READY");

    const stamp = await s.as.sales.query(api.applications.handoverStamp, { orgId: s.orgId, applicationId });
    expect(stamp).not.toBeNull();
    await s.as.sales.mutation(api.applications.registerVehicleHandover, { orgId: s.orgId, applicationId, economicsStamp: stamp as string, notes: "Keys handed over." });
    const app = (await s.t.run((ctx) => ctx.db.get(applicationId)))!;
    expect(app.handoverStatus).toBe("HANDED_OVER");
    expect(app.vehicleHandoverBy).toBe(s.actors.sales.userId);
    expect(app.vehicleHandoverNotes).toBe("Keys handed over.");
    expect(typeof app.vehicleHandoverAt).toBe("number");
  });

  test("finalizeDeal once the forward is paid: every finance-disbursement role gets the sale; a repeat returns the same sale", async () => {
    const s = await seed();
    const applicationId = await STAGE_BUILDERS.READY_FORWARD_UNPAID(s);
    expect((await readinessOf(s, "accountant", applicationId)).state).toBe("READY");
    await payForwardAsOwner(s, applicationId);
    const saleId = await s.as.accountant.mutation(api.applications.finalizeDeal, {
      orgId: s.orgId, applicationId, idempotencyKey: "char-accountant-closes",
    });
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))!.status).toBe("CLOSED");
    // characterises applications.ts:4522 (a CLOSED deal with a sale returns it, before any permission-tier refusal); no ruling.
    expect(await s.as.manager.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId, idempotencyKey: "char-manager-repeat" })).toBe(saleId);
    const afterClose = await readinessOf(s, "owner", applicationId);
    expect(afterClose).toMatchObject({ state: "UNAVAILABLE", open: false, checks: [] });
  });
});
