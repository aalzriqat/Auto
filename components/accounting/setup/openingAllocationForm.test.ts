import type { Id } from "@/convex/_generated/dataModel";
import { expect, test } from "vitest";
import { buildOpeningAllocationPayload, groupOpeningAllocations, openingAllocationTotalsMatch, retainOpeningAllocations } from "./openingAllocationForm";
import type { OpeningAllocationDraft, OpeningAllocationGroup } from "./openingAllocationForm";

const groups: OpeningAllocationGroup[] = [
  { accountId: "ar" as Id<"chartOfAccounts">, kind: "CUSTOMER_RECEIVABLE", journalMinor: 75_000, label: "AR" },
  { accountId: "capital" as Id<"chartOfAccounts">, kind: "PARTNER_CAPITAL", journalMinor: 75_000, label: "Capital" },
];
const rows: OpeningAllocationDraft[] = [
  { rowKey: "ar-1", kind: "CUSTOMER_RECEIVABLE", accountId: "ar" as Id<"chartOfAccounts">, partyId: "customer-1" as Id<"customers">,
    partyLabel: "Synthetic customer", amount: "25.000", title: "Historical invoice", dueDate: "2026-12-31", note: "" },
  { rowKey: "ar-2", kind: "CUSTOMER_RECEIVABLE", accountId: "ar" as Id<"chartOfAccounts">, partyId: "customer-2" as Id<"customers">,
    partyLabel: "Synthetic customer 2", amount: "50.000", title: "Historical invoice 2", dueDate: "2026-12-31", note: "" },
  { rowKey: "partner-1", kind: "PARTNER_CAPITAL", accountId: "capital" as Id<"chartOfAccounts">, partyId: "partner-1" as Id<"partnerEquity">,
    partyLabel: "Synthetic partner", amount: "75.000", title: "", dueDate: "", note: "" },
];

test("an unavailable account policy preserves the original lines while producing no allocation group", () => {
  const lines = [{ accountId: groups[0].accountId, debitMinor: 75000, creditMinor: 0, label: "AR" }];
  const before = structuredClone(lines);
  expect(groupOpeningAllocations(lines, [])).toEqual([]);
  expect(lines).toEqual(before);
});

test("opening allocation rows reconcile by account and preserve stable party identities", () => {
  expect(openingAllocationTotalsMatch(rows, groups, "JOD")).toBe(true);
  expect(buildOpeningAllocationPayload(rows, "JOD")).toEqual([
    { kind: "CUSTOMER_RECEIVABLE", rowKey: "ar-1", accountId: "ar", customerId: "customer-1",
      amountMinor: 25_000, title: "Historical invoice", dueDate: Date.UTC(2026, 11, 31) },
    { kind: "CUSTOMER_RECEIVABLE", rowKey: "ar-2", accountId: "ar", customerId: "customer-2",
      amountMinor: 50_000, title: "Historical invoice 2", dueDate: Date.UTC(2026, 11, 31) },
    { kind: "PARTNER_CAPITAL", rowKey: "partner-1", accountId: "capital", partnerId: "partner-1", amountMinor: 75_000 },
  ]);
});

test("switching away from an account drops only its dependent allocation rows", () => {
  expect(retainOpeningAllocations(rows, new Set(["capital"]))).toEqual([rows[2]]);
});

test("missing identity, excess precision and account mismatches block opening allocation submission", () => {
  expect(openingAllocationTotalsMatch(rows.slice(1), groups, "JOD")).toBe(false);
  expect(openingAllocationTotalsMatch([{ ...rows[0], amount: "25.0001" }, ...rows.slice(1)], groups, "JOD")).toBe(false);
  expect(buildOpeningAllocationPayload([{ ...rows[0], partyId: "" }], "JOD")).toBeNull();
  expect(buildOpeningAllocationPayload([{ ...rows[0], dueDate: "2026-02-31" }], "JOD")).toBeNull();
});

