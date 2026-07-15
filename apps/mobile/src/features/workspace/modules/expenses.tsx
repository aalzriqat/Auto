import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { api, type MobileExpense, type MobileExpenseCategory } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, money, dateLabel, maybeText, parseOptionalNumber, parseRequiredNumber, idempotencyKey, useGenericError, PrimaryButton, FormField, SelectField, FormModal, RecordCard, EmptyList, LoadMoreFooter, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

export function ExpensesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createExpense = useMutation(api.expenses.create);
  const removeExpense = useMutation(api.expenses.remove);
  const { loadMore, results, status } = usePaginatedQuery(api.expenses.list, { orgId }, { initialNumItems: PAGE_SIZE });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, includeReserved: true });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    amount: "",
    taxAmount: "",
    category: "OTHER" as MobileExpenseCategory,
    vendor: "",
    vehicleId: "",
    notes: "",
  });
  const vehicleOptions = [
    { label: locale === "ar" ? "عام" : "General", value: "" },
    ...(vehicles ?? []).map((vehicle) => ({ label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, value: vehicle._id })),
  ];

  async function save() {
    const amount = parseRequiredNumber(form.amount);
    if (!form.title.trim() || amount === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      await createExpense({
        orgId,
        title: form.title,
        amount,
        taxAmount: parseOptionalNumber(form.taxAmount),
        date: Date.now(),
        category: form.category,
        status: "PAID",
        vendor: maybeText(form.vendor),
        vehicleId: maybeText(form.vehicleId),
        notes: maybeText(form.notes),
        idempotencyKey: idempotencyKey("expenses.create"),
      });
      setOpen(false);
      setForm({ title: "", amount: "", taxAmount: "", category: "OTHER", vendor: "", vehicleId: "", notes: "" });
    } catch (error) {
      reportError("Mobile expense save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(expense: MobileExpense) {
    try {
      await removeExpense({ orgId, expenseId: expense._id });
    } catch (error) {
      reportError("Mobile expense remove failed", error);
    }
  }

  return (
    <ModuleScroll>
      <PrimaryButton label={locale === "ar" ? "إضافة مصروف" : "Add expense"} onPress={() => setOpen(true)} />
      {results.length ? results.map((expense) => (
        <RecordCard key={expense._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{expense.title}</Text>
            <Text style={styles.statusPill}>{expense.status}</Text>
          </View>
          <Text style={styles.recordMeta}>{money(expense.amount, locale)} · {expense.category}</Text>
          <Text style={styles.recordMeta}>{expense.vehicleSummary || expense.vendor || dateLabel(expense.date, locale)}</Text>
          <View style={styles.cardActions}>
            <PrimaryButton label={locale === "ar" ? "حذف" : "Remove"} tone="danger" onPress={() => remove(expense)} />
          </View>
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد مصاريف." : "No expenses found."} />}
      <LoadMoreFooter loadMore={loadMore} status={status} />
      <FormModal title={locale === "ar" ? "مصروف جديد" : "New expense"} visible={open} onClose={() => setOpen(false)}>
        <FormField label={locale === "ar" ? "العنوان" : "Title"} value={form.title} onChangeText={(title) => setForm((prev) => ({ ...prev, title }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "المبلغ" : "Amount"} value={form.amount} onChangeText={(amount) => setForm((prev) => ({ ...prev, amount }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "الضريبة" : "Tax"} value={form.taxAmount} onChangeText={(taxAmount) => setForm((prev) => ({ ...prev, taxAmount }))} />
        <SelectField label={locale === "ar" ? "السيارة" : "Vehicle"} value={form.vehicleId} options={vehicleOptions} onChange={(vehicleId) => setForm((prev) => ({ ...prev, vehicleId }))} />
        <SelectField label={locale === "ar" ? "الفئة" : "Category"} value={form.category} options={["REPAIR", "MAINTENANCE", "INSPECTION", "REGISTRATION", "CLEANING", "MARKETING", "OFFICE", "RENT", "SALARIES", "UTILITIES", "INSURANCE", "OTHER"].map((value) => ({ label: value, value }))} onChange={(category) => setForm((prev) => ({ ...prev, category: category as MobileExpenseCategory }))} />
        <FormField label={locale === "ar" ? "المورد" : "Vendor"} value={form.vendor} onChangeText={(vendor) => setForm((prev) => ({ ...prev, vendor }))} />
        <FormField multiline label={locale === "ar" ? "ملاحظات" : "Notes"} value={form.notes} onChangeText={(notes) => setForm((prev) => ({ ...prev, notes }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </ModuleScroll>
  );
}

