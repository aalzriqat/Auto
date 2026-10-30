import type { Doc, Id } from "@/convex/_generated/dataModel";
import { parseOpeningMoneyMinor } from "./openingMoneyInput";

export type OpeningAllocationKind = "CUSTOMER_RECEIVABLE" | "EMPLOYEE_ADVANCE" | "PARTNER_CAPITAL" | "PREPAID_EXPENSE" | "VEHICLE_INVENTORY" |
  "SUPPLIER_RECOVERABLE" | "SUPPLIER_PAYABLE" | "OTHER_PAYABLE" | "EMPLOYEE_COMMISSION" | "UNALLOCATED_LIABILITY" |
  "CUSTOMER_DEPOSIT";

const openingAllocationKinds = new Set<string>([
  "CUSTOMER_RECEIVABLE", "EMPLOYEE_ADVANCE", "PARTNER_CAPITAL", "PREPAID_EXPENSE", "VEHICLE_INVENTORY",
  "SUPPLIER_RECOVERABLE", "SUPPLIER_PAYABLE", "OTHER_PAYABLE", "EMPLOYEE_COMMISSION", "UNALLOCATED_LIABILITY",
  "CUSTOMER_DEPOSIT",
]);

/** SCRUM-858 S1: the two named opening deposit types. */
export type OpeningDepositKind = "SECURITY" | "RESERVATION";

export function isOpeningAllocationKind(kind: string): kind is OpeningAllocationKind {
  return openingAllocationKinds.has(kind);
}

export const OPENING_PREPAID_EXPENSE_OPTIONS = [
  ["RENT_EXPENSE", "OpeningPrepaidCategoryRent"],
  ["UTILITIES_EXPENSE", "OpeningPrepaidCategoryUtilities"],
  ["SALARIES_EXPENSE", "OpeningPrepaidCategorySalaries"],
  ["MARKETING_EXPENSE", "OpeningPrepaidCategoryMarketing"],
  ["OFFICE_EXPENSE", "OpeningPrepaidCategoryOffice"],
  ["PROFESSIONAL_FEES_EXPENSE", "OpeningPrepaidCategoryProfessional"],
  ["GENERAL_EXPENSE", "OpeningPrepaidCategoryGeneral"],
] as const;

type OpeningAllocationFields = {
  rowKey: string;
  accountId: Id<"chartOfAccounts">;
  /** Display snapshot only. The server resolves the actual owned party. */
  partyLabel: string;
  amount: string;
  title: string;
  dueDate: string;
  note: string;
  startYearMonth?: string;
  termMonths?: string;
  expenseSystemKey?: string;
  attestedUnexpiredBenefit?: boolean;
  counterpartyName?: string;
  purpose?: "CLAIM" | "REFUNDABLE_DEPOSIT" | "CUSTOMER_DEPOSIT" | "UNIDENTIFIED_RECEIPT";
  /** CUSTOMER_DEPOSIT only. A security deposit never names a vehicle; a reservation may. */
  depositKind?: OpeningDepositKind;
  depositVehicleId?: Id<"vehicles"> | "";
  /** Display snapshot only, like partyLabel. */
  depositVehicleLabel?: string;
};

export type OpeningAllocationDraft = OpeningAllocationFields & (
  | { kind: "CUSTOMER_RECEIVABLE" | "CUSTOMER_DEPOSIT"; partyId: Id<"customers"> | "" }
  | { kind: "EMPLOYEE_ADVANCE" | "EMPLOYEE_COMMISSION"; partyId: Id<"users"> | "" }
  | { kind: "VEHICLE_INVENTORY"; partyId: Id<"vehicles"> | "" }
  | { kind: "PARTNER_CAPITAL"; partyId: Id<"partnerEquity"> | "" }
  | { kind: "PREPAID_EXPENSE" | "SUPPLIER_RECOVERABLE" | "SUPPLIER_PAYABLE" | "OTHER_PAYABLE" | "UNALLOCATED_LIABILITY"; partyId: "" }
);

export type OpeningAllocationGroup = {
  accountId: Id<"chartOfAccounts">;
  kind: OpeningAllocationKind;
  allowedKinds?: OpeningAllocationKind[];
  allowedPurposes?: Array<"CUSTOMER_DEPOSIT" | "UNIDENTIFIED_RECEIPT">;
  journalMinor: number;
  label: string;
};

