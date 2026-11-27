/**
 * SCRUM-1013 — the General Ledger journal reads in the user's language.
 *
 * Production (Arabic UI) showed the transfer's idempotency key in «المصدر»,
 * English system memos in «البيان», POSTED/REVERSED badges, English line
 * descriptions with `[REVERSAL]`, "Period: 2026-P2", a bank line with no bank
 * name, and no link between a reversal and its original. These render the
 * screen against the real dictionaries in both locales.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { GeneralLedgerTab } from "./GeneralLedgerTab";

let mockLocale: "en" | "ar" = "ar";
const RAW_KEY = '["pd7pw6","k179v2",null,"JOD",4641000,1795651200000,"4641"]:9a19c2be-0000';

vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    locale: mockLocale,
    isRtl: mockLocale === "ar",
    t: (key: string) => (dictionaries[mockLocale] as Record<string, string>)[key] ?? key,
  }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: false, isOwner: true, hasAllPermissions: () => true }),
}));
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => ({ currencySymbol: "JOD" }) }));

const transfer = {
  from: { kind: "CASH" as const },
  to: { kind: "BANK" as const, bankName: "Arab Bank Amman" },
};
const originalEntry = {
  _id: "je_original", journalNumber: "JE-ORIGINAL1", accountingDate: 1795651200000, memo: "4641",
  sourceType: "treasuryTransfers", sourceId: RAW_KEY, status: "REVERSED", category: "SYSTEM", currency: "JOD",
  display: {
    sourceFamily: "TREASURY_TRANSFER", eventType: "TREASURY_TRANSFER", isReversal: false, note: "4641", transfer,
    reversalOf: null, reversedBy: { journalEntryId: "je_reversal", journalNumber: "JE-REVERSAL1" },
  },
};
const reversalEntry = {
  _id: "je_reversal", journalNumber: "JE-REVERSAL1", accountingDate: 1795737600000,
  memo: "Reversal of journal for TREASURY_TRANSFER: Entered against the wrong bank",
  sourceType: "treasuryTransfers", sourceId: RAW_KEY, status: "POSTED", category: "REVERSAL", currency: "JOD",
  display: {
    sourceFamily: "TREASURY_TRANSFER", eventType: "TREASURY_TRANSFER", isReversal: true,
    note: "Entered against the wrong bank", transfer,
    reversalOf: { journalEntryId: "je_original", journalNumber: "JE-ORIGINAL1" }, reversedBy: null,
  },
};
/** An entry whose display facts could not be built: still never the raw key. */
const legacyEntry = {
  _id: "je_legacy", journalNumber: "JE-LEGACY1", accountingDate: 1795651200000, memo: "Legacy imported memo",
  sourceType: "transactions", sourceId: "k17legacyrawid", status: "POSTED", category: "SYSTEM", display: null,
};
let mockEntries: unknown[] = [originalEntry, reversalEntry, legacyEntry];

const accounts = [
  { _id: "acc_cash", code: "1100", name: "Cash on Hand", nameAr: "النقد في الصندوق" },
  { _id: "acc_bank", code: "1110", name: "Bank Account", nameAr: "الحساب البنكي" },
];
const reversalDetails = {
  entry: reversalEntry,
  event: null,
  period: { _id: "p2", fiscalYear: 2026, periodNumber: 2, startDate: 1793577600000, endDate: 1796255999999 },
  display: reversalEntry.display,
  lines: [
    {
      _id: "l1", accountId: "acc_bank", lineNumber: 1, debitMinor: 0, creditMinor: 4641000, currency: "JOD", scale: 3,
      bankAccountId: "bank_1", description: "[REVERSAL] Transfer in",
      display: { bankName: "Arab Bank Amman", transferLeg: "IN", description: "Transfer in", isReversalLine: true },
    },
    {
      _id: "l2", accountId: "acc_cash", lineNumber: 2, debitMinor: 4641000, creditMinor: 0, currency: "JOD", scale: 3,
      description: "[REVERSAL] Transfer out",
      display: { bankName: null, transferLeg: "OUT", description: "Transfer out", isReversalLine: true },
    },
  ],
};

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference as never);
      if (name === "chartOfAccounts:list") return accounts;
      if (name === "accountingPeriods:list") return [reversalDetails.period];
      if (name === "accountingLedger:getJournalEntry") return reversalDetails;
      return undefined;
    },
    usePaginatedQuery: (reference: unknown, args: unknown) => {
      if (args === "skip") return { results: [], status: "LoadingFirstPage", loadMore: vi.fn() };
      const name = getFunctionName(reference as never);
      if (name === "accountingLedger:listJournalEntries") return { results: mockEntries, status: "Exhausted", loadMore: vi.fn() };
      return { results: [], status: "Exhausted", loadMore: vi.fn() };
    },
  };
});

function rows() {
  return screen.getAllByTestId("journal-entry-row");
}

