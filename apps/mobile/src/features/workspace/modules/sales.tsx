import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { GuidedStepFlow, type GuidedStep } from "../../../components/GuidedStepFlow";
import { api, type MobileFinancingType, type MobileMyMembership, type MobileSale } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, SELECTOR_PAGE_SIZE, type Option, type MobileSaleStatusFilter, compactNumber, money, dateLabel, parseOptionalNumber, parseRequiredNumber, idempotencyKey, useGenericError, SearchInput, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, RecordCard, MetricCard, ModuleList, getOptionLabel, saleMatchesView, averageSalePrice, saleRemainingBalance, vehicleListPriceLabel, DetailPill, SummaryRow, SummaryPanel, WizardActions } from "./moduleShared";
import { styles } from "./moduleStyles";

export function SalesModule({
  highlightId,
  myMembership,
  orgId,
}: {
  highlightId?: string;
  myMembership: MobileMyMembership;
  orgId: string;
}) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createDraft = useMutation(api.sales.createDraft);
  const completeDraft = useMutation(api.sales.completeDraft);
  const updateSale = useMutation(api.sales.update);
  const { loadMore, results, status } = usePaginatedQuery(api.sales.list, { orgId }, { initialNumItems: PAGE_SIZE });
  const customers = useQuery(api.customers.list, { orgId, paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE } });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, status: "AVAILABLE", includeReserved: true });
  const members = useQuery(api.memberships.list, { orgId, paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE } });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<MobileSaleStatusFilter>("ALL");
  const [open, setOpen] = useState(false);
  const [draftStep, setDraftStep] = useState(0);
  const [detailSale, setDetailSale] = useState<MobileSale | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    customerId: "",
    vehicleId: "",
    salespersonId: myMembership.userId,
    salePrice: "",
    downPayment: "",
    financingType: "CASH" as MobileFinancingType,
  });
  const statusOptions: Array<Option<MobileSaleStatusFilter>> = [
    { value: "ALL", label: locale === "ar" ? "الكل" : "All" },
    { value: "PENDING", label: locale === "ar" ? "معلقة" : "Pending" },
    { value: "COMPLETED", label: locale === "ar" ? "مكتملة" : "Completed" },
    { value: "CANCELLED", label: locale === "ar" ? "ملغاة" : "Cancelled" },
  ];
  const customerOptions = (customers?.page ?? []).map((customer) => ({
    label: `${customer.firstName} ${customer.lastName}`,
    subLabel: customer.phone || customer.whatsapp || customer.email || customer.address,
    value: customer._id,
  }));
  const vehicleOptions = (vehicles ?? []).map((vehicle) => ({
    label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
    subLabel: `${vehicleListPriceLabel(vehicle.sellingPrice, locale)} · ${vehicle.trim || vehicle.status}`,
    value: vehicle._id,
  }));
  const memberOptions = (members?.page ?? []).map((member) => ({
    label: member.userName,
    subLabel: member.roleName,
    value: member.userId,
  }));
  const selectedVehicle = (vehicles ?? []).find((vehicle) => vehicle._id === form.vehicleId) ?? null;
  const selectedCustomerLabel = getOptionLabel(customerOptions, form.customerId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedVehicleLabel = getOptionLabel(vehicleOptions, form.vehicleId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedSalespersonLabel = getOptionLabel(memberOptions, form.salespersonId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const salePricePreview = parseOptionalNumber(form.salePrice) ?? 0;
  const downPaymentPreview = parseOptionalNumber(form.downPayment) ?? 0;
  const remainingBalancePreview = Math.max(0, salePricePreview - downPaymentPreview);
  const filteredSales = results.filter((sale) => saleMatchesView(sale, statusFilter, search));
  const pendingSalesCount = results.filter((sale) => sale.status === "PENDING").length;
  const completedSalesCount = results.filter((sale) => sale.status === "COMPLETED").length;
  const averageVisibleDeal = averageSalePrice(filteredSales);
  const salesSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "العميل والسيارة" : "Customer and vehicle",
      subtitle: locale === "ar" ? "اختر من القوائم القابلة للبحث." : "Search and pick the exact deal participants.",
    },
    {
      title: locale === "ar" ? "السعر والتمويل" : "Price and financing",
      subtitle: locale === "ar" ? "حدد السعر، الدفعة، وطريقة التمويل." : "Set price, deposit, and finance mode.",
    },
    {
      title: locale === "ar" ? "المراجعة" : "Review",
      subtitle: locale === "ar" ? "راجع الملخص قبل إنشاء المسودة." : "Confirm the draft before it enters the pipeline.",
    },
  ];

  function openDraft() {
    setDraftStep(0);
    setForm({
      customerId: "",
      vehicleId: "",
      salespersonId: myMembership.userId,
      salePrice: "",
      downPayment: "",
      financingType: "CASH",
    });
    setOpen(true);
  }

  function closeDraft() {
    setDraftStep(0);
    setOpen(false);
  }

  function selectVehicle(vehicleId: string) {
    const vehicle = (vehicles ?? []).find((candidate) => candidate._id === vehicleId);
    setForm((prev) => ({
      ...prev,
      vehicleId,
      salePrice: vehicle?.sellingPrice != null ? String(vehicle.sellingPrice) : prev.salePrice,
    }));
  }

  function applyVehiclePrice() {
    if (selectedVehicle?.sellingPrice == null) return;
    setForm((prev) => ({ ...prev, salePrice: String(selectedVehicle.sellingPrice) }));
  }

  function applySuggestedDeposit(percent: number) {
    const deposit = Math.round((salePricePreview * percent) / 100);
    setForm((prev) => ({ ...prev, downPayment: String(deposit) }));
  }

  async function saveDraft() {
    const salePrice = parseRequiredNumber(form.salePrice);
    if (!form.customerId || !form.vehicleId || !form.salespersonId || salePrice === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      await createDraft({
        orgId,
        customerId: form.customerId,
        vehicleId: form.vehicleId,
        salespersonId: form.salespersonId,
        salePrice,
        saleDate: Date.now(),
        status: "PENDING",
        financingType: form.financingType,
        downPayment: parseOptionalNumber(form.downPayment),
        idempotencyKey: idempotencyKey("sales.createDraft"),
      });
      closeDraft();
      setForm({ customerId: "", vehicleId: "", salespersonId: myMembership.userId, salePrice: "", downPayment: "", financingType: "CASH" });
    } catch (error) {
      reportError("Mobile sale draft save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function complete(sale: MobileSale) {
    try {
      await completeDraft({ orgId, saleId: sale._id, idempotencyKey: idempotencyKey("sales.completeDraft") });
    } catch (error) {
      reportError("Mobile sale complete failed", error);
    }
  }

  async function cancel(sale: MobileSale) {
    try {
      await updateSale({ orgId, saleId: sale._id, status: "CANCELLED" });
    } catch (error) {
      reportError("Mobile sale cancel failed", error);
    }
  }

  return (
    <>
      <ModuleList
        data={filteredSales}
        emptyLabel={locale === "ar" ? "لا توجد مبيعات لهذا الفلتر." : "No sales match this view."}
        highlightId={highlightId}
        keyExtractor={(sale) => sale._id}
        loadMore={loadMore}
        status={status}
        header={
          <>
            <View style={styles.actionRow}>
              <SearchInput
                placeholder={locale === "ar" ? "بحث المبيعات" : "Search sales"}
                value={search}
                onChangeText={setSearch}
              />
              <PrimaryButton label={locale === "ar" ? "مسودة" : "Draft"} onPress={openDraft} />
            </View>
            <SegmentedControl options={statusOptions} value={statusFilter} onChange={setStatusFilter} />
            <View style={styles.metricGrid}>
              <MetricCard title={locale === "ar" ? "ظاهرة" : "Visible"} value={compactNumber(filteredSales.length, locale)} caption={locale === "ar" ? "حسب الفلتر" : "after filters"} />
              <MetricCard title={locale === "ar" ? "معلقة" : "Pending"} value={compactNumber(pendingSalesCount, locale)} caption={locale === "ar" ? "تحتاج إجراء" : "need action"} />
              <MetricCard title={locale === "ar" ? "مكتملة" : "Closed"} value={compactNumber(completedSalesCount, locale)} caption={locale === "ar" ? "صفقات منتهية" : "completed deals"} />
              <MetricCard title={locale === "ar" ? "متوسط" : "Avg deal"} value={money(averageVisibleDeal, locale)} caption={locale === "ar" ? "للقائمة الحالية" : "visible list"} />
            </View>
          </>
        }
        renderItem={(sale) => (
          <RecordCard>
            <View style={styles.recordHeader}>
              <Text style={styles.recordTitle}>{sale.vehicleSummary}</Text>
              <Text style={styles.statusPill}>{sale.status}</Text>
            </View>
            <Text style={styles.recordMeta}>{sale.customerName} · {sale.salespersonName}</Text>
            <View style={styles.detailPillRow}>
              <DetailPill label={money(sale.salePrice, locale)} tone="success" />
              <DetailPill label={sale.financingType ?? "CASH"} tone="info" />
              <DetailPill label={dateLabel(sale.saleDate, locale)} />
            </View>
            {sale.downPayment != null ? (
              <Text style={styles.recordMeta}>{locale === "ar" ? "الدفعة" : "Down payment"}: {money(sale.downPayment, locale)}</Text>
            ) : null}
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailSale(sale)} />
              {sale.status === "PENDING" ? <PrimaryButton label={locale === "ar" ? "إتمام" : "Complete"} tone="muted" onPress={() => complete(sale)} /> : null}
              {sale.status !== "CANCELLED" ? <PrimaryButton label={locale === "ar" ? "إلغاء" : "Cancel"} tone="danger" onPress={() => cancel(sale)} /> : null}
            </View>
          </RecordCard>
        )}
      />
      <FormModal title={locale === "ar" ? "مسودة بيع" : "Sale draft"} visible={open} onClose={closeDraft}>
        <GuidedStepFlow activeIndex={draftStep} steps={salesSteps}>
          {draftStep === 0 ? (
            <>
              <SelectField label={locale === "ar" ? "العميل" : "Customer"} value={form.customerId} options={customerOptions} onChange={(customerId) => setForm((prev) => ({ ...prev, customerId }))} />
              <SelectField label={locale === "ar" ? "السيارة" : "Vehicle"} value={form.vehicleId} options={vehicleOptions} onChange={selectVehicle} />
              <SummaryPanel
                title={locale === "ar" ? "اختيار الصفقة" : "Deal selection"}
                subtitle={locale === "ar" ? "اختيار السيارة يعبئ سعر القائمة تلقائياً." : "Picking a vehicle auto-fills its current list price."}
              >
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedVehicleLabel} />
                {selectedVehicle ? (
                  <>
                    <SummaryRow label={locale === "ar" ? "السعر الحالي" : "List price"} value={vehicleListPriceLabel(selectedVehicle.sellingPrice, locale)} />
                    <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={selectedVehicle.status} />
                  </>
                ) : null}
              </SummaryPanel>
            </>
          ) : null}
          {draftStep === 1 ? (
            <>
              <FormField keyboardType="numeric" label={locale === "ar" ? "سعر البيع" : "Sale price"} value={form.salePrice} onChangeText={(salePrice) => setForm((prev) => ({ ...prev, salePrice }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "الدفعة" : "Down payment"} value={form.downPayment} onChangeText={(downPayment) => setForm((prev) => ({ ...prev, downPayment }))} />
              <SummaryPanel
                title={locale === "ar" ? "مساعد التسعير" : "Pricing assist"}
                subtitle={locale === "ar" ? "اختصارات سريعة بدلاً من إدخال كل شيء يدوياً." : "Fast pricing actions instead of manual entry for every deal."}
              >
                <SummaryRow label={locale === "ar" ? "المركبة" : "Vehicle"} value={selectedVehicleLabel} />
                <SummaryRow label={locale === "ar" ? "الرصيد بعد الدفعة" : "Balance after deposit"} value={money(remainingBalancePreview, locale)} />
                <View style={styles.cardActions}>
                  <PrimaryButton
                    disabled={!selectedVehicle}
                    label={locale === "ar" ? "سعر القائمة" : "Use list price"}
                    tone="muted"
                    onPress={applyVehiclePrice}
                  />
                  <PrimaryButton
                    disabled={salePricePreview <= 0}
                    label={locale === "ar" ? "دفعة 10%" : "10% down"}
                    tone="muted"
                    onPress={() => applySuggestedDeposit(10)}
                  />
                  <PrimaryButton
                    disabled={salePricePreview <= 0}
                    label={locale === "ar" ? "دفعة 20%" : "20% down"}
                    tone="muted"
                    onPress={() => applySuggestedDeposit(20)}
                  />
                </View>
              </SummaryPanel>
              <SelectField label={locale === "ar" ? "طريقة التمويل" : "Financing"} value={form.financingType} options={[
                { label: locale === "ar" ? "نقدا" : "Cash", value: "CASH" },
                { label: locale === "ar" ? "تمويل" : "Financed", value: "FINANCED" },
                { label: locale === "ar" ? "تأجير" : "Lease", value: "LEASE" },
              ]} onChange={(financingType) => setForm((prev) => ({ ...prev, financingType: financingType as MobileFinancingType }))} />
              <View style={styles.metricGrid}>
                <MetricCard title={locale === "ar" ? "السعر" : "Price"} value={money(salePricePreview, locale)} caption={locale === "ar" ? "سعر البيع" : "sale price"} />
                <MetricCard title={locale === "ar" ? "المتبقي" : "Balance"} value={money(remainingBalancePreview, locale)} caption={locale === "ar" ? "بعد الدفعة" : "after deposit"} />
              </View>
            </>
          ) : null}
          {draftStep === 2 ? (
            <>
              <SelectField label={locale === "ar" ? "البائع" : "Salesperson"} value={form.salespersonId} options={memberOptions} onChange={(salespersonId) => setForm((prev) => ({ ...prev, salespersonId }))} />
              <SummaryPanel
                title={locale === "ar" ? "مراجعة المسودة" : "Draft review"}
                subtitle={locale === "ar" ? "ستظهر كصفقة معلقة بعد الحفظ." : "This will enter sales as a pending deal."}
              >
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedVehicleLabel} />
                <SummaryRow label={locale === "ar" ? "البائع" : "Salesperson"} value={selectedSalespersonLabel} />
                <SummaryRow label={locale === "ar" ? "السعر" : "Price"} value={money(salePricePreview, locale)} />
                <SummaryRow label={locale === "ar" ? "طريقة التمويل" : "Financing"} value={form.financingType} />
              </SummaryPanel>
            </>
          ) : null}
          <WizardActions
            activeStep={draftStep}
            backLabel={locale === "ar" ? "السابق" : "Back"}
            nextLabel={locale === "ar" ? "التالي" : "Next"}
            saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ المسودة" : "Save draft")}
            saving={saving}
            totalSteps={salesSteps.length}
            onBack={() => setDraftStep((step) => Math.max(0, step - 1))}
            onNext={() => setDraftStep((step) => Math.min(salesSteps.length - 1, step + 1))}
            onSave={saveDraft}
          />
        </GuidedStepFlow>
      </FormModal>
      <FormModal
        title={detailSale ? detailSale.vehicleSummary : ""}
        visible={Boolean(detailSale)}
        onClose={() => setDetailSale(null)}
      >
        {detailSale ? (
          <>
            <View style={styles.metricGrid}>
              <MetricCard title={locale === "ar" ? "السعر" : "Sale price"} value={money(detailSale.salePrice, locale)} caption={detailSale.financingType ?? "CASH"} />
              <MetricCard title={locale === "ar" ? "الدفعة" : "Deposit"} value={money(detailSale.downPayment, locale)} caption={locale === "ar" ? "مدفوعة مقدماً" : "up front"} />
              <MetricCard title={locale === "ar" ? "الرصيد" : "Balance"} value={money(saleRemainingBalance(detailSale), locale)} caption={locale === "ar" ? "بعد الدفعة" : "after deposit"} />
              <MetricCard title={locale === "ar" ? "العمولة" : "Commission"} value={money(detailSale.commissionAmount, locale)} caption={detailSale.commissionPaidAt ? dateLabel(detailSale.commissionPaidAt, locale) : (locale === "ar" ? "غير مدفوعة" : "unpaid")} />
            </View>
            <SummaryPanel
              title={locale === "ar" ? "ملخص الصفقة" : "Deal summary"}
              subtitle={locale === "ar" ? "تفاصيل سريعة قبل تغيير الحالة." : "Fast context before changing the status."}
            >
              <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={detailSale.status} />
              <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={detailSale.customerName} />
              <SummaryRow label={locale === "ar" ? "البائع" : "Salesperson"} value={detailSale.salespersonName} />
              <SummaryRow label="VIN" value={detailSale.vehicleVin} />
              <SummaryRow label={locale === "ar" ? "التاريخ" : "Date"} value={dateLabel(detailSale.saleDate, locale)} />
            </SummaryPanel>
            <View style={styles.cardActions}>
              {detailSale.status === "PENDING" ? (
                <PrimaryButton
                  label={locale === "ar" ? "إتمام البيع" : "Complete sale"}
                  onPress={() => {
                    complete(detailSale);
                    setDetailSale(null);
                  }}
                />
              ) : null}
              {detailSale.status !== "CANCELLED" ? (
                <PrimaryButton
                  label={locale === "ar" ? "إلغاء البيع" : "Cancel sale"}
                  tone="danger"
                  onPress={() => {
                    cancel(detailSale);
                    setDetailSale(null);
                  }}
                />
              ) : null}
            </View>
          </>
        ) : null}
      </FormModal>
    </>
  );
}

