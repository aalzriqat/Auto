import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import { newApplication, seedFinancedDealership } from "@/test-utils/financedDealFixture";
import { FirstPaymentEvidenceCard } from "./FirstPaymentEvidenceCard";

const { mutation, applyIdentity, query, lenderQuery, identityQuery, language } = vi.hoisted(() => ({
  mutation: vi.fn(), applyIdentity: vi.fn(), query: vi.fn(), lenderQuery: vi.fn(), identityQuery: vi.fn(),
  language: { isRtl: false },
}));

vi.mock("convex/react", () => ({
  useQuery: (reference: FunctionReference<"query">, args: unknown) => {
    const name = getFunctionName(reference);
    if (name === "deliveredLenderCorrections:detail") return lenderQuery(args) ?? null;
    if (name === "deliveredDealIdentityCorrections:detail") return identityQuery(args) ?? null;
    return query(args) ?? {
      proof: { status: "BLOCKED", requiredMinor: 550_000, heldMinor: 200_000, directMinor: 0 },
      canConfirm: true, canVoid: true, closed: false, records: [],
    };
  },
  useMutation: (reference: FunctionReference<"mutation">) =>
    getFunctionName(reference) === "financeIdentityBeforeHandover:applyCorrection" ? applyIdentity : mutation,
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: language.isRtl, locale: language.isRtl ? "ar" : "en" }),
}));

function translate(strings: typeof salesAr | typeof salesEn) {
  const entries = new Map(Object.entries(strings));
  return (key: string) => entries.get(key) ?? key;
}

async function lenderCardIds() {
  const modules = import.meta.glob("../../../convex/**/*.ts");
  const s = await seedFinancedDealership("lender-correction-card", {
    modules, ownerPerms: [], actors: {}, label: "Lender correction card", vinPrefix: "LENDER-CARD",
  });
  const { applicationId, quoteId } = await newApplication(s);
  const correction = {
    orgId: s.orgId, applicationId, originalQuoteId: quoteId, replacementQuoteId: quoteId,
    originalCompanyId: s.companyId, replacementCompanyId: s.companyId,
    handoverAt: 1, economicsStamp: "test-stamp", reason: "Customer request",
    requestedBy: s.owner.userId, requestedAt: 2, status: "PENDING" as const,
  };
  const [correctionId, secondCorrectionId] = await s.t.run(async (ctx) => [
    await ctx.db.insert("deliveredLenderCorrections", correction),
    await ctx.db.insert("deliveredLenderCorrections", correction),
  ]);
  return { orgId: s.orgId, applicationId, quoteId, correctionId, secondCorrectionId };
}

let lenderIds: Awaited<ReturnType<typeof lenderCardIds>>;
beforeAll(async () => { lenderIds = await lenderCardIds(); });

afterEach(() => {
  cleanup();
  query.mockReset();
  lenderQuery.mockReset();
  identityQuery.mockReset();
  mutation.mockReset();
  applyIdentity.mockReset();
  language.isRtl = false;
});

test("the independent lender approver can confirm in the Arabic RTL dialog", () => {
  language.isRtl = true;
  const { orgId, applicationId, correctionId } = lenderIds;
  const t = translate(salesAr);
  lenderQuery.mockReturnValue({
    kind: "PENDING", correctionId, lenderName: "جهة تمويل بديلة", reason: "طلب العميل", canApprove: true,
  });
  render(<FirstPaymentEvidenceCard {...{ orgId, applicationId, t }} factor={1000} money={String} />);
  fireEvent.click(screen.getByRole("button", { name: salesAr.DeliveredLenderApprove }));
  const dialog = screen.getByRole("dialog", { name: salesAr.DeliveredLenderApprove });
  expect(dialog.getAttribute("dir")).toBe("rtl");
  fireEvent.change(within(dialog).getByLabelText(salesAr.DeliveredLenderReference), { target: { value: "RL-541" } });
  fireEvent.click(within(dialog).getByRole("button", { name: salesAr.DeliveredLenderApprove }));
  expect(mutation).toHaveBeenCalledWith({
    orgId, correctionId, lenderApprovalReference: "RL-541", idempotencyKey: expect.any(String),
  });
});

