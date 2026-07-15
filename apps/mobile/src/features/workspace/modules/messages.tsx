import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileDirectConversation, type MobileDirectMember, type MobileDirectMessage } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { theme } from "../../../theme";
import { compactInitials } from "../nativeModules";
import { relativeTimeLabel, directConversationTitle, isPaginationLoading, canLoadMore, useGenericError, SearchInput, PrimaryButton, FormField, FormModal, EmptyList } from "./moduleShared";
import { styles } from "./moduleStyles";

export function MessagesModule({ orgId }: { orgId: string }) {
  const { locale, textDirection } = useLocale();
  const reportError = useGenericError();
  const me = useQuery(api.users.getMe, {});
  const conversations = useQuery(api.directMessages.listConversations, { orgId });
  const members = useQuery(api.directMessages.getOrgMembers, { orgId });
  const getOrCreateDm = useMutation(api.directMessages.getOrCreateDm);
  const createGroup = useMutation(api.directMessages.createGroup);
  const sendDirectMessage = useMutation(api.directMessages.sendMessage);
  const markDelivered = useMutation(api.directMessages.markDelivered);
  const markRead = useMutation(api.directMessages.markRead);
  const setTyping = useMutation(api.directMessages.setTyping);
  const setMuted = useMutation(api.directMessages.setMuted);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [composerMode, setComposerMode] = useState<"dm" | "group" | null>(null);
  const [groupName, setGroupName] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedConversation = useQuery(
    api.directMessages.getConversation,
    selectedId ? { conversationId: selectedId } : "skip",
  );
  const {
    loadMore: loadMoreMessages,
    results: messages,
    status: messageStatus,
  } = usePaginatedQuery(
    api.directMessages.listMessages,
    selectedId ? { conversationId: selectedId } : "skip",
    { initialNumItems: 40 },
  );
  const safeConversations = conversations ?? [];
  const filteredConversations = safeConversations.filter((conversation) => {
    const title = directConversationTitle(conversation, me?._id, locale === "ar" ? "محادثة" : "Conversation");
    const preview = conversation.lastMessageBody ?? "";
    const query = search.trim().toLowerCase();
    return !query || `${title} ${preview}`.toLowerCase().includes(query);
  });
  const availableMembers = (members ?? []).filter((member) => {
    const query = memberSearch.trim().toLowerCase();
    return !query || `${member.name} ${member.email ?? ""} ${member.roleName ?? ""}`.toLowerCase().includes(query);
  });
  const activeConversation =
    selectedConversation ?? safeConversations.find((conversation) => conversation._id === selectedId) ?? null;
  const chronologicalMessages = [...messages].reverse();
  const typingNames = (activeConversation?.typingUsers ?? [])
    .filter((typingUser): typingUser is NonNullable<typeof typingUser> => Boolean(typingUser))
    .map((typingUser) => typingUser.name);

  useEffect(() => {
    if (!selectedId && safeConversations[0]) {
      setSelectedId(safeConversations[0]._id);
    }
  }, [safeConversations, selectedId]);

  useEffect(() => {
    if (!me || !conversations) return;
    for (const conversation of conversations) {
      if (
        conversation.lastMessageSenderId &&
        conversation.lastMessageSenderId !== me._id &&
        (conversation.lastDeliveredAt ?? 0) < conversation.lastMessageAt
      ) {
        markDelivered({ conversationId: conversation._id }).catch((error: unknown) => {
          console.error("Mobile message delivered update failed", error);
        });
      }
    }
  }, [conversations, markDelivered, me]);

  useEffect(() => {
    if (!selectedId) return;
    markRead({ conversationId: selectedId }).catch((error: unknown) => {
      console.error("Mobile message read update failed", error);
    });
  }, [markRead, selectedId, messages.length]);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
      }
    };
  }, []);

  function resetComposer() {
    setComposerMode(null);
    setMemberSearch("");
    setGroupName("");
    setSelectedMemberIds([]);
  }

  function updateDraft(nextDraft: string) {
    setDraft(nextDraft);
    if (!selectedId) return;

    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
    }

    if (!nextDraft.trim()) {
      setTyping({ conversationId: selectedId, isTyping: false }).catch(() => null);
      return;
    }

    setTyping({ conversationId: selectedId, isTyping: true }).catch(() => null);
    typingTimerRef.current = setTimeout(() => {
      setTyping({ conversationId: selectedId, isTyping: false }).catch(() => null);
    }, 2500);
  }

  async function startDm(member: MobileDirectMember) {
    setSaving(true);
    try {
      const conversationId = await getOrCreateDm({ orgId, otherUserId: member._id });
      setSelectedId(conversationId);
      resetComposer();
    } catch (error) {
      reportError("Mobile message DM creation failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function startGroup() {
    if (!groupName.trim() || selectedMemberIds.length < 2) {
      Alert.alert(
        locale === "ar" ? "حقول مطلوبة" : "Required fields",
        locale === "ar" ? "أدخل اسم المجموعة واختر عضوين على الأقل." : "Enter a group name and choose at least two members.",
      );
      return;
    }

    setSaving(true);
    try {
      const conversationId = await createGroup({
        orgId,
        name: groupName.trim(),
        memberIds: selectedMemberIds,
      });
      setSelectedId(conversationId);
      resetComposer();
    } catch (error) {
      reportError("Mobile message group creation failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function sendMessage() {
    if (!selectedId || !draft.trim()) return;
    const body = draft.trim();
    setDraft("");
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
    }

    try {
      setTyping({ conversationId: selectedId, isTyping: false }).catch((error) => {
        console.error("Mobile typing status clear failed", error);
      });
      await sendDirectMessage({ conversationId: selectedId, body });
    } catch (error) {
      setDraft(body);
      reportError("Mobile direct message send failed", error);
    }
  }

  async function toggleMute(conversation: MobileDirectConversation) {
    try {
      await setMuted({ conversationId: conversation._id, isMuted: !conversation.isMuted });
    } catch (error) {
      reportError("Mobile message mute update failed", error);
    }
  }

  function toggleGroupMember(memberId: string) {
    setSelectedMemberIds((prev) =>
      prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId],
    );
  }

  if (me === undefined || conversations === undefined || members === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <View style={[styles.messagesRoot, { direction: textDirection }]}>
      <View style={styles.messagesToolbar}>
        <SearchInput
          placeholder={locale === "ar" ? "بحث المحادثات" : "Search conversations"}
          value={search}
          onChangeText={setSearch}
        />
        <PrimaryButton label={locale === "ar" ? "رسالة" : "DM"} onPress={() => setComposerMode("dm")} />
        <PrimaryButton label={locale === "ar" ? "مجموعة" : "Group"} tone="muted" onPress={() => setComposerMode("group")} />
      </View>

      <View style={styles.messagesLayout}>
        <ScrollView style={styles.conversationList} contentContainerStyle={styles.conversationListContent}>
          {filteredConversations.length ? filteredConversations.map((conversation) => {
            const title = directConversationTitle(conversation, me?._id, locale === "ar" ? "محادثة" : "Conversation");
            const isActive = conversation._id === selectedId;
            return (
              <Pressable
                key={conversation._id}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                style={({ pressed }) => [
                  styles.conversationCard,
                  isActive && styles.conversationCardActive,
                  pressed && styles.pressed,
                ]}
                onPress={() => setSelectedId(conversation._id)}
              >
                <View style={styles.conversationAvatar}>
                  <Text style={styles.conversationAvatarText}>{compactInitials(title)}</Text>
                  {conversation.hasUnread ? <View style={styles.unreadDot} /> : null}
                </View>
                <View style={styles.conversationText}>
                  <View style={styles.recordHeader}>
                    <Text numberOfLines={1} style={styles.conversationTitle}>{title}</Text>
                    <Text style={styles.conversationTime}>{relativeTimeLabel(conversation.lastMessageAt, locale)}</Text>
                  </View>
                  <Text numberOfLines={2} style={[styles.conversationPreview, conversation.hasUnread && styles.conversationUnread]}>
                    {conversation.lastMessageBody || (locale === "ar" ? "لا توجد رسائل بعد" : "No messages yet")}
                  </Text>
                </View>
              </Pressable>
            );
          }) : (
            <EmptyList label={locale === "ar" ? "لا توجد محادثات بعد." : "No conversations yet."} />
          )}
        </ScrollView>

        <View style={styles.threadPanel}>
          {activeConversation ? (
            <>
              <View style={styles.threadHeader}>
                <View style={styles.conversationAvatar}>
                  <Text style={styles.conversationAvatarText}>
                    {compactInitials(directConversationTitle(activeConversation, me?._id, locale === "ar" ? "محادثة" : "Conversation"))}
                  </Text>
                </View>
                <View style={styles.headerText}>
                  <Text numberOfLines={1} style={styles.threadTitle}>
                    {directConversationTitle(activeConversation, me?._id, locale === "ar" ? "محادثة" : "Conversation")}
                  </Text>
                  <Text numberOfLines={1} style={styles.recordMeta}>
                    {activeConversation.type === "GROUP"
                      ? `${activeConversation.members.length} ${locale === "ar" ? "أعضاء" : "members"}`
                      : activeConversation.isMuted
                        ? (locale === "ar" ? "الإشعارات مكتومة" : "Notifications muted")
                        : (locale === "ar" ? "محادثة مباشرة" : "Direct message")}
                  </Text>
                </View>
                <PrimaryButton
                  label={activeConversation.isMuted ? (locale === "ar" ? "تفعيل" : "Unmute") : (locale === "ar" ? "كتم" : "Mute")}
                  tone="muted"
                  onPress={() => toggleMute(activeConversation)}
                />
              </View>

              <ScrollView style={styles.threadScroll} contentContainerStyle={styles.threadContent}>
                {canLoadMore(messageStatus) ? (
                  <PrimaryButton
                    label={locale === "ar" ? "رسائل أقدم" : "Older messages"}
                    tone="muted"
                    onPress={() => loadMoreMessages(40)}
                  />
                ) : null}
                {isPaginationLoading(messageStatus) ? (
                  <Text style={styles.mutedText}>{locale === "ar" ? "جاري التحميل..." : "Loading..."}</Text>
                ) : null}
                {chronologicalMessages.length ? chronologicalMessages.map((message: MobileDirectMessage) => {
                  const isMine = message.senderId === me?._id;
                  const statusLabel =
                    message.status === "seen"
                      ? locale === "ar" ? "مقروء" : "Seen"
                      : message.status === "delivered"
                        ? locale === "ar" ? "مستلم" : "Delivered"
                        : message.status === "sent"
                          ? locale === "ar" ? "مرسل" : "Sent"
                          : "";
                  return (
                    <View key={message._id} style={[styles.messageRow, isMine && styles.messageRowMine]}>
                      <View style={[styles.messageBubble, isMine ? styles.messageBubbleMine : styles.messageBubbleOther]}>
                        {!isMine && activeConversation.type === "GROUP" ? (
                          <Text style={styles.messageSender}>{message.senderName}</Text>
                        ) : null}
                        <Text style={[styles.messageBody, isMine && styles.messageBodyMine]}>{message.body}</Text>
                        <Text style={[styles.messageMeta, isMine && styles.messageMetaMine]}>
                          {relativeTimeLabel(message._creationTime, locale)}{statusLabel ? ` · ${statusLabel}` : ""}
                        </Text>
                      </View>
                    </View>
                  );
                }) : (
                  <EmptyList label={locale === "ar" ? "ابدأ المحادثة برسالة." : "Start the conversation with a message."} />
                )}
                {typingNames.length ? (
                  <Text style={styles.typingText}>
                    {typingNames.length === 1
                      ? `${typingNames[0]} ${locale === "ar" ? "يكتب..." : "is typing..."}`
                      : locale === "ar" ? "عدة أشخاص يكتبون..." : "Several people are typing..."}
                  </Text>
                ) : null}
              </ScrollView>

              <View style={styles.composerRow}>
                <TextInput
                  multiline
                  placeholder={locale === "ar" ? "اكتب رسالة..." : "Type a message..."}
                  placeholderTextColor={theme.colors.mutedText}
                  style={styles.composerInput}
                  value={draft}
                  onChangeText={updateDraft}
                />
                <PrimaryButton
                  disabled={!draft.trim()}
                  label={locale === "ar" ? "إرسال" : "Send"}
                  onPress={sendMessage}
                />
              </View>
            </>
          ) : (
            <EmptyList label={locale === "ar" ? "اختر محادثة أو ابدأ رسالة جديدة." : "Choose a conversation or start a new message."} />
          )}
        </View>
      </View>

      <FormModal
        title={
          composerMode === "group"
            ? (locale === "ar" ? "مجموعة جديدة" : "New group")
            : (locale === "ar" ? "رسالة جديدة" : "New message")
        }
        visible={Boolean(composerMode)}
        onClose={resetComposer}
      >
        {composerMode === "group" ? (
          <FormField
            label={locale === "ar" ? "اسم المجموعة" : "Group name"}
            value={groupName}
            onChangeText={setGroupName}
          />
        ) : null}
        <SearchInput
          placeholder={locale === "ar" ? "بحث أعضاء الفريق" : "Search team members"}
          value={memberSearch}
          onChangeText={setMemberSearch}
        />
        {availableMembers.length ? availableMembers.map((member) => {
          const selected = selectedMemberIds.includes(member._id);
          return (
            <Pressable
              key={member._id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.memberRow,
                selected && styles.memberRowSelected,
                pressed && styles.pressed,
              ]}
              onPress={() => {
                if (composerMode === "dm") {
                  startDm(member);
                } else {
                  toggleGroupMember(member._id);
                }
              }}
            >
              <View style={styles.memberAvatar}>
                <Text style={styles.memberAvatarText}>{compactInitials(member.name)}</Text>
              </View>
              <View style={styles.headerText}>
                <Text numberOfLines={1} style={styles.recordTitle}>{member.name}</Text>
                <Text numberOfLines={1} style={styles.recordMeta}>{member.email ?? member.roleName ?? "-"}</Text>
              </View>
              <Text style={styles.statusPill}>
                {composerMode === "dm"
                  ? (locale === "ar" ? "فتح" : "Open")
                  : selected
                    ? (locale === "ar" ? "مختار" : "Selected")
                    : (locale === "ar" ? "اختيار" : "Select")}
              </Text>
            </Pressable>
          );
        }) : (
          <EmptyList label={locale === "ar" ? "لا يوجد أعضاء مطابقون." : "No matching team members."} />
        )}
        {composerMode === "group" ? (
          <PrimaryButton
            disabled={saving}
            label={saving ? (locale === "ar" ? "جاري الإنشاء..." : "Creating...") : (locale === "ar" ? "إنشاء المجموعة" : "Create group")}
            onPress={startGroup}
          />
        ) : null}
      </FormModal>
    </View>
  );
}

