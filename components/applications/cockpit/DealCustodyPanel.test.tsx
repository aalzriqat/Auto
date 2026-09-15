/**
 * The employee custody section, READ-ONLY: balances are the server's, every
 * un-happen state (return, reimbursement owed, overpayment, over-return,
 * write-off) is shown as recorded, and no command is offered — the module is
 * off-ledger, so nothing here may present a cash movement as an action.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import { DealCustodyPanel, type CustodyRecordView, type DealCustodyWiring } from "./DealCustodyPanel";

const tEn = (key: string) => (salesEn as Record<string, string>)[key] ?? key;
const tAr = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
const money = (minor: number, currency: string) => `${(minor / 1000).toLocaleString("en-US")} ${currency}`;

function record(overrides: Partial<CustodyRecordView> = {}): CustodyRecordView {
  return {
    _id: "cust1",
    userId: "u2",
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

function renderPanel(w: DealCustodyWiring, t = tEn) {
  return render(<DealCustodyPanel wiring={w} money={money} t={t} />);
}

afterEach(cleanup);

describe("DealCustodyPanel", () => {
  test("shows the assignee, advanced, expenses paid and what the employee must return", () => {
    renderPanel(wiring());
    expect(screen.getByText("Rami")).toBeTruthy();
    expect(within(screen.getByTestId("custody-issued")).getByText("700 JOD")).toBeTruthy();
    expect(within(screen.getByTestId("custody-expenses")).getByText("340 JOD")).toBeTruthy();
    expect(within(screen.getByTestId("custody-employee-owes")).getByText("360 JOD")).toBeTruthy();
    expect(screen.queryByTestId("custody-dealership-owes")).toBeNull();
    expect(screen.getByTestId("custody-read-only")).toBeTruthy();
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

  test("offers NO custody command — the only button opens the movement log", () => {
    const w = wiring();
    renderPanel(w);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([salesEn.CustodyShowMovements]);
    expect(w.renderMovements).not.toHaveBeenCalled();
    fireEvent.click(buttons[0]);
    expect(w.renderMovements).toHaveBeenCalledWith("cust1");
    expect(screen.getByTestId("movements-slot")).toBeTruthy();
    expect(screen.getByRole("button", { name: salesEn.CustodyHideMovements })).toBeTruthy();
  });

  test("the company-policy expected total is shown ONCE at panel level, unallocated — never inside an employee's record", () => {
    renderPanel(wiring({ records: [record(), record({ _id: "cust2", userName: "Lina" })] }));
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
    renderPanel(wiring({ records: [record({ summary: null })] }));
    expect(screen.getByText(salesEn.CustodySummaryUnavailable)).toBeTruthy();
    expect(screen.queryByTestId("custody-issued")).toBeNull();
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
