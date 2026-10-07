/**
 * SCRUM-606 — the legal invoice amount is recorded exactly or refused with a
 * named reason: more decimals than the currency holds is never rounded, and the
 * refusal is shown in place rather than leaving Submit silently disabled.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { RecordLegalInvoiceDialog } from "./RecordLegalInvoiceDialog";

afterEach(cleanup);

function renderDialog() {
  return render(
    <RecordLegalInvoiceDialog
      open
      submitting={false}
      error={null}
      scale={3}
      currency="JOD"
      t={(key: string) => key}
      onOpenChange={() => {}}
      onSubmit={async () => {}}
    />
  );
}

const amountField = () => screen.getByLabelText(/LegalInvoiceAmount/) as HTMLInputElement;

describe("legal invoice amount precision", () => {
  test("more decimals than the currency holds is named in place and never rounded", () => {
    renderDialog();
    fireEvent.change(amountField(), { target: { value: "12.3456" } });
    expect(amountField().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("AmountTooPrecise");
  });

  test("a non-amount gets the generic reason, an exact figure shows none", () => {
    renderDialog();
    fireEvent.change(amountField(), { target: { value: "abc" } });
    expect(screen.getByRole("alert").textContent).toBe("CustodyAmountInvalid");
    fireEvent.change(amountField(), { target: { value: "12.345" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(amountField().getAttribute("aria-invalid")).toBe("false");
  });
});