describe("SCRUM-1013 General Ledger journal in Arabic", () => {
  afterEach(() => {
    cleanup();
    mockLocale = "ar";
    mockEntries = [originalEntry, reversalEntry, legacyEntry];
  });

  test("the source column names the family and never shows the raw source key", () => {
    render(<GeneralLedgerTab />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("treasuryTransfers: [");
    expect(text).not.toContain("treasuryTransfers");
    expect(text).not.toContain(RAW_KEY);
    expect(text).not.toContain("k17legacyrawid");
    const sources = screen.getAllByTestId("journal-entry-source").map((cell) => cell.textContent);
    expect(sources).toEqual(["تحويل بين الحسابات", "تحويل بين الحسابات", "قيد من النظام"]);
  });

  test("the description is built in Arabic with the banks, the typed note and the reversal links", () => {
    render(<GeneralLedgerTab />);
    const [original, reversal, legacy] = rows();
    expect(original.textContent).toContain("تحويل بين الحسابات");
    expect(original.textContent).toContain("النقد في الصندوق");
    expect(original.textContent).toContain("Arab Bank Amman");
    expect(original.textContent).toContain("4641");
    expect(original.textContent).toContain("عُكس بالقيد");
    expect(original.textContent).toContain("JE-REVERSAL1");

    expect(reversal.textContent).toContain("عكس: تحويل بين الحسابات");
    expect(reversal.textContent).toContain("يعكس القيد");
    expect(reversal.textContent).toContain("JE-ORIGINAL1");
    expect(reversal.textContent).toContain("Entered against the wrong bank");
    expect(reversal.textContent).not.toContain("Reversal of journal for");

    // No structured facts: the stored sentence is shown unchanged, isolated, not guessed.
    const legacyMemo = legacy.querySelector("[data-testid='journal-entry-memo'] bdi[dir='auto']");
    expect(legacyMemo?.textContent).toBe("Legacy imported memo");
  });

  test("mixed-direction values are isolated so they keep their order inside RTL text", () => {
    render(<GeneralLedgerTab />);
    const [original] = rows();
    const isolated = [...original.querySelectorAll("bdi")].map((node) => node.textContent);
    expect(isolated).toEqual(expect.arrayContaining(["JE-ORIGINAL1", "Arab Bank Amman", "4641", "JE-REVERSAL1"]));
    const number = original.querySelector("[data-testid='journal-entry-number'] bdi");
    expect(number?.getAttribute("dir")).toBe("ltr");
  });

  test("status badges are Arabic", () => {
    render(<GeneralLedgerTab />);
    const statuses = screen.getAllByTestId("journal-entry-status").map((badge) => badge.textContent);
    expect(statuses).toEqual(["معكوس", "مُرحّل", "مُرحّل"]);
    expect(document.body.textContent).not.toMatch(/\bPOSTED\b|\bREVERSED\b/);
  });

  test("the full description stays reachable when the cell truncates", () => {
    render(<GeneralLedgerTab />);
    const memo = rows()[1].querySelector("[data-testid='journal-entry-memo']");
    expect(memo?.getAttribute("title")).toContain("عكس: تحويل بين الحسابات");
    expect(memo?.getAttribute("title")).toContain("Entered against the wrong bank");
  });

  test("the lines dialog shows Arabic account names, the bank, Arabic leg labels and the Arabic period", async () => {
    render(<GeneralLedgerTab />);
    fireEvent.click(screen.getAllByTestId("view-entry-lines-btn")[1]);
    const dialog = await screen.findByRole("dialog");
    const text = dialog.textContent ?? "";
    expect(text).toContain("النقد في الصندوق");
    expect(text).toContain("الحساب البنكي");
    expect(text).toContain("Arab Bank Amman");
    expect(text).toContain("تحويل وارد");
    expect(text).toContain("تحويل صادر");
    expect(text).toContain("الفترة");
    expect(text).not.toContain("[REVERSAL]");
    expect(text).not.toContain("Transfer in");
    expect(text).not.toContain("Period:");
    expect(text).not.toContain("treasuryTransfers");
    const bankLine = screen.getAllByTestId("journal-line-row")[0];
    expect(bankLine.querySelector("[data-testid='line-bank'] bdi")?.textContent).toBe("Arab Bank Amman");
  });
});

describe("SCRUM-1013 General Ledger journal in English", () => {
  afterEach(() => {
    cleanup();
    mockLocale = "ar";
  });

  test("English renders the same facts in English and never the raw key", () => {
    mockLocale = "en";
    render(<GeneralLedgerTab />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("treasuryTransfers");
    expect(text).not.toContain(RAW_KEY);
    const [original, reversal] = rows();
    expect(original.textContent).toContain("Transfer between accounts");
    expect(original.textContent).toContain("Cash on hand");
    expect(original.textContent).toContain("Reversed by");
    expect(reversal.textContent).toContain("Reversal: Transfer between accounts");
    expect(reversal.textContent).toContain("Reverses");
    expect(screen.getAllByTestId("journal-entry-source")[0].textContent).toBe("Treasury transfer");
    expect(screen.getAllByTestId("journal-entry-status").map((badge) => badge.textContent)).toEqual(["Reversed", "Posted", "Posted"]);
  });
});
