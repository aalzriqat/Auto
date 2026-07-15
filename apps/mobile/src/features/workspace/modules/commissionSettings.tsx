import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Alert, Text } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileOrgSettings } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { money, parseOptionalNumber, splitLinesOrCommas, useGenericError, PrimaryButton, FormField, SelectField, RecordCard, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

export function CommissionSettingsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const settings = useQuery(api.orgSettings.get, { orgId });
  const upsertSettings = useMutation(api.orgSettings.upsert);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<MobileOrgSettings["commissionMode"]>("AUTO_MEMBER");
  const [tiersText, setTiersText] = useState("");
  const [sampleProfit, setSampleProfit] = useState("1000");

  useEffect(() => {
    if (!settings) return;
    setMode(settings.commissionMode ?? "AUTO_MEMBER");
    setTiersText((settings.commissionTiers ?? [])
      .slice()
      .sort((a, b) => a.minProfitAmount - b.minProfitAmount)
      .map((tier) => `${tier.minProfitAmount},${tier.commissionPct}`)
      .join("\n"));
  }, [settings]);

  const parsedTiers = splitLinesOrCommas(tiersText.replace(/\n/g, ","))
    .reduce<Array<{ minProfitAmount: number; commissionPct: number }>>((acc, _part, index, parts) => {
      if (index % 2 !== 0) return acc;
      const minProfitAmount = Number(parts[index]);
      const commissionPct = Number(parts[index + 1]);
      if (Number.isFinite(minProfitAmount) && Number.isFinite(commissionPct)) {
        acc.push({ minProfitAmount, commissionPct });
      }
      return acc;
    }, [])
    .sort((a, b) => a.minProfitAmount - b.minProfitAmount);
  const sample = parseOptionalNumber(sampleProfit) ?? 0;
  const samplePct = parsedTiers.reduce((pct, tier) => (sample >= tier.minProfitAmount ? tier.commissionPct : pct), 0);

  async function save() {
    setSaving(true);
    try {
      await upsertSettings({
        orgId,
        commissionMode: mode,
        commissionTiers: parsedTiers,
      });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile commission settings save failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (settings === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <SelectField
        label={locale === "ar" ? "نظام العمولة" : "Commission mode"}
        value={mode ?? "AUTO_MEMBER"}
        options={[
          { label: "AUTO_MEMBER", value: "AUTO_MEMBER" },
          { label: "AUTO_TIERS", value: "AUTO_TIERS" },
          { label: "MANUAL", value: "MANUAL" },
        ]}
        onChange={(nextMode) => setMode(nextMode as MobileOrgSettings["commissionMode"])}
      />
      <FormField
        multiline
        label={locale === "ar" ? "شرائح العمولة: ربح,نسبة لكل سطر" : "Commission tiers: profit,percent per line"}
        value={tiersText}
        onChangeText={setTiersText}
        placeholder={"0,5\n1000,7.5\n3000,10"}
      />
      <FormField keyboardType="numeric" label={locale === "ar" ? "مثال ربح" : "Sample profit"} value={sampleProfit} onChangeText={setSampleProfit} />
      <RecordCard>
        <Text style={styles.recordTitle}>{locale === "ar" ? "معاينة" : "Preview"}</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "النسبة" : "Rate"}: {samplePct}%</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "العمولة" : "Commission"}: {money((sample * samplePct) / 100, locale)}</Text>
      </RecordCard>
      <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={save} />
    </ModuleScroll>
  );
}

