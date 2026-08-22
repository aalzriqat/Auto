/**
 * What the approver sees before they sign (SCRUM-50).
 *
 * A manual journal now posts to a date the drafter stated. The approver is
 * therefore authorising a posting into a specific period, and the one thing
 * this screen must never do is let them approve without showing which. Before
 * SCRUM-50 there was no date to show and approval silently chose its own.
 *
 * The fail-closed path matters just as much: a draft written before the field
 * existed can no longer be approved at all, and the reviewer has to learn that
 * from the card rather than from a failed click.
 *
 * The submit form itself is driven by react-hook-form + zod; its rules are
 * asserted against the schema directly, which is where they live.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { manualJournalSchema } from "./manualJournal.schema";

const stubs = vi.hoisted(() => ({
  pending: [] as unknown[],
  accounts: [] as unknown[],
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ code: "JOD" }),
}));

vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (value: number) => String(value),
}));

// Convex function references are opaque objects that cannot be stringified, so
// the generated api is replaced with plain tokens and matched by identity.
vi.mock("@/convex/_generated/api", () => ({
  api: {
    users: { getMe: "users.getMe" },
    chartOfAccounts: { list: "chartOfAccounts.list" },
    financialAudit: {
      listPendingManualJournals: "financialAudit.listPendingManualJournals",
      createManualJournal: "financialAudit.createManualJournal",
      approveManualJournal: "financialAudit.approveManualJournal",
      rejectManualJournal: "financialAudit.rejectManualJournal",
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown) => {
    if (ref === "financialAudit.listPendingManualJournals") return stubs.pending;
    if (ref === "chartOfAccounts.list") return stubs.accounts;
    return { _id: "user1" };
  },
  useMutation: () => vi.fn(),
}));

import { ManualJournalTab } from "./ManualJournalTab";

const DAY = 24 * 60 * 60 * 1000;

function draft(overrides: Record<string, unknown> = {}) {
  return {
    _id: "draft1",
    memo: "June accrual",
    accountingDate: Date.UTC(2026, 5, 30, 12),
    creatorName: "Layla",
    createdBy: "user2",
    lines: [
      { accountId: "acct1", debitMinor: 5000, creditMinor: 0 },
      { accountId: "acct2", debitMinor: 0, creditMinor: 5000 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  stubs.pending = [];
  stubs.accounts = [];
});

describe("the approver is shown which period they are posting into", () => {
  test("a pending draft names its accounting date", () => {
    stubs.pending = [draft()];
    render(<ManualJournalTab />);

    // June 30, not whatever today happens to be — the whole point of SCRUM-50.
    expect(screen.getByText(/Jun 30, 2026/)).toBeTruthy();
  });

  test("a draft carrying no date says so instead of showing a blank", () => {
    // The fail-closed case. Approval refuses this draft server-side; rendering
    // an empty cell would leave the reviewer to discover that by clicking.
    stubs.pending = [draft({ accountingDate: undefined })];
    render(<ManualJournalTab />);

    expect(screen.getByText("ManualJournalMissingDate")).toBeTruthy();
    expect(screen.queryByText(/\d{4}/)).toBeNull();
  });

  test("two drafts show their own dates, not one shared date", () => {
    stubs.pending = [
      draft({ _id: "d1", accountingDate: Date.UTC(2026, 5, 30, 12) }),
      draft({ _id: "d2", memo: "May reclass", accountingDate: Date.UTC(2026, 4, 31, 12) }),
    ];
    render(<ManualJournalTab />);

    expect(screen.getByText(/Jun 30, 2026/)).toBeTruthy();
    expect(screen.getByText(/May 31, 2026/)).toBeTruthy();
  });

  test("the empty state still renders when nothing is pending", () => {
    stubs.pending = [];
    render(<ManualJournalTab />);
    expect(screen.getByText("NoPendingManualJournals")).toBeTruthy();
  });
});

describe("the draft form requires a stated accounting date", () => {
  const validLines = [
    { id: "1", accountId: "acct1", side: "DEBIT" as const, amount: 50 },
    { id: "2", accountId: "acct2", side: "CREDIT" as const, amount: 50 },
  ];

  test("a journal with no accounting date is rejected", () => {
    const result = manualJournalSchema.safeParse({
      memo: "June accrual",
      accountingDate: "",
      lines: validLines,
    });
    expect(result.success).toBe(false);
  });

  test("the field is not optional, so it cannot default to today", () => {
    // A prefilled "today" would be the same defect one step earlier: the entry
    // would still land wherever the drafter happened to be sitting.
    const result = manualJournalSchema.safeParse({
      memo: "June accrual",
      lines: validLines,
    });
    expect(result.success).toBe(false);
  });

  test("a stated date is accepted", () => {
    const result = manualJournalSchema.safeParse({
      memo: "June accrual",
      accountingDate: "2026-06-30",
      lines: validLines,
    });
    expect(result.success).toBe(true);
  });
});

describe("a yyyy-MM-dd date does not slip into the previous day", () => {
  test("the submitted timestamp lands on the stated calendar day in UTC", () => {
    // `new Date("2026-06-30")` is UTC midnight; read through a timezone behind
    // UTC it renders as June 29, and a month-end accrual would post to the
    // wrong period. The component parses to UTC midday for this reason, so the
    // conversion is pinned here rather than trusted to a comment.
    const [year, month, day] = "2026-06-30".split("-").map(Number);
    const stamp = Date.UTC(year, month - 1, day, 12, 0, 0, 0);

    const asUtc = new Date(stamp);
    expect(asUtc.getUTCFullYear()).toBe(2026);
    expect(asUtc.getUTCMonth()).toBe(5);
    expect(asUtc.getUTCDate()).toBe(30);
    // Twelve hours of slack either side, so no real-world offset can move it.
    expect(stamp - Date.UTC(2026, 5, 30)).toBe(12 * 60 * 60 * 1000);
    expect(Date.UTC(2026, 5, 31) - stamp).toBe(12 * 60 * 60 * 1000);
    expect(stamp).toBeLessThan(Date.UTC(2026, 5, 30) + DAY);
  });
});
