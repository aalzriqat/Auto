import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { api, type MobileTask, type MobileTaskPriority } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, SELECTOR_PAGE_SIZE, type Option, dateLabel, maybeText, parseRequiredNumber, useGenericError, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, RecordCard, ModuleList } from "./moduleShared";
import { styles } from "./moduleStyles";

export function TasksModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createTask = useMutation(api.tasks.create);
  const updateTask = useMutation(api.tasks.update);
  const [filter, setFilter] = useState<"ALL" | "PENDING" | "COMPLETED">("PENDING");
  const { loadMore, results, status } = usePaginatedQuery(
    api.tasks.list,
    filter === "ALL" ? { orgId } : { orgId, status: filter },
    { initialNumItems: PAGE_SIZE },
  );
  const members = useQuery(api.memberships.list, {
    orgId,
    paginationOpts: { cursor: null, numItems: SELECTOR_PAGE_SIZE },
  });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    assignedTo: "",
    title: "",
    description: "",
    dueDays: "1",
    priority: "MEDIUM" as MobileTaskPriority,
  });
  const statusOptions: Array<Option<"ALL" | "PENDING" | "COMPLETED">> = [
    { value: "ALL", label: locale === "ar" ? "الكل" : "All" },
    { value: "PENDING", label: locale === "ar" ? "معلقة" : "Pending" },
    { value: "COMPLETED", label: locale === "ar" ? "مكتملة" : "Completed" },
  ];
  const memberOptions = (members?.page ?? []).map((member) => ({ label: member.userName, value: member.userId }));

  async function save() {
    const dueDays = parseRequiredNumber(form.dueDays);
    const assignedTo = form.assignedTo || memberOptions[0]?.value;
    if (!assignedTo || !form.title.trim() || dueDays === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      await createTask({
        orgId,
        assignedTo,
        title: form.title,
        description: maybeText(form.description),
        dueDate: Date.now() + dueDays * 24 * 60 * 60 * 1000,
        priority: form.priority,
        status: "PENDING",
      });
      setOpen(false);
      setForm({ assignedTo: "", title: "", description: "", dueDays: "1", priority: "MEDIUM" });
    } catch (error) {
      reportError("Mobile task save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function setTaskStatus(task: MobileTask, nextStatus: "PENDING" | "COMPLETED" | "CANCELLED") {
    try {
      await updateTask({ orgId, taskId: task._id, status: nextStatus });
    } catch (error) {
      reportError("Mobile task update failed", error);
    }
  }

  return (
    <>
      <ModuleList
        data={results}
        emptyLabel={locale === "ar" ? "لا توجد مهام." : "No tasks found."}
        keyExtractor={(task) => task._id}
        loadMore={loadMore}
        status={status}
        header={
          <View style={styles.actionRow}>
            <SegmentedControl options={statusOptions} value={filter} onChange={setFilter} />
            <PrimaryButton label={locale === "ar" ? "إضافة" : "Add"} onPress={() => setOpen(true)} />
          </View>
        }
        renderItem={(task) => (
          <RecordCard>
            <View style={styles.recordHeader}>
              <Text style={styles.recordTitle}>{task.title}</Text>
              <Text style={styles.statusPill}>{task.status}</Text>
            </View>
            <Text style={styles.recordMeta}>{locale === "ar" ? "المسؤول" : "Assignee"}: {task.assigneeName}</Text>
            <Text style={styles.recordMeta}>{locale === "ar" ? "الاستحقاق" : "Due"}: {dateLabel(task.dueDate, locale)}</Text>
            {task.customerName ? <Text style={styles.recordMeta}>{task.customerName}</Text> : null}
            <View style={styles.cardActions}>
              {task.status !== "COMPLETED" ? <PrimaryButton label={locale === "ar" ? "إنهاء" : "Complete"} tone="muted" onPress={() => setTaskStatus(task, "COMPLETED")} /> : null}
              {task.status !== "CANCELLED" ? <PrimaryButton label={locale === "ar" ? "إلغاء" : "Cancel"} tone="danger" onPress={() => setTaskStatus(task, "CANCELLED")} /> : null}
            </View>
          </RecordCard>
        )}
      />
      <FormModal title={locale === "ar" ? "مهمة جديدة" : "New task"} visible={open} onClose={() => setOpen(false)}>
        <SelectField label={locale === "ar" ? "المسؤول" : "Assigned to"} value={form.assignedTo} options={memberOptions} onChange={(assignedTo) => setForm((prev) => ({ ...prev, assignedTo }))} />
        <FormField label={locale === "ar" ? "العنوان" : "Title"} value={form.title} onChangeText={(title) => setForm((prev) => ({ ...prev, title }))} />
        <FormField multiline label={locale === "ar" ? "الوصف" : "Description"} value={form.description} onChangeText={(description) => setForm((prev) => ({ ...prev, description }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "بعد كم يوم" : "Due in days"} value={form.dueDays} onChangeText={(dueDays) => setForm((prev) => ({ ...prev, dueDays }))} />
        <SelectField label={locale === "ar" ? "الأولوية" : "Priority"} value={form.priority} options={[
          { label: locale === "ar" ? "عالية" : "High", value: "HIGH" },
          { label: locale === "ar" ? "متوسطة" : "Medium", value: "MEDIUM" },
          { label: locale === "ar" ? "منخفضة" : "Low", value: "LOW" },
        ]} onChange={(priority) => setForm((prev) => ({ ...prev, priority: priority as MobileTaskPriority }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </>
  );
}

