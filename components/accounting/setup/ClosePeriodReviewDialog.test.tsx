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
import { SUPPLIER_PAYABLES_RECON_DATE_WARNING, SUPPLIER_RECOVERABLES_RECON_FAMILY_WARNING, EMPLOYEE_ADVANCES_RECON_FAMILY_WARNING } from "@/convex/utils/closeWarnings";
import {
  OPENING_DIFFERENCE_WARNING_BY_FAMILY,
  OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY,
  CUSTOMER_DEPOSITS_RECON_UNAVAILABLE_WARNING,
  SUPPLIER_PAYABLES_RECON_INCONSISTENT_REFERENCE_WARNING,
  SUPPLIER_PAYABLES_RECON_OPENING_SOURCE_WARNING,
  SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING,
  SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING,
  UNEXPLAINED_OPENING_DIFFERENCE_LABEL,
  SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING,
} from "@/convex/utils/closeWarnings";

const UNKNOWN_WARNING = "Some future warning the dialog has never heard of.";

const mocks = vi.hoisted(() => ({
  checklist: undefined as unknown,
  close: vi.fn(),
  query: vi.fn(),
  permissions: ["view:finance", "view:cost_price"],
  permissionsLoading: false,
  owner: false,
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => {
    mocks.query(...args);
    return args[1] === "skip" ? undefined : mocks.checklist;
  },
  useMutation: () => mocks.close,
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    isOwner: mocks.owner,
    isLoading: mocks.permissionsLoading,
    hasAllPermissions: (required: string[]) => required.every((p) => mocks.permissions.includes(p)),
  }),
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

describe("SCRUM-902 close checklist access", () => {
  beforeEach(() => {
    mocks.query.mockClear();
    mocks.close.mockReset();
    mocks.checklist = { canClose: true, blockers: [], warnings: [] };
  });
  afterEach(() => {
    cleanup();
    mocks.permissions = ["view:finance", "view:cost_price"];
    mocks.permissionsLoading = false;
    mocks.owner = false;
  });

  test.each(["en", "ar"] as const)("%s withholds the checklist without both finance and cost access", (locale) => {
    for (const permissions of [["view:finance"], ["view:cost_price"]]) {
      mocks.permissions = permissions;
      renderDialog(locale);
      expect(mocks.query.mock.lastCall?.[1]).toBe("skip");
      expect(screen.getByRole("status").textContent).toBe(translator(locale)("FinancialStatementCostAccessRequired"));
      expect(screen.queryByText(translator(locale)("ClosePeriodNoIssues"))).toBeNull();
      expect((screen.getByRole("button", { name: translator(locale)("ClosePeriod") }) as HTMLButtonElement).disabled).toBe(true);
      cleanup();
    }
    expect(mocks.close).not.toHaveBeenCalled();
  });

  test("permission loading skips the query and renders loading without an access denial", () => {
    mocks.permissionsLoading = true;
    renderDialog("en");
    expect(mocks.query.mock.lastCall?.[1]).toBe("skip");
    expect(screen.getByText(translator("en")("Loading"))).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test.each([false, true])("finance and cost access or owner authority reads the checklist (owner: %s)", (owner) => {
    mocks.owner = owner;
    mocks.permissions = owner ? [] : ["view:finance", "view:cost_price"];
    renderDialog("en");
    expect(mocks.query.mock.lastCall?.[1]).toEqual({ orgId: "org1", periodId: "period1" });
    expect(screen.getByText(translator("en")("ClosePeriodNoIssues"))).toBeTruthy();
    expect((screen.getByRole("button", { name: translator("en")("ClosePeriod") }) as HTMLButtonElement).disabled).toBe(false);
  });
});

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

/**
 * SCRUM-858 - the opening-balance reconciliation warnings. The owner-ruled label must reach the
 * screen in both languages, and each warning is acknowledged by its raw English server text.
 */
const OPENING_WARNINGS: ReadonlyArray<readonly [string, string]> = [
  [SUPPLIER_PAYABLES_RECON_DATE_WARNING, "ClosePeriodWarnSupplierPayablesReconDate"],
  [SUPPLIER_RECOVERABLES_RECON_FAMILY_WARNING, "ClosePeriodWarnSupplierRecoverablesReconFamily"],
  [EMPLOYEE_ADVANCES_RECON_FAMILY_WARNING, "ClosePeriodWarnEmployeeAdvancesReconFamily"],
  [SUPPLIER_PAYABLES_RECON_OPENING_SOURCE_WARNING, "ClosePeriodWarnSupplierPayablesReconOpeningSource"],
  [OPENING_DIFFERENCE_WARNING_BY_FAMILY.SUPPLIER_PAYABLES, "ClosePeriodWarnOpeningDiffSupplierPayables"],
  [OPENING_DIFFERENCE_WARNING_BY_FAMILY.EMPLOYEE_ADVANCES, "ClosePeriodWarnOpeningDiffEmployeeAdvances"],
  [OPENING_DIFFERENCE_WARNING_BY_FAMILY.SUPPLIER_RECOVERABLES, "ClosePeriodWarnOpeningDiffSupplierRecoverables"],
  [OPENING_DIFFERENCE_WARNING_BY_FAMILY.PARTNER_CAPITAL, "ClosePeriodWarnOpeningDiffPartnerCapital"],
  [OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY.EMPLOYEE_ADVANCES, "ClosePeriodWarnOpeningReconUnavailableEmployeeAdvances"],
  [OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY.SUPPLIER_RECOVERABLES, "ClosePeriodWarnOpeningReconUnavailableSupplierRecoverables"],
  [OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY.PARTNER_CAPITAL, "ClosePeriodWarnOpeningReconUnavailablePartnerCapital"],
];

describe("ClosePeriodReviewDialog opening-balance reconciliation warnings", () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.close.mockResolvedValue(undefined);
    mocks.checklist = { canClose: true, blockers: [], warnings: OPENING_WARNINGS.map(([text]) => text) };
  });
  afterEach(cleanup);

  test.each(OPENING_WARNINGS)("the English dictionary entry equals the server text exactly: %s", (text, key) => {
    expect((dictionaries.en as Record<string, string>)[key]).toBe(text);
  });

  test("every opening warning renders its Arabic text, and no raw English remains", () => {
    renderDialog("ar");
    const ar = dictionaries.ar as Record<string, string>;
    for (const [text, key] of OPENING_WARNINGS) {
      expect(ar[key]).toBeTruthy();
      expect(screen.getByText(ar[key])).toBeTruthy();
      expect(screen.queryByText(text)).toBeNull();
    }
  });

  test("the difference warnings carry the owner-ruled label in both languages", () => {
    const en = dictionaries.en as Record<string, string>;
    const ar = dictionaries.ar as Record<string, string>;
    for (const [, key] of OPENING_WARNINGS.filter(([, k]) => k.startsWith("ClosePeriodWarnOpeningDiff"))) {
      expect(en[key].startsWith(UNEXPLAINED_OPENING_DIFFERENCE_LABEL.en)).toBe(true);
      expect(ar[key].startsWith(UNEXPLAINED_OPENING_DIFFERENCE_LABEL.ar)).toBe(true);
    }
  });

  test("closing in Arabic acknowledges the raw English server strings", async () => {
    renderDialog("ar");
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: (dictionaries.ar as Record<string, string>).ClosePeriod }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(mocks.close.mock.calls[0][0].acknowledgedWarnings).toEqual(OPENING_WARNINGS.map(([text]) => text));
  });
});

