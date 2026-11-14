/**
 * SCRUM-426 step 1 (SCRUM-418), area 1: deal stages. Characterisation of the finance
 * application status lifecycle before step 4 moves its writers.
 *
 * Driven only through public doors (`updateStatus`, `registerVehicleHandover`, `finalizeDeal`,
 * `cancelApplication`, `dealCockpit`) on real documents. The expected transition table below is
 * written from the product lifecycle recorded in the comments of `updateStatus`
 * (convex/applications.ts), not generated from `VALID_STATUS_TRANSITIONS`, which is module-private:
 * the effective table is observed through the door, and both directions are compared as sets.
 *
 * Evidence boundary: convex-test only (repository behaviour, no OCC, no production data).
 */
import { beforeAll, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import { registerHandover, registerRateLimiter } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import {
  finalizeAsOwner, G, newApplication, readyDeal, refusalMessageOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";

const MODULES = import.meta.glob("./**/*.ts");

type Status = Doc<"financeApplications">["status"];
type Target = "DRAFT" | "PENDING_DOCS" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "CLOSED";

const OWNER_PERMS = ["view:sales", "create:sales", "view:finance_applications", "view:vehicles"];
const templatePerms = (name: string) => DEFAULT_ROLE_TEMPLATES.find((role) => role.name === name)!.permissions as string[];

// The product lifecycle, written literally (updateStatus comments, applications.ts ~629 and ~2996).
// Every pair not listed here is illegal; DRAFT is a status the door can name but nothing re-enters.
const LEGAL_EDGES: ReadonlyArray<readonly [Status, Target]> = [
  ["DRAFT", "PENDING_DOCS"],
  ["PENDING_DOCS", "UNDER_REVIEW"],
  ["PENDING_DOCS", "REJECTED"],
  ["UNDER_REVIEW", "APPROVED"],
  ["UNDER_REVIEW", "REJECTED"],
  ["UNDER_REVIEW", "PENDING_DOCS"],
];
// In the transition map as "the record of a product requirement", but refused by the door until
// Phase 3 restores it (applications.ts ~2975): the application cannot leave REJECTED.
// Pins the SCRUM-195 Phase-3 deferral (applications.ts ~2984-2998): the Phase-3 change is expected to flip this expectation.
const DEFERRED_EDGE = ["REJECTED", "PENDING_DOCS"] as const;

const SOURCES: readonly Status[] = ["DRAFT", "PENDING_DOCS", "UNDER_REVIEW", "APPROVED", "REJECTED", "CLOSED", "CANCELLED"];
const TARGETS: readonly Target[] = ["DRAFT", "PENDING_DOCS", "UNDER_REVIEW", "APPROVED", "REJECTED", "CLOSED"];

const REFUSALS = {
  CLOSE: /closed by finalizing the deal, not by setting its status/,
  INVALID: /Invalid finance application status transition/,
  REOPEN: /has already left the finance pipeline and cannot be reopened yet/,
} as const;
type Outcome = keyof typeof REFUSALS | "ACCEPTED";

function expectedOutcome(from: Status, to: Target): Outcome {
  if (to === "CLOSED") return "CLOSE";
  if (from === DEFERRED_EDGE[0] && to === DEFERRED_EDGE[1]) return "REOPEN";
  return LEGAL_EDGES.some(([f, t]) => f === from && t === to) ? "ACCEPTED" : "INVALID";
}

// characterises financingEconomics.ts:1406 creditDecisionForStatus and :1427 handoverStatusForFacts; no ruling.
const CREDIT_DECISION: Record<Target, string> = {
  DRAFT: "DRAFT", PENDING_DOCS: "SUBMITTED", UNDER_REVIEW: "UNDER_REVIEW", APPROVED: "APPROVED", REJECTED: "REJECTED", CLOSED: "APPROVED",
};

async function seed(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: OWNER_PERMS, label: "S426", vinPrefix: "VIN426",
    actors: { manager: templatePerms("MANAGER"), sales: templatePerms("SALES"), accountant: templatePerms("ACCOUNTANT") },
  });
  registerRateLimiter(s.t);
  return s;
}
type Seeded = Awaited<ReturnType<typeof seed>>;

let extraVehicles = 0;
/** A deal on its own vehicle: one in-flight application per vehicle is the rule. */
async function newVehicle(s: Seeded) {
  extraVehicles += 1;
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: `VIN426X${extraVehicles}`, make: "Kia", model: "Rio", year: 2024, mileage: 10,
      color: "Red", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12_500, status: "AVAILABLE",
      sourceType: "STOCK", purchasePrice: 9_000,
    })
  );
}
async function dealOnNewVehicle(s: Seeded) {
  return (await newApplication({ ...s, vehicleId: await newVehicle(s) })).applicationId;
}

