/**
 * SCRUM-781 (owner ruling SCRUM-760 c23812 ruling 1): the supplier-payable pay screen never offers or
 * submits VAT on a consigned payable. The backend decides which rows may carry VAT
 * (`vatReclassAllowed`); this screen only follows it, and shows a coded refusal in the user's language.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { dictionaries } from "@/lib/i18n/dictionaries";

let locale: "en" | "ar" = "en";
const markPaid = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

const basePayable = {
  orgId: "org_1",
  vehicleId: "veh_1",
  sourcedFromName: "Sister Dealer Co",
  amountDue: 18000,
  currency: "JOD",
  status: "PENDING",
  createdAt: Date.now(),
  vehicleDesc: "2023 Kia Sportage",
  customerName: "Jane Doe",
  paidByName: null,
  daysOutstanding: 2,
};
const rows = [
  { ...basePayable, _id: "pay_consigned", vatReclassAllowed: false },
  { ...basePayable, _id: "pay_owned", vehicleDesc: "2022 Toyota Corolla", vatReclassAllowed: true },
  // The backend also reports false for an opening liability and for unverifiable ownership, so the note must not claim consignment.
  { ...basePayable, _id: "pay_opening", vehicleDesc: "Opening balance", sourcedFromName: "Opening liability", vatReclassAllowed: false },
];

vi.mock("convex/react", () => ({
  useMutation: () => markPaid,
  useQuery: (ref: { name?: string }) => {
    const name = String(ref?.name ?? "");
    if (name.includes("listPipeline")) return [];
    if (name.includes("listPaymentBankOptions")) return { banks: [], truncated: false };
    if (name.includes("sourcingPayables:list")) return rows;
    return undefined;
  },
}));
vi.mock("@/convex/_generated/api", () => ({
  api: {
    sourcingPayables: {
      list: { name: "sourcingPayables:list" },
      listPipeline: { name: "sourcingPayables:listPipeline" },
      listPaymentBankOptions: { name: "sourcingPayables:listPaymentBankOptions" },
      markPaid: { name: "sourcingPayables:markPaid" },
    },
    vehicles: { markSourcedVehicleArrived: { name: "vehicles:markSourcedVehicleArrived" } },
  },
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    locale,
    t: (key: string) => (dictionaries[locale] as Record<string, string>)[key] ?? key,
  }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m) } }));
vi.mock("@/components/sourcing/SupplierCostRecoveriesSection", () => ({ SupplierCostRecoveriesSection: () => null }));
vi.mock("@/components/payments/PaymentMethodSelect", () => ({ PaymentMethodSelect: () => null }));

import { SourcingClient } from "./client";

const enText = (key: string) => (dictionaries.en as Record<string, string>)[key];
const arText = (key: string) => (dictionaries.ar as Record<string, string>)[key];

function openPay(index: number) {
  fireEvent.click(screen.getAllByRole("button", { name: dictionaries[locale].MarkPaid as string })[index]);
}

beforeEach(() => {
  markPaid.mockReset().mockResolvedValue(null);
  toastError.mockReset();
  toastSuccess.mockReset();
});
afterEach(cleanup);

describe.each(["en", "ar"] as const)("SCRUM-781 supplier payable pay screen (%s)", (language) => {
  beforeEach(() => {
    locale = language;
  });

  test("a consigned payable shows no VAT field, says why, and submits taxAmount 0", async () => {
    render(<SourcingClient />);
    openPay(0);
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByText(new RegExp(`^${dictionaries[locale].VatAmount as string}`))).toBeNull();
    expect(screen.getByText(dictionaries[locale].PayableNoVatReclass as string)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: dictionaries[locale].ConfirmPayment as string }));
    await waitFor(() => expect(markPaid).toHaveBeenCalledOnce());
    expect(markPaid.mock.calls[0][0]).toMatchObject({ payableId: "pay_consigned", taxAmount: 0 });
  });

  test("a non-consigned ineligible payable gets neutral wording, no VAT field, and submits taxAmount 0", async () => {
    render(<SourcingClient />);
    openPay(2);
    expect(screen.queryByRole("spinbutton")).toBeNull();
    const note = screen.getByRole("note");
    expect(note.textContent).toBe(language === "ar" ? "لا يمكن إعادة تصنيف ضريبة القيمة المضافة على هذه الذمة." : "VAT cannot be reclassified on this payable.");
    expect(note.textContent).not.toMatch(/consign|أمانة/i);

    fireEvent.click(screen.getByRole("button", { name: dictionaries[locale].ConfirmPayment as string }));
    await waitFor(() => expect(markPaid).toHaveBeenCalledOnce());
    expect(markPaid.mock.calls[0][0]).toMatchObject({ payableId: "pay_opening", taxAmount: 0 });
  });

  test("an owned payable keeps the VAT field and submits what was typed", async () => {
    render(<SourcingClient />);
    openPay(1);
    const vat = screen.getByRole("spinbutton");
    fireEvent.change(vat, { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: dictionaries[locale].ConfirmPayment as string }));
    await waitFor(() => expect(markPaid).toHaveBeenCalledOnce());
    expect(markPaid.mock.calls[0][0]).toMatchObject({ payableId: "pay_owned", taxAmount: 1000 });
  });

  test("a coded consigned-VAT refusal from the server is shown in the user's language", async () => {
    markPaid.mockRejectedValue(
      new ConvexError({ code: "CONSIGNED_PAYABLE_VAT_REFUSED", message: enText("ServerError_CONSIGNED_PAYABLE_VAT_REFUSED") })
    );
    render(<SourcingClient />);
    openPay(1);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: dictionaries[locale].ConfirmPayment as string }));
    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    expect(toastError.mock.calls[0][0]).toBe(
      language === "ar" ? arText("ServerError_CONSIGNED_PAYABLE_VAT_REFUSED") : enText("ServerError_CONSIGNED_PAYABLE_VAT_REFUSED")
    );
  });
});
