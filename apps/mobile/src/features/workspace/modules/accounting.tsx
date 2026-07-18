import { useMutation, usePaginatedQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { api, type MobileLedgerCategory, type MobileLedgerTransaction, type MobileLedgerType } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, type Option, money, dateLabel, parseRequiredPositiveNumber, idempotencyKey, useGenericError, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, RecordCard, ModuleList } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function AccountingModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  const addTransaction = useMutation(api.transactions.add);
  const updateTransaction = useMutation(api.transactions.update);
  const removeTransaction = useMutation(api.transactions.remove);
  const { loadMore, results, status } = usePaginatedQuery(api.transactions.list, { orgId }, { initialNumItems: PAGE_SIZE });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MobileLedgerTransaction | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    type: "IN" as MobileLedgerType,
    amount: "",
    category: "OTHER" as MobileLedgerCategory,
    description: "",
  });
  const typeOptions: Array<Option<MobileLedgerType>> = [
    { label: locale === "ar" ? "داخل" : "In", value: "IN" },
    { label: locale === "ar" ? "خارج" : "Out", value: "OUT" },
  ];
  const categoryOptions: Array<Option<MobileLedgerCategory>> = [
    "VEHICLE_SALE",
    "VEHICLE_PURCHASE",
    "EXPENSE",
    "DEPOSIT",
    "COLLECTION_PAYMENT",
    "REFUND",
    "PARTNER_DRAW",
    "CAPITAL_INJECTION",
    "CLAIM_PAYMENT",
    "OTHER",
  ].map((value) => ({ label: value, value: value as MobileLedgerCategory }));

  function openCreate() {
    setEditing(null);
    setForm({ type: "IN", amount: "", category: "OTHER", description: "" });
    setOpen(true);
  }

  function openEdit(transaction: MobileLedgerTransaction) {
    setEditing(transaction);
    setForm({
      type: transaction.type,
      amount: String(transaction.amount),
      category: transaction.category,
      description: transaction.description,
    });
    setOpen(true);
  }

  async function save() {
    const amount = parseRequiredPositiveNumber(form.amount);
    if (amount === null || !form.description.trim()) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateTransaction({
          orgId,
          transactionId: editing._id,
          type: form.type,
          amount,
          category: form.category,
          description: form.description,
          date: editing.date,
        });
      } else {
        await addTransaction({
          orgId,
          type: form.type,
          amount,
          category: form.category,
          description: form.description,
          date: Date.now(),
          idempotencyKey: idempotencyKey("transactions.add"),
        });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile accounting save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: MobileLedgerTransaction) {
    try {
      await removeTransaction({ orgId, transactionId: row._id });
    } catch (error) {
      reportError("Mobile accounting delete failed", error);
    }
  }

  return (
    <>
      <ModuleList
        data={results}
        emptyLabel={locale === "ar" ? "لا توجد قيود." : "No ledger entries found."}
        keyExtractor={(transaction) => transaction._id}
        loadMore={loadMore}
        status={status}
        header={
          <View style={styles.actionRow}>
            <PrimaryButton label={locale === "ar" ? "إضافة قيد" : "Add entry"} onPress={openCreate} />
          </View>
        }
        renderItem={(transaction: MobileLedgerTransaction) => (
          <RecordCard>
            <View style={styles.recordHeader}>
              <Text style={styles.recordTitle}>{transaction.description}</Text>
              <Text style={styles.statusPill}>{transaction.type}</Text>
            </View>
            <Text style={styles.recordMeta}>{transaction.category} · {dateLabel(transaction.date, locale)}</Text>
            <Text style={styles.recordMeta}>{money(transaction.amount, locale)} · {transaction.vehicleLabel || transaction.customerName || "-"}</Text>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(transaction)} />
              <PrimaryButton label={locale === "ar" ? "حذف" : "Delete"} tone="danger" onPress={() => remove(transaction)} />
            </View>
          </RecordCard>
        )}
      />
      <FormModal
        title={editing ? (locale === "ar" ? "تعديل قيد" : "Edit entry") : (locale === "ar" ? "قيد جديد" : "New entry")}
        visible={open}
        onClose={() => {
          setEditing(null);
          setOpen(false);
        }}
      >
        <SegmentedControl options={typeOptions} value={form.type} onChange={(type) => setForm((prev) => ({ ...prev, type }))} />
        <SelectField label={locale === "ar" ? "التصنيف" : "Category"} value={form.category} options={categoryOptions} onChange={(category) => setForm((prev) => ({ ...prev, category: category as MobileLedgerCategory }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "المبلغ" : "Amount"} value={form.amount} onChangeText={(amount) => setForm((prev) => ({ ...prev, amount }))} />
        <FormField multiline label={locale === "ar" ? "البيان" : "Description"} value={form.description} onChangeText={(description) => setForm((prev) => ({ ...prev, description }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
    </>
  );
}

