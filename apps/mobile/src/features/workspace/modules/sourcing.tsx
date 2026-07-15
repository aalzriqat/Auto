import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileSupplierPayable, type MobileSupplierPayableStatus } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { type Option, money, maybeText, parseOptionalNumber, idempotencyKey, useGenericError, PrimaryButton, SegmentedControl, FormField, FormModal, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

export function SourcingModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const markPaid = useMutation(api.sourcingPayables.markPaid);
  const [statusFilter, setStatusFilter] = useState<MobileSupplierPayableStatus | "ALL">("PENDING");
  const payables = useQuery(
    api.sourcingPayables.list,
    statusFilter === "ALL" ? { orgId } : { orgId, status: statusFilter },
  );
  const [selected, setSelected] = useState<MobileSupplierPayable | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ notes: "", taxAmount: "" });
  const statusOptions: Array<Option<MobileSupplierPayableStatus | "ALL">> = [
    { label: locale === "ar" ? "الكل" : "All", value: "ALL" },
    { label: "PENDING", value: "PENDING" },
    { label: "PAID", value: "PAID" },
    { label: "CANCELLED", value: "CANCELLED" },
  ];

  function openPay(payable: MobileSupplierPayable) {
    setSelected(payable);
    setForm({
      notes: payable.paymentNotes ?? "",
      taxAmount: payable.taxAmount != null ? String(payable.taxAmount) : "",
    });
  }

  async function savePaid() {
    if (!selected) return;
    setSaving(true);
    try {
      await markPaid({
        orgId,
        payableId: selected._id,
        paymentMethod: "CASH",
        paymentNotes: maybeText(form.notes),
        taxAmount: parseOptionalNumber(form.taxAmount),
        idempotencyKey: idempotencyKey("sourcingPayables.markPaid"),
      });
      setSelected(null);
    } catch (error) {
      reportError("Mobile sourcing payable mark paid failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (payables === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <SegmentedControl options={statusOptions} value={statusFilter} onChange={setStatusFilter} />
      {payables.length ? payables.map((payable) => (
        <RecordCard key={payable._id}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{payable.sourcedFromName}</Text>
            <Text style={styles.statusPill}>{payable.status}</Text>
          </View>
          <Text style={styles.recordMeta}>{payable.vehicleDesc} · {payable.vehicleVin || "-"}</Text>
          <Text style={styles.recordMeta}>{money(payable.amountDue, locale)} · {payable.customerName || "-"}</Text>
          {payable.status === "PENDING" ? (
            <PrimaryButton label={locale === "ar" ? "تسجيل الدفع" : "Mark paid"} tone="muted" onPress={() => openPay(payable)} />
          ) : null}
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد مستحقات." : "No sourcing payables found."} />}
      <FormModal
        title={locale === "ar" ? "تسجيل دفع المورد" : "Mark supplier paid"}
        visible={Boolean(selected)}
        onClose={() => setSelected(null)}
      >
        <FormField keyboardType="numeric" label={locale === "ar" ? "ضريبة" : "Tax amount"} value={form.taxAmount} onChangeText={(taxAmount) => setForm((prev) => ({ ...prev, taxAmount }))} />
        <FormField multiline label={locale === "ar" ? "ملاحظات" : "Notes"} value={form.notes} onChangeText={(notes) => setForm((prev) => ({ ...prev, notes }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={savePaid} />
      </FormModal>
    </ModuleScroll>
  );
}

