import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GeneralLedgerTab } from "./GeneralLedgerTab";

let mockOrgCurrency = "JOD";
let mockEntryDetails: any = null;
/** AF-318-01 — the paginated journal-entry page the GL view renders. */
let mockJournalPage: {
  results: any[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
} = {
  results: [
    {
      _id: "je_1",
      journalNumber: "JE-001",
      accountingDate: 1726531200000,
      memo: "Test Journal Entry",
      sourceType: "MANUAL",
      sourceId: "user_1",
      status: "POSTED",
    },
  ],
  status: "Exhausted",
};
let mockLoadMore = vi.fn();
let mockPeriods: any[] = [
  { _id: "period_1", fiscalYear: 2026, periodNumber: 9, startDate: 1725148800000, endDate: 1727740799999 },
];

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_123" }),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
    isRtl: false,
    locale: "en",
  }),
}));

vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({
    currencySymbol: mockOrgCurrency,
  }),
}));

const mockAccounts = [
  { _id: "acc_cash", code: "1010", name: "Cash on Hand" },
  { _id: "acc_rev", code: "4000", name: "Vehicle Sales Revenue" },
];

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: any, args: any) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "chartOfAccounts:list") {
        return mockAccounts;
      }
      if (name === "accountingLedger:getJournalEntry") {
        return mockEntryDetails;
      }
      if (name === "accountingPeriods:list") {
        return mockPeriods;
      }
      return undefined;
    },
    // AF-318-01 — the GL entry list is now real cursor pagination
    // (usePaginatedQuery), not a plain useQuery returning a fixed array. This
    // fake distinguishes it from the Transaction Register's own paginated
    // query by function name, exactly the way a client bug (accidentally
    // reusing one page's status/loadMore for the other view) would NOT be
    // caught if both simply returned the same empty stub.
    usePaginatedQuery: (reference: any, args: any) => {
      if (args === "skip") {
        return { results: [], status: "LoadingFirstPage" as const, loadMore: mockLoadMore };
      }
      const name = getFunctionName(reference);
      if (name === "accountingLedger:listJournalEntries") {
        return { results: mockJournalPage.results, status: mockJournalPage.status, loadMore: mockLoadMore };
      }
      // transactions:list (Transaction Register) — untouched by this suite.
      return { results: [], status: "Exhausted" as const, loadMore: vi.fn() };
    },
  };
});

import { fireEvent, waitFor } from "@testing-library/react";