test("prepaid opening requires a named unexpired benefit and native schedule fields", () => {
  const prepaid: OpeningAllocationDraft = { rowKey: "prepaid-1", kind: "PREPAID_EXPENSE", accountId: "prepaid" as Id<"chartOfAccounts">,
    partyId: "", partyLabel: "", amount: "100.001", title: "Synthetic unexpired service",
    dueDate: "", note: "", startYearMonth: "2026-01", termMonths: "3",
    expenseSystemKey: "RENT_EXPENSE", attestedUnexpiredBenefit: true };
  const target: OpeningAllocationGroup[] = [{ accountId: "prepaid" as Id<"chartOfAccounts">, kind: "PREPAID_EXPENSE", journalMinor: 100_001,
    label: "Prepaid asset" }];
  expect(buildOpeningAllocationPayload([prepaid], "JOD")).toEqual([{ kind: "PREPAID_EXPENSE",
    rowKey: "prepaid-1", accountId: "prepaid", amountMinor: 100_001,
    title: "Synthetic unexpired service", startYearMonth: "2026-01", termMonths: 3,
    expenseSystemKey: "RENT_EXPENSE", attestedUnexpiredBenefit: true }]);
  expect(openingAllocationTotalsMatch([prepaid], target, "JOD")).toBe(true);
  for (const incomplete of [
    { ...prepaid, attestedUnexpiredBenefit: false }, { ...prepaid, title: "" },
    { ...prepaid, termMonths: "0" }, { ...prepaid, startYearMonth: "2026-13" },
    { ...prepaid, expenseSystemKey: "" },
  ]) expect(buildOpeningAllocationPayload([incomplete], "JOD")).toBeNull();
});

test("remaining opening families serialize only their supported identity and purpose", () => {
  const base = { accountId: "account", partyId: "", partyLabel: "", amount: "4.001",
    title: "Historical source", dueDate: "", note: "" };
  const cases = [
    { row: { ...base, rowKey: "claim", kind: "SUPPLIER_RECOVERABLE", counterpartyName: "Synthetic supplier",
      purpose: "CLAIM" }, expected: { kind: "SUPPLIER_RECOVERABLE", rowKey: "claim", accountId: "account",
      amountMinor: 4001, counterpartyName: "Synthetic supplier", title: "Historical source", purpose: "CLAIM" } },
    { row: { ...base, rowKey: "supplier", kind: "SUPPLIER_PAYABLE", counterpartyName: "Synthetic supplier" },
      expected: { kind: "SUPPLIER_PAYABLE", rowKey: "supplier", accountId: "account", amountMinor: 4001,
        counterpartyName: "Synthetic supplier", title: "Historical source" } },
    { row: { ...base, rowKey: "other", kind: "OTHER_PAYABLE", counterpartyName: "Synthetic creditor" },
      expected: { kind: "OTHER_PAYABLE", rowKey: "other", accountId: "account", amountMinor: 4001,
        counterpartyName: "Synthetic creditor", title: "Historical source" } },
    { row: { ...base, rowKey: "commission", kind: "EMPLOYEE_COMMISSION", partyId: "employee-1" },
      expected: { kind: "EMPLOYEE_COMMISSION", rowKey: "commission", accountId: "account", amountMinor: 4001,
        userId: "employee-1" } },
    { row: { ...base, rowKey: "deposit", kind: "UNALLOCATED_LIABILITY", purpose: "CUSTOMER_DEPOSIT" },
      expected: { kind: "UNALLOCATED_LIABILITY", rowKey: "deposit", accountId: "account", amountMinor: 4001,
        purpose: "CUSTOMER_DEPOSIT", title: "Historical source" } },
    { row: { ...base, rowKey: "receipt", kind: "UNALLOCATED_LIABILITY", purpose: "UNIDENTIFIED_RECEIPT" },
      expected: { kind: "UNALLOCATED_LIABILITY", rowKey: "receipt", accountId: "account", amountMinor: 4001,
        purpose: "UNIDENTIFIED_RECEIPT", title: "Historical source" } },
  ] as const;
  for (const { row, expected } of cases) {
    expect(buildOpeningAllocationPayload([row as OpeningAllocationDraft], "JOD")).toEqual([expected]);
  }
  for (const invalid of [
    { ...cases[0].row, counterpartyName: "" },
    { ...cases[1].row, title: "" },
    { ...cases[3].row, partyId: "" },
    { ...cases[4].row, purpose: "CLAIM" },
  ]) expect(buildOpeningAllocationPayload([invalid as OpeningAllocationDraft], "JOD")).toBeNull();
});

