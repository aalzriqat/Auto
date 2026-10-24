import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OpeningAllocationDraft, OpeningAllocationGroup } from "./openingAllocationForm";

const language = { locale: "en" as "en" | "ar" };
let queryRows: unknown[] | undefined = [{ _id: "customer-a", firstName: "Synthetic", lastName: "Customer", phone: "1234567890" }];
let memberRows: Array<{ userId: string; userName: string; userEmail: string }> = [];
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, locale: language.locale }),
}));
vi.mock("convex/react", () => ({
  useQuery: () => queryRows,
  usePaginatedQuery: () => ({ results: memberRows, status: "Exhausted", loadMore: vi.fn() }),
}));

import { OpeningAllocationEditor } from "./OpeningAllocationEditor";
import type { Id } from "@/convex/_generated/dataModel";

const group: OpeningAllocationGroup = { accountId: "account-a" as Id<"chartOfAccounts">, kind: "CUSTOMER_RECEIVABLE",
  journalMinor: 100_000, label: "1200 · Receivables" };
const selected: OpeningAllocationDraft = { rowKey: "row-a", accountId: group.accountId,
  kind: "CUSTOMER_RECEIVABLE", partyId: "customer-a" as Id<"customers">, partyLabel: "Synthetic Customer",
  amount: "100.000", title: "Opening debt", dueDate: "2026-01-01", note: "" };

afterEach(() => {
  cleanup();
  queryRows = [{ _id: "customer-a", firstName: "Synthetic", lastName: "Customer", phone: "1234567890" }];
  memberRows = [];
});

test.each(["loaded", "empty", "loading"])("an unavailable customer choice reports an error without replacing or dropping the existing row (%s)", state => {
  if (state === "empty") queryRows = [];
  if (state === "loading") queryRows = undefined;
  const onChange = vi.fn();
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[group]} rows={[selected]} onChange={onChange}
    canSelectCustomers canSelectEmployees={false} canSelectPartners={false} />);
  const select = screen.getByRole("combobox", { name: "OpeningAllocationCustomer" });
  const unavailable = document.createElement("option");
  unavailable.value = "unavailable-customer"; unavailable.text = "Unavailable choice";
  select.append(unavailable);
  fireEvent.change(select, { target: { value: unavailable.value } });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("OpeningAllocationPartyUnavailable");
});

test("an offered customer choice stores the query row identity and display snapshot", () => {
  queryRows = [{ _id: "customer-next", firstName: "Next", lastName: "Customer" }];
  const onChange = vi.fn();
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[group]} rows={[selected]} onChange={onChange}
    canSelectCustomers canSelectEmployees={false} canSelectPartners={false} />);
  fireEvent.change(screen.getByRole("combobox", { name: "OpeningAllocationCustomer" }),
    { target: { value: "customer-next" } });
  expect(onChange).toHaveBeenCalledWith([{ ...selected, partyId: "customer-next", partyLabel: "Next Customer" }]);
});

test.each(["en", "ar"] as const)("changing customer search clears stale selected party (%s)", (locale) => {
  language.locale = locale;
  const onChange = vi.fn();
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[group]} rows={[selected]} onChange={onChange}
    canSelectCustomers canSelectEmployees={false} canSelectPartners={false} />);
  const search = screen.getByRole("textbox", { name: "OpeningAllocationSearchCustomer" });
  fireEvent.focus(search);
  fireEvent.change(search, { target: { value: "Different person" } });
  expect(onChange).toHaveBeenCalledWith([{ ...selected, partyId: "", partyLabel: "" }]);
});

test("existing party-view grant gates selection", () => {
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[group]} rows={[]} onChange={vi.fn()}
    canSelectCustomers={false} canSelectEmployees={false} canSelectPartners={false} />);
  expect(screen.getByRole("alert").textContent).toBe("OpeningAllocationPermissionNeeded");
  expect(screen.getByRole("button", { name: "OpeningAllocationAdd" }).hasAttribute("disabled")).toBe(true);
});

test("selected older customer remains identifiable outside the current search result", () => {
  language.locale = "en";
  const older = { ...selected, partyId: "customer-older" as Id<"customers">, partyLabel: "Older customer · 1234" };
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[group]} rows={[older]} onChange={vi.fn()}
    canSelectCustomers canSelectEmployees={false} canSelectPartners={false} />);
  const select = screen.getByRole("combobox", { name: "OpeningAllocationCustomer" }) as HTMLSelectElement;
  expect(select.value).toBe("customer-older");
  expect(screen.getAllByText(/Older customer · 1234/)).toHaveLength(2);
});