describe("GeneralLedgerTab - Currency and Scale Invariants", () => {
  afterEach(() => {
    cleanup();
    mockOrgCurrency = "JOD";
    mockEntryDetails = null;
    mockJournalPage = {
      results: [
        {
          _id: "je_1",
          journalNumber: "JE-001",
          accountingDate: 1726531200000,
          memo: "Test Journal Entry",
          sourceType: "MANUAL",
          sourceId: "user_1",
          status: "POSTED",
        },
      ],
      status: "Exhausted",
    };
    mockLoadMore = vi.fn();
    mockPeriods = [
      { _id: "period_1", fiscalYear: 2026, periodNumber: 9, startDate: 1725148800000, endDate: 1727740799999 },
    ];
  });

  test("renders JOD 3-decimal debit and credit with account code and name", async () => {
    mockOrgCurrency = "JOD";
    mockEntryDetails = {
      entry: {
        _id: "je_1",
        journalNumber: "JE-001",
        memo: "Sale in JOD",
        currency: "JOD",
      },
      lines: [
        {
          _id: "line_1",
          accountId: "acc_cash",
          description: "Cash received",
          debitMinor: 123456, // 123.456 JOD
          creditMinor: 0,
          currency: "JOD",
          scale: 3,
        },
        {
          _id: "line_2",
          accountId: "acc_rev",
          description: "Revenue recognized",
          debitMinor: 0,
          creditMinor: 123456, // 123.456 JOD
          currency: "JOD",
          scale: 3,
        },
      ],
    };

    render(<GeneralLedgerTab />);

    fireEvent.click(screen.getByRole("button", { name: /ViewLines/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeDefined();

    // Verify account code and name are rendered together
    expect(screen.getByText("1010")).toBeDefined();
    expect(screen.getByText("(Cash on Hand)")).toBeDefined();
    expect(screen.getByText("4000")).toBeDefined();
    expect(screen.getByText("(Vehicle Sales Revenue)")).toBeDefined();

    // Verify JOD amounts render with 3 decimal places: 123.456 JOD
    expect(dialog.textContent).toMatch(/123\.456.*JOD|JOD.*123\.456/i);
  });

  test("renders an old USD entry in USD even when org currency is now JOD", async () => {
    mockOrgCurrency = "JOD"; // Organization has switched to JOD
    mockEntryDetails = {
      entry: {
        _id: "je_2",
        journalNumber: "JE-002",
        memo: "Historical USD entry",
        currency: "USD",
      },
      lines: [
        {
          _id: "line_usd_1",
          accountId: "acc_cash",
          description: "USD cash",
          debitMinor: 12345, // 123.45 USD (scale 2)
          creditMinor: 0,
          currency: "USD",
          scale: 2,
        },
        {
          _id: "line_usd_2",
          accountId: "acc_rev",
          description: "USD revenue",
          debitMinor: 0,
          creditMinor: 12345, // 123.45 USD (scale 2)
          currency: "USD",
          scale: 2,
        },
      ],
    };

    render(<GeneralLedgerTab />);

    fireEvent.click(screen.getByRole("button", { name: /ViewLines/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/\$123\.45|123\.45\s*USD/);
    expect(dialog.textContent).not.toMatch(/123\.45\s*JOD/);
  });

  test("derives scale 3 for historical JOD line missing scale and does not divide by 100", async () => {
    mockOrgCurrency = "JOD";
    mockEntryDetails = {
      entry: {
        _id: "je_3",
        journalNumber: "JE-003",
        memo: "Legacy JOD without scale",
        currency: "JOD",
      },
      lines: [
        {
          _id: "line_leg_1",
          accountId: "acc_cash",
          description: "Legacy JOD debit",
          debitMinor: 500000, // 500.000 JOD
          creditMinor: 0,
          currency: "JOD",
          // scale is undefined!
        },
      ],
    };

    render(<GeneralLedgerTab />);
    fireEvent.click(screen.getByRole("button", { name: /ViewLines/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/500(\.000)?\s*JOD|JOD\s*500(\.000)?/);
    expect(dialog.textContent).not.toMatch(/5,?000\.000/);
  });

  test("fails visibly when currency and scale are completely unresolvable", async () => {
    mockEntryDetails = {
      entry: {
        _id: "je_4",
        journalNumber: "JE-004",
        memo: "Unresolvable scale",
      },
      lines: [
        {
          _id: "line_bad_1",
          accountId: "acc_cash",
          description: "Corrupt line",
          debitMinor: 99999,
          creditMinor: 0,
          // currency and scale undefined!
        },
      ],
    };

    render(<GeneralLedgerTab />);
    fireEvent.click(screen.getByRole("button", { name: /ViewLines/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/\[Unverified Scale: 99999 minor\]/);
  });
});

/**
 * AF-318-01 — the regression this remediation exists to make impossible: a
 * General Ledger tab that silently caps at a fixed page and gives the
 * accountant no way to reach the rest. These tests fail if pagination is
 * ever replaced with a fixed `limit` again — the whole point of the
 * regression.
 */
describe("GeneralLedgerTab - pagination (AF-318-01)", () => {
  afterEach(() => {
    cleanup();
    mockJournalPage = {
      results: [
        {
          _id: "je_1",
          journalNumber: "JE-001",
          accountingDate: 1726531200000,
          memo: "Test Journal Entry",
          sourceType: "MANUAL",
          sourceId: "user_1",
          status: "POSTED",
        },
      ],
      status: "Exhausted",
    };
    mockLoadMore = vi.fn();
  });

  test("shows a Load More control when the server reports CanLoadMore, and clicking it requests another page", () => {
    mockJournalPage = {
      results: [
        { _id: "je_page1", journalNumber: "JE-100", accountingDate: 1726531200000, memo: "Page one entry", sourceType: "MANUAL", sourceId: "u1", status: "POSTED" },
      ],
      status: "CanLoadMore",
    };

    render(<GeneralLedgerTab />);

    const loadMoreBtn = screen.getByTestId("gl-load-more-btn");
    expect(loadMoreBtn).toBeDefined();
    fireEvent.click(loadMoreBtn);
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });

  test("does not show Load More once the server reports Exhausted, and shows the all-loaded notice instead", () => {
    mockJournalPage = {
      results: [
        { _id: "je_only", journalNumber: "JE-200", accountingDate: 1726531200000, memo: "Only entry", sourceType: "MANUAL", sourceId: "u1", status: "POSTED" },
      ],
      status: "Exhausted",
    };

    render(<GeneralLedgerTab />);

    expect(screen.queryByTestId("gl-load-more-btn")).toBeNull();
    expect(screen.getByTestId("gl-all-loaded")).toBeDefined();
  });

  test("a page appended via Load More renders alongside the first page's rows (simulated second page)", () => {
    // Page 1
    mockJournalPage = {
      results: [
        { _id: "je_p1", journalNumber: "JE-P1", accountingDate: 1726531200000, memo: "Recent entry", sourceType: "MANUAL", sourceId: "u1", status: "POSTED" },
      ],
      status: "CanLoadMore",
    };
    const { rerender } = render(<GeneralLedgerTab />);
    expect(screen.getByText("JE-P1")).toBeDefined();
    expect(screen.queryByText("JE-OLD")).toBeNull();

    // Simulate Convex's usePaginatedQuery growing `results` after loadMore
    // resolves — the exact mechanism the real hook uses (it does not replace
    // page 1, it appends page 2 to the same results array).
    mockJournalPage = {
      results: [
        { _id: "je_p1", journalNumber: "JE-P1", accountingDate: 1726531200000, memo: "Recent entry", sourceType: "MANUAL", sourceId: "u1", status: "POSTED" },
        { _id: "je_old", journalNumber: "JE-OLD", accountingDate: 1700000000000, memo: "Older entry now reachable", sourceType: "MANUAL", sourceId: "u1", status: "POSTED" },
      ],
      status: "Exhausted",
    };
    rerender(<GeneralLedgerTab />);

    // Both the original page-1 row and the newly-reached older row are visible
    // together — proving continuation reaches an entry that was NOT on page 1,
    // without losing the rows already shown.
    expect(screen.getByText("JE-P1")).toBeDefined();
    expect(screen.getByText("JE-OLD")).toBeDefined();
    expect(screen.getByText("Older entry now reachable")).toBeDefined();
  });

  test("the period filter selector is rendered so an accountant can narrow by accounting period", () => {
    render(<GeneralLedgerTab />);
    const periodFilter = screen.getByTestId("gl-period-filter");
    expect(periodFilter).toBeDefined();
    // The seeded period (2026-P9) is offered as an option.
    expect(periodFilter.textContent).not.toMatch(/undefined|NaN/);
  });

  test("the account filter selector is rendered so an accountant can drill into one account", () => {
    render(<GeneralLedgerTab />);
    const accountFilter = screen.getByTestId("gl-account-filter");
    expect(accountFilter).toBeDefined();
  });
});
