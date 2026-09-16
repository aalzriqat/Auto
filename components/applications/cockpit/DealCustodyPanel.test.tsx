/**
 * The employee custody section: balances are the server's, every un-happen
 * state (return, reimbursement owed, overpayment, over-return, write-off) is
 * shown as recorded, and the money commands exist ONLY for a caller holding
 * the disbursement permission — disabled, with the server's own reason, when
 * the ledger cannot take a posting, and withheld for new cash once the deal
 * is finalized. Nothing here computes a balance or picks an account.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import {
  DealCustodyPanel,
  accountingBlockMessage,
  type CustodyRecordView,
  type DealCustodyActions,
  type DealCustodyWiring,
} from "./DealCustodyPanel";

// The dialogs are the shared `ui/dialog`, which reads the language provider
// for its RTL placement; the panel itself takes `t` as a prop.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (salesEn as Record<string, string>)[key] ?? key,
    isRtl: false,
    locale: "en",
  }),
}));

const tEn = (key: string) => (salesEn as Record<string, string>)[key] ?? key;
const tAr = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
const money = (minor: number, currency: string) => `${(minor / 1000).toLocaleString("en-US")} ${currency}`;

function record(overrides: Partial<CustodyRecordView> = {}): CustodyRecordView {
  return {
    _id: "cust1" as Id<"financeDealCustody">,
    userId: "u2" as Id<"users">,
    userName: "Rami",
    currency: "JOD",
    status: "OPEN",
    issuedMinor: 700_000,
    returnedMinor: 0,
    reimbursedMinor: 0,
    summary: {
      actualExpensesMinor: 340_000,
      employeeOwesDealerMinor: 360_000,
      reimbursementOutstandingMinor: 0,
      reimbursementOverpaidMinor: 0,
      overReturnedMinor: 0,
      settled: false,
    },
    ...overrides,
  };
}

function wiring(overrides: Partial<DealCustodyWiring> = {}): DealCustodyWiring {
  return {
    records: [record()],
    loading: false,
    truncated: false,
    currency: "JOD",
    expectedTotalMinor: 340_000,
    renderMovements: vi.fn(() => <div data-testid="movements-slot" />),
    ...overrides,
  };
}

function actions(overrides: Partial<DealCustodyActions> = {}): DealCustodyActions {
  return {
    members: [{ userId: "u2" as Id<"users">, name: "Rami" }, { userId: "u3" as Id<"users">, name: "Lina" }],
    eligibleFees: [],
    scaleOf: () => 3,
    onPlan: vi.fn(async () => {}),
    onClearPlan: vi.fn(async () => {}),
    onOpen: vi.fn(async () => {}),
    onMove: vi.fn(async () => {}),
    onReverse: vi.fn(async () => {}),
    onAttach: vi.fn(async () => {}),
    onClose: vi.fn(async () => {}),
    onReopen: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderPanel(w: DealCustodyWiring, t = tEn) {
  return render(<DealCustodyPanel wiring={w} money={money} t={t} />);
}

const buttonNames = () => screen.getAllByRole("button").map((b) => b.textContent?.trim());

afterEach(cleanup);

describe("DealCustodyPanel", () => {
  test("shows the assignee, advanced, expenses paid and what the employee must return", () => {
    renderPanel(wiring());
    // Named twice on purpose: at the head as the person holding cash, and on
    // the record itself.
    expect(screen.getAllByText("Rami").length).toBeGreaterThanOrEqual(1);
    expect(within(screen.getByTestId("custody-record-cust1")).getByText("Rami")).toBeTruthy();
    expect(within(screen.getByTestId("custody-position")).getByText("360 JOD")).toBeTruthy();
    expect(within(screen.getByTestId("custody-issued")).getByText("700 JOD")).toBeTruthy();
    expect(within(screen.getByTestId("custody-expenses")).getByText("340 JOD")).toBeTruthy();
    expect(within(screen.getByTestId("custody-employee-owes")).getByText("360 JOD")).toBeTruthy();
    expect(screen.queryByTestId("custody-dealership-owes")).toBeNull();
    // Without the money permission the note says so, and no command exists.
    expect(screen.getByTestId("custody-posted-note").textContent).toBe(salesEn.CustodyNoPermission);
  });

  test("a shortfall reads as owed TO the employee; an overpayment and an over-return as warnings", () => {
    const summary = (s: Partial<NonNullable<CustodyRecordView["summary"]>>) => ({
      actualExpensesMinor: 900_000,
      employeeOwesDealerMinor: 0,
      reimbursementOutstandingMinor: 0,
      reimbursementOverpaidMinor: 0,
      overReturnedMinor: 0,
      settled: false,
      ...s,
    });
    renderPanel(wiring({ records: [record({ summary: summary({ reimbursementOutstandingMinor: 200_000 }) })] }));
    expect(within(screen.getByTestId("custody-dealership-owes")).getByText("200 JOD")).toBeTruthy();
    cleanup();
    renderPanel(wiring({ records: [record({ summary: summary({ reimbursementOverpaidMinor: 100_000 }) })] }));
    expect(within(screen.getByTestId("custody-overpaid")).getByText("100 JOD")).toBeTruthy();
    cleanup();
    renderPanel(wiring({ records: [record({ summary: summary({ overReturnedMinor: 50_000 }) })] }));
    expect(within(screen.getByTestId("custody-over-returned")).getByText("50 JOD")).toBeTruthy();
  });

  test("a balanced open record says so; a closed one shows its notes and write-off", () => {
    renderPanel(
      wiring({
        records: [
          record({
            returnedMinor: 360_000,
            summary: {
              actualExpensesMinor: 340_000,
              employeeOwesDealerMinor: 0,
              reimbursementOutstandingMinor: 0,
              reimbursementOverpaidMinor: 0,
              overReturnedMinor: 0,
              settled: true,
            },
          }),
        ],
      })
    );
    expect(screen.getByTestId("custody-balanced")).toBeTruthy();
    cleanup();
    renderPanel(
      wiring({ records: [record({ status: "WRITTEN_OFF", reconciliationNotes: "Counted", writeOffReason: "Lost receipt" })] })
    );
    expect(screen.getByText(salesEn.CustodyStatusWrittenOff)).toBeTruthy();
    expect(screen.getByText("Counted")).toBeTruthy();
    expect(screen.getByText("Lost receipt")).toBeTruthy();
  });

  test("without the money permission the only button opens the movement log, and no reversal handler is offered", () => {
    const w = wiring();
    renderPanel(w);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([salesEn.CustodyShowMovements]);
    expect(w.renderMovements).not.toHaveBeenCalled();
    fireEvent.click(buttons[0]);
    expect(w.renderMovements).toHaveBeenCalledWith("cust1", undefined);
    expect(screen.getByTestId("movements-slot")).toBeTruthy();
    expect(screen.getByRole("button", { name: salesEn.CustodyHideMovements })).toBeTruthy();
  });

  describe("the money actions, for the disbursement tier", () => {
    test("an open record offers issue-more, return, charge-a-cost and close; reimburse only when something is owed", () => {
      const a = actions();
      renderPanel(wiring({ actions: a, accounting: { ready: true } }));
      const names = buttonNames();
      expect(names).toContain(salesEn.CustodyIssueMore);
      expect(names).toContain(salesEn.CustodyRecordReturn);
      expect(names).toContain(salesEn.CustodyAttachCost);
      expect(names).toContain(salesEn.CustodyClose);
      expect(names).not.toContain(salesEn.CustodyReimburse);
      // Cash is out, so nothing NEW is planned or issued at the head.
      expect(screen.queryByTestId("custody-issue-button")).toBeNull();
      expect(screen.queryByTestId("custody-plan-button")).toBeNull();
      // Nothing eligible to charge: the button exists and is dead.
      expect((screen.getByRole("button", { name: salesEn.CustodyAttachCost }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId("custody-posted-note").textContent).toBe(salesEn.CustodyPostedNote);
    });

    test("reimburse appears when the dealership owes the employee, and the dialog prefills what is owed", () => {
      const a = actions();
      renderPanel(
        wiring({
          actions: a,
          accounting: { ready: true },
          records: [
            record({
              summary: { actualExpensesMinor: 900_000, employeeOwesDealerMinor: 0, reimbursementOutstandingMinor: 200_000, reimbursementOverpaidMinor: 0, overReturnedMinor: 0, settled: false },
            }),
          ],
        })
      );
      fireEvent.click(screen.getByRole("button", { name: salesEn.CustodyReimburse }));
      const dialog = screen.getByTestId("custody-reimbursed-dialog");
      expect((within(dialog).getByLabelText(/Amount/) as HTMLInputElement).value).toBe("200");
      fireEvent.click(within(dialog).getByTestId("custody-reimbursed-submit"));
      expect(a.onMove).toHaveBeenCalledWith("cust1", "REIMBURSED", expect.objectContaining({ amountMinor: 200_000, method: "CASH" }));
    });

    test("a return larger than what was issued is refused in the form before any round trip", () => {
      const a = actions();
      renderPanel(wiring({ actions: a, accounting: { ready: true } }));
      fireEvent.click(screen.getByRole("button", { name: salesEn.CustodyRecordReturn }));
      const dialog = screen.getByTestId("custody-returned-dialog");
      const input = within(dialog).getByLabelText(/Amount/) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "800" } });
      expect(within(dialog).getByRole("alert").textContent).toContain(salesEn.CustodyAmountExceedsIssued);
      expect((within(dialog).getByTestId("custody-returned-submit") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(input, { target: { value: "abc" } });
      expect(within(dialog).getByRole("alert").textContent).toBe(salesEn.CustodyAmountInvalid);
      expect(a.onMove).not.toHaveBeenCalled();
    });

    test("closing an unbalanced record needs a write-off reason; the write-off names the exact residual", () => {
      const a = actions();
      renderPanel(wiring({ actions: a, accounting: { ready: true } }));
      fireEvent.click(screen.getByRole("button", { name: salesEn.CustodyClose }));
      const dialog = screen.getByTestId("custody-close-dialog");
      fireEvent.change(within(dialog).getByLabelText(salesEn.CustodyCloseNotes), { target: { value: "Counted." } });
      // Not settled and no write-off chosen: cannot submit.
      expect((within(dialog).getByTestId("custody-close-submit") as HTMLButtonElement).disabled).toBe(true);
      expect(within(dialog).getByText("360 JOD")).toBeTruthy();
      fireEvent.click(within(dialog).getByTestId("custody-write-off-toggle"));
      fireEvent.change(within(dialog).getByLabelText(salesEn.CustodyWriteOffReason), { target: { value: "Untraceable" } });
      fireEvent.click(within(dialog).getByTestId("custody-close-submit"));
      expect(a.onClose).toHaveBeenCalledWith("cust1", { notes: "Counted.", writeOffReason: "Untraceable" });
    });

    test("a closed record offers reopen only", () => {
      const a = actions();
      renderPanel(wiring({ actions: a, accounting: { ready: true }, records: [record({ status: "RECONCILED", reconciliationNotes: "Done" })] }));
      const names = buttonNames();
      expect(names).toContain(salesEn.CustodyReopen);
      expect(names).not.toContain(salesEn.CustodyClose);
      expect(names).not.toContain(salesEn.CustodyRecordReturn);
      fireEvent.click(screen.getByRole("button", { name: salesEn.CustodyReopen }));
      fireEvent.change(screen.getByLabelText(salesEn.CustodyReason), { target: { value: "Late receipt" } });
      fireEvent.click(screen.getByTestId("custody-reopen-submit"));
      expect(a.onReopen).toHaveBeenCalledWith("cust1", "Late receipt");
    });

    test("the server's refusal is shown beside the form, and the dialog stays open", async () => {
      const a = actions({ onMove: vi.fn(async () => { throw new Error("This custody record is already closed."); }) });
      renderPanel(wiring({ actions: a, accounting: { ready: true } }));
      fireEvent.click(screen.getByRole("button", { name: salesEn.CustodyRecordReturn }));
      const dialog = screen.getByTestId("custody-returned-dialog");
      fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: "100" } });
      fireEvent.click(within(dialog).getByTestId("custody-returned-submit"));
      expect(await within(dialog).findByText("This custody record is already closed.")).toBeTruthy();
      expect(screen.getByTestId("custody-returned-dialog")).toBeTruthy();
    });

    test("with no record yet, the head offers the plan and the issuance; the plan feeds the issuance", () => {
      const a = actions();
      renderPanel(
        wiring({
          actions: a,
          accounting: { ready: true },
          records: [],
          plannedCustody: { userId: "u3" as Id<"users">, userName: "Lina", amountMinor: 120_000, note: null },
          recommended: { recommendedMinor: 90_000, reason: null, outstandingCount: 1 },
        })
      );
      expect(within(screen.getByTestId("custody-planned")).getByText("Lina")).toBeTruthy();
      expect(within(screen.getByTestId("custody-planned")).getByText("120 JOD")).toBeTruthy();
      expect(within(screen.getByTestId("custody-recommended")).getByText("90 JOD")).toBeTruthy();
      expect(screen.getByTestId("custody-plan-button").textContent).toBe(salesEn.CustodyChangeHandler);
      fireEvent.click(screen.getByTestId("custody-issue-button"));
      const dialog = screen.getByTestId("custody-issued-dialog");
      // The planned amount, not the recommendation, prefills once a plan exists.
      expect((within(dialog).getByLabelText(/Amount/) as HTMLInputElement).value).toBe("120");
      fireEvent.click(within(dialog).getByTestId("custody-issued-submit"));
      expect(a.onOpen).toHaveBeenCalledWith(expect.objectContaining({ userId: "u3", amountMinor: 120_000 }));
    });

    test("while the candidate read has not answered, the plan and issue doors are shut — never an empty picker (item 5)", () => {
      const a = actions({ members: undefined });
      renderPanel(wiring({ actions: a, accounting: { ready: true }, records: [] }));
      expect((screen.getByTestId("custody-plan-button") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("custody-issue-button") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByTestId("custody-issue-button"));
      expect(screen.queryByTestId("custody-issued-dialog")).toBeNull();
      cleanup();
      // Answered (even with nobody eligible): the doors open; a dialog with no
      // served member cannot submit, so no money command carries an empty id.
      const answered = actions({ members: [] });
      renderPanel(wiring({ actions: answered, accounting: { ready: true }, records: [] }));
      expect((screen.getByTestId("custody-issue-button") as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByTestId("custody-issue-button"));
      const dialog = screen.getByTestId("custody-issued-dialog");
      fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: "100" } });
      expect((within(dialog).getByTestId("custody-issued-submit") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(dialog).getByTestId("custody-issued-submit"));
      expect(answered.onOpen).not.toHaveBeenCalled();
    });

    test("a plan whose default names someone no longer in the candidate list cannot be submitted as that id (item 4)", () => {
      const a = actions({ members: [{ userId: "u9" as Id<"users">, name: "Omar" }] });
      renderPanel(
        wiring({
          actions: a,
          accounting: { ready: true },
          records: [],
          plannedCustody: { userId: "u3" as Id<"users">, userName: "Lina", amountMinor: 120_000, note: null },
        })
      );
      fireEvent.click(screen.getByTestId("custody-issue-button"));
      const dialog = screen.getByTestId("custody-issued-dialog");
      // The stale default "u3" is not a served member: the submit stays shut.
      expect((within(dialog).getByTestId("custody-issued-submit") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(dialog).getByTestId("custody-issued-submit"));
      expect(a.onOpen).not.toHaveBeenCalled();
    });

    test("the recommendation is withheld with its reason, never shown as zero", () => {
      renderPanel(wiring({ actions: actions(), accounting: { ready: true }, records: [], recommended: { recommendedMinor: null, reason: "UNSAFE_AMOUNT", outstandingCount: 1 } }));
      expect(screen.getByTestId("custody-recommended").textContent).toBe(salesEn.CustodyRecommendedUnreadable);
      cleanup();
      renderPanel(wiring({ actions: actions(), accounting: { ready: true }, records: [], recommended: { recommendedMinor: null, reason: "NOT_CONFIGURED", outstandingCount: 0 } }));
      expect(screen.getByTestId("custody-recommended").textContent).toBe(salesEn.CustodyRecommendedNotConfigured);
    });

    test("when the ledger cannot take a posting every money button is dead and the reason is the server's", () => {
      const a = actions();
      renderPanel(wiring({ actions: a, records: [], accounting: { ready: false, reason: "CHART_NOT_INITIALIZED" } }));
      expect(screen.getByTestId("custody-accounting-blocked").textContent).toBe(salesEn.CustodyAccountingChartNotInitialized);
      expect((screen.getByTestId("custody-issue-button") as HTMLButtonElement).disabled).toBe(true);
      // Planning is not money: still allowed.
      expect((screen.getByTestId("custody-plan-button") as HTMLButtonElement).disabled).toBe(false);
      cleanup();
      renderPanel(wiring({ actions: a, accounting: { ready: false, reason: "ACCOUNT_CODE_CONFLICT", systemKey: "DEAL_CUSTODY_CLEARING" } }));
      expect(screen.getByTestId("custody-accounting-blocked").textContent).toContain("DEAL_CUSTODY_CLEARING");
      for (const name of [salesEn.CustodyIssueMore, salesEn.CustodyRecordReturn, salesEn.CustodyClose]) {
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      }
      expect(accountingBlockMessage({ ready: false, reason: "ACCOUNT_UNMAPPED", systemKey: "CASH_ON_HAND" }, tAr)).toContain("CASH_ON_HAND");
      expect(accountingBlockMessage({ ready: true }, tEn)).toBeNull();
    });

    test("a finalized or stopped deal takes new cash and a new plan off the table while an open record still settles", () => {
      const a = actions();
      renderPanel(wiring({ actions: a, accounting: { ready: true }, dealStopped: true, records: [] }));
      expect(screen.queryByTestId("custody-issue-button")).toBeNull();
      expect(screen.queryByTestId("custody-plan-button")).toBeNull();
      cleanup();
      renderPanel(wiring({ actions: a, accounting: { ready: true }, dealStopped: true }));
      const names = buttonNames();
      expect(names).toContain(salesEn.CustodyRecordReturn);
      expect(names).toContain(salesEn.CustodyClose);
      // "Hand over more" is new cash too — gone with the deal's own issuance.
      expect(names).not.toContain(salesEn.CustodyIssueMore);
    });

    test("a stopped or finalized deal withholds 'charge a cost' too — the server refuses to move a cost onto custody once the economics are frozen — while settling stays", () => {
      const a = actions({ eligibleFees: [{ _id: "fee1" as Id<"financeDealFees">, label: "Plates", actualAmountMinor: 90_000, currency: "JOD" }] });
      renderPanel(wiring({ actions: a, accounting: { ready: true }, dealStopped: true }));
      expect(buttonNames()).not.toContain(salesEn.CustodyAttachCost);
      expect(screen.queryByTestId("custody-attach-cust1")).toBeNull();
      expect(buttonNames()).toContain(salesEn.CustodyRecordReturn);
      expect(buttonNames()).toContain(salesEn.CustodyClose);
      cleanup();
      // Economics open: the same record offers it, live.
      renderPanel(wiring({ actions: a, accounting: { ready: true }, dealStopped: false }));
      expect((screen.getByTestId("custody-attach-cust1") as HTMLButtonElement).disabled).toBe(false);
    });

    test("the operator is never offered as the recipient of their own issuance — the server refuses self-issuance — while the plan may still name them", () => {
      const me = { userId: "u1" as Id<"users">, name: "Me", isActor: true };
      const a = actions({ members: [me, { userId: "u3" as Id<"users">, name: "Lina" }] });
      const plannedSelf = { userId: "u1" as Id<"users">, userName: "Me", amountMinor: 120_000, note: null };
      renderPanel(wiring({ actions: a, accounting: { ready: true }, records: [], plannedCustody: plannedSelf }));
      fireEvent.click(screen.getByTestId("custody-issue-button"));
      const issue = screen.getByTestId("custody-issued-dialog");
      // The plan's person is the operator: not a served recipient, so the
      // picker is unset and the money command cannot be submitted as them.
      expect(within(issue).getByTestId("custody-issued-person").textContent).toContain(salesEn.CustodyAssignPersonPlaceholder);
      expect((within(issue).getByLabelText(/Amount/) as HTMLInputElement).value).toBe("120");
      expect((within(issue).getByTestId("custody-issued-submit") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(issue).getByTestId("custody-issued-submit"));
      expect(a.onOpen).not.toHaveBeenCalled();
      fireEvent.keyDown(issue, { key: "Escape" });
      cleanup();
      // Planning is not money: the same operator may be planned as the handler.
      renderPanel(wiring({ actions: a, accounting: { ready: true }, records: [], plannedCustody: plannedSelf }));
      fireEvent.click(screen.getByTestId("custody-plan-button"));
      const plan = screen.getByTestId("custody-plan-dialog");
      expect((within(plan).getByTestId("custody-plan-submit") as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(within(plan).getByTestId("custody-plan-submit"));
      expect(a.onPlan).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", amountMinor: 120_000 }));
      cleanup();
      // A plan naming somebody else still feeds the issuance as before.
      const b = actions({ members: [me, { userId: "u3" as Id<"users">, name: "Lina" }] });
      renderPanel(wiring({ actions: b, accounting: { ready: true }, records: [], plannedCustody: { userId: "u3" as Id<"users">, userName: "Lina", amountMinor: 120_000, note: null } }));
      fireEvent.click(screen.getByTestId("custody-issue-button"));
      const issueOther = screen.getByTestId("custody-issued-dialog");
      fireEvent.click(within(issueOther).getByTestId("custody-issued-submit"));
      expect(b.onOpen).toHaveBeenCalledWith(expect.objectContaining({ userId: "u3", amountMinor: 120_000 }));
    });

    test("a withheld plan says it is withheld — never 'nobody assigned' — and offers no plan control", () => {
      renderPanel(wiring({ records: [], plannedCustody: null, plannedCustodyWithheld: true }));
      expect(screen.getByTestId("custody-plan-withheld").textContent).toContain(salesEn.CustodyPlanWithheld);
      expect(screen.queryByTestId("custody-unplanned")).toBeNull();
      expect(screen.queryByTestId("custody-plan-button")).toBeNull();
      cleanup();
      renderPanel(wiring({ records: [], plannedCustody: null, plannedCustodyWithheld: true }), tAr);
      expect(screen.getByTestId("custody-plan-withheld").textContent).toContain(salesAr.CustodyPlanWithheld);
    });

    test("a legacy record (opened before ledger posting) shows why and offers no money action, even to the disbursement tier", () => {
      const a = actions();
      const w = wiring({ actions: a, accounting: { ready: true }, records: [record({ legacy: true })] });
      renderPanel(w);
      expect(screen.getByTestId("custody-legacy-cust1").textContent).toBe(salesEn.CustodyLegacyNote);
      expect(screen.queryByTestId("custody-actions-cust1")).toBeNull();
      for (const name of [salesEn.CustodyIssueMore, salesEn.CustodyRecordReturn, salesEn.CustodyClose, salesEn.CustodyAttachCost]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
      // The movement log is still readable, but carries no reversal handler.
      fireEvent.click(screen.getByRole("button", { name: salesEn.CustodyShowMovements }));
      expect((w.renderMovements as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBeUndefined();
    });

    test("no open period today is stated, not hidden", () => {
      renderPanel(wiring({ actions: actions(), accounting: { ready: true }, openPeriodToday: false }));
      expect(screen.getByTestId("custody-period-queued").textContent).toBe(salesEn.CustodyQueuedNote);
    });

    test("the movement log gets a reversal handler on an open record, and the reversal asks for a reason", () => {
      const a = actions();
      const w = wiring({ actions: a, accounting: { ready: true } });
      renderPanel(w);
      fireEvent.click(screen.getByRole("button", { name: salesEn.CustodyShowMovements }));
      const call = (w.renderMovements as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("cust1");
      expect(typeof call[1]).toBe("function");
      act(() => call[1]({ entryId: "e1", kind: "ISSUED", amountMinor: 700_000 }));
      const dialog = screen.getByTestId("custody-reverse-dialog");
      expect(within(dialog).getByTestId("custody-reverse-detail").textContent).toContain("700 JOD");
      fireEvent.change(within(dialog).getByLabelText(salesEn.CustodyReason), { target: { value: "Typo" } });
      fireEvent.click(within(dialog).getByTestId("custody-reverse-submit"));
      expect(a.onReverse).toHaveBeenCalledWith("cust1", { entryId: "e1", kind: "ISSUED", amountMinor: 700_000 }, "Typo");
    });

    test("Arabic: the actions, the position and the blocked reason render in Arabic with LTR-isolated money", () => {
      renderPanel(wiring({ actions: actions(), accounting: { ready: false, reason: "CHART_NOT_INITIALIZED" } }), tAr);
      expect(screen.getByRole("button", { name: salesAr.CustodyRecordReturn })).toBeTruthy();
      expect(screen.getByTestId("custody-accounting-blocked").textContent).toBe(salesAr.CustodyAccountingChartNotInitialized);
      const figure = within(screen.getByTestId("custody-position")).getByText("360 JOD");
      expect(figure.tagName).toBe("BDI");
      expect(figure.getAttribute("dir")).toBe("ltr");
    });
  });

  test("the company-policy expected total is shown ONCE at panel level, unallocated — never inside an employee's record", () => {
    renderPanel(wiring({ records: [record(), record({ _id: "cust2" as Id<"financeDealCustody">, userName: "Lina" })] }));
    const expected = screen.getAllByTestId("custody-expected");
    expect(expected).toHaveLength(1);
    expect(within(expected[0]).getByText("340 JOD")).toBeTruthy();
    expect(within(expected[0]).getByText(salesEn.CustodyExpectedNote)).toBeTruthy();
    // Neither employee record carries an expected/planned row.
    for (const id of ["cust1", "cust2"]) {
      const article = screen.getByTestId(`custody-record-${id}`);
      expect(within(article).queryByText(salesEn.CustodyExpected)).toBeNull();
      expect(within(article).queryByTestId("custody-expected")).toBeNull();
    }
    cleanup();
    renderPanel(wiring({ expectedTotalMinor: null }));
    expect(screen.queryByTestId("custody-expected")).toBeNull();
  });

  test("a mixed-denomination record withholds its balances with the reason", () => {
    renderPanel(wiring({ records: [record({ summary: null, summaryUnavailable: { reason: "MIXED_DENOMINATION" } })] }));
    expect(screen.getByText(salesEn.CustodySummaryUnavailable)).toBeTruthy();
    expect(screen.queryByTestId("custody-issued")).toBeNull();
  });

  test.each([tEn, tAr])("an UNSAFE_AMOUNT record renders its own unavailable sentence and NO money, balance, or stored total — %#", (t) => {
    const dictionary = t === tEn ? salesEn : salesAr;
    // The stored totals are exactly what may be corrupt, so they must not be
    // formatted either — a NaN reaching `money` would paint "NaN JOD".
    const { container } = renderPanel(
      wiring({ records: [record({ summary: null, summaryUnavailable: { reason: "UNSAFE_AMOUNT" }, issuedMinor: Number.NaN, returnedMinor: 0 })] }),
      t
    );
    expect(screen.getByTestId("custody-summary-unavailable-UNSAFE_AMOUNT").textContent).toBe(dictionary.CustodySummaryUnreadable);
    expect(screen.queryByText(dictionary.CustodySummaryUnavailable)).toBeNull();
    for (const id of ["custody-issued", "custody-expenses", "custody-returned", "custody-reimbursed", "custody-employee-owes", "custody-dealership-owes", "custody-balanced"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    // Nothing inside the record formats money — the panel-level policy total
    // above it is a different figure and is not what was withheld.
    expect(screen.getByTestId("custody-record-cust1").textContent).not.toMatch(/NaN|JOD/);
    expect(container.querySelectorAll("bdi[dir='ltr']").length).toBeLessThanOrEqual(1);
    // No money permission wired: no command of any kind; the movement log stays reachable.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  test("a truncated list says so rather than reading as complete", () => {
    renderPanel(wiring({ truncated: true }));
    expect(screen.getByTestId("custody-truncated")).toBeTruthy();
  });

  test("empty, loading and withheld states", () => {
    renderPanel(wiring({ records: [] }));
    expect(screen.getByText(salesEn.CustodyNone)).toBeTruthy();
    cleanup();
    renderPanel(wiring({ records: undefined, loading: true }));
    expect(screen.queryByText(salesEn.CustodyNone)).toBeNull();
    cleanup();
    renderPanel(wiring({ records: undefined, loading: false }));
    expect(screen.getByText(salesEn.MoneyPanelHidden)).toBeTruthy();
  });

  test("renders in Arabic with LTR-isolated amounts", () => {
    renderPanel(wiring(), tAr);
    expect(screen.getByText(salesAr.CustodyHeading)).toBeTruthy();
    expect(screen.getByText(salesAr.CustodyEmployeeOwes)).toBeTruthy();
    const figure = within(screen.getByTestId("custody-issued")).getByText("700 JOD");
    expect(figure.tagName).toBe("BDI");
    expect(figure.getAttribute("dir")).toBe("ltr");
  });
});
