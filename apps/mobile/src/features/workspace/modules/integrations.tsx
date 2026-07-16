import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileFacebookConnectionStatus, type MobileInstagramConnectionStatus } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { maybeText, splitLinesOrCommas, joinList, useGenericError, PrimaryButton, FormField, SelectField, RecordCard, ModuleScroll, LockedFeature } from "./moduleShared";
import { styles } from "./moduleStyles";

function IntegrationPlatformCard({
  facebook,
  instagram,
  orgId,
}: {
  facebook: MobileFacebookConnectionStatus;
  instagram: MobileInstagramConnectionStatus;
  orgId: string;
}) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const saveInstagramReply = useMutation(api.socialIntegrations.setInstagramAutoReplyConfig);
  const saveInstagramLead = useMutation(api.socialIntegrations.setInstagramLeadCreationConfig);
  const saveFacebookReply = useMutation(api.facebookIntegrations.setFacebookAutoReplyConfig);
  const saveFacebookLead = useMutation(api.facebookIntegrations.setFacebookLeadCreationConfig);
  const setAutoPostEnabled = useMutation(api.socialIntegrations.setAutoPostEnabled);
  const [saving, setSaving] = useState(false);
  const [instagramForm, setInstagramForm] = useState({
    enabledForDms: instagram.instagramAutoReplyForDmsEnabled ? "true" : "false",
    enabledForComments: instagram.instagramAutoReplyForCommentsEnabled ? "true" : "false",
    messages: joinList(instagram.instagramAutoReplyMessages),
    mobileReceivedMessage: instagram.instagramAutoReplyMobileReceivedMessage ?? "",
    leadFromCommentsEnabled: instagram.instagramLeadFromCommentsEnabled ? "true" : "false",
    leadFromDmsEnabled: instagram.instagramLeadFromDmsEnabled ? "true" : "false",
    leadFromDmsRequiresMobile: instagram.instagramLeadFromDmsRequiresMobile ? "true" : "false",
    socialAutoPostEnabled: instagram.socialAutoPostEnabled ? "true" : "false",
  });
  const [facebookForm, setFacebookForm] = useState({
    enabledForDms: facebook.facebookAutoReplyForDmsEnabled ? "true" : "false",
    enabledForComments: facebook.facebookAutoReplyForCommentsEnabled ? "true" : "false",
    messages: joinList(facebook.facebookAutoReplyMessages),
    mobileReceivedMessage: facebook.facebookAutoReplyMobileReceivedMessage ?? "",
    leadFromCommentsEnabled: facebook.facebookLeadFromCommentsEnabled ? "true" : "false",
    leadFromDmsEnabled: facebook.facebookLeadFromDmsEnabled ? "true" : "false",
    leadFromDmsRequiresMobile: facebook.facebookLeadFromDmsRequiresMobile ? "true" : "false",
  });

  async function saveInstagram() {
    setSaving(true);
    try {
      await saveInstagramReply({
        orgId,
        enabledForDms: instagramForm.enabledForDms === "true",
        enabledForComments: instagramForm.enabledForComments === "true",
        messages: splitLinesOrCommas(instagramForm.messages),
        mobileReceivedMessage: maybeText(instagramForm.mobileReceivedMessage),
      });
      await saveInstagramLead({
        orgId,
        leadFromCommentsEnabled: instagramForm.leadFromCommentsEnabled === "true",
        leadFromDmsEnabled: instagramForm.leadFromDmsEnabled === "true",
        leadFromDmsRequiresMobile: instagramForm.leadFromDmsRequiresMobile === "true",
      });
      await setAutoPostEnabled({ orgId, enabled: instagramForm.socialAutoPostEnabled === "true" });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile Instagram integration save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function saveFacebook() {
    setSaving(true);
    try {
      await saveFacebookReply({
        orgId,
        enabledForDms: facebookForm.enabledForDms === "true",
        enabledForComments: facebookForm.enabledForComments === "true",
        messages: splitLinesOrCommas(facebookForm.messages),
        mobileReceivedMessage: maybeText(facebookForm.mobileReceivedMessage),
      });
      await saveFacebookLead({
        orgId,
        leadFromCommentsEnabled: facebookForm.leadFromCommentsEnabled === "true",
        leadFromDmsEnabled: facebookForm.leadFromDmsEnabled === "true",
        leadFromDmsRequiresMobile: facebookForm.leadFromDmsRequiresMobile === "true",
      });
      Alert.alert("AutoFlow", locale === "ar" ? "تم الحفظ" : "Saved");
    } catch (error) {
      reportError("Mobile Facebook integration save failed", error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <RecordCard>
        <View style={styles.recordHeader}>
          <Text style={styles.recordTitle}>Instagram</Text>
          <Text style={styles.statusPill}>{instagram.instagramConnected ? "CONNECTED" : "NOT CONNECTED"}</Text>
        </View>
        <Text style={styles.recordMeta}>{instagram.instagramPageName || "-"}</Text>
        <SelectField label={locale === "ar" ? "الرد على الرسائل" : "Reply to DMs"} value={instagramForm.enabledForDms} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(enabledForDms) => setInstagramForm((prev) => ({ ...prev, enabledForDms }))} />
        <SelectField label={locale === "ar" ? "الرد على التعليقات" : "Reply to comments"} value={instagramForm.enabledForComments} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(enabledForComments) => setInstagramForm((prev) => ({ ...prev, enabledForComments }))} />
        <FormField multiline label={locale === "ar" ? "رسائل الرد" : "Reply messages"} value={instagramForm.messages} onChangeText={(messages) => setInstagramForm((prev) => ({ ...prev, messages }))} />
        <FormField label={locale === "ar" ? "رسالة طلب رقم الهاتف" : "Mobile request message"} value={instagramForm.mobileReceivedMessage} onChangeText={(mobileReceivedMessage) => setInstagramForm((prev) => ({ ...prev, mobileReceivedMessage }))} />
        <SelectField label={locale === "ar" ? "إنشاء عملاء من التعليقات" : "Create leads from comments"} value={instagramForm.leadFromCommentsEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(leadFromCommentsEnabled) => setInstagramForm((prev) => ({ ...prev, leadFromCommentsEnabled }))} />
        <SelectField label={locale === "ar" ? "النشر التلقائي" : "Auto-post inventory"} value={instagramForm.socialAutoPostEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(socialAutoPostEnabled) => setInstagramForm((prev) => ({ ...prev, socialAutoPostEnabled }))} />
        <PrimaryButton disabled={saving} label={locale === "ar" ? "حفظ إنستغرام" : "Save Instagram"} onPress={saveInstagram} />
      </RecordCard>
      <RecordCard>
        <View style={styles.recordHeader}>
          <Text style={styles.recordTitle}>Facebook</Text>
          <Text style={styles.statusPill}>{facebook.facebookConnected ? "CONNECTED" : "NOT CONNECTED"}</Text>
        </View>
        <Text style={styles.recordMeta}>{facebook.facebookPageName || "-"}</Text>
        <SelectField label={locale === "ar" ? "الرد على الرسائل" : "Reply to DMs"} value={facebookForm.enabledForDms} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(enabledForDms) => setFacebookForm((prev) => ({ ...prev, enabledForDms }))} />
        <SelectField label={locale === "ar" ? "الرد على التعليقات" : "Reply to comments"} value={facebookForm.enabledForComments} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(enabledForComments) => setFacebookForm((prev) => ({ ...prev, enabledForComments }))} />
        <FormField multiline label={locale === "ar" ? "رسائل الرد" : "Reply messages"} value={facebookForm.messages} onChangeText={(messages) => setFacebookForm((prev) => ({ ...prev, messages }))} />
        <SelectField label={locale === "ar" ? "إنشاء عملاء من الرسائل" : "Create leads from DMs"} value={facebookForm.leadFromDmsEnabled} options={[{ label: locale === "ar" ? "نعم" : "Yes", value: "true" }, { label: locale === "ar" ? "لا" : "No", value: "false" }]} onChange={(leadFromDmsEnabled) => setFacebookForm((prev) => ({ ...prev, leadFromDmsEnabled }))} />
        <PrimaryButton disabled={saving} label={locale === "ar" ? "حفظ فيسبوك" : "Save Facebook"} onPress={saveFacebook} />
      </RecordCard>
    </>
  );
}

export function IntegrationsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const subscription = useQuery(api.subscriptions.getMySubscription, { orgId });
  const canUseSocial = subscription?.planDetails.gates.socialInbox === true;
  const instagram = useQuery(api.socialIntegrations.getConnectionStatus, canUseSocial ? { orgId } : "skip");
  const facebook = useQuery(api.facebookIntegrations.getConnectionStatus, canUseSocial ? { orgId } : "skip");

  if (subscription === undefined || (canUseSocial && (instagram === undefined || facebook === undefined))) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  if (!canUseSocial) {
    return <LockedFeature feature={locale === "ar" ? "الربط الاجتماعي" : "Social integrations"} />;
  }

  if (!instagram || !facebook) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      <IntegrationPlatformCard facebook={facebook} instagram={instagram} orgId={orgId} />
    </ModuleScroll>
  );
}

