import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileCustomField, type MobileCustomFieldEntityType, type MobileCustomFieldType } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { type Option, splitLinesOrCommas, joinList, useGenericError, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

function fieldKeyFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function CustomFieldsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const [entityType, setEntityType] = useState<MobileCustomFieldEntityType>("vehicle");
  const fields = useQuery(api.orgCustomFields.list, { orgId, entityType });
  const createField = useMutation(api.orgCustomFields.create);
  const updateField = useMutation(api.orgCustomFields.update);
  const removeField = useMutation(api.orgCustomFields.remove);
  const [editing, setEditing] = useState<MobileCustomField | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    entityType: "vehicle" as MobileCustomFieldEntityType,
    fieldName: "",
    fieldKey: "",
    fieldType: "text" as MobileCustomFieldType,
    isRequired: "false",
    options: "",
    isActive: "true",
  });

  const entityOptions: Array<Option<MobileCustomFieldEntityType>> = [
    { label: locale === "ar" ? "السيارات" : "Vehicles", value: "vehicle" },
    { label: locale === "ar" ? "العملاء" : "Customers", value: "customer" },
    { label: locale === "ar" ? "العملاء المحتملون" : "Leads", value: "lead" },
  ];

  function openCreate() {
    setEditing(null);
    setForm({
      entityType,
      fieldName: "",
      fieldKey: "",
      fieldType: "text",
      isRequired: "false",
      options: "",
      isActive: "true",
    });
    setOpen(true);
  }

  function openEdit(field: MobileCustomField) {
    setEditing(field);
    setForm({
      entityType: field.entityType,
      fieldName: field.fieldName,
      fieldKey: field.fieldKey,
      fieldType: field.fieldType,
      isRequired: field.isRequired ? "true" : "false",
      options: joinList(field.options),
      isActive: field.isActive ? "true" : "false",
    });
    setOpen(true);
  }

  async function save() {
    if (!form.fieldName.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await updateField({
          orgId,
          fieldId: editing._id,
          fieldName: form.fieldName.trim(),
          isRequired: form.isRequired === "true",
          options: form.fieldType === "select" ? splitLinesOrCommas(form.options) : undefined,
          isActive: form.isActive === "true",
        });
      } else {
        await createField({
          orgId,
          entityType: form.entityType,
          fieldName: form.fieldName.trim(),
          fieldKey: fieldKeyFromName(form.fieldKey || form.fieldName) || `field_${Date.now()}`,
          fieldType: form.fieldType,
          isRequired: form.isRequired === "true",
          options: form.fieldType === "select" ? splitLinesOrCommas(form.options) : undefined,
        });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile custom field save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (fields === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <SegmentedControl options={entityOptions} value={entityType} onChange={setEntityType} />
      <PrimaryButton label={locale === "ar" ? "إضافة حقل" : "Add field"} onPress={openCreate} />
      {fields.length ? fields.map((field) => (
        <RecordCard key={field._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{field.fieldName}</Text>
            <Text style={styles.statusPill}>{field.fieldType}</Text>
          </View>
          <Text style={styles.recordMeta}>{field.fieldKey} · {field.entityType} · {field.isRequired ? (locale === "ar" ? "إجباري" : "Required") : (locale === "ar" ? "اختياري" : "Optional")}</Text>
          {field.options?.length ? <Text style={styles.recordMeta}>{field.options.join(", ")}</Text> : null}
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(field)} />
            <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => removeField({ orgId, fieldId: field._id }).catch((error: unknown) => reportError("Mobile custom field delete failed", error))} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد حقول مخصصة." : "No custom fields found."} />}
      <FormModal title={editing ? (locale === "ar" ? "تعديل حقل" : "Edit field") : (locale === "ar" ? "حقل جديد" : "New field")} visible={open} onClose={() => setOpen(false)}>
        {!editing ? (
          <SelectField label={locale === "ar" ? "النوع" : "Entity"} value={form.entityType} options={entityOptions} onChange={(nextEntityType) => setForm((prev) => ({ ...prev, entityType: nextEntityType as MobileCustomFieldEntityType }))} />
        ) : null}
        <FormField label={locale === "ar" ? "اسم الحقل" : "Field name"} value={form.fieldName} onChangeText={(fieldName) => setForm((prev) => ({ ...prev, fieldName, fieldKey: editing ? prev.fieldKey : fieldKeyFromName(fieldName) }))} />
        {!editing ? (
          <>
            <FormField label={locale === "ar" ? "مفتاح الحقل" : "Field key"} value={form.fieldKey} onChangeText={(fieldKey) => setForm((prev) => ({ ...prev, fieldKey }))} />
            <SelectField
              label={locale === "ar" ? "نوع القيمة" : "Value type"}
              value={form.fieldType}
              options={[
                { label: "Text", value: "text" },
                { label: "Number", value: "number" },
                { label: "Select", value: "select" },
                { label: "Date", value: "date" },
              ]}
              onChange={(fieldType) => setForm((prev) => ({ ...prev, fieldType: fieldType as MobileCustomFieldType }))}
            />
          </>
        ) : null}
        <SelectField label={locale === "ar" ? "إجباري" : "Required"} value={form.isRequired} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isRequired) => setForm((prev) => ({ ...prev, isRequired }))} />
        <SelectField label={locale === "ar" ? "نشط" : "Active"} value={form.isActive} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isActive) => setForm((prev) => ({ ...prev, isActive }))} />
        {form.fieldType === "select" ? (
          <FormField multiline label={locale === "ar" ? "الخيارات" : "Options"} value={form.options} onChangeText={(options) => setForm((prev) => ({ ...prev, options }))} />
        ) : null}
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

