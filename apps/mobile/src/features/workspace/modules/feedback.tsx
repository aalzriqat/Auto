import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileFeedback, type MobileFeedbackStatus, type MobileFeedbackType } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { dateLabel, maybeText, useGenericError, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

export function FeedbackModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const [statusFilter, setStatusFilter] = useState<MobileFeedbackStatus | "ALL">("OPEN");
  const queryArgs = statusFilter === "ALL" ? { orgId } : { orgId, status: statusFilter };
  const feedback = useQuery(api.feedback.list, queryArgs);
  const submitFeedback = useMutation(api.feedback.submit);
  const setFeedbackStatus = useMutation(api.feedback.setStatus);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ type: "FEATURE" as MobileFeedbackType, title: "", description: "" });

  async function submit() {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      await submitFeedback({
        orgId,
        type: form.type,
        title: form.title.trim(),
        description: maybeText(form.description),
      });
      setOpen(false);
      setForm({ type: "FEATURE", title: "", description: "" });
    } catch (error) {
      reportError("Mobile feedback submit failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (feedback === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "ملاحظة جديدة" : "New feedback"} onPress={() => setOpen(true)} />
      </View>
      <SegmentedControl options={[{ label: locale === "ar" ? "مفتوح" : "Open", value: "OPEN" }, { label: locale === "ar" ? "مغلق" : "Closed", value: "CLOSED" }, { label: locale === "ar" ? "الكل" : "All", value: "ALL" }]} value={statusFilter} onChange={setStatusFilter} />
      {feedback.length ? feedback.map((item: MobileFeedback) => (
        <RecordCard key={item._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{item.title}</Text>
            <Text style={styles.statusPill}>{item.type}</Text>
          </View>
          <Text style={styles.recordMeta}>{item.userName ?? "-"} · {dateLabel(item.createdAt, locale)} · {item.status}</Text>
          {item.description ? <Text style={styles.recordMeta}>{item.description}</Text> : null}
          <PrimaryButton
            label={item.status === "OPEN" ? (locale === "ar" ? "إغلاق" : "Close") : (locale === "ar" ? "إعادة فتح" : "Reopen")}
            tone="muted"
            onPress={() => setFeedbackStatus({ orgId, feedbackId: item._id, status: item.status === "OPEN" ? "CLOSED" : "OPEN" }).catch((error: unknown) => reportError("Mobile feedback status failed", error))}
          />
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد ملاحظات." : "No feedback found."} />}
      <FormModal title={locale === "ar" ? "ملاحظة جديدة" : "New feedback"} visible={open} onClose={() => setOpen(false)}>
        <SelectField label={locale === "ar" ? "النوع" : "Type"} value={form.type} options={[{ label: "Feature", value: "FEATURE" }, { label: "Bug", value: "BUG" }]} onChange={(type) => setForm((prev) => ({ ...prev, type: type as MobileFeedbackType }))} />
        <FormField label={locale === "ar" ? "العنوان" : "Title"} value={form.title} onChangeText={(title) => setForm((prev) => ({ ...prev, title }))} />
        <FormField multiline label={locale === "ar" ? "التفاصيل" : "Details"} value={form.description} onChangeText={(description) => setForm((prev) => ({ ...prev, description }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الإرسال..." : "Submitting...") : (locale === "ar" ? "إرسال" : "Submit")} onPress={submit} />
      </FormModal>
    </ModuleScroll>
  );
}

