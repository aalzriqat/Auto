import { useMutation, usePaginatedQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { api, type MobileCustomer } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { compactInitials } from "../nativeModules";
import { PAGE_SIZE, compactNumber, maybeText, useGenericError, SearchInput, PrimaryButton, FormField, FormModal, RecordCard, MetricCard, ModuleList, DetailPill } from "./moduleShared";
import { styles } from "./moduleStyles";
import { CustomerDetailSheet } from "./customerDetail";

export function CustomersModule({ orgId, permissions }: { orgId: string; permissions: readonly string[] }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createCustomer = useMutation(api.customers.create);
  const updateCustomer = useMutation(api.customers.update);
  const deleteCustomer = useMutation(api.customers.softDelete);
  const { loadMore, results, status } = usePaginatedQuery(
    api.customers.list,
    { orgId },
    { initialNumItems: PAGE_SIZE },
  );
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MobileCustomer | null>(null);
  const [detailCustomer, setDetailCustomer] = useState<MobileCustomer | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    whatsapp: "",
    email: "",
    nationalId: "",
    address: "",
  });
  const [saving, setSaving] = useState(false);
  const filtered = results.filter((customer) => {
    const haystack = `${customer.firstName} ${customer.lastName} ${customer.phone ?? ""} ${customer.email ?? ""}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });
  const customersWithPhone = filtered.filter((customer) => Boolean(customer.phone || customer.whatsapp)).length;
  const customersWithEmail = filtered.filter((customer) => Boolean(customer.email)).length;

  function openCreate() {
    setEditing(null);
    setDetailCustomer(null);
    setForm({ firstName: "", lastName: "", phone: "", whatsapp: "", email: "", nationalId: "", address: "" });
    setOpen(true);
  }

  function openEdit(customer: MobileCustomer) {
    setEditing(customer);
    setDetailCustomer(null);
    setForm({
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone ?? "",
      whatsapp: customer.whatsapp ?? "",
      email: customer.email ?? "",
      nationalId: customer.nationalId ?? "",
      address: customer.address ?? "",
    });
    setOpen(true);
  }

  function closeCustomerForm() {
    setEditing(null);
    setOpen(false);
    setForm({ firstName: "", lastName: "", phone: "", whatsapp: "", email: "", nationalId: "", address: "" });
  }

  async function save() {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateCustomer({
          orgId,
          customerId: editing._id,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: maybeText(form.phone),
          whatsapp: maybeText(form.whatsapp),
          email: maybeText(form.email),
          nationalId: maybeText(form.nationalId),
          address: maybeText(form.address),
        });
      } else {
        await createCustomer({
          orgId,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: maybeText(form.phone),
          whatsapp: maybeText(form.whatsapp),
          email: maybeText(form.email),
          nationalId: maybeText(form.nationalId),
          address: maybeText(form.address),
        });
      }
      setEditing(null);
      setOpen(false);
      setForm({ firstName: "", lastName: "", phone: "", whatsapp: "", email: "", nationalId: "", address: "" });
    } catch (error) {
      reportError("Mobile customer save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(customer: MobileCustomer, onSuccess?: () => void) {
    Alert.alert(
      locale === "ar" ? "أرشفة العميل؟" : "Archive customer?",
      `${customer.firstName} ${customer.lastName}`,
      [
        { text: locale === "ar" ? "إلغاء" : "Cancel", style: "cancel" },
        {
          text: locale === "ar" ? "أرشفة" : "Archive",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteCustomer({ orgId, customerId: customer._id });
              onSuccess?.();
            } catch (error) {
              reportError("Mobile customer archive failed", error);
            }
          },
        },
      ],
    );
  }

  return (
    <>
      <ModuleList
        data={filtered}
        emptyLabel={locale === "ar" ? "لا يوجد عملاء." : "No customers found."}
        keyExtractor={(customer) => customer._id}
        loadMore={loadMore}
        status={status}
        header={
          <>
            <View style={styles.actionRow}>
              <SearchInput
                placeholder={locale === "ar" ? "بحث العملاء" : "Search customers"}
                value={search}
                onChangeText={setSearch}
              />
              <PrimaryButton label={locale === "ar" ? "إضافة" : "Add"} onPress={openCreate} />
            </View>
            <View style={styles.metricGrid}>
              <MetricCard title={locale === "ar" ? "النتائج" : "Results"} value={compactNumber(filtered.length, locale)} caption={locale === "ar" ? "عملاء ظاهرون" : "visible customers"} />
              <MetricCard title={locale === "ar" ? "هاتف" : "Phone"} value={compactNumber(customersWithPhone, locale)} caption={locale === "ar" ? "جاهز للتواصل" : "call-ready"} />
              <MetricCard title={locale === "ar" ? "بريد" : "Email"} value={compactNumber(customersWithEmail, locale)} caption={locale === "ar" ? "للمتابعة" : "for follow-up"} />
              <MetricCard title={locale === "ar" ? "النقص" : "Gaps"} value={compactNumber(Math.max(0, filtered.length - customersWithPhone), locale)} caption={locale === "ar" ? "بدون هاتف" : "missing phone"} />
            </View>
          </>
        }
        renderItem={(customer) => (
          <RecordCard>
            <View style={styles.entityHeader}>
              <View style={styles.entityAvatar}>
                <Text style={styles.entityAvatarText}>
                  {compactInitials(`${customer.firstName} ${customer.lastName}`)}
                </Text>
              </View>
              <View style={styles.entityText}>
                <Text style={styles.recordTitle}>{customer.firstName} {customer.lastName}</Text>
                <Text style={styles.recordMeta}>{customer.address || customer.source || (locale === "ar" ? "بدون عنوان" : "No address")}</Text>
              </View>
            </View>
            <View style={styles.detailPillRow}>
              <DetailPill label={customer.phone || (locale === "ar" ? "بدون هاتف" : "No phone")} tone={customer.phone ? "info" : "warning"} />
              <DetailPill label={customer.whatsapp || "WhatsApp"} tone={customer.whatsapp ? "success" : "neutral"} />
              <DetailPill label={customer.email || (locale === "ar" ? "بدون بريد" : "No email")} />
            </View>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailCustomer(customer)} />
              <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(customer)} />
              <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => remove(customer)} />
            </View>
          </RecordCard>
        )}
      />
      <FormModal
        title={editing ? (locale === "ar" ? "تعديل العميل" : "Edit customer") : (locale === "ar" ? "عميل جديد" : "New customer")}
        visible={open}
        onClose={closeCustomerForm}
      >
        <FormField label={locale === "ar" ? "الاسم الأول" : "First name"} value={form.firstName} onChangeText={(firstName) => setForm((prev) => ({ ...prev, firstName }))} />
        <FormField label={locale === "ar" ? "اسم العائلة" : "Last name"} value={form.lastName} onChangeText={(lastName) => setForm((prev) => ({ ...prev, lastName }))} />
        <FormField keyboardType="phone-pad" label={locale === "ar" ? "الهاتف" : "Phone"} value={form.phone} onChangeText={(phone) => setForm((prev) => ({ ...prev, phone }))} />
        <FormField keyboardType="phone-pad" label={locale === "ar" ? "واتساب" : "WhatsApp"} value={form.whatsapp} onChangeText={(whatsapp) => setForm((prev) => ({ ...prev, whatsapp }))} />
        <FormField keyboardType="email-address" label={locale === "ar" ? "البريد" : "Email"} value={form.email} onChangeText={(email) => setForm((prev) => ({ ...prev, email }))} />
        <FormField label={locale === "ar" ? "الرقم الوطني" : "National ID"} value={form.nationalId} onChangeText={(nationalId) => setForm((prev) => ({ ...prev, nationalId }))} />
        <FormField multiline label={locale === "ar" ? "العنوان" : "Address"} value={form.address} onChangeText={(address) => setForm((prev) => ({ ...prev, address }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      </FormModal>
      <CustomerDetailSheet
        orgId={orgId}
        permissions={permissions}
        customer={detailCustomer}
        onArchive={(target) => remove(target, () => setDetailCustomer(null))}
        onClose={() => setDetailCustomer(null)}
        onEdit={(target) => openEdit(target)}
      />
    </>
  );
}

