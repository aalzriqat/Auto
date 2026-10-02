/**
 * SCRUM-571 S1: an unpaid payment link reserves its amount, so the operator
 * needs a way to expire it. The row offers "Expire link" only while PENDING,
 * behind a confirmation, and a coded refusal is shown translated.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { commonAr } from "@/lib/i18n/domains/common";

const stubs = vi.hoisted(() => ({
  rows: [] as unknown[],
  mutations: new Map<string, (...args: unknown[]) => unknown>(),
  t: (key: string): string => key,
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
