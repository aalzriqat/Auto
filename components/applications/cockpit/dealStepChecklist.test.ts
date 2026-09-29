/**
 * SCRUM-417 UX PR 4 (O2) -- the sub-step checklist derivation, one block per
 * stage. Pure: the facts go in, ids/statuses/destinations come out.
 */
import { describe, expect, test } from "vitest";
import { deriveStepChecklist, type ChecklistFacts } from "./dealStepChecklist";

const facts = (over: Partial<ChecklistFacts> & Pick<ChecklistFacts, "stageKey" | "stageState">): ChecklistFacts => ({
  stageStates: {},
  ...over,
});
const view = (items: ReturnType<typeof deriveStepChecklist>) =>
  (items ?? []).map((item) => `${item.id}:${item.status}`);

describe("stages with no sub-steps say nothing", () => {
  test.each(["APPLICATION", "CREDIT_DECISION", "APPRAISAL", "SALE_AGREED", "SOMETHING_NEW"])("%s", (stageKey) => {
    expect(deriveStepChecklist(facts({ stageKey, stageState: "CURRENT" }))).toBeNull();
  });
});

describe("APPROVED_PURCHASE", () => {
  test("no approved amount yet: the amount is current, the shortfall pending", () => {
    const items = deriveStepChecklist(
      facts({ stageKey: "APPROVED_PURCHASE", stageState: "BLOCKED", blocker: "NoApprovedPurchaseAmount" })
    );
    expect(view(items)).toEqual(["approved-amount:current", "gap-settled:pending"]);
    expect(items?.[0].destination).toBe("financeDecision");
  });
  test.each(["GapUnresolved", "GapNegotiationFailed"])("amount recorded, %s: the shortfall is current", (blocker) => {
    const items = deriveStepChecklist(facts({ stageKey: "APPROVED_PURCHASE", stageState: "BLOCKED", blocker }));
    expect(view(items)).toEqual(["approved-amount:done", "gap-settled:current"]);
  });
  test("a blocker key this code does not know is never read as 'amount recorded'", () => {
    const items = deriveStepChecklist(
      facts({ stageKey: "APPROVED_PURCHASE", stageState: "BLOCKED", blocker: "SomeRenamedBlocker" })
    );
    expect(view(items)).toEqual(["approved-amount:current", "gap-settled:pending"]);
  });
  test("complete: everything done; pending: nothing claimed", () => {
    expect(view(deriveStepChecklist(facts({ stageKey: "APPROVED_PURCHASE", stageState: "COMPLETE" })))).toEqual([
      "approved-amount:done",
      "gap-settled:done",
    ]);
    expect(view(deriveStepChecklist(facts({ stageKey: "APPROVED_PURCHASE", stageState: "PENDING" })))).toEqual([
      "approved-amount:pending",
      "gap-settled:pending",
    ]);
  });
});

describe("DELIVERY_ACTIONS", () => {
  const stageKey = "DELIVERY_ACTIONS";
  test("no required documents: no checklist", () => {
    expect(deriveStepChecklist(facts({ stageKey, stageState: "CURRENT", documents: [] }))).toBeNull();
    expect(
      deriveStepChecklist(facts({ stageKey, stageState: "CURRENT", documents: [{ required: false, status: "MISSING" }] }))
    ).toBeNull();
    expect(deriveStepChecklist(facts({ stageKey, stageState: "CURRENT" }))).toBeNull();
  });
  test("something missing: upload is current", () => {
    const items = deriveStepChecklist(
      facts({
        stageKey,
        stageState: "BLOCKED",
        documents: [
          { required: true, status: "UPLOADED" },
          { required: true, status: "MISSING" },
        ],
      })
    );
    expect(view(items)).toEqual(["documents-uploaded:current", "documents-verified:pending"]);
    expect(items?.[0].destination).toBe("documents");
  });
  test("all uploaded, one not verified: verify is current", () => {
    const items = deriveStepChecklist(
      facts({
        stageKey,
        stageState: "BLOCKED",
        documents: [
          { required: true, status: "VERIFIED" },
          { required: true, status: "UPLOADED" },
          { required: false, status: "MISSING" },
        ],
      })
    );
    expect(view(items)).toEqual(["documents-uploaded:done", "documents-verified:current"]);
  });
  test("complete: all done", () => {
    const items = deriveStepChecklist(
      facts({ stageKey, stageState: "COMPLETE", documents: [{ required: true, status: "VERIFIED" }] })
    );
    expect(view(items)).toEqual(["documents-uploaded:done", "documents-verified:done"]);
  });
});

