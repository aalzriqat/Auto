import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Alert, Text } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileMarketplaceDealerProfile } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { maybeText, splitLinesOrCommas, useGenericError, PrimaryButton, FormField, SelectField, RecordCard, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

export function MarketplaceSettingsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const profile = useQuery(api.marketplaceDealers.getMyProfile, { orgId });
  const updateProfile = useMutation(api.marketplaceDealers.updateProfile);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    isOptedIn: "false",
    areas: "",
    brandsCarried: "",
    whatsappNumber: "",
  });

  useEffect(() => {
    if (profile === undefined) return;
    const next: MobileMarketplaceDealerProfile | null = profile;
    setForm({
      isOptedIn: next?.isOptedIn ? "true" : "false",
      areas: (next?.areas ?? []).join(", "),
      brandsCarried: (next?.brandsCarried ?? []).join(", "),
      whatsappNumber: next?.whatsappNumber ?? "",
    });
  }, [profile]);

  async function save() {
    setSaving(true);
    try {
      await updateProfile({
        orgId,
        isOptedIn: form.isOptedIn === "true",
        areas: splitLinesOrCommas(form.areas),
        brandsCarried: splitLinesOrCommas(form.brandsCarried),
        whatsappNumber: maybeText(form.whatsappNumber),
      });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile marketplace settings save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (profile === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <RecordCard>
        <Text style={styles.recordTitle}>{locale === "ar" ? "باقة السوق" : "Marketplace tier"}</Text>
        <Text style={styles.recordMeta}>{profile?.tier ?? "FREE_FOUNDING"} · {(profile?.leadsUsedThisPeriod ?? 0)}/{profile?.leadQuota ?? "-"}</Text>
      </RecordCard>
      <SelectField label={locale === "ar" ? "الظهور في السوق" : "Opted in"} value={form.isOptedIn} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(isOptedIn) => setForm((prev) => ({ ...prev, isOptedIn }))} />
      <FormField multiline label={locale === "ar" ? "المناطق" : "Areas"} value={form.areas} onChangeText={(areas) => setForm((prev) => ({ ...prev, areas }))} />
      <FormField multiline label={locale === "ar" ? "الماركات" : "Brands carried"} value={form.brandsCarried} onChangeText={(brandsCarried) => setForm((prev) => ({ ...prev, brandsCarried }))} />
      <FormField keyboardType="phone-pad" label={locale === "ar" ? "واتساب" : "WhatsApp"} value={form.whatsappNumber} onChangeText={(whatsappNumber) => setForm((prev) => ({ ...prev, whatsappNumber }))} />
      <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
    </ModuleScroll>
  );
}

