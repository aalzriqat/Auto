import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { OpeningBalanceCard } from "./OpeningBalanceCard";

const boundary = vi.hoisted(() => ({
  amountMinor: 200_003,
  mode: "edit" as "edit" | "request" | "approve" | "unavailable",
  calls: {
    edit: vi.fn(), request: vi.fn(), approve: vi.fn(), direct: vi.fn(), draft: vi.fn(),
  },
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org-s850" }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "accountingCutover:openingBalanceStatus") return { posted: boundary.mode !== "edit", pendingExists: boundary.mode === "edit",
        canManageFinance: true, canPostDirectly: true, currency: "JOD", canReadOpeningStockCost: true,
        canSelectCustomers: true, canSelectEmployees: true, canSelectPartners: true, canSelectVehicles: true };
      if (name === "openingBalanceMaintenance:status") {
        if (boundary.mode === "unavailable") return undefined;
        return { canRequestVoid: boundary.mode === "request", canApproveVoid: boundary.mode === "approve", postedDraftId: "posted-s850",
          voidReason: boundary.mode === "approve" ? "Synthetic documented reason" : null,
          editable: boundary.mode === "edit" ? { _id: "pending-s850", currency: "JOD", asOfDate: Date.UTC(2026, 0, 1), memo: "Original memo", allocations: [], lines: [
            { accountId: "cash-s850", debitMinor: boundary.amountMinor, creditMinor: 0, description: "Preserved description" },
            { accountId: "retained-s850", debitMinor: 0, creditMinor: boundary.amountMinor },
          ] } : null };
      }
      if (name === "chartOfAccounts:list") return [
        { _id: "cash-s850", code: "1010", name: "Cash", nameAr: "النقد", normalBalance: "DEBIT" },
        { _id: "retained-s850", code: "3000", name: "Retained earnings", nameAr: "أرباح مدورة", normalBalance: "CREDIT" },
      ];
      if (name === "accountingCutover:listOpeningAccountPolicies") return [
        { accountId: "cash-s850", policy: "LEDGER_ONLY" }, { accountId: "retained-s850", policy: "LEDGER_ONLY" },
      ];
      if (name === "bankAccounts:list") return [];
      if (name === "accountingCutover:postedOpeningAllocationReadback") return null;
      throw new Error(`Unexpected query ${name}`);
    },
    useMutation: (reference: never) => {
      switch (getFunctionName(reference)) {
        case "accountingCutover:editOpeningBalanceDraft": return boundary.calls.edit;
        case "accountingCutover:postOpeningBalanceDirect": return boundary.calls.direct;
        case "accountingCutover:draftOpeningBalance": return boundary.calls.draft;
        case "openingBalanceMaintenance:requestVoid": return boundary.calls.request;
        case "openingBalanceMaintenance:approveVoid": return boundary.calls.approve;
        default: throw new Error("Unexpected mutation");
      }
    },
  };
});
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  boundary.amountMinor = 200_003;
  vi.clearAllMocks();
  Object.values(boundary.calls).forEach(call => call.mockResolvedValue(null));
  vi.stubGlobal("confirm", vi.fn(() => true));
});

test("SCRUM-850 R1 unchanged large draft saves the original exact minor units and empty zero sides", async () => {
  boundary.amountMinor = 9_007_199_254_740_991;
  show("en", "edit");
  fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  expect((screen.getAllByPlaceholderText("Debit")[1] as HTMLInputElement).value).toBe("");
  expect((screen.getAllByPlaceholderText("Credit")[0] as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Save changes for approval" }));
  await waitFor(() => expect(boundary.calls.edit).toHaveBeenCalledWith(expect.objectContaining({ lines: [
    { accountId: "cash-s850", debitMinor: 9_007_199_254_740_991, creditMinor: 0, description: "Preserved description" },
    { accountId: "retained-s850", debitMinor: 0, creditMinor: 9_007_199_254_740_991, description: undefined },
  ] })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function show(locale: "en" | "ar", mode: typeof boundary.mode) {
  boundary.mode = mode;
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  render(<LanguageProvider><OpeningBalanceCard /></LanguageProvider>);
}

test.each(["en", "ar"] as const)("SCRUM-850 pending editor in %s preserves exact amounts and saves for independent approval", async locale => {
  show(locale, "edit");
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Edit draft" : "تعديل المسودة" }));
  const debit = screen.getAllByPlaceholderText(locale === "en" ? "Debit" : "مدين");
  const credit = screen.getAllByPlaceholderText(locale === "en" ? "Credit" : "دائن");
  expect((debit[0] as HTMLInputElement).value).toBe("200.003");
  fireEvent.change(debit[0], { target: { value: "321.007" } });
  fireEvent.change(credit[1], { target: { value: "321.007" } });
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Save changes for approval" : "حفظ التعديلات للموافقة" }));
  await waitFor(() => expect(boundary.calls.edit).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-s850", draftId: "pending-s850",
    expectedCurrency: "JOD", lines: [
      { accountId: "cash-s850", debitMinor: 321_007, creditMinor: 0, description: "Preserved description" },
      { accountId: "retained-s850", debitMinor: 0, creditMinor: 321_007, description: undefined },
    ] })));
  expect(boundary.calls.direct).not.toHaveBeenCalled();
  expect(boundary.calls.draft).not.toHaveBeenCalled();
});

test.each(["en", "ar"] as const)("SCRUM-850 request void in %s sends the documented reason and source id", async locale => {
  show(locale, "request");
  const reason = screen.getByLabelText(locale === "en" ? "Reason for void" : "سبب الإلغاء");
  const button = screen.getByRole("button", { name: locale === "en" ? "Request void" : "طلب الإلغاء" });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.change(reason, { target: { value: "Synthetic error in opening" } });
  fireEvent.click(button);
  await waitFor(() => expect(boundary.calls.request).toHaveBeenCalledWith({ orgId: "org-s850", draftId: "posted-s850", reason: "Synthetic error in opening" }));
  expect(reason.closest("section")?.getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
  expect(boundary.calls.approve).not.toHaveBeenCalled();
});

test.each(["en", "ar"] as const)("SCRUM-850 approve void in %s displays the fixed reason and uses the approval command", async locale => {
  show(locale, "approve");
  expect(screen.getByText("Synthetic documented reason").textContent).toBe("Synthetic documented reason");
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Approve void" : "اعتماد الإلغاء" }));
  await waitFor(() => expect(boundary.calls.approve).toHaveBeenCalledWith({ orgId: "org-s850", draftId: "posted-s850" }));
  expect(boundary.calls.request).not.toHaveBeenCalled();
});

test("SCRUM-850 unavailable capability offers no edit or void command", () => {
  show("en", "unavailable");
  expect(screen.queryByRole("button", { name: /void|edit/i })).toBeNull();
});