describe("HANDOVER", () => {
  const stageKey = "HANDOVER";
  // registerVehicleHandover does not read handover costs -- they gate the close --
  // so none of them is an item here.
  test("ready (no blocker): the figures are done and registering is the one thing left", () => {
    const items = deriveStepChecklist(facts({ stageKey, stageState: "CURRENT" }));
    expect(view(items)).toEqual(["economics-ready:done", "register-handover:current"]);
    expect(items?.[1].destination).toBe("primaryAction");
  });
  test("HandoverBlocked: the figures are current, registering pending", () => {
    const items = deriveStepChecklist(facts({ stageKey, stageState: "BLOCKED", blocker: "HandoverBlocked" }));
    expect(view(items)).toEqual(["economics-ready:current", "register-handover:pending"]);
  });
  test("any blocked handover is not ready, whatever the blocker key is called", () => {
    const items = deriveStepChecklist(facts({ stageKey, stageState: "BLOCKED", blocker: "Renamed" }));
    expect(view(items)).toEqual(["economics-ready:current", "register-handover:pending"]);
  });
  test("costs never appear under Handover, even when readiness shows them unpaid", () => {
    const items = deriveStepChecklist(
      facts({
        stageKey,
        stageState: "CURRENT",
        checks: { CONFIGURED_FEES_RECORDED: "BLOCKED", HANDOVER_COSTS_PAID: "BLOCKED" },
      })
    );
    expect(view(items)).toEqual(["economics-ready:done", "register-handover:current"]);
  });
  test("a pending handover previews everything as pending; a complete one as done", () => {
    expect(view(deriveStepChecklist(facts({ stageKey, stageState: "PENDING" })))).toEqual([
      "economics-ready:pending",
      "register-handover:pending",
    ]);
    expect(view(deriveStepChecklist(facts({ stageKey, stageState: "COMPLETE" })))).toEqual([
      "economics-ready:done",
      "register-handover:done",
    ]);
  });
});

