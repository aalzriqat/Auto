import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GeneralLedgerTab } from "./GeneralLedgerTab";

let mockOrgCurrency = "JOD";
let mockEntryDetails: any = null;

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
      if (name === "accountingLedger:listJournalEntries") {
        return [
          {
            _id: "je_1",
            journalNumber: "JE-001",
            accountingDate: 1726531200000,
            memo: "Test Journal Entry",
            sourceType: "MANUAL",
            sourceId: "user_1",
            status: "POSTED",
          },
        ];
      }
      if (name === "chartOfAccounts:list") {
        return mockAccounts;
      }
      if (name === "accountingLedger:getJournalEntry") {
        return mockEntryDetails;
      }
      return undefined;
    },
    usePaginatedQuery: () => ({
      results: [],
      status: "Done",
      loadMore: vi.fn(),
    }),
  };
});

import { fireEvent, waitFor } from "@testing-library/react";

describe("GeneralLedgerTab - Currency and Scale Invariants", () => {
  afterEach(() => {
    cleanup();
    mockOrgCurrency = "JOD";
    mockEntryDetails = null;
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
