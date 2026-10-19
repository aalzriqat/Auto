/**
 * SCRUM-724: every step of the customer-credit refund lifecycle (request ->
 * approve -> pay out) must be reachable by an actor holding exactly the backend
 * permission that step needs, under the DEFAULT role templates: ACCOUNTANT has
 * MANAGE_FINANCE but not APPROVE_REQUESTS; MANAGER has APPROVE_REQUESTS but not
 * MANAGE_FINANCE.
 *
 * The section is rendered directly here; CollectionsTabRetainedCreditRefunds.test.tsx
 * covers it as mounted on the Collections Approvals tab.
 */
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const value = stubs.queryResults.get(getFunctionName(reference));
      return typeof value === "function" ? (value as (a: unknown) => unknown)(args) : value;
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      if (!stubs.mutations.has(name)) stubs.mutations.set(name, vi.fn().mockResolvedValue(null));
      return stubs.mutations.get(name)!;
    },
  };
});

import { RetainedCreditRefundsSection } from "./RetainedCreditRefundsSection";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

type Actor = { canApprove: boolean; canManage: boolean };
const ACCOUNTANT: Actor = { canApprove: false, canManage: true };
const MANAGER: Actor = { canApprove: true, canManage: false };
const BOTH: Actor = { canApprove: true, canManage: true };

const refundRow = (over: Record<string, unknown>) => ({
  _id: "r1", orgId: "org1", amountMinor: 1200, currency: "JOD", customerName: "Layla Haddad",
  sourceChequeLabel: "Arab Bank #004512", originatingSaleStatus: "CANCELLED",
  requestedByMe: false, ...over,
});

function seedRefunds(rows: Array<Record<string, unknown>>) {
  stubs.queryResults.set("retainedCreditRefunds:listRetainedCreditRefundRequests",
    (args: { status?: string }) => rows.filter((row) => row.status === args.status));
}

function renderSection(actor: Actor, payoutAvailable?: boolean) {
  render(<RetainedCreditRefundsSection orgId={"org1" as never} payoutAvailable={payoutAvailable} {...actor} />);
}

afterEach(() => {
  cleanup();
  stubs.queryResults.clear();
  stubs.mutations.clear();
});

describe("Retained-credit refund queue, lifecycle reachable under default roles", () => {
  test("ACCOUNTANT-like (MANAGE_FINANCE, no APPROVE_REQUESTS) sees the APPROVED request and the payout action, no approve/reject", () => {
    seedRefunds([refundRow({ status: "APPROVED" }), refundRow({ _id: "r2", status: "PENDING" })]);
    renderSection(ACCOUNTANT, true);
    expect(screen.getByRole("button", { name: "RetainedCreditExecute" })).toBeTruthy();
    expect(screen.getByLabelText("RetainedCreditPayoutReference")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  test("two approved refunds offer banks in each request's currency", async () => {
    seedRefunds([
      refundRow({ _id: "usd", status: "APPROVED", method: "BANK_TRANSFER", currency: "USD" }),
      refundRow({ _id: "jod", status: "APPROVED", method: "BANK_TRANSFER", currency: "JOD" }),
    ]);
    const requestedCurrencies: string[] = [];
    stubs.queryResults.set("collections:listReceiptBankOptions", (args: { currency: string }) => {
      requestedCurrencies.push(args.currency);
      return { banks: [{ _id: `bank-${args.currency}`, name: `${args.currency} bank`, currency: args.currency }],
        truncated: false };
    });
    renderSection(ACCOUNTANT, true);
    expect(requestedCurrencies).toContain("USD");
    expect(requestedCurrencies).toContain("JOD");
    const bankPickers = screen.getAllByRole("combobox", { name: "ReceiptBankAccount" });
    fireEvent.pointerDown(bankPickers[0], { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(await screen.findByRole("option", { name: /USD bank/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /JOD bank/ })).toBeNull();
  });

  test("MANAGER-like (APPROVE_REQUESTS, no MANAGE_FINANCE) can approve and reject a PENDING request but cannot pay out", () => {
    seedRefunds([refundRow({ status: "PENDING" }), refundRow({ _id: "r2", status: "APPROVED" })]);
    renderSection(MANAGER, true);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "RetainedCreditExecute" })).toBeNull();
  });

  test("a requester never sees approve/reject on their own request, even holding APPROVE_REQUESTS", () => {
    seedRefunds([refundRow({ status: "PENDING", requestedByMe: true })]);
    renderSection(BOTH, true);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });
});

describe("SCRUM-724 pilot containment: payout actions disabled, exits stay", () => {
  test.each([false, undefined] as const)(
    "payout unavailable (%s): approve and record-payout shown disabled and tied to the reason; reject and cancel stay",
    (availability) => {
      seedRefunds([refundRow({ status: "PENDING" }), refundRow({ _id: "r2", status: "APPROVED" })]);
      renderSection(BOTH, availability);
      const reason = screen.getByTestId("retained-credit-payout-unavailable");
      expect(reason.textContent).toBe("RetainedCreditPayoutUnavailable");
      for (const name of ["Approve", "RetainedCreditExecute"]) {
        const control = screen.getByRole("button", { name }) as HTMLButtonElement;
        expect(control.disabled).toBe(true);
        expect(control.getAttribute("aria-describedby")).toBe(reason.id);
        fireEvent.click(control);
      }
      expect((screen.getByLabelText("RetainedCreditPayoutReference") as HTMLInputElement).disabled).toBe(true);
      expect(stubs.mutations.get("retainedCreditRefunds:respondToRetainedCreditRefund")).not.toHaveBeenCalled();
      expect(stubs.mutations.get("retainedCreditRefunds:executeRetainedCreditRefund")).not.toHaveBeenCalled();
      expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "RetainedCreditRefundCancel" })).toHaveLength(2);
    });

  test("cancel needs a reason, then calls the cancel mutation with it (APPROVED and the requester's own PENDING)", async () => {
    seedRefunds([refundRow({ status: "APPROVED" }), refundRow({ _id: "r2", status: "PENDING", requestedByMe: true })]);
    renderSection(ACCOUNTANT, false);
    const buttons = screen.getAllByRole("button", { name: "RetainedCreditRefundCancel" }) as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    const inputs = screen.getAllByLabelText("RetainedCreditCancelReason");
    fireEvent.change(inputs[0], { target: { value: "  customer kept the credit  " } });
    expect((screen.getAllByRole("button", { name: "RetainedCreditRefundCancel" })[0] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "RetainedCreditRefundCancel" })[0]);
    await vi.waitFor(() => {
      expect(stubs.mutations.get("retainedCreditRefunds:cancelRetainedCreditRefund")).toHaveBeenCalledWith(
        // Rows list PENDING first, so the first control is the requester's own r2.
        { orgId: "org1", requestId: "r2", reason: "customer kept the credit" });
    });
  });

  test("a view-only approver (no MANAGE_FINANCE) gets no cancel control", () => {
    seedRefunds([refundRow({ status: "PENDING" })]);
    renderSection(MANAGER, false);
    expect(screen.queryByRole("button", { name: "RetainedCreditRefundCancel" })).toBeNull();
  });
});
