import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { GuidedStepFlow, type GuidedStep } from "../../../components/GuidedStepFlow";
import { api, type MobileLead, type MobileLeadStage } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, SELECTOR_PAGE_SIZE, type Option, compactNumber, money, maybeText, useGenericError, SearchInput, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, RecordCard, MetricCard, ModuleList, getOptionLabel, DetailPill, SummaryRow, SummaryPanel, WizardActions } from "./moduleShared";
import { styles } from "./moduleStyles";

export function LeadsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createLead = useMutation(api.leads.create);
  const updateLead = useMutation(api.leads.update);
  const deleteLead = useMutation(api.leads.softDelete);
  const [stageFilter, setStageFilter] = useState<MobileLeadStage | "ALL">("ALL");
  const { loadMore, results, status } = usePaginatedQuery(
    api.leads.list,
    stageFilter === "ALL" ? { orgId } : { orgId, stage: stageFilter },
    { initialNumItems: PAGE_SIZE },
  );
  const customers = useQuery(api.customers.list, {
    orgId,
    paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE },
  });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, status: "AVAILABLE", includeReserved: true });
  const members = useQuery(api.memberships.list, {
    orgId,
    paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE },
  });
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [leadStep, setLeadStep] = useState(0);
  const [detailLead, setDetailLead] = useState<MobileLead | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    customerId: "",
    vehicleId: "",
    assignedUserId: "",
    source: "Manual",
    stage: "NEW" as MobileLeadStage,
    notes: "",
  });
  const stageOptions: Array<Option<MobileLeadStage | "ALL">> = [
    { value: "ALL", label: locale === "ar" ? "الكل" : "All" },
    { value: "NEW", label: locale === "ar" ? "جديد" : "New" },
    { value: "CONTACTED", label: locale === "ar" ? "تم التواصل" : "Contacted" },
    { value: "INTERESTED", label: locale === "ar" ? "مهتم" : "Interested" },
    { value: "TEST_DRIVE", label: locale === "ar" ? "تجربة" : "Test drive" },
    { value: "NEGOTIATION", label: locale === "ar" ? "تفاوض" : "Negotiation" },
    { value: "RESERVED", label: locale === "ar" ? "محجوز" : "Reserved" },
    { value: "WON", label: locale === "ar" ? "ناجح" : "Won" },
    { value: "LOST", label: locale === "ar" ? "خاسر" : "Lost" },
  ];
  const filtered = results.filter((lead) => {
    const haystack = `${lead.customerName} ${lead.phone ?? ""} ${lead.vehicleSummary ?? ""} ${lead.source}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });
  const activeLeadCount = filtered.filter((lead) => lead.stage !== "WON" && lead.stage !== "LOST").length;
  const assignedLeadCount = filtered.filter((lead) => Boolean(lead.assignedUserName)).length;
  const vehicleLeadCount = filtered.filter((lead) => Boolean(lead.vehicleSummary)).length;

  const customerOptions = (customers?.page ?? []).map((customer) => ({
    label: `${customer.firstName} ${customer.lastName}`,
    value: customer._id,
  }));
  const vehicleOptions = [
    { label: locale === "ar" ? "بدون سيارة" : "No vehicle", value: "" },
    ...(vehicles ?? []).map((vehicle) => ({
      label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      value: vehicle._id,
    })),
  ];
  const memberOptions = [
    { label: locale === "ar" ? "بدون تعيين" : "Unassigned", value: "" },
    ...(members?.page ?? []).map((member) => ({ label: member.userName, value: member.userId })),
  ];
  const stageSelectOptions = stageOptions
    .filter((option) => option.value !== "ALL")
    .map((option) => ({ label: option.label, value: option.value }));
  const selectedLeadCustomerLabel = getOptionLabel(customerOptions, form.customerId, locale === "ar" ? "لم يتم الاختيار" : "Not selected");
  const selectedLeadVehicleLabel = getOptionLabel(vehicleOptions, form.vehicleId, locale === "ar" ? "بدون سيارة" : "No vehicle");
  const selectedLeadOwnerLabel = getOptionLabel(memberOptions, form.assignedUserId, locale === "ar" ? "بدون تعيين" : "Unassigned");
  const leadSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "العميل والسيارة" : "Customer and vehicle",
      subtitle: locale === "ar" ? "اربط الفرصة بعميل وسيارة اختيارية." : "Attach the opportunity to a customer and optional vehicle.",
    },
    {
      title: locale === "ar" ? "التأهيل" : "Qualification",
      subtitle: locale === "ar" ? "حدد المالك والمصدر والمرحلة الأولى." : "Set owner, source, and first pipeline stage.",
    },
    {
      title: locale === "ar" ? "المراجعة" : "Review",
      subtitle: locale === "ar" ? "راجع السياق قبل الحفظ." : "Confirm the lead context before saving.",
    },
  ];

  function openLeadForm() {
    setLeadStep(0);
    setForm({ customerId: "", vehicleId: "", assignedUserId: "", source: "Manual", stage: "NEW", notes: "" });
    setOpen(true);
  }

  function closeLeadForm() {
    setLeadStep(0);
    setOpen(false);
  }

  async function save() {
    if (!form.customerId) {
      Alert.alert(locale === "ar" ? "اختر عميلاً" : "Choose a customer");
      return;
    }
    setSaving(true);
    try {
      await createLead({
        orgId,
        customerId: form.customerId,
        assignedUserId: maybeText(form.assignedUserId),
        vehicleId: maybeText(form.vehicleId),
        source: form.source || "Manual",
        stage: form.stage,
        notes: maybeText(form.notes),
      });
      closeLeadForm();
      setForm({ customerId: "", vehicleId: "", assignedUserId: "", source: "Manual", stage: "NEW", notes: "" });
    } catch (error) {
      reportError("Mobile lead save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function changeStage(lead: MobileLead, nextStage: MobileLeadStage) {
    try {
      await updateLead({ orgId, leadId: lead._id, stage: nextStage });
    } catch (error) {
      reportError("Mobile lead stage update failed", error);
    }
  }

  async function archive(lead: MobileLead) {
    try {
      await deleteLead({ orgId, leadId: lead._id });
    } catch (error) {
      reportError("Mobile lead archive failed", error);
    }
  }

  return (
    <>
      <ModuleList
        data={filtered}
        emptyLabel={locale === "ar" ? "لا توجد فرص." : "No leads found."}
        keyExtractor={(lead) => lead._id}
        loadMore={loadMore}
        status={status}
        header={
          <>
            <View style={styles.actionRow}>
              <SearchInput placeholder={locale === "ar" ? "بحث العملاء المحتملين" : "Search leads"} value={search} onChangeText={setSearch} />
              <PrimaryButton label={locale === "ar" ? "إضافة" : "Add"} onPress={openLeadForm} />
            </View>
            <SegmentedControl options={stageOptions} value={stageFilter} onChange={setStageFilter} />
            <View style={styles.metricGrid}>
              <MetricCard title={locale === "ar" ? "النتائج" : "Results"} value={compactNumber(filtered.length, locale)} caption={locale === "ar" ? "فرص ظاهرة" : "visible leads"} />
              <MetricCard title={locale === "ar" ? "نشطة" : "Active"} value={compactNumber(activeLeadCount, locale)} caption={locale === "ar" ? "قبل الفوز/الخسارة" : "before won/lost"} />
              <MetricCard title={locale === "ar" ? "مع مسؤول" : "Assigned"} value={compactNumber(assignedLeadCount, locale)} caption={locale === "ar" ? "للمتابعة" : "owned follow-up"} />
              <MetricCard title={locale === "ar" ? "مع سيارة" : "Vehicle"} value={compactNumber(vehicleLeadCount, locale)} caption={locale === "ar" ? "محدد" : "specified"} />
            </View>
          </>
        }
        renderItem={(lead) => (
          <RecordCard>
            <View style={styles.recordHeader}>
              <Text style={styles.recordTitle}>{lead.customerName}</Text>
              <Text style={styles.statusPill}>{lead.stage}</Text>
            </View>
            <View style={styles.detailPillRow}>
              <DetailPill label={lead.source || "Manual"} tone="info" />
              <DetailPill label={lead.assignedUserName || (locale === "ar" ? "بدون مسؤول" : "Unassigned")} tone={lead.assignedUserName ? "success" : "warning"} />
              <DetailPill label={lead.vehicleSummary || (locale === "ar" ? "بدون سيارة" : "No vehicle")} />
            </View>
            <Text style={styles.recordMeta}>{lead.phone || lead.email || "-"}</Text>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailLead(lead)} />
              <PrimaryButton label={locale === "ar" ? "التالي" : "Advance"} tone="muted" onPress={() => changeStage(lead, nextLeadStage(lead.stage))} />
              <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => archive(lead)} />
            </View>
          </RecordCard>
        )}
      />
      <FormModal title={locale === "ar" ? "فرصة جديدة" : "New lead"} visible={open} onClose={closeLeadForm}>
        <GuidedStepFlow activeIndex={leadStep} steps={leadSteps}>
          {leadStep === 0 ? (
            <>
              <SelectField label={locale === "ar" ? "العميل" : "Customer"} value={form.customerId} options={customerOptions} onChange={(customerId) => setForm((prev) => ({ ...prev, customerId }))} />
              <SelectField label={locale === "ar" ? "السيارة" : "Vehicle"} value={form.vehicleId} options={vehicleOptions} onChange={(vehicleId) => setForm((prev) => ({ ...prev, vehicleId }))} />
              <SummaryPanel title={locale === "ar" ? "ربط الفرصة" : "Lead link"}>
                <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedLeadCustomerLabel} />
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedLeadVehicleLabel} />
              </SummaryPanel>
            </>
          ) : null}
          {leadStep === 1 ? (
            <>
              <SelectField label={locale === "ar" ? "المسؤول" : "Assigned to"} value={form.assignedUserId} options={memberOptions} onChange={(assignedUserId) => setForm((prev) => ({ ...prev, assignedUserId }))} />
              <FormField label={locale === "ar" ? "المصدر" : "Source"} value={form.source} onChangeText={(source) => setForm((prev) => ({ ...prev, source }))} />
              <SelectField label={locale === "ar" ? "المرحلة" : "Stage"} value={form.stage} options={stageSelectOptions} onChange={(stage) => setForm((prev) => ({ ...prev, stage: stage as MobileLeadStage }))} />
              <FormField multiline label={locale === "ar" ? "ملاحظات" : "Notes"} value={form.notes} onChangeText={(notes) => setForm((prev) => ({ ...prev, notes }))} />
            </>
          ) : null}
          {leadStep === 2 ? (
            <SummaryPanel
              title={locale === "ar" ? "مراجعة الفرصة" : "Lead review"}
              subtitle={locale === "ar" ? "ستظهر في خط المبيعات بعد الحفظ." : "This will appear in the sales pipeline after saving."}
            >
              <SummaryRow label={locale === "ar" ? "العميل" : "Customer"} value={selectedLeadCustomerLabel} />
              <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={selectedLeadVehicleLabel} />
              <SummaryRow label={locale === "ar" ? "المسؤول" : "Owner"} value={selectedLeadOwnerLabel} />
              <SummaryRow label={locale === "ar" ? "المرحلة" : "Stage"} value={form.stage} />
              <SummaryRow label={locale === "ar" ? "المصدر" : "Source"} value={form.source || "Manual"} />
            </SummaryPanel>
          ) : null}
          <WizardActions
            activeStep={leadStep}
            backLabel={locale === "ar" ? "السابق" : "Back"}
            nextLabel={locale === "ar" ? "التالي" : "Next"}
            saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ الفرصة" : "Save lead")}
            saving={saving}
            totalSteps={leadSteps.length}
            onBack={() => setLeadStep((step) => Math.max(0, step - 1))}
            onNext={() => setLeadStep((step) => Math.min(leadSteps.length - 1, step + 1))}
            onSave={save}
          />
        </GuidedStepFlow>
      </FormModal>
      <FormModal
        title={detailLead ? detailLead.customerName : ""}
        visible={Boolean(detailLead)}
        onClose={() => setDetailLead(null)}
      >
        {detailLead ? (
          <>
            <SummaryPanel
              title={locale === "ar" ? "ملف الفرصة" : "Lead profile"}
              subtitle={locale === "ar" ? "سياق سريع للمتابعة قبل تغيير المرحلة." : "Fast follow-up context before changing stage."}
            >
              <SummaryRow label={locale === "ar" ? "المرحلة" : "Stage"} value={detailLead.stage} />
              <SummaryRow label={locale === "ar" ? "المصدر" : "Source"} value={detailLead.source || "Manual"} />
              <SummaryRow label={locale === "ar" ? "التواصل" : "Contact"} value={detailLead.phone || detailLead.email || "-"} />
              <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={detailLead.vehicleSummary || "-"} />
              <SummaryRow label={locale === "ar" ? "السعر" : "Price"} value={money(detailLead.vehiclePrice, locale)} />
              <SummaryRow label={locale === "ar" ? "المسؤول" : "Owner"} value={detailLead.assignedUserName || "-"} />
              {detailLead.notes ? <SummaryRow label={locale === "ar" ? "ملاحظات" : "Notes"} value={detailLead.notes} /> : null}
            </SummaryPanel>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "التالي" : "Advance"} onPress={() => changeStage(detailLead, nextLeadStage(detailLead.stage))} />
              <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => archive(detailLead)} />
            </View>
          </>
        ) : null}
      </FormModal>
    </>
  );
}

function nextLeadStage(stage: MobileLeadStage): MobileLeadStage {
  const order: MobileLeadStage[] = ["NEW", "CONTACTED", "INTERESTED", "TEST_DRIVE", "NEGOTIATION", "RESERVED", "WON"];
  const index = order.indexOf(stage);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : stage;
}

