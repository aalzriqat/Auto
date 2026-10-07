/**
 * SCRUM-651 - the two "supplier payables reconciliation could not be completed"
 * close warnings were English-only. The dialog renders `checklist.warnings` and
 * sends them back verbatim as `acknowledgedWarnings`, and the close mutation
 * matches them by EXACT string - so the fix has to translate at display time
 * only and keep acknowledging the raw server text.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import {
  SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING,
  SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING,
} from "@/convex/utils/closeWarnings";

const UNKNOWN_WARNING = "Some future warning the dialog has never heard of.";

const mocks = vi.hoisted(() => ({
  checklist: undefined as unknown,
  close: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: () => mocks.checklist,
  useMutation: () => mocks.close,
}));

// DialogContent reads the language context for its close-button label.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../AccountingTabShared", () => ({
  errorMessage: (error: unknown) => String(error),
  DialogFooterActions: (props: {
    confirmLabel: string;
    onConfirm: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={props.onConfirm} disabled={props.disabled}>
      {props.confirmLabel}
    </button>
  ),
}));

import { ClosePeriodReviewDialog } from "./ClosePeriodReviewDialog";

const period = {
  _id: "period1" as never,
  fiscalYear: 2026,
  periodNumber: 3,
  startDate: 0,
  endDate: 1,
  status: "OPEN" as const,
};

function translator(locale: "en" | "ar") {
  return (key: string) =>
    (dictionaries[locale] as Record<string, string>)[key] ||
    (dictionaries.en as Record<string, string>)[key] ||
    key;
}

function renderDialog(locale: "en" | "ar") {
  return render(
    <ClosePeriodReviewDialog
      orgId={"org1" as never}
      period={period}
      open
      isOwner
      onOpenChange={() => undefined}
      onClosed={() => undefined}
      t={translator(locale)}
    />,
  );
}

describe("ClosePeriodReviewDialog supplier payables warnings", () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.close.mockResolvedValue(undefined);
    mocks.checklist = {
      canClose: true,
      blockers: [],
      warnings: [
        SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING,
        SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING,
        UNKNOWN_WARNING,
      ],
    };
  });
  afterEach(cleanup);

  test("renders the two known warnings in Arabic and unknown warnings raw", () => {
    renderDialog("ar");
    const ar = dictionaries.ar as Record<string, string>;
    expect(ar.ClosePeriodWarnSupplierPayablesReconPending).toBeTruthy();
    expect(screen.getByText(ar.ClosePeriodWarnSupplierPayablesReconPending)).toBeTruthy();
    expect(screen.getByText(ar.ClosePeriodWarnSupplierPayablesReconTooMany)).toBeTruthy();
    expect(screen.queryByText(SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING)).toBeNull();
    expect(screen.queryByText(SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING)).toBeNull();
    expect(screen.getByText(UNKNOWN_WARNING)).toBeTruthy();
  });

  test("renders the English text for the known warnings in English", () => {
    renderDialog("en");
    expect(screen.getByText(SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING)).toBeTruthy();
    expect(screen.getByText(SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING)).toBeTruthy();
  });

  test("acknowledge then close in Arabic still sends the raw English server strings", async () => {
    renderDialog("ar");
    const confirm = screen.getByRole("button", { name: (dictionaries.ar as Record<string, string>).ClosePeriod });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(mocks.close.mock.calls[0][0].acknowledgedWarnings).toEqual([
      SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING,
      SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING,
      UNKNOWN_WARNING,
    ]);
  });
});
