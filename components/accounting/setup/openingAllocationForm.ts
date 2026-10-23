import type { Doc, Id } from "@/convex/_generated/dataModel";
import { parseOpeningMoneyMinor } from "./openingMoneyInput";

export type OpeningAllocationKind = "CUSTOMER_RECEIVABLE" | "EMPLOYEE_ADVANCE" | "PARTNER_CAPITAL" | "PREPAID_EXPENSE" | "VEHICLE_INVENTORY" |
  "SUPPLIER_RECOVERABLE" | "SUPPLIER_PAYABLE" | "OTHER_PAYABLE" | "EMPLOYEE_COMMISSION" | "UNALLOCATED_LIABILITY";

const openingAllocationKinds = new Set<string>([
  "CUSTOMER_RECEIVABLE", "EMPLOYEE_ADVANCE", "PARTNER_CAPITAL", "PREPAID_EXPENSE", "VEHICLE_INVENTORY",
  "SUPPLIER_RECOVERABLE", "SUPPLIER_PAYABLE", "OTHER_PAYABLE", "EMPLOYEE_COMMISSION", "UNALLOCATED_LIABILITY",
]);

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

export type OpeningAllocationDraft = {
  rowKey: string;
  kind: OpeningAllocationKind;
  accountId: string;
  partyId: string;
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
};

export type OpeningAllocationGroup = {
  accountId: string;
  kind: OpeningAllocationKind;
  allowedKinds?: OpeningAllocationKind[];
  allowedPurposes?: Array<"CUSTOMER_DEPOSIT" | "UNIDENTIFIED_RECEIPT">;
  journalMinor: number;
  label: string;
};

/** Group the server's account choices by their actual journal account. */
export function groupOpeningAllocations(
  lines: Array<{ accountId: string; debitMinor: number | null; creditMinor: number | null; label: string }>,
  choices: Array<{ accountId: string; policy: string; allowedKinds?: string[]; allowedPurposes?: string[] }>,
): OpeningAllocationGroup[] {
  const byAccount = new Map(choices.map((choice) => [choice.accountId, choice]));
  const groups = new Map<string, OpeningAllocationGroup>();
  for (const line of lines) {
    const choice = byAccount.get(line.accountId);
    const allowedKinds = choice?.allowedKinds?.filter(isOpeningAllocationKind) ?? [];
    if (allowedKinds.length === 0 && choice?.policy === "PARTNER_CAPITAL_CANDIDATE") allowedKinds.push("PARTNER_CAPITAL");
    if (allowedKinds.length === 0 && choice && isOpeningAllocationKind(choice.policy)) allowedKinds.push(choice.policy);
    if (allowedKinds.length === 0) continue;
    const kind = allowedKinds[0];
    const creditNormal = choice?.policy === "DECLARED_LIABILITY" || kind === "PARTNER_CAPITAL" ||
      kind === "SUPPLIER_PAYABLE" || kind === "OTHER_PAYABLE" || kind === "EMPLOYEE_COMMISSION" ||
      kind === "UNALLOCATED_LIABILITY";
    const prior = groups.get(line.accountId);
    groups.set(line.accountId, {
      accountId: line.accountId, kind, allowedKinds,
      allowedPurposes: choice?.allowedPurposes?.filter((purpose): purpose is "CUSTOMER_DEPOSIT" | "UNIDENTIFIED_RECEIPT" =>
        purpose === "CUSTOMER_DEPOSIT" || purpose === "UNIDENTIFIED_RECEIPT"),
      journalMinor: (prior?.journalMinor ?? 0) + (creditNormal ? line.creditMinor ?? 0 : line.debitMinor ?? 0),
      label: line.label,
    });
  }
  return Array.from(groups.values());
}

type AllocationPayload = NonNullable<Doc<"openingBalanceDrafts">["allocations"]>;

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

