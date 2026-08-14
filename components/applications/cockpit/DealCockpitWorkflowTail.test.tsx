/**
 * The workflow TAIL on the cockpit — handover, expected payment, close.
 *
 * SCRUM-78: the stage rail named `تسليم المركبة` as the next step and the screen
 * contained nothing that performed it. All three tail actions lived only in
 * `Finance Applications → row → Review`, a screen the rail never mentions, which
 * is also why the financed E2E stayed green while the cockpit could not take a
 * single one of them.
 *
 * These are CONTAINER tests, not view tests. `FinanceCompanyDecision.test.tsx`
 * hands `DealCockpitView` a `workflowAction` fixture, so it proves what the
 * next-step block does with an answer and nothing about how the answer is
 * chosen — and the choosing is where this issue's defects live: which of three
 * separate permissions gates which step, which step is offered when, and whether
 * a retried close is the same close.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  // Identity `t`, so a missing translation surfaces as its key rather than
  // silently rendering something plausible.
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "JD",
    displayLabel: "Jordanian Dinar",
    format: (n: number) => `JD ${n}`,
    scale: 3,
  }),
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  permissions: new Set<string>(),
  /** Every mutation call this render made: name → the list of args it got. */
  mutationCalls: new Map<string, unknown[]>(),
  /** Names whose next call should reject, and with what. */
  mutationFailures: new Map<string, string>(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: "user_sales" },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async (args: unknown) => {
        const calls = stubs.mutationCalls.get(name) ?? [];
        calls.push(args);
        stubs.mutationCalls.set(name, calls);
        const failure = stubs.mutationFailures.get(name);
        if (failure !== undefined) {
          stubs.mutationFailures.delete(name);
          throw new Error(failure);
        }
        return null;
      };
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";

const { queryResults, permissions, mutationCalls, mutationFailures } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;

const COCKPIT_QUERY = "applications:dealCockpit";
const HANDOVER_MUTATION = "applications:registerVehicleHandover";
const EXPECTED_PAYMENT_MUTATION = "applications:registerExpectedPayment";
const FINALIZE_MUTATION = "applications:finalizeDeal";

/**
 * The rail as the server draws it at each point in the tail.
 *
 * Written as the real five-state shape rather than a two-state stand-in: the
 * step after handover is a BLOCKED settlement stage, and an action attached to a
 * stage the rail reports as merely PENDING would never render.
 */
