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
  const ready = { CONFIGURED_FEES_RECORDED: "READY", HANDOVER_COSTS_PAID: "READY" };
  test("route missing: the route is current", () => {
    const items = deriveStepChecklist(
      facts({ stageKey, stageState: "BLOCKED", routeRecorded: false, readinessState: "NOT_READY", checks: ready })
    );
    expect(view(items)).toEqual([
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
        stageKey,
        stageState: "BLOCKED",
        blocker: "AwaitingSettlement",
        routeRecorded: true,
        readinessState: "NOT_READY",
        checks: { CONFIGURED_FEES_RECORDED: "READY", HANDOVER_COSTS_PAID: "BLOCKED" },
      })
    );
    expect(view(items)).toEqual([
      "route-recorded:done",
      "costs-recorded:done",
      "costs-paid:current",
      "closing-checks:pending",
      "close-deal:pending",
    ]);
    expect(items?.[2].destination).toBe("handoverCosts");
  });
  test("costs done, other checks not ready: the checks are current", () => {
    const items = deriveStepChecklist(
      facts({ stageKey, stageState: "BLOCKED", routeRecorded: true, readinessState: "NOT_READY", checks: ready })
    );
    expect(view(items)).toEqual([
      "route-recorded:done",
      "costs-recorded:done",
      "costs-paid:done",
      "closing-checks:current",
      "close-deal:pending",
    ]);
    expect(items?.find((i) => i.id === "closing-checks")?.destination).toBe("closing");
  });
  test("ready: close the deal is current", () => {
    const items = deriveStepChecklist(
      facts({ stageKey, stageState: "BLOCKED", routeRecorded: true, readinessState: "READY", checks: ready })
    );
    expect(view(items).at(-1)).toBe("close-deal:current");
    expect(view(items).filter((s) => s.endsWith(":pending"))).toEqual([]);
  });
  test("a not-applicable cost check is absent, not done", () => {
    const items = deriveStepChecklist(
      facts({
        stageKey,
        stageState: "BLOCKED",
        routeRecorded: true,
        readinessState: "NOT_READY",
        checks: { CONFIGURED_FEES_RECORDED: "NOT_APPLICABLE", HANDOVER_COSTS_PAID: "NOT_APPLICABLE" },
      })
    );
    expect(view(items)).toEqual(["route-recorded:done", "closing-checks:current", "close-deal:pending"]);
  });
  test("RISK: an expected check key that is absent renders not-done -- never omitted, never done", () => {
    const items = deriveStepChecklist(
      facts({
        stageKey,
        stageState: "BLOCKED",
        routeRecorded: true,
        readinessState: "NOT_READY",
        // both keys renamed by some future server change
        checks: { FEES_RECORDED_V2: "READY", COSTS_PAID_V2: "READY" },
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
        stageKey,
        stageState: "BLOCKED",
        routeRecorded: true,
        readinessState: "NOT_READY",
        checks: { CONFIGURED_FEES_RECORDED: "SOMETHING_NEW", HANDOVER_COSTS_PAID: "READY" },
      })
    );
    expect(items?.find((i) => i.id === "costs-recorded")?.status).toBe("current");
  });
  test("a caller who sees neither the route nor readiness gets no checklist", () => {
    expect(deriveStepChecklist(facts({ stageKey, stageState: "CURRENT" }))).toBeNull();
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
  // A stage the server reports CURRENT has no blocker -- "nothing is outstanding".
  // Whatever facts the cockpit holds, no fact-derived item may then be pending or
  // current: the step's own action is the only thing left.
  const stageKeys = ["APPROVED_PURCHASE", "DELIVERY_ACTIONS", "HANDOVER", "SETTLEMENT", "DISBURSEMENT"];
  const hostileFacts: Array<Partial<ChecklistFacts>> = [
    {},
    { documents: [{ required: true, status: "MISSING" }] },
    { checks: { CONFIGURED_FEES_RECORDED: "BLOCKED", HANDOVER_COSTS_PAID: "BLOCKED" }, readinessState: "NOT_READY" },
    { checks: {}, readinessState: "NOT_READY", routeRecorded: false },
    { stageStates: { HANDOVER: "CURRENT", SETTLEMENT: "PENDING" } },
  ];
  test.each(stageKeys)("%s with no blocker: nothing is pending, at most the action is current", (stageKey) => {
    for (const extra of hostileFacts) {
      const items = deriveStepChecklist(facts({ stageKey, stageState: "CURRENT", ...extra }));
      for (const item of items ?? []) {
        expect(item.status, `${stageKey} ${item.id}`).not.toBe("pending");
        if (item.status === "current") expect(item.destination).toBe("primaryAction");
      }
    }
  });
  test.each(stageKeys)("%s: at most one current item in any state", (stageKey) => {
    for (const stageState of ["CURRENT", "BLOCKED", "PENDING", "COMPLETE", "STOPPED"] as const) {
      for (const extra of hostileFacts) {
        const items = deriveStepChecklist(facts({ stageKey, stageState, ...extra })) ?? [];
        expect(items.filter((i) => i.status === "current").length).toBeLessThanOrEqual(1);
      }
    }
  });
});
