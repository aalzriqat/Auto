import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import { newApplication, seedFinancedDealership } from "@/test-utils/financedDealFixture";
import { FirstPaymentEvidenceCard } from "./FirstPaymentEvidenceCard";

const { mutation, query, lenderQuery, language } = vi.hoisted(() => ({
  mutation: vi.fn(), query: vi.fn(), lenderQuery: vi.fn(), language: { isRtl: false },
}));

vi.mock("convex/react", () => ({
  useQuery: (reference: FunctionReference<"query">, args: unknown) =>
    getFunctionName(reference) === "deliveredLenderCorrections:detail" ? lenderQuery(args) ?? null : query(args) ?? ({
    proof: { status: "BLOCKED", requiredMinor: 550_000, heldMinor: 200_000, directMinor: 0 },
    canConfirm: true, canVoid: true, closed: false, records: [],
  }),
  useMutation: () => mutation,
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
  mutation.mockReset();
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

test("opening another ready-to-render deal clears the previous evidence form", () => {
  const orgId = "test-org" as Id<"organizations">;
  const first = "test-deal-one" as Id<"financeApplications">;
  const second = "test-deal-two" as Id<"financeApplications">;
  const t = (key: string) => (salesEn as Record<string, string>)[key] ?? key;
  const renderCard = (applicationId: Id<"financeApplications">) => (
    <FirstPaymentEvidenceCard orgId={orgId} applicationId={applicationId} factor={1000} money={String} t={t} />
  );
  const { rerender } = render(renderCard(first));
  fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
  fireEvent.change(within(screen.getByRole("dialog")).getByLabelText(salesEn.CustFcPayReferenceLabel), {
    target: { value: "FIRST DEAL RECEIPT" },
  });

  rerender(renderCard(second));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
  expect(screen.queryByDisplayValue("FIRST DEAL RECEIPT")).toBeNull();
  expect(mutation).not.toHaveBeenCalled();
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
