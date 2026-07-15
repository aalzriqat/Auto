import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Text, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileSocialConversation, type MobileSocialConversationEvent, type MobileSocialPlatform } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, type Option, compactNumber, dateLabel, useGenericError, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, RecordCard, MetricCard, ModuleList } from "./moduleShared";
import { styles } from "./moduleStyles";

export function SocialInboxModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const replyInstagramComment = useAction(api.instagramEngagement.replyToInstagramComment);
  const sendInstagramDm = useAction(api.instagramEngagement.sendInstagramDirectMessage);
  const replyFacebookComment = useAction(api.facebookEngagement.replyToFacebookComment);
  const sendFacebookDm = useAction(api.facebookEngagement.sendFacebookDirectMessage);
  const linkVehicle = useMutation(api.socialInbox.setConversationVehicle);
  const stats = useQuery(api.socialInbox.platformStats, { orgId });
  const vehicles = useQuery(api.vehicles.listAll, { orgId, includeReserved: true });
  const [platformFilter, setPlatformFilter] = useState<MobileSocialPlatform | "ALL">("ALL");
  const [needsReplyOnly, setNeedsReplyOnly] = useState<"ALL" | "NEEDS">("ALL");
  const { loadMore, results, status } = usePaginatedQuery(
    api.socialInbox.listConversations,
    {
      orgId,
      platform: platformFilter === "ALL" ? undefined : platformFilter,
      needsReply: needsReplyOnly === "NEEDS" ? true : undefined,
    },
    { initialNumItems: PAGE_SIZE },
  );
  const [selected, setSelected] = useState<MobileSocialConversation | null>(null);
  const [replyText, setReplyText] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [saving, setSaving] = useState(false);
  const events = useQuery(
    api.socialInbox.listEventsForConversation,
    selected
      ? {
          orgId,
          customerId: selected.customerId,
          platform: selected.platform,
          conversationKind: selected.conversationKind,
          conversationPostId: selected.conversationPostId ?? undefined,
        }
      : "skip",
  );
  const vehicleOptions = [
    { label: locale === "ar" ? "اختر سيارة" : "Select vehicle", value: "" },
    ...(vehicles ?? []).map((vehicle) => ({ label: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, value: vehicle._id })),
  ];
  const platformOptions: Array<Option<MobileSocialPlatform | "ALL">> = [
    { label: locale === "ar" ? "الكل" : "All", value: "ALL" },
    { label: "Instagram", value: "instagram" },
    { label: "Facebook", value: "facebook" },
  ];

  function openConversation(conversation: MobileSocialConversation) {
    setSelected(conversation);
    setReplyText("");
    setVehicleId("");
  }

  function eventNeedsReply(event: MobileSocialConversationEvent): boolean {
    return !event.autoRepliedAt && !event.manualRepliedAt;
  }

  async function sendReply() {
    if (!selected || !replyText.trim()) return;
    const event = [...(events ?? [])].reverse().find(eventNeedsReply) ?? events?.at(-1);
    setSaving(true);
    try {
      if (selected.platform === "instagram") {
        if (selected.conversationKind === "comment" && event?._id) {
          await replyInstagramComment({ orgId, instagramEventId: event._id, message: replyText });
        } else {
          await sendInstagramDm({ orgId, customerId: selected.customerId, message: replyText });
        }
      } else if (selected.conversationKind === "comment" && event?._id) {
        await replyFacebookComment({ orgId, facebookEventId: event._id, message: replyText });
      } else {
        await sendFacebookDm({ orgId, customerId: selected.customerId, message: replyText });
      }
      setReplyText("");
    } catch (error) {
      reportError("Mobile social reply failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function saveVehicleLink() {
    if (!selected || !vehicleId) return;
    setSaving(true);
    try {
      await linkVehicle({
        orgId,
        customerId: selected.customerId,
        vehicleId,
        platform: selected.platform,
        conversationKind: selected.conversationKind,
        conversationPostId: selected.conversationPostId ?? undefined,
      });
      setVehicleId("");
    } catch (error) {
      reportError("Mobile social vehicle link failed", error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ModuleList
        data={results}
        emptyLabel={locale === "ar" ? "لا توجد محادثات." : "No conversations found."}
        keyExtractor={(conversation) => `${conversation.platform}-${conversation.customerId}-${conversation.conversationKind}-${conversation.conversationPostId ?? "dm"}`}
        loadMore={loadMore}
        status={status}
        header={
          <>
            <View style={styles.metricGrid}>
              <MetricCard title="Instagram" value={compactNumber(stats?.instagram.total ?? 0, locale)} caption={`${stats?.instagram.comments ?? 0} comments · ${stats?.instagram.dms ?? 0} DM`} />
              <MetricCard title="Facebook" value={compactNumber(stats?.facebook.total ?? 0, locale)} caption={`${stats?.facebook.comments ?? 0} comments · ${stats?.facebook.dms ?? 0} DM`} />
            </View>
            <SegmentedControl options={platformOptions} value={platformFilter} onChange={setPlatformFilter} />
            <SegmentedControl
              options={[
                { label: locale === "ar" ? "الكل" : "All", value: "ALL" },
                { label: locale === "ar" ? "بحاجة رد" : "Needs reply", value: "NEEDS" },
              ]}
              value={needsReplyOnly}
              onChange={setNeedsReplyOnly}
            />
          </>
        }
        renderItem={(conversation: MobileSocialConversation) => (
          <RecordCard>
            <View style={styles.recordHeader}>
              <Text style={styles.recordTitle}>{conversation.senderDisplayName}</Text>
              <Text style={styles.statusPill}>{conversation.needsReply ? (locale === "ar" ? "رد" : "Reply") : conversation.platform}</Text>
            </View>
            <Text style={styles.recordMeta}>{conversation.latestText || "-"}</Text>
            <Text style={styles.recordMeta}>{conversation.vehicleSummary || (locale === "ar" ? "بدون سيارة" : "No vehicle")} · {conversation.eventCount}</Text>
            <PrimaryButton label={locale === "ar" ? "فتح" : "Open"} tone="muted" onPress={() => openConversation(conversation)} />
          </RecordCard>
        )}
      />
      <FormModal
        title={selected ? selected.senderDisplayName : (locale === "ar" ? "محادثة" : "Conversation")}
        visible={Boolean(selected)}
        onClose={() => setSelected(null)}
      >
        {events === undefined ? <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} /> : null}
        {(events ?? []).map((event) => (
          <RecordCard key={event._id}>
            <Text style={styles.recordTitle}>{event.senderDisplayName}</Text>
            <Text style={styles.recordMeta}>{event.text || "-"}</Text>
            {event.autoReplyText ? <Text style={styles.warningText}>{locale === "ar" ? "رد تلقائي: " : "Auto: "}{event.autoReplyText}</Text> : null}
            {event.manualReplyText ? <Text style={styles.warningText}>{locale === "ar" ? "رد يدوي: " : "Manual: "}{event.manualReplyText}</Text> : null}
            <Text style={styles.recordMeta}>{dateLabel(event._creationTime, locale)} · {event.vehicleSummary || "-"}</Text>
          </RecordCard>
        ))}
        <SelectField label={locale === "ar" ? "ربط سيارة" : "Link vehicle"} value={vehicleId} options={vehicleOptions} onChange={setVehicleId} />
        <PrimaryButton disabled={saving || !vehicleId} label={locale === "ar" ? "ربط" : "Link"} tone="muted" onPress={saveVehicleLink} />
        <FormField multiline label={locale === "ar" ? "رد" : "Reply"} value={replyText} onChangeText={setReplyText} />
        <PrimaryButton disabled={saving || !replyText.trim()} label={saving ? (locale === "ar" ? "جاري الإرسال..." : "Sending...") : (locale === "ar" ? "إرسال" : "Send")} onPress={sendReply} />
      </FormModal>
    </>
  );
}

