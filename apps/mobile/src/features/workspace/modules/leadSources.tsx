import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileLeadSource } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { useGenericError, PrimaryButton, FormField, SelectField, FormModal, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

export function LeadSourcesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const sources = useQuery(api.orgLeadSources.list, { orgId });
  const seedSources = useMutation(api.orgLeadSources.seed);
  const createSource = useMutation(api.orgLeadSources.create);
  const updateSource = useMutation(api.orgLeadSources.update);
  const removeSource = useMutation(api.orgLeadSources.remove);
  const reorderSources = useMutation(api.orgLeadSources.reorder);
  const [editing, setEditing] = useState<MobileLeadSource | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ label: "", isActive: "true" });

  function openCreate() {
    setEditing(null);
    setForm({ label: "", isActive: "true" });
    setOpen(true);
  }

  function openEdit(source: MobileLeadSource) {
    setEditing(source);
    setForm({ label: source.label, isActive: source.isActive ? "true" : "false" });
    setOpen(true);
  }

  async function save() {
    if (!form.label.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await updateSource({
          orgId,
          sourceId: editing._id,
          label: form.label.trim(),
          isActive: form.isActive === "true",
        });
      } else {
        await createSource({ orgId, label: form.label.trim() });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile lead source save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function move(source: MobileLeadSource, direction: -1 | 1) {
    if (!sources) return;
    const currentIndex = sources.findIndex((item) => item._id === source._id);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sources.length) return;
    const ordered = [...sources];
    const [removed] = ordered.splice(currentIndex, 1);
    ordered.splice(nextIndex, 0, removed);
    try {
      await reorderSources({ orgId, orderedIds: ordered.map((item) => item._id) });
    } catch (error) {
      reportError("Mobile lead source reorder failed", error);
    }
  }

  if (sources === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة مصدر" : "Add source"} onPress={openCreate} />
        <PrimaryButton label={locale === "ar" ? "تهيئة" : "Seed"} tone="muted" onPress={() => seedSources({ orgId }).catch((error: unknown) => reportError("Mobile lead source seed failed", error))} />
      </View>
      {sources.length ? sources.map((source) => (
        <RecordCard key={source._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{source.label}</Text>
            <Text style={styles.statusPill}>{source.isActive ? "ACTIVE" : "INACTIVE"}</Text>
          </View>
          <Text style={styles.recordMeta}>{locale === "ar" ? "الترتيب" : "Order"} {source.order + 1}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(source)} />
            <PrimaryButton label={locale === "ar" ? "أعلى" : "Up"} tone="muted" onPress={() => move(source, -1)} />
            <PrimaryButton label={locale === "ar" ? "أسفل" : "Down"} tone="muted" onPress={() => move(source, 1)} />
            <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => removeSource({ orgId, sourceId: source._id }).catch((error: unknown) => reportError("Mobile lead source delete failed", error))} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد مصادر." : "No lead sources found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل مصدر" : "Edit source") : (locale === "ar" ? "مصدر جديد" : "New source")} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "المصدر" : "Source"} value={form.label} onChangeText={(label) => setForm((prev) => ({ ...prev, label }))} />
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

