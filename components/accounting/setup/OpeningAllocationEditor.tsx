"use client";

import { useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { Plus, Trash2 } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { fromMinorUnits, scaleForCurrency } from "@/convex/utils/money";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseOpeningMoneyMinor } from "./openingMoneyInput";
import { OPENING_PREPAID_EXPENSE_OPTIONS } from "./openingAllocationForm";
import type { OpeningAllocationDraft, OpeningAllocationGroup } from "./openingAllocationForm";

let allocationSeq = 0;
function emptyParty(fields: Omit<OpeningAllocationDraft, "kind" | "partyId">,
  kind: OpeningAllocationDraft["kind"]): OpeningAllocationDraft {
  switch (kind) {
    case "CUSTOMER_RECEIVABLE": return { ...fields, kind, partyId: "" };
    case "EMPLOYEE_ADVANCE": case "EMPLOYEE_COMMISSION": return { ...fields, kind, partyId: "" };
    case "VEHICLE_INVENTORY": return { ...fields, kind, partyId: "" };
    case "PARTNER_CAPITAL": return { ...fields, kind, partyId: "" };
    default: return { ...fields, kind, partyId: "" };
  }
}
function newRow(group: OpeningAllocationGroup): OpeningAllocationDraft {
  allocationSeq += 1;
  return emptyParty({ rowKey: `oballoc-${allocationSeq}`, accountId: group.accountId,
    partyLabel: "", amount: "", title: "", dueDate: "", note: "",
    startYearMonth: "", termMonths: "", expenseSystemKey: "", attestedUnexpiredBenefit: false,
    counterpartyName: "", purpose: undefined }, group.kind);
}

function maskPhone(phone: string | undefined): string {
  return phone ? `•••${phone.slice(-4)}` : "";
}

function partyFieldLabel(kind: OpeningAllocationDraft["kind"]): string {
  if (kind === "CUSTOMER_RECEIVABLE") return "OpeningAllocationCustomer";
  if (kind === "EMPLOYEE_ADVANCE" || kind === "EMPLOYEE_COMMISSION") return "OpeningAllocationEmployee";
  if (kind === "VEHICLE_INVENTORY") return "OpeningAllocationVehicle";
  return "OpeningAllocationPartner";
}

type Props = {
  orgId: Id<"organizations">;
  currency: string;
  groups: OpeningAllocationGroup[];
  rows: OpeningAllocationDraft[];
  onChange: (rows: OpeningAllocationDraft[]) => void;
  canSelectCustomers: boolean;
  canSelectEmployees: boolean;
  canSelectPartners: boolean;
};

/** Party families use existing party read grants; backend posting still
 * re-resolves each selected ID and owns every financial rule. */
