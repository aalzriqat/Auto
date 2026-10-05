/**
 * SCRUM-707: a lien release is a handover cost the backend already accepts and
 * pays (`HANDOVER_LINE_FEE_TYPES`), so the manual-add menu must offer it, with
 * both languages' labels, without widening what else may be added by hand.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { salesEn, salesAr } from "@/lib/i18n/domains/sales";
import {
  FEE_TYPE_LABEL,
  defaultTreatmentFor,
  HANDOVER_FEE_TYPES,
  HandoverCostsPanel,
  type HandoverCostsData,
} from "./HandoverCostsPanel";

const t = (key: string) => (salesEn as Record<string, string>)[key] ?? key;

const costs: HandoverCostsData = {
  lines: [],
  summary: { lineCount: 0, estimatedTotalMinor: 0, actualTotalMinor: 0, linesAwaitingActual: 0, linesAwaitingReconciliation: 0 },
  summaryUnavailable: null,
  expected: null,
  executionFee: null,
};

afterEach(cleanup);

describe("the manual-add cost-type menu", () => {
  test("offers LIEN_RELEASE (labelled) and still excludes finance-company and non-handover types", () => {
    render(
      <HandoverCostsPanel
        costs={costs}
        loading={false}
        denomination={{ code: "JOD" }}
        scaleOf={() => 3}
        money={(minor) => `${minor / 1000} JOD`}
        canManage
        dealClosed={false}
        costSource={{ kind: "PENDING" }}
        t={t}
        onAdd={async () => {}}
        onAbandonAdd={() => {}}
        onRecordActual={async () => {}}
        onVoid={async () => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: salesEn.AddHandoverCost }));
    const menu = screen.getByLabelText(salesEn.CostTypeLabel) as HTMLSelectElement;
    const options = Array.from(menu.options);
    const values = options.map((o) => o.value);
    expect(values).toContain("LIEN_RELEASE");
    expect(options.find((o) => o.value === "LIEN_RELEASE")?.textContent).toBe(salesEn.FeeTypeLienRelease);
    expect(values).not.toContain("FINANCE_COMPANY_FEE");
    expect(values).not.toContain("COMMISSION");
    expect(values).not.toContain("APPRAISAL_FEE");
  });

  test("defaultTreatmentFor(LIEN_RELEASE) matches the fee template: ownership-transfer expense", () => {
    expect(defaultTreatmentFor("LIEN_RELEASE")).toBe("OWNERSHIP_TRANSFER_EXPENSE");
  });

  test("selecting Lien release and submitting sends the default treatment and payee to onAdd", async () => {
    const onAdd = vi.fn(async () => {});
    render(
      <HandoverCostsPanel
        costs={costs}
        loading={false}
        denomination={{ code: "JOD" }}
        scaleOf={() => 3}
        money={(minor) => `${minor / 1000} JOD`}
        canManage
        dealClosed={false}
        costSource={{ kind: "PENDING" }}
        t={t}
        onAdd={onAdd}
        onAbandonAdd={() => {}}
        onRecordActual={async () => {}}
        onVoid={async () => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: salesEn.AddHandoverCost }));
    fireEvent.change(screen.getByLabelText(salesEn.CostTypeLabel), { target: { value: "LIEN_RELEASE" } });
    fireEvent.change(document.getElementById("handover-cost-amount") as HTMLInputElement, { target: { value: "40" } });
    fireEvent.submit(screen.getByTestId("deal-handover-cost-add"));
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          feeType: "LIEN_RELEASE",
          accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
          paidTo: "GOVERNMENT",
          actualAmountMinor: 40_000,
        })
      )
    );
  });

  test("LIEN_RELEASE has an English and an Arabic label", () => {
    expect(HANDOVER_FEE_TYPES).toContain("LIEN_RELEASE");
    const key = FEE_TYPE_LABEL.LIEN_RELEASE;
    expect((salesEn as Record<string, string>)[key]).toBe("Lien release");
    expect((salesAr as Record<string, string>)[key]).toBeTruthy();
  });
});
