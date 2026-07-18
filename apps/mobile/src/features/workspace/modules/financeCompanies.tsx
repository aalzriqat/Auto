import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { GuidedStepFlow, type GuidedStep } from "../../../components/GuidedStepFlow";
import { api, type MobileFinanceCompany } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { type Option, type MobileFinanceCompanyFilter, type FinancePreviewInput, TERM_MONTH_PRESETS, FINANCE_SCENARIO_PRESETS, compactNumber, money, parseOptionalNumber, parseRequiredNumber, parseRequiredPositiveNumber, useGenericError, SearchInput, PrimaryButton, Chip, SegmentedControl, FormField, SelectField, FormModal, RecordCard, MetricCard, EmptyList, calculateFinancePreview, financeCompanyMatchesView, averageFinanceRate, DetailPill, SummaryRow, SummaryPanel, WizardActions, ModuleScroll } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function FinanceCompaniesModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  const companies = useQuery(api.finance.listCompanies, { orgId });
  const createCompany = useMutation(api.finance.createCompany);
  const updateCompany = useMutation(api.finance.updateCompany);
  const deleteCompany = useMutation(api.finance.deleteCompany);
  const [editing, setEditing] = useState<MobileFinanceCompany | null>(null);
  const [detailCompany, setDetailCompany] = useState<MobileFinanceCompany | null>(null);
  const [financeStep, setFinanceStep] = useState(0);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<MobileFinanceCompanyFilter>("ALL");
  const [samplePrice, setSamplePrice] = useState("24000");
  const [sampleDownPayment, setSampleDownPayment] = useState("4800");
  const [form, setForm] = useState({
    name: "",
    profitRate: "",
    maxTermMonths: "60",
    gracePeriodMonths: "0",
    insuranceRate: "",
    adminFees: "",
    commission: "",
    maxFinancingLTV: "",
    isActive: "true",
    includesCommissionInDebt: "false",
  });
  const visibleCompanies = (companies ?? []).filter((company) =>
    financeCompanyMatchesView(company, statusFilter, search),
  );
  const activeCompanies = (companies ?? []).filter((company) => company.isActive);
  const inactiveCompanies = (companies ?? []).filter((company) => !company.isActive);
  const financeStatusOptions: Array<Option<MobileFinanceCompanyFilter>> = [
    { label: locale === "ar" ? "الكل" : "All", value: "ALL" },
    { label: locale === "ar" ? "نشطة" : "Active", value: "ACTIVE" },
    { label: locale === "ar" ? "متوقفة" : "Inactive", value: "INACTIVE" },
  ];
  const previewInput: FinancePreviewInput = {
    adminFees: parseOptionalNumber(form.adminFees) ?? 0,
    commission: parseOptionalNumber(form.commission) ?? 0,
    downPayment: parseOptionalNumber(sampleDownPayment) ?? 0,
    gracePeriodMonths: parseOptionalNumber(form.gracePeriodMonths) ?? 0,
    includesCommissionInDebt: form.includesCommissionInDebt === "true",
    insuranceRate: parseOptionalNumber(form.insuranceRate) ?? 0,
    profitRate: parseOptionalNumber(form.profitRate) ?? 0,
    termMonths: parseOptionalNumber(form.maxTermMonths) ?? 0,
    vehiclePrice: parseOptionalNumber(samplePrice) ?? 0,
  };
  const preview = calculateFinancePreview(previewInput);
  const financeSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "هوية الشركة" : "Company profile",
      subtitle: locale === "ar" ? "الاسم والحالة وطريقة احتساب العمولة." : "Name, availability, and commission behavior.",
    },
    {
      title: locale === "ar" ? "الشروط الأساسية" : "Core terms",
      subtitle: locale === "ar" ? "نسبة الربح والمدة وفترة السماح." : "Profit rate, repayment term, and grace period.",
    },
    {
      title: locale === "ar" ? "محاكاة الصفقة" : "Deal simulation",
      subtitle: locale === "ar" ? "رسوم وحدود مع معاينة قسط فورية." : "Fees and limits with an instant payment preview.",
    },
  ];

  function fill(company: MobileFinanceCompany | null) {
    setEditing(company);
    setFinanceStep(0);
    setForm({
      name: company?.name ?? "",
      profitRate: company ? String(company.profitRate) : "",
      maxTermMonths: company ? String(company.maxTermMonths) : "60",
      gracePeriodMonths: company ? String(company.gracePeriodMonths) : "0",
      insuranceRate: company?.insuranceRate != null ? String(company.insuranceRate) : "",
      adminFees: company?.adminFees != null ? String(company.adminFees) : "",
      commission: company?.commission != null ? String(company.commission) : "",
      maxFinancingLTV: company?.maxFinancingLTV != null ? String(company.maxFinancingLTV) : "",
      isActive: company?.isActive === false ? "false" : "true",
      includesCommissionInDebt: company?.includesCommissionInDebt ? "true" : "false",
    });
    setOpen(true);
  }

  function applyScenario(price: string, downPayment: string) {
    setSamplePrice(price);
    setSampleDownPayment(downPayment);
  }

  function selectTerm(maxTermMonths: string) {
    setForm((prev) => ({ ...prev, maxTermMonths }));
  }

  async function save() {
    const profitRate = parseRequiredNumber(form.profitRate);
    const maxTermMonths = parseRequiredPositiveNumber(form.maxTermMonths);
    const gracePeriodMonths = parseRequiredNumber(form.gracePeriodMonths);
    if (!form.name.trim() || profitRate === null || maxTermMonths === null || gracePeriodMonths === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    const payload = {
      orgId,
      name: form.name,
      profitRate,
      maxTermMonths,
      gracePeriodMonths,
      insuranceRate: parseOptionalNumber(form.insuranceRate),
      adminFees: parseOptionalNumber(form.adminFees),
      commission: parseOptionalNumber(form.commission),
      maxFinancingLTV: parseOptionalNumber(form.maxFinancingLTV),
      includesCommissionInDebt: form.includesCommissionInDebt === "true",
      isActive: form.isActive === "true",
    };
    try {
      if (editing) {
        await updateCompany({ ...payload, id: editing._id });
      } else {
        await createCompany(payload);
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile finance company save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(company: MobileFinanceCompany) {
    try {
      await deleteCompany({ orgId, id: company._id });
    } catch (error) {
      reportError("Mobile finance company deactivate failed", error);
    }
  }

  if (companies === undefined) return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;

  return (
    <ModuleScroll>
      <View style={styles.metricGrid}>
        <MetricCard title={locale === "ar" ? "الشركات" : "Companies"} value={compactNumber(companies.length, locale)} caption={locale === "ar" ? "إجمالي" : "total"} />
        <MetricCard title={locale === "ar" ? "نشطة" : "Active"} value={compactNumber(activeCompanies.length, locale)} caption={locale === "ar" ? "جاهزة للعروض" : "ready for quotes"} />
        <MetricCard title={locale === "ar" ? "متوسط الربح" : "Avg rate"} value={`${averageFinanceRate(activeCompanies).toFixed(1)}%`} caption={locale === "ar" ? "للشركات النشطة" : "active companies"} />
        <MetricCard title={locale === "ar" ? "متوقفة" : "Inactive"} value={compactNumber(inactiveCompanies.length, locale)} caption={locale === "ar" ? "غير مستخدمة" : "not in use"} />
      </View>
      <View style={styles.actionRow}>
        <SearchInput
          placeholder={locale === "ar" ? "ابحث باسم الشركة أو النسبة" : "Search company or rate"}
          value={search}
          onChangeText={setSearch}
        />
        <PrimaryButton label={locale === "ar" ? "إضافة شركة" : "Add"} onPress={() => fill(null)} />
      </View>
      <SegmentedControl options={financeStatusOptions} value={statusFilter} onChange={setStatusFilter} />
      {visibleCompanies.length ? visibleCompanies.map((company) => (
        <RecordCard key={company._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{company.name}</Text>
            <Text style={styles.statusPill}>{company.isActive ? "ACTIVE" : "INACTIVE"}</Text>
          </View>
          <View style={styles.detailPillRow}>
            <DetailPill label={`${company.profitRate}%`} tone="info" />
            <DetailPill label={`${company.maxTermMonths}m`} />
            <DetailPill label={`LTV ${company.maxFinancingLTV ?? "-"}`} tone="warning" />
            {company.includesCommissionInDebt ? <DetailPill label={locale === "ar" ? "عمولة خارج الأصل" : "flat commission"} tone="success" /> : null}
          </View>
          <Text style={styles.recordMeta}>
            {locale === "ar" ? "رسوم" : "Fees"} {money(company.adminFees, locale)} · {locale === "ar" ? "عمولة" : "Commission"} {money(company.commission, locale)}
          </Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailCompany(company)} />
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => fill(company)} />
            {company.isActive ? <PrimaryButton label={locale === "ar" ? "تعطيل" : "Deactivate"} tone="danger" onPress={() => deactivate(company)} /> : null}
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد شركات مطابقة." : "No matching finance companies."} />}
      <FormModal
        title={editing ? (locale === "ar" ? "تعديل شركة" : "Edit company") : (locale === "ar" ? "شركة جديدة" : "New company")}
        visible={open}
        onClose={() => setOpen(false)}
      >
        <GuidedStepFlow activeIndex={financeStep} steps={financeSteps}>
          {financeStep === 0 ? (
            <>
              <FormField label={locale === "ar" ? "اسم الشركة" : "Company name"} value={form.name} onChangeText={(name) => setForm((prev) => ({ ...prev, name }))} />
              <SelectField label={locale === "ar" ? "فعالة" : "Active"} value={form.isActive} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))} />
              <SelectField
                label={locale === "ar" ? "احتساب العمولة" : "Commission treatment"}
                value={form.includesCommissionInDebt}
                options={[
                  { label: locale === "ar" ? "ضمن أصل الدين" : "Finance commission in debt", value: "false" },
                  { label: locale === "ar" ? "عمولة ثابتة خارج الدين" : "Add commission as flat fee", value: "true" },
                ]}
                onChange={(includesCommissionInDebt) => setForm((prev) => ({ ...prev, includesCommissionInDebt }))}
              />
              <SummaryPanel title={locale === "ar" ? "تأثير الاختيار" : "Setup impact"}>
                <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={form.isActive === "true" ? (locale === "ar" ? "نشطة" : "Active") : (locale === "ar" ? "متوقفة" : "Inactive")} />
                <SummaryRow label={locale === "ar" ? "العمولة" : "Commission"} value={form.includesCommissionInDebt === "true" ? (locale === "ar" ? "تضاف كرسوم ثابتة" : "added as a flat fee") : (locale === "ar" ? "تدخل في التمويل" : "financed into the debt")} />
              </SummaryPanel>
            </>
          ) : null}
          {financeStep === 1 ? (
            <>
              <FormField keyboardType="numeric" label={locale === "ar" ? "نسبة الربح" : "Profit rate"} value={form.profitRate} onChangeText={(profitRate) => setForm((prev) => ({ ...prev, profitRate }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "أقصى مدة" : "Max term months"} value={form.maxTermMonths} onChangeText={(maxTermMonths) => setForm((prev) => ({ ...prev, maxTermMonths }))} />
              <View style={styles.chipRow}>
                {TERM_MONTH_PRESETS.map((term) => (
                  <Chip
                    key={term}
                    label={`${term}m`}
                    selected={form.maxTermMonths === term}
                    value={term}
                    onPress={() => selectTerm(term)}
                  />
                ))}
              </View>
              <FormField keyboardType="numeric" label={locale === "ar" ? "فترة السماح" : "Grace months"} value={form.gracePeriodMonths} onChangeText={(gracePeriodMonths) => setForm((prev) => ({ ...prev, gracePeriodMonths }))} />
              <View style={styles.metricGrid}>
                <MetricCard title={locale === "ar" ? "نسبة" : "Rate"} value={`${previewInput.profitRate.toFixed(2)}%`} caption={locale === "ar" ? "سنوية" : "annual"} />
                <MetricCard title={locale === "ar" ? "مدة" : "Term"} value={`${previewInput.termMonths}m`} caption={locale === "ar" ? "أقصى مدة" : "max months"} />
              </View>
            </>
          ) : null}
          {financeStep === 2 ? (
            <>
              <View style={styles.chipRow}>
                {FINANCE_SCENARIO_PRESETS.map((scenario) => (
                  <Chip
                    key={scenario.labelEn}
                    label={locale === "ar" ? scenario.labelAr : scenario.labelEn}
                    selected={samplePrice === scenario.price && sampleDownPayment === scenario.downPayment}
                    value={scenario.labelEn}
                    onPress={() => applyScenario(scenario.price, scenario.downPayment)}
                  />
                ))}
              </View>
              <FormField keyboardType="numeric" label={locale === "ar" ? "سعر تجربة" : "Sample vehicle price"} value={samplePrice} onChangeText={setSamplePrice} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "دفعة تجربة" : "Sample down payment"} value={sampleDownPayment} onChangeText={setSampleDownPayment} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "تأمين %" : "Insurance rate"} value={form.insuranceRate} onChangeText={(insuranceRate) => setForm((prev) => ({ ...prev, insuranceRate }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "رسوم إدارية" : "Admin fees"} value={form.adminFees} onChangeText={(adminFees) => setForm((prev) => ({ ...prev, adminFees }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "عمولة" : "Commission"} value={form.commission} onChangeText={(commission) => setForm((prev) => ({ ...prev, commission }))} />
              <FormField keyboardType="numeric" label="LTV" value={form.maxFinancingLTV} onChangeText={(maxFinancingLTV) => setForm((prev) => ({ ...prev, maxFinancingLTV }))} />
              <SummaryPanel
                title={locale === "ar" ? "معاينة القسط" : "Payment preview"}
                subtitle={locale === "ar" ? "تقدير للعرض فقط؛ الحفظ لا ينشئ صفقة." : "Preview only; saving does not create a deal."}
              >
                <SummaryRow label={locale === "ar" ? "المبلغ الممول" : "Financed amount"} value={money(preview.financedAmount, locale)} />
                <SummaryRow label={locale === "ar" ? "إجمالي الربح" : "Total profit"} value={money(preview.totalProfit, locale)} />
                <SummaryRow label={locale === "ar" ? "إجمالي العقد" : "Contract value"} value={money(preview.totalContractValue, locale)} />
                <SummaryRow label={locale === "ar" ? "القسط الشهري" : "Monthly installment"} value={money(preview.monthlyInstallment, locale)} />
              </SummaryPanel>
            </>
          ) : null}
          <WizardActions
            activeStep={financeStep}
            backLabel={locale === "ar" ? "السابق" : "Back"}
            nextLabel={locale === "ar" ? "التالي" : "Next"}
            saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ الشركة" : "Save company")}
            saving={saving}
            totalSteps={financeSteps.length}
            onBack={() => setFinanceStep((step) => Math.max(0, step - 1))}
            onNext={() => setFinanceStep((step) => Math.min(financeSteps.length - 1, step + 1))}
            onSave={save}
          />
        </GuidedStepFlow>
      </FormModal>
      <FormModal
        title={detailCompany?.name ?? (locale === "ar" ? "تفاصيل الشركة" : "Company details")}
        visible={Boolean(detailCompany)}
        onClose={() => setDetailCompany(null)}
      >
        {detailCompany ? (
          <>
            <View style={styles.metricGrid}>
              <MetricCard title={locale === "ar" ? "النسبة" : "Rate"} value={`${detailCompany.profitRate}%`} caption={locale === "ar" ? "ربح سنوي" : "annual profit"} />
              <MetricCard title={locale === "ar" ? "المدة" : "Term"} value={`${detailCompany.maxTermMonths}m`} caption={locale === "ar" ? "أقصى مدة" : "maximum"} />
            </View>
            <SummaryPanel title={locale === "ar" ? "إعدادات التمويل" : "Finance settings"}>
              <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={detailCompany.isActive ? "ACTIVE" : "INACTIVE"} />
              <SummaryRow label={locale === "ar" ? "فترة السماح" : "Grace period"} value={`${detailCompany.gracePeriodMonths}m`} />
              <SummaryRow label={locale === "ar" ? "رسوم إدارية" : "Admin fees"} value={money(detailCompany.adminFees, locale)} />
              <SummaryRow label={locale === "ar" ? "تأمين" : "Insurance"} value={`${detailCompany.insuranceRate ?? 0}%`} />
              <SummaryRow label={locale === "ar" ? "عمولة" : "Commission"} value={money(detailCompany.commission, locale)} />
              <SummaryRow label="LTV" value={`${detailCompany.maxFinancingLTV ?? "-"}%`} />
            </SummaryPanel>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} onPress={() => {
                const selectedCompany = detailCompany;
                setDetailCompany(null);
                fill(selectedCompany);
              }} />
              {detailCompany.isActive ? <PrimaryButton label={locale === "ar" ? "تعطيل" : "Deactivate"} tone="danger" onPress={() => deactivate(detailCompany)} /> : null}
            </View>
          </>
        ) : null}
      </FormModal>
    </ModuleScroll>
  );
}

