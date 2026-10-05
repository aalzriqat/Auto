/**
 * SCRUM-691 / SCRUM-693 -- the Unwind deal entry point and dialog, through the deal cockpit container.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "JD",
    displayLabel: "Jordanian Dinar",
    format: (n: number) => `JD ${n}`,
    formatCompact: (n: number) => String(n),
    scale: 3,
  }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: () => 3,
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  /** The args each query was last mounted with, "skip" included. */
  queryArgs: new Map<string, unknown>(),
  permissions: new Set<string>(),
  membershipUserId: "user_manager",
  mutationCalls: new Map<string, unknown[]>(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: stubs.membershipUserId },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      // As the real hook: a skipped query returns undefined, so a read this
      // caller cannot make can never hand the screen data (round 2, W1).
      return args === "skip" ? undefined : stubs.queryResults.get(name);
    },
    // The closing-readiness read (SCRUM-414) goes through `useQueries`; a
    // skipped read is simply absent from the request, as with the real hook.
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          const name = getFunctionName(query);
          stubs.queryArgs.set(name, args);
          return [key, stubs.queryResults.get(name)];
        }),
      ),
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async (args: unknown) => {
        const calls = stubs.mutationCalls.get(name) ?? [];
        calls.push(args);
        stubs.mutationCalls.set(name, calls);
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


// Radix Select's popper needs layout jsdom lacks; the dialog's choice is what is under test.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const Ctx = React.createContext<(v: string) => void>(() => undefined);
  return {
    Select: ({ onValueChange, children }: { onValueChange: (v: string) => void; children: React.ReactNode }) => (
      <Ctx.Provider value={onValueChange}>{children}</Ctx.Provider>
    ),
    SelectTrigger: ({ id }: { id?: string }) => <button type="button" id={id} aria-label="UnwindDispositionLabel" />,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const pick = React.useContext(Ctx);
      return (
        <button type="button" role="option" aria-selected={false} onClick={() => pick(value)}>
          {children}
        </button>
      );
    },
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
import { DealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";

const { queryResults, permissions, mutationCalls } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;
const COCKPIT_QUERY = "dealWorkspace:financedDealCockpit";
const APP_QUERY = "applications:get";
const UNWIND_QUERY = "dealUnwind:unwindStatus";

function cockpit() {
  return {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: "CLOSED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: null,
    vehicle: null,
    salespersonName: "",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    forward: { applies: false, planV2: true, state: "NOT_DUE", mayCancelFinalized: true },
    stages: [{ key: "SETTLEMENT", state: "COMPLETE", authority: "DEALER" }],
    documents: [],
    timeline: [],
    money: null,
  };
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    _id: APP,
    quoteId: "quote_1",
    status: "CLOSED",
    salespersonId: "user_sales",
    companyId: "company_1",
    economicsCurrency: "JOD",
    quote: { totalFinancedAmount: 15000 },
    vehicle: { sourceType: "OWNED" },
    deposits: [],
    hasExternalFinancier: true,
    canSettleDirectToSupplier: false,
    directRouteRefusal: null,
    disbursedAt: Date.UTC(2026, 7, 10),
    ...overrides,
  };
}

const NO_UNWIND = {
  unwindId: null,
  status: null,
  step: null,
  startedAt: null,
  eligibility: { canStart: true, canForwardReturn: false, canFinish: false, canAbandon: false },
  refusals: {},
  evidence: null,
};

const ACTIVE = (step: "AWAITING_FORWARD_RETURN" | "AWAITING_FINISH", method: "BANK_TRANSFER" | "CASH" = "BANK_TRANSFER") => ({
  unwindId: "unwind_1",
  status: "ACTIVE",
  step,
  startedAt: Date.UTC(2026, 9, 5),
  eligibility: {
    canStart: false,
    canForwardReturn: step === "AWAITING_FORWARD_RETURN",
    canFinish: step === "AWAITING_FINISH",
    canAbandon: true,
  },
  refusals: {},
  evidence: {
    reason: "Customer withdrew",
    remittanceMinor: 12_000_000,
    remittanceMethod: method,
    forwardDueMinor: step === "AWAITING_FORWARD_RETURN" ? 11_000_000 : 0,
    forwardReturn: null,
    remittanceRefund: null,
    completion: null,
    abandonment: null,
  },
});

function render_(unwind: unknown, app: Record<string, unknown> = {}) {
  queryResults.set(COCKPIT_QUERY, cockpit());
  queryResults.set(APP_QUERY, application(app));
  if (unwind !== undefined) queryResults.set(UNWIND_QUERY, unwind);
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

beforeEach(() => {
  permissions.add(PERMISSIONS.CANCEL_CLOSED_DEAL);
});

afterEach(() => {
  cleanup();
  queryResults.clear();
  stubs.queryArgs.clear();
  permissions.clear();
  mutationCalls.clear();
});

describe("SCRUM-691 / 693 -- Unwind deal replaces Cancel on a paid deal", () => {
  test("a paid deal the server lets the caller unwind offers Unwind deal and no Cancel", () => {
    render_(NO_UNWIND);
    expect(screen.getByTestId("deal-unwind-deal").textContent).toContain("UnwindDealAction");
    expect(screen.queryByTestId("deal-cancel-application")).toBeNull();
    expect(screen.getByTestId("deal-unwind-banner").textContent).toBe("UnwindPaidDealBanner");
  });

  test("CONTROL -- a closed deal that was never paid keeps Cancel and gets no Unwind", () => {
    render_(
      { ...NO_UNWIND, eligibility: { ...NO_UNWIND.eligibility, canStart: false }, refusals: { start: { code: "DEAL_UNWIND_NOT_ELIGIBLE", message: "x" } } },
      { disbursedAt: undefined }
    );
    expect(screen.getByTestId("deal-cancel-application")).toBeTruthy();
    expect(screen.queryByTestId("deal-unwind-deal")).toBeNull();
    expect(screen.queryByTestId("deal-unwind-hint")).toBeNull();
  });

  test("a paid deal the server will not let the caller unwind is explained, never a blank or a Cancel", () => {
    render_({
      ...NO_UNWIND,
      eligibility: { ...NO_UNWIND.eligibility, canStart: false },
      refusals: { start: { code: "DEAL_UNWIND_COMMISSION_PAID", message: "commission paid" } },
    });
    expect(screen.queryByTestId("deal-unwind-deal")).toBeNull();
    expect(screen.queryByTestId("deal-cancel-application")).toBeNull();
    expect(screen.getByTestId("deal-unwind-hint").textContent).toBe("commission paid");
  });

  test("the unwind read is skipped for a deal that is not closed", () => {
    queryResults.set(COCKPIT_QUERY, { ...cockpit(), status: "APPROVED" });
    queryResults.set(APP_QUERY, application({ status: "APPROVED", disbursedAt: undefined }));
    render(<DealCockpit orgId={ORG} applicationId={APP} />);
    expect(stubs.queryArgs.get(UNWIND_QUERY)).toBe("skip");
    expect(screen.queryByTestId("deal-unwind-deal")).toBeNull();
  });

  test("starting records the reason with a command key", async () => {
    render_(NO_UNWIND);
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    const start = screen.getByTestId("deal-unwind-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("UnwindReasonLabel"), { target: { value: "  Customer withdrew  " } });
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(mutationCalls.get("dealUnwind:startDealUnwind")).toHaveLength(1));
    const call = mutationCalls.get("dealUnwind:startDealUnwind")![0] as Record<string, unknown>;
    expect(call).toMatchObject({ orgId: ORG, applicationId: APP, reason: "Customer withdrew" });
    expect(String(call.idempotencyKey)).toMatch(/^unwind-start:/);
  });

  test("a live unwind resumes at the forward-return step, with the three-step stepper", () => {
    render_(ACTIVE("AWAITING_FORWARD_RETURN"));
    expect(screen.getByTestId("deal-unwind-deal").textContent).toContain("UnwindDealResume");
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    const steps = within(screen.getByTestId("deal-unwind-steps")).getAllByRole("listitem");
    expect(steps.map((s) => s.getAttribute("data-state"))).toEqual(["done", "current", "todo"]);
    expect(screen.getByTestId("deal-unwind-forward-due")).toBeTruthy();
    const submit = screen.getByTestId("deal-unwind-forward-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("UnwindForwardReferenceLabel"), { target: { value: "FC-RET-9" } });
    expect(submit.disabled).toBe(false);
  });

  test("the forward step is not offered a click the server has refused, and says why", () => {
    const status = ACTIVE("AWAITING_FORWARD_RETURN");
    render_({
      ...status,
      eligibility: { ...status.eligibility, canForwardReturn: false },
      refusals: { forwardReturn: { code: "DEAL_UNWIND_FORWARD_UNSETTLED", message: "unsettled" } },
    });
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    fireEvent.change(screen.getByLabelText("UnwindForwardReferenceLabel"), { target: { value: "R" } });
    expect((screen.getByTestId("deal-unwind-forward-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("deal-unwind-forward-refusal").textContent).toBe("unsettled");
  });

  test("the refund step takes a bank reference for a transfer and finishes with every field", async () => {
    const startedAt = Date.now();
    render_(ACTIVE("AWAITING_FINISH", "BANK_TRANSFER"));
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    expect(screen.queryByLabelText("UnwindVoucherLabel")).toBeNull();
    // The server caps references at 200 characters; the form must not accept more.
    expect((screen.getByLabelText("UnwindBankReferenceLabel") as HTMLInputElement).maxLength).toBe(200);
    expect((screen.getByLabelText("UnwindCreditNoteLabel") as HTMLInputElement).maxLength).toBe(200);
    const finish = screen.getByTestId("deal-unwind-finish-submit") as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("UnwindBankReferenceLabel"), { target: { value: "TRX-1" } });
    fireEvent.change(screen.getByLabelText("UnwindCreditNoteLabel"), { target: { value: "CN-7" } });
    fireEvent.change(screen.getByLabelText("UnwindVehicleNoteLabel"), { target: { value: "Scratch on door" } });
    expect(finish.disabled).toBe(true); // no disposition chosen yet
    fireEvent.click(await screen.findByRole("option", { name: "UnwindDispositionRefund" }));
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);
    await waitFor(() => expect(mutationCalls.get("dealUnwind:finishDealUnwind")).toHaveLength(1));
    const call = mutationCalls.get("dealUnwind:finishDealUnwind")![0] as Record<string, unknown>;
    expect(call).toMatchObject({
      unwindId: "unwind_1",
      method: "BANK_TRANSFER",
      bankReference: "TRX-1",
      creditNoteReference: "CN-7",
      vehicleReturnNote: "Scratch on door",
      customerPaymentDisposition: "REFUND",
    });
    expect(call).not.toHaveProperty("voucherNumber");
    // Same-day refund: dated "now", never midnight, which predates the payment confirmed earlier today and is refused.
    expect(call.refundedAt as number).toBeGreaterThanOrEqual(startedAt);
  });

  test("a refund dated the day the finance company paid is never before that payment (server refuses it)", async () => {
    const paidAt = Date.UTC(2026, 9, 3, 14, 0, 0);
    render_(ACTIVE("AWAITING_FINISH", "BANK_TRANSFER"), { disbursedAt: paidAt });
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    fireEvent.change(screen.getByLabelText("UnwindRefundDateLabel"), { target: { value: "2026-10-03" } });
    fireEvent.change(screen.getByLabelText("UnwindBankReferenceLabel"), { target: { value: "TRX-1" } });
    fireEvent.change(screen.getByLabelText("UnwindCreditNoteLabel"), { target: { value: "CN-7" } });
    fireEvent.change(screen.getByLabelText("UnwindVehicleNoteLabel"), { target: { value: "ok" } });
    fireEvent.click(await screen.findByRole("option", { name: "UnwindDispositionRefund" }));
    fireEvent.click(screen.getByTestId("deal-unwind-finish-submit"));
    await waitFor(() => expect(mutationCalls.get("dealUnwind:finishDealUnwind")).toHaveLength(1));
    const call = mutationCalls.get("dealUnwind:finishDealUnwind")![0] as Record<string, unknown>;
    // Midnight of that day (2026-10-03T00:00Z) predates the 14:00Z payment.
    expect(call.refundedAt).toBe(paidAt);
  });

  test("a refund date before the finance company paid is not offered and cannot be submitted (server refuses it)", async () => {
    render_(ACTIVE("AWAITING_FINISH", "BANK_TRANSFER"), { disbursedAt: Date.UTC(2026, 9, 3, 14, 0, 0) });
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    const date = screen.getByLabelText("UnwindRefundDateLabel") as HTMLInputElement;
    expect(date.min).toBe("2026-10-03");
    fireEvent.change(date, { target: { value: "2026-10-02" } });
    fireEvent.change(screen.getByLabelText("UnwindBankReferenceLabel"), { target: { value: "TRX-1" } });
    fireEvent.change(screen.getByLabelText("UnwindCreditNoteLabel"), { target: { value: "CN-7" } });
    fireEvent.change(screen.getByLabelText("UnwindVehicleNoteLabel"), { target: { value: "ok" } });
    fireEvent.click(await screen.findByRole("option", { name: "UnwindDispositionRefund" }));
    const finish = screen.getByTestId("deal-unwind-finish-submit") as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.submit(document.getElementById("deal-unwind-finish-form")!);
    expect(mutationCalls.get("dealUnwind:finishDealUnwind") ?? []).toHaveLength(0);
  });

  test("a deal the finance company paid the supplier on is not offered Cancel, which the server refuses", () => {
    render_(
      { ...NO_UNWIND, eligibility: { ...NO_UNWIND.eligibility, canStart: false }, refusals: { start: { code: "DEAL_UNWIND_NOT_ELIGIBLE", message: "x" } } },
      { disbursedAt: undefined, supplierDisbursementStatus: "CONFIRMED" }
    );
    expect(screen.queryByTestId("deal-cancel-application")).toBeNull();
  });

  test("a viewer who can act on none of an active unwind still sees that it is in progress, with no button", () => {
    render_({
      ...ACTIVE("AWAITING_FINISH"),
      eligibility: { canStart: false, canForwardReturn: false, canFinish: false, canAbandon: false },
      evidence: null,
    });
    expect(screen.queryByTestId("deal-unwind-deal")).toBeNull();
    expect(screen.getByTestId("deal-unwind-banner").textContent).toBe("UnwindInProgressBadge");
  });

  test("a cash remittance is refunded as cash: voucher and acknowledgement, no bank reference", () => {
    render_(ACTIVE("AWAITING_FINISH", "CASH"));
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    expect(screen.getByLabelText("UnwindVoucherLabel")).toBeTruthy();
    expect(screen.getByLabelText("UnwindAcknowledgedLabel")).toBeTruthy();
    expect(screen.queryByLabelText("UnwindBankReferenceLabel")).toBeNull();
  });

  test("a finish the server has refused stays disabled even with every field filled", () => {
    const status = ACTIVE("AWAITING_FINISH");
    render_({
      ...status,
      eligibility: { ...status.eligibility, canFinish: false },
      refusals: { finish: { code: "DEAL_UNWIND_PERIOD_NOT_OPEN", message: "period closed" } },
    });
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    expect((screen.getByTestId("deal-unwind-finish-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("deal-unwind-finish-refusal").textContent).toBe("period closed");
  });

  test("an authorised manager can abandon a live unwind; a caller without that authority sees no control", async () => {
    render_(ACTIVE("AWAITING_FINISH"));
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    fireEvent.click(screen.getByTestId("deal-unwind-abandon"));
    const confirm = screen.getByTestId("deal-unwind-abandon-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("UnwindReasonLabel"), { target: { value: "Started on the wrong deal" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(mutationCalls.get("dealUnwind:abandonDealUnwind")).toHaveLength(1));
    cleanup();
    const status = ACTIVE("AWAITING_FINISH");
    render_({ ...status, eligibility: { ...status.eligibility, canAbandon: false } });
    fireEvent.click(screen.getByTestId("deal-unwind-deal"));
    expect(screen.queryByTestId("deal-unwind-abandon")).toBeNull();
  });
});