import { expect, test } from "vitest";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { fromMinorUnits, toMinorUnits } from "@/convex/utils/money";
import { buildOpeningAllocationPayload, restoreOpeningAllocation } from "./openingAllocationForm";

type Allocation = NonNullable<Doc<"openingBalanceDrafts">["allocations"]>[number];
const accountId = "account" as Id<"chartOfAccounts">;
function allocations(amountMinor: number): Allocation[] {
  const base = { accountId, amountMinor, rowKey: "row" };
  return [
    { ...base, kind: "CUSTOMER_RECEIVABLE", title: "Historical source", customerId: "customer" as Id<"customers">, dueDate: Date.UTC(2026, 0, 1) },
    { ...base, kind: "CUSTOMER_DEPOSIT", title: "Historical source", customerId: "customer" as Id<"customers">, depositKind: "SECURITY" },
    { ...base, kind: "EMPLOYEE_ADVANCE", userId: "employee" as Id<"users">, note: "Keep note" },
    { ...base, kind: "EMPLOYEE_COMMISSION", userId: "employee" as Id<"users"> },
    { ...base, kind: "VEHICLE_INVENTORY", vehicleId: "vehicle" as Id<"vehicles"> },
    { ...base, kind: "PARTNER_CAPITAL", partnerId: "partner" as Id<"partnerEquity"> },
    { ...base, kind: "PREPAID_EXPENSE", title: "Historical source", startYearMonth: "2026-01", termMonths: 12, expenseSystemKey: "RENT_EXPENSE", attestedUnexpiredBenefit: true },
    { ...base, kind: "SUPPLIER_RECOVERABLE", title: "Historical source", counterpartyName: "Supplier", purpose: "CLAIM" },
    { ...base, kind: "SUPPLIER_PAYABLE", title: "Historical source", counterpartyName: "Supplier" },
    { ...base, kind: "OTHER_PAYABLE", title: "Historical source", counterpartyName: "Creditor" },
    { ...base, kind: "UNALLOCATED_LIABILITY", title: "Historical source", purpose: "UNIDENTIFIED_RECEIPT" },
  ];
}

// These upper values satisfy the production admission predicate in
// validateOpeningRow: toMinorUnits(fromMinorUnits(minor)) === minor.
test.each([
  ["JPY", 9_007_199_254_740_991],
  ["USD", 9_007_199_254_740_991],
  ["JOD", 9_007_199_254_740_812],
] as const)("SCRUM-850 R1 all eleven allocation kinds rehydrate exactly at admitted %s boundaries", (currency, boundary) => {
  for (const minor of [1, 4_001, boundary]) {
    expect(toMinorUnits(fromMinorUnits(minor, currency), currency)).toBe(minor);
    const cases = allocations(minor);
    expect(cases).toHaveLength(11);
    for (const row of cases) {
      const restored = restoreOpeningAllocation(row, currency);
      const payload = buildOpeningAllocationPayload([restored], currency);
      // Preserve the complete stored family metadata as well as the amount.
      expect(payload?.[0], `${row.kind} ${currency} ${minor}`).toEqual(row);
    }
  }
});
