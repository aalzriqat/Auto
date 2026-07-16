import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobilePipelineStage } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { useGenericError, PrimaryButton, FormField, SelectField, FormModal, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

export function PipelineSettingsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const stages = useQuery(api.orgPipelineStages.list, { orgId });
  const seedStages = useMutation(api.orgPipelineStages.seed);
  const updateStage = useMutation(api.orgPipelineStages.update);
  const reorderStages = useMutation(api.orgPipelineStages.reorder);
  const [editing, setEditing] = useState<MobilePipelineStage | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ label: "", color: "#0f766e", isActive: "true" });

  function openEdit(stage: MobilePipelineStage) {
    setEditing(stage);
    setForm({
      label: stage.label,
      color: stage.color,
      isActive: stage.isActive ? "true" : "false",
    });
  }

  async function save() {
    if (!editing || !form.label.trim()) return;
    setSaving(true);
    try {
      await updateStage({
        orgId,
        stageId: editing._id,
        label: form.label.trim(),
        color: form.color.trim() || editing.color,
        isActive: form.isActive === "true",
      });
      setEditing(null);
    } catch (error) {
      reportError("Mobile pipeline stage save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function seed() {
    try {
      await seedStages({ orgId });
    } catch (error) {
      reportError("Mobile pipeline seed failed", error);
    }
  }

  async function move(stage: MobilePipelineStage, direction: -1 | 1) {
    if (!stages) return;
    const currentIndex = stages.findIndex((item) => item._id === stage._id);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= stages.length) return;
    const ordered = [...stages];
    const [removed] = ordered.splice(currentIndex, 1);
    ordered.splice(nextIndex, 0, removed);
    try {
      await reorderStages({ orgId, orderedIds: ordered.map((item) => item._id) });
    } catch (error) {
      reportError("Mobile pipeline reorder failed", error);
    }
  }

  if (stages === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <PrimaryButton label={locale === "ar" ? "تهيئة المراحل الافتراضية" : "Seed default stages"} onPress={seed} />
      {stages.length ? stages.map((stage) => (
        <RecordCard key={stage._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{stage.label}</Text>
            <Text style={[styles.statusPill, { backgroundColor: stage.color }]}>{stage.stageKey}</Text>
          </View>
          <Text style={styles.recordMeta}>
            {locale === "ar" ? "الترتيب" : "Order"} {stage.order + 1} · {stage.isActive ? (locale === "ar" ? "نشط" : "Active") : (locale === "ar" ? "متوقف" : "Inactive")}
          </Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(stage)} />
            <PrimaryButton label={locale === "ar" ? "أعلى" : "Up"} tone="muted" onPress={() => move(stage, -1)} />
            <PrimaryButton label={locale === "ar" ? "أسفل" : "Down"} tone="muted" onPress={() => move(stage, 1)} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لم تتم تهيئة المراحل بعد." : "No stages configured yet."} />}
      <FormModal title={locale === "ar" ? "تعديل المرحلة" : "Edit stage"} visible={Boolean(editing)} onClose={() => setEditing(null)}>
        <FormField label={locale === "ar" ? "الاسم" : "Label"} value={form.label} onChangeText={(label) => setForm((prev) => ({ ...prev, label }))} />
        <FormField label={locale === "ar" ? "اللون" : "Color"} value={form.color} onChangeText={(color) => setForm((prev) => ({ ...prev, color }))} />
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

