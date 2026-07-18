import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { GuidedStepFlow, type GuidedStep } from "../../../components/GuidedStepFlow";
import { api, type MobileQuote, type MobileQuoteMode, type MobileQuoteStatus } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { SELECTOR_PAGE_SIZE, type Option, money, dateLabel, maybeText, parseOptionalNumber, parseRequiredNumber, parseRequiredPositiveNumber, useGenericError, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, RecordCard, MetricCard, ModuleList, getOptionLabel, DetailPill, SummaryRow, SummaryPanel, WizardActions } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function QuotesModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  const saveQuote = useMutation(api.quotes.saveQuote);
  const updateQuoteStatus = useMutation(api.quotes.updateQuoteStatus);
  const customers = usePaginatedQuery(api.customers.list, { orgId }, { initialNumItems: SELECTOR_PAGE_SIZE });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, status: "AVAILABLE", includeReserved: true });
  const companies = useQuery(api.finance.listCompanies, { orgId });
  const customerOptions = customers.results.map((customer) => ({ label: `${customer.firstName} ${customer.lastName}`, value: customer._id }));
  const vehicleOptions = (vehicles ?? []).map((vehicle) => ({ label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, value: vehicle._id }));
  const companyOptions = [
    { label: locale === "ar" ? "بدون شركة" : "No company", value: "" },
    ...(companies ?? []).filter((company) => company.isActive).map((company) => ({ label: company.name, value: company._id })),
  ];
  const [customerId, setCustomerId] = useState("");
  const quotes = useQuery(api.quotes.listQuotesByCustomer, customerId ? { orgId, customerId } : "skip");
  const [open, setOpen] = useState(false);
  const [quoteStep, setQuoteStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    customerId: "",
    vehicleId: "",
    companyId: "",
    mode: "CASH" as MobileQuoteMode,
    vehiclePrice: "",
    downPayment: "0",
    termMonths: "60",
    monthlyInstallment: "",
    recipientName: "",
  });
  const quoteStatusOptions: MobileQuoteStatus[] = ["DRAFT", "SHARED", "ACCEPTED", "EXPIRED"];
  const quoteModeOptions: Array<Option<MobileQuoteMode>> = [
    { label: "CASH", value: "CASH" },
    { label: "CONFIGURED", value: "CONFIGURED_FINANCE_COMPANY" },
    { label: "MANUAL", value: "MANUAL_FINANCE_COMPANY" },
    { label: "INSTALLMENT", value: "INTERNAL_INSTALLMENT" },
    { label: "LEASE", value: "LEASE" },
  ];
  const selectedQuoteCustomerLabel = getOptionLabel(customerOptions, form.customerId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedQuoteVehicleLabel = getOptionLabel(vehicleOptions, form.vehicleId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedCompanyLabel = getOptionLabel(companyOptions, form.companyId, locale === "ar" ? "بدون شركة" : "No company");
  const vehiclePricePreview = parseOptionalNumber(form.vehiclePrice) ?? 0;
  const quoteDownPaymentPreview = parseOptionalNumber(form.downPayment) ?? 0;
  const termMonthsPreview = parseOptionalNumber(form.termMonths) ?? 0;
  const monthlyPreview = parseOptionalNumber(form.monthlyInstallment)
    ?? (termMonthsPreview > 0 ? Math.max(0, vehiclePricePreview - quoteDownPaymentPreview) / termMonthsPreview : 0);
  const quoteSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "العميل والسيارة" : "Customer and vehicle",
      subtitle: locale === "ar" ? "ابدأ باختيار العميل والسيارة." : "Start with the buyer and inventory item.",
    },
    {
      title: locale === "ar" ? "خطة العرض" : "Quote plan",
      subtitle: locale === "ar" ? "حدد النقد أو التمويل والأرقام الأساسية." : "Choose cash or finance and the core numbers.",
    },
    {
      title: locale === "ar" ? "المراجعة والإرسال" : "Review and save",
      subtitle: locale === "ar" ? "راجع العرض قبل حفظه." : "Check the quote before saving it.",
    },
  ];

  function openCreate() {
    setQuoteStep(0);
    setForm({
      customerId: customerId || customerOptions[0]?.value || "",
      vehicleId: vehicleOptions[0]?.value || "",
      companyId: "",
      mode: "CASH",
      vehiclePrice: "",
      downPayment: "0",
      termMonths: "60",
      monthlyInstallment: "",
      recipientName: "",
    });
    setOpen(true);
  }

  function closeQuoteForm() {
    setQuoteStep(0);
    setOpen(false);
  }

  function chooseQuoteVehicle(vehicleId: string) {
    const selectedVehicle = (vehicles ?? []).find((vehicle) => vehicle._id === vehicleId);
    setForm((prev) => ({
      ...prev,
      vehicleId,
      vehiclePrice: selectedVehicle?.sellingPrice != null ? String(selectedVehicle.sellingPrice) : "",
    }));
  }

  async function save() {
    const vehiclePrice = parseRequiredPositiveNumber(form.vehiclePrice);
    const downPayment = parseRequiredNumber(form.downPayment);
    const termMonths = parseRequiredPositiveNumber(form.termMonths);
    if (!form.customerId || !form.vehicleId || vehiclePrice === null || downPayment === null || termMonths === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      await saveQuote({
        orgId,
        customerId: form.customerId,
        vehicleId: form.vehicleId,
        companyId: form.mode === "CONFIGURED_FINANCE_COMPANY" ? maybeText(form.companyId) : undefined,
        mode: form.mode,
        vehiclePrice,
        downPayment,
        termMonths,
        monthlyInstallment: parseOptionalNumber(form.monthlyInstallment),
        recipientName: maybeText(form.recipientName),
      });
      setCustomerId(form.customerId);
      closeQuoteForm();
    } catch (error) {
      reportError("Mobile quote save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(quote: MobileQuote, status: MobileQuoteStatus) {
    try {
      await updateQuoteStatus({ orgId, quoteId: quote._id, status });
    } catch (error) {
      reportError("Mobile quote status failed", error);
    }
  }

  return (
    <>
      <ModuleList
        data={quotes ?? []}
        emptyLabel={
          !customerId
            ? (locale === "ar" ? "اختر عميل لعرض العروض." : "Choose a customer to view quotes.")
            : quotes === undefined
              ? ""
              : (locale === "ar" ? "لا توجد عروض لهذا العميل." : "No quotes for this customer.")
        }
        keyExtractor={(quote) => quote._id}
        header={
          <>
            <View style={styles.actionRow}>
              <SelectField label={locale === "ar" ? "العميل" : "Customer"} value={customerId} options={customerOptions} onChange={setCustomerId} />
              <PrimaryButton label={locale === "ar" ? "عرض جديد" : "New quote"} onPress={openCreate} />
            </View>
            {quotes === undefined && customerId ? <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} /> : null}
          </>
        }
        renderItem={(quote) => (
          <RecordCard>
            <View style={styles.recordHeader}>
              <Text style={styles.recordTitle}>{money(quote.vehiclePrice, locale)}</Text>
              <Text style={styles.statusPill}>{quote.status}</Text>
            </View>
            <View style={styles.detailPillRow}>
              <DetailPill label={quote.mode || "CASH"} tone="info" />
              <DetailPill label={`${quote.termMonths}m`} />
              <DetailPill label={money(quote.monthlyInstallment, locale)} tone="success" />
            </View>
            <Text style={styles.recordMeta}>{dateLabel(quote.createdAt, locale)}</Text>
            <View style={styles.cardActions}>
              {quoteStatusOptions.map((statusOption) => (
                <PrimaryButton key={statusOption} label={statusOption} tone="muted" onPress={() => setStatus(quote, statusOption)} />
              ))}
            </View>
          </RecordCard>
        )}
      />
      <FormModal title={locale === "ar" ? "عرض جديد" : "New quote"} visible={open} onClose={closeQuoteForm}>
        <GuidedStepFlow activeIndex={quoteStep} steps={quoteSteps}>
          {quoteStep === 0 ? (
            <>
              <SelectField label={locale === "ar" ? "العميل" : "Customer"} value={form.customerId} options={customerOptions} onChange={(customerIdValue) => setForm((prev) => ({ ...prev, customerId: customerIdValue }))} />
              <SelectField label={locale === "ar" ? "السيارة" : "Vehicle"} value={form.vehicleId} options={vehicleOptions} onChange={chooseQuoteVehicle} />
              <SummaryPanel title={locale === "ar" ? "نطاق العرض" : "Quote scope"}>
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedQuoteCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedQuoteVehicleLabel} />
              </SummaryPanel>
            </>
          ) : null}
          {quoteStep === 1 ? (
            <>
              <SegmentedControl options={quoteModeOptions} value={form.mode} onChange={(mode) => setForm((prev) => ({ ...prev, mode }))} />
              {form.mode === "CONFIGURED_FINANCE_COMPANY" ? <SelectField label={locale === "ar" ? "شركة التمويل" : "Finance company"} value={form.companyId} options={companyOptions} onChange={(companyId) => setForm((prev) => ({ ...prev, companyId }))} /> : null}
              <FormField keyboardType="numeric" label={locale === "ar" ? "سعر السيارة" : "Vehicle price"} value={form.vehiclePrice} onChangeText={(vehiclePrice) => setForm((prev) => ({ ...prev, vehiclePrice }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "دفعة أولى" : "Down payment"} value={form.downPayment} onChangeText={(downPayment) => setForm((prev) => ({ ...prev, downPayment }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "الأشهر" : "Term months"} value={form.termMonths} onChangeText={(termMonths) => setForm((prev) => ({ ...prev, termMonths }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "القسط الشهري" : "Monthly installment"} value={form.monthlyInstallment} onChangeText={(monthlyInstallment) => setForm((prev) => ({ ...prev, monthlyInstallment }))} />
              <View style={styles.metricGrid}>
                <MetricCard title={locale === "ar" ? "القيمة" : "Price"} value={money(vehiclePricePreview, locale)} caption={locale === "ar" ? "سعر السيارة" : "vehicle price"} />
                <MetricCard title={locale === "ar" ? "القسط" : "Monthly"} value={money(monthlyPreview, locale)} caption={locale === "ar" ? "تقديري" : "estimated"} />
              </View>
            </>
          ) : null}
          {quoteStep === 2 ? (
            <>
              <FormField label={locale === "ar" ? "اسم المستلم" : "Recipient"} value={form.recipientName} onChangeText={(recipientName) => setForm((prev) => ({ ...prev, recipientName }))} />
              <SummaryPanel
                title={locale === "ar" ? "مراجعة العرض" : "Quote review"}
                subtitle={locale === "ar" ? "ملخص قابل للمشاركة مع العميل." : "A customer-ready summary before saving."}
              >
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedQuoteCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedQuoteVehicleLabel} />
                <SummaryRow label={locale === "ar" ? "النمط" : "Mode"} value={form.mode} />
                <SummaryRow label={locale === "ar" ? "شركة التمويل" : "Finance company"} value={selectedCompanyLabel} />
                <SummaryRow label={locale === "ar" ? "القيمة" : "Price"} value={money(vehiclePricePreview, locale)} />
                <SummaryRow label={locale === "ar" ? "القسط" : "Monthly"} value={money(monthlyPreview, locale)} />
              </SummaryPanel>
            </>
          ) : null}
          <WizardActions
            activeStep={quoteStep}
            backLabel={locale === "ar" ? "السابق" : "Back"}
            nextLabel={locale === "ar" ? "التالي" : "Next"}
            saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ العرض" : "Save quote")}
            saving={saving}
            totalSteps={quoteSteps.length}
            onBack={() => setQuoteStep((step) => Math.max(0, step - 1))}
            onNext={() => setQuoteStep((step) => Math.min(quoteSteps.length - 1, step + 1))}
            onSave={save}
          />
        </GuidedStepFlow>
      </FormModal>
    </>
  );
}

