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
  /** What usePaginatedQuery returns; undefined models the first page still loading. */
  queryResult: undefined as unknown,
  queryArgs: undefined as unknown,
  queryOptions: undefined as unknown,
  loadMore: vi.fn(),
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
    usePaginatedQuery: (reference: never, args: unknown, options: unknown) => {
      expect(getFunctionName(reference)).toBe("retainedCreditRefunds:listRetainedCreditRefundApprovalQueue");
      stubs.queryArgs = args;
      stubs.queryOptions = options;
      return stubs.queryResult ?? { results: [], status: "LoadingFirstPage", loadMore: stubs.loadMore };
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
  loadMore: { en: "Load more requests", ar: "تحميل المزيد من الطلبات" },
  loadingMore: { en: "Loading more requests…", ar: "جارٍ تحميل المزيد من الطلبات…" },
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
/** The server stamps `payoutAvailable` on every row; `status` is the paginated hook's. */
const loaded = (
  requests: Array<Record<string, unknown>>,
  payoutAvailable: boolean,
  status: "Exhausted" | "CanLoadMore" | "LoadingMore" = "Exhausted",
) => ({
  results: requests.map((request) => ({ payoutAvailable, ...request })),
  status,
  loadMore: stubs.loadMore,
});

const RESPOND = "retainedCreditRefunds:respondToRetainedCreditRefund";
function show() {
  return render(<RetainedCreditRefundApprovalQueue orgId={"org1" as never} />);
}

afterEach(() => {
  cleanup();
  stubs.queryResult = undefined;
  stubs.queryArgs = undefined;
  stubs.queryOptions = undefined;
  stubs.loadMore.mockReset();
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
    expect(stubs.queryOptions).toEqual({ initialNumItems: 25 });
    // A queue that fits one page offers nothing to load.
    expect(screen.queryByTestId("refund-approval-load-more")).toBeNull();
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

  test("a longer queue offers Load more, which asks for the next page and never claims the queue is empty or complete", () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([row()], true, "CanLoadMore");
    show();
    const button = screen.getByRole("button", { name: LITERAL.loadMore[locale] }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(stubs.loadMore).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(stubs.loadMore).toHaveBeenCalledTimes(1);
    expect(stubs.loadMore).toHaveBeenCalledWith(25);
    expect(screen.queryByTestId("refund-approval-empty")).toBeNull();
  });

  test("while the next page loads the control is disabled, busy and says so", () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([row()], true, "LoadingMore");
    show();
    const button = screen.getByTestId("refund-approval-load-more") as HTMLButtonElement;
    expect(button.textContent).toBe(LITERAL.loadingMore[locale]);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(stubs.loadMore).not.toHaveBeenCalled();
    // The rows already loaded stay decidable meanwhile.
    expect(screen.getAllByTestId("refund-approval-row")).toHaveLength(1);
  });

  test("a first page that came back short of the end is not reported as an empty queue", () => {
    stubs.locale = locale;
    stubs.queryResult = loaded([], true, "CanLoadMore");
    show();
    expect(screen.queryByTestId("refund-approval-empty")).toBeNull();
    expect(screen.getByRole("button", { name: LITERAL.loadMore[locale] })).toBeTruthy();
  });

  test("Load more reaches rows beyond the first page, then disappears at the end", () => {
    stubs.locale = locale;
    const all = Array.from({ length: 60 }, (_, index) => row({ _id: `r${index + 1}`, customerName: `Customer ${index + 1}` }));
    let pagesLoaded = 1;
    const current = () => loaded(
      all.slice(0, pagesLoaded * 25), true, pagesLoaded * 25 >= all.length ? "Exhausted" : "CanLoadMore",
    );
    stubs.loadMore.mockImplementation(() => { pagesLoaded += 1; });
    stubs.queryResult = current();
    const view = show();
    expect(screen.getAllByTestId("refund-approval-row")).toHaveLength(25);
    expect(screen.queryByText("Customer 60")).toBeNull();

    for (const expected of [50, 60]) {
      fireEvent.click(screen.getByRole("button", { name: LITERAL.loadMore[locale] }));
      stubs.queryResult = current();
      view.rerender(<RetainedCreditRefundApprovalQueue orgId={"org1" as never} />);
      expect(screen.getAllByTestId("refund-approval-row")).toHaveLength(expected);
    }
    expect(screen.getByText("Customer 60")).toBeTruthy();
    expect(screen.queryByTestId("refund-approval-load-more")).toBeNull();
    expect(stubs.loadMore).toHaveBeenCalledTimes(2);
  });

  test("payout dark on a later page still pauses approve for every loaded row; reject stays", () => {
    stubs.locale = locale;
    stubs.queryResult = {
      results: [{ payoutAvailable: true, ...row({ _id: "r1" }) }, { payoutAvailable: false, ...row({ _id: "r2" }) }],
      status: "CanLoadMore",
      loadMore: stubs.loadMore,
    };
    show();
    expect(screen.getByTestId("refund-approval-paused").textContent).toBe(LITERAL.paused[locale]);
    for (const approve of screen.getAllByRole("button", { name: LITERAL.approve[locale] })) {
      expect((approve as HTMLButtonElement).disabled).toBe(true);
    }
    for (const reject of screen.getAllByRole("button", { name: LITERAL.reject[locale] })) {
      expect((reject as HTMLButtonElement).disabled).toBe(false);
    }
  });
});