describe("ClosePeriodReviewDialog supplier payables post-cutoff warning (SCRUM-876)", () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.close.mockResolvedValue(undefined);
    mocks.checklist = { canClose: true, blockers: [], warnings: [SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING] };
  });
  afterEach(cleanup);

  test("renders in Arabic and English, and acknowledges the raw server text", async () => {
    const ar = dictionaries.ar as Record<string, string>;
    const en = dictionaries.en as Record<string, string>;
    expect(en.ClosePeriodWarnSupplierPayablesReconPostCutoff).toBe(SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING);
    expect(ar.ClosePeriodWarnSupplierPayablesReconPostCutoff).toBeTruthy();
    expect(ar.ClosePeriodWarnSupplierPayablesReconPostCutoff).not.toBe(en.ClosePeriodWarnSupplierPayablesReconPostCutoff);

    renderDialog("ar");
    expect(screen.getByText(ar.ClosePeriodWarnSupplierPayablesReconPostCutoff)).toBeTruthy();
    expect(screen.queryByText(SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: ar.ClosePeriod }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(mocks.close.mock.calls[0][0].acknowledgedWarnings).toEqual([SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING]);
  });
});

describe("ClosePeriodReviewDialog customer deposits warning (SCRUM-858 F2)", () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.close.mockResolvedValue(undefined);
    mocks.checklist = { canClose: true, blockers: [], warnings: [CUSTOMER_DEPOSITS_RECON_UNAVAILABLE_WARNING] };
  });
  afterEach(cleanup);

  test("renders the unavailable-comparison warning in Arabic and English, and acknowledges the raw server text", async () => {
    const ar = dictionaries.ar as Record<string, string>;
    const en = dictionaries.en as Record<string, string>;
    expect(en.ClosePeriodWarnCustomerDepositsReconUnavailable).toBe(CUSTOMER_DEPOSITS_RECON_UNAVAILABLE_WARNING);
    expect(ar.ClosePeriodWarnCustomerDepositsReconUnavailable).toBeTruthy();
    expect(ar.ClosePeriodWarnCustomerDepositsReconUnavailable).not.toBe(en.ClosePeriodWarnCustomerDepositsReconUnavailable);

    renderDialog("ar");
    expect(screen.getByText(ar.ClosePeriodWarnCustomerDepositsReconUnavailable)).toBeTruthy();
    expect(screen.queryByText(CUSTOMER_DEPOSITS_RECON_UNAVAILABLE_WARNING)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: ar.ClosePeriod }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(mocks.close.mock.calls[0][0].acknowledgedWarnings).toEqual([CUSTOMER_DEPOSITS_RECON_UNAVAILABLE_WARNING]);
  });
});
/**
 * SCRUM-889 (round-3 M1). An INCONSISTENT_REFERENCE or OPENING_SOURCE_UNAVAILABLE supplier-payables result
 * used to reach this dialog as the "too many records" text, so the signed close record named the wrong cause.
 * Each now has its own server text (the acknowledgement key) and its own EN and AR display key, and neither
 * renders as the "too many records" message.
 */
