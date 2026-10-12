/**
 * SCRUM-724 deal-page receipts panel, as MOUNTED.
 *
 * Pilot containment: while the backend reports the sale-invoice doors / the
 * retained-credit payout as unavailable (or does not report them at all), every
 * money action the backend would refuse is still SHOWN, visibly disabled, and
 * tied (aria-describedby) to the EN/AR reason. Viewing keeps working, and
 * depositing / clearing a presented cheque (never switch-gated on the server)
 * stays available.
 *
 * CR-1: a coded refusal from any of the five money handlers reaches the user in
 * their language; an uncoded server string is NEVER shown raw - the panel's own
 * localized message stands in for it. These tests use the real dictionaries so
 * the EN and AR text is the shipped text.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  permissions: new Set<string>(["view:finance", "manage:finance"]),
  status: undefined as unknown,
  cheques: [] as Array<Record<string, unknown>>,
  credits: [] as Array<Record<string, unknown>>,
  queryArgs: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries: tables } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      locale: stubs.locale,
      isRtl: stubs.locale === "ar",
      t: (key: string) => (tables[stubs.locale] as Record<string, string>)[key]
        || (tables.en as Record<string, string>)[key] || key,
    }),
  };
});
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: false, hasPermission: (p: string) => stubs.permissions.has(p) }),
}));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      stubs.queryArgs.set(getFunctionName(reference), args);
      return args === "skip" || getFunctionName(reference) !== "collections:saleInvoiceReceiptStatus"
        ? undefined : stubs.status;
    },
    usePaginatedQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      if (args === "skip") return { results: [], status: "LoadingFirstPage", loadMore: () => {} };
      const results = name === "collections:listSaleCustomerCheques" ? stubs.cheques : stubs.credits;
      return { results, status: "Exhausted", loadMore: () => {} };
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      if (!stubs.mutations.has(name)) stubs.mutations.set(name, vi.fn().mockResolvedValue(null));
      return stubs.mutations.get(name)!;
    },
  };
});

import { DealInvoiceReceiptsPanel } from "./DealInvoiceReceiptsPanel";

const EN = dictionaries.en as Record<string, string>;
const AR = dictionaries.ar as Record<string, string>;

const baseStatus = (over: Record<string, unknown>) => ({
  page: [], isDone: true, continueCursor: "", customerId: "c1", saleStatus: "COMPLETED",
  receiptCurrency: "JOD",
  invoice: { currency: "JOD", originalAmountMinor: 100000, outstandingMinor: 100000, availableToReserveMinor: 100000 },
  ...over,
});
const DOORS_OPEN = { saleInvoiceDoorsAvailable: true, retainedCreditPayoutAvailable: true };
const verifiedApplication = { applicationId: "a1", receiptMovementId: "m1", amountMinor: 1000, currency: "JOD",
  createdAt: 1, readiness: "ORIGINS_VERIFIED" };

const credit = {
  receiptMovementId: "m1", availableUnappliedMinor: 3000, currency: "JOD", receiptPosted: true,
  createdAt: 1, sourceChequeLabel: "Arab Bank #1", originatingSaleStatus: "CANCELLED",
};
const heldCheque = { chequeId: "q1", bank: "Arab Bank", chequeNumber: "1", chequeDate: 1, amount: 30, status: "HELD" };
const depositedCheque = { ...heldCheque, chequeId: "q2", status: "DEPOSITED" };

const t = (key: string) => (stubs.locale === "ar" ? AR : EN)[key];
const button = (key: string) => screen.getByRole("button", { name: t(key) }) as HTMLButtonElement;
const mutation = (name: string) => stubs.mutations.get(name);

function renderPanel() {
  render(<DealInvoiceReceiptsPanel orgId={"org1" as never} saleId={"sale1" as never} />);
}

afterEach(() => {
  cleanup();
  stubs.locale = "en";
  stubs.permissions = new Set(["view:finance", "manage:finance"]);
  stubs.status = undefined;
  stubs.cheques = [];
  stubs.credits = [];
  stubs.queryArgs.clear();
  stubs.mutations.clear();
});

describe("DealInvoiceReceiptsPanel under the SCRUM-724 pilot switches", () => {
  test.each([
    ["flags false", { saleInvoiceDoorsAvailable: false, retainedCreditPayoutAvailable: false }],
    ["flags absent (backend does not report them)", {}],
  ])("%s: every money action is shown disabled and tied to the EN reason; clicks call nothing", (_label, flags) => {
    stubs.status = baseStatus({ ...flags, page: [verifiedApplication] });
    stubs.credits = [credit];
    renderPanel();
    const doors = screen.getByTestId("deal-invoice-doors-unavailable");
    const payout = screen.getByTestId("deal-credit-payout-unavailable");
    expect(doors.textContent).toBe(EN.SaleInvoiceDoorsUnavailable);
    expect(payout.textContent).toBe(EN.RetainedCreditPayoutUnavailable);
    for (const key of ["DealReceiptRecordButton", "DealReceiptRegisterCheque", "DealReceiptChooseCredit",
      "DealReceiptTryActivateButton"]) {
      expect(button(key).disabled, key).toBe(true);
      expect(button(key).getAttribute("aria-describedby"), key).toBe(doors.id);
      fireEvent.click(button(key));
    }
    expect(button("RetainedCreditRequestRefund").disabled).toBe(true);
    expect(button("RetainedCreditRequestRefund").getAttribute("aria-describedby")).toBe(payout.id);
    fireEvent.click(button("RetainedCreditRequestRefund"));
    expect((screen.getByLabelText(EN.DealReceiptAmount, { selector: "#sale-receipt-amount" }) as HTMLInputElement).disabled).toBe(true);
    expect([...stubs.mutations.values()].every((fn) => fn.mock.calls.length === 0)).toBe(true);
    // Viewing still works.
    expect(screen.getByText(EN.CustomerInvoiceBalance, { exact: false })).toBeTruthy();
  });

  test("AR: the disabled reasons are the Arabic text", () => {
    stubs.locale = "ar";
    stubs.status = baseStatus({});
    stubs.credits = [credit];
    renderPanel();
    expect(screen.getByTestId("deal-invoice-doors-unavailable").textContent).toBe(AR.SaleInvoiceDoorsUnavailable);
    expect(screen.getByTestId("deal-credit-payout-unavailable").textContent).toBe(AR.RetainedCreditPayoutUnavailable);
    expect(AR.SaleInvoiceDoorsUnavailable).not.toBe(EN.SaleInvoiceDoorsUnavailable);
    expect(button("DealReceiptRecordButton").disabled).toBe(true);
  });

  test("flags true: the actions are enabled (the panel is switch-driven, not hard-coded off)", () => {
    stubs.status = baseStatus({ ...DOORS_OPEN, page: [verifiedApplication] });
    stubs.credits = [credit];
    renderPanel();
    expect(screen.queryByTestId("deal-invoice-doors-unavailable")).toBeNull();
    expect(screen.queryByTestId("deal-credit-payout-unavailable")).toBeNull();
    for (const key of ["DealReceiptRecordButton", "DealReceiptRegisterCheque", "DealReceiptChooseCredit",
      "DealReceiptTryActivateButton", "RetainedCreditRequestRefund"]) {
      expect(button(key).disabled, key).toBe(false);
      expect(button(key).hasAttribute("aria-describedby"), key).toBe(false);
    }
  });

  test("with the doors off, an already-presented (DEPOSITED) cheque can still be cleared, even on a cancelled sale", () => {
    stubs.status = baseStatus({
      saleStatus: "CANCELLED", saleInvoiceDoorsAvailable: false, retainedCreditPayoutAvailable: false,
      invoice: { currency: "JOD", originalAmountMinor: 100000, outstandingMinor: 0, availableToReserveMinor: 0 },
    });
    stubs.cheques = [depositedCheque, heldCheque];
    renderPanel();
    expect(screen.getAllByRole("button", { name: EN.DealReceiptClearCheque })).toHaveLength(1);
    expect(button("DealReceiptClearCheque").disabled).toBe(false);
    expect(screen.queryByRole("button", { name: EN.DealReceiptDepositCheque })).toBeNull();
  });

  // Opus F1: clearCheque reserves for the invoice only on a LIVE intent with the
  // doors open; otherwise the whole face stays unreserved customer credit. The
  // success notice must therefore never claim a reservation it cannot know of.
  const CLEARED = {
    en: "Cheque cleared. Its amount is now customer credit; see the credit and any pending invoice application below.",
    ar: "حُصّل الشيك. أصبح مبلغه رصيداً للعميل؛ راجع الرصيد وأي تطبيق معلّق على الفاتورة أدناه.",
  } as const;
  test.each([
    ["en", "doors off, COMPLETED sale", { saleInvoiceDoorsAvailable: false }],
    ["ar", "doors off, COMPLETED sale", { saleInvoiceDoorsAvailable: false }],
    ["en", "cancelled sale", { saleStatus: "CANCELLED", saleInvoiceDoorsAvailable: true }],
    ["ar", "invoice already covered, doors open", { saleInvoiceDoorsAvailable: true,
      invoice: { currency: "JOD", originalAmountMinor: 100000, outstandingMinor: 0, availableToReserveMinor: 0 } }],
  ] as const)("%s · %s: clearing a cheque never claims it was reserved for the invoice", async (locale, _label, over) => {
    stubs.locale = locale;
    stubs.status = baseStatus({ ...over });
    stubs.cheques = [depositedCheque];
    renderPanel();
    fireEvent.click(button("DealReceiptClearCheque"));
    await vi.waitFor(() => expect(mutation("collections:clearCheque")).toHaveBeenCalledTimes(1));
    const notice = await screen.findByText(CLEARED[locale]);
    expect(notice.tagName).toBe("OUTPUT");
    // The pre-review copy, as literals: it claimed a reservation the server may not make.
    expect(screen.queryByText(/reserved for this invoice|وحُجز للفاتورة/)).toBeNull();
  });

  test("a held cheque the invoice can still cover is depositable with the doors off (deposit is never switch-gated)", () => {
    stubs.status = baseStatus({});
    stubs.cheques = [heldCheque];
    renderPanel();
    fireEvent.click(button("DealReceiptDepositCheque"));
    expect(mutation("collections:depositCheque")).toHaveBeenCalledWith({ orgId: "org1", chequeId: "q1" });
  });

  test("a held cheque larger than what the invoice can still take is not offered for deposit; the reason is shown", () => {
    // 30.000 JOD face, 29.999 JOD left to apply: the server would refuse with
    // CHEQUE_INVOICE_UNCOVERED_HELD.
    stubs.status = baseStatus({
      invoice: { currency: "JOD", originalAmountMinor: 100000, outstandingMinor: 29999, availableToReserveMinor: 29999 },
    });
    stubs.cheques = [heldCheque];
    renderPanel();
    expect(screen.queryByRole("button", { name: EN.DealReceiptDepositCheque })).toBeNull();
    expect(screen.getByText(EN.DealReceiptChequeExceedsInvoice)).toBeTruthy();
  });

  test("a cheque exactly equal to what the invoice can still take is depositable (boundary)", () => {
    stubs.status = baseStatus({
      invoice: { currency: "JOD", originalAmountMinor: 100000, outstandingMinor: 30000, availableToReserveMinor: 30000 },
    });
    stubs.cheques = [heldCheque];
    renderPanel();
    expect(button("DealReceiptDepositCheque").disabled).toBe(false);
    expect(screen.queryByText(EN.DealReceiptChequeExceedsInvoice)).toBeNull();
  });

  test("a status that has not loaded renders a loading state, never a crash", () => {
    stubs.status = undefined;
    renderPanel();
    expect(screen.getByText(EN.Loading)).toBeTruthy();
  });

  test("no invoice yet: the empty state, no actions", () => {
    stubs.status = baseStatus({ ...DOORS_OPEN, invoice: null });
    renderPanel();
    expect(screen.getByText(EN.DealReceiptNoInvoice)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("DealInvoiceReceiptsPanel by role", () => {
  test("VIEW_FINANCE without MANAGE_FINANCE: sees the balances, no money actions and no disabled-reason notes", () => {
    stubs.permissions = new Set(["view:finance"]);
    stubs.status = baseStatus({ page: [verifiedApplication] });
    stubs.credits = [credit];
    stubs.cheques = [heldCheque, depositedCheque];
    renderPanel();
    expect(screen.getByText(EN.CustomerInvoiceBalance, { exact: false })).toBeTruthy();
    expect(screen.queryByTestId("deal-invoice-doors-unavailable")).toBeNull();
    expect(screen.queryByTestId("deal-credit-payout-unavailable")).toBeNull();
    for (const key of ["DealReceiptRecordButton", "DealReceiptRegisterCheque", "DealReceiptChooseCredit",
      "DealReceiptTryActivateButton", "RetainedCreditRequestRefund", "DealReceiptDepositCheque", "DealReceiptClearCheque"]) {
      expect(screen.queryByRole("button", { name: t(key) }), key).toBeNull();
    }
  });

  test("without VIEW_FINANCE the panel renders nothing and skips every query", () => {
    stubs.permissions = new Set();
    stubs.status = baseStatus(DOORS_OPEN);
    renderPanel();
    expect(screen.queryByTestId("deal-invoice-receipts")).toBeNull();
    expect(stubs.queryArgs.get("collections:saleInvoiceReceiptStatus")).toBe("skip");
    expect(stubs.queryArgs.get("collections:listSaleCustomerCheques")).toBe("skip");
    expect(stubs.queryArgs.get("collections:listRetainedCredits")).toBe("skip");
  });
});

describe("CR-2: a retained-credit refund can only be requested by bank transfer", () => {
  test("the refund method offers no CASH option", () => {
    stubs.status = baseStatus(DOORS_OPEN);
    stubs.credits = [credit];
    renderPanel();
    fireEvent.click(button("RetainedCreditRequestRefund"));
    const select = screen.getByLabelText(EN.RetainedCreditRefundMethod) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["BANK_TRANSFER"]);
  });

  test("the request is sent as BANK_TRANSFER", async () => {
    stubs.status = baseStatus(DOORS_OPEN);
    stubs.credits = [credit];
    renderPanel();
    fireEvent.click(button("RetainedCreditRequestRefund"));
    fireEvent.change(screen.getByLabelText(EN.RetainedCreditRefundAmount), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(EN.RetainedCreditRefundReason), { target: { value: "customer asked" } });
    fireEvent.click(button("RetainedCreditRefundSubmit"));
    await vi.waitFor(() => expect(mutation("retainedCreditRefunds:requestRetainedCreditRefund")).toHaveBeenCalledWith(
      { orgId: "org1", receiptMovementId: "m1", amountMinor: 1000, method: "BANK_TRANSFER", reason: "customer asked" }));
  });
});

/** Drives one of the five money handlers to the point its mutation is awaited. */
const HANDLERS: Record<string, { mutation: string; drive: () => void; fallbackKey: string }> = {
  onRecord: {
    mutation: "collections:recordPayment",
    fallbackKey: "DealReceiptActionFailed",
    drive: () => {
      fireEvent.change(document.getElementById("sale-receipt-amount")!, { target: { value: "10" } });
      fireEvent.click(button("DealReceiptRecordButton"));
    },
  },
  onReserve: {
    mutation: "collections:reserveSaleInvoiceReceipt",
    fallbackKey: "DealReceiptActionFailed",
    drive: () => {
      fireEvent.click(button("DealReceiptChooseCredit"));
      fireEvent.change(document.getElementById("sale-reserve-amount")!, { target: { value: "1" } });
      fireEvent.click(button("DealReceiptReserveButton"));
    },
  },
  onActivate: {
    mutation: "collections:activateSaleInvoiceReceipt",
    fallbackKey: "DealReceiptActionFailed",
    drive: () => fireEvent.click(button("DealReceiptTryActivateButton")),
  },
  onRegisterCheque: {
    mutation: "collections:registerSaleInvoiceCheque",
    fallbackKey: "DealReceiptChequeActionFailed",
    drive: () => {
      fireEvent.change(document.getElementById("sale-cheque-bank")!, { target: { value: "Arab Bank" } });
      fireEvent.change(document.getElementById("sale-cheque-number")!, { target: { value: "77" } });
      fireEvent.change(document.getElementById("sale-cheque-amount")!, { target: { value: "5" } });
      fireEvent.click(button("DealReceiptRegisterCheque"));
    },
  },
  onAdvanceCheque: {
    mutation: "collections:depositCheque",
    fallbackKey: "DealReceiptChequeActionFailed",
    drive: () => fireEvent.click(button("DealReceiptDepositCheque")),
  },
};

