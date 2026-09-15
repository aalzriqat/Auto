"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { MAX_FEE_TEMPLATES } from "@/convex/utils/dealCostLimits";
import { denominationOf } from "@/convex/utils/money";
import { translateCustomerStatusLabel } from "@/lib/i18n/defaultLabels";
import { interpolate } from "@/lib/i18n/interpolate";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  FEE_ACCOUNTING_TREATMENTS,
  FEE_PARTIES,
  FINANCE_FEE_TYPES,
  defaultsForFeeType,
  feeFormRowsToTemplates,
  feeTemplateToFormRow,
  newFeeTemplateFormRow,
  type FeeAccountingTreatment,
  type FeeAmountProblem,
  type FeeParty,
  type FeeTemplateFormRow,
  type FinanceFeeTemplate,
  type FinanceFeeType,
} from "@/lib/financeFeeTemplateForm";

/**
 * Labels for every literal the validators admit. Typed as exhaustive records
 * over the validator-derived unions, so a literal added to the backend is a
 * compile error here rather than an option rendered as its raw enum name.
 * The fee-type and the shared party/treatment keys already exist for the deal
 * cockpit's handover-cost checklist; the rest live in the settings domain.
 */
const FEE_TYPE_LABEL: Record<FinanceFeeType, string> = {
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

const FEE_PARTY_LABEL: Record<FeeParty, string> = {
  DEALER: "PayeeDealer",
  CUSTOMER: "PayeeCustomer",
  FINANCE_COMPANY: "PayeeFinanceCompany",
  EMPLOYEE: "PayeeEmployee",
  APPRAISER: "PayeeAppraiser",
  INSURER: "PayeeInsurer",
  GOVERNMENT: "PayeeGovernment",
  OTHER: "PayeeOther",
};

const FEE_TREATMENT_LABEL: Record<FeeAccountingTreatment, string> = {
  SALE_CONSIDERATION_REDUCTION: "TreatmentSaleConsiderationReduction",
  APPRAISAL_EXPENSE: "TreatmentAppraisalExpense",
  INSURANCE_EXPENSE: "TreatmentInsuranceExpense",
  OWNERSHIP_TRANSFER_EXPENSE: "TreatmentOwnershipTransferExpense",
  FINANCE_COMPANY_COMMISSION: "TreatmentFinanceCompanyCommission",
  SELLING_EXPENSE: "TreatmentSellingExpense",
  CUSTOMER_RECEIVABLE: "TreatmentCustomerReceivable",
  EMPLOYEE_RECEIVABLE: "TreatmentEmployeeReceivable",
  EMPLOYEE_PAYABLE: "TreatmentEmployeePayable",
  REFUNDABLE_DEPOSIT: "TreatmentRefundableDeposit",
  DEALER_CONCESSION: "TreatmentDealerConcession",
  CAPITALIZED_TO_VEHICLE: "TreatmentCapitalizedToVehicle",
};

const FEE_AMOUNT_PROBLEM_LABEL: Record<FeeAmountProblem, string> = {
  EMPTY: "FeeTemplateAmountEmpty",
  NOT_A_NUMBER: "FeeTemplateAmountInvalid",
  TOO_PRECISE: "FeeTemplateAmountTooPrecise",
  TOO_LARGE: "FeeTemplateAmountTooLarge",
};

/** Native selects, styled like the deal cockpit's cost forms — keyboard- and RTL-safe without a portal. */
const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function FinanceCompanyDialog({
  open,
  onOpenChange,
  company,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company?: {
    _id: Id<"financeCompanies">;
    name: string;
    profitRate: number;
    maxTermMonths: number;
    gracePeriodMonths: number;
    insuranceRate?: number;
    adminFees?: number;
    commission?: number;
    includesCommissionInDebt?: boolean;
    maxFinancingLTV?: number;
    /** The DEALER-side purchase rate — see the field below. */
    defaultLtvPercent?: number;
    isActive: boolean;
    acceptedStatuses?: string[];
    /** The company's expected handover costs; each new deal freezes a copy. */
    feeTemplates?: FinanceFeeTemplate[];
    /** Optimistic-concurrency token for dealer rules, including fee templates. */
    ruleVersion?: number;
  };
}) {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  // The fee amounts are typed in major units and stored in minor units at the
  // ORG currency's scale. `undefined` settings means the currency has not
  // arrived — and a JOD fallback there would scale a USD company's fees by
  // 1,000 instead of 100 — so the fee section waits for it, like the status
  // list below waits for its query.
  const orgSettings = useOrgSettings();
  const feeCurrency = useMemo(() => {
    if (orgSettings === undefined) return { state: "loading" } as const;
    const code = orgSettings?.currency ?? "JOD";
    const denomination = denominationOf(code);
    if (!denomination) return { state: "unsupported", code } as const;
    return {
      state: "ready",
      code: denomination.code,
      scale: denomination.scale,
      label: locale === "ar" && code === "JOD" ? "دينار اردني" : code,
    } as const;
  }, [locale, orgSettings]);
  const currencyScale = feeCurrency.state === "ready" ? feeCurrency.scale : undefined;

  const createCompany = useMutation(api.finance.createCompany);
  const updateCompany = useMutation(api.finance.updateCompany);
  // Kept undefined-until-loaded on purpose: an empty list and a list that has
  // not arrived yet mean different things below, and conflating them would drop
  // a company's real accepted statuses on the first render.
  const loadedCustomerStatuses = useQuery(
    api.orgCustomerStatuses.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const customerStatusOptions = loadedCustomerStatuses ?? [];

  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: company?.name || "",
    profitRate: company?.profitRate || 0,
    maxTermMonths: company?.maxTermMonths || 72,
    gracePeriodMonths: company?.gracePeriodMonths || 0,
    insuranceRate: company?.insuranceRate || 0,
    adminFees: company?.adminFees || 0,
    commission: company?.commission || 0,
    includesCommissionInDebt: company?.includesCommissionInDebt || false,
    maxFinancingLTV: company?.maxFinancingLTV || 100,
    // Held as a STRING, and empty rather than zero when unset. Zero is not a
    // rate the engine accepts — `resolveAppliedLtv` refuses anything at or
    // below it — so defaulting this to 0 like the fields above would replace
    // "nobody has told us" with a value that is always invalid.
    defaultLtvPercent:
      company?.defaultLtvPercent !== undefined ? String(company.defaultLtvPercent) : "",
    isActive: company?.isActive ?? true,
    acceptedStatuses: company?.acceptedStatuses || [],
  });

  useEffect(() => {
    if (!open) return;
    setFormData({
      name: company?.name || "",
      profitRate: company?.profitRate || 0,
      maxTermMonths: company?.maxTermMonths || 72,
      gracePeriodMonths: company?.gracePeriodMonths || 0,
      insuranceRate: company?.insuranceRate || 0,
      adminFees: company?.adminFees || 0,
      commission: company?.commission || 0,
      includesCommissionInDebt: company?.includesCommissionInDebt || false,
      maxFinancingLTV: company?.maxFinancingLTV || 100,
      defaultLtvPercent:
        company?.defaultLtvPercent !== undefined ? String(company.defaultLtvPercent) : "",
      isActive: company?.isActive ?? true,
      acceptedStatuses: company?.acceptedStatuses || [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company?._id]);

  /**
   * The fee templates as rows. `feeRowsTouched` is the whole "no silent loss"
   * story: `updateCompany` treats an omitted `feeTemplates` as "leave it
   * alone", so an untouched list is NOT sent — the stored templates survive
   * verbatim, including on a company saved by an operator who never opened
   * this section. Only a list the operator actually edited is sent, in full.
   */
  const [feeRows, setFeeRows] = useState<FeeTemplateFormRow[]>([]);
  const [feeRowsTouched, setFeeRowsTouched] = useState(false);
  /** Amount problems stay quiet until a save is attempted; a half-typed row is not an error. */
  const [showFeeProblems, setShowFeeProblems] = useState(false);
  const [expandedFeeKeys, setExpandedFeeKeys] = useState<ReadonlySet<string>>(() => new Set());
  const feeRowKeyCounter = useRef(0);
  const nextFeeRowKey = () => `fee-${++feeRowKeyCounter.current}`;

  // Seeded once the currency is known — a row formatted at the wrong scale
  // would show "2.5" for 2,500 fils. Re-seeded when the currency resolves; the
  // section is disabled until then, so no edit can be lost to the re-seed.
  useEffect(() => {
    if (!open || currencyScale === undefined) return;
    // A reusable controlled dialog has to replace its draft when a different
    // company opens; this is prop-to-form synchronization, not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeeRows(
      (company?.feeTemplates ?? []).map((template) =>
        feeTemplateToFormRow(template, currencyScale, nextFeeRowKey())
      )
    );
    setFeeRowsTouched(false);
    setShowFeeProblems(false);
    setExpandedFeeKeys(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company?._id, currencyScale]);

  const feeConversion = useMemo(
    () => (currencyScale === undefined ? null : feeFormRowsToTemplates(feeRows, currencyScale)),
    [feeRows, currencyScale]
  );
  const feeProblemCount = feeConversion ? Object.keys(feeConversion.problems).length : 0;
  // Always surface legacy over-limit policy because new applications cannot
  // snapshot it. Submission is blocked only after the operator touches the
  // list; unrelated company details can still be repaired/saved unchanged.
  const feeRowsOverLimit = feeRows.length > MAX_FEE_TEMPLATES;

  const updateFeeRow = (key: string, patch: Partial<FeeTemplateFormRow>) => {
    setFeeRowsTouched(true);
    setFeeRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };
  const addFeeRow = () => {
    setFeeRowsTouched(true);
    setFeeRows((rows) => [...rows, newFeeTemplateFormRow(nextFeeRowKey())]);
  };
  const removeFeeRow = (key: string) => {
    setFeeRowsTouched(true);
    setFeeRows((rows) => rows.filter((row) => row.key !== key));
  };
  const toggleFeeRowExpanded = (key: string) => {
    setExpandedFeeKeys((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** Blanking a stored rate is not a way to delete it — see `onSubmit`. */
  const clearingExistingLtv =
    company?.defaultLtvPercent !== undefined && formData.defaultLtvPercent.trim() === "";

  const toggleAcceptedStatus = (id: string) => {
    setFormData((prev) => ({
      ...prev,
      acceptedStatuses: prev.acceptedStatuses.includes(id)
        ? prev.acceptedStatuses.filter((s) => s !== id)
        : [...prev.acceptedStatuses, id],
    }));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrgId) return;
    // Refuse to save against a status list that has not arrived. The checkbox
    // list renders empty while loading, so the form would otherwise submit a
    // selection the user was never shown — and for a new company that persists
    // an empty list, which downstream reads as "accepts every customer".
    if (loadedCustomerStatuses === undefined) return;

    // Emptying the field cannot remove a rate that is already stored:
    // `updateCompany` treats an omitted dealer rule as "leave it alone" — by
    // design, so that an older client saving a company's name cannot wipe its
    // terms. Submitting anyway closed the dialog on a success toast while the
    // previous LTV stayed in force, and every later deal kept being quoted
    // against a rule the operator believed they had removed.
    if (clearingExistingLtv) {
      toast.error(t("DefaultDealerLtvCannotClear" as any));
      return;
    }

    // The fee list is all-or-nothing. A row that fails to convert is not
    // dropped from the payload — that would save the company's policy with
    // one expected cost silently missing — the save is refused instead.
    if (feeCurrency.state !== "ready" || feeConversion === null) return;
    if (feeProblemCount > 0) {
      setShowFeeProblems(true);
      toast.error(t("FeeTemplatesFixBeforeSave"));
      return;
    }
    if (feeRowsTouched && feeRowsOverLimit) {
      toast.error(interpolate(t("FeeTemplatesOverLimit"), { max: MAX_FEE_TEMPLATES }));
      return;
    }

    setIsLoading(true);
    try {
      // Only send statuses that still exist. A company keeps the ids it was
      // saved with, and deleting a customer status used to leave those ids
      // behind — the checkbox list below only renders live statuses, so a
      // stale one was invisible here, could not be unticked, and was re-sent on
      // every save.
      const liveStatusIds = new Set(loadedCustomerStatuses.map((status) => status._id));
      const acceptedStatuses = formData.acceptedStatuses.filter((id) =>
        liveStatusIds.has(id as Id<"orgCustomerStatuses">)
      ) as Id<"orgCustomerStatuses">[];

      const { defaultLtvPercent: defaultLtvInput, ...rest } = formData;
      const parsedDefaultLtv = Number(defaultLtvInput);
      const payload = {
        ...rest,
        acceptedStatuses,
        // Omitted entirely when blank. Sending 0 would be a rate the dealer
        // rules reject; sending nothing keeps the field unset, which is what
        // "this company has not told us its purchase rate" means.
        defaultLtvPercent:
          defaultLtvInput.trim() !== "" && Number.isFinite(parsedDefaultLtv)
            ? parsedDefaultLtv
            : undefined,
        // Omitted unless edited — see `feeRowsTouched`. An edited list is sent
        // whole, an emptied one as `[]`, which the server applies as "no
        // expected costs" rather than reading as "leave it alone".
        feeTemplates: feeRowsTouched ? feeConversion.templates : undefined,
        // These are write preconditions, not persisted company fields. Convex
        // re-reads both authorities in the mutation transaction before any
        // amount can be committed under a stale denomination or policy.
        expectedCurrency: feeRowsTouched ? feeCurrency.code : undefined,
        expectedRuleVersion: feeRowsTouched && company ? company.ruleVersion ?? 1 : undefined,
      };
      if (company) {
        await updateCompany({
          id: company._id,
          orgId: activeOrgId,
          ...payload,
        });
        toast.success(t("CompanyUpdatedSuccess" as any));
      } else {
        await createCompany({
          orgId: activeOrgId,
          ...payload,
        });
        toast.success(t("CompanyCreatedSuccess" as any));
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wider than the legacy 425px so a fee row's type, amount and remove
          action sit on one line; scrolls inside the viewport now that the form
          has a variable-height list. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {company ? t("Edit Company" as any) : t("Add Company" as any)}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4 pt-4">
          <div className="grid gap-2">
            <Label>{t("Company Name" as any)}</Label>
            <Input
              required
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>{t("Profit Rate" as any)}</Label>
              <Input
                type="number"
                step="0.01"
                required
                value={formData.profitRate}
                onChange={(e) => setFormData({ ...formData, profitRate: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("Max Term (Months)" as any)}</Label>
              <Input
                type="number"
                required
                value={formData.maxTermMonths}
                onChange={(e) => setFormData({ ...formData, maxTermMonths: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>{t("Grace Period (Months)" as any)}</Label>
              <Input
                type="number"
                required
                value={formData.gracePeriodMonths}
                onChange={(e) => setFormData({ ...formData, gracePeriodMonths: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("Insurance Rate" as any)}</Label>
              <Input
                type="number"
                step="0.01"
                value={formData.insuranceRate}
                onChange={(e) => setFormData({ ...formData, insuranceRate: parseFloat(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>{t("ExecutionFees" as any)}</Label>
              <Input
                type="number"
                value={formData.adminFees}
                onChange={(e) => setFormData({ ...formData, adminFees: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("MaxFinancingLTV" as any)}</Label>
              <Input
                type="number"
                step="1"
                value={formData.maxFinancingLTV}
                onChange={(e) => setFormData({ ...formData, maxFinancingLTV: parseFloat(e.target.value) || 0 })}
              />
            </div>
          </div>
          {/* The DEALER-side purchase rate, and a different number from the
              customer LTV above — that one describes the loan the company sells
              the customer, this one the share of the vehicle it buys from the
              dealership at.

              It has a schema field and `finance.createCompany` has always
              accepted it; this form simply never asked. So every company created
              here had none, and the whole dealer-economics engine refuses to run
              without one: the quotation calculator throws, and the funding split
              and dealership contribution can never be derived. */}
          <div className="grid gap-2">
            <Label htmlFor="default-ltv-percent">{t("DefaultDealerLtv" as any)}</Label>
            <Input
              id="default-ltv-percent"
              type="number"
              step="0.01"
              inputMode="decimal"
              placeholder={t("DefaultDealerLtvPlaceholder" as any)}
              value={formData.defaultLtvPercent}
              onChange={(e) => setFormData({ ...formData, defaultLtvPercent: e.target.value })}
            />
            {clearingExistingLtv ? (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("DefaultDealerLtvCannotClear" as any)}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("DefaultDealerLtvHint" as any)}</p>
            )}
          </div>
          <div className="grid gap-2">
            <Label>{t("ExecutionCommission" as any)}</Label>
            <Input
              type="number"
              value={formData.commission}
              onChange={(e) => setFormData({ ...formData, commission: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div className="grid gap-2">
            <Label>{t("AcceptedCustomerStatuses" as any)}</Label>
            <p className="text-xs text-muted-foreground">
              {t("AcceptedCustomerStatusesHelp" as any)}
            </p>
            {/* Loading and "none configured" are different statements. Reading
                them off the same empty array told the user no statuses exist
                while the query was still in flight. */}
            {loadedCustomerStatuses === undefined ? (
              <p className="text-xs text-muted-foreground">{t("Loading" as any) ?? "Loading..."}</p>
            ) : customerStatusOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("NoCustomerStatusesConfigured" as any) ?? "No customer statuses configured yet — add some below."}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {customerStatusOptions.map((option: Doc<"orgCustomerStatuses">) => (
                  <div key={option._id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`accepted-status-${option._id}`}
                      className="w-4 h-4"
                      checked={formData.acceptedStatuses.includes(option._id)}
                      onChange={() => toggleAcceptedStatus(option._id)}
                    />
                    <Label htmlFor={`accepted-status-${option._id}`} className="font-normal">
                      {translateCustomerStatusLabel(option.label, locale)}
                    </Label>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* The company's expected handover costs. Separate from the legacy
              "Execution Fees" / "Execution Commission" amounts above: those are
              single figures the quotation engine uses, these are the itemised
              fees each new deal freezes as its handover-cost checklist. Nothing
              is inferred from one into the other. */}
          <section
            aria-labelledby="fee-templates-heading"
            className="grid gap-3 rounded-md border border-border/70 p-3"
            data-testid="fee-templates-section"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="grid gap-1">
                <h3 id="fee-templates-heading" className="text-sm font-semibold">
                  {t("FeeTemplatesHeading")}
                </h3>
                <p className="text-xs text-muted-foreground">{t("FeeTemplatesHint")}</p>
              </div>
              <span
                className={cn(
                  "shrink-0 text-xs tabular-nums",
                  feeRowsOverLimit ? "font-medium text-destructive" : "text-muted-foreground"
                )}
                data-testid="fee-templates-count"
              >
                {interpolate(t("FeeTemplateCount"), { count: feeRows.length, max: MAX_FEE_TEMPLATES })}
              </span>
            </div>
            {feeCurrency.state === "loading" ? (
              <p className="text-xs text-muted-foreground">{t("FeeTemplatesCurrencyLoading")}</p>
            ) : feeCurrency.state === "unsupported" ? (
              <p role="alert" className="text-xs font-medium text-destructive">
                {interpolate(t("FeeTemplatesCurrencyUnsupported"), { currency: feeCurrency.code })}
              </p>
            ) : feeRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("FeeTemplatesEmpty")}</p>
            ) : (
              <ul className="grid gap-2">
                {feeRows.map((row, index) => (
                  <FeeTemplateRowEditor
                    key={row.key}
                    row={row}
                    problem={showFeeProblems ? feeConversion?.problems[row.key] : undefined}
                    expanded={expandedFeeKeys.has(row.key)}
                    currencyLabel={feeCurrency.label}
                    currencyCode={feeCurrency.code}
                    currencyScale={feeCurrency.scale}
                    rowIndex={index}
                    t={t}
                    onChange={(patch) => updateFeeRow(row.key, patch)}
                    onRemove={() => removeFeeRow(row.key)}
                    onToggleExpanded={() => toggleFeeRowExpanded(row.key)}
                  />
                ))}
              </ul>
            )}
            {feeRowsOverLimit && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {interpolate(t("FeeTemplatesOverLimit"), { max: MAX_FEE_TEMPLATES })}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addFeeRow}
                disabled={feeCurrency.state !== "ready" || feeRows.length >= MAX_FEE_TEMPLATES}
              >
                <Plus className="h-4 w-4" />
                {t("FeeTemplateAdd")}
              </Button>
              {feeRows.length >= MAX_FEE_TEMPLATES && (
                <span className="text-xs text-muted-foreground">
                  {interpolate(t("FeeTemplatesLimitReached"), { max: MAX_FEE_TEMPLATES })}
                </span>
              )}
            </div>
          </section>
          <div className="flex flex-col gap-3 pt-2">
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="includesCommissionInDebt"
                  className="w-4 h-4"
                  checked={formData.includesCommissionInDebt}
                  onChange={(e) => setFormData({ ...formData, includesCommissionInDebt: e.target.checked })}
                />
                <Label htmlFor="includesCommissionInDebt">{t("CapitalizesCommissionIntoDebt" as any)}</Label>
              </div>
              <p className="text-xs text-muted-foreground mt-1 ms-6">
                {t("CapitalizesCommissionIntoDebtHint" as any)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isActive"
                className="w-4 h-4"
                checked={formData.isActive}
                onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
              />
              <Label htmlFor="isActive">{t("Is Active" as any)}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancel" as any)}
            </Button>
            {/* Also disabled until the customer statuses and the org currency
                arrive, so the button cannot be pressed while the tick-list is
                still empty or a fee amount would be scaled by a guess. */}
            <Button
              type="submit"
              disabled={isLoading || loadedCustomerStatuses === undefined || feeCurrency.state !== "ready"}
            >
              {isLoading ? t("Saving..." as any) : t("Save" as any)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One expected cost. The main line is what an operator configures daily —
 * type, amount, an optional description. Who pays whom and how it posts are
 * behind a per-row disclosure: every value is stated explicitly (the server
 * infers none of them) and pre-filled per type, but shown only on request so
 * a company with six fees is not thirty controls tall.
 */
function FeeTemplateRowEditor({
  row,
  problem,
  expanded,
  currencyLabel,
  currencyCode,
  currencyScale,
  rowIndex,
  t,
  onChange,
  onRemove,
  onToggleExpanded,
}: Readonly<{
  row: FeeTemplateFormRow;
  /** Set only once a save was attempted; `undefined` renders no error. */
  problem: FeeAmountProblem | undefined;
  expanded: boolean;
  currencyLabel: string;
  currencyCode: string;
  currencyScale: number;
  rowIndex: number;
  t: (key: string) => string;
  onChange: (patch: Partial<FeeTemplateFormRow>) => void;
  onRemove: () => void;
  onToggleExpanded: () => void;
}>) {
  const id = (field: string) => `fee-template-${row.key}-${field}`;
  const problemMessage =
    problem === undefined
      ? null
      : interpolate(t(FEE_AMOUNT_PROBLEM_LABEL[problem]), { currency: currencyCode, scale: currencyScale });

  return (
    <li className="grid gap-2 rounded-md bg-muted/40 p-2" data-testid={`fee-template-row-${row.key}`}>
      {/* `items-start`: when the amount cell grows by an error line, the type
          select and the remove button stay on the input line, not the bottom. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]">
        <div className="grid gap-1">
          <Label htmlFor={id("type")} className="text-xs">
            {t("FeeTemplateType")}
          </Label>
          <select
            id={id("type")}
            className={selectClass}
            value={row.feeType}
            onChange={(e) => {
              const feeType = e.target.value as FinanceFeeType;
              // Re-derive the counterparty and treatment for the new type;
              // both stay visible and editable under "Accounting details".
              onChange({ feeType, ...defaultsForFeeType(feeType) });
            }}
          >
            {FINANCE_FEE_TYPES.map((feeType) => (
              <option key={feeType} value={feeType}>
                {t(FEE_TYPE_LABEL[feeType])}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1 sm:col-start-2">
          <Label htmlFor={id("amount")} className="text-xs">
            {t("FeeTemplateEstimatedAmount")}
          </Label>
          <div className="flex items-center gap-2">
            {/* Text, not number: the value is parsed as a decimal STRING so the
                stored fils are exactly what was typed. Numbers stay LTR in
                Arabic; the currency label follows the reading direction. */}
            <Input
              id={id("amount")}
              type="text"
              inputMode="decimal"
              dir="ltr"
              className="text-end"
              placeholder="0"
              value={row.estimatedAmount}
              aria-invalid={problem !== undefined}
              aria-describedby={problem !== undefined ? id("amount-problem") : undefined}
              onChange={(e) => onChange({ estimatedAmount: e.target.value })}
            />
            <span className="shrink-0 text-xs text-muted-foreground">{currencyLabel}</span>
          </div>
          {problemMessage && (
            <p id={id("amount-problem")} role="alert" className="text-xs font-medium text-destructive">
              {problemMessage}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // `mt-5` = the label line (text-xs) plus the gap, so the icon sits beside the input.
          className="row-start-1 col-start-2 mt-5 text-destructive hover:text-destructive sm:col-start-3"
          aria-label={`${t("FeeTemplateRemove")} ${rowIndex + 1}: ${t(FEE_TYPE_LABEL[row.feeType])}`}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={id("description")} className="text-xs">
          {t("FeeTemplateDescription")}
        </Label>
        <Input
          id={id("description")}
          value={row.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      <button
        type="button"
        className="flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        aria-controls={id("accounting")}
        onClick={onToggleExpanded}
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
        {t("FeeTemplateAccountingDetails")}
      </button>
      {expanded && (
        <div id={id("accounting")} className="grid gap-2">
          {/* Two parties side by side; the treatment gets the full width — its
              labels are sentences ("Recoverable from the customer") and were
              clipped at a third of the dialog. */}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor={id("paid-by")} className="text-xs">
                {t("FeeTemplatePaidBy")}
              </Label>
              <select
                id={id("paid-by")}
                className={selectClass}
                value={row.paidBy}
                onChange={(e) => onChange({ paidBy: e.target.value as FeeParty })}
              >
                {FEE_PARTIES.map((party) => (
                  <option key={party} value={party}>
                    {t(FEE_PARTY_LABEL[party])}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={id("paid-to")} className="text-xs">
                {t("FeeTemplatePaidTo")}
              </Label>
              <select
                id={id("paid-to")}
                className={selectClass}
                value={row.paidTo}
                onChange={(e) => onChange({ paidTo: e.target.value as FeeParty })}
              >
                {FEE_PARTIES.map((party) => (
                  <option key={party} value={party}>
                    {t(FEE_PARTY_LABEL[party])}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1 sm:col-span-2">
              <Label htmlFor={id("treatment")} className="text-xs">
                {t("CostTreatmentLabel")}
              </Label>
              <select
                id={id("treatment")}
                className={selectClass}
                value={row.accountingTreatment}
                onChange={(e) => onChange({ accountingTreatment: e.target.value as FeeAccountingTreatment })}
              >
                {FEE_ACCOUNTING_TREATMENTS.map((treatment) => (
                  <option key={treatment} value={treatment}>
                    {t(FEE_TREATMENT_LABEL[treatment])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ["includedInQuotation", "FeeTemplateIncludedInQuotation"],
                ["deductedFromSettlement", "FeeTemplateDeductedFromSettlement"],
                ["refundable", "FeeTemplateRefundable"],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={id(field)}
                  className="w-4 h-4"
                  checked={row[field]}
                  onChange={(e) => onChange({ [field]: e.target.checked } as Partial<FeeTemplateFormRow>)}
                />
                <Label htmlFor={id(field)} className="text-xs font-normal">
                  {t(label)}
                </Label>
              </div>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}