test.each([false, true])("the Arabic identity correction uses the opened deal version, lender confirmation %s", (requiresLenderConfirmation) => {
  const { orgId, applicationId, quoteId } = lenderIds;
  language.isRtl = true;
  identityQuery.mockReturnValue({
    state: "AVAILABLE_BEFORE_HANDOVER", updatedAt: 13, economicsStamp: "v2|0",
    ...(requiresLenderConfirmation ? { requiresLenderConfirmation: true } : {}),
    options: [{ quoteId, label: "العميل البديل", quotedAt: 13 }],
  });
  render(<FirstPaymentEvidenceCard {...{ orgId, applicationId }} t={translate(salesAr)} factor={1000} money={String} />);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("option", { name: /العميل البديل/ }), { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: salesAr.IdentityBeforeHandoverApply }));
  const dialog = screen.getByRole("dialog", { name: salesAr.IdentityBeforeHandoverApply });
  expect(dialog.getAttribute("dir")).toBe("rtl");
  expect(within(dialog).queryByLabelText(salesAr.DeliveredIdentityReturnTime)).toBeNull();
  fireEvent.change(within(dialog).getByLabelText(salesAr.DeliveredIdentityReason), { target: { value: "عرض جديد معتمد" } });
  const submit = within(dialog).getByRole("button", { name: salesAr.IdentityBeforeHandoverApply });
  if (requiresLenderConfirmation) {
    fireEvent.click(submit);
    expect(applyIdentity).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(salesAr.IdentityBeforeHandoverLenderReference), { target: { value: "  FC-42  " } });
  } else {
    expect(within(dialog).queryByLabelText(salesAr.IdentityBeforeHandoverLenderReference)).toBeNull();
  }
  fireEvent.click(submit);
  expect(applyIdentity).toHaveBeenCalledWith({
    orgId, applicationId, replacementQuoteId: quoteId, expectedUpdatedAt: 13, expectedEconomicsStamp: "v2|0",
    reason: "عرض جديد معتمد", idempotencyKey: expect.any(String),
    ...(requiresLenderConfirmation ? { lenderConfirmationReference: "FC-42" } : {}),
  });
  expect(mutation).not.toHaveBeenCalled();
});

test("the Arabic funded correction sends the opened lender receipt and a confirmed full refund", () => {
  const { orgId, applicationId, quoteId } = lenderIds;
  language.isRtl = true;
  identityQuery.mockReturnValue({
    state: "BLOCKED",
    lenderReturn: {
      updatedAt: 13, economicsStamp: "v2|0", requiresLenderConfirmation: true,
      originalReceipt: {
        paymentId: "original-receipt", receiptStamp: "reviewed-receipt", amountMinor: 350_000,
        reference: "LENDER ORIGINAL", currency: "JOD", paidAt: Date.parse("2026-11-18T11:01:00Z"),
      },
      showroomRefund: { amountMinor: 200_000, refundedAt: Date.parse("2026-11-19T09:30:00Z") },
      options: [{ quoteId, label: "العميل البديل", quotedAt: 13 }],
    },
  });
  render(<FirstPaymentEvidenceCard {...{ orgId, applicationId }} t={translate(salesAr)} factor={1000} money={String} />);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("option", { name: /العميل البديل/ }), { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: salesAr.IdentityBeforeHandoverApply }));
  const dialog = screen.getByRole("dialog", { name: salesAr.IdentityBeforeHandoverApply });
  expect(dialog.getAttribute("dir")).toBe("rtl");
  expect(within(dialog).getByText("LENDER ORIGINAL")).toBeTruthy();
  expect(within(dialog).getByText(salesAr.IdentityBeforeHandoverShowroomRefundRecorded)).toBeTruthy();
  expect(within(dialog).getByText("200000")).toBeTruthy();
  expect(within(dialog).getByText("350000")).toBeTruthy();
  expect(dialog.classList.contains("overflow-y-auto")).toBe(true);
  const refundedAt = "2026-11-19T14:00:00";
  const refundTime = within(dialog).getByLabelText(salesAr.IdentityBeforeHandoverRefundTime);
  fireEvent.change(refundTime, { target: { value: "2026-11-16T14:00:00" } });
  expect(refundTime.getAttribute("aria-invalid")).toBe("true");
  expect(within(dialog).getByRole("alert").textContent).toContain("الاسترداد");
  fireEvent.change(refundTime, { target: { value: refundedAt } });
  const refundReference = within(dialog).getByLabelText(salesAr.IdentityBeforeHandoverRefundReference);
  fireEvent.change(refundReference, { target: { value: "   " } });
  expect(refundReference.getAttribute("aria-invalid")).toBe("true");
  expect(within(dialog).getByRole("alert").textContent).toContain("مرجع الاسترداد");
  fireEvent.change(refundReference, { target: { value: "REFUND-7" } });
  fireEvent.change(within(dialog).getByLabelText(salesAr.IdentityBeforeHandoverLenderReference), { target: { value: "TERMS-7" } });
  fireEvent.change(within(dialog).getByLabelText(salesAr.DeliveredIdentityReason), { target: { value: "عرض جديد معتمد" } });
  const submit = within(dialog).getByRole("button", { name: salesAr.IdentityBeforeHandoverApply });
  fireEvent.click(submit);
  expect(applyIdentity).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: salesAr.IdentityBeforeHandoverRefundVerify }));
  fireEvent.click(submit);
  expect(applyIdentity).toHaveBeenCalledExactlyOnceWith({
    orgId, applicationId, replacementQuoteId: quoteId, expectedUpdatedAt: 13, expectedEconomicsStamp: "v2|0",
    reason: "عرض جديد معتمد", idempotencyKey: expect.any(String), lenderConfirmationReference: "TERMS-7",
    lenderReturn: {
      paymentId: "original-receipt", receiptStamp: "reviewed-receipt", amountMinor: 350_000,
      reference: "REFUND-7", refundedAt: Date.parse(refundedAt), verifiedSamePayer: true,
    },
  });
});