test("empty eligible partner list directs normal onboarding", () => {
  const partnerGroup: OpeningAllocationGroup = { accountId: "capital-a" as Id<"chartOfAccounts">, kind: "PARTNER_CAPITAL",
    journalMinor: 100_000, label: "3010 · Capital" };
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[partnerGroup]} rows={[]} onChange={vi.fn()}
    canSelectCustomers={false} canSelectEmployees={false} canSelectPartners />);
  expect(screen.getByRole("status").textContent).toBe("OpeningAllocationNoEligibleParty");
});

test.each(["en", "ar"] as const)("prepaid row asks for source, dates and attestation without a party selector (%s)", (locale) => {
  language.locale = locale;
  const prepaidGroup: OpeningAllocationGroup = { accountId: "prepaid-a" as Id<"chartOfAccounts">, kind: "PREPAID_EXPENSE",
    journalMinor: 100_001, label: "1450 · Prepaid" };
  const prepaidRow: OpeningAllocationDraft = { rowKey: "prepaid-a", accountId: "prepaid-a" as Id<"chartOfAccounts">,
    kind: "PREPAID_EXPENSE", partyId: "", partyLabel: "", amount: "100.001",
    title: "Synthetic unexpired service", dueDate: "", note: "",
    startYearMonth: "2026-01", termMonths: "3", expenseSystemKey: "RENT_EXPENSE",
    attestedUnexpiredBenefit: false };
  const onChange = vi.fn();
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[prepaidGroup]} rows={[prepaidRow]} onChange={onChange}
    canSelectCustomers={false} canSelectEmployees={false} canSelectPartners={false} />);
  expect(screen.queryByRole("combobox", { name: "OpeningAllocationPartner" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "OpeningPrepaidTitle" })).toBeTruthy();
  expect(screen.getByLabelText("OpeningPrepaidStartMonth")).toBeTruthy();
  expect(screen.getByLabelText("OpeningPrepaidTermMonths")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "OpeningPrepaidAttestation" }));
  expect(onChange).toHaveBeenCalledWith([{ ...prepaidRow, attestedUnexpiredBenefit: true }]);
});

test.each(["en", "ar"] as const)("owned opening stock selection uses server-proven vehicle cost (%s)", (locale) => {
  language.locale = locale;
  queryRows = [{ vehicleId: "vehicle-a", vin: "SYNTHSTOCKVIN001", label: "2024 Example Stock",
    amountMinor: 8_000_000, available: true }];
  const stockGroup: OpeningAllocationGroup = { accountId: "inventory-a" as Id<"chartOfAccounts">, kind: "VEHICLE_INVENTORY",
    journalMinor: 8_000_000, label: "Inventory" };
  const stockRow: OpeningAllocationDraft = { rowKey: "stock-a", accountId: "inventory-a" as Id<"chartOfAccounts">,
    kind: "VEHICLE_INVENTORY", partyId: "", partyLabel: "", amount: "", title: "", dueDate: "", note: "" };
  const onChange = vi.fn();
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[stockGroup]} rows={[stockRow]} onChange={onChange}
    canSelectCustomers={false} canSelectEmployees={false} canSelectPartners={false} />);
  fireEvent.change(screen.getByRole("combobox", { name: "OpeningAllocationVehicle" }),
    { target: { value: "vehicle-a" } });
  expect(screen.queryByRole("option", { name: /vehicle-a/ })).toBeNull();
  expect(onChange).toHaveBeenCalledWith([{ ...stockRow, partyId: "vehicle-a",
    partyLabel: "SYNTHSTOCKVIN001 · 2024 Example Stock", amount: "8000.000" }]);
});