function stages(point: "AWAITING_HANDOVER" | "AFTER_HANDOVER") {
  return point === "AWAITING_HANDOVER"
    ? [
        { key: "APPROVED_PURCHASE", state: "COMPLETE" },
        { key: "DELIVERY_ACTIONS", state: "COMPLETE" },
        { key: "HANDOVER", state: "CURRENT" },
        { key: "SETTLEMENT", state: "PENDING" },
      ]
    : [
        { key: "APPROVED_PURCHASE", state: "COMPLETE" },
        { key: "DELIVERY_ACTIONS", state: "COMPLETE" },
        { key: "HANDOVER", state: "COMPLETE" },
        { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement" },
      ];
}

function cockpit(overrides: Record<string, unknown> = {}) {
  return {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1", name: "سامر الخطيب", phone: "0790112233" },
    vehicle: {
      id: "v1",
      label: "Volkswagen e-Golf 2020",
      vin: "WVWZZZAUZLW901234",
      consigned: false,
      supplierName: "",
    },
    salespersonName: "ليث العمري",
    financeCompanyName: "شركة التمويل الوطني",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    stages: stages("AWAITING_HANDOVER"),
    documents: [],
    timeline: [],
    money: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  permissions.clear();
  mutationCalls.clear();
  mutationFailures.clear();
});

function renderCockpit() {
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

/**
 * The next-step block, scoped.
 *
 * Every stage name appears twice on this screen — once on the rail, once in the
 * block that names the current step — so a global `getByText("StageHandover")`
 * either throws on the duplicate or, worse, passes against the rail row while
 * the block that is supposed to carry the action says nothing.
 */
function nextStepBlock(): HTMLElement {
  return screen.getByTestId("deal-next-step");
}

/** The whole tail, so a case can subtract exactly the one it is testing. */
function grantTheWholeTail() {
  permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
  permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
  permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
}

describe("the step the rail names is a step this screen can take", () => {
  test("handover is offered on the stage the rail is naming", () => {
    grantTheWholeTail();
    queryResults.set(COCKPIT_QUERY, cockpit());

    renderCockpit();

    // The defect verbatim: the block said HANDOVER and offered nothing. Both
    // halves are asserted on the SAME block, because "the rail names it" and
    // "the screen can do it" being true of different elements is exactly the
    // state the owner hit.
    const block = nextStepBlock();
    expect(within(block).getByText("StageHandover")).toBeTruthy();
    expect(within(block).getByRole("button", { name: "RegisterHandoverAction" })).toBeTruthy();
  });

  test("the expected payment is offered once the vehicle has gone out", () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: false })
    );

    renderCockpit();

    expect(screen.getByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeTruthy();
    // Not both at once: the server refuses a close with no expected payment, so
    // offering it here would be offering a guaranteed refusal.
    expect(screen.queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
  });

  test("closing is offered only once the payment fact the server demands is on file", () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );

    renderCockpit();

    expect(screen.getByRole("button", { name: "FinalizeDealAction" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeNull();
  });

  test("nothing in the tail is offered on a deal that is already closed", () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        status: "CLOSED",
        stages: stages("AFTER_HANDOVER"),
        expectedPaymentRegistered: true,
      })
    );

    renderCockpit();

    // `finalizeDeal` answers a closed deal by returning the sale it already
    // made. A button for that is an invitation to wonder whether it worked.
    expect(screen.queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
    expect(screen.queryByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeNull();
  });
});

describe("a step the server would refuse is not offered as a step", () => {
  test("the close is withheld while the settlement route is outstanding, and says so", () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        stages: stages("AFTER_HANDOVER"),
        expectedPaymentRegistered: true,
        // A consigned car with an external financier and no route recorded —
        // the ordinary shape of a consigned financed deal. `finalizeDeal` is
        // certain to reject it, and the operator only gets here AFTER handover
        // has sealed the approved amount.
        supplierSettlementRouteRequired: true,
      })
    );

    renderCockpit();

    const block = nextStepBlock();
    expect(within(block).queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
    // The prerequisite, not the permission: this caller holds every permission
    // in the tail and still cannot close, so naming the permission would be
    // true and useless.
    expect(within(block).getByText("FinalizeNeedsSettlementRoute")).toBeTruthy();
    expect(within(block).queryByText("FinalizeNeedsPermission")).toBeNull();
  });

  test("the route prerequisite outranks the permission gap, because neither can close it", () => {
    // No FINALIZE_FINANCED_DEAL, and the route is missing too. The deal is not
    // closeable by anyone yet, so the reason given is the one that is about the
    // deal rather than about the caller.
    permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        stages: stages("AFTER_HANDOVER"),
        expectedPaymentRegistered: true,
        supplierSettlementRouteRequired: true,
      })
    );

    renderCockpit();

    expect(within(nextStepBlock()).getByText("FinalizeNeedsSettlementRoute")).toBeTruthy();
  });
});

describe("three permissions, not one", () => {
  test("a caller who may hand over but not register the payment is told, at each step", () => {
    // Exactly one of the three. Gating the tail on a single flag would either
    // hide the step this caller is entitled to take or offer the two they are
    // not.
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    queryResults.set(COCKPIT_QUERY, cockpit());

    const { unmount } = renderCockpit();
    expect(screen.getByRole("button", { name: "RegisterHandoverAction" })).toBeTruthy();
    unmount();

    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: false })
    );
    renderCockpit();

    expect(screen.queryByRole("button", { name: "RegisterExpectedPaymentAction" })).toBeNull();
    // Silence here is the dead end this issue exists to remove.
    expect(within(nextStepBlock()).getByText("ExpectedPaymentNeedsPermission")).toBeTruthy();
  });

  test("a caller who may register the payment but not close is told why closing is missing", () => {
    permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );

    renderCockpit();

    expect(screen.queryByRole("button", { name: "FinalizeDealAction" })).toBeNull();
    expect(within(nextStepBlock()).getByText("FinalizeNeedsPermission")).toBeTruthy();
  });
});