test.each([
  { rtl: false, messages: salesEn, buyer: "Replacement buyer" },
  { rtl: true, messages: salesAr, buyer: "العميل البديل" },
])("showroom-only refund submits the reviewed proof without requesting a lender refund in RTL=$rtl", ({ rtl, messages, buyer }) => {
  const { orgId, applicationId, quoteId } = lenderIds;
  language.isRtl = rtl;
  identityQuery.mockReturnValue({
    state: "AVAILABLE_BEFORE_HANDOVER", updatedAt: 13, economicsStamp: "v2|0", requiresLenderConfirmation: true,
    showroomRefund: { amountMinor: 200_000, refundedAt: Date.parse("2026-11-19T09:30:00Z"), stamp: "reviewed-showroom-refund" },
    options: [{ quoteId, label: buyer, quotedAt: 13 }],
  });
  render(<FirstPaymentEvidenceCard {...{ orgId, applicationId }} t={translate(messages)} factor={1000} money={String} />);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("option", { name: new RegExp(buyer) }), { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: messages.IdentityBeforeHandoverApply }));
  const dialog = screen.getByRole("dialog", { name: messages.IdentityBeforeHandoverApply });
  expect(dialog.getAttribute("dir")).toBe(rtl ? "rtl" : "ltr");
  expect(within(dialog).getByText(messages.IdentityBeforeHandoverShowroomRefundRecorded)).toBeTruthy();
  expect(within(dialog).getByText("200000")).toBeTruthy();
  expect(within(dialog).queryByLabelText(messages.IdentityBeforeHandoverRefundReference)).toBeNull();
  expect(within(dialog).queryByRole("checkbox", { name: messages.IdentityBeforeHandoverRefundVerify })).toBeNull();
  fireEvent.change(within(dialog).getByLabelText(messages.DeliveredIdentityReason), { target: { value: "Terms corrected" } });
  fireEvent.change(within(dialog).getByLabelText(messages.IdentityBeforeHandoverLenderReference), { target: { value: "TERMS-7" } });
  fireEvent.click(within(dialog).getByRole("button", { name: messages.IdentityBeforeHandoverApply }));
  expect(applyIdentity).toHaveBeenCalledExactlyOnceWith({
    orgId, applicationId, replacementQuoteId: quoteId, expectedUpdatedAt: 13, expectedEconomicsStamp: "v2|0",
    reason: "Terms corrected", idempotencyKey: expect.any(String), lenderConfirmationReference: "TERMS-7",
    expectedShowroomRefundStamp: "reviewed-showroom-refund",
  });
});

