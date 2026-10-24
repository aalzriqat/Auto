import { expect, test } from "vitest";
import { buildOpeningAllocationPayload, groupOpeningAllocations, openingAllocationTotalsMatch, retainOpeningAllocations } from "./openingAllocationForm";
import type { OpeningAllocationDraft, OpeningAllocationGroup } from "./openingAllocationForm";

const groups: OpeningAllocationGroup[] = [
  { accountId: "ar", kind: "CUSTOMER_RECEIVABLE", journalMinor: 75_000, label: "AR" },
  { accountId: "capital", kind: "PARTNER_CAPITAL", journalMinor: 75_000, label: "Capital" },
];
const rows: OpeningAllocationDraft[] = [
  { rowKey: "ar-1", kind: "CUSTOMER_RECEIVABLE", accountId: "ar", partyId: "customer-1",
    partyLabel: "Synthetic customer", amount: "25.000", title: "Historical invoice", dueDate: "2026-12-31", note: "" },
  { rowKey: "ar-2", kind: "CUSTOMER_RECEIVABLE", accountId: "ar", partyId: "customer-2",
    partyLabel: "Synthetic customer 2", amount: "50.000", title: "Historical invoice 2", dueDate: "2026-12-31", note: "" },
  { rowKey: "partner-1", kind: "PARTNER_CAPITAL", accountId: "capital", partyId: "partner-1",
    partyLabel: "Synthetic partner", amount: "75.000", title: "", dueDate: "", note: "" },
];

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
  const prepaid: OpeningAllocationDraft = { rowKey: "prepaid-1", kind: "PREPAID_EXPENSE", accountId: "prepaid",
    partyId: "", partyLabel: "", amount: "100.001", title: "Synthetic unexpired service",
    dueDate: "", note: "", startYearMonth: "2026-01", termMonths: "3",
    expenseSystemKey: "RENT_EXPENSE", attestedUnexpiredBenefit: true };
  const target: OpeningAllocationGroup[] = [{ accountId: "prepaid", kind: "PREPAID_EXPENSE", journalMinor: 100_001,
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
    { accountId: "custom-liability", policy: "DECLARED_LIABILITY",
      allowedKinds: ["SUPPLIER_PAYABLE", "OTHER_PAYABLE", "EMPLOYEE_COMMISSION", "UNALLOCATED_LIABILITY"],
      allowedPurposes: ["UNIDENTIFIED_RECEIPT"] },
    { accountId: "recoverable", policy: "SUPPLIER_RECOVERABLE", allowedKinds: ["SUPPLIER_RECOVERABLE"] },
  ]);
  expect(groups).toEqual([
    { accountId: "custom-liability", kind: "SUPPLIER_PAYABLE", journalMinor: 8_002,
      label: "2199 · Historical liabilities", allowedKinds: ["SUPPLIER_PAYABLE", "OTHER_PAYABLE",
        "EMPLOYEE_COMMISSION", "UNALLOCATED_LIABILITY"], allowedPurposes: ["UNIDENTIFIED_RECEIPT"] },
    { accountId: "recoverable", kind: "SUPPLIER_RECOVERABLE", journalMinor: 4_001,
      label: "1360 · Supplier recoverable", allowedKinds: ["SUPPLIER_RECOVERABLE"], allowedPurposes: undefined },
  ]);
  const row: OpeningAllocationDraft = { rowKey: "unknown", accountId: "custom-liability",
    kind: "UNALLOCATED_LIABILITY", partyId: "", partyLabel: "", amount: "8.002", title: "Prior unidentified receipts",
    purpose: "UNIDENTIFIED_RECEIPT", dueDate: "", note: "" };
  expect(openingAllocationTotalsMatch([row], groups.slice(0, 1), "JOD")).toBe(true);
  expect(openingAllocationTotalsMatch([{ ...row, purpose: "CUSTOMER_DEPOSIT" }], groups.slice(0, 1), "JOD")).toBe(false);
});