const readApp = (s: Seeded, id: Id<"financeApplications">) => s.t.run((ctx) => ctx.db.get(id));
const logOf = (s: Seeded, id: Id<"financeApplications">) =>
  s.t.run((ctx) => ctx.db.query("applicationStatusLog").withIndex("by_application", (q) => q.eq("applicationId", id)).collect());

/** A deal in `status`, reached through the doors wherever a door exists. */
async function dealIn(s: Seeded, status: Exclude<Status, "CLOSED">) {
  const applicationId = await dealOnNewVehicle(s);
  const update = (who: "owner" | "approver", to: Target) =>
    s[who].as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: to });
  if (status === "DRAFT") await s.t.run((ctx) => ctx.db.patch(applicationId, { status: "DRAFT" }));
  if (status === "UNDER_REVIEW" || status === "APPROVED") await update("owner", "UNDER_REVIEW");
  if (status === "APPROVED") await update("approver", "APPROVED");
  if (status === "REJECTED") await update("owner", "REJECTED");
  if (status === "CANCELLED") {
    await s.owner.as.mutation(api.applications.cancelApplication, { orgId: s.orgId, applicationId, idempotencyKey: `cancel-${applicationId}` });
  }
  return applicationId;
}

describe("updateStatus: the legal edges", () => {
  test.each(LEGAL_EDGES)("%s -> %s is accepted and writes status, dimensions and one log row", async (from, to) => {
    const s = await seed(`edge_${from}_${to}`.toLowerCase());
    const applicationId = await dealIn(s, from as Exclude<Status, "CLOSED">);
    const logBefore = await logOf(s, applicationId);
    const actor = to === "APPROVED" ? s.approver : s.owner;

    await actor.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: to });

    const app = (await readApp(s, applicationId))!;
    expect(app.status).toBe(to);
    expect(app.creditDecision).toBe(CREDIT_DECISION[to]);
    expect(app.handoverStatus).toBe(to === "APPROVED" ? "READY" : "BLOCKED");
    expect(app.approvedBy).toBe(to === "APPROVED" ? actor.userId : undefined);
    const logAfter = await logOf(s, applicationId);
    expect(logAfter).toHaveLength(logBefore.length + 1);
    expect(logAfter.at(-1)).toMatchObject({ fromStatus: from, toStatus: to, changedBy: actor.userId });
  });
});

// Both directions: the legal-edge test.each drives every accepted pair; this matrix drives every other pair and names its refusal.
describe("updateStatus: every other pair is refused and writes nothing", () => {
  let s: Seeded;
  const deals = new Map<Status, Id<"financeApplications">>();
  beforeAll(async () => {
    s = await seed("matrix");
    for (const source of SOURCES.filter((status) => status !== "CLOSED")) {
      deals.set(source, await dealIn(s, source as Exclude<Status, "CLOSED">));
    }
    const { applicationId } = await readyDeal(s);
    await finalizeAsOwner(s, applicationId);
    deals.set("CLOSED", applicationId);
  }, 120_000);

  test.each(SOURCES)("from %s, each target is refused with its own reason", async (from) => {
    const applicationId = deals.get(from)!;
    const tables = ["financeApplications", "applicationStatusLog", "vehicles", "deposits"];
    const before = await dbSnapshot(s.t, tables);
    const observed: Record<string, Outcome> = {};
    const expected: Record<string, Outcome> = {};
    for (const to of TARGETS) {
      if (expectedOutcome(from, to) === "ACCEPTED") continue;
      const message = await refusalMessageOf(
        s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: to })
      );
      expect(message, `${from} -> ${to} must be refused`).not.toBeNull();
      observed[to] = (Object.keys(REFUSALS) as Array<keyof typeof REFUSALS>).find((key) => REFUSALS[key].test(message!))!;
      expected[to] = expectedOutcome(from, to);
    }
    expect(observed).toEqual(expected);
    expect(await dbSnapshot(s.t, tables)).toEqual(before);
  });

});

describe("status writers outside the transition map", () => {
  test("cancelApplication writes CANCELLED, which updateStatus cannot name", async () => {
    const s = await seed("cancelwriter");
    const applicationId = await dealOnNewVehicle(s);
    await s.owner.as.mutation(api.applications.cancelApplication, { orgId: s.orgId, applicationId, idempotencyKey: "cancel-writer" });
    const app = (await readApp(s, applicationId))!;
    expect(app.status).toBe("CANCELLED");
    expect(app.creditDecision).toBe("CANCELLED");
    await expect(
      s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "CANCELLED" as never })
    ).rejects.toThrow(/Validator error: Expected one of .*got .{0,3}CANCELLED/);
  });

  test("the deal status vocabulary has no REVERSED: the two REVERSED writers belong to invoiceReceiptApplications", async () => {
    // characterises accounting/invoiceReceiptActivation.ts:284 and accounting/receiptMovement.ts:644, which patch
    // `invoiceReceiptApplications.status`, never `financeApplications.status`; no ruling.
    const s = await seed("reversed");
    const applicationId = await dealOnNewVehicle(s);
    await expect(s.t.run((ctx) => ctx.db.patch(applicationId, { status: "REVERSED" as never }))).rejects.toThrow(/Validator error: Expected one of .*got .{0,3}REVERSED/);
    expect((await readApp(s, applicationId))!.status).toBe("PENDING_DOCS");
  });
});

