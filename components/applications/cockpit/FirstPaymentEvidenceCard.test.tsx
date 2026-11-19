import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { salesEn } from "@/lib/i18n/domains/sales";
import { FirstPaymentEvidenceCard } from "./FirstPaymentEvidenceCard";

const { mutation } = vi.hoisted(() => ({ mutation: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: () => ({
    proof: { status: "BLOCKED", requiredMinor: 550_000, heldMinor: 200_000, directMinor: 0 },
    canConfirm: true, canVoid: true, closed: false, records: [],
  }),
  useMutation: () => mutation,
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

afterEach(cleanup);

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