test.each(["en", "ar"] as const)("supplier snapshot and unknown-liability purposes have no invented party selector (%s)", (locale) => {
  language.locale = locale;
  const groups: OpeningAllocationGroup[] = [
    { accountId: "supplier" as Id<"chartOfAccounts">, kind: "SUPPLIER_RECOVERABLE", journalMinor: 4_001, label: "Supplier claim" },
    { accountId: "unknown" as Id<"chartOfAccounts">, kind: "UNALLOCATED_LIABILITY", journalMinor: 4_001, label: "Unknown deposits" },
  ];
  const rows: OpeningAllocationDraft[] = groups.map((group, index) => ({ rowKey: `row-${index}`,
    accountId: group.accountId, kind: group.kind, partyId: "", partyLabel: "", amount: "4.001",
    title: "Historical source", dueDate: "", note: "" }));
  const onChange = vi.fn();
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={groups} rows={rows} onChange={onChange}
    canSelectCustomers={false} canSelectEmployees={false} canSelectPartners={false} />);
  expect(screen.queryByRole("combobox", { name: "OpeningAllocationPartner" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "OpeningAllocationCounterpartySnapshot" }),
    { target: { value: "Synthetic supplier" } });
  expect(onChange).toHaveBeenCalledWith([{ ...rows[0], counterpartyName: "Synthetic supplier" }, rows[1]]);
  const purposes = screen.getAllByRole("combobox", { name: "OpeningAllocationPurpose" });
  expect(purposes).toHaveLength(2);
  fireEvent.change(purposes[1], { target: { value: "UNIDENTIFIED_RECEIPT" } });
  expect(onChange).toHaveBeenCalledWith([rows[0], { ...rows[1], purpose: "UNIDENTIFIED_RECEIPT" }]);
  expect(screen.getByRole("note").textContent).toBe("OpeningAllocationUnallocatedNotice");
});

test("opening commission selects an existing employee without accepting a title", () => {
  language.locale = "en";
  memberRows = [{ userId: "employee-1", userName: "Synthetic Employee", userEmail: "employee@example.test" }];
  const group: OpeningAllocationGroup = { accountId: "commission" as Id<"chartOfAccounts">, kind: "EMPLOYEE_COMMISSION",
    journalMinor: 4_001, label: "Historical commission" };
  const row: OpeningAllocationDraft = { rowKey: "commission-1", accountId: group.accountId,
    kind: group.kind, partyId: "", partyLabel: "", amount: "4.001", title: "", dueDate: "", note: "" };
  const onChange = vi.fn();
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[group]} rows={[row]} onChange={onChange}
    canSelectCustomers={false} canSelectEmployees canSelectPartners={false} />);
  fireEvent.change(screen.getByRole("combobox", { name: "OpeningAllocationEmployee" }),
    { target: { value: "employee-1" } });
  expect(onChange).toHaveBeenCalledWith([{ ...row, partyId: "employee-1",
    partyLabel: "Synthetic Employee · employee@example.test" }]);
  expect(screen.queryByRole("textbox", { name: "OpeningAllocationSourceTitle" })).toBeNull();
});

test("declared liability kind selector preserves the server's allowed set and clears stale source fields", () => {
  language.locale = "en";
  const group: OpeningAllocationGroup = { accountId: "liability" as Id<"chartOfAccounts">, kind: "SUPPLIER_PAYABLE",
    allowedKinds: ["SUPPLIER_PAYABLE", "OTHER_PAYABLE", "EMPLOYEE_COMMISSION", "UNALLOCATED_LIABILITY"],
    allowedPurposes: ["UNIDENTIFIED_RECEIPT"], journalMinor: 4_001, label: "Declared liability" };
  const row: OpeningAllocationDraft = { rowKey: "liability-1", accountId: group.accountId,
    kind: "SUPPLIER_PAYABLE", partyId: "", partyLabel: "", counterpartyName: "Synthetic supplier",
    amount: "4.001", title: "Old payable", dueDate: "", note: "" };
  const onChange = vi.fn();
  render(<OpeningAllocationEditor orgId={"org-a" as Id<"organizations">} currency="JOD"
    groups={[group]} rows={[row]} onChange={onChange}
    canSelectCustomers={false} canSelectEmployees={false} canSelectPartners={false} />);
  const kind = screen.getByRole("combobox", { name: "OpeningAllocationKind" });
  expect(kind.querySelectorAll("option")).toHaveLength(4);
  expect((kind.querySelector('option[value="EMPLOYEE_COMMISSION"]') as HTMLOptionElement).disabled).toBe(true);
  fireEvent.change(kind, { target: { value: "UNALLOCATED_LIABILITY" } });
  expect(onChange).toHaveBeenCalledWith([{ ...row, kind: "UNALLOCATED_LIABILITY", partyId: "",
    partyLabel: "", counterpartyName: "", title: "", purpose: undefined }]);
});
