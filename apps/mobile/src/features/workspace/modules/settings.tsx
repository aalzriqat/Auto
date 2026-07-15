import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileMyMembership, type MobileOrgSummary, type MobileOrgSettings } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { maybeText, parseOptionalNumber, splitLinesOrCommas, joinList, useGenericError, PrimaryButton, FormField, SelectField, RecordCard, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

export function SettingsModule({
  myMembership,
  org,
}: {
  myMembership: MobileMyMembership;
  org: MobileOrgSummary;
}) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const settings = useQuery(api.orgSettings.get, { orgId: org._id });
  const upsertSettings = useMutation(api.orgSettings.upsert);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    dealershipName: "",
    legalCompanyName: "",
    dealershipAddress: "",
    dealershipPhone: "",
    dealershipPhones: "",
    currency: "JOD",
    currencySymbol: "د.أ",
    vatRate: "",
    country: "",
    timezone: "",
    approvalThresholdEnabled: "false",
    approvalMinProfitPercent: "",
    commissionMode: "AUTO_MEMBER",
    generatedLeadAutoAssignmentEnabled: "false",
    reservationHoldDays: "",
  });

  useEffect(() => {
    if (!settings) return;
    const next: MobileOrgSettings = settings;
    setForm({
      dealershipName: next.dealershipName ?? org.name,
      legalCompanyName: next.legalCompanyName ?? "",
      dealershipAddress: next.dealershipAddress ?? "",
      dealershipPhone: next.dealershipPhone ?? "",
      dealershipPhones: joinList(next.dealershipPhones),
      currency: next.currency ?? "JOD",
      currencySymbol: next.currencySymbol ?? "د.أ",
      vatRate: next.vatRate != null ? String(next.vatRate) : "",
      country: next.country ?? "",
      timezone: next.timezone ?? "",
      approvalThresholdEnabled: next.approvalThresholdEnabled ? "true" : "false",
      approvalMinProfitPercent: next.approvalMinProfitPercent != null ? String(next.approvalMinProfitPercent) : "",
      commissionMode: next.commissionMode ?? "AUTO_MEMBER",
      generatedLeadAutoAssignmentEnabled: next.generatedLeadAutoAssignmentEnabled ? "true" : "false",
      reservationHoldDays: next.reservationHoldDays != null ? String(next.reservationHoldDays) : "",
    });
  }, [org.name, settings]);

  async function save() {
    setSaving(true);
    try {
      await upsertSettings({
        orgId: org._id,
        dealershipName: maybeText(form.dealershipName),
        legalCompanyName: maybeText(form.legalCompanyName),
        dealershipAddress: maybeText(form.dealershipAddress),
        dealershipPhone: maybeText(form.dealershipPhone),
        dealershipPhones: splitLinesOrCommas(form.dealershipPhones),
        currency: maybeText(form.currency),
        currencySymbol: maybeText(form.currencySymbol),
        vatRate: parseOptionalNumber(form.vatRate),
        country: maybeText(form.country),
        timezone: maybeText(form.timezone),
        approvalThresholdEnabled: form.approvalThresholdEnabled === "true",
        approvalMinProfitPercent: parseOptionalNumber(form.approvalMinProfitPercent),
        commissionMode: form.commissionMode as "AUTO_TIERS" | "AUTO_MEMBER" | "MANUAL",
        generatedLeadAutoAssignmentEnabled: form.generatedLeadAutoAssignmentEnabled === "true",
        reservationHoldDays: parseOptionalNumber(form.reservationHoldDays),
      });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile settings save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (settings === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <RecordCard>
        <Text style={styles.recordTitle}>{org.name}</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "دورك" : "Your role"}: {myMembership.roleName}</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "عدد الصلاحيات" : "Permissions"}: {myMembership.permissions.length}</Text>
      </RecordCard>
      <Text style={styles.sectionTitle}>{locale === "ar" ? "الإعدادات العامة" : "General settings"}</Text>
      <FormField label={locale === "ar" ? "اسم المعرض" : "Dealership name"} value={form.dealershipName} onChangeText={(dealershipName) => setForm((prev) => ({ ...prev, dealershipName }))} />
      <FormField label={locale === "ar" ? "الشركة القانونية" : "Legal company name"} value={form.legalCompanyName} onChangeText={(legalCompanyName) => setForm((prev) => ({ ...prev, legalCompanyName }))} />
      <FormField multiline label={locale === "ar" ? "العنوان" : "Address"} value={form.dealershipAddress} onChangeText={(dealershipAddress) => setForm((prev) => ({ ...prev, dealershipAddress }))} />
      <FormField keyboardType="phone-pad" label={locale === "ar" ? "الهاتف" : "Phone"} value={form.dealershipPhone} onChangeText={(dealershipPhone) => setForm((prev) => ({ ...prev, dealershipPhone }))} />
      <FormField multiline label={locale === "ar" ? "هواتف إضافية" : "Additional phones"} value={form.dealershipPhones} onChangeText={(dealershipPhones) => setForm((prev) => ({ ...prev, dealershipPhones }))} />
      <FormField label={locale === "ar" ? "العملة" : "Currency"} value={form.currency} onChangeText={(currency) => setForm((prev) => ({ ...prev, currency }))} />
      <FormField label={locale === "ar" ? "رمز العملة" : "Currency symbol"} value={form.currencySymbol} onChangeText={(currencySymbol) => setForm((prev) => ({ ...prev, currencySymbol }))} />
      <FormField keyboardType="numeric" label={locale === "ar" ? "ضريبة القيمة المضافة" : "VAT rate"} value={form.vatRate} onChangeText={(vatRate) => setForm((prev) => ({ ...prev, vatRate }))} />
      <FormField label={locale === "ar" ? "الدولة" : "Country"} value={form.country} onChangeText={(country) => setForm((prev) => ({ ...prev, country }))} />
      <FormField label={locale === "ar" ? "المنطقة الزمنية" : "Timezone"} value={form.timezone} onChangeText={(timezone) => setForm((prev) => ({ ...prev, timezone }))} />
      <SelectField label={locale === "ar" ? "تفعيل موافقات هامش الربح" : "Approval threshold"} value={form.approvalThresholdEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(approvalThresholdEnabled) => setForm((prev) => ({ ...prev, approvalThresholdEnabled }))} />
      <FormField keyboardType="numeric" label={locale === "ar" ? "أقل ربح %" : "Min profit %"} value={form.approvalMinProfitPercent} onChangeText={(approvalMinProfitPercent) => setForm((prev) => ({ ...prev, approvalMinProfitPercent }))} />
      <SelectField
        label={locale === "ar" ? "نظام العمولة" : "Commission mode"}
        value={form.commissionMode}
        options={[
          { label: "AUTO_MEMBER", value: "AUTO_MEMBER" },
          { label: "AUTO_TIERS", value: "AUTO_TIERS" },
          { label: "MANUAL", value: "MANUAL" },
        ]}
        onChange={(commissionMode) => setForm((prev) => ({ ...prev, commissionMode }))}
      />
      <SelectField label={locale === "ar" ? "تعيين العملاء تلقائياً" : "Auto-assign generated leads"} value={form.generatedLeadAutoAssignmentEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(generatedLeadAutoAssignmentEnabled) => setForm((prev) => ({ ...prev, generatedLeadAutoAssignmentEnabled }))} />
      <FormField keyboardType="numeric" label={locale === "ar" ? "أيام الحجز" : "Reservation hold days"} value={form.reservationHoldDays} onChangeText={(reservationHoldDays) => setForm((prev) => ({ ...prev, reservationHoldDays }))} />
      <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
      <Text style={styles.sectionTitle}>{locale === "ar" ? "الصلاحيات" : "Permissions"}</Text>
      {myMembership.permissions.map((permission) => (
        <View key={permission} style={styles.permissionRow}>
          <Text style={styles.permissionText}>{permission}</Text>
        </View>
      ))}
    </ModuleScroll>
  );
}