describe("SETTLEMENT", () => {
  const stageKey = "SETTLEMENT";
  const ready = { CONFIGURED_FEES_RECORDED: "READY", HANDOVER_COSTS_PAID: "READY" } as const;
  const open = { stageKey, stageState: "BLOCKED" as const, blocker: "AwaitingSettlement", expectedPaymentRegistered: true };
  test("route required and missing: the route is current, in the server's order", () => {
    const items = deriveStepChecklist(
      facts({ ...open, routeRequired: true, routeRecorded: false, readinessState: "NOT_READY", checks: ready })
    );
    expect(view(items)).toEqual([
      "expected-payment:done",
      "route-recorded:current",
      "costs-recorded:done",
      "costs-paid:done",
      "closing-checks:pending",
      "close-deal:pending",
    ]);
  });
  test("handover costs are closing gates: unpaid costs are the current item, with a destination", () => {
    const items = deriveStepChecklist(
      facts({
        ...open,
        routeRequired: false,
        routeRecorded: true,
        readinessState: "NOT_READY",
        checks: { CONFIGURED_FEES_RECORDED: "READY", HANDOVER_COSTS_PAID: "BLOCKED" },
      })
    );
    expect(view(items)).toEqual([
      "expected-payment:done",
      "route-recorded:done",
      "costs-recorded:done",
      "costs-paid:current",
      "closing-checks:pending",
      "close-deal:pending",
    ]);
    expect(items?.find((i) => i.id === "costs-paid")?.destination).toBe("handoverCosts");
  });
  test("costs done, other checks not ready: the checks are current", () => {
    const items = deriveStepChecklist(facts({ ...open, readinessState: "NOT_READY", checks: ready }));
    expect(view(items)).toEqual([
      "expected-payment:done",
      "costs-recorded:done",
      "costs-paid:done",
      "closing-checks:current",
      "close-deal:pending",
    ]);
    expect(items?.find((i) => i.id === "closing-checks")?.destination).toBe("closing");
  });
  test("ready: close the deal is current", () => {
    const items = deriveStepChecklist(facts({ ...open, readinessState: "READY", checks: ready }));
    expect(view(items).at(-1)).toBe("close-deal:current");
    expect(view(items).filter((s) => s.endsWith(":pending"))).toEqual([]);
  });
  test("a not-applicable cost check is absent, not done", () => {
    const items = deriveStepChecklist(
      facts({
        ...open,
        readinessState: "NOT_READY",
        checks: { CONFIGURED_FEES_RECORDED: "NOT_APPLICABLE", HANDOVER_COSTS_PAID: "NOT_APPLICABLE" },
      })
    );
    expect(view(items)).toEqual(["expected-payment:done", "closing-checks:current", "close-deal:pending"]);
  });
  test("RISK: an expected check key that is absent renders not-done -- never omitted, never done", () => {
    const items = deriveStepChecklist(
      facts({
        ...open,
        readinessState: "NOT_READY",
        // both keys renamed by some future server change
        checks: { FEES_RECORDED_V2: "READY", COSTS_PAID_V2: "READY" } as never,
      })
    );
    const byId = Object.fromEntries((items ?? []).map((item) => [item.id, item.status]));
    expect(byId["costs-recorded"]).toBe("current");
    expect(byId["costs-paid"]).toBe("pending");
    for (const id of ["costs-recorded", "costs-paid"]) expect(byId[id]).not.toBe("done");
  });
  test("RISK: a check with an unrecognised status is not done either", () => {
    const items = deriveStepChecklist(
      facts({
        ...open,
        readinessState: "NOT_READY",
        checks: { CONFIGURED_FEES_RECORDED: "SOMETHING_NEW", HANDOVER_COSTS_PAID: "READY" },
      })
    );
    expect(items?.find((i) => i.id === "costs-recorded")?.status).toBe("current");
  });
  test("a caller who sees no readiness still gets the gates, none of them ticked", () => {
    const items = deriveStepChecklist(facts({ stageKey, stageState: "BLOCKED" }));
    expect(view(items)).toEqual([
      "expected-payment:current",
      "costs-recorded:pending",
      "costs-paid:pending",
      "closing-checks:pending",
      "close-deal:pending",
    ]);
  });
});
describe("DISBURSEMENT", () => {
  const stageKey = "DISBURSEMENT";
  test("neighbours unknown: no checklist", () => {
    expect(deriveStepChecklist(facts({ stageKey, stageState: "CURRENT" }))).toBeNull();
  });
  test("handed over and closed: confirming the payment is current", () => {
    const items = deriveStepChecklist(
      facts({ stageKey, stageState: "BLOCKED", stageStates: { HANDOVER: "COMPLETE", SETTLEMENT: "PENDING" } })
    );
    expect(view(items)).toEqual(["handed-over:done", "sale-closed:done", "payment-confirmed:current"]);
  });
  test("not yet handed over: handover is the first thing outstanding", () => {
    const items = deriveStepChecklist(
      facts({ stageKey, stageState: "PENDING", stageStates: { HANDOVER: "CURRENT", SETTLEMENT: "PENDING" } })
    );
    expect(view(items)).toEqual(["handed-over:pending", "sale-closed:pending", "payment-confirmed:pending"]);
  });
});

