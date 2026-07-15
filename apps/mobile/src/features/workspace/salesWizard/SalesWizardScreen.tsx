// Native port of the web SalesWizard (components/sales/SalesWizard.tsx):
// the same 4-step quote flow — Setup → Customer → Review → Success — with
// CASH (teal) and INSTALLMENT (indigo) accents, murabaha finance comparison,
// customer-status gating, and profit-approval blocking.
import { useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Icon } from "../../../components/Icon";
import {
  api,
  type MobileCustomer,
  type MobileFinanceCompany,
} from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { theme } from "../../../theme";
import { compactInitials } from "../nativeModules";
import { money, parseOptionalNumber, useGenericError, SearchInput } from "../modules/moduleShared";
import { calculateUnifiedMurabaha, type UnifiedMurabahaResult } from "./murabaha";

export type WizardPaymentType = "CASH" | "INSTALLMENT";

const OTHER_COMPANY_ID = "OTHER";

type WizardStep = 1 | 2 | 3 | 4;

interface ComparisonRow {
  company: MobileFinanceCompany;
  result: UnifiedMurabahaResult;
  actualValuation: number;
  maxFinancingAllowed: number;
  exceedsValuation: boolean;
  minimumDownPayment: number;
}

function accentColor(paymentType: WizardPaymentType): string {
  return paymentType === "CASH" ? theme.colors.primary : theme.colors.indigo;
}

function accentSoft(paymentType: WizardPaymentType): string {
  return paymentType === "CASH" ? theme.colors.primarySoft : theme.colors.indigoSoft;
}