test("replacement evidence cannot send a time before the agreement or after now", () => {
  const { orgId, applicationId } = lenderIds;
  query.mockReturnValue({
    proof: { status: "BLOCKED", requiredMinor: 500_000, heldMinor: 0, directMinor: 0 },
    replacementAgreementStartsAt: Date.parse("2025-11-20T14:00:00"),
    agreement: "replacement", canConfirm: true, canVoid: true, closed: false, records: [],
  });
  render(<FirstPaymentEvidenceCard {...{ orgId, applicationId }} t={translate(salesEn)} factor={1000} money={String} />);
  fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
  const dialog = screen.getByRole("dialog");
  const date = within(dialog).getByLabelText(salesEn.CustFcPayDateLabel);
  expect(date.getAttribute("type")).toBe("datetime-local");
  fireEvent.change(within(dialog).getByLabelText(salesEn.CustFcPayReferenceLabel), { target: { value: "REPLACEMENT-24" } });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: salesEn.FirstPaymentProofVerifyReplacementAgreement }));
  const submit = within(dialog).getByRole<HTMLButtonElement>("button", { name: salesEn.CustFcPayConfirmAction });
  for (const time of ["2025-11-20T13:59:59", "2099-11-20T14:00:00"]) {
    fireEvent.change(date, { target: { value: time } });
    expect(submit.disabled).toBe(true);
    expect(within(dialog).getByRole("alert").textContent).toContain("replacement agreement");
  }
  expect(mutation).not.toHaveBeenCalled();
  fireEvent.change(date, { target: { value: "2025-11-20T15:10:00" } });
  fireEvent.click(submit);
  expect(mutation).toHaveBeenCalledWith(expect.objectContaining({
    paidAt: Date.parse("2025-11-20T15:10:00"), verifiedReplacementAgreement: true,
  }));
});