describe("handover, settlement and credit decision as dealCockpit returns them", () => {
  // characterises financingEconomics.ts:1828 deriveDealStages, :1427 handoverStatusForFacts and :1450
  // settlementStatusForFacts as observed through dealCockpit; no ruling.
  let s: Seeded;
  const stagesOf = async (id: Id<"financeApplications">) => {
    const cockpit = await s.owner.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: id });
    return cockpit!.stages.map((stage) => `${stage.key}=${stage.state}${stage.blocker ? `(${stage.blocker})` : ""}`);
  };
  const dimensions = async (id: Id<"financeApplications">) => {
    const app = (await readApp(s, id))!;
    return { status: app.status, creditDecision: app.creditDecision, handoverStatus: app.handoverStatus, settlementStatus: app.settlementStatus, gapResolution: app.gapResolution };
  };

  beforeAll(async () => {
    s = await seed("cockpit");
  }, 120_000);

  test("walks from approval, through purchase approval and handover, to the settlement wait", async () => {
    const applicationId = await dealIn(s, "APPROVED");
    expect(await dimensions(applicationId)).toEqual({
      status: "APPROVED", creditDecision: "APPROVED", handoverStatus: "READY", settlementStatus: "NOT_READY", gapResolution: undefined,
    });
    expect(await stagesOf(applicationId)).toEqual([
      "APPLICATION=COMPLETE", "CREDIT_DECISION=COMPLETE", "APPRAISAL=BLOCKED(AwaitingAppraisal)", "APPROVED_PURCHASE=PENDING",
      "DELIVERY_ACTIONS=NOT_APPLICABLE", "DISBURSEMENT=PENDING", "HANDOVER=PENDING", "SETTLEMENT=PENDING",
    ]);

    await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: G, source: "MANUAL_ENTRY",
    });
    await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: G, basis: "MANUAL", notes: "Approved at the quotation.",
    });
    expect(await dimensions(applicationId)).toMatchObject({ handoverStatus: "READY", settlementStatus: "NOT_READY", gapResolution: "NOT_REQUIRED" });
    expect(await stagesOf(applicationId)).toEqual([
      "APPLICATION=COMPLETE", "CREDIT_DECISION=COMPLETE", "APPRAISAL=COMPLETE", "APPROVED_PURCHASE=COMPLETE",
      "DELIVERY_ACTIONS=NOT_APPLICABLE", "DISBURSEMENT=PENDING", "HANDOVER=CURRENT", "SETTLEMENT=PENDING",
    ]);

    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    expect(await dimensions(applicationId)).toMatchObject({ status: "APPROVED", handoverStatus: "HANDED_OVER", settlementStatus: "NOT_READY" });
    expect(await stagesOf(applicationId)).toEqual([
      "APPLICATION=COMPLETE", "CREDIT_DECISION=COMPLETE", "APPRAISAL=COMPLETE", "APPROVED_PURCHASE=COMPLETE",
      "DELIVERY_ACTIONS=NOT_APPLICABLE", "DISBURSEMENT=PENDING", "HANDOVER=COMPLETE", "SETTLEMENT=BLOCKED(AwaitingSettlement)",
    ]);
  });

  test("finalizeDeal is the CLOSED writer: status CLOSED, credit decision kept, settlement EXPECTED, disbursement awaited", async () => {
    // characterises applications.ts finalizeDeal (the only door to CLOSED); no ruling.
    const { applicationId } = await readyDeal({ ...s, vehicleId: await newVehicle(s) });
    await finalizeAsOwner(s, applicationId);
    expect(await dimensions(applicationId)).toEqual({
      status: "CLOSED", creditDecision: "APPROVED", handoverStatus: "HANDED_OVER", settlementStatus: "EXPECTED", gapResolution: "NOT_REQUIRED",
    });
    expect(await stagesOf(applicationId)).toEqual([
      "APPLICATION=COMPLETE", "CREDIT_DECISION=COMPLETE", "APPRAISAL=COMPLETE", "APPROVED_PURCHASE=COMPLETE",
      "DELIVERY_ACTIONS=NOT_APPLICABLE", "DISBURSEMENT=BLOCKED(AwaitingDisbursement)", "HANDOVER=COMPLETE", "SETTLEMENT=PENDING",
    ]);
  });
});
