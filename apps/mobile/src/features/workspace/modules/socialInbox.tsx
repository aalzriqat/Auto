import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../../../components/Icon";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileSocialConversation, type MobileSocialConversationEvent, type MobileSocialPlatform } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { compactInitials } from "../nativeModules";
import { PAGE_SIZE, compactNumber, relativeTimeLabel, useGenericError, PrimaryButton, FormField, SelectField, FormModal, ModuleList } from "./moduleShared";
import { useStyles } from "./moduleStyles";

function FilterChip({
  label,
  onPress,
  selected,
}: Readonly<{ label: string; onPress: () => void; selected: boolean }>) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
      onPress={onPress}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function ConversationRow({
  conversation,
  onPress,
}: Readonly<{
  conversation: MobileSocialConversation;
  onPress: () => void;
}>) {
  const { locale, textDirection } = useLocale();
  const styles = useStyles();
  const platformLabel = conversation.platform === "instagram" ? "Instagram" : "Facebook";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={conversation.senderDisplayName}
      style={({ pressed }) => [styles.inboxRow, { direction: textDirection }, pressed && styles.pressed]}
      onPress={onPress}
    >
      <View style={styles.conversationAvatar}>
        <Text style={styles.conversationAvatarText}>
          {compactInitials(conversation.senderDisplayName)}
        </Text>
        {conversation.needsReply ? <View style={styles.unreadDot} /> : null}
      </View>
      <View style={styles.inboxRowBody}>
        <View style={styles.recordHeader}>
          <Text numberOfLines={1} style={styles.conversationTitle}>
            {conversation.senderDisplayName}
          </Text>
          <Text style={styles.conversationTime}>
            {relativeTimeLabel(conversation.latestCreationTime, locale)}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.conversationPreview}>
          {conversation.latestText || (locale === "ar" ? "بدون نص" : "No message text")}
        </Text>
        <View style={styles.detailPillRow}>
          {conversation.needsReply ? (
            <View style={[styles.detailPill, styles.detailPillWarning]}>
              <Text style={styles.detailPillText}>{locale === "ar" ? "بحاجة رد" : "Needs reply"}</Text>
            </View>
          ) : null}
          {conversation.leadStage ? (
            <View style={[styles.detailPill, styles.detailPillSuccess]}>
              <Text style={styles.detailPillText}>{conversation.leadStage}</Text>
            </View>
          ) : null}
          <View style={styles.detailPill}>
            <Text style={styles.detailPillText}>{platformLabel}</Text>
          </View>
          {conversation.vehicleSummary ? (
            <View style={[styles.detailPill, styles.detailPillInfo]}>
              <Text numberOfLines={1} style={styles.detailPillText}>{conversation.vehicleSummary}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function EventThread({
  events,
  locale,
}: Readonly<{
  events: readonly MobileSocialConversationEvent[];
  locale: string;
}>) {
  const styles = useStyles();
  return (
    <View style={styles.threadContent}>
      {events.map((event) => (
        <View key={event._id} style={styles.threadEventGroup}>
          {event.text ? (
            <View style={styles.messageRow}>
              <View style={[styles.messageBubble, styles.messageBubbleOther]}>
                <Text style={styles.messageSender}>{event.senderDisplayName}</Text>
                <Text style={styles.messageBody}>{event.text}</Text>
                <Text style={styles.messageMeta}>
                  {relativeTimeLabel(event._creationTime, locale as "en" | "ar")}
                </Text>
              </View>
            </View>
          ) : null}
          {event.autoReplyText ? (
            <View style={[styles.messageRow, styles.messageRowMine]}>
              <View style={[styles.messageBubble, styles.messageBubbleMine]}>
                <Text style={[styles.messageBody, styles.messageBodyMine]}>{event.autoReplyText}</Text>
                <Text style={[styles.messageMeta, styles.messageMetaMine]}>
                  {locale === "ar" ? "رد تلقائي" : "Auto-reply"}
                </Text>
              </View>
            </View>
          ) : null}
          {event.manualReplyText ? (
            <View style={[styles.messageRow, styles.messageRowMine]}>
              <View style={[styles.messageBubble, styles.messageBubbleMine]}>
                <Text style={[styles.messageBody, styles.messageBodyMine]}>{event.manualReplyText}</Text>
                <Text style={[styles.messageMeta, styles.messageMetaMine]}>
                  {event.manualRepliedByName || (locale === "ar" ? "رد يدوي" : "Manual reply")}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function SocialInboxModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
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
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const { loadMore, results, status } = usePaginatedQuery(
    api.socialInbox.listConversations,
    {
      orgId,
      platform: platformFilter === "ALL" ? undefined : platformFilter,
      needsReply: needsReplyOnly ? true : undefined,
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
  const totalConversations = (stats?.instagram.total ?? 0) + (stats?.facebook.total ?? 0);
  const needsReplyLoaded = results.filter((conversation) => conversation.needsReply).length;

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
            <View style={styles.inboxCounterRow}>
              <View style={[styles.detailPill, styles.detailPillSuccess]}>
                <Text style={styles.detailPillText}>
                  {compactNumber(totalConversations, locale)} {locale === "ar" ? "محادثة نشطة" : "active chats"}
                </Text>
              </View>
              {needsReplyLoaded > 0 ? (
                <View style={[styles.detailPill, styles.detailPillWarning]}>
                  <Text style={styles.detailPillText}>
                    {compactNumber(needsReplyLoaded, locale)} {locale === "ar" ? "بحاجة رد" : "need reply"}
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={styles.chipRow}>
              <FilterChip
                label={locale === "ar" ? "الكل" : "All"}
                selected={platformFilter === "ALL"}
                onPress={() => setPlatformFilter("ALL")}
              />
              <FilterChip
                label="Instagram"
                selected={platformFilter === "instagram"}
                onPress={() => setPlatformFilter("instagram")}
              />
              <FilterChip
                label="Facebook"
                selected={platformFilter === "facebook"}
                onPress={() => setPlatformFilter("facebook")}
              />
              <FilterChip
                label={locale === "ar" ? "بحاجة رد" : "Needs reply"}
                selected={needsReplyOnly}
                onPress={() => setNeedsReplyOnly((value) => !value)}
              />
            </View>
          </>
        }
        renderItem={(conversation: MobileSocialConversation) => (
          <ConversationRow conversation={conversation} onPress={() => openConversation(conversation)} />
        )}
      />
      <FormModal
        title={selected ? selected.senderDisplayName : (locale === "ar" ? "محادثة" : "Conversation")}
        visible={Boolean(selected)}
        onClose={() => setSelected(null)}
      >
        {events === undefined ? (
          <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />
        ) : (
          <EventThread events={events} locale={locale} />
        )}
        <View style={styles.leadContextCard}>
          <View style={styles.leadContextHeader}>
            <Icon color="primary" name="vehicles" size={18} />
            <Text style={styles.leadContextTitle}>
              {locale === "ar" ? "السيارة المطلوبة" : "Interested vehicle"}
            </Text>
          </View>
          <Text style={styles.leadContextValue}>
            {selected?.vehicleSummary || (locale === "ar" ? "لم يتم الربط بعد" : "Not linked yet")}
          </Text>
          <SelectField
            label={locale === "ar" ? "ربط سيارة" : "Link vehicle"}
            value={vehicleId}
            options={vehicleOptions}
            onChange={setVehicleId}
          />
          <PrimaryButton
            disabled={saving || !vehicleId}
            label={locale === "ar" ? "ربط" : "Link"}
            tone="muted"
            onPress={saveVehicleLink}
          />
        </View>
        <FormField multiline label={locale === "ar" ? "رد" : "Reply"} value={replyText} onChangeText={setReplyText} />
        <PrimaryButton
          disabled={saving || !replyText.trim()}
          label={saving ? (locale === "ar" ? "جاري الإرسال..." : "Sending...") : (locale === "ar" ? "إرسال" : "Send")}
          onPress={sendReply}
        />
      </FormModal>
    </>
  );
}