/** Group the server's account choices by their actual journal account. */
export function groupOpeningAllocations(
  lines: Array<{ accountId: string; debitMinor: number | null; creditMinor: number | null; label: string }>,
  choices: Array<{ accountId: Id<"chartOfAccounts">; policy: string; allowedKinds?: string[]; allowedPurposes?: string[] }>,
): OpeningAllocationGroup[] {
  const byAccount = new Map<string, typeof choices[number]>(choices.map((choice) => [choice.accountId, choice]));
  const groups = new Map<string, OpeningAllocationGroup>();
  for (const line of lines) {
    const choice = byAccount.get(line.accountId);
    if (!choice) continue;
    const allowedKinds = choice.allowedKinds?.filter(isOpeningAllocationKind) ?? [];
    if (allowedKinds.length === 0 && choice.policy === "PARTNER_CAPITAL_CANDIDATE") allowedKinds.push("PARTNER_CAPITAL");
    if (allowedKinds.length === 0 && isOpeningAllocationKind(choice.policy)) allowedKinds.push(choice.policy);
    if (allowedKinds.length === 0) continue;
    const kind = allowedKinds[0];
    const creditNormal = choice.policy === "DECLARED_LIABILITY" || kind === "PARTNER_CAPITAL" ||
      kind === "SUPPLIER_PAYABLE" || kind === "OTHER_PAYABLE" || kind === "EMPLOYEE_COMMISSION" ||
      kind === "UNALLOCATED_LIABILITY" || kind === "CUSTOMER_DEPOSIT";
    const prior = groups.get(line.accountId);
    groups.set(line.accountId, {
      accountId: choice.accountId, kind, allowedKinds,
      allowedPurposes: choice.allowedPurposes?.filter((purpose): purpose is "CUSTOMER_DEPOSIT" | "UNIDENTIFIED_RECEIPT" =>
        purpose === "CUSTOMER_DEPOSIT" || purpose === "UNIDENTIFIED_RECEIPT"),
      journalMinor: (prior?.journalMinor ?? 0) + (creditNormal ? line.creditMinor ?? 0 : line.debitMinor ?? 0),
      label: line.label,
    });
  }
  return Array.from(groups.values());
}

type AllocationPayload = NonNullable<Doc<"openingBalanceDrafts">["allocations"]>;
type AllocationPayloadRow = AllocationPayload[number];
type AllocationBase = Pick<AllocationPayloadRow, "rowKey" | "accountId" | "amountMinor">;

function dateInputToUtcMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const date = new Date(utc);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day ? utc : null;
}

export function retainOpeningAllocations(rows: OpeningAllocationDraft[], accountIds: Set<string>): OpeningAllocationDraft[] {
  return rows.filter((row) => accountIds.has(row.accountId));
}

function customerReceivablePayload(row: OpeningAllocationDraft, base: AllocationBase): AllocationPayloadRow | null {
  if (row.kind !== "CUSTOMER_RECEIVABLE" || !row.partyId) return null;
  const title = row.title.trim();
  const dueDate = dateInputToUtcMs(row.dueDate);
  if (!title || title.length > 200 || dueDate === null) return null;
  return { ...base, kind: "CUSTOMER_RECEIVABLE", customerId: row.partyId, title, dueDate };
}

function customerDepositPayload(row: OpeningAllocationDraft, base: AllocationBase): AllocationPayloadRow | null {
  if (row.kind !== "CUSTOMER_DEPOSIT" || !row.partyId) return null;
  const title = row.title.trim();
  if (!title || title.length > 200) return null;
  if (row.depositKind === "SECURITY") {
    // A security deposit is a guarantee, not a reservation of a car: it cannot name a VIN.
    if (row.depositVehicleId) return null;
    return { ...base, kind: "CUSTOMER_DEPOSIT", customerId: row.partyId, depositKind: "SECURITY", title };
  }
  if (row.depositKind === "RESERVATION") {
    return { ...base, kind: "CUSTOMER_DEPOSIT", customerId: row.partyId, depositKind: "RESERVATION", title,
      ...(row.depositVehicleId ? { vehicleId: row.depositVehicleId } : {}) };
  }
  return null;
}

function prepaidExpensePayload(row: OpeningAllocationDraft, base: AllocationBase): AllocationPayloadRow | null {
  const title = row.title.trim();
  const startYearMonth = row.startYearMonth ?? "";
  const termMonths = Number(row.termMonths);
  const expenseSystemKey = row.expenseSystemKey ?? "";
  if (!title || title.length > 200 || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(startYearMonth) ||
      !/^[1-9]\d*$/.test(row.termMonths ?? "") || !Number.isSafeInteger(termMonths) ||
      !OPENING_PREPAID_EXPENSE_OPTIONS.some(([key]) => key === expenseSystemKey) ||
      row.attestedUnexpiredBenefit !== true) return null;
  return { ...base, kind: "PREPAID_EXPENSE", title,
    startYearMonth, termMonths, expenseSystemKey, attestedUnexpiredBenefit: true };
}

