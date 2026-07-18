import { useMutation, usePaginatedQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { api, type MobileCustomer } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { Icon } from "../../../components/Icon";
import { compactInitials } from "../nativeModules";
import { PAGE_SIZE, compactNumber, maybeText, useGenericError, SearchInput, PrimaryButton, FormField, FormModal, RecordCard, MetricCard, ModuleList, DetailPill } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function CustomersModule({
  highlightId,
  orgId,
  permissions,
}: {
  highlightId?: string;
  orgId: string;
  permissions: readonly string[];
}) {
  const styles = useStyles();
  const router = useRouter();
  const { locale } = useLocale();
  const reportError = useGenericError();
  const canEdit = permissions.includes("edit:customers");
  const createCustomer = useMutation(api.customers.create);
  const deleteCustomer = useMutation(api.customers.softDelete);
  const { loadMore, results, status } = usePaginatedQuery(
    api.customers.list,
    { orgId },
    { initialNumItems: PAGE_SIZE },
  );
  const [search, setSearch] = useState("");
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
    setForm({ firstName: "", lastName: "", phone: "", whatsapp: "", email: "", nationalId: "", address: "" });
    setOpen(true);
  }

  function closeCustomerForm() {
    setOpen(false);
    setForm({ firstName: "", lastName: "", phone: "", whatsapp: "", email: "", nationalId: "", address: "" });
  }

  function openDetail(customer: MobileCustomer) {
    router.push({
      pathname: "/org/[orgId]/customers/[customerId]" as any,
      params: { orgId, customerId: customer._id },
    });
  }

  async function save() {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
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
      setOpen(false);
      setForm({ firstName: "", lastName: "", phone: "", whatsapp: "", email: "", nationalId: "", address: "" });
    } catch (error) {
      reportError("Mobile customer save failed", error);
    } finally {
      setSaving(false);
    }
  }

  function confirmArchive(customer: MobileCustomer) {
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
            } catch (error) {
              reportError("Mobile customer archive failed", error);
            }
          },
        },
      ],
    );
  }

  function openOverflowMenu(customer: MobileCustomer) {
    Alert.alert(
      locale === "ar" ? "خيارات" : "Options",
      "",
      [
        { text: locale === "ar" ? "إلغاء" : "Cancel", style: "cancel" },
        { text: locale === "ar" ? "أرشفة العميل" : "Archive customer", style: "destructive", onPress: () => confirmArchive(customer) },
      ],
    );
  }

  return (
    <>
      <ModuleList
        data={filtered}
        emptyLabel={locale === "ar" ? "لا يوجد عملاء." : "No customers found."}
        highlightId={highlightId}
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
          <Pressable onPress={() => openDetail(customer)}>
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
                <Icon color="mutedText" name="chevronForward" size={18} />
                {canEdit ? (
                  <Pressable
                    accessibilityLabel={locale === "ar" ? "المزيد" : "More options"}
                    accessibilityRole="button"
                    hitSlop={8}
                    style={styles.overflowButton}
                    onPress={() => openOverflowMenu(customer)}
                  >
                    <Icon color="mutedText" name="more" size={20} />
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.detailPillRow}>
                <DetailPill label={customer.phone || (locale === "ar" ? "بدون هاتف" : "No phone")} tone={customer.phone ? "info" : "warning"} />
                <DetailPill label={customer.whatsapp || "WhatsApp"} tone={customer.whatsapp ? "success" : "neutral"} />
                <DetailPill label={customer.email || (locale === "ar" ? "بدون بريد" : "No email")} />
              </View>
            </RecordCard>
          </Pressable>
        )}
      />
      <FormModal
        title={locale === "ar" ? "عميل جديد" : "New customer"}
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
    </>
  );
}
