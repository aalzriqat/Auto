/** Static paint bridge: real mounted opening components and dictionaries with synthetic SDK rows. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { OpeningAllocationEditor } from "./OpeningAllocationEditor";
import { OpeningBalanceApprovalView, type PendingOpeningBalanceDraft } from "./OpeningBalanceApprovalPanel";
import { OpeningBalanceCard } from "./OpeningBalanceCard";
import type { OpeningAllocationDraft, OpeningAllocationGroup } from "./openingAllocationForm";

const fixture = vi.hoisted(() => ({ locale: "en", values: new Map<string, unknown>() }));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org-a" }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (!fixture.values.has(name)) throw new Error(`Unexpected opening fixture subscription: ${name}`);
      return fixture.values.get(name);
    },
    usePaginatedQuery: (ref: never, args: unknown) => {
      if (args === "skip") return { results: [], status: "Exhausted", loadMore: vi.fn() };
      const name = getFunctionName(ref);
      if (!fixture.values.has(name)) throw new Error(`Unexpected opening fixture page: ${name}`);
      return { results: fixture.values.get(name), status: "Exhausted", loadMore: vi.fn() };
    },
    useMutation: () => vi.fn(),
  };
});

const orgId = "org-a" as Id<"organizations">;
const groups: OpeningAllocationGroup[] = [
  { accountId: "ar", kind: "CUSTOMER_RECEIVABLE", journalMinor: 100_000, label: "1200 · Accounts Receivable" },
  { accountId: "advance", kind: "EMPLOYEE_ADVANCE", journalMinor: 40_000, label: "1250 · Employee Advances" },
  { accountId: "capital", kind: "PARTNER_CAPITAL", journalMinor: 140_000, label: "3010 · Partner Capital" },
];
const rows: OpeningAllocationDraft[] = [
  { rowKey: "ar-row", accountId: "ar", kind: "CUSTOMER_RECEIVABLE", partyId: "customer-a", partyLabel: "Synthetic Customer · •••7890", amount: "100.000", title: "Prior receivable", dueDate: "2026-01-01", note: "" },
  { rowKey: "advance-row", accountId: "advance", kind: "EMPLOYEE_ADVANCE", partyId: "employee-a", partyLabel: "Synthetic Employee · employee@example.test", amount: "40.000", title: "", dueDate: "", note: "Prior advance" },
  { rowKey: "capital-row", accountId: "capital", kind: "PARTNER_CAPITAL", partyId: "partner-a", partyLabel: "Synthetic Partner · tner-a", amount: "140.000", title: "", dueDate: "", note: "" },
];
const review: PendingOpeningBalanceDraft = {
  _id: "draft-a", asOfDate: Date.UTC(2026, 0, 1), createdBy: "preparer-a",
  preparedByName: "Synthetic Preparer", currency: "JOD", denominationKnown: true,
  lines: [
    { accountId: "ar", accountCode: "1200", accountName: "Accounts Receivable", accountNameAr: "ذمم مدينة", debitMinor: 100_000, creditMinor: 0 },
    { accountId: "advance", accountCode: "1250", accountName: "Employee Advances", accountNameAr: "سلف الموظفين", debitMinor: 40_000, creditMinor: 0 },
    { accountId: "capital", accountCode: "3010", accountName: "Partner Capital", accountNameAr: "رأس مال الشركاء", debitMinor: 0, creditMinor: 140_000 },
  ],
  payrollSensitive: true, viewerCanManagePayroll: true,
  readiness: { blockerCodes: [], canApprove: true, canReject: true },
  allocationDetails: rows.map((row, index) => ({ rowKey: row.rowKey, kind: row.kind,
    accountId: row.accountId, accountCode: groups[index].label.slice(0, 4),
    accountName: groups[index].label.slice(7),
    accountNameAr: ["ذمم مدينة", "سلف الموظفين", "رأس مال الشركاء"][index],
    partyId: row.partyId, partyName: row.partyLabel, partyDetail: row.partyId,
    partyAvailable: true, amountMinor: groups[index].journalMinor })),
};

function capture(name: string) {
  const directory = process.env.OPENING_ALLOCATION_VISUAL_FIXTURE_DIR;
  if (directory) {
    // A static HTML bridge must persist the native select's live property.
    for (const select of document.querySelectorAll("select")) {
      for (const option of select.options) option.toggleAttribute("selected", option.selected);
    }
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `${name}-${fixture.locale}.html`), document.body.innerHTML);
  }
  cleanup();
}
function mount(node: React.ReactNode) {
  return render(<LanguageProvider>{node}</LanguageProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); fixture.values.clear(); });

test.each(["en", "ar"] as const)("opening allocation visual fixtures %s", (locale) => {
  fixture.locale = locale;
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  fixture.values.set("memberships:list", [{ userId: "employee-a", userName: "Synthetic Employee", userEmail: "employee@example.test" }]);
  fixture.values.set("partnerEquity:list", [{ _id: "partner-a", partnerName: "Synthetic Partner" }]);
  const entryGroups = groups.map((group, index) => ({ ...group,
    label: locale === "ar" ? `${group.label.slice(0, 4)} · ${["ذمم مدينة", "سلف الموظفين", "رأس مال الشركاء"][index]}` : group.label }));
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningAllocationEditor orgId={orgId} currency="JOD"
    groups={entryGroups} rows={rows} onChange={vi.fn()} canSelectCustomers canSelectEmployees canSelectPartners /></div>);
  expect(screen.getAllByText("Synthetic Customer · •••7890")).toHaveLength(2);
  capture("entry");

  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceApprovalView draft={review}
    isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()} /></div>);
  expect(screen.getByTestId("opening-balance-approval")).toBeTruthy();
  capture("review");

  fixture.values.set("accountingCutover:openingBalanceStatus", { posted: true, pendingExists: false,
    canManageFinance: true, currency: "JOD", canPostDirectly: true });
  fixture.values.set("chartOfAccounts:list", []);
  fixture.values.set("bankAccounts:list", []);
  fixture.values.set("accountingCutover:postedOpeningAllocationReadback", {
    journalStatus: "POSTED", currency: "JOD", rows: [
      { kind: "CUSTOMER_RECEIVABLE", rowKey: "ar-row", restricted: false, accountId: "ar", accountCode: "1200",
        accountName: "Accounts Receivable", accountNameAr: "ذمم مدينة", amountMinor: 100_000,
        partyId: "customer-a", partyName: "Synthetic Customer", documentId: "receivable-a", recordAvailable: true, allocationStatus: "AVAILABLE" },
      { kind: "EMPLOYEE_ADVANCE", rowKey: "advance-row", restricted: false, accountId: "advance", accountCode: "1250",
        accountName: "Employee Advances", accountNameAr: "سلف الموظفين", amountMinor: 40_000,
        partyId: "employee-a", partyName: "Synthetic Employee", documentId: "advance-a", recordAvailable: true, allocationStatus: "AVAILABLE" },
    ],
  });
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceCard /></div>);
  expect(screen.getByText("Synthetic Customer")).toBeTruthy();
  capture("readback");

  fixture.values.set("accountingCutover:postedOpeningAllocationReadback", {
    journalStatus: "POSTED", currency: "JOD", rows: [{ kind: "EMPLOYEE_ADVANCE", restricted: true }],
  });
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceCard /></div>);
  expect(screen.queryByText("Synthetic Employee")).toBeNull();
  capture("redacted");

  const prepaidGroup: OpeningAllocationGroup = { accountId: "prepaid", kind: "PREPAID_EXPENSE",
    journalMinor: 60_000, label: locale === "ar" ? "1450 · مصروفات مدفوعة مقدمًا" : "1450 · Prepaid Expenses" };
  const prepaidRow: OpeningAllocationDraft = { rowKey: "prepaid-row", accountId: "prepaid", kind: "PREPAID_EXPENSE",
    partyId: "", partyLabel: "", amount: "60.000", title: "Synthetic unexpired service",
    dueDate: "", note: "", startYearMonth: "2026-01", termMonths: "3",
    expenseSystemKey: "RENT_EXPENSE", attestedUnexpiredBenefit: true };
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningAllocationEditor orgId={orgId} currency="JOD"
    groups={[prepaidGroup]} rows={[prepaidRow]} onChange={vi.fn()}
    canSelectCustomers={false} canSelectEmployees={false} canSelectPartners={false} /></div>);
  expect(screen.getByDisplayValue("Synthetic unexpired service")).toBeTruthy();
  capture("prepaid-entry");

  const prepaidReview: PendingOpeningBalanceDraft = { ...review, payrollSensitive: false,
    lines: [{ accountId: "prepaid", accountCode: "1450", accountName: "Prepaid Expenses",
      accountNameAr: "مصروفات مدفوعة مقدمًا", debitMinor: 60_000, creditMinor: 0 },
      { accountId: "offset", accountCode: "3200", accountName: "Opening offset",
        accountNameAr: "مقابل افتتاحي", debitMinor: 0, creditMinor: 60_000 }],
    allocationDetails: [{ rowKey: "prepaid-row", kind: "PREPAID_EXPENSE", accountId: "prepaid",
      accountCode: "1450", accountName: "Prepaid Expenses", accountNameAr: "مصروفات مدفوعة مقدمًا",
      partyId: "prepaid-row", partyName: "Synthetic unexpired service", partyDetail: null,
      partyAvailable: true, amountMinor: 60_000, title: "Synthetic unexpired service",
      startYearMonth: "2026-01", termMonths: 3, expenseSystemKey: "RENT_EXPENSE",
      attestedUnexpiredBenefit: true }],
  };
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceApprovalView draft={prepaidReview}
    isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()} /></div>);
  expect(screen.getByText("Synthetic unexpired service")).toBeTruthy();
  capture("prepaid-review");

  fixture.values.set("accountingCutover:postedOpeningAllocationReadback", {
    journalStatus: "POSTED", currency: "JOD", rows: [{ kind: "PREPAID_EXPENSE",
      rowKey: "prepaid-row", restricted: false, accountId: "prepaid", accountCode: "1450",
      accountName: "Prepaid Expenses", accountNameAr: "مصروفات مدفوعة مقدمًا",
      amountMinor: 60_000, partyId: "prepaid-row", partyName: "Synthetic unexpired service",
      documentId: "schedule-a", recordAvailable: true, allocationStatus: "AVAILABLE" }],
  });
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceCard /></div>);
  expect(screen.getByText("Synthetic unexpired service")).toBeTruthy();
  capture("prepaid-readback");

  const stockGroup: OpeningAllocationGroup = { accountId: "stock", kind: "VEHICLE_INVENTORY",
    journalMinor: 8_000_000, label: locale === "ar" ? "1300 · مخزون المركبات" : "1300 · Vehicle Inventory" };
  const stockRow: OpeningAllocationDraft = { rowKey: "stock-row", accountId: "stock",
    kind: "VEHICLE_INVENTORY", partyId: "vehicle-a",
    partyLabel: "SYNTHSTOCKVIN001 · 2024 Example Stock", amount: "8000.000", title: "", dueDate: "", note: "" };
  fixture.values.set("accountingCutover:listOpeningStockChoices", [{ vehicleId: "vehicle-a",
    vin: "SYNTHSTOCKVIN001", label: "2024 Example Stock", amountMinor: 8_000_000, available: true }]);
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningAllocationEditor orgId={orgId} currency="JOD"
    groups={[stockGroup]} rows={[stockRow]} onChange={vi.fn()}
    canSelectCustomers={false} canSelectEmployees={false} canSelectPartners={false} /></div>);
  expect(screen.getByRole("combobox", { name: locale === "ar"
    ? "مركبة مخزون افتتاحي مستوردة" : "Imported opening vehicle" })).toBeTruthy();
  capture("stock-entry");

  const stockReview: PendingOpeningBalanceDraft = { ...review, payrollSensitive: false,
    lines: [{ accountId: "stock", accountCode: "1300", accountName: "Vehicle Inventory",
      accountNameAr: "مخزون المركبات", debitMinor: 8_000_000, creditMinor: 0 },
      { accountId: "offset", accountCode: "3200", accountName: "Opening offset",
        accountNameAr: "مقابل افتتاحي", debitMinor: 0, creditMinor: 8_000_000 }],
    allocationDetails: [{ rowKey: "stock-row", kind: "VEHICLE_INVENTORY", accountId: "stock",
      accountCode: "1300", accountName: "Vehicle Inventory", accountNameAr: "مخزون المركبات",
      partyId: "vehicle-a", partyName: "SYNTHSTOCKVIN001", partyDetail: "2024 Example Stock",
      partyAvailable: true, amountMinor: 8_000_000 }],
  };
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceApprovalView draft={stockReview}
    isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()} /></div>);
  expect(screen.getByText("SYNTHSTOCKVIN001")).toBeTruthy();
  capture("stock-review");

  fixture.values.set("accountingCutover:postedOpeningAllocationReadback", {
    journalStatus: "POSTED", currency: "JOD", rows: [{ kind: "VEHICLE_INVENTORY",
      rowKey: "stock-row", restricted: false, accountId: "stock", accountCode: "1300",
      accountName: "Vehicle Inventory", accountNameAr: "مخزون المركبات", amountMinor: 8_000_000,
      partyId: "vehicle-a", partyName: "SYNTHSTOCKVIN001", documentId: "vehicle-a", recordAvailable: true, allocationStatus: "AVAILABLE" }],
  });
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceCard /></div>);
  expect(screen.getByText("SYNTHSTOCKVIN001")).toBeTruthy();
  capture("stock-readback");

  // Each positive review uses an admissible declared control: the backend
  // forbids mixed families and mixed unknown purposes on one account.
  const remainingControls = [
    { accountId: "recoverable", code: "1360", name: "Supplier recoverable", nameAr: "مستحق من مورد", kind: "SUPPLIER_RECOVERABLE", amountMinor: 4_001 },
    { accountId: "supplier-payable", code: "2391", name: "Opening supplier payable", nameAr: "التزام افتتاحي لمورد", kind: "SUPPLIER_PAYABLE", amountMinor: 4_001 },
    { accountId: "other-payable", code: "2392", name: "Opening other payable", nameAr: "التزام افتتاحي آخر", kind: "OTHER_PAYABLE", amountMinor: 4_001 },
    { accountId: "commission", code: "2393", name: "Opening employee commission", nameAr: "عمولة موظف افتتاحية", kind: "EMPLOYEE_COMMISSION", amountMinor: 7_777 },
    { accountId: "deposit", code: "2100", name: "Customer deposits", nameAr: "عربون العملاء", kind: "UNALLOCATED_LIABILITY", amountMinor: 4_001 },
    { accountId: "receipt", code: "2394", name: "Opening unidentified receipt control", nameAr: "حساب المقبوضات الافتتاحية غير المحددة", kind: "UNALLOCATED_LIABILITY", amountMinor: 4_001 },
  ] as const;
  const customLiabilityKinds: OpeningAllocationGroup["kind"][] = ["SUPPLIER_PAYABLE", "OTHER_PAYABLE", "EMPLOYEE_COMMISSION", "UNALLOCATED_LIABILITY"];
  const remainingGroups: OpeningAllocationGroup[] = remainingControls.map(control => ({
    accountId: control.accountId, kind: control.kind,
    allowedKinds: control.kind === "SUPPLIER_RECOVERABLE" ? ["SUPPLIER_RECOVERABLE"]
      : control.accountId === "deposit" ? ["UNALLOCATED_LIABILITY"] : customLiabilityKinds,
    allowedPurposes: control.accountId === "deposit" ? ["CUSTOMER_DEPOSIT"] : ["UNIDENTIFIED_RECEIPT"],
    journalMinor: control.amountMinor,
    label: `${control.code} · ${locale === "ar" ? control.nameAr : control.name}`,
  }));
  const remainingRows: OpeningAllocationDraft[] = [
    { rowKey: "recoverable", accountId: "recoverable", kind: "SUPPLIER_RECOVERABLE", partyId: "", partyLabel: "",
      counterpartyName: "Synthetic Supplier", purpose: "CLAIM", amount: "4.001", title: "Prior claim", dueDate: "", note: "" },
    { rowKey: "supplier-payable", accountId: "supplier-payable", kind: "SUPPLIER_PAYABLE", partyId: "", partyLabel: "",
      counterpartyName: "Synthetic Supplier", amount: "4.001", title: "Prior supplier debt", dueDate: "", note: "" },
    { rowKey: "other-payable", accountId: "other-payable", kind: "OTHER_PAYABLE", partyId: "", partyLabel: "",
      counterpartyName: "Synthetic Creditor", amount: "4.001", title: "Prior other debt", dueDate: "", note: "" },
    { rowKey: "commission", accountId: "commission", kind: "EMPLOYEE_COMMISSION", partyId: "employee-a",
      partyLabel: "Synthetic Employee", amount: "7.777", title: "", dueDate: "", note: "" },
    { rowKey: "deposit", accountId: "deposit", kind: "UNALLOCATED_LIABILITY", partyId: "", partyLabel: "",
      purpose: "CUSTOMER_DEPOSIT", amount: "4.001", title: "Unassigned deposits", dueDate: "", note: "" },
    { rowKey: "receipt", accountId: "receipt", kind: "UNALLOCATED_LIABILITY", partyId: "", partyLabel: "",
      purpose: "UNIDENTIFIED_RECEIPT", amount: "4.001", title: "Unidentified receipts", dueDate: "", note: "" },
  ];
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningAllocationEditor orgId={orgId} currency="JOD"
    groups={remainingGroups} rows={remainingRows} onChange={vi.fn()}
    canSelectCustomers={false} canSelectEmployees canSelectPartners={false} /></div>);
  expect(screen.getAllByRole("combobox", { name: locale === "ar" ? "نوع الالتزام التاريخي" : "Historical obligation type" })).toHaveLength(4);
  capture("remaining-entry");

  const remainingDetails: NonNullable<PendingOpeningBalanceDraft["allocationDetails"]> = remainingRows.map((row) => {
    const control = remainingControls.find(control => control.accountId === row.accountId);
    if (!control) throw new Error("Missing synthetic declared opening control");
    return {
      rowKey: row.rowKey, kind: row.kind, accountId: row.accountId,
      accountCode: control.code, accountName: control.name, accountNameAr: control.nameAr,
      partyId: row.kind === "EMPLOYEE_COMMISSION" ? row.partyId : null,
      partyName: row.kind === "EMPLOYEE_COMMISSION" ? "Synthetic Employee" : row.counterpartyName ?? null,
      partyDetail: null, partyAvailable: true,
      allocationStatus: row.kind === "UNALLOCATED_LIABILITY" ? "UNALLOCATED" : "AVAILABLE",
      amountMinor: control.amountMinor,
      title: row.title || undefined, purpose: row.purpose,
    };
  });
  const remainingReview: PendingOpeningBalanceDraft = { ...review,
    lines: [
      ...remainingControls.map(control => ({
        accountId: control.accountId, accountCode: control.code,
        accountName: control.name, accountNameAr: control.nameAr,
        debitMinor: control.kind === "SUPPLIER_RECOVERABLE" ? control.amountMinor : 0,
        creditMinor: control.kind === "SUPPLIER_RECOVERABLE" ? 0 : control.amountMinor,
      })),
      { accountId: "cash", accountCode: "1010", accountName: "Opening cash", debitMinor: 19_780, creditMinor: 0 },
    ],
    allocationDetails: remainingDetails,
  };
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceApprovalView draft={remainingReview}
    isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()} /></div>);
  expect(screen.getAllByText(locale === "ar"
    ? "يبقى هذا الالتزام غير موزع. لا تنسبه إلى عميل أو إيصال قبل تحديد مصدره بإجراء منفصل خاضع للمراجعة."
    : "This liability remains unallocated. Do not assign a customer or receipt until its source is identified through a separate reviewed process.")).toHaveLength(2);
  capture("remaining-review");

  const remainingReadbackRows = remainingDetails.map((row) => ({
    ...row, restricted: false, documentId: row.kind === "UNALLOCATED_LIABILITY" ? null : `${row.rowKey}-record`,
    recordAvailable: true,
  }));
  fixture.values.set("accountingCutover:postedOpeningAllocationReadback", {
    journalStatus: "POSTED", currency: "JOD", rows: remainingReadbackRows,
  });
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceCard /></div>);
  expect(screen.getAllByText(locale === "ar" ? "يبقى الالتزام غير موزع" : "Liability remains unallocated").length).toBeGreaterThan(0);
  expect(screen.getByText("Unassigned deposits")).toBeTruthy();
  expect(screen.getByText("Unidentified receipts")).toBeTruthy();
  capture("remaining-readback");

  fixture.values.set("accountingCutover:postedOpeningAllocationReadback", {
    journalStatus: "POSTED", currency: "JOD", rows: remainingReadbackRows.map((row) =>
      row.kind === "EMPLOYEE_COMMISSION" ? { kind: row.kind, restricted: true } : row),
  });
  mount(<div className="mx-auto max-w-5xl p-4"><OpeningBalanceCard /></div>);
  expect(screen.queryByText("Synthetic Employee")).toBeNull();
  capture("remaining-redacted");
});
