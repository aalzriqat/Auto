import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { GuidedStepFlow, type GuidedStep } from "../../../components/GuidedStepFlow";
import { api, type MobileLead, type MobileLeadStage } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { LeadStagePicker } from "./LeadStagePicker";
import {
  LEAD_STAGES,
  commitLeadStageChange,
  leadStageErrorMessage,
  leadStageLabel,
  setPendingLeadStage,
  type PendingLeadStages,
} from "./leadStage";
import { PAGE_SIZE, SELECTOR_PAGE_SIZE, type Option, compactNumber, money, maybeText, useGenericError, SearchInput, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, RecordCard, MetricCard, ModuleList, getOptionLabel, DetailPill, SummaryRow, SummaryPanel, WizardActions } from "./moduleShared";
import { useStyles } from "./moduleStyles";


export function LeadsModule({ highlightId, orgId }: { highlightId?: string; orgId: string }) {
  const styles = useStyles();
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
  // Hold the id, not the row. A stored snapshot goes stale the moment anything
  // about the lead changes, so committing a stage from the detail sheet would
  // roll the picker back to the value the row had when it was opened.
  const [detailLeadId, setDetailLeadId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A lead's entry is removed when its mutation settles either way, so a
  // rejected write can never leave the UI showing a stage the server refused.
  const [pendingStages, setPendingStages] = useState<PendingLeadStages>({});
  const [form, setForm] = useState({
    customerId: "",
    vehicleId: "",
    assignedUserId: "",
    source: "Manual",
    stage: "NEW" as MobileLeadStage,
    notes: "",
  });
  // Filter chips and the stage picker read the same label table, so a stage can
  // never render as its raw enum key (`TEST_DRIVE`) in one place and a
  // translated name in another.
  const stageOptions: Array<Option<MobileLeadStage | "ALL">> = [
    { value: "ALL", label: locale === "ar" ? "الكل" : "All" },
    ...LEAD_STAGES.map((stage) => ({ value: stage, label: leadStageLabel(stage, locale) })),
  ];
  const filtered = (results ?? []).filter((lead) => {
    const haystack = `${lead.customerName} ${lead.phone ?? ""} ${lead.vehicleSummary ?? ""} ${lead.source}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });
  // Resolved against the unfiltered page so typing in the search box cannot
  // blank an open detail sheet.
  const detailLead = (results ?? []).find((lead) => lead._id === detailLeadId) ?? null;
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

  function stageOf(lead: MobileLead): MobileLeadStage {
    return pendingStages[lead._id] ?? lead.stage;
  }

  function isStageBusy(lead: MobileLead): boolean {
    return pendingStages[lead._id] !== undefined;
  }

  async function changeStage(lead: MobileLead, nextStage: MobileLeadStage) {
    await commitLeadStageChange(lead.stage, nextStage, {
      applyStage: (stage) => updateLead({ orgId, leadId: lead._id, stage }),
      setOptimisticStage: (stage) =>
        setPendingStages((current) => setPendingLeadStage(current, lead._id, stage)),
      onError: (error) => {
        console.error("Mobile lead stage update failed", error);
        Alert.alert(
          locale === "ar" ? "تعذر تغيير المرحلة" : "Could not change stage",
          leadStageErrorMessage(
            error,
            locale === "ar"
              ? "حدث خطأ غير متوقع. حاول مرة أخرى."
              : "An unexpected error occurred. Please try again.",
          ),
        );
      },
    });
  }

  async function runArchive(lead: MobileLead) {
    try {
      await deleteLead({ orgId, leadId: lead._id });
      setDetailLeadId((current) => (current === lead._id ? null : current));
    } catch (error) {
      reportError("Mobile lead archive failed", error);
    }
  }

  // Archiving soft-deletes the lead and drops it out of every list. A single
  // stray tap in a scrolling list should not be able to do that silently.
  function archive(lead: MobileLead) {
    Alert.alert(
      locale === "ar" ? "أرشفة هذه الفرصة؟" : "Archive this lead?",
      locale === "ar"
        ? "ستختفي الفرصة من القوائم. يمكن للمسؤول استعادتها لاحقاً."
        : "The lead will disappear from your lists. An admin can restore it later.",
      [
        { style: "cancel", text: locale === "ar" ? "إلغاء" : "Cancel" },
        {
          style: "destructive",
          text: locale === "ar" ? "أرشفة" : "Archive",
          onPress: () => {
            void runArchive(lead);
          },
        },
      ],
    );
  }

  return (
    <>
      <ModuleList
        data={filtered}
        emptyLabel={locale === "ar" ? "لا توجد فرص." : "No leads found."}
        highlightId={highlightId}
        keyExtractor={(lead) => lead._id}
        loadMore={loadMore}
        status={status}
        header={
          <>
            <View style={styles.actionRow}>
              <SearchInput placeholder={locale === "ar" ? "بحث العملاء المحتملين" : "Search leads"} value={search} onChangeText={setSearch} />
              <PrimaryButton label={locale === "ar" ? "إضافة" : "Add"} onPress={openLeadForm} />
            </View>
            <SegmentedControl
              options={stageOptions}
              value={stageFilter}
              onChange={(nextFilter) => {
                // The detail sheet is keyed off an id resolved against the
                // current page. Without this, a lead that left the filtered
                // query (say, by being moved to WON) would silently re-open its
                // sheet as soon as the filter widened enough to return it.
                setDetailLeadId(null);
                setStageFilter(nextFilter);
              }}
            />
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
              {/* The status *is* the control: tapping the stage opens the whole
                  pipeline, so any move is one interaction from the list. */}
              <LeadStagePicker
                compact
                busy={isStageBusy(lead)}
                stage={stageOf(lead)}
                testID={`lead-stage-${lead._id}`}
                onSelect={(nextStage) => {
                  void changeStage(lead, nextStage);
                }}
              />
            </View>
            <View style={styles.detailPillRow}>
              <DetailPill label={lead.source || "Manual"} tone="info" />
              <DetailPill label={lead.assignedUserName || (locale === "ar" ? "بدون مسؤول" : "Unassigned")} tone={lead.assignedUserName ? "success" : "warning"} />
              <DetailPill label={lead.vehicleSummary || (locale === "ar" ? "بدون سيارة" : "No vehicle")} />
            </View>
            <Text style={styles.recordMeta}>{lead.phone || lead.email || "-"}</Text>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailLeadId(lead._id)} />
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
              <SummaryRow label={locale === "ar" ? "المرحلة" : "Stage"} value={leadStageLabel(form.stage, locale)} />
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
        onClose={() => setDetailLeadId(null)}
      >
        {detailLead ? (
          <>
            <SummaryPanel
              title={locale === "ar" ? "ملف الفرصة" : "Lead profile"}
              subtitle={locale === "ar" ? "سياق سريع للمتابعة قبل تغيير المرحلة." : "Fast follow-up context before changing stage."}
            >
              <SummaryRow label={locale === "ar" ? "المصدر" : "Source"} value={detailLead.source || "Manual"} />
              <SummaryRow label={locale === "ar" ? "التواصل" : "Contact"} value={detailLead.phone || detailLead.email || "-"} />
              <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={detailLead.vehicleSummary || "-"} />
              <SummaryRow label={locale === "ar" ? "السعر" : "Price"} value={money(detailLead.vehiclePrice, locale)} />
              <SummaryRow label={locale === "ar" ? "المسؤول" : "Owner"} value={detailLead.assignedUserName || "-"} />
              {detailLead.notes ? <SummaryRow label={locale === "ar" ? "ملاحظات" : "Notes"} value={detailLead.notes} /> : null}
            </SummaryPanel>
            <LeadStagePicker
              busy={isStageBusy(detailLead)}
              stage={stageOf(detailLead)}
              testID="lead-detail-stage"
              onSelect={(nextStage) => {
                void changeStage(detailLead, nextStage);
              }}
            />
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => archive(detailLead)} />
            </View>
          </>
        ) : null}
      </FormModal>
    </>
  );
}

