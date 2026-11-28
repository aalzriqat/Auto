/**
 * SCRUM-1039: the expense form opened from the assistant. The assistant only
 * proposes values; the form is the same create form, the staff member checks it
 * and only their own click on Record Expense calls `expenses.create`.
 *
 * Only network and the authenticated organization context are replaced. The
 * form, language provider, selects and toast renderer are real. jsdom has no
 * layout, so RTL spacing and phone widths still need a rendered pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { ExpenseDialog } from "./ExpenseDialog";
import type { ExpenseProposalValues } from "./expense.schema";

const network = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_a1039" }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (name === "vehicles:listAll") return [];
      if (name === "orgSettings:get") return { currency: "JOD" };
      return undefined;
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: () => network.mutate,
  };
});

type Locale = "en" | "ar";
const copy = (locale: Locale) => dictionaries[locale] as Record<string, string>;

const rentProposal: ExpenseProposalValues = {
  amount: 120,
  taxAmount: 15,
  category: "RENT",
  date: "2026-11-20",
  title: "Office rent",
  notes: "November",
  vendorName: "Al Noor Properties",
  paymentMethod: "CASH",
};

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  // jsdom has no ResizeObserver; the create form's prepaid checkbox measures itself.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  network.mutate.mockReset();
  network.mutate.mockResolvedValue("expense_new");
});

afterEach(() => {
  toast.dismiss();
  vi.unstubAllGlobals();
});

function renderDialog(locale: Locale, props: { assistantProposal?: ExpenseProposalValues | null; expense?: Doc<"expenses"> | null } = {}) {
  localStorage.setItem("autoflow-locale", locale);
  return render(
    <LanguageProvider>
      <ExpenseDialog open onOpenChange={() => undefined} {...props} />
      <Toaster />
    </LanguageProvider>,
  );
}

function input(placeholder: string): HTMLInputElement {
  return screen.getByPlaceholderText(placeholder) as HTMLInputElement;
}

describe("ExpenseDialog opened from the assistant", () => {
  test.each(["en", "ar"] as const)("%s shows the proposal in the fields and the check-before-saving notice", async (locale) => {
    renderDialog(locale, { assistantProposal: rentProposal });
    const c = copy(locale);
    expect(await screen.findByText(c.ExpenseAssistantNoticeTitle)).toBeTruthy();
    await waitFor(() => expect(input("e.g. Brake pad replacement").value).toBe("Office rent"));
    expect(input("250").value).toBe("120");
    expect(input("0").value).toBe("15");
    expect(screen.getByDisplayValue("2026-11-20")).toBeTruthy();
    expect(input("e.g. Joe's Repair Shop").value).toBe("Al Noor Properties");
    expect((screen.getByPlaceholderText(c.AnyExtraDetails) as HTMLTextAreaElement).value).toBe("November");
    expect(screen.getByRole("combobox", { name: c.Category }).textContent).toContain(c.Rent);
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
    // The notice is part of the dialog's accessible description, so it is read on open.
    const dialog = screen.getByRole("dialog");
    const describedBy = (dialog.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const description = describedBy.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(description).toContain(c.ExpenseAssistantNoticeTitle);
  });

  test.each(["en", "ar"] as const)("%s saves nothing until the user clicks Record Expense, then exactly once with the visible values", async (locale) => {
    renderDialog(locale, { assistantProposal: rentProposal });
    const c = copy(locale);
    await waitFor(() => expect(input("e.g. Brake pad replacement").value).toBe("Office rent"));
    expect(network.mutate).not.toHaveBeenCalled();

    // The user corrects one field before saving; the saved value is the visible one.
    fireEvent.change(input("250"), { target: { value: "125" } });
    fireEvent.click(screen.getByRole("button", { name: c.RecordExpense }));

    await waitFor(() => expect(network.mutate).toHaveBeenCalledTimes(1));
    expect(network.mutate.mock.calls[0][0]).toEqual({
      idempotencyKey: expect.stringMatching(/^create-expense:/),
      orgId: "org_a1039",
      title: "Office rent",
      amount: 125,
      taxAmount: 15,
      date: Date.UTC(2026, 10, 20),
      category: "RENT",
      vehicleId: undefined,
      status: "PAID",
      vendor: "Al Noor Properties",
      vendorSupplierId: undefined,
      payerId: undefined,
      paymentMethod: "CASH",
      bankAccountId: undefined,
      notes: "November",
      isPrepaid: false,
      amortizationMonths: undefined,
      amortizationStartDate: undefined,
      costBearer: undefined,
    });
  });

  test.each(["en", "ar"] as const)("%s leaves absent optional fields at the form defaults", async (locale) => {
    renderDialog(locale, { assistantProposal: { amount: 35, category: "TRANSPORT", date: "2026-11-27", title: "Fuel" } });
    const c = copy(locale);
    await waitFor(() => expect(input("e.g. Brake pad replacement").value).toBe("Fuel"));
    expect(input("0").value).toBe("0");
    expect(input("e.g. Joe's Repair Shop").value).toBe("");
    expect((screen.getByPlaceholderText(c.AnyExtraDetails) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText(c.ExpenseAssistantNoticeCategory)).toBeNull();
    expect(screen.queryByText(c.ExpenseAssistantNoticePaymentMethod)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: c.RecordExpense }));
    await waitFor(() => expect(network.mutate).toHaveBeenCalledTimes(1));
    expect(network.mutate.mock.calls[0][0]).toMatchObject({ taxAmount: undefined, vendor: "", notes: "", paymentMethod: "CASH", status: "PAID", payerId: undefined, vehicleId: undefined });
  });

  test.each(["en", "ar"] as const)("%s keeps the default category and payment method when the form does not offer the proposed ones, and says so", async (locale) => {
    renderDialog(locale, { assistantProposal: { ...rentProposal, category: "PREPAID", paymentMethod: "ON_ACCOUNT" } });
    const c = copy(locale);
    expect(await screen.findByText(c.ExpenseAssistantNoticeCategory)).toBeTruthy();
    expect(screen.getByText(c.ExpenseAssistantNoticePaymentMethod)).toBeTruthy();
    await waitFor(() => expect(input("e.g. Brake pad replacement").value).toBe("Office rent"));
    expect(screen.getByRole("combobox", { name: c.Category }).textContent).toContain(c.Other);
    fireEvent.click(screen.getByRole("button", { name: c.RecordExpense }));
    await waitFor(() => expect(network.mutate).toHaveBeenCalledTimes(1));
    expect(network.mutate.mock.calls[0][0]).toMatchObject({ category: "OTHER", paymentMethod: "CASH" });
  });

  test("a proposed card payment is shown, and the bank stays the user's choice", async () => {
    renderDialog("en", { assistantProposal: { ...rentProposal, paymentMethod: "CARD" } });
    await waitFor(() => expect(input("e.g. Brake pad replacement").value).toBe("Office rent"));
    expect(screen.getAllByText(dictionaries.en.PaymentMethod_CARD).length).toBeGreaterThan(0);
    // No bank was proposed and none is chosen: the existing bank rule refuses before any call.
    fireEvent.click(screen.getByRole("button", { name: dictionaries.en.RecordExpense }));
    await waitFor(() => expect(screen.getByText(dictionaries.en.ServerError_EXPENSE_BANK_INVALID)).toBeTruthy());
    expect(network.mutate).not.toHaveBeenCalled();
  });
});

describe("ExpenseDialog without a proposal is unchanged", () => {
  test.each(["en", "ar"] as const)("%s create mode: no notice, today's defaults, and the same create payload", async (locale) => {
    renderDialog(locale);
    const c = copy(locale);
    expect(await screen.findByRole("button", { name: c.RecordExpense })).toBeTruthy();
    expect(screen.queryByText(c.ExpenseAssistantNoticeTitle ?? "Filled by the assistant")).toBeNull();
    const today = new Date().toISOString().split("T")[0];
    expect(input("e.g. Brake pad replacement").value).toBe("");
    expect(screen.getByDisplayValue(today)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: c.Category }).textContent).toContain(c.Other);

    fireEvent.change(input("e.g. Brake pad replacement"), { target: { value: "Car wash" } });
    fireEvent.change(input("250"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: c.RecordExpense }));
    await waitFor(() => expect(network.mutate).toHaveBeenCalledTimes(1));
    expect(network.mutate.mock.calls[0][0]).toEqual({
      idempotencyKey: expect.stringMatching(/^create-expense:/),
      orgId: "org_a1039",
      title: "Car wash",
      amount: 10,
      taxAmount: undefined,
      date: new Date(today).getTime(),
      category: "OTHER",
      vehicleId: undefined,
      status: "PAID",
      vendor: "",
      vendorSupplierId: undefined,
      payerId: undefined,
      paymentMethod: "CASH",
      bankAccountId: undefined,
      notes: "",
      isPrepaid: false,
      amortizationMonths: undefined,
      amortizationStartDate: undefined,
      costBearer: undefined,
    });
  });

  test.each(["en", "ar"] as const)("%s edit mode: no notice and the stored values", async (locale) => {
    const expense: Doc<"expenses"> = {
      _id: "expense_a1" as Id<"expenses">, _creationTime: 0, orgId: "org_a1039" as Id<"organizations">,
      title: "Stored title", amount: 40, date: Date.UTC(2026, 0, 5), category: "OFFICE", status: "PENDING", paymentMethod: "CASH",
    };
    renderDialog(locale, { expense });
    const c = copy(locale);
    await waitFor(() => expect(input("e.g. Brake pad replacement").value).toBe("Stored title"));
    expect(screen.getByDisplayValue("2026-01-05")).toBeTruthy();
    expect(screen.queryByText(c.ExpenseAssistantNoticeTitle ?? "Filled by the assistant")).toBeNull();
    expect(screen.getByRole("button", { name: c.SaveChanges })).toBeTruthy();
  });
});