describe.each([
  {
    name: "inconsistent journal reference",
    warning: SUPPLIER_PAYABLES_RECON_INCONSISTENT_REFERENCE_WARNING,
    key: "ClosePeriodWarnSupplierPayablesReconInconsistentReference",
  },
  {
    name: "opening-balance source unavailable",
    warning: SUPPLIER_PAYABLES_RECON_OPENING_SOURCE_WARNING,
    key: "ClosePeriodWarnSupplierPayablesReconOpeningSource",
  },
])("ClosePeriodReviewDialog supplier payables $name warning (SCRUM-889)", ({ warning, key }) => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.close.mockResolvedValue(undefined);
    mocks.checklist = { canClose: true, blockers: [], warnings: [warning] };
  });
  afterEach(cleanup);

  test("has its own text, is not the too-many-records text, renders in EN and AR, and acknowledges the raw server text", async () => {
    const ar = dictionaries.ar as Record<string, string>;
    const en = dictionaries.en as Record<string, string>;
    expect(warning).toBeTruthy();
    expect(warning).not.toBe(SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING);
    expect(en[key]).toBe(warning);
    expect(ar[key]).toBeTruthy();
    expect(ar[key]).not.toBe(en[key]);
    expect(ar[key]).not.toBe(ar.ClosePeriodWarnSupplierPayablesReconTooMany);

    renderDialog("en");
    expect(screen.getByText(warning)).toBeTruthy();
    cleanup();

    renderDialog("ar");
    expect(screen.getByText(ar[key])).toBeTruthy();
    expect(screen.queryByText(warning)).toBeNull();
    expect(screen.queryByText(ar.ClosePeriodWarnSupplierPayablesReconTooMany)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: ar.ClosePeriod }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(mocks.close.mock.calls[0][0].acknowledgedWarnings).toEqual([warning]);
  });
});