test("a repeated local replacement time needs an explicit offset before confirmation", () => {
  vi.stubEnv("TZ", "America/New_York");
  try {
    const { orgId, applicationId } = lenderIds;
    query.mockReturnValue({
      proof: { status: "BLOCKED", requiredMinor: 500_000, heldMinor: 0, directMinor: 0 },
      replacementAgreementStartsAt: Date.parse("2025-11-01T00:00:00Z"),
      agreement: "replacement", canConfirm: true, canVoid: true, closed: false, records: [],
    });
    render(<FirstPaymentEvidenceCard {...{ orgId, applicationId }} t={translate(salesEn)} factor={1000} money={String} />);
    fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(salesEn.CustFcPayDateLabel), { target: { value: "2025-11-02T01:30:00" } });
    fireEvent.change(within(dialog).getByLabelText(salesEn.CustFcPayReferenceLabel), { target: { value: "REPLACEMENT-25" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: salesEn.FirstPaymentProofVerifyReplacementAgreement }));
    const submit = within(dialog).getByRole<HTMLButtonElement>("button", { name: salesEn.CustFcPayConfirmAction });
    expect(submit.disabled).toBe(true);
    const timeOffset = within(dialog).getByRole("combobox", { name: "Time offset from UTC" });
    const secondOccurrence = Date.parse("2025-11-02T06:30:00Z");
    fireEvent.change(timeOffset, { target: { value: String(secondOccurrence) } });
    fireEvent.click(submit);
    expect(mutation).toHaveBeenCalledWith(expect.objectContaining({ paidAt: secondOccurrence }));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("delivered replacement evidence can be corrected to its actual time on the agreement day", () => {
  const { orgId, applicationId } = lenderIds;
  const handoverAt = Date.parse("2025-11-21T18:00:00");
  query.mockReturnValue({
    proof: { status: "PROVEN", requiredMinor: 500_000, heldMinor: 0, directMinor: 500_000 },
    correctionHandoverAt: handoverAt, replacementAgreementStartsAt: Date.parse("2025-11-20T14:00:00"),
    agreement: "replacement", canConfirm: false, canVoid: true, closed: false,
    records: [{ _id: "replacement-proof", status: "CONFIRMED", agreement: "CURRENT", amountMinor: 500_000,
      paidAt: Date.parse("2025-11-21T09:00:00"), reference: "REPLACEMENT-24", kind: "RECEIPT", canCorrectEvidence: true }],
  });
  render(<FirstPaymentEvidenceCard {...{ orgId, applicationId }} t={translate(salesEn)} factor={1000} money={String} />);
  fireEvent.click(screen.getByRole("button", { name: salesEn.FirstPaymentCorrectionRequest }));
  const dialog = screen.getByRole("dialog", { name: salesEn.FirstPaymentCorrectionRequest });
  const date = within(dialog).getByLabelText(salesEn.CustFcPayDateLabel);
  expect(date.getAttribute("type")).toBe("datetime-local");
  fireEvent.change(within(dialog).getByLabelText(salesEn.FirstPaymentCorrectionReason), { target: { value: "Earlier proof on file" } });
  const submit = within(dialog).getByRole<HTMLButtonElement>("button", { name: salesEn.FirstPaymentCorrectionRequest });
  fireEvent.change(date, { target: { value: "2025-11-20T13:30:00" } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(date, { target: { value: "2025-11-20T15:10:00" } });
  fireEvent.click(submit);
  expect(mutation).toHaveBeenCalledWith(expect.objectContaining({
    paidAt: Date.parse("2025-11-20T15:10:00"), expectedHandoverAt: handoverAt,
  }));
});

test("a newly pending correction cannot take over an open confirmation dialog", () => {
  const { orgId, applicationId, correctionId, secondCorrectionId } = lenderIds;
  const t = translate(salesEn);
  const proposal = { kind: "PENDING", lenderName: "Lender", reason: "Customer request", canApprove: true };
  lenderQuery.mockReturnValue({ ...proposal, correctionId });
  const card = () => <FirstPaymentEvidenceCard {...{ orgId, applicationId, t }} factor={1000} money={String} />;
  const { rerender } = render(card());
  fireEvent.click(screen.getByRole("button", { name: salesEn.DeliveredLenderApprove }));
  const dialog = screen.getByRole("dialog", { name: salesEn.DeliveredLenderApprove });
  fireEvent.change(within(dialog).getByLabelText(salesEn.DeliveredLenderReference), { target: { value: "RL-541" } });

  lenderQuery.mockReturnValue({ ...proposal, correctionId: secondCorrectionId });
  rerender(card());
  const approve = within(dialog).getByRole<HTMLButtonElement>("button", { name: salesEn.DeliveredLenderApprove });
  expect(approve.disabled).toBe(true);
  fireEvent.click(approve);
  expect(mutation).not.toHaveBeenCalled();
});

test("the Arabic cockpit can reach an older quote after an empty page", () => {
  const { orgId, applicationId, quoteId } = lenderIds;
  language.isRtl = true;
  lenderQuery.mockImplementation(({ cursor }: { cursor?: string }) => ({
    kind: "AVAILABLE", handoverAt: 1, economicsStamp: "test-stamp",
    ...(cursor === "older"
      ? { replacements: [{ quoteId, name: "جهة التمويل البديلة", termMonths: 48, createdAt: Date.UTC(2026, 6, 28, 12) }] }
      : { replacements: [], nextCursor: "older" }),
  }));
  render(<FirstPaymentEvidenceCard {...{ orgId, applicationId }} t={translate(salesAr)} factor={1000} money={String} />);
  expect(screen.queryByRole("button", { name: salesAr.DeliveredLenderRequest })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: salesAr.DeliveredLenderOlderQuotes }));
  fireEvent.click(screen.getByRole("button", { name: salesAr.DeliveredLenderRequest }));
  const dialog = screen.getByRole("dialog", { name: salesAr.DeliveredLenderRequest });
  fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "ArrowDown" });
  const option = screen.getByRole("option", { name: /28 يوليو 2026/ });
  fireEvent.keyDown(option, { key: "Escape" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: salesAr.DeliveredLenderPreviousQuotes }));
  expect(screen.queryByRole("button", { name: salesAr.DeliveredLenderRequest })).toBeNull();
});

test("the Arabic cockpit shows the recorded-money hold instead of asking for another quote", () => {
  const { orgId, applicationId } = lenderIds;
  language.isRtl = true;
  lenderQuery.mockReturnValue({ kind: "BLOCKED", reason: "RECORDED_MONEY" });
  render(<FirstPaymentEvidenceCard {...{ orgId, applicationId }} t={translate(salesAr)} factor={1000} money={String} />);
  expect(screen.getByText(salesAr.DeliveredLenderMoneyBlocked)).toBeTruthy();
  expect(screen.queryByText(salesAr.DeliveredLenderQuoteNeeded)).toBeNull();
});