test("custom liability groups use the server allowlist and sum credit lines on one account", () => {
  const groups = groupOpeningAllocations([
    { accountId: "custom-liability", debitMinor: 0, creditMinor: 4_001, label: "2199 · Historical liabilities" },
    { accountId: "custom-liability", debitMinor: 0, creditMinor: 4_001, label: "2199 · Historical liabilities" },
    { accountId: "recoverable", debitMinor: 4_001, creditMinor: 0, label: "1360 · Supplier recoverable" },
  ], [
    { accountId: "custom-liability" as Id<"chartOfAccounts">, policy: "DECLARED_LIABILITY",
      allowedKinds: ["SUPPLIER_PAYABLE", "OTHER_PAYABLE", "EMPLOYEE_COMMISSION", "UNALLOCATED_LIABILITY"],
      allowedPurposes: ["UNIDENTIFIED_RECEIPT"] },
    { accountId: "recoverable" as Id<"chartOfAccounts">, policy: "SUPPLIER_RECOVERABLE", allowedKinds: ["SUPPLIER_RECOVERABLE"] },
  ]);
  expect(groups).toEqual([
    { accountId: "custom-liability", kind: "SUPPLIER_PAYABLE", journalMinor: 8_002,
      label: "2199 · Historical liabilities", allowedKinds: ["SUPPLIER_PAYABLE", "OTHER_PAYABLE",
        "EMPLOYEE_COMMISSION", "UNALLOCATED_LIABILITY"], allowedPurposes: ["UNIDENTIFIED_RECEIPT"] },
    { accountId: "recoverable", kind: "SUPPLIER_RECOVERABLE", journalMinor: 4_001,
      label: "1360 · Supplier recoverable", allowedKinds: ["SUPPLIER_RECOVERABLE"], allowedPurposes: undefined },
  ]);
  const row: OpeningAllocationDraft = { rowKey: "unknown", accountId: "custom-liability" as Id<"chartOfAccounts">,
    kind: "UNALLOCATED_LIABILITY", partyId: "", partyLabel: "", amount: "8.002", title: "Prior unidentified receipts",
    purpose: "UNIDENTIFIED_RECEIPT", dueDate: "", note: "" };
  expect(openingAllocationTotalsMatch([row], groups.slice(0, 1), "JOD")).toBe(true);
  expect(openingAllocationTotalsMatch([{ ...row, purpose: "CUSTOMER_DEPOSIT" }], groups.slice(0, 1), "JOD")).toBe(false);
});
// SCRUM-858 S1 (ruling SCRUM-858#c23884): named opening deposits.
test("named opening deposits serialize the customer, the deposit type and only a reservation's vehicle", () => {
  const deposit = { rowKey: "dep-1", kind: "CUSTOMER_DEPOSIT", accountId: "deposits" as Id<"chartOfAccounts">,
    partyId: "customer-1" as Id<"customers">, partyLabel: "Synthetic customer", amount: "500.000",
    title: "Reservation taken before launch", dueDate: "", note: "", depositKind: "RESERVATION", depositVehicleId: "" } as const;
  const target: OpeningAllocationGroup[] = [{ accountId: "deposits" as Id<"chartOfAccounts">, kind: "UNALLOCATED_LIABILITY",
    allowedKinds: ["UNALLOCATED_LIABILITY", "CUSTOMER_DEPOSIT"], allowedPurposes: ["CUSTOMER_DEPOSIT"],
    journalMinor: 800_000, label: "2100 · Customer deposits" }];
  // A reservation without a car is customer credit and sends no vehicleId.
  expect(buildOpeningAllocationPayload([deposit as OpeningAllocationDraft], "JOD")).toEqual([
    { kind: "CUSTOMER_DEPOSIT", rowKey: "dep-1", accountId: "deposits", amountMinor: 500_000, customerId: "customer-1",
      depositKind: "RESERVATION", title: "Reservation taken before launch" }]);
  const named = { ...deposit, depositVehicleId: "vehicle-1" as Id<"vehicles"> } as OpeningAllocationDraft;
  expect(buildOpeningAllocationPayload([named], "JOD")).toEqual([
    { kind: "CUSTOMER_DEPOSIT", rowKey: "dep-1", accountId: "deposits", amountMinor: 500_000, customerId: "customer-1",
      depositKind: "RESERVATION", vehicleId: "vehicle-1", title: "Reservation taken before launch" }]);
  const security = { ...deposit, rowKey: "dep-2", depositKind: "SECURITY", amount: "300.000", title: "Security held" } as OpeningAllocationDraft;
  expect(buildOpeningAllocationPayload([security], "JOD")).toEqual([
    { kind: "CUSTOMER_DEPOSIT", rowKey: "dep-2", accountId: "deposits", amountMinor: 300_000, customerId: "customer-1",
      depositKind: "SECURITY", title: "Security held" }]);
  // Both rows reconcile to the one control account, which takes the named family.
  expect(openingAllocationTotalsMatch([named, security], target, "JOD")).toBe(true);
  expect(openingAllocationTotalsMatch([named], target, "JOD")).toBe(false);
});

