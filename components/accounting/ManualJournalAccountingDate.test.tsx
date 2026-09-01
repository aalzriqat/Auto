/**
 * SCRUM-50 — the Manual Journal form declares its accounting date.
 *
 * The backend now REQUIRES an accounting date and refuses a draft without one.
 * If the form did not collect one, that refusal would be a workflow dead end
 * rather than a fix, so the field's existence is part of the correction and is
 * asserted here rather than eyeballed.
 *
 * WHAT IS DELIBERATELY NOT MOCKED: `AccountingTabShared`. It supplies the real
 * `todayInput` and `dateInputToMs`, and those are the two things under test.
 * Stubbing them would make the default and the conversion agree with whatever
 * the stub said and prove nothing — the same trap the sibling opening-balance
 * suite records for `scaleForCurrency`.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { todayDateInput } from "@/lib/dateInput";

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_1" }),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  // Identity `t` so a MISSING translation surfaces as its key rather than
  // silently rendering something plausible.
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/hooks/useCurrency", () => ({ useCurrency: () => ({ code: "JOD" }) }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number) => String(n),
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const stubs = vi.hoisted(() => ({
  // Stable per-function spies. `useMutation: () => vi.fn()` would hand back a
  // FRESH spy on every render, so no test could ever inspect what was sent —
  // the failure mode the sibling container suite records.
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => {
      const name = getFunctionName(reference);
      if (name.includes("getMe")) return { _id: "user_1", name: "Preparer" };
      if (name.includes("chartOfAccounts")) return [];
      return [];
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      if (!stubs.mutations.has(name)) {
        stubs.mutations.set(name, vi.fn().mockResolvedValue({ draftId: "d1" }));
      }
      return stubs.mutations.get(name)!;
    },
  };
});

import { ManualJournalTab } from "./ManualJournalTab";
import { manualJournalSchema } from "./manualJournal.schema";

afterEach(() => {
  cleanup();
  stubs.mutations.clear();
});

function openDialog() {
  render(<ManualJournalTab />);
  fireEvent.click(screen.getByRole("button", { name: /NewManualJournal/ }));
}

describe("SCRUM-50 — the manual journal form declares its accounting date", () => {
  test("the form offers an accounting-date field", () => {
    openDialog();
    // Labelled, so a reviewer can tell what the date means rather than guessing
    // from position.
    expect(screen.getByText("ManualJournalAccountingDate")).toBeTruthy();
  });

  test("it is a real date control, not a free-text box", () => {
    openDialog();
    const input = document.querySelector('input[type="date"]');
    expect(input).toBeTruthy();
  });

  test("it defaults to the user's LOCAL calendar today", () => {
    openDialog();
    const input = document.querySelector('input[type="date"]') as HTMLInputElement;
    // `todayDateInput` deliberately avoids toISOString().slice(0,10): the UTC
    // date reads as YESTERDAY for a user ahead of UTC in the first hours of
    // their day, so the picker would open on the wrong calendar day in Jordan.
    expect(input.value).toBe(todayDateInput());
  });

  test("the hint tells the operator the date drives the period, not the approval day", () => {
    openDialog();
    // This sentence is the whole point of the ticket: the defect persisted
    // because nothing on screen said the date mattered.
    expect(screen.getByText("ManualJournalAccountingDateHint")).toBeTruthy();
  });

  /**
   * ⚠️ THIS REPLACED A VACUOUS TEST, and the reason is worth keeping.
   *
   * The first version cleared the date, clicked submit, and asserted the create
   * mutation was never called. It passed — and it passed just as happily with
   * `accountingDate` made OPTIONAL, which is the control that exposed it. With
   * no accounts mocked, the form ALWAYS fails line validation, so the mutation
   * is unreachable whatever the date does. The assertion was shaped like the
   * outcome and could not distinguish the guard from the fixture.
   *
   * The requirement is asserted against the resolver itself instead, where it
   * flips: made optional, this test fails.
   */
  test("the schema REQUIRES an accounting date — a draft cannot omit it", () => {
    const withoutDate = manualJournalSchema.safeParse({
      memo: "Accrual",
      lines: [
        { id: "1", accountId: "acc_1", side: "DEBIT", amount: 10 },
        { id: "2", accountId: "acc_2", side: "CREDIT", amount: 10 },
      ],
    });
    expect(withoutDate.success).toBe(false);

    const withDate = manualJournalSchema.safeParse({
      accountingDate: "2026-08-31",
      memo: "Accrual",
      lines: [
        { id: "1", accountId: "acc_1", side: "DEBIT", amount: 10 },
        { id: "2", accountId: "acc_2", side: "CREDIT", amount: 10 },
      ],
    });
    // The positive control: the same payload WITH a date must be accepted, so
    // the test above is failing for the missing date and not for some unrelated
    // shape error.
    expect(withDate.success).toBe(true);
  });

  test("an empty date string is rejected, not treated as 'today'", () => {
    const blank = manualJournalSchema.safeParse({
      accountingDate: "",
      memo: "Accrual",
      lines: [
        { id: "1", accountId: "acc_1", side: "DEBIT", amount: 10 },
        { id: "2", accountId: "acc_2", side: "CREDIT", amount: 10 },
      ],
    });
    expect(blank.success).toBe(false);
  });
});
