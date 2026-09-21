/**
 * Verification of the retirement of the fee-template adoption UX.
 *
 * Old business rule:
 * - The handover checklist offered a fee-template adoption notice and action to
 *   adopt late-configured fee templates onto deals frozen without templates.
 *
 * Why obsolete:
 * - Company-level fee templates have been retired in favor of company `adminFees`
 *   (Execution Fees / مصاريف التنفيذ) as the single authoritative expected fee figure.
 * - Template adoption is no longer needed or supported in the UI.
 *
 * New invariant:
 * - Handover costs panel tracks actual deal costs via `financeDealFees` without
 *   duplicate template adoption UX.
 * - The adoption notice banner is never rendered.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { salesEn } from "@/lib/i18n/domains/sales";
import { HandoverCostsPanel, type HandoverCostsData, type HandoverFeeAdoption } from "./HandoverCostsPanel";

const t = (key: string) => (salesEn as Record<string, string>)[key] ?? key;

function costs(adoption: HandoverFeeAdoption): HandoverCostsData {
  return {
    lines: [],
    summary: {
      lineCount: 0,
      estimatedTotalMinor: 0,
      actualTotalMinor: 0,
      linesAwaitingActual: 0,
      linesAwaitingReconciliation: 0,
    },
    summaryUnavailable: null,
    expected: {
      source: "NO_TEMPLATES",
      currency: "JOD",
      rows: [],
      expectedTotalMinor: null,
      expectedTotalReason: null,
      actualTotalMinor: 0,
      differenceMinor: null,
      unplannedLineIds: [],
      adoption,
    },
  };
}

function renderPanel(adoption: HandoverFeeAdoption) {
  return render(
    <HandoverCostsPanel
      costs={costs(adoption)}
      loading={false}
      denomination={{ code: "JOD" }}
      scaleOf={() => 3}
      money={(minor) => `${minor / 1000} JOD`}
      canManage={true}
      dealClosed={false}
      t={t}
      onAdd={async () => {}}
      onAbandonAdd={() => {}}
      onRecordActual={async () => {}}
      onVoid={async () => {}}
    />
  );
}

afterEach(cleanup);

describe("fee-template adoption retirement on the handover-cost checklist", () => {
  test("AVAILABLE state: adoption notice is retired and not rendered", () => {
    renderPanel({ state: "AVAILABLE", liveTemplateCount: 3, liveRuleVersion: 2, adopted: null });
    expect(screen.queryByTestId("deal-handover-fee-adoption")).toBeNull();
    expect(screen.queryByRole("button", { name: salesEn.AdoptCompanyFees })).toBeNull();
  });

  test("blocked states: adoption notice is retired and not rendered", () => {
    renderPanel({ state: "BLOCKED_COSTS_RECORDED", liveTemplateCount: 3, liveRuleVersion: 2, adopted: null });
    expect(screen.queryByTestId("deal-handover-fee-adoption")).toBeNull();
  });

  test("unreadable or over limit states: adoption notice is retired and not rendered", () => {
    renderPanel({ state: "COMPANY_TEMPLATES_UNREADABLE", liveTemplateCount: 2, liveRuleVersion: 3, adopted: null });
    expect(screen.queryByTestId("deal-handover-fee-adoption")).toBeNull();

    cleanup();
    renderPanel({ state: "COMPANY_TEMPLATES_OVER_LIMIT", liveTemplateCount: 101, liveRuleVersion: 3, adopted: null });
    expect(screen.queryByTestId("deal-handover-fee-adoption")).toBeNull();
  });
});
