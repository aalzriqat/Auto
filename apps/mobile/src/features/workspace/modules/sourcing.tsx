import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileSupplierPayable, type MobileSupplierPayableStatus } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { type Option, money, maybeText, parseOptionalNumber, useCommandIdentity, useGenericError, PrimaryButton, SegmentedControl, FormField, FormModal, RecordCard, ModuleList } from "./moduleShared";
import { useStyles } from "./moduleStyles";

/** SCRUM-902: shown instead of the payables to a role with finance access and without cost-price access. */
export const SOURCING_COST_ACCESS_NOTE = {
  en: "Supplier payables show what each sourced car cost. Your role needs cost-price access as well as finance access to see them. Ask an administrator to update your role.",
  ar: "تعرض مستحقات الموردين تكلفة كل مركبة مورَّدة. يحتاج دورك إلى صلاحية عرض سعر التكلفة إضافةً إلى صلاحية المالية. اطلب من المسؤول تحديث دورك.",
} as const;

const LABELS = {
  en: {
    all: "All",
    loading: "Loading",
    empty: "No sourcing payables found.",
    markPaid: "Mark paid",
    markSupplierPaid: "Mark supplier paid",
    tax: "Tax amount",
    notes: "Notes",
    saving: "Saving...",
    save: "Save",
  },
  ar: {
    all: "الكل",
    loading: "جاري التحميل",
    empty: "لا توجد مستحقات.",
    markPaid: "تسجيل الدفع",
    markSupplierPaid: "تسجيل دفع المورد",
    tax: "ضريبة",
    notes: "ملاحظات",
    saving: "جاري الحفظ...",
    save: "حفظ",
  },
} as const;

export function SourcingModule({ orgId, permissions }: Readonly<{ orgId: string; permissions: readonly string[] }>) {
  const styles = useStyles();
  // The server requires view:finance and view:cost_price (a sourced car's supplier amount is its cost).
  const canViewSupplierCost = permissions.includes("view:finance") && permissions.includes("view:cost_price");
  const { locale } = useLocale();
  const labels = LABELS[locale];
  const reportError = useGenericError();
  const markPaid = useMutation(api.sourcingPayables.markPaid);
  const commandId = useCommandIdentity();
  const [statusFilter, setStatusFilter] = useState<MobileSupplierPayableStatus | "ALL">("PENDING");
  const payableQueryArgs = statusFilter === "ALL" ? { orgId } : { orgId, status: statusFilter };
  const payables = useQuery(
    api.sourcingPayables.list,
    !canViewSupplierCost ? "skip" : payableQueryArgs,
  );
  const [selected, setSelected] = useState<MobileSupplierPayable | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ notes: "", taxAmount: "" });
  const statusOptions: Array<Option<MobileSupplierPayableStatus | "ALL">> = [
    { label: labels.all, value: "ALL" },
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
    // Scoped to the PAYABLE. A failed submit keeps the identity so the retry is
    // the same settlement; only success retires it.
    const intent = `payable-pay:${String(selected._id)}`;
    try {
      await markPaid({
        orgId,
        payableId: selected._id,
        paymentMethod: "CASH",
        paymentNotes: maybeText(form.notes),
        taxAmount: parseOptionalNumber(form.taxAmount),
        idempotencyKey: commandId.for(intent),
      });
      commandId.retire(intent);
      setSelected(null);
    } catch (error) {
      reportError("Mobile sourcing payable mark paid failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (!canViewSupplierCost) {
    return (
      <RecordCard>
        <Text accessibilityRole="text" style={styles.recordMeta}>{SOURCING_COST_ACCESS_NOTE[locale === "ar" ? "ar" : "en"]}</Text>
      </RecordCard>
    );
  }

  if (payables === undefined) {
    return <RouteLoadingState label={labels.loading} />;
  }

  return (
    <>
      <ModuleList
        data={payables}
        emptyLabel={labels.empty}
        keyExtractor={(payable) => payable._id}
        header={
          <SegmentedControl options={statusOptions} value={statusFilter} onChange={setStatusFilter} />
        }
        renderItem={(payable) => (
          <RecordCard>
            <View style={styles.recordHeader}>
              <Text style={styles.recordTitle}>{payable.sourcedFromName}</Text>
              <Text style={styles.statusPill}>{payable.status}</Text>
            </View>
            <Text style={styles.recordMeta}>{payable.vehicleDesc} · {payable.vehicleVin || "-"}</Text>
            <Text style={styles.recordMeta}>{money(payable.amountDue, locale)} · {payable.customerName || "-"}</Text>
            {payable.status === "PENDING" ? (
              <PrimaryButton label={labels.markPaid} tone="muted" onPress={() => openPay(payable)} />
            ) : null}
          </RecordCard>
        )}
      />
      <FormModal
        title={labels.markSupplierPaid}
        visible={Boolean(selected)}
        onClose={() => setSelected(null)}
      >
        <FormField keyboardType="numeric" label={labels.tax} value={form.taxAmount} onChangeText={(taxAmount) => setForm((prev) => ({ ...prev, taxAmount }))} />
        <FormField multiline label={labels.notes} value={form.notes} onChangeText={(notes) => setForm((prev) => ({ ...prev, notes }))} />
        <PrimaryButton disabled={saving} label={saving ? labels.saving : labels.save} onPress={savePaid} />
      </FormModal>
    </>
  );
}

