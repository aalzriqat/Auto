import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobilePlanId } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { money, dateLabel, maybeText, useGenericError, PrimaryButton, FormField, FormModal, RecordCard, ModuleScroll } from "./moduleShared";
import { styles } from "./moduleStyles";

function planRank(planId: MobilePlanId): number {
  const order: MobilePlanId[] = ["free", "starter", "professional", "enterprise"];
  return order.indexOf(planId);
}

function limitLabel(current: number, max: number, locale: "en" | "ar"): string {
  if (max === -1) return `${current} / ${locale === "ar" ? "غير محدود" : "Unlimited"}`;
  return `${current} / ${max}`;
}

export function BillingModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const subscription = useQuery(api.subscriptions.getMySubscription, { orgId });
  const usage = useQuery(api.subscriptions.getUsageStats, { orgId });
  const plans = useQuery(api.subscriptions.getPlans, {});
  const showPricing = useQuery(api.subscriptions.getShowPricing, {});
  const requestUpgrade = useAction(api.subscriptions.requestUpgrade);
  const [targetPlan, setTargetPlan] = useState<MobilePlanId | null>(null);
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function submitUpgrade() {
    if (!targetPlan || !phone.trim()) return;
    setSaving(true);
    try {
      await requestUpgrade({
        orgId,
        targetPlan,
        phone: phone.trim(),
        message: maybeText(message),
      });
      setTargetPlan(null);
      setPhone("");
      setMessage("");
      Alert.alert("AutoFlow", locale === "ar" ? "تم إرسال طلب الترقية" : "Upgrade request sent");
    } catch (error) {
      reportError("Mobile upgrade request failed", error);
    } finally {
      setSaving(false);
    }
  }

  if (subscription === undefined || usage === undefined || plans === undefined || showPricing === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  const orderedPlans = plans.slice().sort((a, b) => planRank(a.id) - planRank(b.id));

  return (
    <ModuleScroll>
      <RecordCard>
        <View style={styles.recordHeader}>
          <Text style={styles.recordTitle}>{locale === "ar" ? subscription.planDetails.nameAr : subscription.planDetails.name}</Text>
          <Text style={styles.statusPill}>{subscription.status}</Text>
        </View>
        <Text style={styles.recordMeta}>{locale === "ar" ? "السيارات" : "Vehicles"}: {limitLabel(usage.vehicleCount, usage.maxVehicles, locale)}</Text>
        <Text style={styles.recordMeta}>{locale === "ar" ? "الأعضاء" : "Members"}: {limitLabel(usage.memberCount, usage.maxUsers, locale)}</Text>
        {subscription.currentPeriodEnd ? <Text style={styles.recordMeta}>{locale === "ar" ? "ينتهي في" : "Renews on"} {dateLabel(subscription.currentPeriodEnd, locale)}</Text> : null}
      </RecordCard>
      {orderedPlans.map((plan) => {
        const current = plan.id === subscription.plan;
        return (
          <RecordCard key={plan.id}>
            <View style={styles.recordHeader}>
              <Text style={styles.recordTitle}>{locale === "ar" ? plan.nameAr : plan.name}</Text>
              <Text style={styles.statusPill}>{current ? (locale === "ar" ? "الحالية" : "CURRENT") : plan.id.toUpperCase()}</Text>
            </View>
            {showPricing ? <Text style={styles.recordMeta}>{money(plan.priceJod, locale)} / {locale === "ar" ? "شهر" : "month"}</Text> : null}
            <Text style={styles.recordMeta}>{limitLabel(0, plan.maxVehicles, locale)} {locale === "ar" ? "سيارة" : "vehicles"} · {limitLabel(0, plan.maxUsers, locale)} {locale === "ar" ? "أعضاء" : "members"}</Text>
            {(locale === "ar" ? plan.featuresAr : plan.features).slice(0, 4).map((feature) => (
              <Text key={feature} style={styles.recordMeta}>- {feature}</Text>
            ))}
            {!current ? (
              <PrimaryButton label={locale === "ar" ? "طلب ترقية" : "Request upgrade"} tone="muted" onPress={() => setTargetPlan(plan.id)} />
            ) : null}
          </RecordCard>
        );
      })}
      <FormModal title={locale === "ar" ? "طلب ترقية" : "Request upgrade"} visible={Boolean(targetPlan)} onClose={() => setTargetPlan(null)}>
        <FormField keyboardType="phone-pad" label={locale === "ar" ? "رقم الهاتف" : "Phone"} value={phone} onChangeText={setPhone} />
        <FormField multiline label={locale === "ar" ? "رسالة" : "Message"} value={message} onChangeText={setMessage} />
        <PrimaryButton disabled={saving || !phone.trim()} label={saving ? (locale === "ar" ? "جاري الإرسال..." : "Submitting...") : (locale === "ar" ? "إرسال" : "Submit")} onPress={submitUpgrade} />
      </FormModal>
    </ModuleScroll>
  );
}

