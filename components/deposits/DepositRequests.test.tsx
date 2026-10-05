/**
 * SCRUM-444. The two places a deposit request is shown.
 *
 *  - the manager / accountant queue: confirming needs a method (no default) and
 *    rejecting needs a reason, and the query is not even asked of anyone who
 *    lacks the authority (a refused query throws into render);
 *  - the salesperson's view on the quote: the request reads as awaiting
 *    confirmation, offers WITHDRAW on their own request, and never offers
 *    confirm or reject.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";

const stubs = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  queryArgs: new Map<string, unknown>(),
  queryResults: new Map<string, unknown>(),
  permissions: [] as string[],
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.includes(permission),
  }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      return args === "skip" ? undefined : stubs.queryResults.get(name);
    },
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      stubs.calls.push({ name: getFunctionName(reference), args });
    },
  };
});
vi.mock("@/components/payments/PaymentMethodSelect", () => ({
  PaymentMethodSelect: ({
    value,
    onValueChange,
    ariaLabel,
  }: {
    value: string | undefined;
    onValueChange: (method: string) => void;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      data-testid="method-select"
      value={value ?? ""}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="" />
      <option value="CASH">CASH</option>
    </select>
  ),
}));

import { PendingDepositRequestsQueue, QuoteDepositRequests } from "./DepositRequests";

const ORG = "org1" as Id<"organizations">;
const QUOTE = "quote1" as Id<"quotes">;
const CONFIRM = "confirm:finance_disbursement";

const pendingRow = {
  _id: "req1",
  quoteId: "quote1",
  amount: 1500,
  currency: "JOD",
  note: null,
  requestedAt: 1,
  requestedByName: "Sam",
  customerName: "Dana Doe",
  vehicleLabel: "2022 Toyota Camry",
};

beforeEach(() => {
  stubs.calls.length = 0;
  stubs.queryArgs.clear();
  stubs.queryResults.clear();
  stubs.permissions = [];
});
afterEach(cleanup);

describe("PendingDepositRequestsQueue", () => {
  test("is not asked of a caller without the authority", () => {
    stubs.queryResults.set("depositRequests:listPending", [pendingRow]);
    render(<PendingDepositRequestsQueue orgId={ORG} />);
    expect(stubs.queryArgs.get("depositRequests:listPending")).toBe("skip");
    expect(screen.queryByTestId("pending-deposit-requests")).toBeNull();
  });

  test("confirming needs a method, and posts the request's own amount", async () => {
    stubs.permissions = [CONFIRM];
    stubs.queryResults.set("depositRequests:listPending", [pendingRow]);
    render(<PendingDepositRequestsQueue orgId={ORG} />);

    fireEvent.click(screen.getByTestId("deposit-request-confirm-open"));
    const submit = screen.getByTestId("deposit-request-confirm-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText("DepositMethodRequired")).toBeTruthy();

    fireEvent.change(screen.getByTestId("method-select"), { target: { value: "CASH" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(stubs.calls).toHaveLength(1));
    expect(stubs.calls[0].name).toBe("depositRequests:confirm");
    expect(stubs.calls[0].args).toMatchObject({
      orgId: ORG,
      requestId: "req1",
      amount: 1500,
      method: "CASH",
    });
    expect(stubs.calls[0].args.idempotencyKey).toEqual(expect.any(String));
  });

  test("rejecting needs a reason", async () => {
    stubs.permissions = [CONFIRM];
    stubs.queryResults.set("depositRequests:listPending", [pendingRow]);
    render(<PendingDepositRequestsQueue orgId={ORG} />);

    fireEvent.click(screen.getByTestId("deposit-request-reject-open"));
    const submit = screen.getByTestId("deposit-request-reject-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("DepositRequestRejectReason"), {
      target: { value: "  Customer changed their mind  " },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(stubs.calls).toHaveLength(1));
    expect(stubs.calls[0]).toEqual({
      name: "depositRequests:reject",
      args: { orgId: ORG, requestId: "req1", reason: "Customer changed their mind" },
    });
  });
});

describe("QuoteDepositRequests", () => {
  const forQuote = (canConfirm: boolean, isMine: boolean) => ({
    canConfirm,
    requests: [
      {
        _id: "req1",
        amount: 1500,
        currency: "JOD",
        note: null,
        status: "PENDING",
        requestedAt: 1,
        resolutionReason: null,
        confirmedDepositId: null,
        isMine,
      },
    ],
  });

  test("the requester sees it as awaiting confirmation and may withdraw it, never decide it", async () => {
    stubs.queryResults.set("depositRequests:listForQuote", forQuote(false, true));
    render(<QuoteDepositRequests orgId={ORG} quoteId={QUOTE} />);

    expect(screen.getByTestId("deposit-request-status-PENDING")).toBeTruthy();
    expect(screen.getByText("DepositRequestStatus_PENDING")).toBeTruthy();
    expect(screen.getByText("DepositRequestAwaitingManager")).toBeTruthy();
    expect(screen.queryByTestId("deposit-request-confirm-open")).toBeNull();
    expect(screen.queryByTestId("deposit-request-reject-open")).toBeNull();

    fireEvent.click(screen.getByTestId("deposit-request-withdraw"));
    await waitFor(() => expect(stubs.calls).toHaveLength(1));
    expect(stubs.calls[0]).toEqual({
      name: "depositRequests:withdraw",
      args: { orgId: ORG, requestId: "req1" },
    });
  });

  test("somebody else's request offers no withdraw to a non-confirmer", () => {
    stubs.queryResults.set("depositRequests:listForQuote", forQuote(false, false));
    render(<QuoteDepositRequests orgId={ORG} quoteId={QUOTE} />);
    expect(screen.queryByTestId("deposit-request-withdraw")).toBeNull();
  });

  test("a confirmer is offered the decision on the quote too", () => {
    stubs.queryResults.set("depositRequests:listForQuote", forQuote(true, false));
    render(<QuoteDepositRequests orgId={ORG} quoteId={QUOTE} />);
    expect(screen.getByTestId("deposit-request-confirm-open")).toBeTruthy();
    expect(screen.getByTestId("deposit-request-reject-open")).toBeTruthy();
  });
});
