/**
 * SCRUM-469. A refund approval request names the instrument the money will go
 * out by, which picks the ledger account it is paid from. The picker starts
 * empty, Submit is refused until one is chosen, and the chosen method is exactly
 * what reaches `collections.requestApproval`. Reschedule and cancel move no cash
 * and never ask for one.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_1" }),
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (value: number) => String(value),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: () => undefined,
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => undefined }),
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      stubs.calls.push({ name: getFunctionName(reference), args });
    },
  };
});

import { ApprovalRequestDialog, KeyedApprovalRequestDialog } from "./CollectionsTab";

// jsdom implements none of the pointer-capture surface Radix reaches for.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  stubs.calls.length = 0;
});
afterEach(cleanup);

const receivable = {
  _id: "rec_1",
  customerName: "Dana",
  title: "Deal 7",
} as never;

function renderDialog(type: "REFUND" | "RESCHEDULE" | "CANCEL_RECEIVABLE") {
  render(<ApprovalRequestDialog target={{ receivable, type }} onOpenChange={() => undefined} />);
}

const submit = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;

function chooseMethod(label: string) {
  const trigger = screen.getByRole("combobox");
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  fireEvent.click(screen.getByText(label));
}

describe("ApprovalRequestDialog refund method (SCRUM-469)", () => {
  test("a refund request starts with no method and cannot be submitted, with the reason on screen", () => {
    renderDialog("REFUND");
    fireEvent.change(screen.getByPlaceholderText("RefundAmount"), { target: { value: "50" } });
    fireEvent.change(screen.getByPlaceholderText("Reason"), { target: { value: "Customer withdrew" } });

    expect(screen.getByText("RefundChooseMethod")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("RefundMethodRequired");
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(stubs.calls).toHaveLength(0);
  });

  test("the method sent is exactly the one chosen", async () => {
    renderDialog("REFUND");
    fireEvent.change(screen.getByPlaceholderText("RefundAmount"), { target: { value: "50" } });
    fireEvent.change(screen.getByPlaceholderText("Reason"), { target: { value: "Customer withdrew" } });
    chooseMethod("Bank Transfer");

    expect(screen.queryByRole("status")).toBeNull();
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(stubs.calls).toHaveLength(1));
    expect(stubs.calls[0]!.args).toMatchObject({
      requestType: "REFUND",
      requestedAmount: 50,
      disbursementMethod: "BANK_TRANSFER",
    });
  });

  test("a reschedule moves no cash: no method is asked and none is sent", async () => {
    renderDialog("RESCHEDULE");
    fireEvent.change(screen.getByPlaceholderText("Reason"), { target: { value: "Customer asked" } });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(stubs.calls).toHaveLength(1));
    expect(stubs.calls[0]!.args.disbursementMethod).toBeUndefined();
  });
});
describe("refund method is per intent, never carried over (SCRUM-469 round 1, SOL-01)", () => {
  const other = { _id: "rec_2", customerName: "Omar", title: "Deal 9" } as never;
  const open = (r: never, type: "REFUND" | "RESCHEDULE" | "CANCEL_RECEIVABLE" = "REFUND") => (
    <KeyedApprovalRequestDialog target={{ receivable: r, type }} onOpenChange={() => undefined} />
  );

  test("Cancel then a different receivable's Refund opens with NO method and Submit disabled", () => {
    const view = render(open(receivable));
    fireEvent.change(screen.getByPlaceholderText("RefundAmount"), { target: { value: "50" } });
    fireEvent.change(screen.getByPlaceholderText("Reason"), { target: { value: "Customer withdrew" } });
    chooseMethod("Bank Transfer");
    expect(submit().disabled).toBe(false);

    view.rerender(<KeyedApprovalRequestDialog target={null} onOpenChange={() => undefined} />);
    view.rerender(open(other));

    expect(screen.getByText("RefundChooseMethod")).toBeTruthy();
    expect((screen.getByPlaceholderText("RefundAmount") as HTMLInputElement).value).toBe("");
    expect((screen.getByPlaceholderText("Reason") as HTMLInputElement).value).toBe("");
    expect(submit().disabled).toBe(true);
  });

  test("reopening the SAME receivable after close is a new intent too", () => {
    const view = render(open(receivable));
    chooseMethod("Bank Transfer");
    view.rerender(<KeyedApprovalRequestDialog target={null} onOpenChange={() => undefined} />);
    view.rerender(open(receivable));
    expect(screen.getByText("RefundChooseMethod")).toBeTruthy();
  });

  test("control: while the same target stays open (a retry) the method is kept", () => {
    const view = render(open(receivable));
    fireEvent.change(screen.getByPlaceholderText("RefundAmount"), { target: { value: "50" } });
    fireEvent.change(screen.getByPlaceholderText("Reason"), { target: { value: "Customer withdrew" } });
    chooseMethod("Bank Transfer");
    view.rerender(open(receivable));
    expect(screen.queryByText("RefundChooseMethod")).toBeNull();
    expect(submit().disabled).toBe(false);
  });
});