function StepIndicator({
  currentStep,
  paymentType,
}: Readonly<{ currentStep: WizardStep; paymentType: WizardPaymentType }>) {
  const { locale, textDirection } = useLocale();
  const labels = [
    locale === "ar" ? "الإعداد" : "Setup",
    locale === "ar" ? "العميل" : "Customer",
    locale === "ar" ? "المراجعة" : "Review",
  ];
  const accent = accentColor(paymentType);

  return (
    <View style={[styles.stepRow, { direction: textDirection }]}>
      {labels.map((label, index) => {
        const step = index + 1;
        const done = currentStep > step;
        const active = currentStep === step;
        return (
          <View key={label} style={styles.stepItem}>
            <View
              style={[
                styles.stepCircle,
                (active || done) && { backgroundColor: accent },
              ]}
            >
              {done ? (
                <Icon color="onPrimary" name="check" size={14} />
              ) : (
                <Text style={[styles.stepNumber, (active || done) && styles.stepNumberActive]}>
                  {step}
                </Text>
              )}
            </View>
            <Text style={[styles.stepLabel, active && { color: accent }]}>{label}</Text>
            {step < 3 ? <View style={[styles.stepLine, done && { backgroundColor: accent }]} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function Field({
  keyboardType,
  label,
  onChangeText,
  value,
}: Readonly<{
  keyboardType?: "numeric" | "default";
  label: string;
  onChangeText: (value: string) => void;
  value: string;
}>) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        keyboardType={keyboardType ?? "default"}
        placeholderTextColor={theme.colors.subtleText}
        style={styles.fieldInput}
        value={value}
        onChangeText={onChangeText}
      />
    </View>
  );
}

export function SalesWizardScreen({
  onClose,
  orgId,
  paymentType,
}: Readonly<{
  onClose: () => void;
  orgId: string;
  paymentType: WizardPaymentType;
}>) {
  const { locale, textDirection } = useLocale();
  const reportError = useGenericError();
  const isCash = paymentType === "CASH";
  const accent = accentColor(paymentType);

  const [step, setStep] = useState<WizardStep>(1);

  // ── Step 1 state ─────────────────────────────────────────────
  const [vehicleId, setVehicleId] = useState("");
  const [vehiclePrice, setVehiclePrice] = useState("");
  const [desiredProfit, setDesiredProfit] = useState("0");
  const [downPayment, setDownPayment] = useState("0");
  const [termMonths, setTermMonths] = useState("84");
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | undefined>(undefined);
  const [customerStatuses, setCustomerStatuses] = useState<string[]>([]);
  const [manualProfitRate, setManualProfitRate] = useState("0");
  const [manualInsuranceRate, setManualInsuranceRate] = useState("0");
  const [manualCommission, setManualCommission] = useState("0");
  const [manualFees, setManualFees] = useState("0");
  const [manualIncludesCommission, setManualIncludesCommission] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [requesting, setRequesting] = useState(false);

  // ── Step 2 state ─────────────────────────────────────────────
  const [customer, setCustomer] = useState<MobileCustomer | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ firstName: "", lastName: "", phone: "" });

  // ── Step 3/4 state ───────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [shared, setShared] = useState(false);

  const availableVehicles = useQuery(api.vehicles.listAll, {
    orgId,
    status: "AVAILABLE",
    includeReserved: true,
  });
  const statusOptions = useQuery(api.orgCustomerStatuses.list, { orgId });
  const companies = useQuery(api.finance.listCompanies, isCash ? "skip" as never : { orgId });
  const valuations = useQuery(
    api.finance.listValuations,
    !isCash && vehicleId ? { orgId, vehicleId } : "skip",
  );
  const pendingApproval = useQuery(
    api.approvals.checkPendingApproval,
    !isCash && vehicleId ? { orgId, vehicleId } : "skip",
  );
  const customersPage = useQuery(api.customers.list, {
    orgId,
    paginationOpts: { cursor: null, numItems: 100 },
  });
  const requestApproval = useMutation(api.approvals.requestProfitApproval);
  const createCustomer = useMutation(api.customers.create);
  const saveQuote = useMutation(api.quotes.saveQuote);
  const updateQuoteStatus = useMutation(api.quotes.updateQuoteStatus);

  const activeStatusOptions = (statusOptions ?? []).filter((option) => option.isActive);
  const selectedVehicle =
    (availableVehicles ?? []).find((vehicle) => vehicle._id === vehicleId) ?? null;

  const price = parseOptionalNumber(vehiclePrice) ?? 0;
  const profit = parseOptionalNumber(desiredProfit) ?? 0;
  const down = parseOptionalNumber(downPayment) ?? 0;
  const term = parseOptionalNumber(termMonths) ?? 0;
  const effectivePrice = price + profit;

  const minimumProfit = selectedVehicle?.minimumProfit ?? 0;
  const isProfitBelowMinimum = !isCash && Boolean(vehicleId) && profit < minimumProfit;
  const hasValidApproval =
    pendingApproval?.status === "APPROVED" && profit >= pendingApproval.requestedProfit;
  const isBlockedByProfit = isProfitBelowMinimum && !hasValidApproval;

  // Mirrors useFinanceComparison: gate on customer statuses, filter by each
  // company's acceptedStatuses, then run the murabaha math per company.
  const comparisons = useMemo<ComparisonRow[]>(() => {
    if (isCash || !vehicleId || price <= 0 || customerStatuses.length === 0) return [];
    return (companies ?? [])
      .filter((company) => company.isActive)
      .filter((company) => {
        const accepted = company.acceptedStatuses;
        if (!accepted || accepted.length === 0) return true;
        return customerStatuses.some((status) => accepted.includes(status));
      })
      .map((company) => {
        const result = calculateUnifiedMurabaha({
          vehiclePrice: effectivePrice,
          downPayment: down,
          commission: company.commission || 0,
          processingFees: company.adminFees || 0,
          annualProfitRate: company.profitRate,
          annualInsuranceRate: company.insuranceRate || 0,
          termMonths: term,
          gracePeriodMonths: company.gracePeriodMonths,
          includesCommissionInDebt: company.includesCommissionInDebt,
        });
        const actualValuation =
          (valuations ?? []).find((valuation) => valuation.companyId === company._id)
            ?.valuationAmount || 0;
        const maxLTV = company.maxFinancingLTV || 0;
        const maxFinancingAllowed =
          maxLTV > 0 && actualValuation > 0
            ? actualValuation * (maxLTV / 100)
            : Number.MAX_SAFE_INTEGER;
        const exceedsValuation = result.financedAmount > maxFinancingAllowed && actualValuation > 0;
        const minimumDownPayment = Math.max(
          0,
          effectivePrice + (company.commission || 0) + (company.adminFees || 0) - maxFinancingAllowed,
        );
        return { company, result, actualValuation, maxFinancingAllowed, exceedsValuation, minimumDownPayment };
      });
  }, [companies, customerStatuses, down, effectivePrice, isCash, price, term, valuations, vehicleId]);

  const manualResult = useMemo(
    () =>
      calculateUnifiedMurabaha({
        vehiclePrice: effectivePrice,
        downPayment: down,
        commission: parseOptionalNumber(manualCommission) ?? 0,
        processingFees: parseOptionalNumber(manualFees) ?? 0,
        annualProfitRate: parseOptionalNumber(manualProfitRate) ?? 0,
        annualInsuranceRate: parseOptionalNumber(manualInsuranceRate) ?? 0,
        termMonths: term,
        includesCommissionInDebt: manualIncludesCommission,
      }),
    [down, effectivePrice, manualCommission, manualFees, manualInsuranceRate, manualProfitRate, manualIncludesCommission, term],
  );

  const selectedComparison = comparisons.find((row) => row.company._id === selectedCompanyId) ?? null;
  const selectedResult = selectedCompanyId === OTHER_COMPANY_ID ? manualResult : selectedComparison?.result ?? null;

  const filteredVehicles = (availableVehicles ?? []).filter((vehicle) => {
    const haystack = `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.vin}`.toLowerCase();
    return haystack.includes(pickerSearch.trim().toLowerCase());
  });
  const filteredCustomers = (customersPage?.page ?? []).filter((row) => {
    const haystack = `${row.firstName} ${row.lastName} ${row.phone ?? ""}`.toLowerCase();
    return haystack.includes(customerSearch.trim().toLowerCase());
  });

  const canLeaveStep1 =
    Boolean(vehicleId) &&
    price > 0 &&
    !isBlockedByProfit &&
    (isCash || Boolean(selectedCompanyId));

  async function handleRequestApproval() {
    if (!vehicleId) return;
    setRequesting(true);
    try {
      await requestApproval({
        orgId,
        vehicleId,
        requestedProfit: profit,
        minimumProfit,
        wizardSnapshot: {
          paymentType,
          vehiclePrice: price,
          desiredProfit: profit,
          downPayment: down,
          termMonths: term,
          selectedCompanyId,
        },
      });
    } catch (error) {
      reportError("Mobile wizard approval request failed", error);
    } finally {
      setRequesting(false);
    }
  }

  async function handleCreateCustomer() {
    if (!newCustomer.firstName.trim() || !newCustomer.lastName.trim()) return;
    setSaving(true);
    try {
      const id = await createCustomer({
        orgId,
        firstName: newCustomer.firstName,
        lastName: newCustomer.lastName,
        phone: newCustomer.phone.trim() || undefined,
      });
      setCustomer({
        _id: id,
        firstName: newCustomer.firstName,
        lastName: newCustomer.lastName,
        phone: newCustomer.phone.trim() || undefined,
      } as MobileCustomer);
      setCreatingCustomer(false);
    } catch (error) {
      reportError("Mobile wizard customer create failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateQuote() {
    if (!customer || !vehicleId) return;
    setSaving(true);
    try {
      const manual = selectedCompanyId === OTHER_COMPANY_ID;
      const id = await saveQuote({
        orgId,
        customerId: customer._id,
        vehicleId,
        companyId: !isCash && !manual ? selectedCompanyId : undefined,
        mode: isCash ? "CASH" : manual ? "MANUAL_FINANCE_COMPANY" : "CONFIGURED_FINANCE_COMPANY",
        vehiclePrice: price,
        downPayment: down,
        termMonths: isCash ? 0 : term,
        totalFinancedAmount: selectedResult?.financedAmount,
        monthlyInstallment: selectedResult?.monthlyInstallment,
        profitRateApplied: manual
          ? parseOptionalNumber(manualProfitRate) ?? 0
          : selectedComparison?.company.profitRate,
        totalProfit: selectedResult?.totalProfit,
        manualProviderName: manual ? (locale === "ar" ? "جهة أخرى" : "Other provider") : undefined,
        manualProfitRate: manual ? parseOptionalNumber(manualProfitRate) ?? 0 : undefined,
        manualInsuranceRate: manual ? parseOptionalNumber(manualInsuranceRate) ?? 0 : undefined,
        manualAdminFees: manual ? parseOptionalNumber(manualFees) ?? 0 : undefined,
        manualCommission: manual ? parseOptionalNumber(manualCommission) ?? 0 : undefined,
        manualIncludesCommissionInDebt: manual ? manualIncludesCommission : undefined,
      });
      setQuoteId(id);
      setStep(4);
    } catch (error) {
      reportError("Mobile wizard quote save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkShared() {
    if (!quoteId) return;
    try {
      await updateQuoteStatus({ orgId, quoteId, status: "SHARED" });
      setShared(true);
    } catch (error) {
      reportError("Mobile wizard quote share failed", error);
    }
  }

  const title = isCash
    ? locale === "ar" ? "عرض نقدي جديد" : "New Cash Quote"
    : locale === "ar" ? "عرض تقسيط جديد" : "New Installment Quote";

  return (
    <View style={[styles.root, { direction: textDirection }]}>
      {/* HEADER — matches the web wizard header (title + step X of 3 + close) */}
      <View style={styles.header}>
        <View style={[styles.headerIcon, { backgroundColor: accentSoft(paymentType) }]}>
          <Icon color={isCash ? "primary" : "indigo"} name={isCash ? "sales" : "billing"} size={20} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>{title}</Text>
          <Text style={styles.headerCaption}>
            {locale === "ar" ? "الخطوة" : "Step"} {Math.min(step, 3)} {locale === "ar" ? "من" : "of"} 3
          </Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={locale === "ar" ? "إغلاق" : "Close"} style={styles.closeButton} onPress={onClose}>
          <Icon color="text" name="close" size={20} />
        </Pressable>
      </View>

      {step < 4 ? <StepIndicator currentStep={step} paymentType={paymentType} /> : null}

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* ── STEP 1 — QUOTE SETUP ─────────────────────────────── */}
        {step === 1 ? (
          <>
            {/* Payment-type badge card */}
            <View style={[styles.badgeCard, { backgroundColor: accentSoft(paymentType) }]}>
              <Icon color={isCash ? "primary" : "indigo"} name={isCash ? "sales" : "billing"} size={22} />
              <View style={styles.badgeCardText}>
                <Text style={styles.badgeCardTitle}>
                  {isCash
                    ? locale === "ar" ? "صفقة نقدية" : "Cash Deal"
                    : locale === "ar" ? "عرض تقسيط" : "Installment Quote"}
                </Text>
                <Text style={styles.badgeCardCaption}>
                  {isCash
                    ? locale === "ar" ? "دفعة كاملة بدون تمويل" : "Full payment, no financing"
                    : locale === "ar" ? "تمويل بأقساط شهرية" : "Financing with monthly installments"}
                </Text>
              </View>
              <Text style={[styles.badgeOutline, { color: accent, borderColor: accent }]}>
                {isCash ? (locale === "ar" ? "نقدي" : "Cash") : (locale === "ar" ? "ممول" : "Financed")}
              </Text>
            </View>

            {/* Vehicle picker */}
            <Text style={styles.sectionLabel}>{locale === "ar" ? "السيارة" : "Vehicle"}</Text>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.vehicleSelector, pressed && styles.pressed]}
              onPress={() => setPickerOpen(true)}
            >
              {selectedVehicle ? (
                <>
                  <Text style={styles.vehicleSelectorTitle}>
                    {selectedVehicle.year} {selectedVehicle.make} {selectedVehicle.model}
                  </Text>
                  <Text style={styles.vehicleSelectorMeta}>
                    {selectedVehicle.trim || selectedVehicle.vin} · {money(selectedVehicle.sellingPrice, locale)}
                  </Text>
                </>
              ) : (
                <Text style={styles.vehicleSelectorPlaceholder}>
                  {locale === "ar" ? "اختر سيارة من المخزون" : "Choose a vehicle from inventory"}
                </Text>
              )}
              <Icon color="subtleText" name="chevronDown" size={18} />
            </Pressable>

            {/* Cost bar — purchase vs sale margin, like VehicleCostBar */}
            {selectedVehicle?.purchasePrice != null ? (
              <View style={styles.costBar}>
                <View style={styles.costBarRow}>
                  <Text style={styles.costBarLabel}>{locale === "ar" ? "التكلفة" : "Cost"}</Text>
                  <Text style={styles.costBarValue}>{money(selectedVehicle.purchasePrice, locale)}</Text>
                </View>
                <View style={styles.costBarRow}>
                  <Text style={styles.costBarLabel}>{locale === "ar" ? "الهامش" : "Margin"}</Text>
                  <Text style={[styles.costBarValue, { color: accent }]}>
                    {money(Math.max(0, (price || selectedVehicle.sellingPrice || 0) - (selectedVehicle.purchasePrice ?? 0)), locale)}
                  </Text>
                </View>
              </View>
            ) : null}

            {/* Pricing grid */}
            <View style={styles.fieldGrid}>
              <Field
                keyboardType="numeric"
                label={locale === "ar" ? "سعر السيارة" : "Vehicle price (JOD)"}
                value={vehiclePrice}
                onChangeText={(value) => {
                  setVehiclePrice(value);
                  setSelectedCompanyId(undefined);
                }}
              />
              {!isCash ? (
                <>
                  <Field
                    keyboardType="numeric"
                    label={locale === "ar" ? "ربح المعرض" : "Dealer profit"}
                    value={desiredProfit}
                    onChangeText={(value) => {
                      setDesiredProfit(value);
                      setSelectedCompanyId(undefined);
                    }}
                  />
                  <Field
                    keyboardType="numeric"
                    label={locale === "ar" ? "الدفعة الأولى" : "Down payment"}
                    value={downPayment}
                    onChangeText={setDownPayment}
                  />
                  <Field
                    keyboardType="numeric"
                    label={locale === "ar" ? "عدد الأشهر" : "Term (months)"}
                    value={termMonths}
                    onChangeText={setTermMonths}
                  />
                </>
              ) : null}
            </View>

            {/* Customer status requirements */}
            {!isCash ? (
              <>
                <Text style={styles.sectionLabel}>
                  {locale === "ar" ? "متطلبات حالة العميل" : "Customer status requirements"}
                </Text>
                {activeStatusOptions.length === 0 ? (
                  <Text style={styles.hintText}>
                    {locale === "ar"
                      ? "لا توجد حالات عملاء معرفة — أضفها من إعدادات التمويل."
                      : "No customer statuses configured yet — set them up in Finance Settings."}
                  </Text>
                ) : (
                  <View style={styles.statusGrid}>
                    {activeStatusOptions.map((option) => {
                      const checked = customerStatuses.includes(option._id);
                      return (
                        <Pressable
                          key={option._id}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked }}
                          style={[styles.statusChip, checked && { backgroundColor: accentSoft(paymentType) }]}
                          onPress={() => {
                            setCustomerStatuses((prev) =>
                              prev.includes(option._id)
                                ? prev.filter((id) => id !== option._id)
                                : [...prev, option._id],
                            );
                            setSelectedCompanyId(undefined);
                          }}
                        >
                          <View style={[styles.checkbox, checked && { backgroundColor: accent, borderColor: accent }]}>
                            {checked ? <Icon color="onPrimary" name="check" size={12} /> : null}
                          </View>
                          <Text style={styles.statusChipText}>{option.label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                {/* Finance comparison panel */}
                <Text style={styles.sectionLabel}>
                  {locale === "ar" ? "شركات التمويل" : "Financing companies"}
                </Text>
                {customerStatuses.length === 0 ? (
                  <Text style={styles.hintText}>
                    {locale === "ar"
                      ? "اختر حالة العميل أولاً لعرض العروض المتاحة."
                      : "Select the customer status first to see available offers."}
                  </Text>
                ) : null}
                {comparisons.map(({ company, exceedsValuation, minimumDownPayment, result }) => {
                  const selected = selectedCompanyId === company._id;
                  return (
                    <Pressable
                      key={company._id}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      style={[styles.companyCard, selected && { borderColor: accent, borderWidth: 2 }]}
                      onPress={() => setSelectedCompanyId(company._id)}
                    >
                      <View style={styles.companyHeader}>
                        <Text style={styles.companyName}>{company.name}</Text>
                        <Text style={[styles.companyRate, { color: accent }]}>{company.profitRate}%</Text>
                      </View>
                      <Text style={[styles.companyMonthly, { color: accent }]}>
                        {money(result.monthlyInstallment, locale)}
                        <Text style={styles.companyMonthlyUnit}> /{locale === "ar" ? "شهر" : "mo"}</Text>
                      </Text>
                      <View style={styles.companyMetaRow}>
                        <Text style={styles.companyMeta}>
                          {locale === "ar" ? "التمويل" : "Financed"}: {money(result.financedAmount, locale)}
                        </Text>
                        <Text style={styles.companyMeta}>
                          {locale === "ar" ? "الربح" : "Profit"}: {money(result.totalProfit, locale)}
                        </Text>
                        <Text style={styles.companyMeta}>
                          {locale === "ar" ? "التكافل" : "Takaful"}: {money(result.takafulAmount, locale)}
                        </Text>
                      </View>
                      {exceedsValuation ? (
                        <Text style={styles.companyWarning}>
                          {locale === "ar"
                            ? `يتجاوز حد التمويل — الحد الأدنى للدفعة ${money(minimumDownPayment, locale)}`
                            : `Exceeds financing limit — minimum down payment ${money(minimumDownPayment, locale)}`}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}

                {/* Manual "Others" card */}
                {customerStatuses.length > 0 && vehicleId ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedCompanyId === OTHER_COMPANY_ID }}
                    style={[styles.companyCard, selectedCompanyId === OTHER_COMPANY_ID && { borderColor: accent, borderWidth: 2 }]}
                    onPress={() => setSelectedCompanyId(OTHER_COMPANY_ID)}
                  >
                    <View style={styles.companyHeader}>
                      <Text style={styles.companyName}>{locale === "ar" ? "جهة أخرى (يدوي)" : "Others (manual)"}</Text>
                      <Text style={[styles.companyMonthly, { color: accent }]}>
                        {money(manualResult.monthlyInstallment, locale)}
                        <Text style={styles.companyMonthlyUnit}> /{locale === "ar" ? "شهر" : "mo"}</Text>
                      </Text>
                    </View>
                    {selectedCompanyId === OTHER_COMPANY_ID ? (
                      <View style={styles.manualGrid}>
                        <Field keyboardType="numeric" label={locale === "ar" ? "نسبة الربح %" : "Profit rate %"} value={manualProfitRate} onChangeText={setManualProfitRate} />
                        <Field keyboardType="numeric" label={locale === "ar" ? "نسبة التأمين %" : "Insurance rate %"} value={manualInsuranceRate} onChangeText={setManualInsuranceRate} />
                        <Field keyboardType="numeric" label={locale === "ar" ? "عمولة التنفيذ" : "Execution commission"} value={manualCommission} onChangeText={setManualCommission} />
                        <Field keyboardType="numeric" label={locale === "ar" ? "رسوم التنفيذ" : "Execution fees"} value={manualFees} onChangeText={setManualFees} />
                        <Pressable
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: manualIncludesCommission }}
                          style={styles.statusChip}
                          onPress={() => setManualIncludesCommission((value) => !value)}
                        >
                          <View style={[styles.checkbox, manualIncludesCommission && { backgroundColor: accent, borderColor: accent }]}>
                            {manualIncludesCommission ? <Icon color="onPrimary" name="check" size={12} /> : null}
                          </View>
                          <Text style={styles.statusChipText}>
                            {locale === "ar" ? "العمولة ضمن الدين" : "Commission included in debt"}
                          </Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </Pressable>
                ) : null}

                {/* Profit approval gate */}
                {isBlockedByProfit ? (
                  <View style={styles.approvalAlert}>
                    <Text style={styles.approvalTitle}>
                      {locale === "ar" ? "موافقة مطلوبة" : "Approval required"}
                    </Text>
                    <Text style={styles.approvalBody}>
                      {locale === "ar"
                        ? `الربح المطلوب (${money(profit, locale)}) أقل من الحد الأدنى (${money(minimumProfit, locale)}).`
                        : `Desired profit (${money(profit, locale)}) is below this vehicle's minimum (${money(minimumProfit, locale)}).`}
                    </Text>
                    {pendingApproval?.status === "PENDING" && pendingApproval.requestedProfit === profit ? (
                      <Text style={styles.approvalPending}>
                        {locale === "ar" ? "الطلب قيد الانتظار — بانتظار المدير." : "Approval request pending — waiting for a manager."}
                      </Text>
                    ) : pendingApproval?.status === "REJECTED" && pendingApproval.requestedProfit === profit ? (
                      <Text style={styles.approvalRejected}>
                        {locale === "ar" ? "رُفض هذا المبلغ — ارفع الربح أو اطلب مجدداً." : "This amount was rejected — raise the profit or request again."}
                      </Text>
                    ) : (
                      <Pressable
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.approvalButton, pressed && styles.pressed]}
                        onPress={handleRequestApproval}
                      >
                        <Text style={styles.approvalButtonText}>
                          {requesting
                            ? locale === "ar" ? "جاري الطلب..." : "Requesting..."
                            : locale === "ar" ? "طلب موافقة الربح" : "Request profit approval"}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                ) : null}
                {hasValidApproval && isProfitBelowMinimum ? (
                  <View style={styles.approvedNote}>
                    <Icon color="success" name="check" size={16} />
                    <Text style={styles.approvedNoteText}>
                      {locale === "ar" ? "تمت الموافقة على الربح — يمكنك المتابعة." : "Profit approved by management — you may proceed."}
                    </Text>
                  </View>
                ) : null}
              </>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canLeaveStep1 }}
              disabled={!canLeaveStep1}
              style={({ pressed }) => [
                styles.nextButton,
                { backgroundColor: accent },
                !canLeaveStep1 && styles.disabled,
                pressed && styles.pressed,
              ]}
              onPress={() => setStep(2)}
            >
              <Text style={styles.nextButtonText}>{locale === "ar" ? "التالي" : "Next"}</Text>
            </Pressable>
          </>
        ) : null}

        {/* ── STEP 2 — CUSTOMER ────────────────────────────────── */}
        {step === 2 ? (
          <>
            {customer ? (
              <View style={[styles.badgeCard, { backgroundColor: accentSoft(paymentType) }]}>
                <View style={styles.customerAvatar}>
                  <Text style={styles.customerAvatarText}>
                    {compactInitials(`${customer.firstName} ${customer.lastName}`)}
                  </Text>
                </View>
                <View style={styles.badgeCardText}>
                  <Text style={styles.badgeCardTitle}>{customer.firstName} {customer.lastName}</Text>
                  <Text style={styles.badgeCardCaption}>{customer.phone || (locale === "ar" ? "بدون هاتف" : "No phone")}</Text>
                </View>
                <Pressable accessibilityRole="button" onPress={() => setCustomer(null)}>
                  <Icon color="mutedText" name="close" size={18} />
                </Pressable>
              </View>
            ) : creatingCustomer ? (
              <View style={styles.createCard}>
                <Text style={styles.sectionLabel}>{locale === "ar" ? "عميل جديد" : "New customer"}</Text>
                <Field label={locale === "ar" ? "الاسم الأول" : "First name"} value={newCustomer.firstName} onChangeText={(firstName) => setNewCustomer((prev) => ({ ...prev, firstName }))} />
                <Field label={locale === "ar" ? "اسم العائلة" : "Last name"} value={newCustomer.lastName} onChangeText={(lastName) => setNewCustomer((prev) => ({ ...prev, lastName }))} />
                <Field keyboardType="numeric" label={locale === "ar" ? "الهاتف" : "Phone"} value={newCustomer.phone} onChangeText={(phone) => setNewCustomer((prev) => ({ ...prev, phone }))} />
                <View style={styles.rowButtons}>
                  <Pressable accessibilityRole="button" style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]} onPress={() => setCreatingCustomer(false)}>
                    <Text style={styles.ghostButtonText}>{locale === "ar" ? "إلغاء" : "Cancel"}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={saving}
                    style={({ pressed }) => [styles.nextButton, { backgroundColor: accent, flex: 1 }, pressed && styles.pressed]}
                    onPress={handleCreateCustomer}
                  >
                    <Text style={styles.nextButtonText}>
                      {saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "إنشاء" : "Create")}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <>
                <SearchInput
                  placeholder={locale === "ar" ? "ابحث بالاسم أو الهاتف" : "Search by name or phone"}
                  value={customerSearch}
                  onChangeText={setCustomerSearch}
                />
                <Pressable
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
                  onPress={() => setCreatingCustomer(true)}
                >
                  <Text style={[styles.ghostButtonText, { color: accent }]}>
                    + {locale === "ar" ? "إنشاء عميل جديد" : "Create new customer"}
                  </Text>
                </Pressable>
                {filteredCustomers.map((row) => (
                  <Pressable
                    key={row._id}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.customerRow, pressed && styles.pressed]}
                    onPress={() => setCustomer(row)}
                  >
                    <View style={styles.customerAvatar}>
                      <Text style={styles.customerAvatarText}>{compactInitials(`${row.firstName} ${row.lastName}`)}</Text>
                    </View>
                    <View style={styles.badgeCardText}>
                      <Text style={styles.badgeCardTitle}>{row.firstName} {row.lastName}</Text>
                      <Text style={styles.badgeCardCaption}>{row.phone || row.email || "-"}</Text>
                    </View>
                    <Icon color="subtleText" name="chevronForward" size={16} />
                  </Pressable>
                ))}
              </>
            )}

            <View style={styles.rowButtons}>
              <Pressable accessibilityRole="button" style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]} onPress={() => setStep(1)}>
                <Text style={styles.ghostButtonText}>{locale === "ar" ? "السابق" : "Back"}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !customer }}
                disabled={!customer}
                style={({ pressed }) => [styles.nextButton, { backgroundColor: accent, flex: 1 }, !customer && styles.disabled, pressed && styles.pressed]}
                onPress={() => setStep(3)}
              >
                <Text style={styles.nextButtonText}>{locale === "ar" ? "التالي" : "Next"}</Text>
              </Pressable>
            </View>
          </>
        ) : null}

        {/* ── STEP 3 — REVIEW ──────────────────────────────────── */}
        {step === 3 && customer ? (
          <>
            <View style={styles.reviewCard}>
              <Text style={styles.reviewCardLabel}>{locale === "ar" ? "العميل" : "Customer"}</Text>
              <Text style={styles.reviewCardTitle}>{customer.firstName} {customer.lastName}</Text>
              <Text style={styles.reviewCardMeta}>{customer.phone || "-"}</Text>
            </View>
            <View style={styles.reviewCard}>
              <Text style={styles.reviewCardLabel}>{locale === "ar" ? "السيارة" : "Vehicle"}</Text>
              <Text style={styles.reviewCardTitle}>
                {selectedVehicle ? `${selectedVehicle.year} ${selectedVehicle.make} ${selectedVehicle.model}` : "-"}
              </Text>
              <Text style={[styles.reviewCardPrice, { color: accent }]}>{money(price, locale)}</Text>
            </View>
            <View style={styles.reviewCard}>
              <Text style={styles.reviewCardLabel}>
                {isCash ? (locale === "ar" ? "ملخص الدفع" : "Payment summary") : (locale === "ar" ? "ملخص التمويل" : "Finance summary")}
              </Text>
              {isCash ? (
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewRowLabel}>{locale === "ar" ? "الإجمالي نقداً" : "Total due (cash)"}</Text>
                  <Text style={[styles.reviewRowValue, { color: accent }]}>{money(price, locale)}</Text>
                </View>
              ) : (
                <>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewRowLabel}>{locale === "ar" ? "الجهة" : "Provider"}</Text>
                    <Text style={styles.reviewRowValue}>
                      {selectedCompanyId === OTHER_COMPANY_ID
                        ? locale === "ar" ? "جهة أخرى" : "Other provider"
                        : selectedComparison?.company.name ?? "-"}
                    </Text>
                  </View>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewRowLabel}>{locale === "ar" ? "الدفعة الأولى" : "Down payment"}</Text>
                    <Text style={styles.reviewRowValue}>{money(down, locale)}</Text>
                  </View>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewRowLabel}>{locale === "ar" ? "التمويل" : "Financed amount"}</Text>
                    <Text style={styles.reviewRowValue}>{money(selectedResult?.financedAmount, locale)}</Text>
                  </View>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewRowLabel}>{locale === "ar" ? "المدة" : "Term"}</Text>
                    <Text style={styles.reviewRowValue}>{term} {locale === "ar" ? "شهر" : "months"}</Text>
                  </View>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewRowLabel}>{locale === "ar" ? "القسط الشهري" : "Monthly installment"}</Text>
                    <Text style={[styles.reviewRowValue, styles.reviewMonthly, { color: accent }]}>
                      {money(selectedResult?.monthlyInstallment, locale)}
                    </Text>
                  </View>
                </>
              )}
            </View>

            <View style={styles.rowButtons}>
              <Pressable accessibilityRole="button" style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]} onPress={() => setStep(2)}>
                <Text style={styles.ghostButtonText}>{locale === "ar" ? "السابق" : "Back"}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={saving}
                style={({ pressed }) => [styles.nextButton, { backgroundColor: accent, flex: 1 }, pressed && styles.pressed]}
                onPress={handleCreateQuote}
              >
                <Text style={styles.nextButtonText}>
                  {saving
                    ? locale === "ar" ? "جاري الإنشاء..." : "Creating..."
                    : locale === "ar" ? "إنشاء العرض" : "Create quote"}
                </Text>
              </Pressable>
            </View>
          </>
        ) : null}

        {/* ── STEP 4 — SUCCESS ─────────────────────────────────── */}
        {step === 4 && customer ? (
          <>
            <View style={styles.successBlock}>
              <View style={[styles.successCircle, { backgroundColor: accentSoft(paymentType) }]}>
                <Icon color={isCash ? "primary" : "indigo"} name="check" size={34} />
              </View>
              <Text style={styles.successTitle}>
                {locale === "ar" ? "تم إنشاء العرض" : "Quote created"}
              </Text>
              <Text style={styles.successCaption}>
                {customer.firstName} {customer.lastName} · {selectedVehicle ? `${selectedVehicle.year} ${selectedVehicle.make} ${selectedVehicle.model}` : ""}
              </Text>
              {!isCash && selectedResult ? (
                <Text style={[styles.successMonthly, { color: accent }]}>
                  {money(selectedResult.monthlyInstallment, locale)} /{locale === "ar" ? "شهر" : "mo"}
                </Text>
              ) : (
                <Text style={[styles.successMonthly, { color: accent }]}>{money(price, locale)}</Text>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={shared}
              style={({ pressed }) => [styles.nextButton, { backgroundColor: accent }, shared && styles.disabled, pressed && styles.pressed]}
              onPress={handleMarkShared}
            >
              <Text style={styles.nextButtonText}>
                {shared
                  ? locale === "ar" ? "تمت المشاركة" : "Marked as shared"
                  : locale === "ar" ? "تحديد كمشارك مع العميل" : "Mark as shared with customer"}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]} onPress={onClose}>
              <Text style={styles.ghostButtonText}>{locale === "ar" ? "تم" : "Done"}</Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>

      {/* Vehicle picker sheet */}
      <Modal transparent animationType="slide" visible={pickerOpen} onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.sheetRoot}>
          <Pressable style={styles.sheetDismiss} onPress={() => setPickerOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.sheetGrabber} />
            <SearchInput
              placeholder={locale === "ar" ? "ابحث في المخزون" : "Search inventory"}
              value={pickerSearch}
              onChangeText={setPickerSearch}
            />
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.sheetList}>
              {filteredVehicles.map((vehicle) => (
                <Pressable
                  key={vehicle._id}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.customerRow, pressed && styles.pressed]}
                  onPress={() => {
                    setVehicleId(vehicle._id);
                    setVehiclePrice(String(vehicle.sellingPrice));
                    setSelectedCompanyId(undefined);
                    setPickerOpen(false);
                  }}
                >
                  <View style={styles.badgeCardText}>
                    <Text style={styles.badgeCardTitle}>
                      {vehicle.year} {vehicle.make} {vehicle.model}
                    </Text>
                    <Text style={styles.badgeCardCaption}>{vehicle.trim || vehicle.vin}</Text>
                  </View>
                  <Text style={[styles.reviewRowValue, { color: accent }]}>
                    {money(vehicle.sellingPrice, locale)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  headerIcon: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  headerTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  headerCaption: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  stepRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  stepItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
  },
  stepCircle: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  stepNumber: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  stepNumberActive: {
    color: theme.colors.onPrimary,
  },
  stepLabel: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  stepLine: {
    width: 18,
    height: 2,
    borderRadius: 1,
    backgroundColor: theme.colors.border,
  },
  content: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xxl,
  },
  badgeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
  },
  badgeCardText: {
    flex: 1,
    minWidth: 0,
  },
  badgeCardTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  badgeCardCaption: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  badgeOutline: {
    borderWidth: 1,
    borderRadius: theme.radius.full,
    fontSize: 12,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 3,
  },
  sectionLabel: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "600",
    marginTop: theme.spacing.xs,
  },
  vehicleSelector: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    ...theme.shadows.sm,
  },
  vehicleSelectorTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  vehicleSelectorMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  vehicleSelectorPlaceholder: {
    flex: 1,
    color: theme.colors.subtleText,
    fontSize: 15,
  },
  costBar: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.md,
  },
  costBarRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  costBarLabel: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  costBarValue: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  fieldGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
  },
  field: {
    flexGrow: 1,
    minWidth: "45%",
    gap: theme.spacing.xs,
  },
  fieldLabel: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  fieldInput: {
    minHeight: 46,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    color: theme.colors.text,
    fontSize: 16,
    paddingHorizontal: theme.spacing.md,
  },
  hintText: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  statusGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  checkbox: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.surface,
  },
  statusChipText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "500",
  },
  companyCard: {
    gap: theme.spacing.sm,
    borderWidth: 2,
    borderColor: "transparent",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    ...theme.shadows.sm,
  },
  companyHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  companyName: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  companyRate: {
    fontSize: 14,
    fontWeight: "700",
  },
  companyMonthly: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  companyMonthlyUnit: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "500",
  },
  companyMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
  },
  companyMeta: {
    color: theme.colors.mutedText,
    fontSize: 12,
  },
  companyWarning: {
    color: theme.colors.danger,
    fontSize: 12,
    fontWeight: "600",
  },
  manualGrid: {
    gap: theme.spacing.sm,
  },
  approvalAlert: {
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.dangerSoft,
    padding: theme.spacing.lg,
  },
  approvalTitle: {
    color: theme.colors.danger,
    fontSize: 15,
    fontWeight: "700",
  },
  approvalBody: {
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  approvalPending: {
    color: theme.colors.warning,
    fontSize: 13,
    fontWeight: "600",
  },
  approvalRejected: {
    color: theme.colors.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  approvalButton: {
    alignSelf: "flex-start",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.danger,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  approvalButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  approvedNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.successSoft,
    padding: theme.spacing.md,
  },
  approvedNoteText: {
    flex: 1,
    color: theme.colors.success,
    fontSize: 13,
    fontWeight: "600",
  },
  nextButton: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.xl,
  },
  nextButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 16,
    fontWeight: "600",
  },
  ghostButton: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.lg,
  },
  ghostButtonText: {
    color: theme.colors.mutedText,
    fontSize: 15,
    fontWeight: "600",
  },
  rowButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  createCard: {
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    ...theme.shadows.sm,
  },
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  customerAvatar: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  customerAvatarText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: "700",
  },
  reviewCard: {
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    ...theme.shadows.sm,
  },
  reviewCardLabel: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  reviewCardTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  reviewCardMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  reviewCardPrice: {
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  reviewRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing.sm,
  },
  reviewRowLabel: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  reviewRowValue: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  reviewMonthly: {
    fontSize: 18,
    fontWeight: "700",
  },
  successBlock: {
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xl,
  },
  successCircle: {
    width: 76,
    height: 76,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
  },
  successTitle: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  successCaption: {
    color: theme.colors.mutedText,
    fontSize: 14,
    textAlign: "center",
  },
  successMonthly: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  sheetRoot: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15,23,42,0.4)",
  },
  sheetDismiss: {
    flex: 1,
  },
  sheet: {
    maxHeight: "82%",
    gap: theme.spacing.md,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
  },
  sheetGrabber: {
    alignSelf: "center",
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.borderStrong,
  },
  sheetList: {
    flexGrow: 0,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.85,
  },
});