function counterpartyPayload(row: OpeningAllocationDraft, base: AllocationBase): AllocationPayloadRow | null {
  const counterpartyName = row.counterpartyName?.trim() ?? "";
  const title = row.title.trim();
  if (!counterpartyName || counterpartyName.length > 200 || !title || title.length > 200) return null;
  if (row.kind === "SUPPLIER_RECOVERABLE") {
    if (row.purpose !== "CLAIM" && row.purpose !== "REFUNDABLE_DEPOSIT") return null;
    return { ...base, kind: row.kind, counterpartyName, title, purpose: row.purpose };
  }
  if (row.kind === "SUPPLIER_PAYABLE" || row.kind === "OTHER_PAYABLE") {
    return { ...base, kind: row.kind, counterpartyName, title };
  }
  return null;
}

function unallocatedLiabilityPayload(row: OpeningAllocationDraft, base: AllocationBase): AllocationPayloadRow | null {
  const title = row.title.trim();
  if (!title || title.length > 200 ||
      (row.purpose !== "CUSTOMER_DEPOSIT" && row.purpose !== "UNIDENTIFIED_RECEIPT")) return null;
  return { ...base, kind: "UNALLOCATED_LIABILITY", purpose: row.purpose, title };
}

function openingAllocationRowPayload(row: OpeningAllocationDraft, base: AllocationBase): AllocationPayloadRow | null {
  switch (row.kind) {
    case "CUSTOMER_RECEIVABLE": return customerReceivablePayload(row, base);
    case "CUSTOMER_DEPOSIT": return customerDepositPayload(row, base);
    case "EMPLOYEE_ADVANCE":
      if (!row.partyId) return null;
      if (row.note.length > 500) return null;
      return { ...base, kind: row.kind, userId: row.partyId, note: row.note.trim() || undefined };
    case "VEHICLE_INVENTORY":
      if (!row.partyId) return null;
      return { ...base, kind: row.kind, vehicleId: row.partyId };
    case "PREPAID_EXPENSE": return prepaidExpensePayload(row, base);
    case "SUPPLIER_RECOVERABLE":
    case "SUPPLIER_PAYABLE":
    case "OTHER_PAYABLE": return counterpartyPayload(row, base);
    case "EMPLOYEE_COMMISSION":
      if (!row.partyId) return null;
      return { ...base, kind: row.kind, userId: row.partyId };
    case "UNALLOCATED_LIABILITY": return unallocatedLiabilityPayload(row, base);
    case "PARTNER_CAPITAL":
      if (!row.partyId) return null;
      return { ...base, kind: row.kind, partnerId: row.partyId };
    default: return null;
  }
}

/** UI payload assembly; backend validators still own tenant and money rules. */
export function buildOpeningAllocationPayload(rows: OpeningAllocationDraft[], currency: string): AllocationPayload | null {
  if (rows.length > 100) return null;
  const keys = new Set<string>();
  const partnerPairs = new Set<string>();
  const payload: AllocationPayload = [];
  for (const row of rows) {
    const amountMinor = parseOpeningMoneyMinor(row.amount, currency);
    const requiresParty = ["CUSTOMER_RECEIVABLE", "CUSTOMER_DEPOSIT", "EMPLOYEE_ADVANCE", "PARTNER_CAPITAL", "VEHICLE_INVENTORY", "EMPLOYEE_COMMISSION"].includes(row.kind);
    if (amountMinor === null || amountMinor <= 0 || requiresParty && !row.partyId ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.rowKey) || keys.has(row.rowKey)) return null;
    keys.add(row.rowKey);
    if (row.kind === "PARTNER_CAPITAL") {
      const pair = `${row.accountId}:${row.partyId}`;
      if (partnerPairs.has(pair)) return null;
      partnerPairs.add(pair);
    }
    const allocation = openingAllocationRowPayload(row, {
      rowKey: row.rowKey, accountId: row.accountId, amountMinor,
    });
    if (!allocation) return null;
    payload.push(allocation);
  }
  return payload;
}

/** Reconcile each operational control account, not each visual journal line. */
export function openingAllocationTotalsMatch(
  rows: OpeningAllocationDraft[], groups: OpeningAllocationGroup[], currency: string,
): boolean {
  const payload = buildOpeningAllocationPayload(rows, currency);
  if (!payload) return false;
  const target = new Map(groups.map((group) => [group.accountId, group]));
  const totals = new Map<string, number>();
  for (const row of payload) {
    const group = target.get(row.accountId);
    if (!group || !(group.allowedKinds ?? [group.kind]).includes(row.kind)) return false;
    if (row.kind === "UNALLOCATED_LIABILITY" && group.allowedPurposes &&
        !group.allowedPurposes.includes(row.purpose as "CUSTOMER_DEPOSIT" | "UNIDENTIFIED_RECEIPT")) return false;
    totals.set(row.accountId, (totals.get(row.accountId) ?? 0) + row.amountMinor);
  }
  return groups.every((group) => group.journalMinor > 0 && Number.isSafeInteger(group.journalMinor) &&
    totals.get(group.accountId) === group.journalMinor);
}
