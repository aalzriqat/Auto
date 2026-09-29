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
  test("amount recorded: it is done and the shortfall is current", () => {
    const items = deriveStepChecklist(facts({ stageKey: "APPROVED_PURCHASE", stageState: "CURRENT" }));
    expect(view(items)).toEqual(["approved-amount:done", "gap-settled:current"]);
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
        stageState: "CURRENT",
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
  test("readiness unseen: no checklist", () => {
    expect(deriveStepChecklist(facts({ stageKey, stageState: "CURRENT" }))).toBeNull();
  });
  test("costs recorded, paid, then register", () => {
    const items = deriveStepChecklist(
      facts({
        stageKey,
        stageState: "CURRENT",
        checks: { CONFIGURED_FEES_RECORDED: "READY", HANDOVER_COSTS_PAID: "BLOCKED" },
      })
    );
    expect(view(items)).toEqual(["costs-recorded:done", "costs-paid:current", "register-handover:pending"]);
    expect(items?.[1].destination).toBe("handoverCosts");
    expect(items?.[2].destination).toBe("primaryAction");
  });
  test("all costs settled: register handover is current", () => {
    const items = deriveStepChecklist(
      facts({
        stageKey,
        stageState: "CURRENT",
        checks: { CONFIGURED_FEES_RECORDED: "READY", HANDOVER_COSTS_PAID: "READY" },
      })
    );
    expect(view(items)).toEqual(["costs-recorded:done", "costs-paid:done", "register-handover:current"]);
  });
  test("a not-applicable check is absent, not done; one item left is no checklist", () => {
    const items = deriveStepChecklist(
      facts({
        stageKey,
        stageState: "CURRENT",
        checks: { CONFIGURED_FEES_RECORDED: "NOT_APPLICABLE", HANDOVER_COSTS_PAID: "READY" },
      })
    );
    expect(view(items)).toEqual(["costs-paid:done", "register-handover:current"]);
    expect(
      deriveStepChecklist(
        facts({
          stageKey,
          stageState: "CURRENT",
          checks: { CONFIGURED_FEES_RECORDED: "NOT_APPLICABLE", HANDOVER_COSTS_PAID: "NOT_APPLICABLE" },
        })
      )
    ).toBeNull();
  });
  test("a pending handover previews everything as pending; a complete one as done", () => {
    const checks = { CONFIGURED_FEES_RECORDED: "READY", HANDOVER_COSTS_PAID: "READY" };
    expect(view(deriveStepChecklist(facts({ stageKey, stageState: "PENDING", checks })))).toEqual([
      "costs-recorded:pending",
      "costs-paid:pending",
      "register-handover:pending",
    ]);
    expect(view(deriveStepChecklist(facts({ stageKey, stageState: "COMPLETE", checks })))).toEqual([
      "costs-recorded:done",
      "costs-paid:done",
      "register-handover:done",
    ]);
  });
});

describe("SETTLEMENT", () => {
  const stageKey = "SETTLEMENT";
  test("route missing: the route is current", () => {
    const items = deriveStepChecklist(
      facts({ stageKey, stageState: "BLOCKED", routeRecorded: false, readinessState: "NOT_READY" })
    );
    expect(view(items)).toEqual(["route-recorded:current", "closing-checks:pending", "close-deal:pending"]);
  });
  test("route recorded, checks not ready: the checks are current", () => {
    const items = deriveStepChecklist(
      facts({ stageKey, stageState: "CURRENT", routeRecorded: true, readinessState: "NOT_READY" })
    );
    expect(view(items)).toEqual(["route-recorded:done", "closing-checks:current", "close-deal:pending"]);
    expect(items?.[1].destination).toBe("closing");
  });
  test("ready: close the deal is current", () => {
    const items = deriveStepChecklist(
      facts({ stageKey, stageState: "CURRENT", routeRecorded: true, readinessState: "READY" })
    );
    expect(view(items)).toEqual(["route-recorded:done", "closing-checks:done", "close-deal:current"]);
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
