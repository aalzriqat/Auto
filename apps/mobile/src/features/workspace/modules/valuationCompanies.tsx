import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileValuationCompany } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { useGenericError, PrimaryButton, FormField, SelectField, FormModal, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function ValuationCompaniesModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  const companies = useQuery(api.orgValuationCompanies.list, { orgId });
  const seedCompanies = useMutation(api.orgValuationCompanies.seed);
  const createCompany = useMutation(api.orgValuationCompanies.create);
  const updateCompany = useMutation(api.orgValuationCompanies.update);
  const removeCompany = useMutation(api.orgValuationCompanies.remove);
  const [editing, setEditing] = useState<MobileValuationCompany | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", isActive: "true" });

  function openCreate() {
    setEditing(null);
    setForm({ name: "", isActive: "true" });
    setOpen(true);
  }

  function openEdit(company: MobileValuationCompany) {
    setEditing(company);
    setForm({ name: company.name, isActive: company.isActive ? "true" : "false" });
    setOpen(true);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await updateCompany({
          orgId,
          companyId: editing._id,
          name: form.name.trim(),
          isActive: form.isActive === "true",
        });
      } else {
        await createCompany({ orgId, name: form.name.trim() });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile valuation company save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (companies === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة شركة" : "Add company"} onPress={openCreate} />
        <PrimaryButton label={locale === "ar" ? "تهيئة" : "Seed"} tone="muted" onPress={() => seedCompanies({ orgId }).catch((error: unknown) => reportError("Mobile valuation seed failed", error))} />
      </View>
      {companies.length ? companies.map((company) => (
        <RecordCard key={company._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{company.name}</Text>
            <Text style={styles.statusPill}>{company.isActive ? "ACTIVE" : "INACTIVE"}</Text>
          </View>
          <Text style={styles.recordMeta}>{locale === "ar" ? "الترتيب" : "Order"} {company.order + 1}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(company)} />
            <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => removeCompany({ orgId, companyId: company._id }).catch((error: unknown) => reportError("Mobile valuation delete failed", error))} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد شركات تقييم." : "No valuation companies found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل شركة" : "Edit company") : (locale === "ar" ? "شركة جديدة" : "New company")} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "الاسم" : "Name"} value={form.name} onChangeText={(name) => setForm((prev) => ({ ...prev, name }))} />
        <SelectField
          label={locale === "ar" ? "الحالة" : "Status"}
          value={form.isActive}
          options={[{ label: locale === "ar" ? "نشط" : "Active", value: "true" }, { label: locale === "ar" ? "متوقف" : "Inactive", value: "false" }]}
          onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))}
        />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

