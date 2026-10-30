/**
 * SCRUM-858 (c23884, round-2 Seat 1 LOW): an opening balance that names a customer deposit is saved for an
 * accountant's approval, never posted directly, and the card must SAY so: the note and the button must not
 * offer "post this directly" while the click routes to the approval draft. Real LanguageProvider and the
 * real card; only the Convex hooks, the Radix Select (a native one stands in), the allocation editor
 * (a stub that adds one named deposit row) and the toast are replaced.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { OpeningBalanceCard } from "./OpeningBalanceCard";

const fixture = vi.hoisted(() => ({
  canPostDirectly: true,
  postDirect: undefined as unknown as ReturnType<typeof vi.fn>,
  draftForApproval: undefined as unknown as ReturnType<typeof vi.fn>,
  confirm: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org-a" }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      switch (getFunctionName(ref)) {
        case "accountingCutover:openingBalanceStatus":
          return {
            posted: false, pendingExists: false, canManageFinance: true, currency: "JOD",
            canPostDirectly: fixture.canPostDirectly, canSelectCustomers: true, canSelectEmployees: false,
            canSelectPartners: false, canSelectVehicles: false,
          };
        case "chartOfAccounts:list":
          return [
            { _id: "cash", code: "1010", name: "Cash", nameAr: "نقد", normalBalance: "DEBIT" },
            { _id: "deposit", code: "2100", name: "Customer deposits", nameAr: "عربون العملاء", normalBalance: "CREDIT" },
            { _id: "equity", code: "3000", name: "Owner equity", nameAr: "حقوق الملكية", normalBalance: "CREDIT" },
          ];
        case "accountingCutover:listOpeningAccountPolicies":
          return [
            { accountId: "cash", policy: "PLAIN" },
            { accountId: "equity", policy: "PLAIN" },
            { accountId: "deposit", policy: "DECLARED_LIABILITY", allowedKinds: ["CUSTOMER_DEPOSIT"] },
          ];
        case "bankAccounts:list":
          return [];
        default:
          throw new Error(`Unexpected opening card subscription: ${getFunctionName(ref)}`);
      }
    },
    useMutation: (ref: never) => {
      const name = getFunctionName(ref);
      if (name === "accountingCutover:postOpeningBalanceDirect") return fixture.postDirect;
      if (name === "accountingCutover:draftOpeningBalance") return fixture.draftForApproval;
      throw new Error(`Unexpected opening card mutation: ${name}`);
    },
  };
});
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// A native select keeps the account choice drivable in jsdom; the Radix one needs pointer-capture APIs.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children?: ReactNode }) =>
    createElement("select", { "data-testid": "account-select", value: value ?? "", onChange: (e: { target: { value: string } }) => onValueChange?.(e.target.value) },
      createElement("option", { value: "" }, "-"), children),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => children,
  SelectItem: ({ value }: { value: string }) => createElement("option", { value }, value),
}));
vi.mock("./OpeningAllocationEditor", () => ({
  OpeningAllocationEditor: ({ groups, onChange }: { groups: Array<{ accountId: string }>; onChange: (rows: unknown[]) => void }) =>
    createElement("button", {
      type: "button",
      onClick: () => onChange([{
        rowKey: "dep1", accountId: groups[0].accountId, kind: "CUSTOMER_DEPOSIT", partyId: "cust1", partyLabel: "Layla",
        amount: "100.000", title: "Opening security deposit", dueDate: "", note: "", depositKind: "SECURITY",
      }]),
    }, "add-named-deposit"),
}));

beforeEach(() => {
  fixture.canPostDirectly = true;
  fixture.postDirect = vi.fn().mockResolvedValue(undefined);
  fixture.draftForApproval = vi.fn().mockResolvedValue(undefined);
  fixture.confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", fixture.confirm);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TEXT = {
  en: { open: "Set opening balance", save: "Save for approval", post: "Post opening balance", owner: "As an owner you can post this directly, with no second approver.", deposit: "This opening balance names customer deposits, so it is saved for an accountant's approval and is not posted until it is approved." },
  ar: { open: "تسجيل الرصيد الافتتاحي", save: "حفظ للموافقة", post: "ترحيل الرصيد الافتتاحي", owner: "بصفتك المالك يمكنك الترحيل مباشرة دون موافقة شخص ثانٍ.", deposit: "يتضمن هذا الرصيد الافتتاحي عربونات عملاء مسمّاة، لذلك يُحفظ بانتظار موافقة المحاسب ولا يُرحَّل قبل الموافقة عليه." },
} as const;

/**
 * Opens the dialog and fills a balanced two-line opening: cash 100.000 against either the customer-deposits
 * control (which then needs a named deposit row) or plain owner equity (no allocation needed).
 */
function fillOpening(locale: "en" | "ar", withDeposit: boolean) {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  render(<LanguageProvider><OpeningBalanceCard /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: TEXT[locale].open }));
  const selects = screen.getAllByTestId("account-select");
  fireEvent.change(selects[0], { target: { value: "cash" } });
  fireEvent.change(selects[1], { target: { value: withDeposit ? "deposit" : "equity" } });
  const debit = screen.getAllByPlaceholderText(locale === "en" ? "Debit" : "مدين");
  const credit = screen.getAllByPlaceholderText(locale === "en" ? "Credit" : "دائن");
  fireEvent.change(debit[0], { target: { value: "100.000" } });
  fireEvent.change(credit[1], { target: { value: "100.000" } });
  if (withDeposit) fireEvent.click(screen.getByRole("button", { name: "add-named-deposit" }));
}

describe.each(["en", "ar"] as const)("opening balance card with a named customer deposit in %s", (locale) => {
  const text = TEXT[locale];

  test("a draft that names a deposit says it is saved for approval, offers no direct post, and routes to the approval draft", async () => {
    fillOpening(locale, true);
    expect(screen.queryByText(text.owner)).toBeNull();
    expect(screen.queryByRole("button", { name: text.post })).toBeNull();
    expect(screen.getByText(text.deposit)).toBeTruthy();
    const save = screen.getByRole("button", { name: text.save });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(fixture.draftForApproval).toHaveBeenCalledTimes(1));
    expect(fixture.postDirect).not.toHaveBeenCalled();
    expect(fixture.confirm).not.toHaveBeenCalled();
    const payload = fixture.draftForApproval.mock.calls[0][0] as { allocations: Array<{ kind: string }> };
    expect(payload.allocations.map((row) => row.kind)).toEqual(["CUSTOMER_DEPOSIT"]);
  });

  test("control: without a named deposit the owner still sees the direct note and button, and the click posts directly", async () => {
    fillOpening(locale, false);
    expect(screen.getByText(text.owner)).toBeTruthy();
    expect(screen.queryByRole("button", { name: text.save })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: text.post }));
    await waitFor(() => expect(fixture.postDirect).toHaveBeenCalledTimes(1));
    expect(fixture.draftForApproval).not.toHaveBeenCalled();
  });
});

test("a user who cannot post directly keeps the approval wording whether or not a deposit is named", () => {
  fixture.canPostDirectly = false;
  fillOpening("en", true);
  expect(screen.getByRole("button", { name: "Save for approval" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Post opening balance" })).toBeNull();
});