test("a named opening deposit is refused locally when it lacks a customer, a type or a title, or a security deposit names a car", () => {
  const deposit = { rowKey: "dep-1", kind: "CUSTOMER_DEPOSIT", accountId: "deposits" as Id<"chartOfAccounts">,
    partyId: "customer-1" as Id<"customers">, partyLabel: "", amount: "5.000", title: "Held",
    dueDate: "", note: "", depositKind: "RESERVATION", depositVehicleId: "" } as const;
  for (const invalid of [
    { ...deposit, partyId: "" },
    { ...deposit, depositKind: undefined },
    { ...deposit, title: "   " },
    { ...deposit, title: "x".repeat(201) },
    { ...deposit, depositKind: "SECURITY", depositVehicleId: "vehicle-1" },
  ]) expect(buildOpeningAllocationPayload([invalid as unknown as OpeningAllocationDraft], "JOD")).toBeNull();
});

test("the server's customer-deposit allowance makes the Customer Deposits control a credit-normal group of both families", () => {
  const groups = groupOpeningAllocations([
    { accountId: "deposits", debitMinor: 0, creditMinor: 800_000, label: "2100 · Customer deposits" },
  ], [{ accountId: "deposits" as Id<"chartOfAccounts">, policy: "UNALLOCATED_LIABILITY",
    allowedKinds: ["UNALLOCATED_LIABILITY", "CUSTOMER_DEPOSIT"], allowedPurposes: ["CUSTOMER_DEPOSIT"] }]);
  expect(groups).toEqual([{ accountId: "deposits", kind: "UNALLOCATED_LIABILITY", journalMinor: 800_000,
    label: "2100 · Customer deposits", allowedKinds: ["UNALLOCATED_LIABILITY", "CUSTOMER_DEPOSIT"],
    allowedPurposes: ["CUSTOMER_DEPOSIT"] }]);
  // A custom declared-liability account that the server lists CUSTOMER_DEPOSIT for is credit-normal too.
  const declared = groupOpeningAllocations([
    { accountId: "custom", debitMinor: 0, creditMinor: 1_000, label: "2199" },
  ], [{ accountId: "custom" as Id<"chartOfAccounts">, policy: "DECLARED_LIABILITY", allowedKinds: ["CUSTOMER_DEPOSIT"] }]);
  expect(declared[0]?.journalMinor).toBe(1_000);
});