test.each(["deal", "quote"] as const)("changing the %s clears the evidence form and uses the new agreement on confirmation", async (changed) => {
  const orgId = "test-org" as Id<"organizations">;
  const first = "test-deal-one" as Id<"financeApplications">;
  const second = changed === "quote" ? first : "test-deal-two" as Id<"financeApplications">;
  const t = translate(salesEn);
  const evidence = {
    proof: { status: "BLOCKED", requiredMinor: 550_000, heldMinor: 200_000, directMinor: 0 },
    canConfirm: true, canVoid: true, closed: false, records: [],
  };
  query.mockReturnValue({ ...evidence, agreement: "test-agreement-one" });
  mutation.mockResolvedValue("confirmed-first-payment");
  const renderCard = (applicationId: Id<"financeApplications">) => (
    <FirstPaymentEvidenceCard orgId={orgId} applicationId={applicationId} factor={1000} money={String} t={t} />
  );
  const { rerender } = render(renderCard(first));
  fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
  fireEvent.change(within(screen.getByRole("dialog")).getByLabelText(salesEn.CustFcPayReferenceLabel), {
    target: { value: "FIRST DEAL RECEIPT" },
  });

  query.mockReturnValue({ ...evidence, agreement: "test-agreement-two" });
  rerender(renderCard(second));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
  expect(screen.queryByDisplayValue("FIRST DEAL RECEIPT")).toBeNull();
  expect(mutation).not.toHaveBeenCalled();
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayReferenceLabel), { target: { value: "CURRENT QUOTE RECEIPT" } });
  fireEvent.click(dialog.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
  expect(mutation).toHaveBeenCalledExactlyOnceWith({
    orgId, applicationId: second, expectedAgreement: "test-agreement-two",
    amountMinor: 350_000, paidAt: expect.any(Number), reference: "CURRENT QUOTE RECEIPT", kind: "RECEIPT",
    idempotencyKey: expect.any(String),
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("first-payment confirmation refuses a response without the agreement", () => {
  const { orgId, applicationId } = lenderIds;
  render(<FirstPaymentEvidenceCard {...{ orgId, applicationId }} t={translate(salesEn)} factor={1000} money={String} />);
  expect(screen.queryByRole("button", { name: salesEn.CustFcPayConfirmAction })).toBeNull();
  expect(screen.getByText(salesEn.ClosingReason_FIRST_PAYMENT_PROOF_UNAVAILABLE)).toBeTruthy();
});

test("the Arabic receipt correction uses RTL and clears when the operator changes deals", () => {
  language.isRtl = true;
  const orgId = "test-org" as Id<"organizations">;
  const first = "test-deal-one" as Id<"financeApplications">;
  const second = "test-deal-two" as Id<"financeApplications">;
  const t = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
  const handoverAt = Date.UTC(2026, 10, 18, 10);
  query.mockImplementation(({ applicationId }: { applicationId: string }) => ({
    proof: { status: "READY", requiredMinor: 350_000, heldMinor: 0, directMinor: 350_000 },
    canConfirm: false, canVoid: true, closed: false, correctionHandoverAt: handoverAt,
    records: [{
      _id: `receipt-${applicationId}`, status: "CONFIRMED", agreement: "CURRENT",
      reference: "Lender receipt 001", kind: "RECEIPT", amountMinor: 350_000,
      paidAt: handoverAt - 86_400_000, canCorrectEvidence: true,
    }],
  }));
  const renderCard = (applicationId: Id<"financeApplications">) => (
    <FirstPaymentEvidenceCard orgId={orgId} applicationId={applicationId} factor={1000} money={String} t={t} />
  );
  const { rerender } = render(renderCard(first));
  fireEvent.click(screen.getByRole("button", { name: salesAr.FirstPaymentCorrectionRequest }));
  const dialog = screen.getByRole("dialog", { name: salesAr.FirstPaymentCorrectionRequest });
  expect(dialog.getAttribute("dir")).toBe("rtl");
  fireEvent.change(within(dialog).getByLabelText(salesAr.FirstPaymentCorrectionReason), { target: { value: "تصحيح التاريخ" } });
  rerender(renderCard(second));
  rerender(renderCard(first));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mutation).not.toHaveBeenCalled();
});