const CODES_BY_HANDLER: Array<[string, string]> = [
  ["onRecord", "SALE_INVOICE_RECEIPT_DOORS_DISABLED"],
  ["onReserve", "RETAINED_CREDIT_UNAVAILABLE"],
  ["onReserve", "SALE_INVOICE_RECEIPT_DOORS_DISABLED"],
  ["onActivate", "SALE_INVOICE_RECEIPT_DOORS_DISABLED"],
  ["onRegisterCheque", "SALE_INVOICE_RECEIPT_DOORS_DISABLED"],
  ["onAdvanceCheque", "CHEQUE_INVOICE_UNCOVERED_HELD"],
  ["onAdvanceCheque", "CHEQUE_SALE_CANCELLED_RETURN_TO_CUSTOMER"],
];

function seedForHandlers() {
  stubs.status = baseStatus({ ...DOORS_OPEN, page: [verifiedApplication] });
  stubs.credits = [credit];
  stubs.cheques = [heldCheque];
}

describe("CR-1: the five money handlers surface coded refusals in the user's language", () => {
  test.each(CODES_BY_HANDLER.flatMap(([handler, code]) =>
    (["en", "ar"] as const).map((locale) => [handler, code, locale] as const)))(
    "%s refused with %s (%s) shows the dictionary text, not the server English",
    async (handler, code, locale) => {
      stubs.locale = locale;
      seedForHandlers();
      renderPanel();
      const serverEnglish = `Server English for ${code}`;
      stubs.mutations.get(HANDLERS[handler].mutation)!
        .mockRejectedValueOnce(new ConvexError({ code, message: serverEnglish }));
      HANDLERS[handler].drive();
      const alert = await screen.findByRole("alert");
      const expected = (locale === "ar" ? AR : EN)[`ServerError_${code}`];
      expect(expected, `ServerError_${code} has a ${locale} entry`).toBeTruthy();
      expect(alert.textContent).toBe(expected);
      expect(alert.textContent).not.toContain(serverEnglish);
    });

  test.each(Object.keys(HANDLERS).flatMap((handler) => (["en", "ar"] as const).map((locale) => [handler, locale] as const)))(
    "%s refused with an UNCODED server string (%s) shows the panel's localized message, never the raw string",
    async (handler, locale) => {
      stubs.locale = locale;
      seedForHandlers();
      renderPanel();
      stubs.mutations.get(HANDLERS[handler].mutation)!
        .mockRejectedValueOnce(new ConvexError("Only held cheques can be deposited."));
      HANDLERS[handler].drive();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe((locale === "ar" ? AR : EN)[HANDLERS[handler].fallbackKey]);
      expect(document.body.textContent).not.toContain("Only held cheques can be deposited.");
    });

  test("a success notice is an <output> live region", async () => {
    seedForHandlers();
    renderPanel();
    HANDLERS.onActivate.drive();
    const notice = await screen.findByRole("status");
    expect(notice.tagName).toBe("OUTPUT");
    expect(notice.textContent).toBe(EN.DealReceiptActivated);
  });
});
