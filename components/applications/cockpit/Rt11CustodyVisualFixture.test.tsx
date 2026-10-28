/** SCRUM-760 c23862: finalized movement/reopen refusals and the pre-finalization control. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { CustodyRecordView, DealCustodyActions, DealCustodyWiring } from "./DealCustodyPanel";
import { CustodyMovementsList } from "./CustodyMovementsList";

vi.mock("convex/react", () => ({ usePaginatedQuery: () => ({ results: [{
  _id: "entry-a", kind: "ISSUED", amountMinor: 100000, method: "CASH", occurredAt: 1,
  reversed: false,
}], status: "Exhausted", loadMore: vi.fn() }) }));
const { DealCustodyPanel } = await import(process.env.RT11_CUSTODY_COMPONENT || "./DealCustodyPanel") as typeof import("./DealCustodyPanel");
const money = (minor: number, currency: string) => `${minor / 1000} ${currency}`;
const actions: DealCustodyActions = {
  members: [{ userId: "employee-a" as Id<"users">, name: "Synthetic employee" }],
  eligibleFees: [], scaleOf: () => 3,
  onPlan: vi.fn(), onClearPlan: vi.fn(), onOpen: vi.fn(), onMove: vi.fn(),
  onReverse: vi.fn(), onAttach: vi.fn(), onClose: vi.fn(), onReopen: vi.fn(),
  onAbandonOpen: vi.fn(), onAbandonMove: vi.fn(), onAbandonClose: vi.fn(),
};
const record: CustodyRecordView = {
  _id: "custody-open" as Id<"financeDealCustody">, userId: "employee-a" as Id<"users">,
  userName: "Synthetic employee", currency: "JOD", status: "OPEN", issuedMinor: 100000,
  returnedMinor: 0, reimbursedMinor: 0, summary: { actualExpensesMinor: 150000,
    employeeOwesDealerMinor: 0, reimbursementOutstandingMinor: 50000,
    reimbursementOverpaidMinor: 0, overReturnedMinor: 0, settled: false },
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test.each(["en", "ar"] as const)("RT11 custody markup %s", (locale) => {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  const t = (key: string) => dictionaries[locale][key as keyof typeof dictionaries.en] || key;
  for (const state of ["finalized", "active", "loading", "empty"]) {
    const wiring: DealCustodyWiring = {
      records: state === "loading" ? undefined : state === "empty" ? [] : [record,
        { ...record, _id: "custody-closed" as Id<"financeDealCustody">, status: "RECONCILED",
          summary: { ...record.summary!, actualExpensesMinor: 100000, reimbursementOutstandingMinor: 0, settled: true } }],
      loading: state === "loading", truncated: false, currency: "JOD", expectedTotalMinor: null,
      finalized: state === "finalized", dealStopped: state === "finalized", actions,
      renderMovements: (custodyId, onReverse) => <CustodyMovementsList orgId={"org-a" as Id<"organizations">}
        custodyId={custodyId} currency="JOD" money={money} formatDate={() => "2026-10-28"} t={t} onReverse={onReverse} />,
    };
    render(<LanguageProvider><main className="mx-auto max-w-5xl p-3 md:p-8"><DealCustodyPanel wiring={wiring} money={money} t={t} /></main></LanguageProvider>);
    for (const button of screen.queryAllByRole("button", { name: t("CustodyShowMovements") })) fireEvent.click(button);
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
    const directory = process.env.RT11_CUSTODY_FIXTURE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, `custody-${locale}-${state}.html`), document.body.innerHTML);
    }
    cleanup();
  }
});