/** UI payload assembly; backend validators still own tenant and money rules. */
export function buildOpeningAllocationPayload(rows: OpeningAllocationDraft[], currency: string): AllocationPayload | null {
  if (rows.length > 100) return null;
  const keys = new Set<string>();
  const partnerPairs = new Set<string>();
  const payload: AllocationPayload = [];
  for (const row of rows) {
    const amountMinor = parseOpeningMoneyMinor(row.amount, currency);
    if (amountMinor === null || amountMinor <= 0 ||
        (["CUSTOMER_RECEIVABLE", "EMPLOYEE_ADVANCE", "PARTNER_CAPITAL", "VEHICLE_INVENTORY", "EMPLOYEE_COMMISSION"] as OpeningAllocationKind[]).includes(row.kind) && !row.partyId ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.rowKey) || keys.has(row.rowKey)) return null;
    keys.add(row.rowKey);
    const accountId = row.accountId as Id<"chartOfAccounts">;
    if (row.kind === "CUSTOMER_RECEIVABLE") {
      const title = row.title.trim();
      const dueDate = dateInputToUtcMs(row.dueDate);
      if (!title || title.length > 200 || dueDate === null) return null;
      payload.push({ kind: row.kind, rowKey: row.rowKey, accountId,
        customerId: row.partyId as Id<"customers">, amountMinor, title, dueDate });
    } else if (row.kind === "EMPLOYEE_ADVANCE") {
      if (row.note.length > 500) return null;
      payload.push({ kind: row.kind, rowKey: row.rowKey, accountId,
        userId: row.partyId as Id<"users">, amountMinor, note: row.note.trim() || undefined });
    } else if (row.kind === "VEHICLE_INVENTORY") {
      payload.push({ kind: row.kind, rowKey: row.rowKey, accountId,
        vehicleId: row.partyId as Id<"vehicles">, amountMinor });
    } else if (row.kind === "PREPAID_EXPENSE") {
      const title = row.title.trim();
      const startYearMonth = row.startYearMonth ?? "";
      const termMonths = Number(row.termMonths);
      const expenseSystemKey = row.expenseSystemKey ?? "";
      if (!title || title.length > 200 || !/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(startYearMonth) ||
          !/^[1-9][0-9]*$/.test(row.termMonths ?? "") || !Number.isSafeInteger(termMonths) ||
          !OPENING_PREPAID_EXPENSE_OPTIONS.some(([key]) => key === expenseSystemKey) ||
          row.attestedUnexpiredBenefit !== true) return null;
      payload.push({ kind: row.kind, rowKey: row.rowKey, accountId, amountMinor, title,
        startYearMonth, termMonths, expenseSystemKey, attestedUnexpiredBenefit: true });
    } else if (row.kind === "SUPPLIER_RECOVERABLE") {
      const counterpartyName = row.counterpartyName?.trim() ?? "";
      const title = row.title.trim();
      if (!counterpartyName || counterpartyName.length > 200 || !title || title.length > 200 ||
          (row.purpose !== "CLAIM" && row.purpose !== "REFUNDABLE_DEPOSIT")) return null;
      payload.push({ kind: row.kind, rowKey: row.rowKey, accountId, amountMinor,
        counterpartyName, title, purpose: row.purpose });
    } else if (row.kind === "SUPPLIER_PAYABLE" || row.kind === "OTHER_PAYABLE") {
      const counterpartyName = row.counterpartyName?.trim() ?? "";
      const title = row.title.trim();
      if (!counterpartyName || counterpartyName.length > 200 || !title || title.length > 200) return null;
      payload.push({ kind: row.kind, rowKey: row.rowKey, accountId, amountMinor, counterpartyName, title });
    } else if (row.kind === "EMPLOYEE_COMMISSION") {
      payload.push({ kind: row.kind, rowKey: row.rowKey, accountId, amountMinor,
        userId: row.partyId as Id<"users"> });
    } else if (row.kind === "UNALLOCATED_LIABILITY") {
      const title = row.title.trim();
      if (!title || title.length > 200 ||
          (row.purpose !== "CUSTOMER_DEPOSIT" && row.purpose !== "UNIDENTIFIED_RECEIPT")) return null;
      payload.push({ kind: row.kind, rowKey: row.rowKey, accountId, amountMinor, purpose: row.purpose, title });
    } else if (row.kind === "PARTNER_CAPITAL") {
      const pair = `${row.accountId}:${row.partyId}`;
      if (partnerPairs.has(pair)) return null;
      partnerPairs.add(pair);
      payload.push({ kind: row.kind, rowKey: row.rowKey, accountId,
        partnerId: row.partyId as Id<"partnerEquity">, amountMinor });
    } else {
      return null;
    }
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
