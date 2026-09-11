"use client";

import { useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { dateInputToUtcMs, todayDateInput } from "@/lib/dateInput";

/**
 * رسوم ومصاريف تسليم السيارة — the costs of handing THIS car to THIS customer,
 * managed on the Deal (owner requirement, SCRUM-215 c19384).
 *
 * Everything here is the canonical `financeDealCosts` record, read through
 * `listDealCosts` and written through the three commands that already exist
 * for it — nothing is a vehicle expense, nothing is a second ledger:
 *
 *   ADD    → `recordDealFee`         (retained command identity; the form's
 *                                     own intent, minted when it opens)
 *   EDIT   → `recordActualFeeAmount` (the ACTUAL figure, its date and its
 *                                     receipt reference; the estimate on the
 *                                     line is preserved beside it)
 *   REMOVE → `voidDealFee`           (audited void with a reason; the record
 *                                     and its figures survive as VOID)
 *
 * What the section deliberately does NOT claim: a line's amount being
 * recorded is not the same as it being paid or reconciled — the server derives
 * one status per line and it is shown as such; totals keep estimated and
 * actual strictly apart, exactly as `summarizeFees` returns them; nothing is
 * summed here. Costs of buying, importing, preparing or repairing the car are
 * not offered — the add form is restricted to the handover fee types.
 *
 * Every write can be refused server-side (a voided line, a closed custody
 * record, a reconciled figure without the permission to withdraw it); the
 * refusal is shown in the form that attempted it.
 */

/** The fee types that are costs of the HANDOVER, and nothing else. */
export const HANDOVER_FEE_TYPES = [
  "OWNERSHIP_TRANSFER",
  "LICENSING",
  "STAMPS",
  "LIEN_REGISTRATION",
  "INSPECTION",
  "INSURANCE",
  "OTHER_CLOSING_EXPENSE",
] as const;
export type HandoverFeeType = (typeof HANDOVER_FEE_TYPES)[number];

/**
 * The accounting treatment the server REQUIRES to be stated (it refuses to
 * infer one). Offered pre-selected per type, and visible, so a different one
 * can be chosen deliberately.
 */
export const HANDOVER_TREATMENTS = [
  "OWNERSHIP_TRANSFER_EXPENSE",
  "SELLING_EXPENSE",
  "INSURANCE_EXPENSE",
  "CUSTOMER_RECEIVABLE",
] as const;
export type HandoverTreatment = (typeof HANDOVER_TREATMENTS)[number];

export const HANDOVER_PAYEES = ["GOVERNMENT", "INSURER", "OTHER"] as const;
export type HandoverPayee = (typeof HANDOVER_PAYEES)[number];

export function defaultTreatmentFor(feeType: HandoverFeeType): HandoverTreatment {
  switch (feeType) {
    case "OWNERSHIP_TRANSFER":
    case "LIEN_REGISTRATION":
      return "OWNERSHIP_TRANSFER_EXPENSE";
    case "INSURANCE":
      return "INSURANCE_EXPENSE";
    default:
      return "SELLING_EXPENSE";
  }
}

export const FEE_TYPE_LABEL: Record<string, string> = {
  FINANCE_COMPANY_FEE: "FeeTypeFinanceCompany",
  APPRAISAL_FEE: "FeeTypeAppraisal",
  INSURANCE: "FeeTypeInsurance",
  STAMPS: "FeeTypeStamps",
  LICENSING: "FeeTypeLicensing",
  OWNERSHIP_TRANSFER: "FeeTypeOwnershipTransfer",
  LIEN_REGISTRATION: "FeeTypeLienRegistration",
  LIEN_RELEASE: "FeeTypeLienRelease",
  INSPECTION: "FeeTypeInspection",
  ADMINISTRATIVE_FEE: "FeeTypeAdministrative",
  COMMISSION: "FeeTypeCommission",
  OTHER_CLOSING_EXPENSE: "FeeTypeOtherClosing",
};

const TREATMENT_LABEL: Record<HandoverTreatment, string> = {
  OWNERSHIP_TRANSFER_EXPENSE: "TreatmentOwnershipTransferExpense",
  SELLING_EXPENSE: "TreatmentSellingExpense",
  INSURANCE_EXPENSE: "TreatmentInsuranceExpense",
  CUSTOMER_RECEIVABLE: "TreatmentCustomerReceivable",
};

const PAYEE_LABEL: Record<HandoverPayee, string> = {
  GOVERNMENT: "PayeeGovernment",
  INSURER: "PayeeInsurer",
  OTHER: "PayeeOther",
};

const STATUS_LABEL: Record<string, string> = {
  UNQUANTIFIED: "CostStatusUnquantified",
  ESTIMATED_ONLY: "CostStatusEstimated",
  ACTUAL_RECORDED: "CostStatusActual",
  RECONCILED: "CostStatusReconciled",
  VOID: "CostStatusVoid",
};

/** One cost line as `listDealCosts` serves it, with the server-derived status. */
export type HandoverCostLine = {
  _id: string;
  feeType: string;
  description?: string;
  estimatedAmountMinor?: number;
  actualAmountMinor?: number;
  paidBy: string;
  paidTo: string;
  status: string;
  paidAt?: number;
  receiptReference?: string;
};

export type HandoverCostsSummary = {
  lineCount: number;
  estimatedTotalMinor: number;
  actualTotalMinor: number;
  linesAwaitingActual: number;
  linesAwaitingReconciliation: number;
};

export type HandoverCostsData = {
  lines: ReadonlyArray<HandoverCostLine>;
  summary: HandoverCostsSummary;
};

export type NewHandoverCost = {
  /**
   * Names THIS attempt's intent — minted once when the add form opened, so the
   * container's retained command identity survives a retry of the same form
   * and a later, genuinely new line is a new command.
   */
  intentId: string;
  feeType: HandoverFeeType;
  description: string | undefined;
  /** Exactly one of the two may be present; a line with neither is refused here. */
  estimatedAmountMinor: number | undefined;
  actualAmountMinor: number | undefined;
  paidTo: HandoverPayee;
  accountingTreatment: HandoverTreatment;
  paidAt: number | undefined;
  receiptReference: string | undefined;
};

export type ActualHandoverCost = {
  actualAmountMinor: number;
  paidAt: number | undefined;
  receiptReference: string | undefined;
};

function isHandoverType(feeType: string): feeType is HandoverFeeType {
  return (HANDOVER_FEE_TYPES as ReadonlyArray<string>).includes(feeType);
}

/** Majors typed by the operator → minor units at the deal's scale, or null when not a positive amount. */
function parseMajor(value: string, scale: number): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const major = Number(trimmed);
  if (!Number.isFinite(major) || major < 0) return null;
  return Math.round(major * Math.pow(10, scale));
}

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function HandoverCostsPanel({
  costs,
  currency,
  scale,
  money,
  canManage,
  dealClosed,
  t,
  onAdd,
  onRecordActual,
  onVoid,
}: Readonly<{
  /** `undefined` while loading or when this caller may not read the cost rows. */
  costs: HandoverCostsData | undefined;
  currency: string;
  scale: number;
  money: (minor: number) => string;
  /** `create:finance_application` — the permission all three commands check. */
  canManage: boolean;
  /** Informational only; the server decides what a closed deal still accepts. */
  dealClosed: boolean;
  t: (key: string) => string;
  onAdd: (values: NewHandoverCost) => Promise<void>;
  onRecordActual: (feeId: string, values: ActualHandoverCost) => Promise<void>;
  onVoid: (feeId: string, reason: string) => Promise<void>;
}>) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // `listDealCosts` serves live lines only; a voided line leaves the section
  // (its record survives server-side with reason, actor and time).
  const live = costs?.lines ?? [];

  return (
    <Card data-testid="deal-handover-costs">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("HandoverCostsHeading")}</CardTitle>
          <p className="text-xs text-muted-foreground">{t("HandoverCostsNote")}</p>
        </div>
        {canManage && costs && !adding && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditingId(null);
              setVoidingId(null);
              setAdding(true);
            }}
          >
            <Plus className="h-4 w-4 me-1.5" />
            {t("AddHandoverCost")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {costs === undefined ? (
          <p className="text-sm text-muted-foreground">{t("HandoverCostsUnavailable")}</p>
        ) : (
          <>
            {/* Compact totals first: estimated and actual are different facts
                and are never combined. */}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3" data-testid="deal-handover-costs-totals">
              <div>
                <dt className="text-xs text-muted-foreground">{t("CostsExpectedTotal")}</dt>
                <dd className="font-medium">
                  <bdi className="tabular-nums" dir="ltr">
                    {money(costs.summary.estimatedTotalMinor)}
                  </bdi>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("CostsActualTotal")}</dt>
                <dd className="font-medium">
                  <bdi className="tabular-nums" dir="ltr">
                    {money(costs.summary.actualTotalMinor)}
                  </bdi>
                </dd>
              </div>
              {costs.summary.linesAwaitingActual > 0 && (
                <div>
                  <dt className="text-xs text-muted-foreground">{t("CostsAwaitingActual")}</dt>
                  <dd className="font-medium text-amber-700 dark:text-amber-400">
                    <bdi>{costs.summary.linesAwaitingActual}</bdi>
                  </dd>
                </div>
              )}
            </dl>
            <Separator />

            {live.length === 0 && !adding && (
              <p className="text-sm text-muted-foreground">{t("NoHandoverCosts")}</p>
            )}

            <ul className="space-y-2">
              {live.map((line) => (
                <li
                  key={line._id}
                  className="rounded-md border p-3 text-sm"
                  data-testid={`deal-handover-cost-${line._id}`}
                >
                  {editingId === line._id ? (
                    <ActualForm
                      line={line}
                      currency={currency}
                      scale={scale}
                      t={t}
                      onCancel={() => setEditingId(null)}
                      onSubmit={async (values) => {
                        await onRecordActual(line._id, values);
                        setEditingId(null);
                      }}
                    />
                  ) : voidingId === line._id ? (
                    <VoidForm
                      t={t}
                      onCancel={() => setVoidingId(null)}
                      onSubmit={async (reason) => {
                        await onVoid(line._id, reason);
                        setVoidingId(null);
                      }}
                    />
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium">
                          {t(FEE_TYPE_LABEL[line.feeType] ?? line.feeType)}
                          {line.description && (
                            <span className="text-muted-foreground">
                              {" · "}
                              <bdi>{line.description}</bdi>
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          <Badge variant="outline" className="me-1.5">
                            {t(STATUS_LABEL[line.status] ?? line.status)}
                          </Badge>
                          {line.receiptReference && (
                            <>
                              {t("ReceiptReferenceLabel")}: <bdi dir="ltr">{line.receiptReference}</bdi>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex items-start gap-3">
                        <dl className="grid grid-cols-[auto_auto] gap-x-3 text-end text-xs">
                          <dt className="text-muted-foreground">{t("CostEstimated")}</dt>
                          <dd className="tabular-nums">
                            {line.estimatedAmountMinor === undefined ? (
                              <span className="text-muted-foreground">{t("FactUnavailable")}</span>
                            ) : (
                              <bdi dir="ltr">{money(line.estimatedAmountMinor)}</bdi>
                            )}
                          </dd>
                          <dt className="text-muted-foreground">{t("CostActual")}</dt>
                          <dd className="font-semibold tabular-nums">
                            {line.actualAmountMinor === undefined ? (
                              <span className="font-normal text-muted-foreground">{t("FactUnavailable")}</span>
                            ) : (
                              <bdi dir="ltr">{money(line.actualAmountMinor)}</bdi>
                            )}
                          </dd>
                        </dl>
                        {canManage && isHandoverType(line.feeType) && (
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={t("RecordActualCost")}
                              onClick={() => {
                                setAdding(false);
                                setVoidingId(null);
                                setEditingId(line._id);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              aria-label={t("RemoveHandoverCost")}
                              onClick={() => {
                                setAdding(false);
                                setEditingId(null);
                                setVoidingId(line._id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {adding && (
              <AddForm
                currency={currency}
                scale={scale}
                dealClosed={dealClosed}
                t={t}
                onCancel={() => setAdding(false)}
                onSubmit={async (values) => {
                  await onAdd(values);
                  setAdding(false);
                }}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AddForm({
  currency,
  scale,
  dealClosed,
  t,
  onCancel,
  onSubmit,
}: Readonly<{
  currency: string;
  scale: number;
  dealClosed: boolean;
  t: (key: string) => string;
  onCancel: () => void;
  onSubmit: (values: NewHandoverCost) => Promise<void>;
}>) {
  const [feeType, setFeeType] = useState<HandoverFeeType>("OWNERSHIP_TRANSFER");
  const [treatment, setTreatment] = useState<HandoverTreatment>(defaultTreatmentFor("OWNERSHIP_TRANSFER"));
  const [payee, setPayee] = useState<HandoverPayee>("GOVERNMENT");
  const [description, setDescription] = useState("");
  const [figure, setFigure] = useState<"ESTIMATED" | "ACTUAL">("ESTIMATED");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intentId] = useState(() => crypto.randomUUID());

  const amountMinor = parseMajor(amount, scale);
  const amountInvalid = amount.trim() !== "" && amountMinor === null;

  return (
    <form
      className="space-y-3 rounded-md border border-dashed p-3"
      data-testid="deal-handover-cost-add"
      onSubmit={async (event) => {
        event.preventDefault();
        if (amountMinor === null) {
          setError(t("CostAmountRequired"));
          return;
        }
        setSubmitting(true);
        setError(null);
        try {
          await onSubmit({
            intentId,
            feeType,
            description: description.trim() || undefined,
            estimatedAmountMinor: figure === "ESTIMATED" ? amountMinor : undefined,
            actualAmountMinor: figure === "ACTUAL" ? amountMinor : undefined,
            paidTo: payee,
            accountingTreatment: treatment,
            paidAt: figure === "ACTUAL" && paidOn ? dateInputToUtcMs(paidOn) : undefined,
            receiptReference: figure === "ACTUAL" ? reference.trim() || undefined : undefined,
          });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : t("UnexpectedError"));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <p className="text-sm font-medium">{t("AddHandoverCost")}</p>
      {dealClosed && <p className="text-xs text-muted-foreground">{t("HandoverCostAfterCloseNote")}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-type">{t("CostTypeLabel")}</Label>
          <select
            id="handover-cost-type"
            className={selectClass}
            value={feeType}
            onChange={(event) => {
              const next = event.target.value as HandoverFeeType;
              setFeeType(next);
              setTreatment(defaultTreatmentFor(next));
              setPayee(next === "INSURANCE" ? "INSURER" : next === "OTHER_CLOSING_EXPENSE" ? "OTHER" : "GOVERNMENT");
            }}
          >
            {HANDOVER_FEE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(FEE_TYPE_LABEL[type])}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-payee">{t("CostPayeeLabel")}</Label>
          <select
            id="handover-cost-payee"
            className={selectClass}
            value={payee}
            onChange={(event) => setPayee(event.target.value as HandoverPayee)}
          >
            {HANDOVER_PAYEES.map((option) => (
              <option key={option} value={option}>
                {t(PAYEE_LABEL[option])}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="handover-cost-description">{t("CostDescriptionLabel")}</Label>
          <Input
            id="handover-cost-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-figure">{t("CostFigureLabel")}</Label>
          <select
            id="handover-cost-figure"
            className={selectClass}
            value={figure}
            onChange={(event) => setFigure(event.target.value as "ESTIMATED" | "ACTUAL")}
          >
            <option value="ESTIMATED">{t("CostEstimated")}</option>
            <option value="ACTUAL">{t("CostActual")}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-amount">
            {t("CostAmountLabel")} (<bdi dir="ltr">{currency}</bdi>)
          </Label>
          <Input
            id="handover-cost-amount"
            inputMode="decimal"
            className="tabular-nums"
            value={amount}
            aria-invalid={amountInvalid}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        {figure === "ACTUAL" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="handover-cost-paid-on">{t("CostPaidOnLabel")}</Label>
              <Input
                id="handover-cost-paid-on"
                type="date"
                max={todayDateInput()}
                value={paidOn}
                onChange={(event) => setPaidOn(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="handover-cost-reference">{t("ReceiptReferenceLabel")}</Label>
              <Input
                id="handover-cost-reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            </div>
          </>
        )}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="handover-cost-treatment">{t("CostTreatmentLabel")}</Label>
          <select
            id="handover-cost-treatment"
            className={selectClass}
            value={treatment}
            onChange={(event) => setTreatment(event.target.value as HandoverTreatment)}
          >
            {HANDOVER_TREATMENTS.map((option) => (
              <option key={option} value={option}>
                {t(TREATMENT_LABEL[option])}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t("CostTreatmentNote")}</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || amountMinor === null}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t("SaveHandoverCost")}
        </Button>
      </div>
    </form>
  );
}

function ActualForm({
  line,
  currency,
  scale,
  t,
  onCancel,
  onSubmit,
}: Readonly<{
  line: HandoverCostLine;
  currency: string;
  scale: number;
  t: (key: string) => string;
  onCancel: () => void;
  onSubmit: (values: ActualHandoverCost) => Promise<void>;
}>) {
  const [amount, setAmount] = useState(
    line.actualAmountMinor === undefined ? "" : String(line.actualAmountMinor / Math.pow(10, scale))
  );
  const [paidOn, setPaidOn] = useState("");
  const [reference, setReference] = useState(line.receiptReference ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountMinor = parseMajor(amount, scale);

  return (
    <form
      className="space-y-3"
      data-testid={`deal-handover-cost-edit-${line._id}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (amountMinor === null) {
          setError(t("CostAmountRequired"));
          return;
        }
        setSubmitting(true);
        setError(null);
        try {
          await onSubmit({
            actualAmountMinor: amountMinor,
            paidAt: paidOn ? dateInputToUtcMs(paidOn) : undefined,
            receiptReference: reference.trim() || undefined,
          });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : t("UnexpectedError"));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <p className="font-medium">
        {t("RecordActualCost")} · {t(FEE_TYPE_LABEL[line.feeType] ?? line.feeType)}
      </p>
      {line.estimatedAmountMinor !== undefined && (
        <p className="text-xs text-muted-foreground">
          {t("CostEstimated")}:{" "}
          <bdi dir="ltr" className="tabular-nums">
            {line.estimatedAmountMinor / Math.pow(10, scale)} {currency}
          </bdi>{" "}
          — {t("CostEstimatePreservedNote")}
        </p>
      )}
      {line.status === "RECONCILED" && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t("CostReconciledEditNote")}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`actual-amount-${line._id}`}>
            {t("CostActual")} (<bdi dir="ltr">{currency}</bdi>)
          </Label>
          <Input
            id={`actual-amount-${line._id}`}
            inputMode="decimal"
            className="tabular-nums"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`actual-paid-on-${line._id}`}>{t("CostPaidOnLabel")}</Label>
          <Input
            id={`actual-paid-on-${line._id}`}
            type="date"
            max={todayDateInput()}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`actual-reference-${line._id}`}>{t("ReceiptReferenceLabel")}</Label>
          <Input
            id={`actual-reference-${line._id}`}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || amountMinor === null}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t("SaveActualCost")}
        </Button>
      </div>
    </form>
  );
}

function VoidForm({
  t,
  onCancel,
  onSubmit,
}: Readonly<{
  t: (key: string) => string;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}>) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setError(t("VoidReasonRequired"));
          return;
        }
        setSubmitting(true);
        setError(null);
        try {
          await onSubmit(reason.trim());
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : t("UnexpectedError"));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <p className="font-medium text-destructive">{t("RemoveHandoverCost")}</p>
      <p className="text-xs text-muted-foreground">{t("VoidCostNote")}</p>
      <div className="space-y-1.5">
        <Label htmlFor="void-reason">{t("VoidReasonLabel")}</Label>
        <Input id="void-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button type="submit" size="sm" variant="destructive" disabled={submitting || !reason.trim()}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t("ConfirmRemoveCost")}
        </Button>
      </div>
    </form>
  );
}
