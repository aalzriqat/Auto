import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { WITHHELD_READINESS_REASON_FALLBACK, closingReadinessRefusalOf } from "@/lib/closingReadinessReasonCodes";
import { DealClosingReadinessList, closingReasonText, type ClosingReadinessView } from "./DealClosingReadinessList";

/**
 * SCRUM-414: the readiness panel translates the server's reason CODE (with its
 * params) instead of printing the server's English sentence, and falls back to
 * that sentence — never a blank, never a raw code — for a reason with no code.
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

  // S414-I18N-1: the server sends the internal treatment enum; the screen
  // names it with the label the rest of the app already uses, in both locales.
  test.each([
    ["ar", tAr, "تأمين قابل للاسترداد"],
    ["en", (key: string) => en[key] || key, "Refundable deposit"],
  ] as const)("an unmapped treatment is named by its %s label, never the raw enum", (_locale, t, label) => {
    render(
      <DealClosingReadinessList
        t={t}
        readiness={view({
          reasonCode: "COSTS_TREATMENT_UNMAPPED",
          reasonParams: { feeLabel: "Refundable plate deposit", treatment: "REFUNDABLE_DEPOSIT" },
        })}
      />
    );
    const reason = screen.getByTestId("closing-check-reason-COSTS_CLOSABLE").textContent ?? "";
    expect(reason).toContain(label);
    expect(reason).toContain("Refundable plate deposit");
    expect(reason).not.toContain("REFUNDABLE_DEPOSIT");
  });

  test("an unknown treatment value is shown as sent rather than dropped", () => {
    const text = closingReasonText(tAr, "COSTS_TREATMENT_UNMAPPED", { feeLabel: "X", treatment: "FUTURE_TREATMENT" }, ENGLISH).text;
    expect(text).toContain("FUTURE_TREATMENT");
  });

  test("falls back to the server's English diagnostic for a reason with no code", () => {
    render(<DealClosingReadinessList t={tAr} readiness={view({ reasonCode: null })} />);
    expect(screen.getByTestId("closing-check-reason-COSTS_CLOSABLE").textContent).toBe(ENGLISH);
  });

  test("an older server (deployed separately) that sends no code still shows its sentence", () => {
    render(<DealClosingReadinessList t={tAr} readiness={view({})} />);
    expect(screen.getByTestId("closing-check-reason-COSTS_CLOSABLE").textContent).toBe(ENGLISH);
  });

  test("a withheld reason (no params, no diagnostic) is translated", () => {
    render(
      <DealClosingReadinessList
        t={tAr}
        readiness={view({ reason: WITHHELD_READINESS_REASON_FALLBACK, reasonCode: "WITHHELD_COSTS_CLOSABLE" })}
      />
    );
    expect(screen.getByTestId("closing-check-reason-COSTS_CLOSABLE").textContent).toBe(ar.ClosingReason_WITHHELD_COSTS_CLOSABLE);
  });

  // SCRUM-420: the FINANCING_RECONCILED row needs no layout change -- the generic list renders it, in both locales.
  test.each([
    ["ar", tAr, true],
    ["en", (key: string) => en[key] || key, false],
  ] as const)("a flagged-financing row shows its %s label and reason, and the withheld form", (_locale, t, arabic) => {
    const row = { key: "FINANCING_RECONCILED", status: "BLOCKED", reason: "x", reasonCode: "FINANCING_RECONCILIATION_FLAGGED" };
    const { unmount } = render(<DealClosingReadinessList t={t} readiness={view(row, { checks: [row] })} />);
    expect(screen.getByTestId("closing-check-FINANCING_RECONCILED").textContent).toContain(t("ClosingCheck_FINANCING_RECONCILED"));
    const reason = screen.getByTestId("closing-check-reason-FINANCING_RECONCILED").textContent ?? "";
    expect(reason).toBe(t("ClosingReason_FINANCING_RECONCILIATION_FLAGGED"));
    expect(/[؀-ۿ]/.test(reason)).toBe(arabic);
    unmount();

    const withheld = { ...row, reason: WITHHELD_READINESS_REASON_FALLBACK, reasonCode: "WITHHELD_FINANCING_RECONCILED" };
    render(<DealClosingReadinessList t={t} readiness={view(withheld, { checks: [withheld] })} />);
    expect(screen.getByTestId("closing-check-reason-FINANCING_RECONCILED").textContent).toBe(t("ClosingReason_WITHHELD_FINANCING_RECONCILED"));
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

describe("closingReasonText — the refused-finalize toast uses the panel's translation", () => {
  test("a coded refusal payload is localized with its params", () => {
    const refusal = closingReadinessRefusalOf({ code: "COSTS_FOREIGN_CURRENCY", params: { count: 3, currency: "JOD" }, message: ENGLISH });
    expect(refusal).not.toBeNull();
    const { text, translated } = closingReasonText(tAr, refusal!.code, refusal!.params, refusal!.message);
    expect(translated).toBe(true);
    expect(text).toMatch(/[؀-ۿ]/);
    expect(text).toContain("JOD");
    expect(text).not.toMatch(/\{\w+\}/);
  });

  test("a plain string or an unknown code is not a coded refusal (the toast keeps getErrorMessage)", () => {
    expect(closingReadinessRefusalOf("Register how and when the payment is expected before finalizing the deal.")).toBeNull();
    expect(closingReadinessRefusalOf({ code: "SOME_FUTURE_CODE", message: ENGLISH })).toBeNull();
    expect(closingReadinessRefusalOf({ code: "UNAUTHORIZED", message: "No." })).toBeNull();
  });
});

/**
 * SCRUM-417 UX1 (S4): a failed check is a destination. The container-side
 * mapping decides WHICH panel a check opens; the list only offers the control
 * on a row that is not satisfied and has somewhere to go.
 */