export function OpeningAllocationEditor({ orgId, currency, groups, rows, onChange,
  canSelectCustomers, canSelectEmployees, canSelectPartners }: Readonly<Props>) {
  const { t } = useLanguage();
  const [activeCustomerRow, setActiveCustomerRow] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const needsCustomers = groups.some((group) => (group.allowedKinds ?? [group.kind]).includes("CUSTOMER_RECEIVABLE"));
  const needsEmployees = groups.some((group) => (group.allowedKinds ?? [group.kind]).some((kind) =>
    kind === "EMPLOYEE_ADVANCE" || kind === "EMPLOYEE_COMMISSION"));
  const needsPartners = groups.some((group) => (group.allowedKinds ?? [group.kind]).includes("PARTNER_CAPITAL"));
  const needsVehicles = groups.some((group) => (group.allowedKinds ?? [group.kind]).includes("VEHICLE_INVENTORY"));
  const vehicles = useQuery(api.accountingCutover.listOpeningStockChoices,
    needsVehicles ? { orgId } : "skip");
  const customerOptions = useQuery(api.customers.selectorOptions,
    needsCustomers && canSelectCustomers && activeCustomerRow !== null
      ? { orgId, search: customerSearch } : "skip");
  const { results: members, status: memberStatus, loadMore: loadMoreMembers } = usePaginatedQuery(
    api.memberships.list,
    needsEmployees && canSelectEmployees ? { orgId } : "skip",
    { initialNumItems: 50 },
  );
  const { results: partners, status: partnerStatus, loadMore: loadMorePartners } = usePaginatedQuery(
    api.partnerEquity.list,
    needsPartners && canSelectPartners ? { orgId } : "skip",
    { initialNumItems: 50 },
  );
  const employeesExhausted = memberStatus === "Exhausted" && members.length === 0;
  const noEligiblePartyByKind: Partial<Record<OpeningAllocationDraft["kind"], boolean>> = {
    CUSTOMER_RECEIVABLE: activeCustomerRow !== null && customerOptions !== undefined && customerOptions.length === 0,
    EMPLOYEE_ADVANCE: employeesExhausted,
    EMPLOYEE_COMMISSION: employeesExhausted,
    VEHICLE_INVENTORY: vehicles !== undefined && vehicles.every((vehicle) => !vehicle.available),
    PARTNER_CAPITAL: partnerStatus === "Exhausted" && partners.length === 0,
  };

  function selectedPartyLabel(partyId: string): string {
    const customer = customerOptions?.find((item) => item._id === partyId);
    if (customer) return `${customer.firstName} ${customer.lastName} ${maskPhone(customer.phone)}`.trim();
    const member = members?.find((item) => item.userId === partyId);
    if (member) return `${member.userName} · ${member.userEmail}`;
    const partner = partners?.find((item) => item._id === partyId);
    if (partner) return `${partner.partnerName} · ${String(partner._id).slice(-6)}`;
    const vehicle = vehicles?.find((item) => item.vehicleId === partyId);
    return vehicle ? `${vehicle.vin ?? ""} · ${vehicle.label ?? ""}` : "";
  }

  function updateRow(rowKey: string, patch: Partial<Omit<OpeningAllocationDraft, "kind" | "partyId">>) {
    onChange(rows.map((row) => row.rowKey === rowKey ? { ...row, ...patch } : row));
  }

  function replaceRow(next: OpeningAllocationDraft) {
    setSelectionError(null);
    onChange(rows.map(row => row.rowKey === next.rowKey ? next : row));
  }

  function selectParty(row: OpeningAllocationDraft, value: string) {
    if (value === row.partyId) { setSelectionError(null); return; }
    if (!value) { replaceRow({ ...row, partyId: "", partyLabel: "" }); return; }
    const partyLabel = selectedPartyLabel(value);
    switch (row.kind) {
      case "CUSTOMER_RECEIVABLE": {
        const choice = customerOptions?.find(item => item._id === value);
        if (choice) { replaceRow({ ...row, partyId: choice._id, partyLabel }); return; }
        break;
      }
      case "EMPLOYEE_ADVANCE": case "EMPLOYEE_COMMISSION": {
        const choice = members.find(item => item.userId === value);
        if (choice) { replaceRow({ ...row, partyId: choice.userId, partyLabel }); return; }
        break;
      }
      case "PARTNER_CAPITAL": {
        const choice = partners.find(item => item._id === value);
        if (choice) { replaceRow({ ...row, partyId: choice._id, partyLabel }); return; }
        break;
      }
      case "VEHICLE_INVENTORY": {
        const choice = vehicles?.find(item => item.vehicleId === value && item.available);
        if (choice) { replaceRow({ ...row, partyId: choice.vehicleId, partyLabel,
          ...(choice.amountMinor != null ? { amount: fromMinorUnits(choice.amountMinor, currency).toFixed(scaleForCurrency(currency)) } : {}) }); return; }
        break;
      }
    }
    setSelectionError(t("OpeningAllocationPartyUnavailable"));
  }

  function canEditKind(kind: OpeningAllocationDraft["kind"]): boolean {
    if (kind === "CUSTOMER_RECEIVABLE") return canSelectCustomers;
    if (kind === "EMPLOYEE_ADVANCE" || kind === "EMPLOYEE_COMMISSION") return canSelectEmployees;
    if (kind === "PARTNER_CAPITAL") return canSelectPartners;
    return true;
  }

  return (
    <section aria-label={t("OpeningAllocationSection")} className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold">{t("OpeningAllocationSection")}</h4>
        <p className="text-xs text-muted-foreground">{t("OpeningAllocationHelp")}</p>
      </div>
      {selectionError && <p role="alert" className="text-xs text-amber-700">{selectionError}</p>}
      {groups.map((group) => {
        const groupRows = rows.filter((row) => row.accountId === group.accountId);
        const allocated = groupRows.reduce((sum, row) => sum + (parseOpeningMoneyMinor(row.amount, currency) ?? 0), 0);
        const maySelect = (group.allowedKinds ?? [group.kind]).some(canEditKind);
        const noEligibleParty = maySelect && (noEligiblePartyByKind[group.kind] ?? false);
        return (
          <div key={group.accountId} className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <strong><bdi>{group.label}</bdi></strong>
              <span className={allocated === group.journalMinor && allocated > 0 ? "text-emerald-700" : "text-amber-700"}>
                {t("OpeningAllocationAllocated")}: {fromMinorUnits(allocated, currency).toFixed(scaleForCurrency(currency))}
                {" / "}{fromMinorUnits(group.journalMinor, currency).toFixed(scaleForCurrency(currency))} <bdi>{currency}</bdi>
              </span>
            </div>
            {!maySelect && <p className="text-xs text-amber-700" role="alert">{t("OpeningAllocationPermissionNeeded")}</p>}
            {noEligibleParty && <p className="text-xs text-amber-700" role="status">{t("OpeningAllocationNoEligibleParty")}</p>}
            {groupRows.map((row) => (
              <div key={row.rowKey} className="space-y-3 rounded-md bg-muted/40 p-3">
                {group.allowedKinds && group.allowedKinds.length > 1 && <div className="space-y-1">
                  <Label htmlFor={`${row.rowKey}-kind`}>{t("OpeningAllocationKind")}</Label>
                  <select id={`${row.rowKey}-kind`} value={row.kind}
                    onChange={(event) => {
                      const kind = group.allowedKinds?.find(kind => kind === event.target.value && canEditKind(kind));
                      if (!kind) { setSelectionError(t("OpeningAllocationPartyUnavailable")); return; }
                      replaceRow(emptyParty({ ...row, partyLabel: "", counterpartyName: "", title: "", purpose: undefined }, kind));
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                    {group.allowedKinds.map((kind) => <option key={kind} value={kind} disabled={!canEditKind(kind)}>
                      {t(`OpeningAllocationKind_${kind}`)}</option>)}
                  </select>
                </div>}
                {!canEditKind(row.kind) && maySelect && <p className="text-xs text-amber-700" role="alert">
                  {t("OpeningAllocationPermissionNeeded")}
                </p>}
                {row.kind === "EMPLOYEE_COMMISSION" && group.kind !== "EMPLOYEE_COMMISSION" &&
                  memberStatus === "Exhausted" && members.length === 0 &&
                  <p className="text-xs text-amber-700" role="status">{t("OpeningAllocationNoEligibleParty")}</p>}
                <div className="grid gap-3 sm:grid-cols-2">
                  {["CUSTOMER_RECEIVABLE", "EMPLOYEE_ADVANCE", "EMPLOYEE_COMMISSION", "PARTNER_CAPITAL", "VEHICLE_INVENTORY"].includes(row.kind) && <div className="space-y-1">
                    <Label htmlFor={`${row.rowKey}-party`}>{t(partyFieldLabel(row.kind))}</Label>
                    {row.kind === "CUSTOMER_RECEIVABLE" && (
                      <Input
                        aria-label={t("OpeningAllocationSearchCustomer")}
                        placeholder={t("OpeningAllocationSearchCustomer")}
                        value={activeCustomerRow === row.rowKey ? customerSearch : row.partyLabel}
                        onFocus={() => { setActiveCustomerRow(row.rowKey); setCustomerSearch(""); }}
                        onChange={(event) => {
                          setActiveCustomerRow(row.rowKey);
                          setCustomerSearch(event.target.value);
                          if (row.partyId) replaceRow({ ...row, partyId: "", partyLabel: "" });
                        }}
                        disabled={!canEditKind(row.kind)}
                      />
                    )}
                    <select
                      id={`${row.rowKey}-party`}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={row.partyId}
                      disabled={!canEditKind(row.kind)}
                      onChange={(event) => selectParty(row, event.target.value)}
                    >
                      <option value="">{t("OpeningAllocationSelectParty")}</option>
                      {row.partyId && !customerOptions?.some((item) => item._id === row.partyId) &&
                        !members?.some((item) => item.userId === row.partyId) &&
                        !partners?.some((item) => item._id === row.partyId) &&
                        !vehicles?.some((item) => item.vehicleId === row.partyId) && (
                          <option value={row.partyId}>{row.partyLabel || row.partyId}</option>
                      )}
                      {row.kind === "CUSTOMER_RECEIVABLE" && customerOptions?.map((customer) => (
                        <option key={customer._id} value={customer._id}>
                          {customer.firstName} {customer.lastName} · {maskPhone(customer.phone) || customer.email || String(customer._id).slice(-6)}
                        </option>
                      ))}
                      {(row.kind === "EMPLOYEE_ADVANCE" || row.kind === "EMPLOYEE_COMMISSION") && members?.map((member) => (
                        <option key={member.userId} value={member.userId}>{member.userName} · {member.userEmail}</option>
                      ))}
                      {row.kind === "PARTNER_CAPITAL" && partners?.map((partner) => (
                        <option key={partner._id} value={partner._id}>{partner.partnerName} · {String(partner._id).slice(-6)}</option>
                      ))}
                      {row.kind === "VEHICLE_INVENTORY" && vehicles?.filter((vehicle) => vehicle.available).map((vehicle) => (
                        <option key={vehicle.vehicleId} value={vehicle.vehicleId}>
                          {vehicle.vin} · {vehicle.label} · {fromMinorUnits(vehicle.amountMinor ?? 0, currency).toFixed(scaleForCurrency(currency))} {currency}
                        </option>
                      ))}
                    </select>
                    {row.partyId && <p className="text-xs text-muted-foreground"><bdi>{row.partyLabel}</bdi> · <bdi>{row.partyId}</bdi></p>}
                  </div>}
                  <div className="space-y-1">
                    <Label htmlFor={`${row.rowKey}-amount`}>{t("OpeningAllocationAmount")} · <bdi>{currency}</bdi></Label>
                    <Input id={`${row.rowKey}-amount`} type="text" inputMode="decimal" value={row.amount}
                      onChange={(event) => updateRow(row.rowKey, { amount: event.target.value })}
                      readOnly={row.kind === "VEHICLE_INVENTORY"} />
                  </div>
                  {(row.kind === "SUPPLIER_RECOVERABLE" || row.kind === "SUPPLIER_PAYABLE" || row.kind === "OTHER_PAYABLE") && <div className="space-y-1">
                    <Label htmlFor={`${row.rowKey}-counterparty`}>{t("OpeningAllocationCounterpartySnapshot")}</Label>
                    <Input id={`${row.rowKey}-counterparty`} value={row.counterpartyName ?? ""}
                      onChange={(event) => updateRow(row.rowKey, { counterpartyName: event.target.value })} />
                  </div>}
                  {(row.kind === "SUPPLIER_RECOVERABLE" || row.kind === "SUPPLIER_PAYABLE" ||
                    row.kind === "OTHER_PAYABLE" || row.kind === "UNALLOCATED_LIABILITY") && <div className="space-y-1">
                    <Label htmlFor={`${row.rowKey}-source-title`}>{t("OpeningAllocationSourceTitle")}</Label>
                    <Input id={`${row.rowKey}-source-title`} value={row.title}
                      onChange={(event) => updateRow(row.rowKey, { title: event.target.value })} />
                  </div>}
                  {(row.kind === "SUPPLIER_RECOVERABLE" || row.kind === "UNALLOCATED_LIABILITY") && <div className="space-y-1">
                    <Label htmlFor={`${row.rowKey}-purpose`}>{t("OpeningAllocationPurpose")}</Label>
                    <select id={`${row.rowKey}-purpose`} value={row.purpose ?? ""}
                      onChange={(event) => updateRow(row.rowKey, { purpose: event.target.value as OpeningAllocationDraft["purpose"] })}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                      <option value="">{t("OpeningAllocationChoosePurpose")}</option>
                      {(row.kind === "SUPPLIER_RECOVERABLE" ? ["CLAIM", "REFUNDABLE_DEPOSIT"] as const
                        : group.allowedPurposes ?? ["CUSTOMER_DEPOSIT", "UNIDENTIFIED_RECEIPT"] as const).map((purpose) => (
                        <option key={purpose} value={purpose}>{t(`OpeningAllocationPurpose_${purpose}`)}</option>
                      ))}
                    </select>
                  </div>}
                  {row.kind === "UNALLOCATED_LIABILITY" && <p className="text-xs text-amber-700 sm:col-span-2" role="note">
                    {t("OpeningAllocationUnallocatedNotice")}
                  </p>}
                  {row.kind === "CUSTOMER_RECEIVABLE" && <>
                    <div className="space-y-1"><Label htmlFor={`${row.rowKey}-title`}>{t("OpeningAllocationTitle")}</Label>
                      <Input id={`${row.rowKey}-title`} value={row.title}
                        onChange={(event) => updateRow(row.rowKey, { title: event.target.value })} /></div>
                    <div className="space-y-1"><Label htmlFor={`${row.rowKey}-due`}>{t("OpeningAllocationDueDate")}</Label>
                      <Input id={`${row.rowKey}-due`} type="date" value={row.dueDate}
                        onChange={(event) => updateRow(row.rowKey, { dueDate: event.target.value })} /></div>
                  </>}
                  {row.kind === "EMPLOYEE_ADVANCE" && <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor={`${row.rowKey}-note`}>{t("OpeningAllocationNote")}</Label>
                    <Input id={`${row.rowKey}-note`} value={row.note}
                      onChange={(event) => updateRow(row.rowKey, { note: event.target.value })} />
                  </div>}
                  {row.kind === "PREPAID_EXPENSE" && <>
                    <div className="space-y-1">
                      <Label htmlFor={`${row.rowKey}-prepaid-title`}>{t("OpeningPrepaidTitle")}</Label>
                      <Input id={`${row.rowKey}-prepaid-title`} value={row.title}
                        onChange={(event) => updateRow(row.rowKey, { title: event.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${row.rowKey}-prepaid-category`}>{t("OpeningPrepaidCategory")}</Label>
                      <select id={`${row.rowKey}-prepaid-category`} value={row.expenseSystemKey ?? ""}
                        onChange={(event) => updateRow(row.rowKey, { expenseSystemKey: event.target.value })}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="">{t("OpeningPrepaidChooseCategory")}</option>
                        {OPENING_PREPAID_EXPENSE_OPTIONS.map(([key, label]) =>
                          <option key={key} value={key}>{t(label)}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${row.rowKey}-prepaid-start`}>{t("OpeningPrepaidStartMonth")}</Label>
                      <Input id={`${row.rowKey}-prepaid-start`} type="month" value={row.startYearMonth ?? ""}
                        onChange={(event) => updateRow(row.rowKey, { startYearMonth: event.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${row.rowKey}-prepaid-term`}>{t("OpeningPrepaidTermMonths")}</Label>
                      <Input id={`${row.rowKey}-prepaid-term`} type="number" min="1" step="1"
                        value={row.termMonths ?? ""}
                        onChange={(event) => updateRow(row.rowKey, { termMonths: event.target.value })} />
                    </div>
                    <label className="flex items-start gap-2 text-sm sm:col-span-2">
                      <input type="checkbox" className="mt-1" checked={row.attestedUnexpiredBenefit === true}
                        onChange={(event) => updateRow(row.rowKey, { attestedUnexpiredBenefit: event.target.checked })} />
                      <span>{t("OpeningPrepaidAttestation")}</span>
                    </label>
                  </>}
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => onChange(rows.filter((item) => item.rowKey !== row.rowKey))}>
                  <Trash2 className="me-1 h-4 w-4" />{t("OpeningAllocationRemove")}
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" disabled={!maySelect || rows.length >= 100}
              onClick={() => onChange([...rows, newRow({ ...group,
                kind: (group.allowedKinds ?? [group.kind]).find(canEditKind) ?? group.kind })])}>
              <Plus className="me-1 h-4 w-4" />{t("OpeningAllocationAdd")}
            </Button>
          </div>
        );
      })}
      {needsEmployees && memberStatus === "CanLoadMore" && <Button type="button" variant="outline" size="sm"
        onClick={() => loadMoreMembers(50)}>{t("OpeningAllocationMoreEmployees")}</Button>}
      {needsPartners && partnerStatus === "CanLoadMore" && <Button type="button" variant="outline" size="sm"
        onClick={() => loadMorePartners(50)}>{t("OpeningAllocationMorePartners")}</Button>}
    </section>
  );
}
