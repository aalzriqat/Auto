/**
 * SCRUM-571 S1: an unpaid payment link reserves its amount, so the operator
 * needs a way to expire it. The row offers "Expire link" only while PENDING,
 * behind a confirmation, and a coded refusal is shown translated.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { commonAr, commonEn } from "@/lib/i18n/domains/common";

const stubs = vi.hoisted(() => ({
  rows: [] as unknown[],
  mutations: new Map<string, (...args: unknown[]) => unknown>(),
  t: (key: string): string => key,
  held: [] as unknown[] | undefined,
  heldThrows: false,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => stubs.t(key), isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number) => `${n} JOD`,
}));
vi.mock("@/hooks/useCurrency", () => ({ useCurrency: () => ({ code: "JOD" }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    usePaginatedQuery: () => ({ results: stubs.rows, status: "Exhausted", loadMore: () => {} }),
    // Convex's useQuery throws the server error during render; mirror that.
    useQuery: () => {
      if (stubs.heldThrows) throw new Error("query failed");
      return stubs.held;
    },
    useMutation: (reference: never) => stubs.mutations.get(getFunctionName(reference)) ?? vi.fn(),
  };
});

import { PaymentLinksPanel } from "./PaymentLinksPanel";

const intent = (over: Record<string, unknown>) => ({
  _id: "pi1",
  _creationTime: 0,
  orgId: "org1",
  customerId: "c1",
  customerName: "Layla Nasser",
  amountMinor: 600_000,
  currency: "JOD",
  provider: "tap",
  status: "PENDING",
  ...over,
});

afterEach(() => {
  cleanup();
  stubs.rows = [];
  stubs.held = [];
  stubs.heldThrows = false;
  stubs.mutations.clear();
  stubs.t = (key: string) => key;
  vi.clearAllMocks();
});

describe("PaymentLinksPanel: Expire link", () => {
  test.each(["SETTLED", "EXPIRED", "FAILED"])("is disabled for a %s link", (status) => {
    stubs.rows = [intent({ status })];
    render(<PaymentLinksPanel />);
    expect((screen.getByRole("button", { name: "ExpirePaymentLink" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("on a PENDING link it asks first, then expires and confirms", async () => {
    const expire = vi.fn().mockResolvedValue(null);
    stubs.mutations.set("paymentIntents:expire", expire);
    stubs.rows = [intent({})];
    render(<PaymentLinksPanel />);

    fireEvent.click(screen.getByRole("button", { name: "ExpirePaymentLink" }));
    const dialog = await screen.findByRole("dialog");
    expect(expire).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "ExpirePaymentLink" }));
    await waitFor(() => expect(expire).toHaveBeenCalledWith({ orgId: "org1", intentId: "pi1" }));
    const { toast } = await import("@/components/ui/sonner");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("PaymentLinkExpired"));
  });

  test("Cancel closes the dialog without calling the server", async () => {
    const expire = vi.fn();
    stubs.mutations.set("paymentIntents:expire", expire);
    stubs.rows = [intent({})];
    render(<PaymentLinksPanel />);
    fireEvent.click(screen.getByRole("button", { name: "ExpirePaymentLink" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(expire).not.toHaveBeenCalled();
  });

  test("Cancel is disabled while the expire is in flight and enabled again once it settles", async () => {
    let finish: (value: unknown) => void = () => {};
    const expire = vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)));
    stubs.mutations.set("paymentIntents:expire", expire);
    stubs.rows = [intent({})];
    render(<PaymentLinksPanel />);
    fireEvent.click(screen.getByRole("button", { name: "ExpirePaymentLink" }));
    const dialog = await screen.findByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "ExpirePaymentLink" }));
    await waitFor(() => expect(expire).toHaveBeenCalled());
    expect(cancel.disabled).toBe(true);

    finish(null);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("Cancel is enabled again after a refused expire (dialog stays open)", async () => {
    const expire = vi.fn().mockRejectedValue(new Error("nope"));
    stubs.mutations.set("paymentIntents:expire", expire);
    stubs.rows = [intent({})];
    render(<PaymentLinksPanel />);
    fireEvent.click(screen.getByRole("button", { name: "ExpirePaymentLink" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ExpirePaymentLink" }));
    await waitFor(() => expect(expire).toHaveBeenCalled());
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false));
  });

  test("the confirmation shows the corrected copy: local release, deactivate at the provider, late payments held", async () => {
    stubs.t = (key: string) => (key === "ExpirePaymentLinkDescription" ? (commonEn as Record<string, string>)[key] : key);
    stubs.rows = [intent({})];
    render(<PaymentLinksPanel />);
    fireEvent.click(screen.getByRole("button", { name: "ExpirePaymentLink" }));
    const dialog = await screen.findByRole("dialog");
    const text = dialog.textContent ?? "";
    expect(text).toContain("Layla Nasser");
    expect(text).toContain("600 JOD");
    expect(text).toMatch(/deactivate/i);
    expect(text).toMatch(/held for review/i);
    expect(text).not.toMatch(/will stop accepting payment/i);
  });

  test("a coded PAYMENT_LINK_NOT_PENDING refusal is shown in Arabic, not as raw JSON", async () => {
    stubs.t = (key: string) => (key.startsWith("ServerError_") ? (commonAr as Record<string, string>)[key] ?? key : key);
    const expire = vi.fn().mockRejectedValue(
      new ConvexError({
        code: "PAYMENT_LINK_NOT_PENDING",
        message: "Only a payment link that is still waiting for payment can be expired. Nothing has been changed.",
      })
    );
    stubs.mutations.set("paymentIntents:expire", expire);
    stubs.rows = [intent({})];
    render(<PaymentLinksPanel />);
    fireEvent.click(screen.getByRole("button", { name: "ExpirePaymentLink" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ExpirePaymentLink" }));
    const { toast } = await import("@/components/ui/sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const shown = String(vi.mocked(toast.error).mock.calls.at(-1)?.[0]);
    expect(shown).toBe((commonAr as Record<string, string>).ServerError_PAYMENT_LINK_NOT_PENDING);
    expect(shown).not.toContain('{"code"');
  });
});

const held = (over: Record<string, unknown>) => ({
  _id: "uf1",
  _creationTime: 0,
  orgId: "org1",
  provider: "tap",
  externalId: "tap_chg_late",
  intentId: "pi1",
  reason: "INTENT_NOT_PENDING",
  intentStatusAtReceipt: "EXPIRED",
  amountMinor: 250_000,
  currency: "JOD",
  providerEventIds: ["evt_1"],
  deliveryCount: 2,
  amountConflict: false,
  reviewStatus: "OPEN",
  firstReceivedAt: 1_700_000_000_000,
  lastReceivedAt: 1_700_000_100_000,
  ...over,
});

describe("PaymentLinksPanel: Payments held for review (SCRUM-571 D-8)", () => {
  test("shows a loading state while the query is undefined", () => {
    stubs.held = undefined;
    render(<PaymentLinksPanel />);
    expect(screen.getByText("HeldPaymentsLoading")).toBeTruthy();
  });

  test("shows the empty state when nothing is held", () => {
    stubs.held = [];
    render(<PaymentLinksPanel />);
    expect(screen.getByText("HeldPaymentsTitle")).toBeTruthy();
    expect(screen.getByText("HeldPaymentsEmpty")).toBeTruthy();
  });

  test("shows an error state instead of crashing the panel when the query fails", () => {
    stubs.heldThrows = true;
    stubs.rows = [intent({})];
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PaymentLinksPanel />);
    expect(screen.getByText("HeldPaymentsError")).toBeTruthy();
    // The payment links table above is unaffected.
    expect(screen.getByText("Layla Nasser")).toBeTruthy();
    quiet.mockRestore();
  });

  test("renders rows with amount, provider, reference, reason, delivery count and a conflict badge", () => {
    stubs.held = [
      held({}),
      held({ _id: "uf2", externalId: "tap_chg_two", reason: "UNKNOWN_REFERENCE", amountConflict: true, deliveryCount: 1 }),
    ];
    render(<PaymentLinksPanel />);
    expect(screen.getByText("tap_chg_late")).toBeTruthy();
    expect(screen.getAllByText("250 JOD").length).toBe(2);
    expect(screen.getByText("HeldPaymentsReason_INTENT_NOT_PENDING")).toBeTruthy();
    expect(screen.getByText("HeldPaymentsReason_UNKNOWN_REFERENCE")).toBeTruthy();
    expect(screen.getAllByText("HeldPaymentsConflict")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "HeldPaymentsResolve" })).toHaveLength(2);
  });

  test("a RESOLVED row has no Resolve action", () => {
    stubs.held = [held({ reviewStatus: "RESOLVED", resolvedAt: 1_700_000_200_000, resolutionNote: "Refunded" })];
    render(<PaymentLinksPanel />);
    expect(screen.queryByRole("button", { name: "HeldPaymentsResolve" })).toBeNull();
    expect(screen.getByText("HeldPaymentsResolved")).toBeTruthy();
  });

  test("Resolve requires a note, then submits it trimmed", async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    stubs.mutations.set("paymentIntents:resolveUnmatchedProviderFunds", resolve);
    stubs.held = [held({})];
    render(<PaymentLinksPanel />);

    fireEvent.click(screen.getByRole("button", { name: "HeldPaymentsResolve" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "HeldPaymentsResolve" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "  Refunded through the bank  " } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({ orgId: "org1", id: "uf1", note: "Refunded through the bank" })
    );
    const { toast } = await import("@/components/ui/sonner");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("HeldPaymentsResolvedToast"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("Cancel in the Resolve dialog is disabled while the resolve is in flight", async () => {
    let finish: (value: unknown) => void = () => {};
    const resolve = vi.fn().mockReturnValue(new Promise((r) => (finish = r)));
    stubs.mutations.set("paymentIntents:resolveUnmatchedProviderFunds", resolve);
    stubs.held = [held({})];
    render(<PaymentLinksPanel />);
    fireEvent.click(screen.getByRole("button", { name: "HeldPaymentsResolve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "done" } });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    fireEvent.click(within(dialog).getByRole("button", { name: "HeldPaymentsResolve" }));
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(cancel.disabled).toBe(true);
    finish(null);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
