import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import { FirstPaymentEvidenceCard } from "./FirstPaymentEvidenceCard";

const { mutation, query, language } = vi.hoisted(() => ({
  mutation: vi.fn(), query: vi.fn(), language: { isRtl: false },
}));

vi.mock("convex/react", () => ({
  useQuery: (_reference: unknown, args: unknown) => query(args) ?? ({
    proof: { status: "BLOCKED", requiredMinor: 550_000, heldMinor: 200_000, directMinor: 0 },
    canConfirm: true, canVoid: true, closed: false, records: [],
  }),
  useMutation: () => mutation,
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: language.isRtl, locale: language.isRtl ? "ar" : "en" }),
}));

afterEach(() => {
  cleanup();
  query.mockReset();
  mutation.mockReset();
  language.isRtl = false;
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
