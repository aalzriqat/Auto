import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileBranch } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { SELECTOR_PAGE_SIZE, maybeText, splitLinesOrCommas, joinList, useGenericError, PrimaryButton, FormField, SelectField, FormModal, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

export function BranchesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const branches = useQuery(api.branches.list, { orgId });
  const members = usePaginatedQuery(api.memberships.list, { orgId }, { initialNumItems: SELECTOR_PAGE_SIZE });
  const addBranch = useMutation(api.branches.add);
  const updateBranch = useMutation(api.branches.update);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MobileBranch | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", phone: "", additionalPhones: "", managerId: "", isActive: "true" });
  const managerOptions = [
    { label: locale === "ar" ? "بدون مدير" : "Unassigned", value: "" },
    ...members.results.map((member) => ({ label: member.userName, value: member.userId })),
  ];

  function openForm(branch: MobileBranch | null) {
    setEditing(branch);
    setForm({
      name: branch?.name ?? "",
      address: branch?.address ?? "",
      phone: branch?.phone ?? "",
      additionalPhones: joinList(branch?.additionalPhones),
      managerId: branch?.managerId ?? "",
      isActive: branch?.isActive === false ? "false" : "true",
    });
    setOpen(true);
  }

  async function save() {
    if (!form.name.trim()) {
      Alert.alert(locale === "ar" ? "الاسم مطلوب" : "Name required");
      return;
    }
    const payload = {
      orgId,
      name: form.name,
      address: maybeText(form.address),
      phone: maybeText(form.phone),
      additionalPhones: splitLinesOrCommas(form.additionalPhones),
      managerId: maybeText(form.managerId),
      isActive: form.isActive === "true",
    };
    setSaving(true);
    try {
      if (editing) {
        await updateBranch({ ...payload, id: editing._id });
      } else {
        await addBranch(payload);
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile branch save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (branches === undefined) return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة فرع" : "Add branch"} onPress={() => openForm(null)} />
      </View>
      {branches.length ? branches.map((branch) => (
        <RecordCard key={branch._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{branch.name}</Text>
            <Text style={styles.statusPill}>{branch.isActive ? "ACTIVE" : "INACTIVE"}</Text>
          </View>
          <Text style={styles.recordMeta}>{branch.address || "-"}</Text>
          <Text style={styles.recordMeta}>{branch.phone || "-"} · {branch.managerName}</Text>
          <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openForm(branch)} />
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد فروع." : "No branches found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل فرع" : "Edit branch") : (locale === "ar" ? "فرع جديد" : "New branch")} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "الاسم" : "Name"} value={form.name} onChangeText={(name) => setForm((prev) => ({ ...prev, name }))} />
        <FormField multiline label={locale === "ar" ? "العنوان" : "Address"} value={form.address} onChangeText={(address) => setForm((prev) => ({ ...prev, address }))} />
        <FormField keyboardType="phone-pad" label={locale === "ar" ? "الهاتف" : "Phone"} value={form.phone} onChangeText={(phone) => setForm((prev) => ({ ...prev, phone }))} />
        <FormField multiline label={locale === "ar" ? "هواتف إضافية" : "Additional phones"} value={form.additionalPhones} onChangeText={(additionalPhones) => setForm((prev) => ({ ...prev, additionalPhones }))} />
        <SelectField label={locale === "ar" ? "المدير" : "Manager"} value={form.managerId} options={managerOptions} onChange={(managerId) => setForm((prev) => ({ ...prev, managerId }))} />
        <SelectField label={locale === "ar" ? "فعال" : "Active"} value={form.isActive} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

