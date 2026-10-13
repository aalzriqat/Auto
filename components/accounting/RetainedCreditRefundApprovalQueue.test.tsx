/**
 * SCRUM-831: the approver's customer-credit refund queue, rendered with the real
 * EN and AR dictionaries. The expected texts are hand-written literals so the
 * assertions do not echo the dictionary they test.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  queryResult: undefined as unknown,
  queryArgs: undefined as unknown,
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (dictionaries[stubs.locale] as Record<string, string>)[key] ?? key,
    isRtl: stubs.locale === "ar",
    locale: stubs.locale,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: stubs.toastSuccess, error: stubs.toastError } }));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => `key:${k}`, retire: () => {} }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      expect(getFunctionName(reference)).toBe("retainedCreditRefunds:listRetainedCreditRefundApprovalQueue");
      stubs.queryArgs = args;
      return stubs.queryResult;
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      if (!stubs.mutations.has(name)) stubs.mutations.set(name, vi.fn().mockResolvedValue(null));
      return stubs.mutations.get(name)!;
    },
  };
});

import { RetainedCreditRefundApprovalQueue } from "./RetainedCreditRefundApprovalQueue";

const LITERAL = {
  title: { en: "Customer credit refunds awaiting approval", ar: "طلبات ردّ رصيد العملاء بانتظار الموافقة" },
  loading: { en: "Loading refund requests…", ar: "جارٍ تحميل طلبات الردّ…" },
  empty: {
    en: "No customer credit refunds are waiting for your approval.",
    ar: "لا توجد طلبات ردّ أرصدة بانتظار موافقتك.",
  },
  own: {
    en: "You requested this refund, so a different approver must decide it.",
    ar: "أنت من قدّم طلب الردّ هذا، لذلك يجب أن يبتّ فيه موافق آخر.",
  },
  paused: {
    en: "Approving is paused: paying customer credit out is not available during the pilot. The credit stays on the customer's account. You can still reject a request.",
    ar: "الموافقة متوقفة: دفع أرصدة العملاء غير متاح خلال المرحلة التجريبية. يبقى الرصيد في حساب العميل. ما زال بإمكانك رفض الطلب.",
  },
  approve: { en: "Approve", ar: "موافقة" },
  reject: { en: "Reject", ar: "رفض" },
  approved: { en: "Refund approved.", ar: "تمت الموافقة على الردّ." },
  rejected: { en: "Refund rejected.", ar: "تم رفض الردّ." },
  failed: {
    en: "The refund action could not be completed. Reload the page to see its current status, then try again.",
    ar: "تعذّر إتمام إجراء ردّ الرصيد. أعد تحميل الصفحة لرؤية حالته الحالية، ثم حاول مجدداً.",
  },
  bank: { en: "Bank transfer", ar: "تحويل بنكي" },
  // The PAYMENT-method word (MethodCash), not the deal-type word "نقدي" (the Cash key).
  cash: { en: "Cash", ar: "نقدًا" },
  dealTypeCashAr: "نقدي",
  cancelledSale: { en: "Originating sale: cancelled", ar: "الصفقة الأصلية: ملغاة" },
} as const;

const row = (over: Record<string, unknown> = {}) => ({
  _id: "r1", amountMinor: 1200, currency: "JOD", method: "BANK_TRANSFER", reason: "Customer asked for money back",
  createdAt: Date.UTC(2026, 9, 12), requestedByMe: false, requestedByName: "Dana", customerName: "Layla Haddad",
  sourceChequeLabel: "Arab Bank #004512", originatingSaleStatus: "CANCELLED", ...over,
});
const loaded = (requests: unknown[], payoutAvailable: boolean) => ({ payoutAvailable, requests });

const RESPOND = "retainedCreditRefunds:respondToRetainedCreditRefund";
function show() {
  render(<RetainedCreditRefundApprovalQueue orgId={"org1" as never} />);
}

afterEach(() => {
  cleanup();
  stubs.queryResult = undefined;
  stubs.queryArgs = undefined;
  stubs.mutations.clear();
  stubs.toastError.mockReset();
  stubs.toastSuccess.mockReset();
  stubs.locale = "en";
});

describe.each(["en", "ar"] as const)("manager refund approval queue (%s)", (locale) => {
  test("loading shows a status, not an empty queue", () => {
    stubs.locale = locale;
    show();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(LITERAL.loading[locale]);
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("refund-approval-empty")).toBeNull();
  });

  test("empty says nothing is waiting, with no actions", () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([], true);
    show();
    expect(screen.getByTestId("refund-approval-empty").textContent).toBe(LITERAL.empty[locale]);
    expect(screen.getByRole("region", { name: LITERAL.title[locale] })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("refund-approval-paused")).toBeNull();
  });

  test("a pending request shows what the approver needs to judge it, and only approve and reject", () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([row()], true);
    show();
    expect(stubs.queryArgs).toEqual({ orgId: "org1" });
    const item = screen.getByTestId("refund-approval-row");
    expect(item.textContent).toContain("Layla Haddad");
    expect(item.textContent).toContain("Customer asked for money back");
    expect(item.textContent).toContain("Dana");
    expect(item.textContent).toContain("1.200");
    expect(item.textContent).toContain(LITERAL.bank[locale]);
    expect(item.textContent).toContain(LITERAL.cancelledSale[locale]);
    expect(item.querySelector("bdi")?.getAttribute("dir")).toBe("ltr");
    expect(item.textContent).toContain("Arab Bank #004512");
    expect(item.querySelector("p[dir='auto']")).not.toBeNull();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([LITERAL.approve[locale], LITERAL.reject[locale]]);
    expect(buttons.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByTestId("refund-approval-paused")).toBeNull();
  });

  test("a CASH request names the payment method with the payment-method word, not the deal-type word", () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([row({ method: "CASH", requestedByMe: false })], true);
    show();
    const text = screen.getByTestId("refund-approval-row").textContent ?? "";
    expect(text).toContain(LITERAL.cash[locale]);
    expect(text).not.toContain(LITERAL.bank[locale]);
    if (locale === "ar") expect(text).not.toContain(LITERAL.dealTypeCashAr);
  });

  test("payout unavailable: approve is disabled and tied to the reason; reject stays available", () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([row()], false);
    show();
    const note = screen.getByTestId("refund-approval-paused");
    expect(note.textContent).toBe(LITERAL.paused[locale]);
    const approve = screen.getByRole("button", { name: LITERAL.approve[locale] }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.getAttribute("aria-describedby")).toBe(note.id);
    fireEvent.click(approve);
    expect(stubs.mutations.get(RESPOND)).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: LITERAL.reject[locale] }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("the requester's own request offers no decision, only the reason", () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([row({ requestedByMe: true })], true);
    show();
    expect(screen.getByTestId("refund-approval-own-request").textContent).toBe(LITERAL.own[locale]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("approve and reject forward the request with an idempotency key and confirm in the user's language", async () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([row()], true);
    show();
    fireEvent.click(screen.getByRole("button", { name: LITERAL.approve[locale] }));
    await vi.waitFor(() => expect(stubs.toastSuccess).toHaveBeenCalledWith(LITERAL.approved[locale]));
    expect(stubs.mutations.get(RESPOND)).toHaveBeenCalledWith({
      orgId: "org1", requestId: "r1", status: "APPROVED", idempotencyKey: "key:retained-refund-decide:r1:APPROVED",
    });
    fireEvent.click(screen.getByRole("button", { name: LITERAL.reject[locale] }));
    await vi.waitFor(() => expect(stubs.toastSuccess).toHaveBeenCalledWith(LITERAL.rejected[locale]));
    expect(stubs.mutations.get(RESPOND)).toHaveBeenLastCalledWith({
      orgId: "org1", requestId: "r1", status: "REJECTED", idempotencyKey: "key:retained-refund-decide:r1:REJECTED",
    });
  });

  test("a refused decision shows the localized message, never server English", async () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([row()], true);
    stubs.mutations.set(RESPOND, vi.fn().mockRejectedValue(new ConvexError("Requester cannot approve or reject their own retained credit refund request.")));
    show();
    fireEvent.click(screen.getByRole("button", { name: LITERAL.reject[locale] }));
    await vi.waitFor(() => expect(stubs.toastError).toHaveBeenCalledTimes(1));
    expect(stubs.toastError).toHaveBeenCalledWith(LITERAL.failed[locale]);
  });
});
