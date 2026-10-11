/**
 * SCRUM-795: with the pilot switch ON the Manual Journal tab tells the user why
 * the feature is off, disables "New manual journal" and "Approve", and keeps
 * "Reject" working so legacy pending drafts can still be cleared.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { MANUAL_JOURNALS_PILOT_DISABLED } from "@/convex/utils/pilotSwitches";
import { ManualJournalTab } from "./ManualJournalTab";

const pendingDraft = {
  _id: "draft_1",
  memo: "Legacy draft",
  creatorName: "Someone Else",
  createdBy: "user_other",
  accountingDate: 1726531200000,
  lines: [
    { accountId: "acc_a", debitMinor: 5000, creditMinor: 0 },
    { accountId: "acc_b", debitMinor: 0, creditMinor: 5000 },
  ],
};

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_123" }),
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/useCurrency", () => ({ useCurrency: () => ({ code: "JOD" }) }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number) => String(n),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: any, args: any) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "users:getMe") return { _id: "user_me" };
      if (name === "chartOfAccounts:list") {
        return [
          { _id: "acc_a", name: "Account A", code: "1", allowManualPosting: true },
          { _id: "acc_b", name: "Account B", code: "2", allowManualPosting: true },
        ];
      }
      if (name === "financialAudit:listPendingManualJournals") return [pendingDraft];
      return undefined;
    },
    useMutation: () => vi.fn(),
  };
});

describe("ManualJournalTab — pilot switch ON", () => {
  afterEach(cleanup);

  test("the shared leaf constant is ON in the shipped build", () => {
    expect(MANUAL_JOURNALS_PILOT_DISABLED).toBe(true);
  });

  test("shows the notice, disables New and Approve, keeps Reject enabled", () => {
    render(<ManualJournalTab />);
    expect(screen.getByTestId("manual-journals-pilot-off-notice").textContent).toBe(
      "ManualJournalsPilotOffNotice"
    );
    expect((screen.getByTestId("new-manual-journal-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("approve-draft-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("reject-draft-btn") as HTMLButtonElement).disabled).toBe(false);
  });

  test("the notice exists in English and Arabic and mentions the owner close override", () => {
    const en = (dictionaries.en as Record<string, string>)["ManualJournalsPilotOffNotice"];
    const ar = (dictionaries.ar as Record<string, string>)["ManualJournalsPilotOffNotice"];
    expect(en).toMatch(/turned off for the pilot/i);
    expect(en).toMatch(/close override/i);
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toBe(en);
  });
});
