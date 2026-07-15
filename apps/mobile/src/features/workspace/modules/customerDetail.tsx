import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { api, type MobileCustomer } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import {
  Chip,
  DetailPill,
  FormField,
  FormModal,
  PrimaryButton,
  SummaryPanel,
  SummaryRow,
  dateLabel,
  money,
  parseOptionalNumber,
  useGenericError,
} from "./moduleShared";
import { styles } from "./moduleStyles";

const PERMISSION = {
  editCustomers: "edit:customers",
} as const;

type DetailTab = "overview" | "activity" | "quotes" | "tasks" | "financials";

function calculateDBR(salary: number, existingDebt: number, proposedInstallment: number): number {
  if (salary <= 0) return 0;
  return ((existingDebt + proposedInstallment) / salary) * 100;
}

export function CustomerDetailSheet({
  customer,
  onArchive,
  onClose,
  onEdit,
  orgId,
  permissions,
}: {
  customer: MobileCustomer | null;
  onArchive: (customer: MobileCustomer) => void;
  onClose: () => void;
  onEdit: (customer: MobileCustomer) => void;
  orgId: string;
  permissions: readonly string[];
}) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const canEdit = permissions.includes(PERMISSION.editCustomers);

  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: "overview", label: locale === "ar" ? "نظرة عامة" : "Overview" },
    { id: "activity", label: locale === "ar" ? "الفرص والمبيعات" : "Leads & Sales" },
    { id: "quotes", label: locale === "ar" ? "العروض" : "Quotes" },
    { id: "tasks", label: locale === "ar" ? "المهام" : "Tasks" },
    { id: "financials", label: locale === "ar" ? "الماليات" : "Financials" },
  ];

  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const customerId = customer?._id ?? null;

  useEffect(() => {
    setActiveTab("overview");
  }, [customerId]);

  const scopedArgs = customerId ? { orgId, customerId } : null;
  const relations = useQuery(api.customers.getRelations, scopedArgs ?? "skip");
  const guarantors = useQuery(
    api.guarantors.listByCustomer,
    scopedArgs && activeTab === "financials" ? scopedArgs : "skip",
  );

  const updateCustomer = useMutation(api.customers.update);
  const createApplication = useMutation(api.applications.createFromQuote);
  const addGuarantor = useMutation(api.guarantors.add);
  const updateGuarantor = useMutation(api.guarantors.update);
  const removeGuarantor = useMutation(api.guarantors.remove);

  const [editingFinancials, setEditingFinancials] = useState(false);
  const [savingFinancials, setSavingFinancials] = useState(false);
  const [financialsForm, setFinancialsForm] = useState({
    employer: "",
    jobTitle: "",
    salary: "",
    totalMonthlyDebt: "",
  });
  const [guarantorFormOpen, setGuarantorFormOpen] = useState(false);
  const [editingGuarantorId, setEditingGuarantorId] = useState<string | null>(null);
  const [savingGuarantor, setSavingGuarantor] = useState(false);
  const [guarantorForm, setGuarantorForm] = useState({
    firstName: "",
    lastName: "",
    nationalId: "",
    phone: "",
    relationship: "",
    income: "",
  });

  useEffect(() => {
    if (!customer) return;
    setEditingFinancials(false);
    setFinancialsForm({
      employer: customer.employment?.employer ?? "",
      jobTitle: customer.employment?.title ?? "",
      salary: customer.employment?.salary !== undefined ? String(customer.employment.salary) : "",
      totalMonthlyDebt:
        customer.financials?.totalMonthlyDebt !== undefined ? String(customer.financials.totalMonthlyDebt) : "",
    });
  }, [customerId]);

  function closeGuarantorForm() {
    setGuarantorFormOpen(false);
    setEditingGuarantorId(null);
    setGuarantorForm({ firstName: "", lastName: "", nationalId: "", phone: "", relationship: "", income: "" });
  }

  function openAddGuarantor() {
    setEditingGuarantorId(null);
    setGuarantorForm({ firstName: "", lastName: "", nationalId: "", phone: "", relationship: "", income: "" });
    setGuarantorFormOpen(true);
  }

  function openEditGuarantor(guarantorId: string) {
    const guarantor = (guarantors ?? []).find((item) => item._id === guarantorId);
    if (!guarantor) return;
    setEditingGuarantorId(guarantorId);
    setGuarantorForm({
      firstName: guarantor.firstName,
      lastName: guarantor.lastName,
      nationalId: guarantor.nationalId,
      phone: guarantor.phone,
      relationship: guarantor.relationship ?? "",
      income: guarantor.income !== undefined ? String(guarantor.income) : "",
    });
    setGuarantorFormOpen(true);
  }

  async function saveFinancials() {
    if (!customerId) return;
    const salary = parseOptionalNumber(financialsForm.salary) ?? 0;
    const totalMonthlyDebt = parseOptionalNumber(financialsForm.totalMonthlyDebt) ?? 0;
    const dbr = calculateDBR(salary, totalMonthlyDebt, 0);
    setSavingFinancials(true);
    try {
      await updateCustomer({
        orgId,
        customerId,
        employment: {
          employer: financialsForm.employer,
          title: financialsForm.jobTitle || undefined,
          salary,
        },
        financials: { totalMonthlyDebt, dbr },
      });
      setEditingFinancials(false);
    } catch (error) {
      reportError("Mobile customer financials save failed", error);
    } finally {
      setSavingFinancials(false);
    }
  }

  async function saveGuarantor() {
    if (!customerId) return;
    if (!guarantorForm.firstName.trim() || !guarantorForm.lastName.trim() || !guarantorForm.nationalId.trim() || !guarantorForm.phone.trim()) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSavingGuarantor(true);
    try {
      const payload = {
        firstName: guarantorForm.firstName.trim(),
        lastName: guarantorForm.lastName.trim(),
        nationalId: guarantorForm.nationalId.trim(),
        phone: guarantorForm.phone.trim(),
        relationship: guarantorForm.relationship.trim() || undefined,
        income: parseOptionalNumber(guarantorForm.income),
      };
      if (editingGuarantorId) {
        await updateGuarantor({ orgId, guarantorId: editingGuarantorId, ...payload });
      } else {
        await addGuarantor({ orgId, customerId, ...payload });
      }
      closeGuarantorForm();
    } catch (error) {
      reportError("Mobile guarantor save failed", error);
    } finally {
      setSavingGuarantor(false);
    }
  }

  function confirmRemoveGuarantor(guarantorId: string) {
    Alert.alert(
      locale === "ar" ? "إزالة الضامن؟" : "Remove guarantor?",
      "",
      [
        { text: locale === "ar" ? "إلغاء" : "Cancel", style: "cancel" },
        {
          text: locale === "ar" ? "إزالة" : "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await removeGuarantor({ orgId, guarantorId });
            } catch (error) {
              reportError("Mobile guarantor remove failed", error);
            }
          },
        },
      ],
    );
  }

  async function submitApplication(quoteId: string) {
    try {
      await createApplication({ orgId, quoteId });
      Alert.alert(locale === "ar" ? "تم إنشاء طلب التمويل." : "Finance application created.");
    } catch (error) {
      reportError("Mobile application create failed", error);
    }
  }

  if (!customer) {
    return null;
  }

  const loadingLabel = locale === "ar" ? "جاري التحميل..." : "Loading...";
  const dbr = customer.financials?.dbr;

  return (
    <>
    <FormModal title={`${customer.firstName} ${customer.lastName}`} visible onClose={onClose}>
      {canEdit ? (
        <View style={styles.cardActions}>
          <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} onPress={() => onEdit(customer)} />
          <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => onArchive(customer)} />
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.detailTabStrip}>
        {tabs.map((tab) => (
          <Chip
            key={tab.id}
            label={tab.label}
            selected={tab.id === activeTab}
            value={tab.id}
            onPress={() => setActiveTab(tab.id)}
          />
        ))}
      </ScrollView>

      {activeTab === "overview" ? (
        <SummaryPanel
          title={locale === "ar" ? "ملف العميل" : "Customer profile"}
          subtitle={locale === "ar" ? "معلومات التواصل الكاملة." : "Full contact context."}
        >
          <SummaryRow label={locale === "ar" ? "الهاتف" : "Phone"} value={customer.phone || "-"} />
          <SummaryRow label="WhatsApp" value={customer.whatsapp || "-"} />
          <SummaryRow label={locale === "ar" ? "البريد" : "Email"} value={customer.email || "-"} />
          <SummaryRow label={locale === "ar" ? "الرقم الوطني" : "National ID"} value={customer.nationalId || "-"} />
          <SummaryRow label={locale === "ar" ? "العنوان" : "Address"} value={customer.address || "-"} />
          {customer.source ? <SummaryRow label={locale === "ar" ? "المصدر" : "Source"} value={customer.source} /> : null}
        </SummaryPanel>
      ) : null}

      {activeTab === "activity" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "المشتريات السابقة" : "Past purchases"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : relations.sales.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد مبيعات لهذا العميل." : "No sales recorded for this customer."}</Text>
          ) : (
            relations.sales.map((sale) => (
              <View key={sale._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{sale.vehicleDesc}</Text>
                  <DetailPill label={sale.status} tone={sale.status === "COMPLETED" ? "success" : sale.status === "CANCELLED" ? "warning" : "info"} />
                </View>
                <Text style={styles.recordMeta}>
                  {dateLabel(sale.saleDate, locale)} · {money(sale.salePrice, locale)} · {sale.salespersonName}
                </Text>
              </View>
            ))
          )}
          <Text style={styles.sectionTitle}>{locale === "ar" ? "الفرص الحالية والسابقة" : "Active/past leads"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : relations.leads.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد فرص لهذا العميل." : "No leads recorded for this customer."}</Text>
          ) : (
            relations.leads.map((lead) => (
              <View key={lead._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{lead.vehicleDesc}</Text>
                  <DetailPill label={lead.stage} tone="info" />
                </View>
                <Text style={styles.recordMeta}>
                  {(locale === "ar" ? "المصدر: " : "Source: ") + lead.source} · {lead.assignedUserName}
                </Text>
                {lead.notes ? <Text style={styles.recordMeta}>{lead.notes}</Text> : null}
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "quotes" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "العروض المُنشأة" : "Generated quotes"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : !relations.quotes || relations.quotes.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد عروض لهذا العميل." : "No quotes generated for this customer."}</Text>
          ) : (
            relations.quotes.map((quote) => (
              <View key={quote._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <View>
                    <Text style={styles.detailAmountText}>{quote.vehicleDesc}</Text>
                    <Text style={styles.recordMeta}>{quote.companyName}</Text>
                  </View>
                  <DetailPill
                    label={quote.status}
                    tone={quote.status === "ACCEPTED" ? "success" : quote.status === "EXPIRED" ? "warning" : "info"}
                  />
                </View>
                <Text style={styles.recordMeta}>
                  {locale === "ar" ? "سعر السيارة" : "Vehicle price"}: {money(quote.vehiclePrice, locale)}
                </Text>
                {quote.companyId ? (
                  <Text style={styles.recordMeta}>
                    {locale === "ar" ? "القسط الشهري" : "Monthly installment"}: {money(quote.monthlyInstallment, locale)} · {quote.termMonths}{" "}
                    {locale === "ar" ? "شهر" : "months"}
                  </Text>
                ) : null}
                <Text style={styles.recordMeta}>{dateLabel(quote.createdAt, locale)} · {quote.createdByUserName}</Text>
                <View style={styles.cardActions}>
                  <PrimaryButton
                    label={locale === "ar" ? "إرسال طلب تمويل" : "Submit application"}
                    tone="muted"
                    onPress={() => void submitApplication(quote._id)}
                  />
                </View>
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "tasks" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "المهام والتواصل المرتبط" : "Associated tasks & communication"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : relations.tasks.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد مهام لهذا العميل." : "No tasks assigned for this customer."}</Text>
          ) : (
            relations.tasks.map((task) => (
              <View key={task._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{task.title}</Text>
                  <DetailPill
                    label={task.status}
                    tone={task.status === "COMPLETED" ? "success" : task.status === "CANCELLED" ? "warning" : "info"}
                  />
                </View>
                <Text style={styles.recordMeta}>
                  {(locale === "ar" ? "الاستحقاق: " : "Due: ") + dateLabel(task.dueDate, locale)} · {task.assignedUserName}
                </Text>
                {task.description ? <Text style={styles.recordMeta}>{task.description}</Text> : null}
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "financials" ? (
        <View style={styles.detailSection}>
          <View style={styles.detailRowSplit}>
            <Text style={styles.sectionTitle}>{locale === "ar" ? "الماليات والتوظيف" : "Financials & employment"}</Text>
            {canEdit ? (
              <PrimaryButton
                label={editingFinancials ? (locale === "ar" ? "إلغاء" : "Cancel") : (locale === "ar" ? "تعديل" : "Edit")}
                tone="muted"
                onPress={() => setEditingFinancials((value) => !value)}
              />
            ) : null}
          </View>
          {editingFinancials ? (
            <>
              <FormField
                label={locale === "ar" ? "جهة العمل" : "Employer"}
                value={financialsForm.employer}
                onChangeText={(employer) => setFinancialsForm((prev) => ({ ...prev, employer }))}
              />
              <FormField
                label={locale === "ar" ? "المسمى الوظيفي" : "Job title"}
                value={financialsForm.jobTitle}
                onChangeText={(jobTitle) => setFinancialsForm((prev) => ({ ...prev, jobTitle }))}
              />
              <FormField
                keyboardType="numeric"
                label={locale === "ar" ? "الراتب" : "Salary"}
                value={financialsForm.salary}
                onChangeText={(salary) => setFinancialsForm((prev) => ({ ...prev, salary }))}
              />
              <FormField
                keyboardType="numeric"
                label={locale === "ar" ? "إجمالي الديون الشهرية" : "Total monthly debt"}
                value={financialsForm.totalMonthlyDebt}
                onChangeText={(totalMonthlyDebt) => setFinancialsForm((prev) => ({ ...prev, totalMonthlyDebt }))}
              />
              <PrimaryButton
                disabled={savingFinancials}
                label={savingFinancials ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")}
                onPress={saveFinancials}
              />
            </>
          ) : (
            <SummaryPanel title={locale === "ar" ? "الملخص" : "Summary"}>
              <SummaryRow label={locale === "ar" ? "جهة العمل" : "Employer"} value={customer.employment?.employer || "-"} />
              <SummaryRow label={locale === "ar" ? "المسمى الوظيفي" : "Job title"} value={customer.employment?.title || "-"} />
              <SummaryRow label={locale === "ar" ? "الراتب" : "Salary"} value={money(customer.employment?.salary, locale)} />
              <SummaryRow
                label={locale === "ar" ? "إجمالي الديون الشهرية" : "Total monthly debt"}
                value={money(customer.financials?.totalMonthlyDebt, locale)}
              />
              {dbr !== undefined ? (
                <SummaryRow label="DBR" value={`${dbr.toFixed(1)}%`} />
              ) : null}
            </SummaryPanel>
          )}

          <View style={styles.detailRowSplit}>
            <Text style={styles.sectionTitle}>{locale === "ar" ? "الضامنون" : "Guarantors"}</Text>
            {canEdit ? (
              <PrimaryButton label={locale === "ar" ? "إضافة ضامن" : "Add guarantor"} tone="muted" onPress={openAddGuarantor} />
            ) : null}
          </View>
          {guarantors === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : guarantors.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا يوجد ضامنون." : "No guarantors."}</Text>
          ) : (
            guarantors.map((guarantor) => (
              <View key={guarantor._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{guarantor.firstName} {guarantor.lastName}</Text>
                  {guarantor.relationship ? <DetailPill label={guarantor.relationship} /> : null}
                </View>
                <Text style={styles.recordMeta}>
                  {(locale === "ar" ? "الهوية: " : "ID: ") + guarantor.nationalId} · {guarantor.phone}
                </Text>
                {guarantor.income !== undefined ? (
                  <Text style={styles.recordMeta}>{(locale === "ar" ? "الدخل: " : "Income: ") + money(guarantor.income, locale)}</Text>
                ) : null}
                {canEdit ? (
                  <View style={styles.cardActions}>
                    <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEditGuarantor(guarantor._id)} />
                    <PrimaryButton label={locale === "ar" ? "إزالة" : "Remove"} tone="danger" onPress={() => confirmRemoveGuarantor(guarantor._id)} />
                  </View>
                ) : null}
              </View>
            ))
          )}
        </View>
      ) : null}
    </FormModal>
      <FormModal
        title={editingGuarantorId ? (locale === "ar" ? "تعديل ضامن" : "Edit guarantor") : (locale === "ar" ? "ضامن جديد" : "New guarantor")}
        visible={guarantorFormOpen}
        onClose={closeGuarantorForm}
      >
        <FormField
          label={locale === "ar" ? "الاسم الأول" : "First name"}
          value={guarantorForm.firstName}
          onChangeText={(firstName) => setGuarantorForm((prev) => ({ ...prev, firstName }))}
        />
        <FormField
          label={locale === "ar" ? "اسم العائلة" : "Last name"}
          value={guarantorForm.lastName}
          onChangeText={(lastName) => setGuarantorForm((prev) => ({ ...prev, lastName }))}
        />
        <FormField
          label={locale === "ar" ? "الرقم الوطني" : "National ID"}
          value={guarantorForm.nationalId}
          onChangeText={(nationalId) => setGuarantorForm((prev) => ({ ...prev, nationalId }))}
        />
        <FormField
          keyboardType="phone-pad"
          label={locale === "ar" ? "الهاتف" : "Phone"}
          value={guarantorForm.phone}
          onChangeText={(phone) => setGuarantorForm((prev) => ({ ...prev, phone }))}
        />
        <FormField
          label={locale === "ar" ? "صلة القرابة" : "Relationship"}
          value={guarantorForm.relationship}
          onChangeText={(relationship) => setGuarantorForm((prev) => ({ ...prev, relationship }))}
        />
        <FormField
          keyboardType="numeric"
          label={locale === "ar" ? "الدخل" : "Income"}
          value={guarantorForm.income}
          onChangeText={(income) => setGuarantorForm((prev) => ({ ...prev, income }))}
        />
        <PrimaryButton
          disabled={savingGuarantor}
          label={savingGuarantor ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")}
          onPress={saveGuarantor}
        />
      </FormModal>
    </>
  );
}
