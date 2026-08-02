import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileRole } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { splitLinesOrCommas, joinList, requiredFieldMessage, requiredText, useFieldFocusChain, useFormErrors, useGenericError, PrimaryButton, FormField, FormModal, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function RolesModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  const roles = useQuery(api.roles.list, { orgId });
  const createRole = useMutation(api.roles.create);
  const updateRole = useMutation(api.roles.update);
  const removeRole = useMutation(api.roles.remove);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MobileRole | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", permissions: "" });
  const { errors, reset, validate } = useFormErrors<"name" | "permissions">();
  const chain = useFieldFocusChain(2);

  function openForm(role: MobileRole | null) {
    setEditing(role);
    setForm({ name: role?.name ?? "", permissions: joinList(role?.permissions) });
    reset();
    setOpen(true);
  }

  async function save() {
    const permissions = splitLinesOrCommas(form.permissions);
    const valid = validate({
      name: requiredText(form.name, locale),
      permissions: permissions.length === 0 ? requiredFieldMessage(locale) : undefined,
    });
    if (!valid) return;
    setSaving(true);
    try {
      if (editing) {
        await updateRole({ orgId, roleId: editing._id, name: form.name, permissions });
      } else {
        await createRole({ orgId, name: form.name, permissions });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile role save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(role: MobileRole) {
    try {
      await removeRole({ orgId, roleId: role._id });
    } catch (error) {
      reportError("Mobile role delete failed", error);
    }
  }

  if (roles === undefined) return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;

  return (
    <ModuleScroll>
      <View style={styles.actionRow}>
        <PrimaryButton label={locale === "ar" ? "إضافة دور" : "Add role"} onPress={() => openForm(null)} />
      </View>
      {roles.length ? roles.map((role) => (
        <RecordCard key={role._id}>
          <Text style={styles.recordTitle}>{role.name}</Text>
          <Text style={styles.recordMeta}>{role.permissions.length} {locale === "ar" ? "صلاحية" : "permissions"}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openForm(role)} />
            {role.name !== "OWNER" ? <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => remove(role)} /> : null}
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد أدوار." : "No roles found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل دور" : "Edit role") : (locale === "ar" ? "دور جديد" : "New role")} visible={open} onClose={() => setOpen(false)}>
        <FormField error={errors.name} label={locale === "ar" ? "الاسم" : "Name"} value={form.name} onChangeText={(name) => setForm((prev) => ({ ...prev, name }))} {...chain.fieldProps(0)} />
        <FormField multiline error={errors.permissions} label={locale === "ar" ? "الصلاحيات، كل سطر صلاحية" : "Permissions, one per line"} value={form.permissions} onChangeText={(permissions) => setForm((prev) => ({ ...prev, permissions }))} {...chain.fieldProps(1)} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

