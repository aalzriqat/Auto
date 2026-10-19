import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { commonAr, commonEn } from "@/lib/i18n/domains/common";
import { PayrollBankPicker } from "./PayrollBankPicker";

afterEach(cleanup);

const bank = { _id: "payroll-bank" as Id<"bankAccounts">, name: "Payroll bank", currency: "JOD" };
const en = (key: string) => (commonEn as Record<string, string>)[key] ?? key;
const ar = (key: string) => (commonAr as Record<string, string>)[key] ?? key;

describe("payroll physical bank choice", () => {
  test("offers no default bank before an explicit choice", () => {
    render(<PayrollBankPicker id="pay-bank" value="" onChange={vi.fn()}
      options={{ banks: [bank], truncated: false }} disabled={false} t={en} />);
    expect(screen.getByRole("combobox", { name: en("DirectPaymentBankLabel") }).textContent)
      .toContain(en("DirectPaymentBankChoose"));
  });

  test("an Arabic uncertain retry still names its original bank when options disappear", () => {
    render(<PayrollBankPicker id="pay-bank" value={bank._id} onChange={vi.fn()}
      options={{ banks: [], truncated: false }} disabled frozenName="بنك الرواتب" t={ar} />);
    expect(screen.getByRole("status").textContent).toContain("بنك الرواتب");
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
