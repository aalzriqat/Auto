import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { Alert, Animated, Easing, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { MemberAvatar } from "../../../components/Avatar";
import { Icon } from "../../../components/Icon";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileDirectConversation, type MobileDirectMember, type MobileDirectMessage } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { useAppTheme } from "../../../providers/ThemeProvider";
import { relativeTimeLabel, directConversationTitle, isPaginationLoading, canLoadMore, useGenericError, SearchInput, PrimaryButton, FormField, FormModal, EmptyList } from "./moduleShared";
import { useStyles } from "./moduleStyles";

function directConversationAvatarUrl(
  conversation: MobileDirectConversation,
  currentUserId: string | undefined,
): string | undefined {
  if (conversation.type === "GROUP") return undefined;
  const otherMember = conversation.members.find((member) => member?._id !== currentUserId);
  return otherMember?.imageUrl;
}

function TypingDots() {
  const styles = useStyles();
  const dots = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    const animations = dots.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration: 300,
            delay: index * 150,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(value, { toValue: 0, duration: 300, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    );
    animations.forEach((animation) => animation.start());
    return () => animations.forEach((animation) => animation.stop());
  }, [dots]);

  return (
    <View style={styles.typingDotsShell}>
      {dots.map((value, index) => (
        <Animated.View
          key={index}
          style={[
            styles.typingDot,
            { transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }] },
          ]}
        />
      ))}
    </View>
  );
}

export function MessagesModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const theme = useAppTheme();
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
                  <MemberAvatar imageUrl={directConversationAvatarUrl(conversation, me?._id)} name={title} size={42} />
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
                <MemberAvatar
                  imageUrl={directConversationAvatarUrl(activeConversation, me?._id)}
                  name={directConversationTitle(activeConversation, me?._id, locale === "ar" ? "محادثة" : "Conversation")}
                  size={42}
                />
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
                {chronologicalMessages.length ? chronologicalMessages.map((message: MobileDirectMessage, index) => {
                  const isMine = message.senderId === me?._id;
                  const nextMessage = chronologicalMessages[index + 1];
                  const isLastInRun = !nextMessage || nextMessage.senderId !== message.senderId;
                  return (
                    <View key={message._id} style={[styles.messageRow, isMine && styles.messageRowMine]}>
                      {!isMine ? (
                        <View style={styles.messageAvatarSlot}>
                          {isLastInRun ? (
                            <MemberAvatar imageUrl={message.senderImageUrl} name={message.senderName} size={26} />
                          ) : null}
                        </View>
                      ) : null}
                      <View style={[styles.messageBubble, isMine ? styles.messageBubbleMine : styles.messageBubbleOther]}>
                        {!isMine && activeConversation.type === "GROUP" ? (
                          <Text style={styles.messageSender}>{message.senderName}</Text>
                        ) : null}
                        <Text style={[styles.messageBody, isMine && styles.messageBodyMine]}>{message.body}</Text>
                        <View style={styles.messageMetaRow}>
                          <Text style={[styles.messageMeta, isMine && styles.messageMetaMine]}>
                            {relativeTimeLabel(message._creationTime, locale)}
                          </Text>
                          {isMine && activeConversation.type === "GROUP" && message.seenBy.length > 0 ? (
                            <View style={styles.seenByStack}>
                              {message.seenBy.slice(0, 4).map((viewer) => (
                                <MemberAvatar
                                  key={viewer.userId}
                                  imageUrl={viewer.imageUrl}
                                  name={viewer.name}
                                  size={14}
                                  style={styles.seenByAvatar}
                                />
                              ))}
                            </View>
                          ) : null}
                          {isMine && activeConversation.type !== "GROUP" && message.status !== "sent" ? (
                            <Icon
                              color={message.status === "seen" ? "onPrimary" : "primarySoft"}
                              name="checkDone"
                              size={13}
                            />
                          ) : null}
                          {isMine && activeConversation.type !== "GROUP" && message.status === "sent" ? (
                            <Icon color="primarySoft" name="check" size={13} />
                          ) : null}
                        </View>
                      </View>
                    </View>
                  );
                }) : (
                  <EmptyList label={locale === "ar" ? "ابدأ المحادثة برسالة." : "Start the conversation with a message."} />
                )}
                {typingNames.length ? (
                  <View style={styles.typingRow}>
                    <TypingDots />
                    <Text style={styles.typingText}>
                      {typingNames.length === 1
                        ? `${typingNames[0]} ${locale === "ar" ? "يكتب..." : "is typing..."}`
                        : locale === "ar" ? "عدة أشخاص يكتبون..." : "Several people are typing..."}
                    </Text>
                  </View>
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
              <MemberAvatar imageUrl={member.imageUrl} name={member.name} size={38} />
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

