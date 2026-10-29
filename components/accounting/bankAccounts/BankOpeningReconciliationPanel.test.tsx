/**
 * SCRUM-858 S5 + S2 display (owner ruling SCRUM-858#c23884). The native bank screen shows each bank's posted opening
 * beside the balance the dealership stated, and any unexplained difference under the owner's exact label in the
 * reader's language. The panel is display only. The vehicle record shows an "Opening cost" marker for an owned car
 * whose cost came from an approved opening balance and never for a consigned (SOURCED) car.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { UNEXPLAINED_OPENING_DIFFERENCE_LABEL } from "@/convex/utils/closeWarnings";

const language = vi.hoisted(() => ({ locale: "en" as "en" | "ar" }));

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries: dicts } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      locale: language.locale,
      isRtl: language.locale === "ar",
      t: (key: string) => (dicts as Record<string, Record<string, string>>)[language.locale][key] ?? key,
    }),
  };
});

import { BankOpeningReconciliationPanel } from "./BankOpeningReconciliationPanel";
import { hasOpeningCost, OpeningCostBadge } from "@/components/vehicles/OpeningCostBadge";

afterEach(() => {
  cleanup();
  language.locale = "en";
});

type Reconciliation = Parameters<typeof BankOpeningReconciliationPanel>[0]["reconciliation"];

const formatMinor = (minor: number, currency: string) => `${currency} ${minor}`;

function bankRow(id: string, name: string, posted: number | null, stated: number, difference: number | null) {
  return {
    bankAccountId: id,
    name,
    currency: "JOD",
    isActive: true,
    openingLineMinor: posted,
    referenceOpeningMinor: stated,
    differenceMinor: difference,
  };
}

function reconciliation(overrides: Record<string, unknown>): Reconciliation {
  return {
    status: "OK",
    currency: "JOD",
    controlOpeningMinor: 0,
    bankLinesTotalMinor: 0,
    unattributedOpeningMinor: 0,
    banks: [],
    unexplainedOpeningDifference: null,
    ...overrides,
  } as unknown as Reconciliation;
}

describe("BankOpeningReconciliationPanel", () => {
  test("a reconciled opening lists each bank and shows no difference block", () => {
    render(
      <BankOpeningReconciliationPanel
        formatMinor={formatMinor}
        reconciliation={reconciliation({
          banks: [bankRow("b1", "Arab Bank", 4_000_000, 4_000_000, 0), bankRow("b2", "Housing Bank", 3_000_000, 3_000_000, 0)],
        })}
      />
    );
    const panel = screen.getByTestId("opening-bank-panel");
    expect(within(panel).getByTestId("opening-bank-row-b1").textContent).toContain("Arab Bank");
    expect(within(panel).getByTestId("opening-bank-row-b2").textContent).toContain("JOD 3000000");
    expect(screen.queryByTestId("opening-bank-difference")).toBeNull();
    expect(screen.queryByTestId("opening-bank-unattributed")).toBeNull();
  });

  test("an unexplained difference shows the owner's English label, net and absolute, and the report-only note", () => {
    render(
      <BankOpeningReconciliationPanel
        formatMinor={formatMinor}
        reconciliation={reconciliation({
          banks: [bankRow("b1", "Arab Bank", 4_000_000, 4_100_000, 100_000)],
          unexplainedOpeningDifference: {
            label: UNEXPLAINED_OPENING_DIFFERENCE_LABEL,
            currencies: [{ currency: "JOD", differenceMinor: 100_000, absoluteDifferenceMinor: 100_000 }],
          },
        })}
      />
    );
    const block = screen.getByTestId("opening-bank-difference");
    expect(block.textContent).toContain("Unexplained opening-balance reconciliation difference");
    expect(block.textContent).toContain("Net: JOD 100000");
    expect(block.textContent).toContain("Total of differences: JOD 100000");
    expect(block.textContent).toContain("Reported only. Nothing is posted and no balance is changed.");
  });

  test("in Arabic the owner's Arabic label and Arabic column headings are used", () => {
    language.locale = "ar";
    render(
      <BankOpeningReconciliationPanel
        formatMinor={formatMinor}
        reconciliation={reconciliation({
          banks: [bankRow("b1", "البنك العربي", 4_000_000, 4_100_000, 100_000)],
          unexplainedOpeningDifference: {
            label: UNEXPLAINED_OPENING_DIFFERENCE_LABEL,
            currencies: [{ currency: "JOD", differenceMinor: 100_000, absoluteDifferenceMinor: 100_000 }],
          },
        })}
      />
    );
    expect(screen.getByTestId("opening-bank-difference").textContent).toContain("فرق أرصدة افتتاحية غير مفسر قيد المطابقة");
    expect(screen.getByTestId("opening-bank-panel").textContent).toContain("الرصيد الافتتاحي لكل بنك");
    expect(screen.getByText("المُعلن من المعرض")).toBeTruthy();
    expect(screen.getByText("للإبلاغ فقط. لا يتم ترحيل أي قيد ولا يتغير أي رصيد.")).toBeTruthy();
  });

  test("a bank with no posted opening line shows a dash, not zero", () => {
    render(
      <BankOpeningReconciliationPanel
        formatMinor={formatMinor}
        reconciliation={reconciliation({ banks: [bankRow("b9", "Cairo Amman", null, 500_000, null)] })}
      />
    );
    const row = screen.getByTestId("opening-bank-row-b9");
    expect(row.textContent).toContain("—");
    expect(row.textContent).toContain("JOD 500000");
  });

  test("an opening amount not tied to any bank is called out", () => {
    render(
      <BankOpeningReconciliationPanel
        formatMinor={formatMinor}
        reconciliation={reconciliation({ unattributedOpeningMinor: 250_000, banks: [bankRow("b1", "Arab Bank", 1, 1, 0)] })}
      />
    );
    expect(screen.getByTestId("opening-bank-unattributed").textContent).toContain("JOD 250000");
  });

  test("no opening renders nothing; an unverifiable opening says so instead of showing figures", () => {
    const none = render(<BankOpeningReconciliationPanel formatMinor={formatMinor} reconciliation={reconciliation({ status: "NO_OPENING" })} />);
    expect(none.container.innerHTML).toBe("");
    none.unmount();
    render(<BankOpeningReconciliationPanel formatMinor={formatMinor} reconciliation={reconciliation({ status: "OPENING_PROOF_UNAVAILABLE" })} />);
    expect(screen.getByTestId("opening-bank-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("opening-bank-panel")).toBeNull();
  });
});

describe("opening cost marker on the vehicle record", () => {
  test("owned car with an opening draft shows it; consigned or plain cars never do", () => {
    expect(hasOpeningCost({ openingBalanceDraftId: "d1", sourceType: "STOCK" })).toBe(true);
    expect(hasOpeningCost({ openingBalanceDraftId: "d1" })).toBe(true);
    expect(hasOpeningCost({ openingBalanceDraftId: "d1", sourceType: "SOURCED" })).toBe(false);
    expect(hasOpeningCost({ sourceType: "STOCK" })).toBe(false);
    expect(hasOpeningCost({ openingBalanceDraftId: null })).toBe(false);
  });

  test("badge text is localized", () => {
    render(<OpeningCostBadge />);
    expect(screen.getByTestId("opening-cost-badge").textContent).toContain("Opening cost");
    cleanup();
    language.locale = "ar";
    render(<OpeningCostBadge />);
    expect(screen.getByTestId("opening-cost-badge").textContent).toContain("تكلفة افتتاحية");
  });
});

describe("dictionary parity for the new keys", () => {
  const KEYS = [
    "OpeningBankPanelTitle",
    "OpeningBankPosted",
    "OpeningBankStated",
    "OpeningBankDifference",
    "OpeningBankNet",
    "OpeningBankAbsolute",
    "OpeningBankUnattributed",
    "OpeningBankReportOnly",
    "OpeningBankProofUnavailable",
    "VehicleOpeningCostBadge",
  ];
  test.each(KEYS)("%s exists in English and Arabic and the two differ", (key) => {
    const en = (dictionaries as Record<string, Record<string, string>>).en[key];
    const ar = (dictionaries as Record<string, Record<string, string>>).ar[key];
    expect(en).toBeTruthy();
    expect(ar).toBeTruthy();
    expect(ar).not.toBe(en);
  });
});