describe("INVARIANT: the checklist never contradicts the step's own status", () => {
  // The only stage the server ever reports CURRENT (no blocker: "nothing is
  // outstanding") is HANDOVER (`deriveDealStages`). There, whatever else the
  // cockpit holds, no item is pending, and the one current item is the step's
  // own action -- and a cash deal is not credited with a fact it does not have.
  const hostileFacts: Array<Partial<ChecklistFacts>> = [
    {},
    { documents: [{ required: true, status: "MISSING" }] },
    { checks: { CONFIGURED_FEES_RECORDED: "BLOCKED", HANDOVER_COSTS_PAID: "BLOCKED" }, readinessState: "NOT_READY" },
    { checks: {}, readinessState: "NOT_READY", routeRecorded: false, expectedPaymentRegistered: false },
    { stageStates: { HANDOVER: "CURRENT", SETTLEMENT: "PENDING" } },
  ];
  test.each(["FINANCED", "CASH", undefined])("HANDOVER (%s) with no blocker: nothing is pending-blocking", (dealKind) => {
    for (const extra of hostileFacts) {
      const items = deriveStepChecklist(facts({ stageKey: "HANDOVER", stageState: "CURRENT", dealKind, ...extra })) ?? [];
      for (const item of items) {
        expect(item.status, `${item.id}`).not.toBe("pending");
        if (item.status === "current") expect(item.destination).toBe("primaryAction");
      }
    }
  });
  test("no stage reports 'done' for a fact the server did not report", () => {
    // No blocker, no facts, no live control: nothing but the stage's own state may tick anything.
    for (const stageKey of ["APPROVED_PURCHASE", "SETTLEMENT"]) {
      const items = deriveStepChecklist(facts({ stageKey, stageState: "BLOCKED" })) ?? [];
      expect(items.filter((i) => i.status === "done").map((i) => i.id)).toEqual([]);
    }
  });
  test.each(["APPROVED_PURCHASE", "DELIVERY_ACTIONS", "HANDOVER", "SETTLEMENT", "DISBURSEMENT"])(
    "%s: at most one current item in any state",
    (stageKey) => {
      for (const stageState of ["CURRENT", "BLOCKED", "PENDING", "COMPLETE", "STOPPED"] as const) {
        for (const extra of hostileFacts) {
          const items = deriveStepChecklist(facts({ stageKey, stageState, ...extra })) ?? [];
          expect(items.filter((i) => i.status === "current").length).toBeLessThanOrEqual(1);
        }
      }
    }
  );
});
// ---------------------------------------------------------------------------
// SCRUM-417 UX4 round 1 -- the checklist is never its own derivation of "next".
// ---------------------------------------------------------------------------
describe("ROUND 1 F1: Settlement mirrors the finalizeDeal gates and the live control", () => {
  const stageKey = "SETTLEMENT";
  const ready = { CONFIGURED_FEES_RECORDED: "READY", HANDOVER_COSTS_PAID: "READY" };
  const base = {
    stageKey,
    stageState: "BLOCKED" as const,
    blocker: "AwaitingSettlement",
    checks: ready,
    readinessState: "READY",
  };
  test("READY checks but no expected payment: registering it is current and closing is pending", () => {
    const items = deriveStepChecklist(
      facts({ ...base, expectedPaymentRegistered: false, liveAction: { actionKey: "RegisterExpectedPaymentAction" } })
    );
    const byId = Object.fromEntries((items ?? []).map((i) => [i.id, i.status]));
    expect(byId["expected-payment"]).toBe("current");
    expect(byId["close-deal"]).toBe("pending");
    expect(items?.find((i) => i.id === "expected-payment")?.destination).toBe("primaryAction");
  });
  test("an unknown expected-payment fact is not done", () => {
    const items = deriveStepChecklist(facts({ ...base }));
    expect(items?.find((i) => i.id === "expected-payment")?.status).toBe("current");
  });
  test("the true control (close) is current once the payment is on file", () => {
    const items = deriveStepChecklist(
      facts({ ...base, expectedPaymentRegistered: true, liveAction: { actionKey: "FinalizeDealAction" } })
    );
    expect(view(items).at(-1)).toBe("close-deal:current");
    expect(view(items).filter((s) => s.endsWith(":pending"))).toEqual([]);
  });
  test("a live reconciliation control is the current item -- never 'Close the deal'", () => {
    const items = deriveStepChecklist(
      facts({ ...base, expectedPaymentRegistered: true, liveAction: { actionKey: "ResolveReconciliationAction" } })
    );
    const byId = Object.fromEntries((items ?? []).map((i) => [i.id, i.status]));
    expect(byId["reconciliation-resolved"]).toBe("current");
    expect(byId["close-deal"]).toBe("pending");
  });
  test("a held deposit reported by the live control is a current gate", () => {
    const items = deriveStepChecklist(
      facts({
        ...base,
        expectedPaymentRegistered: true,
        liveAction: { actionKey: "FinalizeDealAction", unavailableReasonKey: "FinalizeNeedsHeldDepositResolved" },
      })
    );
    expect(items?.find((i) => i.id === "deposit-resolved")?.status).toBe("current");
    expect(items?.find((i) => i.id === "close-deal")?.status).toBe("pending");
  });
  test.each(["FinalizeCurrencyMismatch", "FinalizeCurrencyUnsupported"])("%s is a current gate", (reason) => {
    const items = deriveStepChecklist(
      facts({
        ...base,
        expectedPaymentRegistered: true,
        liveAction: { actionKey: "FinalizeDealAction", unavailableReasonKey: reason },
      })
    );
    expect(items?.find((i) => i.id === "currency-supported")?.status).toBe("current");
    expect(items?.find((i) => i.id === "close-deal")?.status).toBe("pending");
  });
  test("the route item appears only when the server says it is required, or already recorded", () => {
    const none = deriveStepChecklist(facts({ ...base, expectedPaymentRegistered: true, routeRequired: false }));
    expect(none?.some((i) => i.id === "route-recorded")).toBe(false);
    const required = deriveStepChecklist(
      facts({ ...base, expectedPaymentRegistered: true, routeRequired: true, routeRecorded: false })
    );
    expect(required?.find((i) => i.id === "route-recorded")?.status).toBe("current");
    const recorded = deriveStepChecklist(
      facts({ ...base, expectedPaymentRegistered: true, routeRequired: false, routeRecorded: true })
    );
    expect(recorded?.find((i) => i.id === "route-recorded")?.status).toBe("done");
  });
  test("done is never inferred: a stage with no blocker facts still asks for the payment", () => {
    const items = deriveStepChecklist(facts({ stageKey, stageState: "CURRENT" }));
    expect(items?.find((i) => i.id === "expected-payment")?.status).not.toBe("done");
  });
});