describe("DealClosingReadinessList — destinations", () => {
  const many = (): ClosingReadinessView =>
    ({
      state: "BLOCKED",
      open: true,
      checks: [
        { key: "CUSTODY_SETTLED", status: "BLOCKED", reason: "open", reasonCode: null },
        { key: "COSTS_CLOSABLE", status: "READY", reason: null, reasonCode: null },
        { key: "REMITTANCE_KNOWN", status: "BLOCKED", reason: "no remittance", reasonCode: null },
        { key: "HANDOVER_COSTS_PAID", status: "UNAVAILABLE", reason: "unknown", reasonCode: null },
      ],
      unavailableReason: null,
      moneyWithheld: false,
    }) as unknown as ClosingReadinessView;

  test("a blocked row with a destination offers it, and it goes there", () => {
    const onGo = vi.fn();
    render(
      <DealClosingReadinessList
        t={(key) => key}
        readiness={many()}
        destinations={{ CUSTODY_SETTLED: { labelKey: "ClosingCheckGoToCustody", onGo } }}
      />
    );
    const go = screen.getByTestId("closing-check-go-CUSTODY_SETTLED");
    expect(go.textContent).toContain("ClosingCheckGoToCustody");
    fireEvent.click(go);
    expect(onGo).toHaveBeenCalledTimes(1);
  });

  test("an UNAVAILABLE row with a destination offers it too", () => {
    render(
      <DealClosingReadinessList
        t={(key) => key}
        readiness={many()}
        destinations={{ HANDOVER_COSTS_PAID: { labelKey: "ClosingCheckGoToCosts", onGo: () => {} } }}
      />
    );
    expect(screen.getByTestId("closing-check-go-HANDOVER_COSTS_PAID")).toBeTruthy();
  });

  test("CONTROL -- a satisfied row, and a blocked row with no destination, offer nothing", () => {
    render(
      <DealClosingReadinessList
        t={(key) => key}
        readiness={many()}
        destinations={{ COSTS_CLOSABLE: { labelKey: "ClosingCheckGoToCosts", onGo: () => {} } }}
      />
    );
    expect(screen.queryByTestId("closing-check-go-COSTS_CLOSABLE")).toBeNull();
    expect(screen.queryByTestId("closing-check-go-REMITTANCE_KNOWN")).toBeNull();
  });

  test("with no destinations at all the list is unchanged", () => {
    render(<DealClosingReadinessList t={(key) => key} readiness={many()} />);
    expect(screen.queryByTestId("closing-check-go-CUSTODY_SETTLED")).toBeNull();
  });
});