describe("the mutations behind the buttons", () => {
  test("handover goes through the existing mutation, with no second write path", async () => {
    grantTheWholeTail();
    queryResults.set(COCKPIT_QUERY, cockpit());

    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "RegisterHandoverAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /ConfirmHandoverAction/ }));

    await waitFor(() => {
      expect(mutationCalls.get(HANDOVER_MUTATION)).toEqual([
        { orgId: ORG, applicationId: APP, notes: undefined },
      ]);
    });
  });

  test("the expected payment carries the method and the date the form collected", async () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: false })
    );

    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "RegisterExpectedPaymentAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Confirm$/ }));

    await waitFor(() => {
      const calls = mutationCalls.get(EXPECTED_PAYMENT_MUTATION) ?? [];
      expect(calls).toHaveLength(1);
    });
    const [call] = mutationCalls.get(EXPECTED_PAYMENT_MUTATION) as Array<Record<string, unknown>>;
    expect(call.orgId).toBe(ORG);
    expect(call.applicationId).toBe(APP);
    // The form's own default. Asserted so a change to it is a decision rather
    // than a surprise arriving at a mutation that writes a cheque record.
    expect(call.method).toBe("BANK_TRANSFER");
    expect(typeof call.expectedDate).toBe("number");
  });

  test("a retried close is the SAME close — one idempotency key, reused", async () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );
    // The first attempt is refused the way the server refuses a real one: with
    // a message naming what to change. The operator fixes nothing and simply
    // tries again — the case a fresh key per click turns into two sales.
    mutationFailures.set(FINALIZE_MUTATION, "Record the settlement route before finalizing.");

    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "FinalizeDealAction" }));

    const confirm = await screen.findByRole("button", { name: /ConfirmFinalizeAction/ });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect((mutationCalls.get(FINALIZE_MUTATION) ?? []).length).toBe(1);
    });
    // The refusal is kept on the dialog, not only in a toast that has gone by
    // the time the operator looks back.
    expect(await screen.findByText(/Record the settlement route/)).toBeTruthy();

    fireEvent.click(confirm);
    await waitFor(() => {
      expect((mutationCalls.get(FINALIZE_MUTATION) ?? []).length).toBe(2);
    });

    const calls = mutationCalls.get(FINALIZE_MUTATION) as Array<Record<string, unknown>>;
    expect(calls[0].idempotencyKey).toBeTruthy();
    // A second sale, a second set of journals and a second inventory movement
    // for one car is what a fresh key on retry buys.
    expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
  });

  test("a close that succeeded does not lend its key to the next one", async () => {
    grantTheWholeTail();
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ stages: stages("AFTER_HANDOVER"), expectedPaymentRegistered: true })
    );

    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "FinalizeDealAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /ConfirmFinalizeAction/ }));
    await waitFor(() => {
      expect((mutationCalls.get(FINALIZE_MUTATION) ?? []).length).toBe(1);
    });

    // Reopened and run again — a different operation, which must not be
    // answered out of the first one's idempotency record.
    fireEvent.click(screen.getByRole("button", { name: "FinalizeDealAction" }));
    fireEvent.click(await screen.findByRole("button", { name: /ConfirmFinalizeAction/ }));
    await waitFor(() => {
      expect((mutationCalls.get(FINALIZE_MUTATION) ?? []).length).toBe(2);
    });

    const calls = mutationCalls.get(FINALIZE_MUTATION) as Array<Record<string, unknown>>;
    expect(calls[1].idempotencyKey).not.toBe(calls[0].idempotencyKey);
  });
});