describe("ROUND 1 F2: an answered, empty readiness list keeps the cost items, not done", () => {
  const stageKey = "SETTLEMENT";
  const settle = (checks: Record<string, string> | undefined) =>
    deriveStepChecklist(
      facts({
        stageKey,
        stageState: "BLOCKED",
        expectedPaymentRegistered: true,
        readinessState: "NOT_READY",
        checks,
      })
    );
  test("{} (UNAVAILABLE with checks: []) keeps both cost items, not done", () => {
    const items = settle({});
    expect(items?.find((i) => i.id === "costs-recorded")?.status).toBe("current");
    expect(items?.find((i) => i.id === "costs-paid")?.status).toBe("pending");
  });
  test("control: READY is done", () => {
    const items = settle({ CONFIGURED_FEES_RECORDED: "READY", HANDOVER_COSTS_PAID: "READY" });
    expect(items?.find((i) => i.id === "costs-recorded")?.status).toBe("done");
    expect(items?.find((i) => i.id === "costs-paid")?.status).toBe("done");
  });
  test("control: NOT_APPLICABLE is still omitted", () => {
    const items = settle({ CONFIGURED_FEES_RECORDED: "NOT_APPLICABLE", HANDOVER_COSTS_PAID: "NOT_APPLICABLE" });
    expect(items?.some((i) => i.id === "costs-recorded" || i.id === "costs-paid")).toBe(false);
  });
  test("control: one key missing is not done", () => {
    const items = settle({ HANDOVER_COSTS_PAID: "READY" });
    expect(items?.find((i) => i.id === "costs-recorded")?.status).toBe("current");
  });
  test("control: a redacted / unavailable status is not done", () => {
    const items = settle({ CONFIGURED_FEES_RECORDED: "UNAVAILABLE", HANDOVER_COSTS_PAID: "BLOCKED" });
    expect(items?.find((i) => i.id === "costs-recorded")?.status).toBe("current");
    expect(items?.find((i) => i.id === "costs-paid")?.status).toBe("pending");
  });
  test("readiness not read at all (undefined): the cost items are not omitted either", () => {
    const items = settle(undefined);
    expect(items?.find((i) => i.id === "costs-recorded")?.status).toBe("current");
  });
});

describe("ROUND 1 F3: cash deals show no inferred ticks", () => {
  test("a live cash handover has no checklist (a single action is not a checklist)", () => {
    expect(
      deriveStepChecklist(
        facts({
          stageKey: "HANDOVER",
          stageState: "CURRENT",
          dealKind: "CASH",
          liveAction: { actionKey: "CompleteCashSaleAction" },
        })
      )
    ).toBeNull();
  });
  test("a cash handover with a deposit decision pending mirrors the cash step, no economics tick", () => {
    const items = deriveStepChecklist(
      facts({
        stageKey: "HANDOVER",
        stageState: "CURRENT",
        dealKind: "CASH",
        liveAction: {
          actionKey: "CompleteCashSaleAction",
          unavailableReasonKey: "CashSaleCompletionNeedsDepositDecision",
        },
      })
    );
    expect(view(items)).toEqual(["cash-deposit-decision:current", "complete-sale:pending"]);
    expect(items?.some((i) => i.id === "economics-ready")).toBe(false);
  });
  test("a cash settlement is never given the financed close chain", () => {
    expect(
      deriveStepChecklist(
        facts({ stageKey: "SETTLEMENT", stageState: "BLOCKED", dealKind: "CASH", expectedPaymentRegistered: false })
      )
    ).toBeNull();
  });
});

describe("ROUND 1 F5: the shortfall item points at the action that can settle it", () => {
  test("Shortfall settled goes to primaryAction", () => {
    const items = deriveStepChecklist(
      facts({ stageKey: "APPROVED_PURCHASE", stageState: "BLOCKED", blocker: "GapUnresolved" })
    );
    expect(items?.find((i) => i.id === "gap-settled")?.destination).toBe("primaryAction");
  });
});