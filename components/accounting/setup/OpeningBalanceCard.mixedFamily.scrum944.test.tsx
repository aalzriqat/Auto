/**
 * SCRUM-944: the opening card must not offer a submit the server always refuses. Two rows on one declared control
 * account that disagree on obligation type are refused by `validateDeclaredOpeningControl` ("Every opening control
 * needs one explicitly declared allocation family"), so the screen keeps the save button disabled until they agree.
 * Real LanguageProvider and real card; only the Convex hooks, the Radix Select (a native one stands in), the
 * allocation editor (a stub that adds two otherwise-valid payable rows of the kinds the test chooses) and the toast
 * are replaced. The real editor's alert is covered in OpeningAllocationEditor.test.tsx.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { OpeningBalanceCard } from "./OpeningBalanceCard";

const fixture = vi.hoisted(() => ({ kinds: ["OTHER_PAYABLE", "OTHER_PAYABLE"] as string[] }));

vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org-a" }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      switch (getFunctionName(ref)) {
        case "openingBalanceMaintenance:status":
          return { editable: null, postedDraftId: null, canRequestVoid: false, canApproveVoid: false, voidReason: null };
        case "accountingCutover:openingBalanceStatus":
          return {
            posted: false, pendingExists: false, canManageFinance: true, currency: "JOD", canPostDirectly: true,
            canSelectCustomers: false, canSelectEmployees: false, canSelectPartners: false, canSelectVehicles: false,
          };
        case "chartOfAccounts:list":
          return [
            { _id: "cash", code: "1010", name: "Cash", nameAr: "نقد", normalBalance: "DEBIT" },
            { _id: "payables", code: "2000", name: "Other payables", nameAr: "ذمم دائنة أخرى", normalBalance: "CREDIT" },
          ];
        case "accountingCutover:listOpeningAccountPolicies":
          return [
            { accountId: "cash", policy: "PLAIN" },
            { accountId: "payables", policy: "DECLARED_LIABILITY", allowedKinds: ["OTHER_PAYABLE", "SUPPLIER_PAYABLE"] },
          ];
        case "bankAccounts:list":
          return [];
        default:
          throw new Error(`Unexpected opening card subscription: ${getFunctionName(ref)}`);
      }
    },
    useMutation: () => vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
      onClick: () => onChange(fixture.kinds.map((kind, index) => ({
        rowKey: `pay${index + 1}`, accountId: groups[0].accountId, kind, partyId: "", partyLabel: "",
        amount: "50.000", title: "Historical balance", dueDate: "", note: "", counterpartyName: "Counterparty",
        ...(kind === "SUPPLIER_PAYABLE" ? { supplierId: "supplier-1" } : {}),
      }))),
    }, "add-two-payables"),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TEXT = {
  en: { open: "Set opening balance", post: "Post opening balance" },
  ar: { open: "تسجيل الرصيد الافتتاحي", post: "ترحيل الرصيد الافتتاحي" },
} as const;

/** Cash 100.000 against two payable rows of 50.000 each: totals match, and only the row kinds vary. */
function fillOpening(locale: "en" | "ar", kinds: string[]) {
  fixture.kinds = kinds;
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  render(<LanguageProvider><OpeningBalanceCard /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: TEXT[locale].open }));
  const selects = screen.getAllByTestId("account-select");
  fireEvent.change(selects[0], { target: { value: "cash" } });
  fireEvent.change(selects[1], { target: { value: "payables" } });
  fireEvent.change(screen.getAllByPlaceholderText(locale === "en" ? "Debit" : "مدين")[0], { target: { value: "100.000" } });
  fireEvent.change(screen.getAllByPlaceholderText(locale === "en" ? "Credit" : "دائن")[1], { target: { value: "100.000" } });
  fireEvent.click(screen.getByRole("button", { name: "add-two-payables" }));
  return screen.getByRole("button", { name: TEXT[locale].post }) as HTMLButtonElement;
}

function submitDisabledInBothLanguages(kinds: string[]): boolean[] {
  return (["en", "ar"] as const).map((locale) => {
    const disabled = fillOpening(locale, kinds).disabled;
    cleanup();
    return disabled;
  });
}

describe("SCRUM-944 opening card with two payable rows", () => {
  test("rows of different kinds on one declared account keep the submit button disabled in English and Arabic", () => {
    expect(submitDisabledInBothLanguages(["OTHER_PAYABLE", "SUPPLIER_PAYABLE"])).toEqual([true, true]);
  });

  test("control: the same two rows with one kind enable the submit button in English and Arabic", () => {
    expect(submitDisabledInBothLanguages(["OTHER_PAYABLE", "OTHER_PAYABLE"])).toEqual([false, false]);
  });
});