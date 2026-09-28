import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { DealClosingReadinessList, type ClosingReadinessView } from "./DealClosingReadinessList";

/**
 * SCRUM-414: the readiness panel translates the server's reason CODE (with its
 * params) instead of printing the server's English sentence, and falls back to
 * that sentence — never a blank, never a raw code — for a code it does not know.
 */
afterEach(cleanup);

const ar = dictionaries.ar as Record<string, string>;
const en = dictionaries.en as Record<string, string>;
const tAr = (key: string) => ar[key] || en[key] || key;

const ENGLISH = "3 cost line(s) on this deal are not in JOD, so its costs cannot be finalized until the records agree.";

function view(check: Record<string, unknown>, extra: Record<string, unknown> = {}): ClosingReadinessView {
  return {
    state: "BLOCKED",
    open: true,
    checks: [{ key: "COSTS_CLOSABLE", status: "BLOCKED", reason: ENGLISH, ...check }],
    unavailableReason: null,
    moneyWithheld: false,
    ...extra,
  } as unknown as ClosingReadinessView;
}

describe("DealClosingReadinessList — reason codes", () => {
  test("renders the Arabic translation of a coded reason, with its params filled in", () => {
    render(
      <DealClosingReadinessList
        t={tAr}
        readiness={view({ reasonCode: "COSTS_FOREIGN_CURRENCY", reasonParams: { count: 3, currency: "JOD" } })}
      />
    );
    const reason = screen.getByTestId("closing-check-reason-COSTS_CLOSABLE");
    expect(reason.textContent).toMatch(/[؀-ۿ]/);
    expect(reason.textContent).toContain("3");
    expect(reason.textContent).toContain("JOD");
    expect(reason.textContent).not.toMatch(/\{\w+\}/);
    expect(reason.textContent).not.toContain("cost line(s)");
    // The English stays reachable as the diagnostic, not as the text.
    expect(reason.getAttribute("title")).toBe(ENGLISH);
  });

  test("falls back to the server's English diagnostic for a code this build does not know", () => {
    render(<DealClosingReadinessList t={tAr} readiness={view({ reasonCode: "SOME_FUTURE_CODE", reasonParams: { count: 3 } })} />);
    expect(screen.getByTestId("closing-check-reason-COSTS_CLOSABLE").textContent).toBe(ENGLISH);
  });

  test("an older server that sends no code still shows its sentence", () => {
    render(<DealClosingReadinessList t={tAr} readiness={view({})} />);
    expect(screen.getByTestId("closing-check-reason-COSTS_CLOSABLE").textContent).toBe(ENGLISH);
  });

  test("a withheld reason (no params, no diagnostic) is translated", () => {
    render(
      <DealClosingReadinessList
        t={tAr}
        readiness={view({ reason: "The deal's costs are not all recorded and reconciled yet.", reasonCode: "WITHHELD_COSTS_CLOSABLE" })}
      />
    );
    expect(screen.getByTestId("closing-check-reason-COSTS_CLOSABLE").textContent).toBe(ar.ClosingReason_WITHHELD_COSTS_CLOSABLE);
  });

  test("the no-verdict reason is translated from its code", () => {
    render(
      <DealClosingReadinessList
        t={tAr}
        readiness={view({}, {
          state: "UNAVAILABLE",
          checks: [],
          unavailableReason: "This deal's figures were recorded in JOD, but the organization's currency is now USD.",
          unavailableReasonCode: "READINESS_CURRENCY_DRIFT",
          unavailableReasonParams: { recordedCurrency: "JOD", orgCurrency: "USD" },
        })}
      />
    );
    const reason = screen.getByTestId("closing-readiness-unavailable-reason");
    expect(reason.textContent).toMatch(/[؀-ۿ]/);
    expect(reason.textContent).toContain("USD");
    expect(reason.textContent).not.toContain("organization's currency");
  });
});
